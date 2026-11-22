"""Pipeline test: the entrypoint's steps against Floci, for Runner 0 / 1 / 2 and a failed preflight.

Needs Docker and Terraform. Run explicitly: FLOCI_PIPELINE=1 python3 -m unittest tests.floci.test_pipeline
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from .harness import PRESET, Environment


@unittest.skipUnless(os.environ.get("FLOCI_PIPELINE") == "1", "set FLOCI_PIPELINE=1 to run the Floci pipeline test (needs Docker)")
class FlociPipelineTest(unittest.TestCase):
    environment: Environment

    @classmethod
    def setUpClass(cls) -> None:
        artifacts = os.environ.get("FLOCI_TEST_ARTIFACTS") or tempfile.mkdtemp(prefix="floci-iac-artifacts-")
        cls.environment = Environment(Path(artifacts))
        try:
            cls.environment.start()
        except BaseException:
            cls.environment.stop()
            raise
        print(f"Floci pipeline test artifacts: {artifacts}", flush=True)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.environment.stop()

    def run_scenario(self, name: str, scenario: str, **options):
        result = self.environment.pipeline.execute(name, scenario, **options)
        if result.snapshot:
            self.environment.purge_source_queues(result.snapshot)
        return result

    def assert_destroyed(self, result) -> None:
        self.assertEqual(result.steps["destroy"], 0, "terraform destroy")
        self.assertEqual(result.steps["verify_destroy"], 0, result.destroy_verification)
        self.assertEqual(result.destroy_verification["status"], "PASS")
        self.assertEqual(self.environment.experiment_resources_left(), [])

    def runner_exit_code(self, result) -> str:
        return (result.exp_dir / "results" / "runner-exit-code").read_text(encoding="utf-8").strip()

    def recorded_keys(self, result) -> set[str]:
        snapshot = result.snapshot["resources"]["runner"]
        prefix = f"performance/results/{PRESET}/{result.name}/experiment/"
        listing = self.environment.floci.client("s3").list_objects_v2(Bucket=snapshot["results_bucket_name"], Prefix=prefix)
        return {item["Key"][len(prefix):] for item in listing.get("Contents", [])}

    def test_1_runner_pass(self) -> None:
        result = self.run_scenario("pass", "pass")
        self.assertEqual(result.steps["preflight"], 0, result.preflight)
        self.assertEqual(result.build["status"], "SUCCEEDED")
        self.assertIn("result.json", result.runner_files)
        self.assertEqual(self.runner_exit_code(result), "0")
        self.assertEqual(result.final["status"], "PASS", result.final)
        self.assertEqual(result.final["tuple"], {"W": 1, "C": 2, "T": 2})
        self.assertEqual(result.final["infrastructure"]["status"], "PASS")
        self.assertEqual(result.steps["combine"], 0)
        self.assertTrue({"final.json", "summary.md", "snapshot.json"} <= self.recorded_keys(result))
        self.assert_destroyed(result)

    def test_2_measurement_fail(self) -> None:
        result = self.run_scenario("fail", "fail")
        self.assertEqual(result.build["status"], "FAILED")
        self.assertEqual(self.runner_exit_code(result), "1")
        self.assertIn("result.json", result.runner_files)
        self.assertEqual(result.final["status"], "FAIL", result.final)
        self.assertEqual(result.final["runner"]["status"], "FAIL")
        self.assertEqual(result.final["tuple"], {"W": 1, "C": 2, "T": 2})
        self.assertEqual(result.steps["combine"], 1)
        self.assertTrue({"final.json", "summary.md"} <= self.recorded_keys(result))
        self.assert_destroyed(result)

    def test_3_runner_error(self) -> None:
        result = self.run_scenario("error", "error")
        self.assertEqual(result.build["status"], "FAILED")
        self.assertEqual(self.runner_exit_code(result), "2")
        self.assertIn("failure.json", result.runner_files)
        self.assertNotIn("result.json", result.runner_files)
        self.assertEqual(result.final["status"], "ERROR", result.final)
        self.assertEqual(result.final["runner"]["failure"]["phase"], "report")
        self.assertEqual(result.steps["combine"], 2)
        self.assertTrue({"final.json", "summary.md"} <= self.recorded_keys(result))
        self.assert_destroyed(result)

    def runner_build_count(self) -> int:
        codebuild = self.environment.floci.client("codebuild")
        projects = codebuild.list_projects().get("projects", [])
        return sum(len(codebuild.list_builds_for_project(projectName=name)["ids"]) for name in projects)

    def test_4_preflight_failure_stops_before_the_runner(self) -> None:
        builds_before = self.runner_build_count()
        result = self.run_scenario("preflight", "pass", seed_queue_message=True)
        self.assertEqual(result.steps["preflight"], 1)
        self.assertEqual(result.preflight["status"], "FAIL")
        failed = [item["name"] for item in result.preflight["checks"] if item["status"] != "PASS"]
        self.assertEqual(failed, ["sqs.source.gb-workitems"])
        self.assertNotIn("start_build", result.steps)
        self.assertEqual(self.runner_build_count(), builds_before, "no Runner build may start")
        self.assertEqual(result.final["status"], "ERROR")
        self.assertEqual(result.final["stage"], "preflight")
        self.assertEqual(result.final["runner"]["status"], "NOT_RUN")
        self.assertTrue({"final.json", "preflight.json"} <= self.recorded_keys(result))
        self.assert_destroyed(result)


if __name__ == "__main__":
    unittest.main()
