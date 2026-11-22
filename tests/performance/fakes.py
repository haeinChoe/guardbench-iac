"""AWS client doubles and a snapshot builder shared by the script unit tests."""

from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Any

from botocore.exceptions import ClientError

from scripts.performance.common import Clients

CLUSTER = "guardbench-dev-cluster"
ACCOUNT = "000000000000"
REGION = "ap-northeast-2"


def client_error(code: str, message: str, operation: str = "Operation") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": message}}, operation)


def make_snapshot() -> dict[str, Any]:
    def task_definition(name: str) -> str:
        return f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/{name}:1"

    queues = {name: f"http://sqs.local/{ACCOUNT}/perf-{name}" for name in ("resolve", "workitems", "finalize")}
    dead_letters = {name: f"{url}-dlq" for name, url in queues.items()}
    return {
        "schema_version": 1,
        "id": "validation",
        "revision": "0123456789abcdef0123456789abcdef01234567",
        "app_image_tag": "abcdef0",
        "expected": {
            "ecs": {
                "api": {
                    "cluster_identifier": CLUSTER,
                    "service_identifier": "perf-app",
                    "task_cpu": "512",
                    "task_memory": "1024",
                    "desired_count": 2,
                },
                "worker": {
                    "cluster_identifier": CLUSTER,
                    "service_identifier": "perf-worker",
                    "task_cpu": "512",
                    "task_memory": "1024",
                    "desired_count": 3,
                    "work_items_concurrency": 4,
                },
            },
            "rds": {"db_instance_identifier": "perf-db", "db_instance_class": "db.t4g.micro"},
            "sagemaker": {
                "endpoint_name": "perf-endpoint",
                "production_variant_name": "AllTraffic",
                "instance_type": "ml.g5.xlarge",
                "desired_instance_count": 1,
            },
        },
        "resources": {
            "ecs": {
                "cluster_name": CLUSTER,
                "cluster_arn": f"arn:aws:ecs:{REGION}:{ACCOUNT}:cluster/{CLUSTER}",
                "api": {
                    "service_name": "perf-app",
                    "task_definition_arn": task_definition("perf-app"),
                    "log_group_name": "/ecs/perf/app",
                },
                "worker": {
                    "service_name": "perf-worker",
                    "task_definition_arn": task_definition("perf-worker"),
                    "log_group_name": "/ecs/perf/app",
                },
                "demo_ai": {
                    "service_name": "perf-demo",
                    "task_definition_arn": task_definition("perf-demo"),
                    "log_group_name": "/ecs/perf/demo",
                },
            },
            "rds": {"db_instance_identifier": "perf-db"},
            "sagemaker": {
                "model_name": "perf-model",
                "endpoint_config_name": "perf-config",
                "endpoint_name": "perf-endpoint",
                "endpoint_arn": f"arn:aws:sagemaker:{REGION}:{ACCOUNT}:endpoint/perf-endpoint",
                "production_variant_name": "AllTraffic",
            },
            "sqs": {"source_queue_urls": queues, "dlq_urls": dead_letters},
            "runner": {"codebuild_project_name": "perf-runner", "results_bucket_name": "perf-results"},
        },
        "api_url": "http://perf-alb.local",
        "target": {"type": "HTTP_ENDPOINT", "url": "http://perf-alb.local/v1/chat/completions", "model": "demo-model", "revision": "d9d9b4a"},
    }


class FakeEcs:
    def __init__(self, snapshot: dict[str, Any]) -> None:
        self.services: dict[str, dict[str, Any]] = {}
        self.definitions: dict[str, dict[str, Any]] = {}
        expected = snapshot["expected"]["ecs"]
        resources = snapshot["resources"]["ecs"]
        for name, desired in (("api", 2), ("worker", 3), ("demo_ai", 1)):
            arn = resources[name]["task_definition_arn"]
            self.services[resources[name]["service_name"]] = {
                "serviceName": resources[name]["service_name"],
                "status": "ACTIVE",
                "desiredCount": desired,
                "runningCount": desired,
                "pendingCount": 0,
                "taskDefinition": arn,
                "deployments": [{"status": "PRIMARY", "rolloutState": "COMPLETED"}],
            }
            self.definitions[arn] = {
                "taskDefinitionArn": arn,
                "status": "ACTIVE",
                "cpu": expected.get(name, {}).get("task_cpu", "512"),
                "memory": expected.get(name, {}).get("task_memory", "1024"),
                "containerDefinitions": [{"environment": []}],
            }
        worker_arn = resources["worker"]["task_definition_arn"]
        self.definitions[worker_arn]["containerDefinitions"][0]["environment"] = [
            {"name": "GUARDBENCH_WORKER_WORK_ITEMS_CONCURRENCY", "value": "4"}
        ]
        self.fail_describe_services: Exception | None = None

    def describe_services(self, cluster: str, services: list[str]) -> dict[str, Any]:
        if self.fail_describe_services:
            raise self.fail_describe_services
        found = [copy.deepcopy(self.services[name]) for name in services if name in self.services]
        return {"services": found, "failures": []}

    def describe_task_definition(self, taskDefinition: str) -> dict[str, Any]:  # noqa: N803 - boto3 casing
        if taskDefinition not in self.definitions:
            raise client_error("ClientException", "Unable to describe task definition.", "DescribeTaskDefinition")
        return {"taskDefinition": copy.deepcopy(self.definitions[taskDefinition])}


class FakeRds:
    def __init__(self, instance_class: str = "db.t4g.micro", status: str = "available") -> None:
        self.instance_class = instance_class
        self.status = status
        self.error: Exception | None = None

    def describe_db_instances(self, DBInstanceIdentifier: str) -> dict[str, Any]:  # noqa: N803
        if self.error:
            raise self.error
        return {"DBInstances": [{"DBInstanceClass": self.instance_class, "DBInstanceStatus": self.status}]}


class FakeSageMaker:
    def __init__(self) -> None:
        self.status = "InService"
        self.instance_type = "ml.g5.xlarge"
        self.instance_count = 1
        self.exists = True

    def describe_endpoint(self, EndpointName: str) -> dict[str, Any]:  # noqa: N803
        if not self.exists:
            raise client_error("ValidationException", f'Could not find endpoint "{EndpointName}".', "DescribeEndpoint")
        return {
            "EndpointStatus": self.status,
            "EndpointConfigName": "perf-config",
            "ProductionVariants": [
                {
                    "VariantName": "AllTraffic",
                    "CurrentInstanceCount": self.instance_count,
                    "DesiredInstanceCount": self.instance_count,
                }
            ],
        }

    def describe_endpoint_config(self, EndpointConfigName: str) -> dict[str, Any]:  # noqa: N803
        if not self.exists:
            raise client_error("ValidationException", "Could not find endpoint configuration.", "DescribeEndpointConfig")
        return {"ProductionVariants": [{"VariantName": "AllTraffic", "InstanceType": self.instance_type}]}

    def describe_model(self, ModelName: str) -> dict[str, Any]:  # noqa: N803
        if not self.exists:
            raise client_error("ValidationException", "Could not find model.", "DescribeModel")
        return {"ModelName": ModelName}


class FakeSqs:
    def __init__(self) -> None:
        self.depths: dict[str, tuple[int, int, int]] = {}
        self.errors: dict[str, Exception] = {}
        self.calls = 0
        self.drain_after_calls: int | None = None

    def get_queue_attributes(self, QueueUrl: str, AttributeNames: list[str]) -> dict[str, Any]:  # noqa: N803
        self.calls += 1
        if QueueUrl in self.errors:
            raise self.errors[QueueUrl]
        visible, in_flight, delayed = self.depths.get(QueueUrl, (0, 0, 0))
        if self.drain_after_calls is not None and self.calls > self.drain_after_calls:
            visible = in_flight = delayed = 0
        return {
            "Attributes": {
                "ApproximateNumberOfMessages": str(visible),
                "ApproximateNumberOfMessagesNotVisible": str(in_flight),
                "ApproximateNumberOfMessagesDelayed": str(delayed),
            }
        }


class FakePaginator:
    def __init__(self, pages_for: Any) -> None:
        self._pages_for = pages_for

    def paginate(self, **kwargs: Any):
        return iter(self._pages_for(**kwargs))


class FakeCloudWatch:
    def __init__(self) -> None:
        self.values: dict[str, list[float]] = {}
        self.error: Exception | None = None

    def get_paginator(self, name: str) -> FakePaginator:
        assert name == "get_metric_data"

        def pages(MetricDataQueries: list[dict[str, Any]], **_: Any):  # noqa: N803
            if self.error:
                raise self.error
            results = [
                {"Id": query["Id"], "Label": query["Label"], "Values": self.values.get(query["Label"], [])}
                for query in MetricDataQueries
            ]
            return [{"MetricDataResults": results}]

        return FakePaginator(pages)


class FakeLogs:
    def __init__(self) -> None:
        self.events: dict[str, list[dict[str, Any]]] = {}
        self.error_groups: dict[str, Exception] = {}
        self.existing_groups: set[str] = set()

    def get_paginator(self, name: str) -> FakePaginator:
        if name == "filter_log_events":

            def pages(logGroupName: str, startTime: int, endTime: int):  # noqa: N803
                if logGroupName in self.error_groups:
                    raise self.error_groups[logGroupName]
                selected = [e for e in self.events.get(logGroupName, []) if startTime <= e["timestamp"] <= endTime]
                return [{"events": selected}]

            return FakePaginator(pages)
        if name == "describe_log_groups":

            def group_pages(logGroupNamePrefix: str):  # noqa: N803
                return [{"logGroups": [{"logGroupName": g} for g in self.existing_groups if g.startswith(logGroupNamePrefix)]}]

            return FakePaginator(group_pages)
        raise AssertionError(name)


class FakeCodeBuild:
    def __init__(self, statuses: list[str]) -> None:
        self.statuses = list(statuses)
        self.polls = 0
        self.started: list[dict[str, Any]] = []
        self.stopped: list[str] = []

    def start_build(self, projectName: str, environmentVariablesOverride: list[dict[str, str]]) -> dict[str, Any]:  # noqa: N803
        self.started.append({"project": projectName, "env": environmentVariablesOverride})
        return {"build": {"id": f"{projectName}:1", "buildStatus": "IN_PROGRESS"}}

    def batch_get_builds(self, ids: list[str]) -> dict[str, Any]:
        index = min(self.polls, len(self.statuses) - 1)
        self.polls += 1
        status = self.statuses[index]
        build = {
            "id": ids[0],
            "buildStatus": status,
            "currentPhase": "COMPLETED" if status != "IN_PROGRESS" else "BUILD",
            "startTime": datetime(2026, 11, 22, 1, 0, tzinfo=timezone.utc),
            "phases": [{"phaseType": "BUILD", "phaseStatus": "SUCCEEDED"}],
            "logs": {"groupName": "/codebuild/perf", "streamName": "stream"},
        }
        if status != "IN_PROGRESS":
            build["endTime"] = datetime(2026, 11, 22, 1, 5, tzinfo=timezone.utc)
        return {"builds": [build]}

    def stop_build(self, id: str) -> dict[str, Any]:  # noqa: A002
        self.stopped.append(id)
        return {}


class FakeBuildLogs:
    def __init__(self, messages: list[str] | None = None, error: Exception | None = None) -> None:
        self.messages = messages or []
        self.error = error
        self.served = False

    def get_log_events(self, **kwargs: Any) -> dict[str, Any]:
        if self.error:
            raise self.error
        if self.served:
            return {"events": [], "nextForwardToken": "end"}
        self.served = True
        return {"events": [{"message": m} for m in self.messages], "nextForwardToken": "t1"}


def make_clients(**fakes: Any) -> Clients:
    return Clients(factory=lambda service: fakes[service])


def healthy_clients(snapshot: dict[str, Any]) -> tuple[Clients, dict[str, Any]]:
    fakes = {
        "ecs": FakeEcs(snapshot),
        "rds": FakeRds(),
        "sagemaker": FakeSageMaker(),
        "sqs": FakeSqs(),
        "cloudwatch": FakeCloudWatch(),
        "logs": FakeLogs(),
    }
    return make_clients(**fakes), fakes
