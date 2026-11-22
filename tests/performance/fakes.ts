// AWS client doubles and a snapshot builder shared by the script unit tests.
//
// A fake is an object with the SDK client's `send` method. It answers by the command class
// name and reads the command's `input`, so the scripts run against it unchanged.

import type { Clients, Dict } from "../../scripts/performance/common.ts";

export const CLUSTER = "guardbench-dev-cluster";
export const ACCOUNT = "000000000000";
export const REGION = "ap-northeast-2";

/** Shaped like an SDK service exception (it carries `$metadata`). */
export class FakeServiceError extends Error {
  readonly $fault = "client";
  readonly $metadata = {};

  constructor(code: string, message: string) {
    super(message);
    this.name = code;
  }
}

export function clientError(code: string, message: string): FakeServiceError {
  return new FakeServiceError(code, message);
}

interface SdkCommand {
  constructor: { name: string };
  input: Dict;
}

function asCommand(command: unknown): SdkCommand {
  return command as SdkCommand;
}

function commandName(command: unknown): string {
  return asCommand(command).constructor.name;
}

function inputOf(command: unknown): Dict {
  return asCommand(command).input;
}

function unsupported(command: unknown): never {
  throw new Error(`fake does not support ${commandName(command)}`);
}

export function makeSnapshot(): Dict {
  const taskDefinition = (name: string): string => `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/${name}:1`;
  const queues: Record<string, string> = {};
  const deadLetters: Record<string, string> = {};
  for (const name of ["resolve", "workitems", "finalize"]) {
    queues[name] = `http://sqs.local/${ACCOUNT}/perf-${name}`;
    deadLetters[name] = `${queues[name]}-dlq`;
  }
  return {
    schema_version: 1,
    id: "validation",
    revision: "0123456789abcdef0123456789abcdef01234567",
    app_image_tag: "abcdef0",
    expected: {
      ecs: {
        api: {
          cluster_identifier: CLUSTER,
          service_identifier: "perf-app",
          task_cpu: "512",
          task_memory: "1024",
          desired_count: 2,
        },
        worker: {
          cluster_identifier: CLUSTER,
          service_identifier: "perf-worker",
          task_cpu: "512",
          task_memory: "1024",
          desired_count: 3,
          work_items_concurrency: 4,
        },
      },
      rds: { db_instance_identifier: "perf-db", db_instance_class: "db.t4g.micro" },
      sagemaker: {
        endpoint_name: "perf-endpoint",
        production_variant_name: "AllTraffic",
        instance_type: "ml.g5.xlarge",
        desired_instance_count: 1,
      },
    },
    resources: {
      ecs: {
        cluster_name: CLUSTER,
        cluster_arn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/${CLUSTER}`,
        api: {
          service_name: "perf-app",
          task_definition_arn: taskDefinition("perf-app"),
          log_group_name: "/ecs/perf/app",
        },
        worker: {
          service_name: "perf-worker",
          task_definition_arn: taskDefinition("perf-worker"),
          log_group_name: "/ecs/perf/app",
        },
        demo_ai: {
          service_name: "perf-demo",
          task_definition_arn: taskDefinition("perf-demo"),
          log_group_name: "/ecs/perf/demo",
        },
      },
      rds: { db_instance_identifier: "perf-db" },
      sagemaker: {
        model_name: "perf-model",
        endpoint_config_name: "perf-config",
        endpoint_name: "perf-endpoint",
        endpoint_arn: `arn:aws:sagemaker:${REGION}:${ACCOUNT}:endpoint/perf-endpoint`,
        production_variant_name: "AllTraffic",
      },
      sqs: { source_queue_urls: queues, dlq_urls: deadLetters },
      runner: { codebuild_project_name: "perf-runner", results_bucket_name: "perf-results" },
    },
    api_url: "http://perf-alb.local",
    target: {
      type: "HTTP_ENDPOINT",
      url: "http://perf-alb.local/v1/chat/completions",
      model: "demo-model",
      revision: "d9d9b4a",
    },
  };
}

export class FakeEcs {
  services: Record<string, Dict> = {};
  definitions: Record<string, Dict> = {};
  failDescribeServices: Error | null = null;

  constructor(snapshot: Dict) {
    const expected = snapshot.expected.ecs;
    const resources = snapshot.resources.ecs;
    const desiredCounts: [string, number][] = [
      ["api", 2],
      ["worker", 3],
      ["demo_ai", 1],
    ];
    for (const [name, desired] of desiredCounts) {
      const arn = resources[name].task_definition_arn;
      this.services[resources[name].service_name] = {
        serviceName: resources[name].service_name,
        status: "ACTIVE",
        desiredCount: desired,
        runningCount: desired,
        pendingCount: 0,
        taskDefinition: arn,
        deployments: [{ status: "PRIMARY", rolloutState: "COMPLETED" }],
      };
      this.definitions[arn] = {
        taskDefinitionArn: arn,
        status: "ACTIVE",
        cpu: expected[name]?.task_cpu ?? "512",
        memory: expected[name]?.task_memory ?? "1024",
        containerDefinitions: [{ environment: [] }],
      };
    }
    this.definitions[resources.worker.task_definition_arn].containerDefinitions[0].environment = [
      { name: "GUARDBENCH_WORKER_WORK_ITEMS_CONCURRENCY", value: "4" },
    ];
  }

  async send(command: unknown): Promise<Dict> {
    const input = inputOf(command);
    switch (commandName(command)) {
      case "DescribeServicesCommand": {
        if (this.failDescribeServices) {
          throw this.failDescribeServices;
        }
        const found = (input.services as string[])
          .filter((name) => name in this.services)
          .map((name) => structuredClone(this.services[name]));
        return { services: found, failures: [] };
      }
      case "DescribeTaskDefinitionCommand": {
        if (!(input.taskDefinition in this.definitions)) {
          throw clientError("ClientException", "Unable to describe task definition.");
        }
        return { taskDefinition: structuredClone(this.definitions[input.taskDefinition]) };
      }
      default:
        return unsupported(command);
    }
  }
}

export class FakeRds {
  instanceClass = "db.t4g.micro";
  status = "available";
  error: Error | null = null;

  async send(command: unknown): Promise<Dict> {
    if (commandName(command) !== "DescribeDBInstancesCommand") {
      return unsupported(command);
    }
    if (this.error) {
      throw this.error;
    }
    return { DBInstances: [{ DBInstanceClass: this.instanceClass, DBInstanceStatus: this.status }] };
  }
}

/** Shaped like Floci's responses: DescribeEndpoint carries no ProductionVariants. */
export class FakeSageMaker {
  status = "InService";
  endpointConfig = "perf-config";
  instanceType = "ml.g5.xlarge";
  instanceCount = 1;
  variantName = "AllTraffic";
  exists = true;

  async send(command: unknown): Promise<Dict> {
    const input = inputOf(command);
    switch (commandName(command)) {
      case "DescribeEndpointCommand":
        if (!this.exists) {
          throw clientError("ValidationException", `Could not find endpoint "${input.EndpointName}".`);
        }
        return { EndpointStatus: this.status, EndpointConfigName: this.endpointConfig };
      case "DescribeEndpointConfigCommand":
        if (!this.exists) {
          throw clientError("ValidationException", "Could not find endpoint configuration.");
        }
        return {
          ProductionVariants: [
            {
              VariantName: this.variantName,
              InstanceType: this.instanceType,
              InitialInstanceCount: this.instanceCount,
            },
          ],
        };
      case "DescribeModelCommand":
        if (!this.exists) {
          throw clientError("ValidationException", "Could not find model.");
        }
        return { ModelName: input.ModelName };
      default:
        return unsupported(command);
    }
  }
}

export class FakeSqs {
  depths: Record<string, [number, number, number]> = {};
  errors: Record<string, Error> = {};
  calls = 0;
  drainAfterCalls: number | null = null;

  async send(command: unknown): Promise<Dict> {
    if (commandName(command) !== "GetQueueAttributesCommand") {
      return unsupported(command);
    }
    this.calls += 1;
    const url = inputOf(command).QueueUrl as string;
    if (url in this.errors) {
      throw this.errors[url];
    }
    let [visible, inFlight, delayed] = this.depths[url] ?? [0, 0, 0];
    if (this.drainAfterCalls !== null && this.calls > this.drainAfterCalls) {
      visible = inFlight = delayed = 0;
    }
    return {
      Attributes: {
        ApproximateNumberOfMessages: String(visible),
        ApproximateNumberOfMessagesNotVisible: String(inFlight),
        ApproximateNumberOfMessagesDelayed: String(delayed),
      },
    };
  }
}

export class FakeCloudWatch {
  values: Record<string, number[]> = {};
  error: Error | null = null;

  async send(command: unknown): Promise<Dict> {
    if (commandName(command) !== "GetMetricDataCommand") {
      return unsupported(command);
    }
    if (this.error) {
      throw this.error;
    }
    const queries = inputOf(command).MetricDataQueries as Dict[];
    return {
      MetricDataResults: queries.map((query) => ({
        Id: query.Id,
        Label: query.Label,
        Values: this.values[query.Label] ?? [],
      })),
    };
  }
}

export class FakeLogs {
  events: Record<string, Dict[]> = {};
  errorGroups: Record<string, Error> = {};
  existingGroups = new Set<string>();

  async send(command: unknown): Promise<Dict> {
    const input = inputOf(command);
    switch (commandName(command)) {
      case "FilterLogEventsCommand": {
        if (input.logGroupName in this.errorGroups) {
          throw this.errorGroups[input.logGroupName];
        }
        const selected = (this.events[input.logGroupName] ?? []).filter(
          (event) => input.startTime <= event.timestamp && event.timestamp <= input.endTime,
        );
        return { events: selected };
      }
      case "DescribeLogGroupsCommand":
        return {
          logGroups: [...this.existingGroups]
            .filter((group) => group.startsWith(input.logGroupNamePrefix))
            .map((group) => ({ logGroupName: group })),
        };
      default:
        return unsupported(command);
    }
  }
}

export class FakeCodeBuild {
  statuses: string[];
  polls = 0;
  started: { project: string; env: Dict[] }[] = [];
  stopped: string[] = [];

  constructor(statuses: string[]) {
    this.statuses = [...statuses];
  }

  async send(command: unknown): Promise<Dict> {
    const input = inputOf(command);
    switch (commandName(command)) {
      case "StartBuildCommand":
        this.started.push({ project: input.projectName, env: input.environmentVariablesOverride });
        return { build: { id: `${input.projectName}:1`, buildStatus: "IN_PROGRESS" } };
      case "BatchGetBuildsCommand": {
        const index = Math.min(this.polls, this.statuses.length - 1);
        this.polls += 1;
        const status = this.statuses[index];
        const build: Dict = {
          id: input.ids[0],
          buildStatus: status,
          currentPhase: status !== "IN_PROGRESS" ? "COMPLETED" : "BUILD",
          startTime: new Date(Date.UTC(2026, 10, 22, 1, 0)),
          phases: [{ phaseType: "BUILD", phaseStatus: "SUCCEEDED" }],
          logs: { groupName: "/codebuild/perf", streamName: "stream" },
        };
        if (status !== "IN_PROGRESS") {
          build.endTime = new Date(Date.UTC(2026, 10, 22, 1, 5));
        }
        return { builds: [build] };
      }
      case "StopBuildCommand":
        this.stopped.push(input.id);
        return {};
      default:
        return unsupported(command);
    }
  }
}

export class FakeBuildLogs {
  messages: string[];
  error: Error | null;
  served = false;

  constructor(messages: string[] = [], error: Error | null = null) {
    this.messages = messages;
    this.error = error;
  }

  async send(command: unknown): Promise<Dict> {
    if (commandName(command) !== "GetLogEventsCommand") {
      return unsupported(command);
    }
    if (this.error) {
      throw this.error;
    }
    if (this.served) {
      return { events: [], nextForwardToken: "end" };
    }
    this.served = true;
    return { events: this.messages.map((message) => ({ message })), nextForwardToken: "t1" };
  }
}

/** In-memory S3 for the results transfer tests. */
export class FakeS3 {
  objects: Record<string, string>;
  uploads = new Map<string, string>();

  constructor(objects: Record<string, string> = {}) {
    this.objects = { ...objects };
  }

  async send(command: unknown): Promise<Dict> {
    const input = inputOf(command);
    switch (commandName(command)) {
      case "ListObjectsV2Command":
        return {
          Contents: Object.keys(this.objects)
            .sort()
            .filter((key) => key.startsWith(input.Prefix))
            .map((key) => ({ Key: key })),
          IsTruncated: false,
        };
      case "GetObjectCommand": {
        const text = this.objects[input.Key];
        return { Body: { transformToByteArray: async () => new TextEncoder().encode(text) } };
      }
      case "PutObjectCommand":
        this.uploads.set(`${input.Bucket}/${input.Key}`, Buffer.from(input.Body).toString("utf-8"));
        return {};
      default:
        return unsupported(command);
    }
  }
}

export function makeClients(fakes: Dict): Clients {
  return fakes as unknown as Clients;
}

export interface Fakes {
  ecs: FakeEcs;
  rds: FakeRds;
  sagemaker: FakeSageMaker;
  sqs: FakeSqs;
  cloudwatch: FakeCloudWatch;
  logs: FakeLogs;
}

export function healthyClients(snapshot: Dict): { clients: Clients; fakes: Fakes } {
  const fakes: Fakes = {
    ecs: new FakeEcs(snapshot),
    rds: new FakeRds(),
    sagemaker: new FakeSageMaker(),
    sqs: new FakeSqs(),
    cloudwatch: new FakeCloudWatch(),
    logs: new FakeLogs(),
  };
  return { clients: makeClients(fakes), fakes };
}
