"""Collect the experiment window's infrastructure evidence and make the infrastructure-level call.

Collected: queue drain and DLQ state, CloudWatch metrics of the ECS services, the RDS
instance and the SageMaker endpoint, and ECS log events of every TestRun in the window.
Infrastructure verdict: PASS when every source queue drains and every DLQ is empty and
all evidence could be read; FAIL when a queue does not drain or a DLQ holds messages;
ERROR when any evidence could not be read. Resource utilization is recorded, not judged:
no utilization criteria are defined yet.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from .common import (
    ERROR,
    FAIL,
    PASS,
    Clients,
    check,
    dig,
    error_check,
    overall,
    parse_iso,
    queue_depth,
    queue_is_empty,
    read_json,
    write_json,
)

METRIC_PERIOD_SECONDS = 60
MAX_LOG_SAMPLE_EVENTS = 500


def wait_for_drain(
    sqs: Any,
    urls: dict[str, str],
    timeout_seconds: float,
    poll_seconds: float,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> tuple[dict[str, dict[str, int]], dict[str, str]]:
    """Poll the source queues until they are all empty or the timeout passes."""
    deadline = monotonic() + timeout_seconds
    depths: dict[str, dict[str, int]] = {}
    errors: dict[str, str] = {}
    while True:
        errors = {}
        for name, url in sorted(urls.items()):
            try:
                depths[name] = queue_depth(sqs, url)
            except Exception as exc:  # noqa: BLE001
                errors[name] = f"{type(exc).__name__}: {exc}"
        if errors or all(queue_is_empty(depths[name]) for name in urls):
            return depths, errors
        if monotonic() >= deadline:
            return depths, errors
        sleep(poll_seconds)


def _queue_checks(
    depths: dict[str, dict[str, int]],
    errors: dict[str, str],
    kind: str,
) -> list[dict[str, Any]]:
    checks = []
    for name in sorted(set(depths) | set(errors)):
        label = f"{kind}.{name}"
        if name in errors:
            checks.append(check(label, ERROR, message=errors[name]))
        elif queue_is_empty(depths[name]):
            checks.append(check(label, PASS, "empty", depths[name]))
        else:
            checks.append(check(label, FAIL, "empty", depths[name], f"{kind} {name} is not empty"))
    return checks


def _metric_definitions(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    cluster = dig(snapshot, "resources", "ecs", "cluster_name")
    services = {
        "api": dig(snapshot, "resources", "ecs", "api", "service_name"),
        "worker": dig(snapshot, "resources", "ecs", "worker", "service_name"),
        "demo_ai": dig(snapshot, "resources", "ecs", "demo_ai", "service_name"),
    }
    definitions: list[dict[str, Any]] = []
    for label, service in services.items():
        dimensions = [{"Name": "ClusterName", "Value": cluster}, {"Name": "ServiceName", "Value": service}]
        for metric in ("CPUUtilization", "MemoryUtilization"):
            for stat in ("Average", "Maximum"):
                definitions.append(
                    {
                        "key": f"ecs.{label}.{metric}.{stat}",
                        "namespace": "AWS/ECS",
                        "metric": metric,
                        "stat": stat,
                        "dimensions": dimensions,
                    }
                )
    db_identifier = dig(snapshot, "resources", "rds", "db_instance_identifier")
    definitions.append(
        {
            "key": "rds.CPUUtilization.Maximum",
            "namespace": "AWS/RDS",
            "metric": "CPUUtilization",
            "stat": "Maximum",
            "dimensions": [{"Name": "DBInstanceIdentifier", "Value": db_identifier}],
        }
    )
    endpoint = dig(snapshot, "resources", "sagemaker", "endpoint_name")
    variant = dig(snapshot, "resources", "sagemaker", "production_variant_name")
    sagemaker_dimensions = [{"Name": "EndpointName", "Value": endpoint}, {"Name": "VariantName", "Value": variant}]
    for metric, stat in (
        ("Invocations", "Sum"),
        ("Invocation4XXErrors", "Sum"),
        ("Invocation5XXErrors", "Sum"),
        ("ModelLatency", "Average"),
        ("ModelLatency", "Maximum"),
    ):
        definitions.append(
            {
                "key": f"sagemaker.{metric}.{stat}",
                "namespace": "AWS/SageMaker",
                "metric": metric,
                "stat": stat,
                "dimensions": sagemaker_dimensions,
            }
        )
    return definitions


def collect_metrics(cloudwatch: Any, snapshot: dict[str, Any], start: datetime, end: datetime) -> dict[str, Any]:
    definitions = _metric_definitions(snapshot)
    queries = [
        {
            "Id": f"m{index}",
            "Label": item["key"],
            "MetricStat": {
                "Metric": {
                    "Namespace": item["namespace"],
                    "MetricName": item["metric"],
                    "Dimensions": item["dimensions"],
                },
                "Period": METRIC_PERIOD_SECONDS,
                "Stat": item["stat"],
            },
            "ReturnData": True,
        }
        for index, item in enumerate(definitions)
    ]
    values: dict[str, list[float]] = {item["key"]: [] for item in definitions}
    by_id = {f"m{index}": item["key"] for index, item in enumerate(definitions)}
    paginator = cloudwatch.get_paginator("get_metric_data")
    for page in paginator.paginate(MetricDataQueries=queries, StartTime=start, EndTime=end):
        for result in page.get("MetricDataResults", []):
            key = by_id.get(result.get("Id"))
            if key is not None:
                values[key].extend(float(point) for point in result.get("Values", []))
    summary = {}
    for item in definitions:
        points = values[item["key"]]
        if not points:
            summary[item["key"]] = {"datapoints": 0, "value": None}
        elif item["stat"] == "Maximum":
            summary[item["key"]] = {"datapoints": len(points), "value": max(points)}
        elif item["stat"] == "Sum":
            summary[item["key"]] = {"datapoints": len(points), "value": sum(points)}
        else:
            summary[item["key"]] = {"datapoints": len(points), "value": sum(points) / len(points)}
    return summary


def collect_logs(
    logs_client: Any, groups: list[str], start: datetime, end: datetime
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    """Return per-group counts, a bounded event sample and the checks for the groups."""
    start_ms, end_ms = int(start.timestamp() * 1000), int(end.timestamp() * 1000)
    counts: dict[str, Any] = {}
    sample: list[dict[str, Any]] = []
    checks: list[dict[str, Any]] = []
    for group in groups:
        events = 0
        error_events = 0
        try:
            paginator = logs_client.get_paginator("filter_log_events")
            for page in paginator.paginate(logGroupName=group, startTime=start_ms, endTime=end_ms):
                for event in page.get("events", []):
                    events += 1
                    message = event.get("message", "")
                    if "ERROR" in message:
                        error_events += 1
                    if len(sample) < MAX_LOG_SAMPLE_EVENTS:
                        sample.append(
                            {"log_group": group, "timestamp": event.get("timestamp"), "message": message.rstrip()}
                        )
            counts[group] = {"events": events, "error_events": error_events}
            checks.append(check(f"logs.{group}", PASS, actual=counts[group]))
        except Exception as exc:  # noqa: BLE001
            checks.append(error_check(f"logs.{group}", exc))
    return counts, sample, checks


def collect(
    snapshot: dict[str, Any],
    clients: Clients,
    start: datetime,
    end: datetime,
    drain_timeout_seconds: float,
    drain_poll_seconds: float,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    checks: list[dict[str, Any]] = []
    sqs = clients.sqs
    source_urls = dig(snapshot, "resources", "sqs", "source_queue_urls")
    dead_letter_urls = dig(snapshot, "resources", "sqs", "dlq_urls")

    source_depths, source_errors = wait_for_drain(sqs, source_urls, drain_timeout_seconds, drain_poll_seconds)
    checks += _queue_checks(source_depths, source_errors, "queue_drain")
    dead_letter_depths: dict[str, dict[str, int]] = {}
    dead_letter_errors: dict[str, str] = {}
    for name, url in sorted(dead_letter_urls.items()):
        try:
            dead_letter_depths[name] = queue_depth(sqs, url)
        except Exception as exc:  # noqa: BLE001
            dead_letter_errors[name] = f"{type(exc).__name__}: {exc}"
    checks += _queue_checks(dead_letter_depths, dead_letter_errors, "dlq_empty")

    try:
        metrics = collect_metrics(clients.cloudwatch, snapshot, start, end)
        checks.append(check("metrics.collection", PASS, actual=f"{len(metrics)} series"))
    except Exception as exc:  # noqa: BLE001
        metrics = {}
        checks.append(error_check("metrics.collection", exc))

    groups = sorted(
        {
            dig(snapshot, "resources", "ecs", "api", "log_group_name"),
            dig(snapshot, "resources", "ecs", "worker", "log_group_name"),
            dig(snapshot, "resources", "ecs", "demo_ai", "log_group_name"),
        }
    )
    log_counts, log_sample, log_checks = collect_logs(clients.logs, groups, start, end)
    checks += log_checks

    infrastructure = {
        "status": overall(checks),
        "window": {"start": start.isoformat(), "end": end.isoformat()},
        "queues": {"source": source_depths, "dead_letter": dead_letter_depths},
        "metrics": metrics,
        "logs": log_counts,
        "checks": checks,
    }
    return infrastructure, log_sample


def resolve_window(
    start: str | None,
    end: str | None,
    result_dir: str | None,
    build: dict[str, Any] | None,
) -> tuple[datetime, datetime]:
    """Pick the experiment window: explicit values, else the Runner result, else the build times."""
    candidates: list[tuple[str | None, str | None]] = [(start, end)]
    if result_dir:
        path = Path(result_dir) / "result.json"
        if path.is_file():
            try:
                result = read_json(path)
                candidates.append((result.get("started_at"), result.get("finished_at")))
            except (OSError, ValueError, AttributeError):
                pass
    if build:
        candidates.append((build.get("start_time"), build.get("end_time")))
    for first, last in candidates:
        if first and last:
            return parse_iso(first), parse_iso(last)
    raise ValueError("no experiment window: pass --start/--end or provide a Runner result or build summary")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Collect infrastructure evidence for the experiment window.")
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--start", help="window start, ISO 8601")
    parser.add_argument("--end", help="window end, ISO 8601")
    parser.add_argument("--result-dir", help="Runner results; their started_at/finished_at define the window")
    parser.add_argument("--build", help="build summary JSON; used when the Runner left no result.json")
    parser.add_argument("--output", required=True)
    parser.add_argument("--logs-output", required=True)
    parser.add_argument("--drain-timeout-seconds", type=float, default=300)
    parser.add_argument("--drain-poll-seconds", type=float, default=10)
    args = parser.parse_args(argv)
    try:
        snapshot = read_json(args.snapshot)
        build = read_json(args.build) if args.build and Path(args.build).is_file() else None
        window_start, window_end = resolve_window(args.start, args.end, args.result_dir, build)
        infrastructure, log_sample = collect(
            snapshot,
            Clients(),
            window_start,
            window_end,
            args.drain_timeout_seconds,
            args.drain_poll_seconds,
        )
    except Exception as exc:  # noqa: BLE001
        write_json(args.output, {"status": ERROR, "checks": [error_check("collect", exc)]})
        write_json(args.logs_output, [])
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    write_json(args.output, infrastructure)
    write_json(args.logs_output, log_sample)
    for item in infrastructure["checks"]:
        if item["status"] != PASS:
            print(f"{item['status']}: {item['name']}: {item['message']}", file=sys.stderr)
    print(f"infrastructure: {infrastructure['status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
