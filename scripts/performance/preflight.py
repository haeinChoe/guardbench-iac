"""Pre-run check: compare the snapshot's expected values with the real AWS state.

Any mismatch, failed lookup or unfinished rollout means the load must not start.
SageMaker: status and endpoint config name come from DescribeEndpoint; variant, instance type
and instance count come from DescribeEndpointConfig (see _sagemaker_checks).
Exit code: 0 all checks passed, 1 at least one check failed or could not be made.
"""

from __future__ import annotations

import argparse
import sys
from typing import Any

from .common import (
    ERROR,
    FAIL,
    PASS,
    Clients,
    SnapshotError,
    check,
    compare,
    dig,
    error_check,
    overall,
    queue_depth,
    queue_is_empty,
    read_json,
    write_json,
)

WORKER_CONCURRENCY_ENV = "GUARDBENCH_WORKER_WORK_ITEMS_CONCURRENCY"
SUPPORTED_SCHEMA_VERSION = 1


def _service_checks(
    ecs: Any,
    label: str,
    cluster: str,
    service_name: str,
    task_definition_arn: str,
    expected_desired: int | None = None,
    expected_cpu: str | None = None,
    expected_memory: str | None = None,
    expected_concurrency: int | None = None,
) -> list[dict[str, Any]]:
    prefix = f"ecs.{label}"
    try:
        response = ecs.describe_services(cluster=cluster, services=[service_name])
        services = response.get("services", [])
        if not services:
            return [check(f"{prefix}.exists", FAIL, service_name, None, f"service {service_name} not found")]
        service = services[0]
        checks = [compare(f"{prefix}.status", "ACTIVE", service.get("status"))]
        desired = service.get("desiredCount")
        if expected_desired is not None:
            checks.append(compare(f"{prefix}.desired_count", expected_desired, desired))
        checks.append(compare(f"{prefix}.running_count", desired, service.get("runningCount")))
        checks.append(compare(f"{prefix}.pending_count", 0, service.get("pendingCount")))
        checks.append(compare(f"{prefix}.task_definition", task_definition_arn, service.get("taskDefinition")))
        deployments = service.get("deployments", [])
        rollout = [(item.get("status"), item.get("rolloutState")) for item in deployments]
        checks.append(compare(f"{prefix}.rollout", [("PRIMARY", "COMPLETED")], rollout))
    except Exception as exc:  # noqa: BLE001 - a failed lookup must block the run, whatever its cause
        return [error_check(f"{prefix}.service", exc)]

    if expected_cpu is None and expected_memory is None and expected_concurrency is None:
        return checks
    try:
        definition = ecs.describe_task_definition(taskDefinition=task_definition_arn)["taskDefinition"]
        if expected_cpu is not None:
            checks.append(compare(f"{prefix}.task_cpu", expected_cpu, definition.get("cpu")))
        if expected_memory is not None:
            checks.append(compare(f"{prefix}.task_memory", expected_memory, definition.get("memory")))
        if expected_concurrency is not None:
            environment = {
                item["name"]: item.get("value")
                for container in definition.get("containerDefinitions", [])
                for item in container.get("environment", [])
            }
            checks.append(
                compare(
                    f"{prefix}.work_items_concurrency",
                    str(expected_concurrency),
                    environment.get(WORKER_CONCURRENCY_ENV),
                )
            )
    except Exception as exc:  # noqa: BLE001
        checks.append(error_check(f"{prefix}.task_definition_lookup", exc))
    return checks


def _rds_checks(rds: Any, identifier: str, expected_class: str) -> list[dict[str, Any]]:
    try:
        instances = rds.describe_db_instances(DBInstanceIdentifier=identifier).get("DBInstances", [])
        if not instances:
            return [check("rds.exists", FAIL, identifier, None, f"DB instance {identifier} not found")]
        instance = instances[0]
        return [
            compare("rds.instance_class", expected_class, instance.get("DBInstanceClass")),
            compare("rds.status", "available", instance.get("DBInstanceStatus")),
        ]
    except Exception as exc:  # noqa: BLE001
        return [error_check("rds.instance", exc)]


def _sagemaker_checks(
    sagemaker: Any,
    endpoint_name: str,
    endpoint_config_name: str,
    variant_name: str,
    instance_type: str,
    instance_count: int,
) -> list[dict[str, Any]]:
    """Check the endpoint is InService and was built from the expected endpoint config.

    Variant name, instance type and instance count are read from the endpoint config
    (InitialInstanceCount). That equals the live instance count only because this IaC has no
    SageMaker autoscaling: an InService endpoint then runs exactly the configured count.
    If autoscaling is added, replace the count check with the endpoint's current instance
    count (DescribeEndpoint ProductionVariants[].CurrentInstanceCount).
    """
    try:
        endpoint = sagemaker.describe_endpoint(EndpointName=endpoint_name)
        checks = [
            compare("sagemaker.status", "InService", endpoint.get("EndpointStatus")),
            compare("sagemaker.endpoint_config", endpoint_config_name, endpoint.get("EndpointConfigName")),
        ]
        config = sagemaker.describe_endpoint_config(EndpointConfigName=endpoint.get("EndpointConfigName") or endpoint_config_name)
        variants = {item.get("VariantName"): item for item in config.get("ProductionVariants", [])}
        variant = variants.get(variant_name)
        if variant is None:
            checks.append(check("sagemaker.variant", FAIL, variant_name, sorted(variants), "variant not found"))
            return checks
        checks.append(compare("sagemaker.instance_type", instance_type, variant.get("InstanceType")))
        checks.append(compare("sagemaker.instance_count", instance_count, variant.get("InitialInstanceCount")))
        return checks
    except Exception as exc:  # noqa: BLE001
        return [error_check("sagemaker.endpoint", exc)]


def _queue_checks(sqs: Any, kind: str, urls: dict[str, str]) -> list[dict[str, Any]]:
    checks = []
    for name in sorted(urls):
        label = f"sqs.{kind}.{name}"
        try:
            depth = queue_depth(sqs, urls[name])
        except Exception as exc:  # noqa: BLE001
            checks.append(error_check(label, exc))
            continue
        if queue_is_empty(depth):
            checks.append(check(label, PASS, "empty", depth))
        else:
            checks.append(check(label, FAIL, "empty", depth, f"{kind} queue {name} still holds messages"))
    return checks


def evaluate(snapshot: dict[str, Any], clients: Clients) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    try:
        version = dig(snapshot, "schema_version")
        if version != SUPPORTED_SCHEMA_VERSION:
            raise SnapshotError(f"unsupported snapshot schema_version {version!r}")
        expected = dig(snapshot, "expected")
        resources = dig(snapshot, "resources")
        cluster = dig(resources, "ecs", "cluster_name")
        api_expected = dig(expected, "ecs", "api")
        worker_expected = dig(expected, "ecs", "worker")
        api_resources = dig(resources, "ecs", "api")
        worker_resources = dig(resources, "ecs", "worker")
        demo_resources = dig(resources, "ecs", "demo_ai")
        rds_expected = dig(expected, "rds")
        sagemaker_expected = dig(expected, "sagemaker")
        source_queues = dig(resources, "sqs", "source_queue_urls")
        dead_letter_queues = dig(resources, "sqs", "dlq_urls")
    except SnapshotError as exc:
        return {"status": ERROR, "checks": [error_check("snapshot", exc)]}

    checks += _service_checks(
        clients.ecs,
        "api",
        cluster,
        api_expected["service_identifier"],
        api_resources["task_definition_arn"],
        expected_desired=api_expected["desired_count"],
        expected_cpu=api_expected["task_cpu"],
        expected_memory=api_expected["task_memory"],
    )
    checks += _service_checks(
        clients.ecs,
        "worker",
        cluster,
        worker_expected["service_identifier"],
        worker_resources["task_definition_arn"],
        expected_desired=worker_expected["desired_count"],
        expected_cpu=worker_expected["task_cpu"],
        expected_memory=worker_expected["task_memory"],
        expected_concurrency=worker_expected["work_items_concurrency"],
    )
    checks += _service_checks(
        clients.ecs,
        "demo_ai",
        cluster,
        demo_resources["service_name"],
        demo_resources["task_definition_arn"],
    )
    checks += _rds_checks(clients.rds, rds_expected["db_instance_identifier"], rds_expected["db_instance_class"])
    checks += _sagemaker_checks(
        clients.sagemaker,
        sagemaker_expected["endpoint_name"],
        dig(resources, "sagemaker", "endpoint_config_name"),
        sagemaker_expected["production_variant_name"],
        sagemaker_expected["instance_type"],
        sagemaker_expected["desired_instance_count"],
    )
    checks += _queue_checks(clients.sqs, "source", source_queues)
    checks += _queue_checks(clients.sqs, "dlq", dead_letter_queues)
    return {"status": overall(checks), "checks": checks}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compare the experiment snapshot with the real AWS state.")
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        snapshot = read_json(args.snapshot)
    except (OSError, ValueError) as exc:
        write_json(args.output, {"status": ERROR, "checks": [error_check("snapshot", exc)]})
        return 1
    result = evaluate(snapshot, Clients())
    write_json(args.output, result)
    for item in result["checks"]:
        if item["status"] != PASS:
            print(f"{item['status']}: {item['name']}: {item['message']}", file=sys.stderr)
    print(f"preflight: {result['status']}")
    return 0 if result["status"] == PASS else 1


if __name__ == "__main__":
    raise SystemExit(main())
