"""Confirm that destroy left no experiment-layer resources behind.

Checks the Terraform state list (must be empty) and, when a snapshot exists, asks AWS
whether the experiment's ECS services, task definitions, SageMaker endpoint and log groups
are gone. Exit code: 0 nothing left, 1 something is left or could not be confirmed.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

from botocore.exceptions import ClientError

from .common import FAIL, PASS, Clients, check, dig, error_check, overall, read_json, write_json

_ABSENT = re.compile(r"could not find|not found|does not exist|unable to describe|no such", re.IGNORECASE)


def _is_absent_error(exc: BaseException) -> bool:
    return isinstance(exc, ClientError) and bool(_ABSENT.search(str(exc)))


def _service_gone(ecs: Any, cluster: str, service: str, label: str) -> dict[str, Any]:
    try:
        response = ecs.describe_services(cluster=cluster, services=[service])
        live = [item for item in response.get("services", []) if item.get("status") not in (None, "INACTIVE")]
        if live:
            return check(label, FAIL, "absent", live[0].get("status"), f"service {service} still {live[0].get('status')}")
        return check(label, PASS, "absent", "absent")
    except Exception as exc:  # noqa: BLE001
        if _is_absent_error(exc):
            return check(label, PASS, "absent", "absent")
        return error_check(label, exc)


def _task_definition_gone(ecs: Any, arn: str, label: str) -> dict[str, Any]:
    try:
        definition = ecs.describe_task_definition(taskDefinition=arn)["taskDefinition"]
        if definition.get("status") == "INACTIVE":
            return check(label, PASS, "inactive or absent", "INACTIVE")
        return check(label, FAIL, "inactive or absent", definition.get("status"), f"{arn} still {definition.get('status')}")
    except Exception as exc:  # noqa: BLE001
        if _is_absent_error(exc):
            return check(label, PASS, "inactive or absent", "absent")
        return error_check(label, exc)


def _sagemaker_gone(sagemaker: Any, kind: str, describe: str, argument: str, name: str) -> dict[str, Any]:
    label = f"sagemaker.{kind}"
    try:
        getattr(sagemaker, describe)(**{argument: name})
        return check(label, FAIL, "absent", "present", f"{kind} {name} still exists")
    except Exception as exc:  # noqa: BLE001
        if _is_absent_error(exc):
            return check(label, PASS, "absent", "absent")
        return error_check(label, exc)


def _log_group_gone(logs: Any, group: str) -> dict[str, Any]:
    label = f"logs.{group}"
    try:
        found = [
            item
            for page in logs.get_paginator("describe_log_groups").paginate(logGroupNamePrefix=group)
            for item in page.get("logGroups", [])
            if item.get("logGroupName") == group
        ]
        if found:
            return check(label, FAIL, "absent", "present", f"log group {group} still exists")
        return check(label, PASS, "absent", "absent")
    except Exception as exc:  # noqa: BLE001
        return error_check(label, exc)


def verify(state_resources: list[str], snapshot: dict[str, Any] | None, clients: Clients) -> dict[str, Any]:
    checks = []
    if state_resources:
        checks.append(
            check("terraform.state", FAIL, "empty", state_resources, f"{len(state_resources)} resource(s) remain in state")
        )
    else:
        checks.append(check("terraform.state", PASS, "empty", []))
    if snapshot is not None:
        resources = dig(snapshot, "resources")
        cluster = dig(resources, "ecs", "cluster_name")
        for name in ("api", "worker", "demo_ai"):
            entry = dig(resources, "ecs", name)
            checks.append(_service_gone(clients.ecs, cluster, entry["service_name"], f"ecs.service.{name}"))
            checks.append(_task_definition_gone(clients.ecs, entry["task_definition_arn"], f"ecs.task_definition.{name}"))
        sagemaker = dig(resources, "sagemaker")
        checks.append(_sagemaker_gone(clients.sagemaker, "endpoint", "describe_endpoint", "EndpointName", sagemaker["endpoint_name"]))
        checks.append(
            _sagemaker_gone(
                clients.sagemaker, "endpoint_config", "describe_endpoint_config", "EndpointConfigName", sagemaker["endpoint_config_name"]
            )
        )
        checks.append(_sagemaker_gone(clients.sagemaker, "model", "describe_model", "ModelName", sagemaker["model_name"]))
        groups = sorted({dig(resources, "ecs", name, "log_group_name") for name in ("api", "worker", "demo_ai")})
        checks += [_log_group_gone(clients.logs, group) for group in groups]
    return {"status": overall(checks), "checks": checks}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify the experiment layer was destroyed.")
    parser.add_argument("--state-list", required=True, help="file with the output of `terraform state list`")
    parser.add_argument("--snapshot", help="snapshot JSON; omitted when apply never produced one")
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    state = [line.strip() for line in Path(args.state_list).read_text(encoding="utf-8").splitlines() if line.strip()]
    snapshot = read_json(args.snapshot) if args.snapshot and Path(args.snapshot).is_file() else None
    result = verify(state, snapshot, Clients())
    write_json(args.output, result)
    for item in result["checks"]:
        if item["status"] != PASS:
            print(f"{item['status']}: {item['name']}: {item['message']}", file=sys.stderr)
    print(f"destroy verification: {result['status']}")
    return 0 if result["status"] == PASS else 1


if __name__ == "__main__":
    raise SystemExit(main())
