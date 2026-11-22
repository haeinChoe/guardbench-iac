import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from scripts.performance import collect
from scripts.performance.common import ERROR, FAIL, PASS

from .fakes import client_error, healthy_clients, make_snapshot

START = datetime(2026, 11, 22, 1, 0, tzinfo=timezone.utc)
END = datetime(2026, 11, 22, 1, 10, tzinfo=timezone.utc)


def names(infrastructure):
    return {item["name"]: item for item in infrastructure["checks"]}


class CollectTest(unittest.TestCase):
    def setUp(self):
        self.snapshot = make_snapshot()
        self.clients, self.fakes = healthy_clients(self.snapshot)

    def run_collect(self, drain_timeout=0):
        return collect.collect(self.snapshot, self.clients, START, END, drain_timeout, 0)

    def test_drained_queues_and_clean_dead_letters_pass(self):
        infrastructure, sample = self.run_collect()
        self.assertEqual(infrastructure["status"], PASS, [c for c in infrastructure["checks"] if c["status"] != PASS])
        self.assertEqual(sample, [])
        self.assertIn("queue_drain.workitems", names(infrastructure))

    def test_queue_that_does_not_drain_fails(self):
        url = self.snapshot["resources"]["sqs"]["source_queue_urls"]["workitems"]
        self.fakes["sqs"].depths[url] = (5, 0, 0)
        infrastructure, _ = self.run_collect()
        self.assertEqual(infrastructure["status"], FAIL)
        self.assertEqual(names(infrastructure)["queue_drain.workitems"]["status"], FAIL)

    def test_queue_that_drains_within_the_timeout_passes(self):
        url = self.snapshot["resources"]["sqs"]["source_queue_urls"]["workitems"]
        self.fakes["sqs"].depths[url] = (5, 0, 0)
        self.fakes["sqs"].drain_after_calls = 3
        infrastructure, _ = self.run_collect(drain_timeout=60)
        self.assertEqual(infrastructure["status"], PASS)
        self.assertGreater(self.fakes["sqs"].calls, 3)

    def test_dead_letter_message_fails(self):
        url = self.snapshot["resources"]["sqs"]["dlq_urls"]["finalize"]
        self.fakes["sqs"].depths[url] = (1, 0, 0)
        infrastructure, _ = self.run_collect()
        self.assertEqual(infrastructure["status"], FAIL)
        self.assertEqual(names(infrastructure)["dlq_empty.finalize"]["status"], FAIL)

    def test_queue_lookup_failure_is_an_error(self):
        url = self.snapshot["resources"]["sqs"]["dlq_urls"]["resolve"]
        self.fakes["sqs"].errors[url] = client_error("AccessDenied", "denied", "GetQueueAttributes")
        infrastructure, _ = self.run_collect()
        self.assertEqual(infrastructure["status"], ERROR)

    def test_metric_lookup_failure_is_an_error(self):
        self.fakes["cloudwatch"].error = client_error("AccessDenied", "denied", "GetMetricData")
        infrastructure, _ = self.run_collect()
        self.assertEqual(infrastructure["status"], ERROR)
        self.assertEqual(names(infrastructure)["metrics.collection"]["status"], ERROR)

    def test_metrics_are_summarized_not_judged(self):
        self.fakes["cloudwatch"].values = {
            "ecs.api.CPUUtilization.Average": [10.0, 30.0],
            "rds.CPUUtilization.Maximum": [12.0, 80.0],
            "sagemaker.Invocations.Sum": [3.0, 4.0],
        }
        infrastructure, _ = self.run_collect()
        metrics = infrastructure["metrics"]
        self.assertEqual(metrics["ecs.api.CPUUtilization.Average"], {"datapoints": 2, "value": 20.0})
        self.assertEqual(metrics["rds.CPUUtilization.Maximum"]["value"], 80.0)
        self.assertEqual(metrics["sagemaker.Invocations.Sum"]["value"], 7.0)
        self.assertIsNone(metrics["ecs.worker.CPUUtilization.Average"]["value"])
        self.assertEqual(infrastructure["status"], PASS)

    def test_log_events_in_the_window_are_counted_and_sampled(self):
        inside = int(START.timestamp() * 1000) + 1000
        outside = int(END.timestamp() * 1000) + 60_000
        self.fakes["logs"].events = {
            "/ecs/perf/app": [
                {"timestamp": inside, "message": "INFO started\n"},
                {"timestamp": inside + 1, "message": "ERROR TestRun 12 failed"},
                {"timestamp": outside, "message": "ERROR after the window"},
            ],
            "/ecs/perf/demo": [{"timestamp": inside, "message": "INFO ok"}],
        }
        infrastructure, sample = self.run_collect()
        self.assertEqual(infrastructure["logs"]["/ecs/perf/app"], {"events": 2, "error_events": 1})
        self.assertEqual(infrastructure["logs"]["/ecs/perf/demo"], {"events": 1, "error_events": 0})
        self.assertEqual(len(sample), 3)
        self.assertEqual(infrastructure["status"], PASS)

    def test_log_lookup_failure_is_an_error(self):
        self.fakes["logs"].error_groups["/ecs/perf/demo"] = client_error("ResourceNotFoundException", "no group", "FilterLogEvents")
        infrastructure, _ = self.run_collect()
        self.assertEqual(infrastructure["status"], ERROR)

    def test_cli_writes_evidence_and_log_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "snapshot.json").write_text(json.dumps(self.snapshot), encoding="utf-8")
            original = collect.Clients
            collect.Clients = lambda: self.clients
            try:
                code = collect.main(
                    [
                        "--snapshot", str(root / "snapshot.json"),
                        "--start", "2026-11-22T01:00:00Z",
                        "--end", "2026-11-22T01:10:00Z",
                        "--output", str(root / "infra.json"),
                        "--logs-output", str(root / "logs.json"),
                        "--drain-timeout-seconds", "0",
                    ]
                )
            finally:
                collect.Clients = original
            self.assertEqual(code, 0)
            self.assertEqual(json.loads((root / "infra.json").read_text(encoding="utf-8"))["status"], PASS)
            self.assertEqual(json.loads((root / "logs.json").read_text(encoding="utf-8")), [])

    def test_cli_error_still_writes_an_error_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            code = collect.main(
                [
                    "--snapshot", str(root / "missing.json"),
                    "--start", "2026-11-22T01:00:00Z",
                    "--end", "2026-11-22T01:10:00Z",
                    "--output", str(root / "infra.json"),
                    "--logs-output", str(root / "logs.json"),
                ]
            )
            self.assertEqual(code, 2)
            self.assertEqual(json.loads((root / "infra.json").read_text(encoding="utf-8"))["status"], ERROR)


if __name__ == "__main__":
    unittest.main()
