"""Fixture Runner for the pipeline test: the Backend ADR 0017 command line and result files.

It accepts the contract's arguments, calls the GuardBench API it is pointed at (health check
and test-suite creation) and writes result.json / failure.json in the documented shape. The
scenario's `outcome` field selects PASS, FAIL (measurement FAIL, exit 1) or ERROR (exit 2).
It is not the real Runner: the Backend repository tests that one with its own mock E2E.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _read_fields(path: str) -> dict[str, str]:
    fields = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if ":" in line and not line.startswith("#"):
            key, _, value = line.partition(":")
            fields[key.strip()] = value.strip()
    return fields


def _request(url: str, method: str = "GET", body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310 - URL comes from the CLI
        payload = response.read().decode()
        return json.loads(payload) if payload.startswith("{") else {}


def run(args: argparse.Namespace) -> int:
    started_at = _now()
    scenario = _read_fields(args.scenario)
    dataset = _read_fields(args.dataset)
    result_dir = Path(args.result_dir)
    result_dir.mkdir(parents=True, exist_ok=False)
    run_id = f"{scenario['id']}-{uuid.uuid4().hex[:8]}"

    api_url = args.api_url.rstrip("/")
    with urllib.request.urlopen(api_url + "/health", timeout=10) as response:  # noqa: S310
        if response.status != 200:
            raise RuntimeError(f"health check returned {response.status}")
    suite = _request(api_url + "/api/v1/test-suites", "POST", {"name": run_id})["data"]

    if scenario["outcome"] == "ERROR":
        failure = {
            "run_id": run_id,
            "phase": "report",
            "suite_id": suite["id"],
            "error": {"type": "ApiError", "message": "fixture execution error"},
        }
        (result_dir / "failure.json").write_text(json.dumps(failure, indent=2) + "\n", encoding="utf-8")
        print("ERROR: fixture execution error", file=sys.stderr)
        return 2

    failed = scenario["outcome"] == "FAIL"
    concurrency = int(scenario["concurrent_test_runs"])
    cases = int(dataset["test_case_count"])
    result = {
        "schema_version": 2,
        "run_id": run_id,
        "started_at": started_at,
        "finished_at": _now(),
        "scenario": {"id": scenario["id"], "type": scenario["type"]},
        "connection": {
            "api_url": args.api_url,
            "target": {
                "type": "HTTP_ENDPOINT",
                "url": args.target_url,
                "model": args.target_model,
                "revision": args.target_revision or None,
            },
        },
        "dataset": {"id": dataset["id"], "test_case_count": cases, "suite_id": suite["id"]},
        "workload": {"concurrent_test_runs": concurrency},
        "tuple": {"concurrent_test_runs": concurrency, "test_case_count": cases},
        "k6": {"exit_code": 99 if failed else 0, "thresholds": "FAIL" if failed else "PASS"},
        "failure_categories": {"thresholds": "FAIL" if failed else "PASS", "execution_failures": 0},
        "acceptance": {
            "status": "FAIL" if failed else "PASS",
            "checks": [{"name": "api.create_latency_p95", "status": "FAIL" if failed else "PASS"}],
        },
    }
    (result_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    (result_dir / "report.md").write_text(f"# {scenario['id']}\n\nDecision: {result['acceptance']['status']}\n", encoding="utf-8")
    print(f"{result['acceptance']['status']}: {result_dir}")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--target-url", required=True)
    parser.add_argument("--target-model", required=True)
    parser.add_argument("--target-revision", default="")
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--result-dir", required=True)
    args = parser.parse_args(argv)
    try:
        return run(args)
    except Exception as exc:  # noqa: BLE001
        failure_dir = Path(args.result_dir)
        failure_dir.mkdir(parents=True, exist_ok=True)
        (failure_dir / "failure.json").write_text(
            json.dumps({"phase": "api", "error": {"type": type(exc).__name__, "message": str(exc)}}) + "\n", encoding="utf-8"
        )
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
