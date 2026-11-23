// Collect the experiment window's infrastructure evidence and make the infrastructure-level call.
//
// Collected: queue drain and DLQ state, CloudWatch metrics of the ECS services, the RDS
// instance and the SageMaker endpoint, and ECS log events of every TestRun in the window.
// CloudWatch publishes datapoints with a delay, so the metric query ends a settle period after
// the build ended and the collection waits until then.
// Infrastructure verdict: PASS when every source queue drains and every DLQ is empty and
// all evidence could be read; FAIL when a queue does not drain or a DLQ holds messages;
// ERROR when any evidence could not be read. Resource utilization is recorded, not judged:
// no utilization criteria are defined yet.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import type { CloudWatchClient, MetricDataQuery } from "@aws-sdk/client-cloudwatch";
import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import type { SQSClient } from "@aws-sdk/client-sqs";

import {
  ERROR,
  FAIL,
  PASS,
  check,
  describeError,
  dig,
  errorCheck,
  isoWithOffset,
  log,
  monotonic,
  numberOption,
  optionalString,
  overall,
  parseCli,
  parseIso,
  queueDepth,
  queueIsEmpty,
  readJson,
  requiredString,
  runScript,
  sleep,
  withUsageErrors,
  writeJson,
} from "./common.ts";
import type { Check, Clients, Dict, QueueDepth } from "./common.ts";

const METRIC_PERIOD_SECONDS = 60;
export const DEFAULT_METRICS_SETTLE_SECONDS = 180;
const MAX_LOG_SAMPLE_EVENTS = 500;

/** Time hooks, replaceable in tests. */
export interface TimeHooks {
  sleep: (seconds: number) => Promise<void>;
  monotonic: () => number;
  /** Wall clock, compared with the end of the build. */
  now: () => Date;
}

const DEFAULT_HOOKS: TimeHooks = { sleep, monotonic, now: () => new Date() };

/** When the metric query ends: a settle period after the build ended. */
export interface MetricsSettle {
  /** End of the build, or null when it is not known (the window end is used as is). */
  buildEnd: Date | null;
  seconds: number;
}

/** Poll the source queues until they are all empty or the timeout passes. */
export async function waitForDrain(
  sqs: SQSClient,
  urls: Record<string, string>,
  timeoutSeconds: number,
  pollSeconds: number,
  hooks: TimeHooks = DEFAULT_HOOKS,
): Promise<{ depths: Record<string, QueueDepth>; errors: Record<string, string> }> {
  const deadline = hooks.monotonic() + timeoutSeconds;
  const depths: Record<string, QueueDepth> = {};
  for (;;) {
    const errors: Record<string, string> = {};
    for (const name of Object.keys(urls).sort()) {
      try {
        depths[name] = await queueDepth(sqs, urls[name]);
      } catch (exc) {
        errors[name] = describeError(exc);
      }
    }
    if (Object.keys(errors).length > 0 || Object.keys(urls).every((name) => queueIsEmpty(depths[name]))) {
      return { depths, errors };
    }
    if (hooks.monotonic() >= deadline) {
      return { depths, errors };
    }
    await hooks.sleep(pollSeconds);
  }
}

function queueChecks(depths: Record<string, QueueDepth>, errors: Record<string, string>, kind: string): Check[] {
  const checks: Check[] = [];
  for (const name of [...new Set([...Object.keys(depths), ...Object.keys(errors)])].sort()) {
    const label = `${kind}.${name}`;
    if (name in errors) {
      checks.push(check(label, ERROR, null, null, errors[name]));
    } else if (queueIsEmpty(depths[name])) {
      checks.push(check(label, PASS, "empty", depths[name]));
    } else {
      checks.push(check(label, FAIL, "empty", depths[name], `${kind} ${name} is not empty`));
    }
  }
  return checks;
}

interface MetricDefinition {
  key: string;
  namespace: string;
  metric: string;
  stat: string;
  dimensions: { Name: string; Value: string }[];
}

function metricDefinitions(snapshot: Dict): MetricDefinition[] {
  const cluster = dig(snapshot, "resources", "ecs", "cluster_name");
  const services: Record<string, string> = {
    api: dig(snapshot, "resources", "ecs", "api", "service_name"),
    worker: dig(snapshot, "resources", "ecs", "worker", "service_name"),
    demo_ai: dig(snapshot, "resources", "ecs", "demo_ai", "service_name"),
  };
  const definitions: MetricDefinition[] = [];
  for (const [label, service] of Object.entries(services)) {
    const dimensions = [
      { Name: "ClusterName", Value: cluster },
      { Name: "ServiceName", Value: service },
    ];
    for (const metric of ["CPUUtilization", "MemoryUtilization"]) {
      for (const stat of ["Average", "Maximum"]) {
        definitions.push({ key: `ecs.${label}.${metric}.${stat}`, namespace: "AWS/ECS", metric, stat, dimensions });
      }
    }
  }
  const dbIdentifier = dig(snapshot, "resources", "rds", "db_instance_identifier");
  definitions.push({
    key: "rds.CPUUtilization.Maximum",
    namespace: "AWS/RDS",
    metric: "CPUUtilization",
    stat: "Maximum",
    dimensions: [{ Name: "DBInstanceIdentifier", Value: dbIdentifier }],
  });
  const endpoint = dig(snapshot, "resources", "sagemaker", "endpoint_name");
  const variant = dig(snapshot, "resources", "sagemaker", "production_variant_name");
  const sagemakerDimensions = [
    { Name: "EndpointName", Value: endpoint },
    { Name: "VariantName", Value: variant },
  ];
  const sagemakerMetrics: [string, string][] = [
    ["Invocations", "Sum"],
    ["Invocation4XXErrors", "Sum"],
    ["Invocation5XXErrors", "Sum"],
    ["ModelLatency", "Average"],
    ["ModelLatency", "Maximum"],
  ];
  for (const [metric, stat] of sagemakerMetrics) {
    definitions.push({
      key: `sagemaker.${metric}.${stat}`,
      namespace: "AWS/SageMaker",
      metric,
      stat,
      dimensions: sagemakerDimensions,
    });
  }
  return definitions;
}

export interface MetricSummary {
  datapoints: number;
  value: number | null;
}

export async function collectMetrics(
  cloudwatch: CloudWatchClient,
  snapshot: Dict,
  start: Date,
  end: Date,
): Promise<Record<string, MetricSummary>> {
  const definitions = metricDefinitions(snapshot);
  const queries: MetricDataQuery[] = definitions.map((item, index) => ({
    Id: `m${index}`,
    Label: item.key,
    MetricStat: {
      Metric: { Namespace: item.namespace, MetricName: item.metric, Dimensions: item.dimensions },
      Period: METRIC_PERIOD_SECONDS,
      Stat: item.stat,
    },
    ReturnData: true,
  }));
  const values = new Map<string, number[]>(definitions.map((item) => [item.key, []]));
  const byId = new Map(definitions.map((item, index) => [`m${index}`, item.key]));
  let token: string | undefined;
  do {
    const page = await cloudwatch.send(
      new GetMetricDataCommand({ MetricDataQueries: queries, StartTime: start, EndTime: end, NextToken: token }),
    );
    for (const result of page.MetricDataResults ?? []) {
      const key = byId.get(result.Id ?? "");
      if (key !== undefined) {
        values.get(key)?.push(...(result.Values ?? []).map(Number));
      }
    }
    token = page.NextToken;
  } while (token);
  const summary: Record<string, MetricSummary> = {};
  for (const item of definitions) {
    const points = values.get(item.key) ?? [];
    const total = points.reduce((sum, point) => sum + point, 0);
    if (points.length === 0) {
      summary[item.key] = { datapoints: 0, value: null };
    } else if (item.stat === "Maximum") {
      summary[item.key] = { datapoints: points.length, value: Math.max(...points) };
    } else if (item.stat === "Sum") {
      summary[item.key] = { datapoints: points.length, value: total };
    } else {
      summary[item.key] = { datapoints: points.length, value: total / points.length };
    }
  }
  return summary;
}

export interface LogSampleEvent {
  log_group: string;
  timestamp: number | undefined;
  message: string;
}

/** Return per-group counts, a bounded event sample and the checks for the groups. */
export async function collectLogs(
  logsClient: CloudWatchLogsClient,
  groups: string[],
  start: Date,
  end: Date,
): Promise<{ counts: Record<string, { events: number; error_events: number }>; sample: LogSampleEvent[]; checks: Check[] }> {
  const startMs = Math.trunc(start.getTime());
  const endMs = Math.trunc(end.getTime());
  const counts: Record<string, { events: number; error_events: number }> = {};
  const sample: LogSampleEvent[] = [];
  const checks: Check[] = [];
  for (const group of groups) {
    let events = 0;
    let errorEvents = 0;
    try {
      let token: string | undefined;
      do {
        const page = await logsClient.send(
          new FilterLogEventsCommand({ logGroupName: group, startTime: startMs, endTime: endMs, nextToken: token }),
        );
        for (const event of page.events ?? []) {
          events += 1;
          const message = event.message ?? "";
          if (message.includes("ERROR")) {
            errorEvents += 1;
          }
          if (sample.length < MAX_LOG_SAMPLE_EVENTS) {
            sample.push({ log_group: group, timestamp: event.timestamp, message: message.trimEnd() });
          }
        }
        token = page.nextToken;
      } while (token);
      counts[group] = { events, error_events: errorEvents };
      checks.push(check(`logs.${group}`, PASS, null, counts[group]));
    } catch (exc) {
      checks.push(errorCheck(`logs.${group}`, exc));
    }
  }
  return { counts, sample, checks };
}

export async function collect(
  snapshot: Dict,
  clients: Clients,
  start: Date,
  end: Date,
  drainTimeoutSeconds: number,
  drainPollSeconds: number,
  hooks: TimeHooks = DEFAULT_HOOKS,
  settle: MetricsSettle = { buildEnd: null, seconds: DEFAULT_METRICS_SETTLE_SECONDS },
): Promise<{ infrastructure: Dict; logSample: LogSampleEvent[] }> {
  const checks: Check[] = [];
  const sqs = clients.sqs;
  const sourceUrls: Record<string, string> = dig(snapshot, "resources", "sqs", "source_queue_urls");
  const deadLetterUrls: Record<string, string> = dig(snapshot, "resources", "sqs", "dlq_urls");

  const source = await waitForDrain(sqs, sourceUrls, drainTimeoutSeconds, drainPollSeconds, hooks);
  checks.push(...queueChecks(source.depths, source.errors, "queue_drain"));
  const deadLetterDepths: Record<string, QueueDepth> = {};
  const deadLetterErrors: Record<string, string> = {};
  for (const name of Object.keys(deadLetterUrls).sort()) {
    try {
      deadLetterDepths[name] = await queueDepth(sqs, deadLetterUrls[name]);
    } catch (exc) {
      deadLetterErrors[name] = describeError(exc);
    }
  }
  checks.push(...queueChecks(deadLetterDepths, deadLetterErrors, "dlq_empty"));

  let metricsEnd = end;
  if (settle.buildEnd !== null) {
    metricsEnd = new Date(settle.buildEnd.getTime() + settle.seconds * 1000);
    // The wait is bounded by the settle period even if the clocks disagree.
    const remaining = Math.min((metricsEnd.getTime() - hooks.now().getTime()) / 1000, settle.seconds);
    if (remaining > 0) {
      log(`waiting ${Math.ceil(remaining)}s for CloudWatch metrics to settle after the build`);
      await hooks.sleep(remaining);
    }
  }

  let metrics: Record<string, MetricSummary>;
  try {
    metrics = await collectMetrics(clients.cloudwatch, snapshot, start, metricsEnd);
    checks.push(check("metrics.collection", PASS, null, `${Object.keys(metrics).length} series`));
  } catch (exc) {
    metrics = {};
    checks.push(errorCheck("metrics.collection", exc));
  }

  const groups = [
    ...new Set(
      ["api", "worker", "demo_ai"].map((name) => dig(snapshot, "resources", "ecs", name, "log_group_name") as string),
    ),
  ].sort();
  const logs = await collectLogs(clients.logs, groups, start, end);
  checks.push(...logs.checks);

  const infrastructure = {
    status: overall(checks),
    window: { start: isoWithOffset(start), end: isoWithOffset(end) },
    metrics_window: { start: isoWithOffset(start), end: isoWithOffset(metricsEnd) },
    queues: { source: source.depths, dead_letter: deadLetterDepths },
    metrics,
    logs: logs.counts,
    checks,
  };
  return { infrastructure, logSample: logs.sample };
}

/** Pick the experiment window: explicit values, else the Runner result, else the build times.
 * The metric query then ends a settle period after the build ended, unless --end is explicit. */
export function resolveWindow(
  start: string | undefined,
  end: string | undefined,
  resultDir: string | undefined,
  build: Dict | null | undefined,
): [Date, Date] {
  const candidates: [string | undefined, string | undefined][] = [[start, end]];
  if (resultDir) {
    const path = join(resultDir, "result.json");
    if (existsSync(path)) {
      try {
        const result = readJson(path);
        candidates.push([result.started_at, result.finished_at]);
      } catch {
        // An unreadable Runner result falls through to the build times.
      }
    }
  }
  if (build) {
    candidates.push([build.start_time, build.end_time]);
  }
  for (const [first, last] of candidates) {
    if (first && last) {
      return [parseIso(first), parseIso(last)];
    }
  }
  throw new Error("no experiment window: pass --start/--end or provide a Runner result or build summary");
}

/** The end time of the build summary, or null when the build has none (not finished, no summary). */
function buildEndTime(build: Dict | null): Date | null {
  return build && typeof build.end_time === "string" && build.end_time !== "" ? parseIso(build.end_time) : null;
}

export async function main(argv: string[], clients: Clients, hooks: TimeHooks = DEFAULT_HOOKS): Promise<number> {
  return withUsageErrors(async () => {
    const args = parseCli(argv, {
      snapshot: requiredString,
      start: optionalString,
      end: optionalString,
      "result-dir": optionalString,
      build: optionalString,
      output: requiredString,
      "logs-output": requiredString,
      "drain-timeout-seconds": numberOption(300),
      "drain-poll-seconds": numberOption(10),
      "metrics-settle-seconds": numberOption(DEFAULT_METRICS_SETTLE_SECONDS),
    });
    let infrastructure: Dict;
    let logSample: LogSampleEvent[];
    try {
      const snapshot = readJson(args.snapshot);
      const build = args.build && existsSync(args.build) ? readJson(args.build) : null;
      const [windowStart, windowEnd] = resolveWindow(args.start, args.end, args["result-dir"], build);
      ({ infrastructure, logSample } = await collect(
        snapshot,
        clients,
        windowStart,
        windowEnd,
        args["drain-timeout-seconds"],
        args["drain-poll-seconds"],
        hooks,
        { buildEnd: args.end ? null : buildEndTime(build), seconds: args["metrics-settle-seconds"] },
      ));
    } catch (exc) {
      writeJson(args.output, { status: ERROR, checks: [errorCheck("collect", exc)] });
      writeJson(args["logs-output"], []);
      process.stderr.write(`ERROR: ${describeError(exc)}\n`);
      return 2;
    }
    writeJson(args.output, infrastructure);
    writeJson(args["logs-output"], logSample);
    for (const item of infrastructure.checks as Check[]) {
      if (item.status !== PASS) {
        process.stderr.write(`${item.status}: ${item.name}: ${item.message}\n`);
      }
    }
    console.log(`infrastructure: ${infrastructure.status}`);
    return 0;
  });
}

if (import.meta.main) {
  await runScript(main);
}
