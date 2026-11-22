import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from scripts.performance import codebuild

from .fakes import FakeBuildLogs, FakeCodeBuild, client_error

ENV = {
    "BACKEND_COMMIT": "0" * 40,
    "API_URL": "http://api",
    "TARGET_URL": "http://target",
    "TARGET_MODEL": "model",
    "TARGET_REVISION": "rev",
    "SCENARIO_PATH": "performance/scenarios/smoke.yaml",
    "DATASET_PATH": "performance/datasets/base.yaml",
    "RESULT_S3_PREFIX": "s3://bucket/performance/results/run/",
}


class CodeBuildTest(unittest.TestCase):
    def test_start_passes_every_value_as_an_override(self):
        fake = FakeCodeBuild(["IN_PROGRESS"])
        started = codebuild.start_build(fake, "perf-runner", ENV)
        self.assertEqual(started["build_id"], "perf-runner:1")
        sent = {item["name"]: item["value"] for item in fake.started[0]["env"]}
        self.assertEqual(sent, ENV)
        self.assertTrue(all(item["type"] == "PLAINTEXT" for item in fake.started[0]["env"]))

    def test_start_rejects_missing_required_values(self):
        for name in ("BACKEND_COMMIT", "API_URL", "RESULT_S3_PREFIX"):
            with self.subTest(name=name):
                env = dict(ENV)
                env[name] = ""
                with self.assertRaisesRegex(ValueError, name):
                    codebuild.start_build(FakeCodeBuild(["IN_PROGRESS"]), "p", env)

    def test_target_revision_is_optional(self):
        env = dict(ENV)
        del env["TARGET_REVISION"]
        codebuild.start_build(FakeCodeBuild(["IN_PROGRESS"]), "p", env)

    def test_wait_polls_until_a_terminal_state_and_prints_logs(self):
        fake = FakeCodeBuild(["IN_PROGRESS", "IN_PROGRESS", "SUCCEEDED"])
        sleeps = []
        output = io.StringIO()
        with redirect_stdout(output):
            summary = codebuild.wait_for_build(
                fake, FakeBuildLogs(["hello from build"]), "perf-runner:1", 600, 5, sleep=sleeps.append, monotonic=lambda: 0.0
            )
        self.assertEqual(summary["status"], "SUCCEEDED")
        self.assertEqual(sleeps, [5, 5])
        self.assertIn("hello from build", output.getvalue())
        self.assertFalse(summary["wait_timed_out"])

    def test_failed_build_is_reported_not_raised(self):
        summary = codebuild.wait_for_build(
            FakeCodeBuild(["FAILED"]), FakeBuildLogs(), "perf-runner:1", 600, 5, sleep=lambda _: None, monotonic=lambda: 0.0
        )
        self.assertEqual(summary["status"], "FAILED")
        self.assertEqual(summary["build_id"], "perf-runner:1")

    def test_missing_logs_do_not_fail_the_wait(self):
        logs = FakeBuildLogs(error=client_error("ResourceNotFoundException", "no stream", "GetLogEvents"))
        summary = codebuild.wait_for_build(
            FakeCodeBuild(["SUCCEEDED"]), logs, "perf-runner:1", 600, 5, sleep=lambda _: None, monotonic=lambda: 0.0
        )
        self.assertEqual(summary["status"], "SUCCEEDED")

    def test_timeout_stops_the_build(self):
        fake = FakeCodeBuild(["IN_PROGRESS"])
        clock = iter([0.0, 10.0, 20.0, 30.0, 40.0])
        summary = codebuild.wait_for_build(
            fake, FakeBuildLogs(), "perf-runner:1", 15, 5, sleep=lambda _: None, monotonic=lambda: next(clock)
        )
        self.assertTrue(summary["wait_timed_out"])
        self.assertEqual(fake.stopped, ["perf-runner:1"])

    def test_stop_is_a_no_op_for_finished_builds(self):
        fake = FakeCodeBuild(["SUCCEEDED"])
        self.assertEqual(codebuild.stop_build(fake, "perf-runner:1"), "SUCCEEDED")
        self.assertEqual(fake.stopped, [])

    def test_stop_requests_stop_for_running_builds(self):
        fake = FakeCodeBuild(["IN_PROGRESS"])
        self.assertEqual(codebuild.stop_build(fake, "perf-runner:1"), "STOP_REQUESTED")
        self.assertEqual(fake.stopped, ["perf-runner:1"])

    def test_cli_start_wait_stop(self):
        fake = FakeCodeBuild(["SUCCEEDED"])

        class Clients:
            codebuild = fake
            logs = FakeBuildLogs()

        original = codebuild.Clients
        codebuild.Clients = Clients
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "env.json").write_text(json.dumps(ENV), encoding="utf-8")
                self.assertEqual(codebuild.main(["start", "--project", "perf-runner", "--env-file", str(root / "env.json"), "--output", str(root / "start.json")]), 0)
                self.assertEqual(codebuild.main(["wait", "--start-file", str(root / "start.json"), "--output", str(root / "build.json"), "--poll-seconds", "0"]), 0)
                self.assertEqual(json.loads((root / "build.json").read_text(encoding="utf-8"))["status"], "SUCCEEDED")
                self.assertEqual(codebuild.main(["stop", "--start-file", str(root / "start.json")]), 0)
        finally:
            codebuild.Clients = original

    def test_cli_rejects_incomplete_environment(self):
        class Clients:
            codebuild = FakeCodeBuild(["IN_PROGRESS"])

        original = codebuild.Clients
        codebuild.Clients = Clients
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "env.json").write_text(json.dumps({"API_URL": "x"}), encoding="utf-8")
                code = codebuild.main(["start", "--project", "p", "--env-file", str(root / "env.json"), "--output", str(root / "o.json")])
                self.assertEqual(code, 2)
        finally:
            codebuild.Clients = original


if __name__ == "__main__":
    unittest.main()
