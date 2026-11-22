"""Combine the Runner's result files and the infrastructure snapshot into the experiment verdict.

The Runner owns the application-level verdict (exit code 0 PASS / 1 FAIL / 2 error);
the infrastructure evidence owns the infrastructure-level verdict. The experiment is
PASS only when both pass. A missing, unreadable or unexpected Runner exit code counts
as 2 (error). The tuple is (W, C, T): W is the Worker concurrency from the snapshot,
C and T come from the Runner result.

Exit code: 0 PASS, 1 FAIL, 2 ERROR.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .common import ERROR, FAIL, PASS, dig, read_json, write_json

EXIT_CODE_FILE = "runner-exit-code"
RESULT_FILE = "result.json"
FAILURE_FILE = "failure.json"
APP_STATUS = {0: PASS, 1: FAIL, 2: ERROR}
NOT_RUN = "NOT_RUN"
NOT_COLLECTED = "NOT_COLLECTED"


def _read_exit_code(result_dir: Path | None, reasons: list[str]) -> tuple[int, str]:
    """Return (exit code, source). Anything but a readable 0, 1 or 2 is 2."""
    path = result_dir / EXIT_CODE_FILE if result_dir else None
    if path is None or not path.is_file():
        reasons.append("runner-exit-code was not found in the results; treated as 2")
        return 2, "missing"
    text = path.read_text(encoding="utf-8").strip()
    try:
        code = int(text)
    except ValueError:
        reasons.append(f"runner-exit-code is not a number ({text!r}); treated as 2")
        return 2, "invalid"
    if code not in APP_STATUS:
        reasons.append(f"runner-exit-code {code} is not 0, 1 or 2; treated as 2")
        return 2, "invalid"
    return code, EXIT_CODE_FILE


def _read_optional_json(path: Path) -> tuple[Any, str | None]:
    if not path.is_file():
        return None, "not found"
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except (OSError, ValueError) as exc:
        return None, f"unreadable ({exc})"


def _result_summary(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "run_id": result.get("run_id"),
        "started_at": result.get("started_at"),
        "finished_at": result.get("finished_at"),
        "scenario": result.get("scenario"),
        "dataset": result.get("dataset"),
        "acceptance_status": (result.get("acceptance") or {}).get("status"),
        "failed_checks": [
            item for item in (result.get("acceptance") or {}).get("checks", []) if item.get("status") == "FAIL"
        ],
    }


def combine(
    snapshot: dict[str, Any],
    result_dir: str | Path | None,
    build: dict[str, Any] | None,
    infrastructure: dict[str, Any] | None,
    preflight: dict[str, Any] | None,
) -> dict[str, Any]:
    reasons: list[str] = []
    worker_concurrency = dig(snapshot, "expected", "ecs", "worker", "work_items_concurrency")
    final: dict[str, Any] = {
        "schema_version": 1,
        "experiment": {
            "id": snapshot.get("id"),
            "revision": snapshot.get("revision"),
            "app_image_tag": snapshot.get("app_image_tag"),
        },
        "tuple": {"W": worker_concurrency, "C": None, "T": None},
        "preflight": {"status": (preflight or {}).get("status", NOT_COLLECTED)},
        "build": {
            "status": (build or {}).get("status", NOT_RUN),
            "build_id": (build or {}).get("build_id"),
        },
    }

    if preflight is not None and preflight.get("status") != PASS:
        failed = [item for item in preflight.get("checks", []) if item.get("status") != PASS]
        reasons += [f"preflight {item['name']}: {item.get('message') or item['status']}" for item in failed] or [
            "preflight did not pass"
        ]
        final.update(
            status=ERROR,
            stage="preflight",
            reasons=reasons,
            runner={"status": NOT_RUN, "exit_code": None},
            infrastructure={"status": NOT_COLLECTED},
        )
        return final

    directory = Path(result_dir) if result_dir else None
    exit_code, source = _read_exit_code(directory, reasons)
    runner: dict[str, Any] = {"exit_code": exit_code, "exit_code_source": source}

    result = None
    if exit_code in (0, 1):
        result, problem = _read_optional_json(directory / RESULT_FILE) if directory else (None, "not found")
        if not isinstance(result, dict):
            reasons.append(f"Runner exit code {exit_code} but {RESULT_FILE} is {problem or 'not an object'}; treated as 2")
            exit_code = 2
            runner["exit_code"] = 2
            result = None
    if result is not None:
        runner["result"] = _result_summary(result)
        tuple_info = result.get("tuple") or {}
        final["tuple"]["C"] = tuple_info.get("concurrent_test_runs")
        final["tuple"]["T"] = tuple_info.get("test_case_count")
        if exit_code == 1:
            reasons.append("Runner reported a measurement FAIL")
    if exit_code == 2 and directory is not None:
        failure, _ = _read_optional_json(directory / FAILURE_FILE)
        if isinstance(failure, dict):
            runner["failure"] = failure
            reasons.append(f"Runner failure at phase {failure.get('phase')}")
    runner["status"] = APP_STATUS[exit_code]
    final["runner"] = runner

    if infrastructure is None:
        infrastructure_status = NOT_COLLECTED
    else:
        infrastructure_status = infrastructure.get("status", ERROR)
    final["infrastructure"] = {
        "status": infrastructure_status,
        "failed_checks": [
            item for item in (infrastructure or {}).get("checks", []) if item.get("status") != PASS
        ],
    }
    for item in final["infrastructure"]["failed_checks"]:
        reasons.append(f"infrastructure {item['name']}: {item.get('message') or item['status']}")
    if infrastructure_status == NOT_COLLECTED and runner["status"] != ERROR:
        reasons.append("infrastructure evidence was not collected")

    statuses = [runner["status"], infrastructure_status]
    if ERROR in statuses or NOT_COLLECTED in statuses:
        final["status"] = ERROR
    elif FAIL in statuses:
        final["status"] = FAIL
    else:
        final["status"] = PASS
    final["stage"] = "complete"
    final["reasons"] = reasons
    return final


def render_summary(final: dict[str, Any]) -> str:
    experiment = final["experiment"]
    tuple_info = final["tuple"]
    runner = final["runner"]
    infrastructure = final["infrastructure"]
    lines = [
        f"## Performance experiment `{experiment['id']}`: {final['status']}",
        "",
        f"- IaC revision: `{experiment['revision']}`",
        f"- Backend image tag: `{experiment['app_image_tag']}`",
        f"- Tuple (W, C, T): ({tuple_info['W']}, {tuple_info['C']}, {tuple_info['T']})",
        "",
        "| Stage | Status |",
        "| --- | --- |",
        f"| Preflight | {final['preflight']['status']} |",
        f"| CodeBuild | {final['build']['status']} |",
        f"| Runner (exit code {runner.get('exit_code')}) | {runner['status']} |",
        f"| Infrastructure | {infrastructure['status']} |",
        f"| **Final** | **{final['status']}** |",
    ]
    if final["reasons"]:
        lines += ["", "### Reasons", ""]
        lines += [f"- {reason}" for reason in final["reasons"]]
    result = runner.get("result")
    if result:
        lines += [
            "",
            "### Runner result",
            "",
            f"- Run: `{result.get('run_id')}`",
            f"- Window: {result.get('started_at')} to {result.get('finished_at')}",
            f"- Acceptance: {result.get('acceptance_status')}",
        ]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Combine Runner results and the snapshot into the verdict.")
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--result-dir", help="directory with the Runner result files downloaded from S3")
    parser.add_argument("--build", help="build summary JSON from `codebuild wait`")
    parser.add_argument("--infrastructure", help="infrastructure evidence JSON from `collect`")
    parser.add_argument("--preflight", help="preflight JSON from `preflight`")
    parser.add_argument("--output", required=True)
    parser.add_argument("--summary", required=True, help="Markdown file for the Step Summary")
    args = parser.parse_args(argv)

    def optional(path: str | None) -> Any:
        return read_json(path) if path and Path(path).is_file() else None

    try:
        final = combine(
            read_json(args.snapshot),
            args.result_dir,
            optional(args.build),
            optional(args.infrastructure),
            optional(args.preflight),
        )
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    write_json(args.output, final)
    Path(args.summary).write_text(render_summary(final), encoding="utf-8")
    print(f"experiment verdict: {final['status']}")
    return {PASS: 0, FAIL: 1}.get(final["status"], 2)


if __name__ == "__main__":
    raise SystemExit(main())
