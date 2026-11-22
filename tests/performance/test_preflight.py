import copy
import json
import tempfile
import unittest
from pathlib import Path

from scripts.performance import preflight
from scripts.performance.common import ERROR, FAIL, PASS

from .fakes import client_error, healthy_clients, make_snapshot


def by_name(result):
    return {item["name"]: item for item in result["checks"]}


class PreflightTest(unittest.TestCase):
    def setUp(self):
        self.snapshot = make_snapshot()
        self.clients, self.fakes = healthy_clients(self.snapshot)

    def run_preflight(self):
        return preflight.evaluate(self.snapshot, self.clients)

    def test_matching_state_passes(self):
        result = self.run_preflight()
        self.assertEqual(result["status"], PASS, [c for c in result["checks"] if c["status"] != PASS])
        names = by_name(result)
        for expected_name in (
            "ecs.api.desired_count",
            "ecs.worker.work_items_concurrency",
            "rds.instance_class",
            "sagemaker.status",
            "sqs.source.workitems",
            "sqs.dlq.workitems",
        ):
            self.assertIn(expected_name, names)

    def test_rds_class_mismatch_fails(self):
        self.fakes["rds"].instance_class = "db.m7g.large"
        result = self.run_preflight()
        self.assertEqual(result["status"], FAIL)
        self.assertEqual(by_name(result)["rds.instance_class"]["status"], FAIL)

    def test_api_running_count_below_desired_fails(self):
        self.fakes["ecs"].services["perf-app"]["runningCount"] = 1
        result = self.run_preflight()
        self.assertEqual(result["status"], FAIL)
        self.assertEqual(by_name(result)["ecs.api.running_count"]["status"], FAIL)

    def test_unfinished_rollout_fails(self):
        self.fakes["ecs"].services["perf-worker"]["deployments"] = [
            {"status": "PRIMARY", "rolloutState": "IN_PROGRESS"},
            {"status": "ACTIVE", "rolloutState": "COMPLETED"},
        ]
        result = self.run_preflight()
        self.assertEqual(result["status"], FAIL)
        self.assertEqual(by_name(result)["ecs.worker.rollout"]["status"], FAIL)

    def test_task_definition_mismatch_fails(self):
        self.fakes["ecs"].services["perf-app"]["taskDefinition"] = "arn:other:1"
        self.assertEqual(by_name(self.run_preflight())["ecs.api.task_definition"]["status"], FAIL)

    def test_task_size_mismatch_fails(self):
        arn = self.snapshot["resources"]["ecs"]["api"]["task_definition_arn"]
        self.fakes["ecs"].definitions[arn]["cpu"] = "1024"
        self.assertEqual(by_name(self.run_preflight())["ecs.api.task_cpu"]["status"], FAIL)

    def test_worker_concurrency_mismatch_fails(self):
        arn = self.snapshot["resources"]["ecs"]["worker"]["task_definition_arn"]
        self.fakes["ecs"].definitions[arn]["containerDefinitions"][0]["environment"][0]["value"] = "9"
        self.assertEqual(by_name(self.run_preflight())["ecs.worker.work_items_concurrency"]["status"], FAIL)

    def test_sagemaker_not_in_service_fails(self):
        self.fakes["sagemaker"].status = "Creating"
        self.assertEqual(by_name(self.run_preflight())["sagemaker.status"]["status"], FAIL)

    def test_sagemaker_instance_type_mismatch_fails(self):
        self.fakes["sagemaker"].instance_type = "ml.g5.2xlarge"
        self.assertEqual(by_name(self.run_preflight())["sagemaker.instance_type"]["status"], FAIL)

    def test_lookup_failure_is_an_error_not_a_pass(self):
        self.fakes["rds"].error = client_error("AccessDenied", "denied", "DescribeDBInstances")
        result = self.run_preflight()
        self.assertEqual(result["status"], ERROR)
        self.assertEqual(by_name(result)["rds.instance"]["status"], ERROR)

    def test_ecs_lookup_failure_is_an_error(self):
        self.fakes["ecs"].fail_describe_services = RuntimeError("timeout")
        self.assertEqual(self.run_preflight()["status"], ERROR)

    def test_missing_service_fails(self):
        del self.fakes["ecs"].services["perf-demo"]
        self.assertEqual(by_name(self.run_preflight())["ecs.demo_ai.exists"]["status"], FAIL)

    def test_residual_source_queue_message_fails(self):
        url = self.snapshot["resources"]["sqs"]["source_queue_urls"]["workitems"]
        self.fakes["sqs"].depths[url] = (0, 2, 0)
        result = self.run_preflight()
        self.assertEqual(result["status"], FAIL)
        self.assertEqual(by_name(result)["sqs.source.workitems"]["status"], FAIL)

    def test_dead_letter_message_fails(self):
        url = self.snapshot["resources"]["sqs"]["dlq_urls"]["resolve"]
        self.fakes["sqs"].depths[url] = (1, 0, 0)
        self.assertEqual(by_name(self.run_preflight())["sqs.dlq.resolve"]["status"], FAIL)

    def test_delayed_messages_count_as_residual(self):
        url = self.snapshot["resources"]["sqs"]["source_queue_urls"]["finalize"]
        self.fakes["sqs"].depths[url] = (0, 0, 3)
        self.assertEqual(by_name(self.run_preflight())["sqs.source.finalize"]["status"], FAIL)

    def test_queue_lookup_failure_is_an_error(self):
        url = self.snapshot["resources"]["sqs"]["source_queue_urls"]["resolve"]
        self.fakes["sqs"].errors[url] = client_error("QueueDoesNotExist", "gone", "GetQueueAttributes")
        self.assertEqual(self.run_preflight()["status"], ERROR)

    def test_unsupported_schema_version_is_an_error(self):
        self.snapshot["schema_version"] = 2
        self.assertEqual(self.run_preflight()["status"], ERROR)

    def test_incomplete_snapshot_is_an_error(self):
        broken = copy.deepcopy(self.snapshot)
        del broken["resources"]["sqs"]
        self.assertEqual(preflight.evaluate(broken, self.clients)["status"], ERROR)


class PreflightCliTest(unittest.TestCase):
    def test_main_writes_result_and_exit_code(self):
        snapshot = make_snapshot()
        clients, fakes = healthy_clients(snapshot)
        fakes["rds"].instance_class = "db.m7g.large"
        with tempfile.TemporaryDirectory() as directory:
            snapshot_path = Path(directory) / "snapshot.json"
            output_path = Path(directory) / "preflight.json"
            snapshot_path.write_text(json.dumps(snapshot), encoding="utf-8")
            original = preflight.Clients
            preflight.Clients = lambda: clients
            try:
                code = preflight.main(["--snapshot", str(snapshot_path), "--output", str(output_path)])
            finally:
                preflight.Clients = original
            self.assertEqual(code, 1)
            self.assertEqual(json.loads(output_path.read_text(encoding="utf-8"))["status"], FAIL)

    def test_unreadable_snapshot_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "preflight.json"
            code = preflight.main(["--snapshot", str(Path(directory) / "missing.json"), "--output", str(output_path)])
            self.assertEqual(code, 1)
            self.assertEqual(json.loads(output_path.read_text(encoding="utf-8"))["status"], ERROR)


if __name__ == "__main__":
    unittest.main()
