import unittest

from scripts.performance import verify_destroyed
from scripts.performance.common import ERROR, FAIL, PASS

from .fakes import client_error, healthy_clients, make_snapshot


class VerifyDestroyedTest(unittest.TestCase):
    def setUp(self):
        self.snapshot = make_snapshot()
        self.clients, self.fakes = healthy_clients(self.snapshot)
        # After destroy: services inactive, task definitions inactive, SageMaker gone, no log groups.
        for service in self.fakes["ecs"].services.values():
            service["status"] = "INACTIVE"
        for definition in self.fakes["ecs"].definitions.values():
            definition["status"] = "INACTIVE"
        self.fakes["sagemaker"].exists = False

    def verify(self, state=(), snapshot="default"):
        snapshot = self.snapshot if snapshot == "default" else snapshot
        return verify_destroyed.verify(list(state), snapshot, self.clients)

    def test_clean_account_passes(self):
        result = self.verify()
        self.assertEqual(result["status"], PASS, [c for c in result["checks"] if c["status"] != PASS])

    def test_remaining_state_fails(self):
        result = self.verify(state=["aws_ecs_service.performance_app"])
        self.assertEqual(result["status"], FAIL)

    def test_active_service_fails(self):
        self.fakes["ecs"].services["perf-app"]["status"] = "ACTIVE"
        self.assertEqual(self.verify()["status"], FAIL)

    def test_draining_service_fails(self):
        self.fakes["ecs"].services["perf-worker"]["status"] = "DRAINING"
        self.assertEqual(self.verify()["status"], FAIL)

    def test_missing_service_counts_as_gone(self):
        del self.fakes["ecs"].services["perf-demo"]
        self.assertEqual(self.verify()["status"], PASS)

    def test_active_task_definition_fails(self):
        arn = self.snapshot["resources"]["ecs"]["api"]["task_definition_arn"]
        self.fakes["ecs"].definitions[arn]["status"] = "ACTIVE"
        self.assertEqual(self.verify()["status"], FAIL)

    def test_deleted_task_definition_counts_as_gone(self):
        arn = self.snapshot["resources"]["ecs"]["api"]["task_definition_arn"]
        del self.fakes["ecs"].definitions[arn]
        self.assertEqual(self.verify()["status"], PASS)

    def test_existing_endpoint_fails(self):
        self.fakes["sagemaker"].exists = True
        self.assertEqual(self.verify()["status"], FAIL)

    def test_remaining_log_group_fails(self):
        self.fakes["logs"].existing_groups = {"/ecs/perf/demo"}
        self.assertEqual(self.verify()["status"], FAIL)

    def test_unexpected_lookup_error_is_not_treated_as_gone(self):
        self.fakes["ecs"].fail_describe_services = client_error("AccessDeniedException", "denied", "DescribeServices")
        self.assertEqual(self.verify()["status"], ERROR)

    def test_without_a_snapshot_only_the_state_is_checked(self):
        self.assertEqual(self.verify(snapshot=None)["status"], PASS)
        self.assertEqual(self.verify(state=["x"], snapshot=None)["status"], FAIL)


if __name__ == "__main__":
    unittest.main()
