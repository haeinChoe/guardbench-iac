// Pre-run check: compare the snapshot's expected values with the real AWS state.
//
// Any mismatch, failed lookup or unfinished rollout means the load must not start.
// SageMaker: status and endpoint config name come from DescribeEndpoint; variant, instance type
// and instance count come from DescribeEndpointConfig (see sagemakerChecks).
// Exit code: 0 all checks passed, 1 at least one check failed or could not be made.

import { DescribeServicesCommand, DescribeTaskDefinitionCommand } from "@aws-sdk/client-ecs";
import type { ECSClient } from "@aws-sdk/client-ecs";
import { DescribeDBInstancesCommand } from "@aws-sdk/client-rds";
import type { RDSClient } from "@aws-sdk/client-rds";
import { DescribeEndpointCommand, DescribeEndpointConfigCommand } from "@aws-sdk/client-sagemaker";
import type { SageMakerClient } from "@aws-sdk/client-sagemaker";
import type { SQSClient } from "@aws-sdk/client-sqs";

import {
  ERROR,
  FAIL,
  PASS,
  SnapshotError,
  check,
  compare,
  dig,
  errorCheck,
  overall,
  parseCli,
  queueDepth,
  queueIsEmpty,
  readJson,
  requiredString,
  runScript,
  withUsageErrors,
  writeJson,
} from "./common.ts";
import type { Check, Clients, Dict } from "./common.ts";

export const WORKER_CONCURRENCY_ENV = "GUARDBENCH_WORKER_WORK_ITEMS_CONCURRENCY";
const SUPPORTED_SCHEMA_VERSION = 1;

interface ServiceExpectations {
  desiredCount?: number;
  cpu?: string;
  memory?: string;
  concurrency?: number;
}

async function serviceChecks(
  ecs: ECSClient,
  label: string,
  cluster: string,
  serviceName: string,
  taskDefinitionArn: string,
  expected: ServiceExpectations = {},
): Promise<Check[]> {
  const prefix = `ecs.${label}`;
  const checks: Check[] = [];
  try {
    const response = await ecs.send(new DescribeServicesCommand({ cluster, services: [serviceName] }));
    const services = response.services ?? [];
    if (services.length === 0) {
      return [check(`${prefix}.exists`, FAIL, serviceName, null, `service ${serviceName} not found`)];
    }
    const service = services[0];
    checks.push(compare(`${prefix}.status`, "ACTIVE", service.status));
    const desired = service.desiredCount;
    if (expected.desiredCount !== undefined) {
      checks.push(compare(`${prefix}.desired_count`, expected.desiredCount, desired));
    }
    checks.push(compare(`${prefix}.running_count`, desired, service.runningCount));
    checks.push(compare(`${prefix}.pending_count`, 0, service.pendingCount));
    checks.push(compare(`${prefix}.task_definition`, taskDefinitionArn, service.taskDefinition));
    const rollout = (service.deployments ?? []).map((item) => [item.status, item.rolloutState]);
    checks.push(compare(`${prefix}.rollout`, [["PRIMARY", "COMPLETED"]], rollout));
  } catch (exc) {
    // A failed lookup must block the run, whatever its cause.
    return [errorCheck(`${prefix}.service`, exc)];
  }

  if (expected.cpu === undefined && expected.memory === undefined && expected.concurrency === undefined) {
    return checks;
  }
  try {
    const response = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefinitionArn }));
    const definition = response.taskDefinition ?? {};
    if (expected.cpu !== undefined) {
      checks.push(compare(`${prefix}.task_cpu`, expected.cpu, definition.cpu));
    }
    if (expected.memory !== undefined) {
      checks.push(compare(`${prefix}.task_memory`, expected.memory, definition.memory));
    }
    if (expected.concurrency !== undefined) {
      const environment = new Map<string, string | undefined>();
      for (const container of definition.containerDefinitions ?? []) {
        for (const item of container.environment ?? []) {
          environment.set(item.name ?? "", item.value);
        }
      }
      checks.push(
        compare(`${prefix}.work_items_concurrency`, String(expected.concurrency), environment.get(WORKER_CONCURRENCY_ENV)),
      );
    }
  } catch (exc) {
    checks.push(errorCheck(`${prefix}.task_definition_lookup`, exc));
  }
  return checks;
}

async function rdsChecks(rds: RDSClient, identifier: string, expectedClass: string): Promise<Check[]> {
  try {
    const response = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }));
    const instances = response.DBInstances ?? [];
    if (instances.length === 0) {
      return [check("rds.exists", FAIL, identifier, null, `DB instance ${identifier} not found`)];
    }
    const instance = instances[0];
    return [
      compare("rds.instance_class", expectedClass, instance.DBInstanceClass),
      compare("rds.status", "available", instance.DBInstanceStatus),
    ];
  } catch (exc) {
    return [errorCheck("rds.instance", exc)];
  }
}

/**
 * Check the endpoint is InService and was built from the expected endpoint config.
 *
 * Variant name, instance type and instance count are read from the endpoint config
 * (InitialInstanceCount). That equals the live instance count only because this IaC has no
 * SageMaker autoscaling: an InService endpoint then runs exactly the configured count.
 * If autoscaling is added, replace the count check with the endpoint's current instance
 * count (DescribeEndpoint ProductionVariants[].CurrentInstanceCount).
 */
async function sagemakerChecks(
  sagemaker: SageMakerClient,
  endpointName: string,
  endpointConfigName: string,
  variantName: string,
  instanceType: string,
  instanceCount: number,
): Promise<Check[]> {
  try {
    const endpoint = await sagemaker.send(new DescribeEndpointCommand({ EndpointName: endpointName }));
    const checks = [
      compare("sagemaker.status", "InService", endpoint.EndpointStatus),
      compare("sagemaker.endpoint_config", endpointConfigName, endpoint.EndpointConfigName),
    ];
    const config = await sagemaker.send(
      new DescribeEndpointConfigCommand({ EndpointConfigName: endpoint.EndpointConfigName || endpointConfigName }),
    );
    const variants = new Map((config.ProductionVariants ?? []).map((item) => [item.VariantName, item]));
    const variant = variants.get(variantName);
    if (variant === undefined) {
      checks.push(check("sagemaker.variant", FAIL, variantName, [...variants.keys()].sort(), "variant not found"));
      return checks;
    }
    checks.push(compare("sagemaker.instance_type", instanceType, variant.InstanceType));
    checks.push(compare("sagemaker.instance_count", instanceCount, variant.InitialInstanceCount));
    return checks;
  } catch (exc) {
    return [errorCheck("sagemaker.endpoint", exc)];
  }
}

async function queueChecks(sqs: SQSClient, kind: string, urls: Record<string, string>): Promise<Check[]> {
  const checks: Check[] = [];
  for (const name of Object.keys(urls).sort()) {
    const label = `sqs.${kind}.${name}`;
    let depth;
    try {
      depth = await queueDepth(sqs, urls[name]);
    } catch (exc) {
      checks.push(errorCheck(label, exc));
      continue;
    }
    if (queueIsEmpty(depth)) {
      checks.push(check(label, PASS, "empty", depth));
    } else {
      checks.push(check(label, FAIL, "empty", depth, `${kind} queue ${name} still holds messages`));
    }
  }
  return checks;
}

export async function evaluate(snapshot: Dict, clients: Clients): Promise<{ status: string; checks: Check[] }> {
  let cluster: string;
  let apiExpected: Dict, workerExpected: Dict, apiResources: Dict, workerResources: Dict, demoResources: Dict;
  let rdsExpected: Dict, sagemakerExpected: Dict, endpointConfigName: string;
  let sourceQueues: Record<string, string>, deadLetterQueues: Record<string, string>;
  try {
    const version = dig(snapshot, "schema_version");
    if (version !== SUPPORTED_SCHEMA_VERSION) {
      throw new SnapshotError(`unsupported snapshot schema_version ${JSON.stringify(version)}`);
    }
    const expected = dig(snapshot, "expected");
    const resources = dig(snapshot, "resources");
    cluster = dig(resources, "ecs", "cluster_name") as unknown as string;
    apiExpected = dig(expected, "ecs", "api");
    workerExpected = dig(expected, "ecs", "worker");
    apiResources = dig(resources, "ecs", "api");
    workerResources = dig(resources, "ecs", "worker");
    demoResources = dig(resources, "ecs", "demo_ai");
    rdsExpected = dig(expected, "rds");
    sagemakerExpected = dig(expected, "sagemaker");
    endpointConfigName = dig(resources, "sagemaker", "endpoint_config_name") as unknown as string;
    sourceQueues = dig(resources, "sqs", "source_queue_urls");
    deadLetterQueues = dig(resources, "sqs", "dlq_urls");
  } catch (exc) {
    if (exc instanceof SnapshotError) {
      return { status: ERROR, checks: [errorCheck("snapshot", exc)] };
    }
    throw exc;
  }

  const checks: Check[] = [];
  checks.push(
    ...(await serviceChecks(clients.ecs, "api", cluster, apiExpected.service_identifier, apiResources.task_definition_arn, {
      desiredCount: apiExpected.desired_count,
      cpu: apiExpected.task_cpu,
      memory: apiExpected.task_memory,
    })),
  );
  checks.push(
    ...(await serviceChecks(
      clients.ecs,
      "worker",
      cluster,
      workerExpected.service_identifier,
      workerResources.task_definition_arn,
      {
        desiredCount: workerExpected.desired_count,
        cpu: workerExpected.task_cpu,
        memory: workerExpected.task_memory,
        concurrency: workerExpected.work_items_concurrency,
      },
    )),
  );
  checks.push(
    ...(await serviceChecks(clients.ecs, "demo_ai", cluster, demoResources.service_name, demoResources.task_definition_arn)),
  );
  checks.push(...(await rdsChecks(clients.rds, rdsExpected.db_instance_identifier, rdsExpected.db_instance_class)));
  checks.push(
    ...(await sagemakerChecks(
      clients.sagemaker,
      sagemakerExpected.endpoint_name,
      endpointConfigName,
      sagemakerExpected.production_variant_name,
      sagemakerExpected.instance_type,
      sagemakerExpected.desired_instance_count,
    )),
  );
  checks.push(...(await queueChecks(clients.sqs, "source", sourceQueues)));
  checks.push(...(await queueChecks(clients.sqs, "dlq", deadLetterQueues)));
  return { status: overall(checks), checks };
}

export async function main(argv: string[], clients: Clients): Promise<number> {
  return withUsageErrors(async () => {
    const args = parseCli(argv, { snapshot: requiredString, output: requiredString });
    let snapshot: Dict;
    try {
      snapshot = readJson(args.snapshot);
    } catch (exc) {
      writeJson(args.output, { status: ERROR, checks: [errorCheck("snapshot", exc)] });
      return 1;
    }
    const result = await evaluate(snapshot, clients);
    writeJson(args.output, result);
    for (const item of result.checks) {
      if (item.status !== PASS) {
        process.stderr.write(`${item.status}: ${item.name}: ${item.message}\n`);
      }
    }
    console.log(`preflight: ${result.status}`);
    return result.status === PASS ? 0 : 1;
  });
}

if (import.meta.main) {
  await runScript(main);
}
