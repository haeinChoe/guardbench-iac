// Shared helpers for the performance experiment entrypoint scripts.
//
// AWS access goes through the AWS SDK v3 default behavior only. Credentials, region and
// endpoint selection come from the environment (AWS_ACCESS_KEY_ID, AWS_REGION,
// AWS_ENDPOINT_URL, ...), so the same code runs against AWS and against any
// AWS-compatible endpoint without a code path of its own.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { CodeBuildClient } from "@aws-sdk/client-codebuild";
import { ECSClient } from "@aws-sdk/client-ecs";
import { RDSClient } from "@aws-sdk/client-rds";
import { S3Client } from "@aws-sdk/client-s3";
import { SageMakerClient } from "@aws-sdk/client-sagemaker";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { QueueAttributeName } from "@aws-sdk/client-sqs";

export const PASS = "PASS";
export const FAIL = "FAIL";
export const ERROR = "ERROR";

// Parsed JSON of unknown shape (snapshot, Runner results, check lists).
export type Dict = Record<string, any>;

export interface Check {
  name: string;
  status: string;
  expected: unknown;
  actual: unknown;
  message: string;
}

export interface QueueDepth {
  visible: number;
  in_flight: number;
  delayed: number;
}

const QUEUE_DEPTH_ATTRIBUTES: QueueAttributeName[] = [
  "ApproximateNumberOfMessages",
  "ApproximateNumberOfMessagesNotVisible",
  "ApproximateNumberOfMessagesDelayed",
];

/** The infrastructure snapshot does not have the expected shape. */
export class SnapshotError extends Error {
  override name = "SnapshotError";
}

/** The service clients a script needs. Tests pass fakes with the same `send` interface. */
export interface Clients {
  readonly ecs: ECSClient;
  readonly rds: RDSClient;
  readonly sagemaker: SageMakerClient;
  readonly sqs: SQSClient;
  readonly cloudwatch: CloudWatchClient;
  readonly logs: CloudWatchLogsClient;
  readonly codebuild: CodeBuildClient;
  readonly s3: S3Client;
}

interface Destroyable {
  destroy(): void;
}

/** Lazily created SDK clients using only the ambient configuration. */
export class AwsClients implements Clients {
  private readonly cache = new Map<string, Destroyable>();

  private get<T extends Destroyable>(name: string, create: () => T): T {
    let client = this.cache.get(name);
    if (client === undefined) {
      client = create();
      this.cache.set(name, client);
    }
    return client as T;
  }

  get ecs(): ECSClient {
    return this.get("ecs", () => new ECSClient({}));
  }
  get rds(): RDSClient {
    return this.get("rds", () => new RDSClient({}));
  }
  get sagemaker(): SageMakerClient {
    return this.get("sagemaker", () => new SageMakerClient({}));
  }
  get sqs(): SQSClient {
    return this.get("sqs", () => new SQSClient({}));
  }
  get cloudwatch(): CloudWatchClient {
    return this.get("cloudwatch", () => new CloudWatchClient({}));
  }
  get logs(): CloudWatchLogsClient {
    return this.get("logs", () => new CloudWatchLogsClient({}));
  }
  get codebuild(): CodeBuildClient {
    return this.get("codebuild", () => new CodeBuildClient({}));
  }
  get s3(): S3Client {
    return this.get("s3", () => new S3Client({}));
  }

  destroy(): void {
    for (const client of this.cache.values()) {
      client.destroy();
    }
    this.cache.clear();
  }
}

/** Run a CLI `main` with real clients, set the exit code and release the connections. */
export async function runScript(main: (argv: string[], clients: Clients) => Promise<number>): Promise<void> {
  const clients = new AwsClients();
  try {
    process.exitCode = await main(process.argv.slice(2), clients);
  } finally {
    clients.destroy();
  }
}

export function readJson(path: string): Dict {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Dict;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, sortKeys(source[key])]),
    );
  }
  return value;
}

/** Write JSON with sorted keys, two-space indent, ASCII only and a trailing newline. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(sortKeys(value), null, 2).replace(
    /[\u007f-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  writeFileSync(path, `${text}\n`, "utf-8");
}

export function isObject(value: unknown): value is Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An object value, or an empty object for anything else (missing, null, a scalar). */
export function objectOrEmpty(value: unknown): Dict {
  return isObject(value) ? value : {};
}

/** ISO 8601 UTC with a trailing Z; fractional seconds only when not zero. */
export function iso(value: Date): string {
  return value.toISOString().replace(".000Z", "Z");
}

/** ISO 8601 UTC with a +00:00 offset, as used for the experiment window. */
export function isoWithOffset(value: Date): string {
  return iso(value).replace(/Z$/, "+00:00");
}

/** Parse an ISO 8601 timestamp; a value without a time zone is read as UTC. */
export function parseIso(value: string): Date {
  let text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    text += "T00:00:00";
  }
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    text += "Z";
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid isoformat string: '${value}'`);
  }
  return parsed;
}

/** Return a nested mapping value or throw a SnapshotError naming the path. */
export function dig(value: unknown, ...path: string[]): any {
  let current: unknown = value;
  for (const key of path) {
    if (!isObject(current) || !(key in current)) {
      throw new SnapshotError(`snapshot is missing ${path.join(".")}`);
    }
    current = current[key];
  }
  return current as Dict;
}

/** Python-style text of a value, for messages that show an expected and an actual value. */
export function repr(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "string") {
    return `'${value}'`;
  }
  return JSON.stringify(value);
}

export function check(
  name: string,
  status: string,
  expected: unknown = null,
  actual: unknown = null,
  message = "",
): Check {
  return { name, status, expected, actual, message };
}

export function compare(name: string, expected: unknown, actual: unknown): Check {
  if (isDeepStrictEqual(expected, actual)) {
    return check(name, PASS, expected, actual);
  }
  return check(name, FAIL, expected, actual, `expected ${repr(expected)}, found ${repr(actual)}`);
}

/** "Name: message" of a thrown value. */
export function describeError(exc: unknown): string {
  if (exc instanceof Error) {
    return `${exc.name}: ${exc.message}`;
  }
  return String(exc);
}

export function errorCheck(name: string, exc: unknown): Check {
  return check(name, ERROR, null, null, describeError(exc));
}

export function overall(checks: Iterable<{ status: string }>): string {
  const statuses = [...checks].map((item) => item.status);
  if (statuses.includes(ERROR)) {
    return ERROR;
  }
  if (statuses.includes(FAIL)) {
    return FAIL;
  }
  return PASS;
}

export async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<QueueDepth> {
  const response = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: QUEUE_DEPTH_ATTRIBUTES }),
  );
  const attributes = response.Attributes ?? {};
  return {
    visible: Number(attributes.ApproximateNumberOfMessages ?? 0),
    in_flight: Number(attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
    delayed: Number(attributes.ApproximateNumberOfMessagesDelayed ?? 0),
  };
}

export function queueIsEmpty(depth: QueueDepth): boolean {
  return depth.visible === 0 && depth.in_flight === 0 && depth.delayed === 0;
}

export function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** Seconds from a monotonic clock. */
export function monotonic(): number {
  return performance.now() / 1000;
}

// --- command line parsing -------------------------------------------------------------

/** A command line the script cannot use (unknown or missing option, bad number). Exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

export interface RequiredString {
  kind: "string";
  required: true;
}
export interface OptionalString {
  kind: "string";
  required: false;
}
export interface NumberOption {
  kind: "number";
  fallback: number;
}
type Option = RequiredString | OptionalString | NumberOption;

export const requiredString: RequiredString = { kind: "string", required: true };
export const optionalString: OptionalString = { kind: "string", required: false };
export function numberOption(fallback: number): NumberOption {
  return { kind: "number", fallback };
}

type Parsed<S extends Record<string, Option>> = {
  [K in keyof S]: S[K] extends NumberOption ? number : S[K] extends RequiredString ? string : string | undefined;
};

/** Parse `--name value` options against a spec; throws UsageError for anything unexpected. */
export function parseCli<S extends Record<string, Option>>(argv: string[], spec: S): Parsed<S> {
  const options: Record<string, { type: "string" }> = {};
  for (const name of Object.keys(spec)) {
    options[name] = { type: "string" };
  }
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values;
  } catch (exc) {
    throw new UsageError(exc instanceof Error ? exc.message : String(exc));
  }
  const result: Dict = {};
  for (const [name, option] of Object.entries(spec)) {
    const raw = values[name] as string | undefined;
    if (option.kind === "number") {
      const number = raw === undefined ? option.fallback : Number(raw);
      if (Number.isNaN(number)) {
        throw new UsageError(`--${name} expects a number, got '${raw}'`);
      }
      result[name] = number;
    } else {
      if (option.required && raw === undefined) {
        throw new UsageError(`--${name} is required`);
      }
      result[name] = raw;
    }
  }
  return result as Parsed<S>;
}

/** Run a CLI body; a usage error prints a message and gives exit code 2. */
export async function withUsageErrors(body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (exc) {
    if (exc instanceof UsageError) {
      process.stderr.write(`usage error: ${exc.message}\n`);
      return 2;
    }
    throw exc;
  }
}
