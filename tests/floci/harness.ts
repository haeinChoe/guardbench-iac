// Floci-backed harness that runs the experiment entrypoint's steps against a local emulator.
//
// Nothing here reaches a real AWS endpoint: every process gets dummy credentials, an empty AWS
// config, and a loopback endpoint. Terraform reaches Floci only through generated override files
// written into a throwaway copy of the roots; the roots themselves have no emulator branch. The
// scripts under scripts/performance run unchanged and find Floci through AWS_ENDPOINT_URL.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { CodeBuildClient, ListBuildsForProjectCommand, ListProjectsCommand } from "@aws-sdk/client-codebuild";
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { DescribeSecurityGroupsCommand, EC2Client } from "@aws-sdk/client-ec2";
import {
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  ListTaskDefinitionsCommand,
} from "@aws-sdk/client-ecs";
import { IAMClient, ListRolesCommand } from "@aws-sdk/client-iam";
import {
  CreateBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  ListEndpointConfigsCommand,
  ListEndpointsCommand,
  ListModelsCommand,
  SageMakerClient,
} from "@aws-sdk/client-sagemaker";
import { PurgeQueueCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

import type { Dict } from "../../scripts/performance/common.ts";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
const FLOCI_IMAGE = "floci/floci:2.4.0";
export const REGION = "ap-northeast-2";
const STATE_BUCKET = "guardbench-terraform-state";
const ROOTS = ["shared", "performance-base", "performance-experiment"] as const;
const STATE_KEYS: Record<string, string> = Object.fromEntries(ROOTS.map((root) => [root, `${root}/terraform.tfstate`]));
const INFRASTRUCTURE_REVISION = "0123456789abcdef0123456789abcdef01234567";
export const PRESET = "validation";
const PROVIDER_ENDPOINT_SERVICES = [
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
];

function assertLoopback(endpoint: string): void {
  const host = new URL(endpoint).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`refusing to use a non-loopback endpoint: ${endpoint}`);
  }
}

function freePort(preferred: number): Promise<number> {
  const listen = (port: number) =>
    new Promise<number | null>((done) => {
      const probe = createServer();
      probe.once("error", () => done(null));
      probe.listen(port, "127.0.0.1", () => {
        const address = probe.address();
        probe.close(() => done(typeof address === "object" && address ? address.port : null));
      });
    });
  return listen(preferred).then(async (port) => {
    const found = port ?? (await listen(0));
    if (found === null) {
      throw new Error("no free port");
    }
    return found;
  });
}

export interface RunOptions {
  env?: Record<string, string>;
  cwd?: string;
  log?: string;
  check?: boolean;
}

export interface RunResult {
  status: number;
  stdout: string;
  output: string;
}

/** Run a command, appending its combined output to `log` (and raising with its tail on failure). */
export function run(command: string[], options: RunOptions = {}): RunResult {
  const { env, cwd, log, check = true } = options;
  const completed = spawnSync(command[0], command.slice(1), {
    env,
    cwd,
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const status = completed.status ?? 1;
  const stdout = completed.stdout ?? "";
  const output = stdout + (completed.stderr ?? "") + (completed.error ? String(completed.error) : "");
  if (log !== undefined) {
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, `$ ${command.join(" ")}\n${output}\n[exit ${status}]\n`);
  }
  if (check && status !== 0) {
    throw new Error(`command failed (${status}): ${command.join(" ")}\n${output.slice(-4000)}`);
  }
  return { status, stdout, output };
}

function sleepSeconds(seconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, seconds * 1000));
}

/** One Floci container; AWS clients and Terraform are pointed at it by environment/override. */
export class Floci {
  readonly name = `floci-iac-test-${randomBytes(4).toString("hex")}`;
  port = 0;
  endpoint = "";

  /** Address used by the Node processes: with an IP host the SDK uses path-style S3 URLs, so no `<bucket>.localhost` name has to resolve. */
  get ipEndpoint(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.port = await freePort(4566);
    this.endpoint = `http://localhost:${this.port}`;
    assertLoopback(this.endpoint);
    run([
      "docker", "run", "--detach", "--name", this.name,
      "--publish", `127.0.0.1:${this.port}:4566`,
      "--volume", "/var/run/docker.sock:/var/run/docker.sock",
      FLOCI_IMAGE,
    ]);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.endpoint}/`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) {
          return;
        }
      } catch {
        // not ready yet
      }
      await sleepSeconds(1);
    }
    throw new Error("Floci did not become ready");
  }

  /** Remove Floci and every container it created (they carry the label floci=true). */
  stop(): void {
    const listing = run(["docker", "ps", "--all", "--quiet", "--filter", "label=floci=true"], { check: false }).stdout.split(/\s+/);
    for (const containerId of listing.filter(Boolean)) {
      run(["docker", "rm", "--force", containerId], { check: false });
    }
    run(["docker", "rm", "--force", this.name], { check: false });
  }

  /** Minimal environment with dummy credentials; nothing is inherited from the caller. */
  baseEnv(): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      LANG: "C.UTF-8",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      AWS_REGION: REGION,
      AWS_DEFAULT_REGION: REGION,
      AWS_CONFIG_FILE: "/dev/null",
      AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
      AWS_EC2_METADATA_DISABLED: "true",
    };
  }

  /** Environment of the scripts: dummy credentials and Floci's endpoint, nothing else. */
  scriptEnv(): Record<string, string> {
    return { ...this.baseEnv(), AWS_ENDPOINT_URL: this.ipEndpoint };
  }

  /** An SDK client for the test's own checks, independent of the scripts under test. */
  client<T>(Client: new (config: Dict) => T): T {
    return new Client({
      endpoint: this.ipEndpoint,
      region: REGION,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      forcePathStyle: true,
    });
  }
}

/** Override file that points one root's backend, provider and remote state at Floci. */
function override(root: string, floci: Floci): string {
  const s3Options = `
    endpoints                   = { s3 = "${floci.endpoint}" }
    access_key                  = "test"
    secret_key                  = "test"
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_requesting_account_id  = true
    skip_region_validation      = true
    skip_s3_checksum            = true`;
  const endpoints = PROVIDER_ENDPOINT_SERVICES.map((service) => `    ${service} = "${floci.endpoint}"`).join("\n");
  let text = `terraform {
  backend "s3" {
    bucket       = "${STATE_BUCKET}"
    key          = "${STATE_KEYS[root]}"
    region       = "${REGION}"
    use_lockfile = true
    encrypt      = true${s3Options}
  }
}

provider "aws" {
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  endpoints {
${endpoints}
  }
}
`;
  const upstream: Record<string, string[]> = {
    "performance-base": ["shared"],
    "performance-experiment": ["shared", "performance_base"],
  };
  const names: Record<string, string> = { shared: "shared", performance_base: "performance-base" };
  for (const name of upstream[root] ?? []) {
    text += `
data "terraform_remote_state" "${name.replaceAll("-", "_")}" {
  backend = "s3"
  config = {
    bucket = "${STATE_BUCKET}"
    key    = "${STATE_KEYS[names[name] ?? name]}"
    region = "${REGION}"${s3Options}
  }
}
`;
  }
  return text;
}

const COPY_EXCLUDED = new Set([".terraform", ".terraform.lock.hcl", "override.tf"]);

function copyTree(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    filter: (path) => {
      const name = basename(path);
      return !COPY_EXCLUDED.has(name) && !name.endsWith(".tfstate") && !name.includes(".tfstate.");
    },
  });
}

/** Throwaway copy of the roots and buildspec with Floci override files. */
export class Workspace {
  readonly floci: Floci;
  readonly root: string;
  readonly tfEnv: Record<string, string>;

  private constructor(floci: Floci, root: string, tfEnv: Record<string, string>) {
    this.floci = floci;
    this.root = root;
    this.tfEnv = tfEnv;
  }

  static create(floci: Floci): Workspace {
    const root = mkdtempSync(join(tmpdir(), "floci-iac-workspace-"));
    for (const name of ROOTS) {
      copyTree(join(REPO_ROOT, "terraform", name), join(root, "terraform", name));
    }
    cpSync(join(REPO_ROOT, "codebuild"), join(root, "codebuild"), { recursive: true });
    for (const name of ROOTS) {
      writeFileSync(join(root, "terraform", name, "override.tf"), override(name, floci), "utf-8");
    }
    const tfEnv = { ...floci.baseEnv(), TF_IN_AUTOMATION: "true" } as Record<string, string>;
    if (process.env.TF_PLUGIN_CACHE_DIR) {
      tfEnv.TF_PLUGIN_CACHE_DIR = process.env.TF_PLUGIN_CACHE_DIR;
    }
    return new Workspace(floci, root, tfEnv);
  }

  directory(rootName: string): string {
    return join(this.root, "terraform", rootName);
  }

  terraform(
    rootName: string,
    args: string[],
    options: { extraEnv?: Record<string, string>; log?: string; check?: boolean } = {},
  ): RunResult {
    return run(["terraform", `-chdir=${this.directory(rootName)}`, ...args], {
      env: { ...this.tfEnv, ...options.extraEnv },
      log: options.log,
      check: options.check,
    });
  }

  remove(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Create the Backend fixture as a bare repository at destination; return its commit SHA. */
export function buildFixtureRepository(destination: string): string {
  const work = mkdtempSync(join(tmpdir(), "floci-iac-fixture-"));
  try {
    const source = join(work, "source");
    cpSync(join(REPO_ROOT, "tests", "floci", "fixture_backend"), source, { recursive: true });
    const gitEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: work,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    };
    run(["git", "init", "--quiet", "--initial-branch=main"], { cwd: source, env: gitEnv });
    run(["git", "add", "."], { cwd: source, env: gitEnv });
    run(["git", "commit", "--quiet", "--message", "fixture backend"], { cwd: source, env: gitEnv });
    const sha = run(["git", "rev-parse", "HEAD"], { cwd: source, env: gitEnv }).stdout.trim();
    run(["git", "clone", "--quiet", "--bare", source, destination], { env: gitEnv });
    return sha;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Docker images the experiment cannot pull from a registry in a local run. */
export class Images {
  readonly tag = randomBytes(6).toString("hex");
  readonly appTag = randomBytes(6).toString("hex");
  readonly demoTag = randomBytes(6).toString("hex");
  readonly stub = `guardbench-floci-stub:${this.tag}`;
  readonly codebuild = `guardbench-floci-codebuild:${this.tag}`;
  backendCommit = "";
  private readonly created: string[] = [];

  build(): void {
    run(["docker", "build", "--quiet", "--tag", this.stub, join(REPO_ROOT, "tests/floci/images/stub")]);
    this.created.push(this.stub);
    for (const extra of [`guardbench-floci-stub:${this.appTag}`, `guardbench-floci-stub:${this.demoTag}`]) {
      run(["docker", "tag", this.stub, extra]);
      this.created.push(extra);
    }
    const context = mkdtempSync(join(tmpdir(), "floci-iac-cb-context-"));
    try {
      cpSync(join(REPO_ROOT, "tests/floci/images/codebuild/Dockerfile"), join(context, "Dockerfile"));
      this.backendCommit = buildFixtureRepository(join(context, "backend.git"));
      run(["docker", "build", "--quiet", "--tag", this.codebuild, context]);
      this.created.push(this.codebuild);
    } finally {
      rmSync(context, { recursive: true, force: true });
    }
  }

  remove(): void {
    for (const image of this.created) {
      run(["docker", "rmi", "--force", image], { check: false });
    }
  }
}

export interface PipelineResult {
  name: string;
  expDir: string;
  steps: Record<string, number>;
  final: Dict | null;
  preflight: Dict | null;
  destroyVerification: Dict | null;
  build: Dict | null;
  runnerFiles: string[];
  snapshot: Dict | null;
}

function readJsonFile(path: string): Dict {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** The entrypoint workflow's steps, in the workflow's order, against Floci. */
export class Pipeline {
  private readonly floci: Floci;
  private readonly workspace: Workspace;
  private readonly images: Images;
  private readonly runDir: string;

  constructor(floci: Floci, workspace: Workspace, images: Images, runDir: string) {
    this.floci = floci;
    this.workspace = workspace;
    this.images = images;
    this.runDir = runDir;
  }

  private terraformFlags(): string[] {
    return [
      `-var-file=presets/${PRESET}.tfvars`,
      `-var=infrastructure_id=${PRESET}`,
      `-var=infrastructure_revision=${INFRASTRUCTURE_REVISION}`,
      `-var=app_image_tag=${this.images.appTag}`,
      "-var=app_image_repository_url=guardbench-floci-stub",
      "-var=demo_ai_image_repository_url=guardbench-floci-stub",
      `-var=performance_sagemaker_container_image=${this.images.stub}`,
    ];
  }

  private terraformEnv(): Record<string, string> {
    return {
      TF_VAR_demo_ai_image_tag: this.images.demoTag,
      TF_VAR_demo_ai_bedrock_model_id: "apac.amazon.nova-micro-v1:0",
      TF_VAR_demo_ai_bedrock_resource_arns: JSON.stringify([
        `arn:aws:bedrock:${REGION}:000000000000:inference-profile/apac.amazon.nova-micro-v1:0`,
      ]),
      TF_VAR_demo_ai_target_model: "demo-model",
    };
  }

  private script(module: string, args: string[], log: string): number {
    return run(["node", join(REPO_ROOT, "scripts", "performance", `${module}.ts`), ...args], {
      env: this.floci.scriptEnv(),
      cwd: REPO_ROOT,
      log,
      check: false,
    }).status;
  }

  async execute(name: string, scenario: string, options: { seedQueueMessage?: boolean } = {}): Promise<PipelineResult> {
    const exp = join(this.runDir, name);
    mkdirSync(exp, { recursive: true });
    const logs = join(exp, "logs");
    const result: PipelineResult = {
      name,
      expDir: exp,
      steps: {},
      final: null,
      preflight: null,
      destroyVerification: null,
      build: null,
      runnerFiles: [],
      snapshot: null,
    };
    const flags = this.terraformFlags();
    const extraEnv = this.terraformEnv();
    let applyAttempted = false;
    try {
      this.workspace.terraform("performance-experiment", ["init", "-input=false", "-no-color"], {
        log: join(logs, "init.log"),
      });
      applyAttempted = true;
      this.workspace.terraform(
        "performance-experiment",
        ["apply", "-input=false", "-auto-approve", "-no-color", ...flags],
        { extraEnv, log: join(logs, "apply.log") },
      );
      const snapshotText = this.workspace.terraform(
        "performance-experiment",
        ["output", "-json", "infrastructure_snapshot"],
        { log: join(logs, "snapshot.log") },
      ).stdout;
      writeFileSync(join(exp, "snapshot.json"), snapshotText, "utf-8");
      const snapshot = JSON.parse(snapshotText) as Dict;
      result.snapshot = snapshot;
      const runner = snapshot.resources.runner;
      const resultPrefix = `s3://${runner.results_bucket_name}/performance/results/${PRESET}/${name}/`;

      if (options.seedQueueMessage) {
        const queue = snapshot.resources.sqs.source_queue_urls["gb-workitems"];
        await this.floci
          .client(SQSClient)
          .send(new SendMessageCommand({ QueueUrl: queue, MessageBody: "left over from an earlier run" }));
      }

      result.steps.preflight = this.script(
        "preflight",
        ["--snapshot", join(exp, "snapshot.json"), "--output", join(exp, "preflight.json")],
        join(logs, "preflight.log"),
      );
      result.preflight = readJsonFile(join(exp, "preflight.json"));

      if (result.steps.preflight === 0) {
        this.runRunner(exp, logs, snapshot, scenario, resultPrefix, result);
      }

      this.combine(exp, logs, result);
      this.script(
        "s3results",
        ["upload", "--src", this.record(exp), "--prefix", `${resultPrefix}experiment/`],
        join(logs, "upload.log"),
      );
    } finally {
      if (applyAttempted) {
        this.destroy(exp, logs, flags, extraEnv, result);
      }
    }
    return result;
  }

  private runnerEnv(snapshot: Dict, scenario: string, resultPrefix: string): Record<string, string> {
    const env: Record<string, string> = {
      BACKEND_COMMIT: this.images.backendCommit,
      BACKEND_REPO_URL: "file:///fixture/backend.git",
      API_URL: snapshot.api_url,
      TARGET_URL: snapshot.target.url,
      TARGET_MODEL: snapshot.target.model,
      TARGET_REVISION: snapshot.target.revision,
      SCENARIO_PATH: `performance/scenarios/${scenario}.yaml`,
      DATASET_PATH: "performance/datasets/two-cases.yaml",
      RESULT_S3_PREFIX: `${resultPrefix}runner/`,
    };
    return Object.fromEntries(Object.entries(env).filter(([, value]) => value));
  }

  private runRunner(
    exp: string,
    logs: string,
    snapshot: Dict,
    scenario: string,
    resultPrefix: string,
    result: PipelineResult,
  ): void {
    writeFileSync(join(exp, "build-env.json"), JSON.stringify(this.runnerEnv(snapshot, scenario, resultPrefix), null, 2), "utf-8");
    const project = snapshot.resources.runner.codebuild_project_name;
    result.steps.start_build = this.script(
      "codebuild",
      ["start", "--project", project, "--env-file", join(exp, "build-env.json"), "--output", join(exp, "build-start.json")],
      join(logs, "start-build.log"),
    );
    if (result.steps.start_build !== 0) {
      return;
    }
    result.steps.wait_build = this.script(
      "codebuild",
      ["wait", "--start-file", join(exp, "build-start.json"), "--output", join(exp, "build.json"), "--timeout-seconds", "900", "--poll-seconds", "2"],
      join(logs, "wait-build.log"),
    );
    this.script("codebuild", ["stop", "--start-file", join(exp, "build-start.json")], join(logs, "stop-build.log"));
    mkdirSync(join(exp, "results"));
    result.steps.download = this.script(
      "s3results",
      ["download", "--prefix", `${resultPrefix}runner/`, "--dest", join(exp, "results")],
      join(logs, "download.log"),
    );
    result.steps.collect = this.script(
      "collect",
      [
        "--snapshot", join(exp, "snapshot.json"),
        "--result-dir", join(exp, "results"),
        "--build", join(exp, "build.json"),
        "--output", join(exp, "infrastructure.json"),
        "--logs-output", join(exp, "ecs-logs.json"),
        "--drain-timeout-seconds", "30",
        "--drain-poll-seconds", "2",
      ],
      join(logs, "collect.log"),
    );
    if (existsSync(join(exp, "build.json"))) {
      result.build = readJsonFile(join(exp, "build.json"));
    }
    result.runnerFiles = existsSync(join(exp, "results")) ? readdirSync(join(exp, "results")).sort() : [];
  }

  private combine(exp: string, logs: string, result: PipelineResult): void {
    result.steps.combine = this.script(
      "combine",
      [
        "--snapshot", join(exp, "snapshot.json"),
        "--result-dir", join(exp, "results"),
        "--build", join(exp, "build.json"),
        "--infrastructure", join(exp, "infrastructure.json"),
        "--preflight", join(exp, "preflight.json"),
        "--output", join(exp, "final.json"),
        "--summary", join(exp, "summary.md"),
      ],
      join(logs, "combine.log"),
    );
    result.final = readJsonFile(join(exp, "final.json"));
  }

  private record(exp: string): string {
    const record = join(exp, "record");
    mkdirSync(record, { recursive: true });
    for (const name of ["snapshot", "preflight", "build-start", "build", "infrastructure", "ecs-logs", "final"]) {
      if (existsSync(join(exp, `${name}.json`))) {
        cpSync(join(exp, `${name}.json`), join(record, `${name}.json`));
      }
    }
    if (existsSync(join(exp, "summary.md"))) {
      cpSync(join(exp, "summary.md"), join(record, "summary.md"));
    }
    return record;
  }

  private destroy(exp: string, logs: string, flags: string[], extraEnv: Record<string, string>, result: PipelineResult): void {
    const destroy = this.workspace.terraform(
      "performance-experiment",
      ["destroy", "-input=false", "-auto-approve", "-no-color", "-lock-timeout=5m", ...flags],
      { extraEnv, log: join(logs, "destroy.log"), check: false },
    );
    result.steps.destroy = destroy.status;
    const state = this.workspace.terraform("performance-experiment", ["state", "list"], {
      log: join(logs, "state.log"),
      check: false,
    });
    writeFileSync(
      join(exp, "state-after-destroy.txt"),
      state.status === 0 ? state.stdout : "state list could not be read\n",
      "utf-8",
    );
    const args = ["--state-list", join(exp, "state-after-destroy.txt"), "--output", join(exp, "destroy-verification.json")];
    if (existsSync(join(exp, "snapshot.json"))) {
      args.push("--snapshot", join(exp, "snapshot.json"));
    }
    result.steps.verify_destroy = this.script("verify_destroyed", args, join(logs, "verify-destroy.log"));
    result.destroyVerification = readJsonFile(join(exp, "destroy-verification.json"));
  }
}

/** Floci, stub images and the always-on layers (shared, performance-base), applied once. */
export class Environment {
  readonly floci = new Floci();
  readonly images = new Images();
  readonly artifactsDir: string;
  workspace: Workspace | null = null;
  pipeline: Pipeline | null = null;

  constructor(artifactsDir: string) {
    this.artifactsDir = artifactsDir;
  }

  async start(): Promise<void> {
    const logs = join(this.artifactsDir, "setup");
    await this.floci.start();
    this.images.build();
    await this.floci
      .client(S3Client)
      .send(new CreateBucketCommand({ Bucket: STATE_BUCKET, CreateBucketConfiguration: { LocationConstraint: REGION } }));
    this.workspace = Workspace.create(this.floci);
    const layers: [string, string[]][] = [
      ["shared", []],
      [
        "performance-base",
        [
          "-var=performance_db_instance_class=db.t4g.micro",
          "-var=performance_db_allocated_storage=20",
          "-var=performance_db_max_allocated_storage=100",
          "-var=performance_db_backup_retention_period=0",
          `-var=performance_codebuild_image=${this.images.codebuild}`,
        ],
      ],
    ];
    for (const [rootName, args] of layers) {
      this.workspace.terraform(rootName, ["init", "-input=false", "-no-color"], { log: join(logs, `${rootName}-init.log`) });
      this.workspace.terraform(rootName, ["apply", "-input=false", "-auto-approve", "-no-color", ...args], {
        log: join(logs, `${rootName}-apply.log`),
      });
    }
    this.pipeline = new Pipeline(this.floci, this.workspace, this.images, join(this.artifactsDir, "runs"));
  }

  stop(): void {
    this.floci.stop();
    this.workspace?.remove();
    this.images.remove();
  }

  async purgeSourceQueues(snapshot: Dict): Promise<void> {
    const sqs = this.floci.client(SQSClient);
    for (const url of Object.values<string>(snapshot.resources.sqs.source_queue_urls)) {
      await sqs.send(new PurgeQueueCommand({ QueueUrl: url }));
    }
  }

  /** Independent of the scripts under test: list what an experiment would have created. */
  async experimentResourcesLeft(): Promise<string[]> {
    const left: string[] = [];
    const ecs = this.floci.client(ECSClient);
    for (const cluster of (await ecs.send(new ListClustersCommand({}))).clusterArns ?? []) {
      for (const arn of (await ecs.send(new ListServicesCommand({ cluster }))).serviceArns ?? []) {
        left.push(`ecs service ${arn}`);
      }
    }
    for (const family of ["performance-app", "performance-worker", "demo-ai"]) {
      const listing = await ecs.send(
        new ListTaskDefinitionsCommand({ familyPrefix: `guardbench-dev-${family}`, status: "ACTIVE" }),
      );
      for (const arn of listing.taskDefinitionArns ?? []) {
        left.push(`ecs task definition ${arn}`);
      }
    }
    const sagemaker = this.floci.client(SageMakerClient);
    for (const item of (await sagemaker.send(new ListEndpointsCommand({}))).Endpoints ?? []) {
      left.push(`sagemaker endpoint ${item.EndpointName}`);
    }
    for (const item of (await sagemaker.send(new ListEndpointConfigsCommand({}))).EndpointConfigs ?? []) {
      left.push(`sagemaker endpoint config ${item.EndpointConfigName}`);
    }
    for (const item of (await sagemaker.send(new ListModelsCommand({}))).Models ?? []) {
      left.push(`sagemaker model ${item.ModelName}`);
    }
    const logs = this.floci.client(CloudWatchLogsClient);
    for (const item of (await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: "/ecs/" }))).logGroups ?? []) {
      left.push(`log group ${item.logGroupName}`);
    }
    const iam = this.floci.client(IAMClient);
    const markers = ["performance-ecs-exec", "performance-app-task", "performance-sagemaker-exec", "demo-ai-"];
    for (const role of (await iam.send(new ListRolesCommand({}))).Roles ?? []) {
      if (markers.some((marker) => (role.RoleName ?? "").includes(marker))) {
        left.push(`iam role ${role.RoleName}`);
      }
    }
    const ec2 = this.floci.client(EC2Client);
    const groups = ["guardbench-dev-performance-api-sg", "guardbench-dev-performance-worker-sg", "guardbench-dev-demo-ai-sg"];
    for (const group of (await ec2.send(new DescribeSecurityGroupsCommand({}))).SecurityGroups ?? []) {
      if (groups.includes(group.GroupName ?? "")) {
        left.push(`security group ${group.GroupName}`);
      }
    }
    const containers = run(["docker", "ps", "--all", "--format", "{{.Names}}"], { check: false }).stdout.split(/\s+/);
    for (const name of containers) {
      if (name.startsWith("floci-aws-ecs-") || name.startsWith("floci-aws-sagemaker-endpoint-")) {
        left.push(`container ${name}`);
      }
    }
    return left;
  }

  /** Number of Runner builds ever started in the CodeBuild projects. */
  async runnerBuildCount(): Promise<number> {
    const codebuild = this.floci.client(CodeBuildClient);
    let count = 0;
    for (const name of (await codebuild.send(new ListProjectsCommand({}))).projects ?? []) {
      count += ((await codebuild.send(new ListBuildsForProjectCommand({ projectName: name }))).ids ?? []).length;
    }
    return count;
  }

  /** Object keys recorded under a prefix of a results bucket. */
  async listKeys(bucket: string, prefix: string): Promise<string[]> {
    const listing = await this.floci.client(S3Client).send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    return (listing.Contents ?? []).map((item) => (item.Key ?? "").slice(prefix.length));
  }
}
