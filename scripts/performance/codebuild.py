"""Start, wait for and stop the performance Runner CodeBuild build.

`wait` returns 0 whenever the build reached a terminal state, including FAILED
(a measurement FAIL makes the Runner, and so the build, exit with code 1). The
verdict is made later from the Runner's own result files.
Exit code of `wait`: 0 terminal state reached, 2 wait timed out or could not be observed.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime
from typing import Any, Callable

from .common import Clients, iso, log, read_json, write_json

TERMINAL_STATUSES = frozenset({"SUCCEEDED", "FAILED", "FAULT", "TIMED_OUT", "STOPPED"})
REQUIRED_ENV = (
    "BACKEND_COMMIT",
    "API_URL",
    "TARGET_URL",
    "TARGET_MODEL",
    "SCENARIO_PATH",
    "DATASET_PATH",
    "RESULT_S3_PREFIX",
)


def start_build(codebuild: Any, project: str, env: dict[str, str]) -> dict[str, Any]:
    missing = [name for name in REQUIRED_ENV if not env.get(name)]
    if missing:
        raise ValueError(f"missing build environment values: {', '.join(missing)}")
    overrides = [{"name": name, "value": str(value), "type": "PLAINTEXT"} for name, value in sorted(env.items())]
    build = codebuild.start_build(projectName=project, environmentVariablesOverride=overrides)["build"]
    return {"build_id": build["id"], "project": project, "status": build.get("buildStatus")}


def _to_iso(value: Any) -> str | None:
    return iso(value) if isinstance(value, datetime) else (str(value) if value else None)


def _summarize(build: dict[str, Any], timed_out_waiting: bool = False) -> dict[str, Any]:
    logs = build.get("logs") or {}
    return {
        "build_id": build.get("id"),
        "status": build.get("buildStatus"),
        "current_phase": build.get("currentPhase"),
        "start_time": _to_iso(build.get("startTime")),
        "end_time": _to_iso(build.get("endTime")),
        "phases": [
            {"phase": item.get("phaseType"), "status": item.get("phaseStatus")} for item in build.get("phases", [])
        ],
        "logs": {"group_name": logs.get("groupName"), "stream_name": logs.get("streamName")},
        "wait_timed_out": timed_out_waiting,
    }


class _LogFollower:
    """Prints new CloudWatch log events of the build; missing logs are not an error."""

    def __init__(self, logs_client: Any) -> None:
        self._client = logs_client
        self._token: str | None = None

    def drain(self, build: dict[str, Any]) -> None:
        location = build.get("logs") or {}
        group, stream = location.get("groupName"), location.get("streamName")
        if not group or not stream:
            return
        try:
            while True:
                arguments = {"logGroupName": group, "logStreamName": stream, "startFromHead": True}
                if self._token:
                    arguments["nextToken"] = self._token
                response = self._client.get_log_events(**arguments)
                for event in response.get("events", []):
                    print(event.get("message", "").rstrip(), flush=True)
                next_token = response.get("nextForwardToken")
                if not response.get("events") or next_token == self._token:
                    self._token = next_token or self._token
                    return
                self._token = next_token
        except Exception as exc:  # noqa: BLE001 - logs are informational; never fail the wait because of them
            log(f"build log unavailable: {type(exc).__name__}: {exc}")


def wait_for_build(
    codebuild: Any,
    logs_client: Any,
    build_id: str,
    timeout_seconds: float,
    poll_seconds: float,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    deadline = monotonic() + timeout_seconds
    follower = _LogFollower(logs_client)
    last_phase = None
    while True:
        builds = codebuild.batch_get_builds(ids=[build_id]).get("builds", [])
        if not builds:
            raise RuntimeError(f"build {build_id} not found")
        build = builds[0]
        phase = build.get("currentPhase")
        if phase != last_phase:
            log(f"build {build_id}: phase {phase}")
            last_phase = phase
        follower.drain(build)
        if build.get("buildStatus") in TERMINAL_STATUSES:
            return _summarize(build)
        if monotonic() >= deadline:
            stop_build(codebuild, build_id)
            return _summarize(build, timed_out_waiting=True)
        sleep(poll_seconds)


def stop_build(codebuild: Any, build_id: str) -> str:
    """Stop the build if it is still running; return the status seen afterwards."""
    builds = codebuild.batch_get_builds(ids=[build_id]).get("builds", [])
    if not builds:
        return "NOT_FOUND"
    status = builds[0].get("buildStatus")
    if status in TERMINAL_STATUSES:
        return status
    codebuild.stop_build(id=build_id)
    return "STOP_REQUESTED"


def _load_env(path: str) -> dict[str, str]:
    value = read_json(path)
    if not isinstance(value, dict) or not all(isinstance(item, str) for item in value.values()):
        raise ValueError("build environment file must be a JSON object of strings")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Control the performance Runner CodeBuild build.")
    commands = parser.add_subparsers(dest="command", required=True)

    start = commands.add_parser("start")
    start.add_argument("--project", required=True)
    start.add_argument("--env-file", required=True, help="JSON object of build environment overrides")
    start.add_argument("--output", required=True)

    wait = commands.add_parser("wait")
    wait.add_argument("--start-file", required=True)
    wait.add_argument("--output", required=True)
    wait.add_argument("--timeout-seconds", type=float, default=4 * 3600)
    wait.add_argument("--poll-seconds", type=float, default=15)

    stop = commands.add_parser("stop")
    stop.add_argument("--start-file", required=True)

    args = parser.parse_args(argv)
    clients = Clients()
    try:
        if args.command == "start":
            started = start_build(clients.codebuild, args.project, _load_env(args.env_file))
            write_json(args.output, started)
            print(f"started build {started['build_id']}")
            return 0
        build_id = read_json(args.start_file)["build_id"]
        if args.command == "stop":
            print(f"build {build_id}: {stop_build(clients.codebuild, build_id)}")
            return 0
        summary = wait_for_build(
            clients.codebuild, clients.logs, build_id, args.timeout_seconds, args.poll_seconds
        )
        write_json(args.output, summary)
        print(f"build {build_id}: {summary['status']}")
        return 2 if summary["wait_timed_out"] else 0
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
