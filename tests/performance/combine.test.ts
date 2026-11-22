import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { combine, main, NOT_COLLECTED, NOT_RUN } from "../../scripts/performance/combine.ts";
import { ERROR, FAIL, PASS } from "../../scripts/performance/common.ts";
import type { Dict } from "../../scripts/performance/common.ts";
import { makeSnapshot } from "./fakes.ts";
import { tempDirectory } from "./helpers.ts";

function runnerResult(status = "PASS", concurrency = 5, cases = 20): Dict {
  return {
    schema_version: 2,
    run_id: "smoke-20261122T010000Z-abcd1234",
    started_at: "2026-11-22T01:00:10Z",
    finished_at: "2026-11-22T01:03:10Z",
    scenario: { id: "smoke", type: "SMOKE" },
    dataset: { id: "baseline-v1", test_case_count: cases, suite_id: 7 },
    tuple: { concurrent_test_runs: concurrency, test_case_count: cases },
    acceptance: {
      status,
      checks: [{ name: "api.p95", status: status === "FAIL" ? "FAIL" : "PASS" }],
    },
  };
}

function infra(status: string = PASS, checks: Dict[] = []): Dict {
  return { status, checks };
}

describe("combine", () => {
  let results: string;
  let snapshot: Dict;
  let ctx: { results: string };

  beforeEach((t) => {
    const root = tempDirectory(t as never);
    results = join(root, "results");
    mkdirSync(results);
    snapshot = makeSnapshot();
    ctx = { results };
  });

  const write = (name: string, content: unknown) => {
    writeFileSync(join(ctx.results, name), typeof content === "string" ? content : JSON.stringify(content), "utf-8");
  };

  const run = (
    options: { build?: Dict; infrastructure?: Dict | null; preflight?: Dict | null; withResults?: boolean } = {},
  ): Dict =>
    combine(
      snapshot,
      options.withResults === false ? null : ctx.results,
      options.build ?? { status: "SUCCEEDED", build_id: "perf-runner:1" },
      options.infrastructure === undefined ? infra() : options.infrastructure,
      options.preflight ?? null,
    );

  it("passes when the Runner and the infrastructure pass", () => {
    write("runner-exit-code", "0\n");
    write("result.json", runnerResult("PASS"));
    const final = run({ preflight: { status: PASS, checks: [] } });
    assert.equal(final.status, PASS);
    assert.deepEqual(final.tuple, { W: 4, C: 5, T: 20 });
    assert.equal(final.runner.status, PASS);
    assert.equal(final.experiment.id, "validation");
    assert.equal(final.stage, "complete");
  });

  it("is FAIL with the tuple on a measurement fail", () => {
    write("runner-exit-code", "1");
    write("result.json", runnerResult("FAIL"));
    const final = run();
    assert.equal(final.status, FAIL);
    assert.equal(final.tuple.C, 5);
    assert.equal(final.runner.result.failed_checks[0].name, "api.p95");
  });

  it("keeps the failure file on a Runner error", () => {
    write("runner-exit-code", "2");
    write("failure.json", { phase: "report", error: { type: "ApiError" } });
    const final = run();
    assert.equal(final.status, ERROR);
    assert.equal(final.runner.failure.phase, "report");
    assert.equal(final.tuple.C, null);
    assert.equal(final.tuple.W, 4);
  });

  it("treats a missing exit code file as two", () => {
    write("result.json", runnerResult("PASS"));
    const final = run();
    assert.equal(final.status, ERROR);
    assert.equal(final.runner.exit_code, 2);
    assert.equal(final.runner.exit_code_source, "missing");
    assert.ok(final.reasons.some((reason: string) => reason.includes("runner-exit-code")));
  });

  it("treats a missing results directory as two", () => {
    const final = run({ withResults: false });
    assert.equal(final.runner.exit_code, 2);
    assert.equal(final.status, ERROR);
  });

  for (const text of ["abc", "3", ""]) {
    it(`treats the exit code value '${text}' as two`, () => {
      write("runner-exit-code", text);
      const final = run();
      assert.equal(final.runner.exit_code, 2);
      assert.equal(final.runner.exit_code_source, "invalid");
    });
  }

  it("is an error for exit zero without result.json", () => {
    write("runner-exit-code", "0");
    const final = run();
    assert.equal(final.status, ERROR);
    assert.equal(final.runner.exit_code, 2);
  });

  it("is an error for exit zero with an unreadable result.json", () => {
    write("runner-exit-code", "0");
    write("result.json", "{not json");
    assert.equal(run().status, ERROR);
  });

  it("is FAIL when the infrastructure fails even if the Runner passes", () => {
    write("runner-exit-code", "0");
    write("result.json", runnerResult("PASS"));
    const failing = infra(FAIL, [{ name: "dlq_empty.resolve", status: FAIL, message: "dlq not empty" }]);
    const final = run({ infrastructure: failing });
    assert.equal(final.status, FAIL);
    assert.equal(final.runner.status, PASS);
    assert.ok(final.reasons.some((reason: string) => reason.includes("dlq_empty.resolve")));
  });

  it("is ERROR when the infrastructure errors", () => {
    write("runner-exit-code", "0");
    write("result.json", runnerResult("PASS"));
    assert.equal(run({ infrastructure: infra(ERROR) }).status, ERROR);
  });

  it("is ERROR for a Runner fail with an infrastructure error", () => {
    write("runner-exit-code", "1");
    write("result.json", runnerResult("FAIL"));
    assert.equal(run({ infrastructure: infra(ERROR) }).status, ERROR);
  });

  it("is an error when the infrastructure evidence is missing", () => {
    write("runner-exit-code", "0");
    write("result.json", runnerResult("PASS"));
    const final = combine(snapshot, ctx.results, { status: "SUCCEEDED" }, null, null);
    assert.equal(final.status, ERROR);
    assert.equal(final.infrastructure.status, NOT_COLLECTED);
  });

  it("stops before the Runner when the preflight failed", () => {
    const preflight = {
      status: FAIL,
      checks: [{ name: "rds.instance_class", status: FAIL, message: "expected 'a', found 'b'" }],
    };
    const final = combine(snapshot, null, null, null, preflight);
    assert.equal(final.status, ERROR);
    assert.equal(final.stage, "preflight");
    assert.equal(final.runner.status, NOT_RUN);
    assert.equal(final.runner.exit_code, null);
    assert.ok(final.reasons.some((reason: string) => reason.includes("rds.instance_class")));
  });

  it("is an error for a build that timed out without results", () => {
    const final = run({ build: { status: "TIMED_OUT", build_id: "perf-runner:1" }, withResults: false });
    assert.equal(final.status, ERROR);
    assert.equal(final.build.status, "TIMED_OUT");
  });
});

describe("combine CLI", () => {
  function runCli(t: unknown, exitCode: number | null, resultStatus?: string) {
    const root = tempDirectory(t as never);
    mkdirSync(join(root, "results"));
    writeFileSync(join(root, "snapshot.json"), JSON.stringify(makeSnapshot()), "utf-8");
    writeFileSync(join(root, "infra.json"), JSON.stringify(infra()), "utf-8");
    if (exitCode !== null) {
      writeFileSync(join(root, "results", "runner-exit-code"), String(exitCode), "utf-8");
    }
    if (resultStatus) {
      writeFileSync(join(root, "results", "result.json"), JSON.stringify(runnerResult(resultStatus)), "utf-8");
    }
    return main([
      "--snapshot", join(root, "snapshot.json"),
      "--result-dir", join(root, "results"),
      "--infrastructure", join(root, "infra.json"),
      "--output", join(root, "final.json"),
      "--summary", join(root, "summary.md"),
    ]).then((code) => ({
      code,
      final: JSON.parse(readFileSync(join(root, "final.json"), "utf-8")) as Dict,
      summary: readFileSync(join(root, "summary.md"), "utf-8"),
    }));
  }

  it("follows the verdict in its exit codes", async (t) => {
    assert.equal((await runCli(t, 0, "PASS")).code, 0);
    assert.equal((await runCli(t, 1, "FAIL")).code, 1);
    assert.equal((await runCli(t, 2)).code, 2);
    assert.equal((await runCli(t, null)).code, 2);
  });

  it("names the verdict and the tuple in the summary", async (t) => {
    const { final, summary } = await runCli(t, 1, "FAIL");
    assert.equal(final.status, FAIL);
    assert.ok(summary.includes("(4, 5, 20)"));
    assert.ok(summary.includes("**FAIL**"));
    assert.ok(summary.includes("Reasons"));
  });
});
