"""Shared helpers for the performance experiment entrypoint scripts.

AWS access goes through boto3's default behavior only. Credentials, region and
endpoint selection come from the environment (AWS_ACCESS_KEY_ID, AWS_REGION,
AWS_ENDPOINT_URL, ...), so the same code runs against AWS and against any
AWS-compatible endpoint without a code path of its own.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

PASS = "PASS"
FAIL = "FAIL"
ERROR = "ERROR"

QUEUE_DEPTH_ATTRIBUTES = (
    "ApproximateNumberOfMessages",
    "ApproximateNumberOfMessagesNotVisible",
    "ApproximateNumberOfMessagesDelayed",
)


class SnapshotError(ValueError):
    """The infrastructure snapshot does not have the expected shape."""


def client(service: str) -> Any:
    """Create a boto3 client using only the ambient configuration."""
    import boto3

    return boto3.client(service)


class Clients:
    """Lazily created boto3 clients, replaceable as a whole in tests."""

    def __init__(self, factory=client) -> None:
        self._factory = factory
        self._cache: dict[str, Any] = {}

    def __getattr__(self, service: str) -> Any:
        if service.startswith("_"):
            raise AttributeError(service)
        if service not in self._cache:
            self._cache[service] = self._factory(service)
        return self._cache[service]


def read_json(path: str | Path) -> Any:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: str | Path, value: Any) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True, default=str)
        handle.write("\n")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def dig(value: Any, *path: str) -> Any:
    """Return a nested mapping value or raise SnapshotError naming the path."""
    current = value
    for key in path:
        if not isinstance(current, dict) or key not in current:
            raise SnapshotError(f"snapshot is missing {'.'.join(path)}")
        current = current[key]
    return current


def check(name: str, status: str, expected: Any = None, actual: Any = None, message: str = "") -> dict[str, Any]:
    return {"name": name, "status": status, "expected": expected, "actual": actual, "message": message}


def compare(name: str, expected: Any, actual: Any) -> dict[str, Any]:
    if expected == actual:
        return check(name, PASS, expected, actual)
    return check(name, FAIL, expected, actual, f"expected {expected!r}, found {actual!r}")


def error_check(name: str, exc: BaseException) -> dict[str, Any]:
    return check(name, ERROR, message=f"{type(exc).__name__}: {exc}")


def overall(checks: Iterable[dict[str, Any]]) -> str:
    statuses = [item["status"] for item in checks]
    if any(status == ERROR for status in statuses):
        return ERROR
    if any(status == FAIL for status in statuses):
        return FAIL
    return PASS


def queue_depth(sqs: Any, queue_url: str) -> dict[str, int]:
    response = sqs.get_queue_attributes(QueueUrl=queue_url, AttributeNames=list(QUEUE_DEPTH_ATTRIBUTES))
    attributes = response.get("Attributes", {})
    return {
        "visible": int(attributes.get("ApproximateNumberOfMessages", 0)),
        "in_flight": int(attributes.get("ApproximateNumberOfMessagesNotVisible", 0)),
        "delayed": int(attributes.get("ApproximateNumberOfMessagesDelayed", 0)),
    }


def queue_is_empty(depth: dict[str, int]) -> bool:
    return depth["visible"] == 0 and depth["in_flight"] == 0 and depth["delayed"] == 0


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)
