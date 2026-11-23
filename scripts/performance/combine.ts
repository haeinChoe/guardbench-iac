// Combine the Runner's result files and the infrastructure snapshot into the experiment verdict.
//
// The Runner owns the application-level verdict (exit code 0 PASS / 1 FAIL / 2 error);
// the infrastructure evidence owns the infrastructure-level verdict. The experiment is
// PASS only when both pass. A missing, unreadable or unexpected Runner exit code counts
// as 2 (error). The tuple is (W, C, T): W is the Worker concurrency from the snapshot,
// C and T come from the Runner result.
//
// Exit code: 0 PASS, 1 FAIL, 2 ERROR.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ERROR,
  FAIL,
  PASS,
  describeError,
  dig,
  isObject,
  objectOrEmpty,
  optionalString,
  parseCli,
  readJson,
  requiredString,
  runScript,
  withUsageErrors,
  writeJson,
} from "./common.ts";
import type { Clients, Dict } from "./common.ts";

const EXIT_CODE_FILE = "runner-exit-code";
const RESULT_FILE = "result.json";
const FAILURE_FILE = "failure.json";
const APP_STATUS: Record<number, string> = { 0: PASS, 1: FAIL, 2: ERROR };
export const NOT_RUN = "NOT_RUN";
export const NOT_COLLECTED = "NOT_COLLECTED";

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** Return [exit code, source]. Anything but a readable 0, 1 or 2 is 2. */
function readExitCode(resultDir: string | null, reasons: string[]): [number, string] {
  const path = resultDir ? join(resultDir, EXIT_CODE_FILE) : null;
  if (path === null || !isFile(path)) {
    reasons.push("runner-exit-code was not found in the results; treated as 2");
    return [2, "missing"];
  }
  const text = readFileSync(path, "utf-8").trim();
  if (!/^[+-]?\d+$/.test(text)) {
    reasons.push(`runner-exit-code is not a number ('${text}'); treated as 2`);
    return [2, "invalid"];
  }
  const code = Number(text);
  if (!(code in APP_STATUS)) {
    reasons.push(`runner-exit-code ${code} is not 0, 1 or 2; treated as 2`);
    return [2, "invalid"];
  }
  return [code, EXIT_CODE_FILE];
}

function readOptionalJson(path: string): [unknown, string | null] {
  if (!isFile(path)) {
    return [null, "not found"];
  }
  try {
    return [JSON.parse(readFileSync(path, "utf-8")), null];
  } catch (exc) {
    return [null, `unreadable (${describeError(exc)})`];
  }
}

function resultSummary(result: Dict): Dict {
  const acceptance = objectOrEmpty(result.acceptance);
  return {
    run_id: result.run_id ?? null,
    started_at: result.started_at ?? null,
    finished_at: result.finished_at ?? null,
    scenario: result.scenario ?? null,
    dataset: result.dataset ?? null,
    acceptance_status: acceptance.status ?? null,
    failed_checks: (acceptance.checks ?? []).filter((item: Dict) => item.status === FAIL),
  };
}

/** Why the build summary cannot back a passing Runner, or null when it can. */
function buildProblem(build: Dict | null): string | null {
  if (build === null) {
    return "the CodeBuild build status could not be confirmed (no build summary)";
  }
  if (build.wait_timed_out === true) {
    return "the wait for the CodeBuild build timed out";
  }
  if (build.status !== "SUCCEEDED") {
    return `the CodeBuild build status is ${build.status ?? "unknown"}, not SUCCEEDED`;
  }
  return null;
}

export function combine(
  snapshot: Dict,
  resultDir: string | null,
  build: Dict | null,
  infrastructure: Dict | null,
  preflight: Dict | null,
): Dict {
  const reasons: string[] = [];
  const workerConcurrency = dig(snapshot, "expected", "ecs", "worker", "work_items_concurrency");
  const final: Dict = {
    schema_version: 1,
    experiment: {
      id: snapshot.id ?? null,
      revision: snapshot.revision ?? null,
      app_image_tag: snapshot.app_image_tag ?? null,
    },
    tuple: { W: workerConcurrency, C: null, T: null },
    preflight: { status: preflight?.status ?? NOT_COLLECTED },
    build: {
      status: build?.status ?? NOT_RUN,
      build_id: build?.build_id ?? null,
    },
  };

  if (preflight !== null && preflight.status !== PASS) {
    const failed = (preflight.checks ?? []).filter((item: Dict) => item.status !== PASS);
    reasons.push(...failed.map((item: Dict) => `preflight ${item.name}: ${item.message || item.status}`));
    if (failed.length === 0) {
      reasons.push("preflight did not pass");
    }
    Object.assign(final, {
      status: ERROR,
      stage: "preflight",
      reasons,
      runner: { status: NOT_RUN, exit_code: null },
      infrastructure: { status: NOT_COLLECTED },
    });
    return final;
  }

  const directory = resultDir || null;
  let [exitCode, source] = readExitCode(directory, reasons);
  const runner: Dict = { exit_code: exitCode, exit_code_source: source };

  let result: Dict | null = null;
  if (exitCode === 0 || exitCode === 1) {
    let problem: string | null = "not found";
    let parsed: unknown = null;
    if (directory) {
      [parsed, problem] = readOptionalJson(join(directory, RESULT_FILE));
    }
    if (isObject(parsed)) {
      result = parsed;
    } else {
      reasons.push(`Runner exit code ${exitCode} but ${RESULT_FILE} is ${problem ?? "not an object"}; treated as 2`);
      exitCode = 2;
      runner.exit_code = 2;
    }
  }
  if (exitCode === 0) {
    // A passing Runner means its build ended with SUCCEEDED. Exit code 1 (a measurement FAIL)
    // makes the build FAILED, which is expected, so it is not checked.
    const problem = buildProblem(build);
    if (problem !== null) {
      reasons.push(`Runner exit code 0 but ${problem}; treated as 2`);
      exitCode = 2;
      runner.exit_code = 2;
    }
  }
  if (result !== null) {
    runner.result = resultSummary(result);
    const tupleInfo = objectOrEmpty(result.tuple);
    final.tuple.C = tupleInfo.concurrent_test_runs ?? null;
    final.tuple.T = tupleInfo.test_case_count ?? null;
    if (exitCode === 1) {
      reasons.push("Runner reported a measurement FAIL");
    }
  }
  if (exitCode === 2 && directory !== null) {
    const [failure] = readOptionalJson(join(directory, FAILURE_FILE));
    if (isObject(failure)) {
      runner.failure = failure;
      reasons.push(`Runner failure at phase ${failure.phase ?? "None"}`);
    }
  }
  runner.status = APP_STATUS[exitCode];
  final.runner = runner;

  const infrastructureStatus: string = infrastructure === null ? NOT_COLLECTED : (infrastructure.status ?? ERROR);
  final.infrastructure = {
    status: infrastructureStatus,
    failed_checks: (infrastructure?.checks ?? []).filter((item: Dict) => item.status !== PASS),
  };
  for (const item of final.infrastructure.failed_checks) {
    reasons.push(`infrastructure ${item.name}: ${item.message || item.status}`);
  }
  if (infrastructureStatus === NOT_COLLECTED && runner.status !== ERROR) {
    reasons.push("infrastructure evidence was not collected");
  }

  const statuses = [runner.status, infrastructureStatus];
  if (statuses.includes(ERROR) || statuses.includes(NOT_COLLECTED)) {
    final.status = ERROR;
  } else if (statuses.includes(FAIL)) {
    final.status = FAIL;
  } else {
    final.status = PASS;
  }
  final.stage = "complete";
  final.reasons = reasons;
  return final;
}

export function renderSummary(final: Dict): string {
  const experiment = final.experiment;
  const tupleInfo = final.tuple;
  const runner = final.runner;
  const infrastructure = final.infrastructure;
  const lines = [
    `## Performance experiment \`${experiment.id}\`: ${final.status}`,
    "",
    `- IaC revision: \`${experiment.revision}\``,
    `- Backend image tag: \`${experiment.app_image_tag}\``,
    `- Tuple (W, C, T): (${tupleInfo.W}, ${tupleInfo.C}, ${tupleInfo.T})`,
    "",
    "| Stage | Status |",
    "| --- | --- |",
    `| Preflight | ${final.preflight.status} |`,
    `| CodeBuild | ${final.build.status} |`,
    `| Runner (exit code ${runner.exit_code}) | ${runner.status} |`,
    `| Infrastructure | ${infrastructure.status} |`,
    `| **Final** | **${final.status}** |`,
  ];
  if (final.reasons.length > 0) {
    lines.push("", "### Reasons", "");
    lines.push(...final.reasons.map((reason: string) => `- ${reason}`));
  }
  const result = runner.result;
  if (result) {
    lines.push(
      "",
      "### Runner result",
      "",
      `- Run: \`${result.run_id}\``,
      `- Window: ${result.started_at} to ${result.finished_at}`,
      `- Acceptance: ${result.acceptance_status}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function main(argv: string[], _clients?: Clients): Promise<number> {
  return withUsageErrors(async () => {
    const args = parseCli(argv, {
      snapshot: requiredString,
      "result-dir": optionalString,
      build: optionalString,
      infrastructure: optionalString,
      preflight: optionalString,
      output: requiredString,
      summary: requiredString,
    });
    const optional = (path: string | undefined): Dict | null => (path && isFile(path) ? readJson(path) : null);
    let final: Dict;
    try {
      final = combine(
        readJson(args.snapshot),
        args["result-dir"] ?? null,
        optional(args.build),
        optional(args.infrastructure),
        optional(args.preflight),
      );
    } catch (exc) {
      process.stderr.write(`ERROR: ${describeError(exc)}\n`);
      return 2;
    }
    writeJson(args.output, final);
    writeFileSync(args.summary, renderSummary(final), "utf-8");
    console.log(`experiment verdict: ${final.status}`);
    return final.status === PASS ? 0 : final.status === FAIL ? 1 : 2;
  });
}

if (import.meta.main) {
  await runScript(main);
}
