// Start, wait for and stop the performance Runner CodeBuild build.
//
// `wait` returns 0 whenever the build reached a terminal state, including FAILED
// (a measurement FAIL makes the Runner, and so the build, exit with code 1). The
// verdict is made later from the Runner's own result files.
// Exit code of `wait`: 0 terminal state reached, 2 wait timed out or could not be observed.

import { BatchGetBuildsCommand, StartBuildCommand, StopBuildCommand } from "@aws-sdk/client-codebuild";
import type { Build, CodeBuildClient } from "@aws-sdk/client-codebuild";
import { GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";

import {
  describeError,
  iso,
  isObject,
  isTransientError,
  log,
  monotonic,
  numberOption,
  parseCli,
  readJson,
  requiredString,
  runScript,
  sleep,
  UsageError,
  withUsageErrors,
  writeJson,
} from "./common.ts";
import type { Clients } from "./common.ts";

/** Consecutive failed BatchGetBuilds polls tolerated before the wait gives up. */
export const MAX_CONSECUTIVE_POLL_FAILURES = 5;
const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "FAULT", "TIMED_OUT", "STOPPED"]);
export const REQUIRED_ENV = [
  "BACKEND_COMMIT",
  "API_URL",
  "TARGET_URL",
  "TARGET_MODEL",
  "SCENARIO_PATH",
  "DATASET_PATH",
  "RESULT_S3_PREFIX",
] as const;

export interface StartedBuild {
  build_id: string;
  project: string;
  status: string | undefined;
}

export interface BuildSummary {
  build_id: string | undefined;
  status: string | undefined;
  current_phase: string | undefined;
  start_time: string | null;
  end_time: string | null;
  phases: { phase: string | undefined; status: string | undefined }[];
  logs: { group_name: string | undefined; stream_name: string | undefined };
  wait_timed_out: boolean;
}

class BuildNotFoundError extends Error {
  override name = "BuildNotFoundError";

  constructor(buildId: string) {
    super(`build ${buildId} not found`);
  }
}

/** Time and output hooks, replaceable in tests. */
export interface WaitHooks {
  sleep: (seconds: number) => Promise<void>;
  monotonic: () => number;
  print: (line: string) => void;
}

const DEFAULT_HOOKS: WaitHooks = { sleep, monotonic, print: (line) => console.log(line) };

export async function startBuild(
  codebuild: CodeBuildClient,
  project: string,
  env: Record<string, string>,
): Promise<StartedBuild> {
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`missing build environment values: ${missing.join(", ")}`);
  }
  const overrides = Object.keys(env)
    .sort()
    .map((name) => ({ name, value: String(env[name]), type: "PLAINTEXT" as const }));
  const response = await codebuild.send(
    new StartBuildCommand({ projectName: project, environmentVariablesOverride: overrides }),
  );
  const build = response.build as Build;
  return { build_id: build.id as string, project, status: build.buildStatus };
}

function summarize(build: Build, timedOutWaiting = false): BuildSummary {
  const logs = build.logs ?? {};
  return {
    build_id: build.id,
    status: build.buildStatus,
    current_phase: build.currentPhase,
    start_time: build.startTime ? iso(build.startTime) : null,
    end_time: build.endTime ? iso(build.endTime) : null,
    phases: (build.phases ?? []).map((item) => ({ phase: item.phaseType, status: item.phaseStatus })),
    logs: { group_name: logs.groupName, stream_name: logs.streamName },
    wait_timed_out: timedOutWaiting,
  };
}

/** Prints new CloudWatch log events of the build; missing logs are not an error. */
class LogFollower {
  private readonly client: CloudWatchLogsClient;
  private readonly print: (line: string) => void;
  private token: string | undefined;

  constructor(client: CloudWatchLogsClient, print: (line: string) => void) {
    this.client = client;
    this.print = print;
  }

  async drain(build: Build): Promise<void> {
    const group = build.logs?.groupName;
    const stream = build.logs?.streamName;
    if (!group || !stream) {
      return;
    }
    try {
      for (;;) {
        const response = await this.client.send(
          new GetLogEventsCommand({
            logGroupName: group,
            logStreamName: stream,
            startFromHead: true,
            ...(this.token ? { nextToken: this.token } : {}),
          }),
        );
        const events = response.events ?? [];
        for (const event of events) {
          this.print((event.message ?? "").trimEnd());
        }
        const next = response.nextForwardToken;
        if (events.length === 0 || next === this.token) {
          this.token = next ?? this.token;
          return;
        }
        this.token = next;
      }
    } catch (exc) {
      // Logs are informational; never fail the wait because of them.
      log(`build log unavailable: ${describeError(exc)}`);
    }
  }
}

export async function waitForBuild(
  clients: Pick<Clients, "codebuild" | "logs">,
  buildId: string,
  timeoutSeconds: number,
  pollSeconds: number,
  hooks: WaitHooks = DEFAULT_HOOKS,
): Promise<BuildSummary> {
  const deadline = hooks.monotonic() + timeoutSeconds;
  const follower = new LogFollower(clients.logs, hooks.print);
  let lastPhase: string | undefined;
  let lastBuild: Build | undefined;
  let failures = 0;
  for (;;) {
    let build: Build;
    try {
      const response = await clients.codebuild.send(new BatchGetBuildsCommand({ ids: [buildId] }));
      const builds = response.builds ?? [];
      if (builds.length === 0) {
        throw new BuildNotFoundError(buildId);
      }
      build = builds[0];
    } catch (exc) {
      if (exc instanceof BuildNotFoundError || !isTransientError(exc)) {
        throw exc;
      }
      failures += 1;
      if (failures > MAX_CONSECUTIVE_POLL_FAILURES) {
        throw exc;
      }
      log(`build ${buildId}: poll failed (${failures}/${MAX_CONSECUTIVE_POLL_FAILURES}), retrying: ${describeError(exc)}`);
      if (hooks.monotonic() >= deadline) {
        return await timedOut(clients.codebuild, buildId, lastBuild, exc);
      }
      await hooks.sleep(pollSeconds);
      continue;
    }
    failures = 0;
    lastBuild = build;
    if (build.currentPhase !== lastPhase) {
      log(`build ${buildId}: phase ${build.currentPhase}`);
      lastPhase = build.currentPhase;
    }
    await follower.drain(build);
    if (build.buildStatus && TERMINAL_STATUSES.has(build.buildStatus)) {
      return summarize(build);
    }
    if (hooks.monotonic() >= deadline) {
      await stopBuild(clients.codebuild, buildId);
      return summarize(build, true);
    }
    await hooks.sleep(pollSeconds);
  }
}

/** The deadline passed while polling kept failing: stop the build if possible and report the timeout. */
async function timedOut(
  codebuild: CodeBuildClient,
  buildId: string,
  lastBuild: Build | undefined,
  cause: unknown,
): Promise<BuildSummary> {
  try {
    await stopBuild(codebuild, buildId);
  } catch (exc) {
    log(`build ${buildId}: could not stop the build: ${describeError(exc)}`);
  }
  if (lastBuild === undefined) {
    throw cause;
  }
  return summarize(lastBuild, true);
}

/** Stop the build if it is still running; return the status seen afterwards. */
export async function stopBuild(codebuild: CodeBuildClient, buildId: string): Promise<string> {
  const response = await codebuild.send(new BatchGetBuildsCommand({ ids: [buildId] }));
  const builds = response.builds ?? [];
  if (builds.length === 0) {
    return "NOT_FOUND";
  }
  const status = builds[0].buildStatus;
  if (status && TERMINAL_STATUSES.has(status)) {
    return status;
  }
  await codebuild.send(new StopBuildCommand({ id: buildId }));
  return "STOP_REQUESTED";
}

function loadEnv(path: string): Record<string, string> {
  const value = readJson(path);
  if (!isObject(value) || !Object.values(value).every((item) => typeof item === "string")) {
    throw new Error("build environment file must be a JSON object of strings");
  }
  return value;
}

export async function main(argv: string[], clients: Clients, hooks: WaitHooks = DEFAULT_HOOKS): Promise<number> {
  return withUsageErrors(async () => {
    const [command, ...rest] = argv;
    try {
      if (command === "start") {
        const args = parseCli(rest, { project: requiredString, "env-file": requiredString, output: requiredString });
        const started = await startBuild(clients.codebuild, args.project, loadEnv(args["env-file"]));
        writeJson(args.output, started);
        console.log(`started build ${started.build_id}`);
        return 0;
      }
      if (command === "wait") {
        const args = parseCli(rest, {
          "start-file": requiredString,
          output: requiredString,
          "timeout-seconds": numberOption(4 * 3600),
          "poll-seconds": numberOption(15),
        });
        const buildId = readJson(args["start-file"]).build_id as string;
        const summary = await waitForBuild(clients, buildId, args["timeout-seconds"], args["poll-seconds"], hooks);
        writeJson(args.output, summary);
        console.log(`build ${buildId}: ${summary.status}`);
        return summary.wait_timed_out ? 2 : 0;
      }
      if (command === "stop") {
        const args = parseCli(rest, { "start-file": requiredString });
        const buildId = readJson(args["start-file"]).build_id as string;
        console.log(`build ${buildId}: ${await stopBuild(clients.codebuild, buildId)}`);
        return 0;
      }
    } catch (exc) {
      if (exc instanceof UsageError) {
        throw exc;
      }
      process.stderr.write(`ERROR: ${describeError(exc)}\n`);
      return 2;
    }
    throw new UsageError("expected a command: start, wait or stop");
  });
}

if (import.meta.main) {
  await runScript(main);
}
