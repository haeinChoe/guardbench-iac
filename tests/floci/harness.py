"""Floci-backed harness that runs the experiment entrypoint's steps against a local emulator.

Nothing here reaches a real AWS endpoint: every process gets dummy credentials, an empty AWS
config, and a loopback endpoint. Terraform reaches Floci only through generated override files
written into a throwaway copy of the roots; the roots themselves have no emulator branch. The
scripts under scripts/performance run unchanged and find Floci through AWS_ENDPOINT_URL.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
FLOCI_IMAGE = "floci/floci:2.4.0"
REGION = "ap-northeast-2"
STATE_BUCKET = "guardbench-terraform-state"
BASE_IMAGE_NAMES = ("guardbench-floci-stub", "guardbench-floci-codebuild")
ROOTS = ("shared", "performance-base", "performance-experiment")
STATE_KEYS = {root: f"{root}/terraform.tfstate" for root in ROOTS}
INFRASTRUCTURE_REVISION = "0123456789abcdef0123456789abcdef01234567"
PRESET = "validation"
PROVIDER_ENDPOINT_SERVICES = (
    "cloudwatch",
    "codebuild",
    "ec2",
    "ecr",
    "ecs",
    "elbv2",
    "iam",
    "logs",
    "rds",
    "s3",
    "sagemaker",
    "secretsmanager",
    "sqs",
    "sts",
)
EXPERIMENT_NAME_MARKERS = ("performance-app", "performance-worker", "demo-ai", "performance-qwen3", "perf-qwen3")


def _assert_loopback(endpoint: str) -> None:
    host = endpoint.split("://", 1)[1].split(":", 1)[0]
    if host not in ("localhost", "127.0.0.1"):
        raise RuntimeError(f"refusing to use a non-loopback endpoint: {endpoint}")


def _free_port(preferred: int) -> int:
    for candidate in (preferred, 0):
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", candidate))
            except OSError:
                continue
            return probe.getsockname()[1]
    raise RuntimeError("no free port")


def run(command: list[str], *, env: dict[str, str] | None = None, cwd: Path | None = None, log: Path | None = None,
        check: bool = True, input_text: str | None = None) -> subprocess.CompletedProcess:
    """Run a command, capturing combined output into `log` (and the exception text on failure)."""
    completed = subprocess.run(
        command, env=env, cwd=cwd, input=input_text, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False
    )
    if log is not None:
        log.parent.mkdir(parents=True, exist_ok=True)
        with open(log, "a", encoding="utf-8") as handle:
            handle.write(f"$ {' '.join(command)}\n{completed.stdout}\n[exit {completed.returncode}]\n")
    if check and completed.returncode != 0:
        tail = completed.stdout[-4000:]
        raise RuntimeError(f"command failed ({completed.returncode}): {' '.join(command)}\n{tail}")
    return completed


class Floci:
    """One Floci container; AWS clients and Terraform are pointed at it by environment/override."""

    def __init__(self) -> None:
        self.name = f"floci-iac-test-{secrets.token_hex(4)}"
        self.port = _free_port(4566)
        self.endpoint = f"http://localhost:{self.port}"
        _assert_loopback(self.endpoint)

    def start(self) -> None:
        run(
            [
                "docker", "run", "--detach", "--name", self.name,
                "--publish", f"127.0.0.1:{self.port}:4566",
                "--volume", "/var/run/docker.sock:/var/run/docker.sock",
                FLOCI_IMAGE,
            ]
        )
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(self.endpoint + "/", timeout=2):
                    return
            except OSError:
                time.sleep(1)
        raise RuntimeError("Floci did not become ready")

    def stop(self) -> None:
        """Remove Floci and every container it created (they carry the label floci=true)."""
        listing = run(["docker", "ps", "--all", "--quiet", "--filter", "label=floci=true"], check=False).stdout.split()
        for container_id in listing:
            run(["docker", "rm", "--force", container_id], check=False)
        run(["docker", "rm", "--force", self.name], check=False)

    def base_env(self) -> dict[str, str]:
        """Minimal environment with dummy credentials; nothing is inherited from the caller."""
        return {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", "/tmp"),
            "LANG": "C.UTF-8",
            "AWS_ACCESS_KEY_ID": "test",
            "AWS_SECRET_ACCESS_KEY": "test",
            "AWS_REGION": REGION,
            "AWS_DEFAULT_REGION": REGION,
            "AWS_CONFIG_FILE": "/dev/null",
            "AWS_SHARED_CREDENTIALS_FILE": "/dev/null",
            "AWS_EC2_METADATA_DISABLED": "true",
        }

    def script_env(self) -> dict[str, str]:
        env = self.base_env()
        env["AWS_ENDPOINT_URL"] = self.endpoint
        env["PYTHONPATH"] = str(REPO_ROOT)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        return env

    def client(self, service: str) -> Any:
        import boto3

        return boto3.client(
            service,
            endpoint_url=self.endpoint,
            region_name=REGION,
            aws_access_key_id="test",
            aws_secret_access_key="test",
        )


def _override(root: str, floci: Floci) -> str:
    """Override file that points one root's backend, provider and remote state at Floci."""
    s3_options = f'''
    endpoints                   = {{ s3 = "{floci.endpoint}" }}
    access_key                  = "test"
    secret_key                  = "test"
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_requesting_account_id  = true
    skip_region_validation      = true
    skip_s3_checksum            = true'''
    endpoints = "\n".join(f'    {service} = "{floci.endpoint}"' for service in PROVIDER_ENDPOINT_SERVICES)
    text = f'''terraform {{
  backend "s3" {{
    bucket       = "{STATE_BUCKET}"
    key          = "{STATE_KEYS[root]}"
    region       = "{REGION}"
    use_lockfile = true
    encrypt      = true{s3_options}
  }}
}}

provider "aws" {{
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  endpoints {{
{endpoints}
  }}
}}
'''
    upstream = {"performance-base": ("shared",), "performance-experiment": ("shared", "performance_base")}
    names = {"shared": "shared", "performance_base": "performance-base"}
    for name in upstream.get(root, ()):
        text += f'''
data "terraform_remote_state" "{name.replace("-", "_")}" {{
  backend = "s3"
  config = {{
    bucket = "{STATE_BUCKET}"
    key    = "{STATE_KEYS[names.get(name, name)]}"
    region = "{REGION}"{s3_options}
  }}
}}
'''
    return text


@dataclass
class Workspace:
    """Throwaway copy of the roots and buildspec with Floci override files."""

    floci: Floci
    root: Path
    tf_env: dict[str, str] = field(default_factory=dict)

    @classmethod
    def create(cls, floci: Floci) -> "Workspace":
        root = Path(tempfile.mkdtemp(prefix="floci-iac-workspace-"))
        ignore = shutil.ignore_patterns(".terraform", "*.tfstate", "*.tfstate.*", ".terraform.lock.hcl", "override.tf")
        for name in ROOTS:
            shutil.copytree(REPO_ROOT / "terraform" / name, root / "terraform" / name, ignore=ignore)
        shutil.copytree(REPO_ROOT / "codebuild", root / "codebuild")
        for name in ROOTS:
            (root / "terraform" / name / "override.tf").write_text(_override(name, floci), encoding="utf-8")
        workspace = cls(floci=floci, root=root)
        workspace.tf_env = floci.base_env()
        workspace.tf_env["TF_IN_AUTOMATION"] = "true"
        if os.environ.get("TF_PLUGIN_CACHE_DIR"):
            workspace.tf_env["TF_PLUGIN_CACHE_DIR"] = os.environ["TF_PLUGIN_CACHE_DIR"]
        return workspace

    def directory(self, root_name: str) -> Path:
        return self.root / "terraform" / root_name

    def terraform(self, root_name: str, *arguments: str, extra_env: dict[str, str] | None = None,
                  log: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
        env = dict(self.tf_env)
        env.update(extra_env or {})
        return run(
            ["terraform", f"-chdir={self.directory(root_name)}", *arguments], env=env, log=log, check=check
        )

    def remove(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


def build_fixture_repository(destination: Path) -> str:
    """Create the Backend fixture as a bare repository at destination; return its commit SHA."""
    work = Path(tempfile.mkdtemp(prefix="floci-iac-fixture-"))
    try:
        source = work / "source"
        shutil.copytree(REPO_ROOT / "tests" / "floci" / "fixture_backend", source)
        git_env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(work),
            "GIT_AUTHOR_NAME": "fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
            "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z",
        }
        run(["git", "init", "--quiet", "--initial-branch=main"], cwd=source, env=git_env)
        run(["git", "add", "."], cwd=source, env=git_env)
        run(["git", "commit", "--quiet", "--message", "fixture backend"], cwd=source, env=git_env)
        sha = run(["git", "rev-parse", "HEAD"], cwd=source, env=git_env).stdout.strip()
        run(["git", "clone", "--quiet", "--bare", str(source), str(destination)], env=git_env)
        return sha
    finally:
        shutil.rmtree(work, ignore_errors=True)


class Images:
    """Docker images the experiment cannot pull from a registry in a local run."""

    def __init__(self) -> None:
        self.tag = secrets.token_hex(6)
        self.app_tag = secrets.token_hex(6)
        self.demo_tag = secrets.token_hex(6)
        self.stub = f"guardbench-floci-stub:{self.tag}"
        self.codebuild = f"guardbench-floci-codebuild:{self.tag}"
        self.backend_commit = ""
        self._created: list[str] = []

    def build(self) -> None:
        run(["docker", "build", "--quiet", "--tag", self.stub, str(REPO_ROOT / "tests/floci/images/stub")])
        self._created.append(self.stub)
        for extra in (f"guardbench-floci-stub:{self.app_tag}", f"guardbench-floci-stub:{self.demo_tag}"):
            run(["docker", "tag", self.stub, extra])
            self._created.append(extra)
        context = Path(tempfile.mkdtemp(prefix="floci-iac-cb-context-"))
        try:
            shutil.copy(REPO_ROOT / "tests/floci/images/codebuild/Dockerfile", context / "Dockerfile")
            self.backend_commit = build_fixture_repository(context / "backend.git")
            run(["docker", "build", "--quiet", "--tag", self.codebuild, str(context)])
            self._created.append(self.codebuild)
        finally:
            shutil.rmtree(context, ignore_errors=True)

    def remove(self) -> None:
        for image in self._created:
            run(["docker", "rmi", "--force", image], check=False)


@dataclass
class PipelineResult:
    name: str
    exp_dir: Path
    steps: dict[str, int] = field(default_factory=dict)
    final: dict[str, Any] | None = None
    preflight: dict[str, Any] | None = None
    destroy_verification: dict[str, Any] | None = None
    build: dict[str, Any] | None = None
    runner_files: list[str] = field(default_factory=list)
    snapshot: dict[str, Any] | None = None


class Pipeline:
    """The entrypoint workflow's steps, in the workflow's order, against Floci."""

    def __init__(self, floci: Floci, workspace: Workspace, images: Images, run_dir: Path) -> None:
        self.floci = floci
        self.workspace = workspace
        self.images = images
        self.run_dir = run_dir

    def terraform_flags(self) -> list[str]:
        return [
            f"-var-file=presets/{PRESET}.tfvars",
            f"-var=infrastructure_id={PRESET}",
            f"-var=infrastructure_revision={INFRASTRUCTURE_REVISION}",
            f"-var=app_image_tag={self.images.app_tag}",
            "-var=app_image_repository_url=guardbench-floci-stub",
            "-var=demo_ai_image_repository_url=guardbench-floci-stub",
            f"-var=performance_sagemaker_container_image={self.images.stub}",
        ]

    def terraform_env(self) -> dict[str, str]:
        return {
            "TF_VAR_demo_ai_image_tag": self.images.demo_tag,
            "TF_VAR_demo_ai_bedrock_model_id": "apac.amazon.nova-micro-v1:0",
            "TF_VAR_demo_ai_bedrock_resource_arns": json.dumps(
                [f"arn:aws:bedrock:{REGION}:000000000000:inference-profile/apac.amazon.nova-micro-v1:0"]
            ),
            "TF_VAR_demo_ai_target_model": "demo-model",
        }

    def script(self, module: str, *arguments: str, log: Path, check: bool = False) -> int:
        completed = run(
            ["python3", "-m", f"scripts.performance.{module}", *arguments],
            env=self.floci.script_env(), cwd=REPO_ROOT, log=log, check=check,
        )
        return completed.returncode

    def execute(self, name: str, scenario: str, *, seed_queue_message: bool = False) -> PipelineResult:
        exp = self.run_dir / name
        exp.mkdir(parents=True)
        logs = exp / "logs"
        result = PipelineResult(name=name, exp_dir=exp)
        flags = self.terraform_flags()
        extra_env = self.terraform_env()
        result_prefix = ""
        apply_attempted = False
        try:
            self.workspace.terraform("performance-experiment", "init", "-input=false", "-no-color", log=logs / "init.log")
            apply_attempted = True
            self.workspace.terraform(
                "performance-experiment", "apply", "-input=false", "-auto-approve", "-no-color", *flags,
                extra_env=extra_env, log=logs / "apply.log",
            )
            snapshot_text = self.workspace.terraform(
                "performance-experiment", "output", "-json", "infrastructure_snapshot", log=logs / "snapshot.log"
            ).stdout
            (exp / "snapshot.json").write_text(snapshot_text, encoding="utf-8")
            snapshot = json.loads(snapshot_text)
            result.snapshot = snapshot
            runner = snapshot["resources"]["runner"]
            result_prefix = f"s3://{runner['results_bucket_name']}/performance/results/{PRESET}/{name}/"

            if seed_queue_message:
                queue = snapshot["resources"]["sqs"]["source_queue_urls"]["gb-workitems"]
                self.floci.client("sqs").send_message(QueueUrl=queue, MessageBody="left over from an earlier run")

            result.steps["preflight"] = self.script(
                "preflight", "--snapshot", str(exp / "snapshot.json"), "--output", str(exp / "preflight.json"),
                log=logs / "preflight.log",
            )
            result.preflight = json.loads((exp / "preflight.json").read_text(encoding="utf-8"))

            if result.steps["preflight"] == 0:
                self._run_runner(exp, logs, snapshot, scenario, result_prefix, result)

            self._combine(exp, logs, result, bool(result.steps.get("start_build") == 0))
            self.script("s3results", "upload", "--src", str(self._record(exp)), "--prefix", result_prefix + "experiment/",
                        log=logs / "upload.log")
        finally:
            if apply_attempted:
                self._destroy(exp, logs, flags, extra_env, result)
        return result

    def _runner_env(self, snapshot: dict[str, Any], scenario: str, result_prefix: str) -> dict[str, str]:
        env = {
            "BACKEND_COMMIT": self.images.backend_commit,
            "BACKEND_REPO_URL": "file:///fixture/backend.git",
            "API_URL": snapshot["api_url"],
            "TARGET_URL": snapshot["target"]["url"],
            "TARGET_MODEL": snapshot["target"]["model"],
            "TARGET_REVISION": snapshot["target"]["revision"],
            "SCENARIO_PATH": f"performance/scenarios/{scenario}.yaml",
            "DATASET_PATH": "performance/datasets/two-cases.yaml",
            "RESULT_S3_PREFIX": result_prefix + "runner/",
        }
        return {key: value for key, value in env.items() if value}

    def _run_runner(self, exp: Path, logs: Path, snapshot: dict[str, Any], scenario: str,
                    result_prefix: str, result: PipelineResult) -> None:
        env = self._runner_env(snapshot, scenario, result_prefix)
        (exp / "build-env.json").write_text(json.dumps(env, indent=2), encoding="utf-8")
        project = snapshot["resources"]["runner"]["codebuild_project_name"]
        result.steps["start_build"] = self.script(
            "codebuild", "start", "--project", project, "--env-file", str(exp / "build-env.json"),
            "--output", str(exp / "build-start.json"), log=logs / "start-build.log",
        )
        if result.steps["start_build"] != 0:
            return
        result.steps["wait_build"] = self.script(
            "codebuild", "wait", "--start-file", str(exp / "build-start.json"), "--output", str(exp / "build.json"),
            "--timeout-seconds", "900", "--poll-seconds", "2", log=logs / "wait-build.log",
        )
        self.script("codebuild", "stop", "--start-file", str(exp / "build-start.json"), log=logs / "stop-build.log")
        (exp / "results").mkdir()
        result.steps["download"] = self.script(
            "s3results", "download", "--prefix", result_prefix + "runner/", "--dest", str(exp / "results"),
            log=logs / "download.log",
        )
        result.steps["collect"] = self.script(
            "collect", "--snapshot", str(exp / "snapshot.json"), "--result-dir", str(exp / "results"),
            "--build", str(exp / "build.json"), "--output", str(exp / "infrastructure.json"),
            "--logs-output", str(exp / "ecs-logs.json"), "--drain-timeout-seconds", "30", "--drain-poll-seconds", "2",
            log=logs / "collect.log",
        )
        if (exp / "build.json").is_file():
            result.build = json.loads((exp / "build.json").read_text(encoding="utf-8"))
        result.runner_files = sorted(path.name for path in (exp / "results").iterdir()) if (exp / "results").is_dir() else []

    def _combine(self, exp: Path, logs: Path, result: PipelineResult, ran_runner: bool) -> None:
        arguments = [
            "--snapshot", str(exp / "snapshot.json"), "--result-dir", str(exp / "results"),
            "--build", str(exp / "build.json"), "--infrastructure", str(exp / "infrastructure.json"),
            "--preflight", str(exp / "preflight.json"), "--output", str(exp / "final.json"),
            "--summary", str(exp / "summary.md"),
        ]
        result.steps["combine"] = self.script("combine", *arguments, log=logs / "combine.log")
        result.final = json.loads((exp / "final.json").read_text(encoding="utf-8"))

    def _record(self, exp: Path) -> Path:
        record = exp / "record"
        record.mkdir(exist_ok=True)
        for name in ("snapshot", "preflight", "build-start", "build", "infrastructure", "ecs-logs", "final"):
            if (exp / f"{name}.json").is_file():
                shutil.copy(exp / f"{name}.json", record / f"{name}.json")
        if (exp / "summary.md").is_file():
            shutil.copy(exp / "summary.md", record / "summary.md")
        return record

    def _destroy(self, exp: Path, logs: Path, flags: list[str], extra_env: dict[str, str], result: PipelineResult) -> None:
        destroy = self.workspace.terraform(
            "performance-experiment", "destroy", "-input=false", "-auto-approve", "-no-color", "-lock-timeout=5m", *flags,
            extra_env=extra_env, log=logs / "destroy.log", check=False,
        )
        result.steps["destroy"] = destroy.returncode
        state = self.workspace.terraform("performance-experiment", "state", "list", log=logs / "state.log", check=False)
        (exp / "state-after-destroy.txt").write_text(
            state.stdout if state.returncode == 0 else "state list could not be read\n", encoding="utf-8"
        )
        arguments = ["--state-list", str(exp / "state-after-destroy.txt"), "--output", str(exp / "destroy-verification.json")]
        if (exp / "snapshot.json").is_file():
            arguments += ["--snapshot", str(exp / "snapshot.json")]
        result.steps["verify_destroy"] = self.script("verify_destroyed", *arguments, log=logs / "verify-destroy.log")
        result.destroy_verification = json.loads((exp / "destroy-verification.json").read_text(encoding="utf-8"))


class Environment:
    """Floci, stub images and the always-on layers (shared, performance-base), applied once."""

    def __init__(self, artifacts_dir: Path) -> None:
        self.floci = Floci()
        self.images = Images()
        self.workspace: Workspace | None = None
        self.pipeline: Pipeline | None = None
        self.artifacts_dir = artifacts_dir

    def start(self) -> None:
        logs = self.artifacts_dir / "setup"
        self.floci.start()
        self.images.build()
        self.floci.client("s3").create_bucket(
            Bucket=STATE_BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION}
        )
        self.workspace = Workspace.create(self.floci)
        for root_name, arguments in (
            ("shared", []),
            (
                "performance-base",
                [
                    "-var=performance_db_instance_class=db.t4g.micro",
                    "-var=performance_db_allocated_storage=20",
                    "-var=performance_db_max_allocated_storage=100",
                    "-var=performance_db_backup_retention_period=0",
                    f"-var=performance_codebuild_image={self.images.codebuild}",
                ],
            ),
        ):
            self.workspace.terraform(root_name, "init", "-input=false", "-no-color", log=logs / f"{root_name}-init.log")
            self.workspace.terraform(
                root_name, "apply", "-input=false", "-auto-approve", "-no-color", *arguments, log=logs / f"{root_name}-apply.log"
            )
        self.pipeline = Pipeline(self.floci, self.workspace, self.images, self.artifacts_dir / "runs")

    def stop(self) -> None:
        self.floci.stop()
        if self.workspace is not None:
            self.workspace.remove()
        self.images.remove()

    def purge_source_queues(self, snapshot: dict[str, Any]) -> None:
        sqs = self.floci.client("sqs")
        for url in snapshot["resources"]["sqs"]["source_queue_urls"].values():
            sqs.purge_queue(QueueUrl=url)

    def experiment_resources_left(self) -> list[str]:
        """Independent of the scripts under test: list what an experiment would have created."""
        left: list[str] = []
        ecs = self.floci.client("ecs")
        cluster_arns = ecs.list_clusters().get("clusterArns", [])
        for cluster in cluster_arns:
            for arn in ecs.list_services(cluster=cluster).get("serviceArns", []):
                left.append(f"ecs service {arn}")
        for family in ("performance-app", "performance-worker", "demo-ai"):
            for arn in ecs.list_task_definitions(familyPrefix=f"guardbench-dev-{family}", status="ACTIVE").get("taskDefinitionArns", []):
                left.append(f"ecs task definition {arn}")
        sagemaker = self.floci.client("sagemaker")
        left += [f"sagemaker endpoint {item['EndpointName']}" for item in sagemaker.list_endpoints().get("Endpoints", [])]
        left += [f"sagemaker endpoint config {item['EndpointConfigName']}" for item in sagemaker.list_endpoint_configs().get("EndpointConfigs", [])]
        left += [f"sagemaker model {item['ModelName']}" for item in sagemaker.list_models().get("Models", [])]
        logs = self.floci.client("logs")
        left += [f"log group {item['logGroupName']}" for item in logs.describe_log_groups(logGroupNamePrefix="/ecs/").get("logGroups", [])]
        iam = self.floci.client("iam")
        for role in iam.list_roles().get("Roles", []):
            if any(marker in role["RoleName"] for marker in ("performance-ecs-exec", "performance-app-task", "performance-sagemaker-exec", "demo-ai-")):
                left.append(f"iam role {role['RoleName']}")
        ec2 = self.floci.client("ec2")
        for group in ec2.describe_security_groups().get("SecurityGroups", []):
            if group["GroupName"] in ("guardbench-dev-performance-api-sg", "guardbench-dev-performance-worker-sg", "guardbench-dev-demo-ai-sg"):
                left.append(f"security group {group['GroupName']}")
        containers = run(["docker", "ps", "--all", "--format", "{{.Names}}"], check=False).stdout.split()
        left += [f"container {name}" for name in containers if name.startswith(("floci-aws-ecs-", "floci-aws-sagemaker-endpoint-"))]
        return left
