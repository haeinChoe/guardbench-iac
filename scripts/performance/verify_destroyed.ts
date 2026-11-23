// Confirm that destroy left no experiment-layer resources behind.
//
// Checks the Terraform state list (must be empty) and, when a snapshot exists, asks AWS
// whether the experiment's ECS services, task definitions, SageMaker endpoint and log groups
// are gone. Exit code: 0 nothing left, 1 something is left or could not be confirmed.

import { existsSync, readFileSync } from "node:fs";

import { DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DescribeServicesCommand, DescribeTaskDefinitionCommand } from "@aws-sdk/client-ecs";
import type { ECSClient } from "@aws-sdk/client-ecs";
import {
  DescribeEndpointCommand,
  DescribeEndpointConfigCommand,
  DescribeModelCommand,
} from "@aws-sdk/client-sagemaker";

import {
  FAIL,
  PASS,
  check,
  dig,
  errorCheck,
  overall,
  parseCli,
  optionalString,
  readJson,
  requiredString,
  runScript,
  withUsageErrors,
  writeJson,
} from "./common.ts";
import type { Check, Clients, Dict } from "./common.ts";

const ABSENT = /could not find|not found|does not exist|unable to describe|no such/i;

/** A service error (not a local failure) whose message says the resource is not there. */
function isAbsentError(exc: unknown): boolean {
  return exc instanceof Error && "$metadata" in exc && ABSENT.test(exc.message);
}

async function serviceGone(ecs: ECSClient, cluster: string, service: string, label: string): Promise<Check> {
  try {
    const response = await ecs.send(new DescribeServicesCommand({ cluster, services: [service] }));
    const live = (response.services ?? []).filter((item) => item.status !== undefined && item.status !== "INACTIVE");
    if (live.length > 0) {
      return check(label, FAIL, "absent", live[0].status, `service ${service} still ${live[0].status}`);
    }
    return check(label, PASS, "absent", "absent");
  } catch (exc) {
    return isAbsentError(exc) ? check(label, PASS, "absent", "absent") : errorCheck(label, exc);
  }
}

async function taskDefinitionGone(ecs: ECSClient, arn: string, label: string): Promise<Check> {
  try {
    const response = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn }));
    const status = response.taskDefinition?.status;
    if (status === "INACTIVE") {
      return check(label, PASS, "inactive or absent", "INACTIVE");
    }
    return check(label, FAIL, "inactive or absent", status, `${arn} still ${status}`);
  } catch (exc) {
    return isAbsentError(exc) ? check(label, PASS, "inactive or absent", "absent") : errorCheck(label, exc);
  }
}

async function sagemakerGone(kind: string, name: string, describe: () => Promise<unknown>): Promise<Check> {
  const label = `sagemaker.${kind}`;
  try {
    await describe();
    return check(label, FAIL, "absent", "present", `${kind} ${name} still exists`);
  } catch (exc) {
    return isAbsentError(exc) ? check(label, PASS, "absent", "absent") : errorCheck(label, exc);
  }
}

async function logGroupGone(logs: CloudWatchLogsClient, group: string): Promise<Check> {
  const label = `logs.${group}`;
  try {
    let found = false;
    let token: string | undefined;
    do {
      const page = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: group, nextToken: token }));
      found = found || (page.logGroups ?? []).some((item) => item.logGroupName === group);
      token = page.nextToken;
    } while (token);
    return found ? check(label, FAIL, "absent", "present", `log group ${group} still exists`) : check(label, PASS, "absent", "absent");
  } catch (exc) {
    return errorCheck(label, exc);
  }
}

export async function verify(
  stateResources: string[],
  snapshot: Dict | null,
  clients: Clients,
): Promise<{ status: string; checks: Check[] }> {
  const checks: Check[] = [];
  if (stateResources.length > 0) {
    checks.push(
      check("terraform.state", FAIL, "empty", stateResources, `${stateResources.length} resource(s) remain in state`),
    );
  } else {
    checks.push(check("terraform.state", PASS, "empty", []));
  }
  if (snapshot !== null) {
    const resources = dig(snapshot, "resources");
    const cluster = dig(resources, "ecs", "cluster_name");
    for (const name of ["api", "worker", "demo_ai"]) {
      const entry = dig(resources, "ecs", name);
      checks.push(await serviceGone(clients.ecs, cluster, entry.service_name, `ecs.service.${name}`));
      checks.push(await taskDefinitionGone(clients.ecs, entry.task_definition_arn, `ecs.task_definition.${name}`));
    }
    const sagemaker = dig(resources, "sagemaker");
    checks.push(
      await sagemakerGone("endpoint", sagemaker.endpoint_name, () =>
        clients.sagemaker.send(new DescribeEndpointCommand({ EndpointName: sagemaker.endpoint_name })),
      ),
    );
    checks.push(
      await sagemakerGone("endpoint_config", sagemaker.endpoint_config_name, () =>
        clients.sagemaker.send(new DescribeEndpointConfigCommand({ EndpointConfigName: sagemaker.endpoint_config_name })),
      ),
    );
    checks.push(
      await sagemakerGone("model", sagemaker.model_name, () =>
        clients.sagemaker.send(new DescribeModelCommand({ ModelName: sagemaker.model_name })),
      ),
    );
    const groups = [...new Set(["api", "worker", "demo_ai"].map((name) => dig(resources, "ecs", name, "log_group_name") as string))].sort();
    for (const group of groups) {
      checks.push(await logGroupGone(clients.logs, group));
    }
  }
  return { status: overall(checks), checks };
}

export async function main(argv: string[], clients: Clients): Promise<number> {
  return withUsageErrors(async () => {
    const args = parseCli(argv, { "state-list": requiredString, snapshot: optionalString, output: requiredString });
    const state = readFileSync(args["state-list"], "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line);
    const snapshot = args.snapshot && existsSync(args.snapshot) ? readJson(args.snapshot) : null;
    const result = await verify(state, snapshot, clients);
    writeJson(args.output, result);
    for (const item of result.checks) {
      if (item.status !== PASS) {
        process.stderr.write(`${item.status}: ${item.name}: ${item.message}\n`);
      }
    }
    console.log(`destroy verification: ${result.status}`);
    return result.status === PASS ? 0 : 1;
  });
}

if (import.meta.main) {
  await runScript(main);
}
