import json
import tempfile
import unittest
from pathlib import Path

from scripts.performance import combine
from scripts.performance.common import ERROR, FAIL, PASS

from .fakes import make_snapshot


def runner_result(status="PASS", concurrency=5, cases=20):
    return {
        "schema_version": 2,
        "run_id": "smoke-20261122T010000Z-abcd1234",
        "started_at": "2026-11-22T01:00:10Z",
        "finished_at": "2026-11-22T01:03:10Z",
        "scenario": {"id": "smoke", "type": "SMOKE"},
        "dataset": {"id": "baseline-v1", "test_case_count": cases, "suite_id": 7},
        "tuple": {"concurrent_test_runs": concurrency, "test_case_count": cases},
        "acceptance": {
            "status": status,
            "checks": [{"name": "api.p95", "status": "FAIL" if status == "FAIL" else "PASS"}],
        },
    }


def infra(status=PASS, checks=None):
    return {"status": status, "checks": checks or []}


class CombineTest(unittest.TestCase):
    def setUp(self):
        self._directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        self.results = Path(self._directory.name) / "results"
        self.results.mkdir()
        self.snapshot = make_snapshot()

    def write(self, name, content):
        path = self.results / name
        path.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")

    def combine(self, build=None, infrastructure=None, preflight=None, with_results=True):
        return combine.combine(
            self.snapshot,
            self.results if with_results else None,
            build or {"status": "SUCCEEDED", "build_id": "perf-runner:1"},
            infrastructure if infrastructure is not None else infra(),
            preflight,
        )

    def test_pass_when_runner_and_infrastructure_pass(self):
        self.write("runner-exit-code", "0\n")
        self.write("result.json", runner_result("PASS"))
        final = self.combine(preflight={"status": PASS, "checks": []})
        self.assertEqual(final["status"], PASS)
        self.assertEqual(final["tuple"], {"W": 4, "C": 5, "T": 20})
        self.assertEqual(final["runner"]["status"], PASS)
        self.assertEqual(final["experiment"]["id"], "validation")
        self.assertEqual(final["stage"], "complete")

    def test_measurement_fail_is_fail_with_the_tuple(self):
        self.write("runner-exit-code", "1")
        self.write("result.json", runner_result("FAIL"))
        final = self.combine()
        self.assertEqual(final["status"], FAIL)
        self.assertEqual(final["tuple"]["C"], 5)
        self.assertEqual(final["runner"]["result"]["failed_checks"][0]["name"], "api.p95")

    def test_runner_error_keeps_failure_file(self):
        self.write("runner-exit-code", "2")
        self.write("failure.json", {"phase": "report", "error": {"type": "ApiError"}})
        final = self.combine()
        self.assertEqual(final["status"], ERROR)
        self.assertEqual(final["runner"]["failure"]["phase"], "report")
        self.assertIsNone(final["tuple"]["C"])
        self.assertEqual(final["tuple"]["W"], 4)

    def test_missing_exit_code_file_is_treated_as_two(self):
        self.write("result.json", runner_result("PASS"))
        final = self.combine()
        self.assertEqual(final["status"], ERROR)
        self.assertEqual(final["runner"]["exit_code"], 2)
        self.assertEqual(final["runner"]["exit_code_source"], "missing")
        self.assertTrue(any("runner-exit-code" in reason for reason in final["reasons"]))

    def test_missing_results_directory_is_treated_as_two(self):
        final = self.combine(with_results=False)
        self.assertEqual(final["runner"]["exit_code"], 2)
        self.assertEqual(final["status"], ERROR)

    def test_invalid_exit_code_values_are_treated_as_two(self):
        for text in ("abc", "3", ""):
            with self.subTest(text=text):
                self.write("runner-exit-code", text)
                final = self.combine()
                self.assertEqual(final["runner"]["exit_code"], 2)
                self.assertEqual(final["runner"]["exit_code_source"], "invalid")

    def test_exit_zero_without_result_json_is_an_error(self):
        self.write("runner-exit-code", "0")
        final = self.combine()
        self.assertEqual(final["status"], ERROR)
        self.assertEqual(final["runner"]["exit_code"], 2)

    def test_exit_zero_with_unreadable_result_json_is_an_error(self):
        self.write("runner-exit-code", "0")
        self.write("result.json", "{not json")
        self.assertEqual(self.combine()["status"], ERROR)

    def test_infrastructure_fail_makes_final_fail_even_when_runner_passes(self):
        self.write("runner-exit-code", "0")
        self.write("result.json", runner_result("PASS"))
        failing = infra(FAIL, [{"name": "dlq_empty.resolve", "status": FAIL, "message": "dlq not empty"}])
        final = self.combine(infrastructure=failing)
        self.assertEqual(final["status"], FAIL)
        self.assertEqual(final["runner"]["status"], PASS)
        self.assertTrue(any("dlq_empty.resolve" in reason for reason in final["reasons"]))

    def test_infrastructure_error_makes_final_error(self):
        self.write("runner-exit-code", "0")
        self.write("result.json", runner_result("PASS"))
        self.assertEqual(self.combine(infrastructure=infra(ERROR))["status"], ERROR)

    def test_runner_fail_and_infrastructure_error_is_error(self):
        self.write("runner-exit-code", "1")
        self.write("result.json", runner_result("FAIL"))
        self.assertEqual(self.combine(infrastructure=infra(ERROR))["status"], ERROR)

    def test_missing_infrastructure_evidence_is_an_error(self):
        self.write("runner-exit-code", "0")
        self.write("result.json", runner_result("PASS"))
        final = combine.combine(self.snapshot, self.results, {"status": "SUCCEEDED"}, None, None)
        self.assertEqual(final["status"], ERROR)
        self.assertEqual(final["infrastructure"]["status"], combine.NOT_COLLECTED)

    def test_failed_preflight_stops_before_the_runner(self):
        preflight = {
            "status": FAIL,
            "checks": [{"name": "rds.instance_class", "status": FAIL, "message": "expected 'a', found 'b'"}],
        }
        final = combine.combine(self.snapshot, None, None, None, preflight)
        self.assertEqual(final["status"], ERROR)
        self.assertEqual(final["stage"], "preflight")
        self.assertEqual(final["runner"]["status"], combine.NOT_RUN)
        self.assertIsNone(final["runner"]["exit_code"])
        self.assertTrue(any("rds.instance_class" in reason for reason in final["reasons"]))

    def test_build_that_timed_out_without_results_is_an_error(self):
        build = {"status": "TIMED_OUT", "build_id": "perf-runner:1"}
        final = self.combine(build=build, with_results=False)
        self.assertEqual(final["status"], ERROR)
        self.assertEqual(final["build"]["status"], "TIMED_OUT")


class CombineCliTest(unittest.TestCase):
    def run_cli(self, exit_code, result_status=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "results").mkdir()
            (root / "snapshot.json").write_text(json.dumps(make_snapshot()), encoding="utf-8")
            (root / "infra.json").write_text(json.dumps(infra()), encoding="utf-8")
            if exit_code is not None:
                (root / "results" / "runner-exit-code").write_text(str(exit_code), encoding="utf-8")
            if result_status:
                (root / "results" / "result.json").write_text(json.dumps(runner_result(result_status)), encoding="utf-8")
            code = combine.main(
                [
                    "--snapshot", str(root / "snapshot.json"),
                    "--result-dir", str(root / "results"),
                    "--infrastructure", str(root / "infra.json"),
                    "--output", str(root / "final.json"),
                    "--summary", str(root / "summary.md"),
                ]
            )
            return code, json.loads((root / "final.json").read_text(encoding="utf-8")), (root / "summary.md").read_text(encoding="utf-8")

    def test_exit_codes_follow_the_verdict(self):
        self.assertEqual(self.run_cli(0, "PASS")[0], 0)
        self.assertEqual(self.run_cli(1, "FAIL")[0], 1)
        self.assertEqual(self.run_cli(2)[0], 2)
        self.assertEqual(self.run_cli(None)[0], 2)

    def test_summary_names_the_verdict_and_tuple(self):
        _, final, summary = self.run_cli(1, "FAIL")
        self.assertEqual(final["status"], FAIL)
        self.assertIn("(4, 5, 20)", summary)
        self.assertIn("**FAIL**", summary)
        self.assertIn("Reasons", summary)


if __name__ == "__main__":
    unittest.main()
