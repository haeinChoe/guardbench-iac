// Pipeline test: the entrypoint's steps against Floci, for Runner 0 / 1 / 2 and a failed preflight.
//
// Needs Docker and Terraform. Run explicitly: FLOCI_PIPELINE=1 node --test tests/floci/pipeline.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Environment, EXPERIMENT_POLICIES, MANAGED_POLICY_LIMIT, PRESET } from "./harness.ts";
import type { PipelineResult } from "./harness.ts";

const skip = process.env.FLOCI_PIPELINE === "1" ? false : "set FLOCI_PIPELINE=1 to run the Floci pipeline test (needs Docker)";
const TIMEOUT = 20 * 60 * 1000;

describe("Floci pipeline", { skip }, () => {
  let environment: Environment;

  before(
    async () => {
      const artifacts = process.env.FLOCI_TEST_ARTIFACTS || mkdtempSync(join(tmpdir(), "floci-iac-artifacts-"));
      environment = new Environment(artifacts);
      try {
        await environment.start();
      } catch (error) {
        environment.stop();
        throw error;
      }
      console.log(`Floci pipeline test artifacts: ${artifacts}`);
    },
    { timeout: TIMEOUT },
  );

  after(() => {
    environment?.stop();
  });

  async function runScenario(name: string, scenario: string, options: { seedQueueMessage?: boolean } = {}) {
    const result = await (environment.pipeline as NonNullable<Environment["pipeline"]>).execute(name, scenario, options);
    if (result.snapshot) {
      await environment.purgeSourceQueues(result.snapshot);
    }
    return result;
  }

  async function assertDestroyed(result: PipelineResult) {
    assert.equal(result.steps.destroy, 0, "terraform destroy");
    assert.equal(result.steps.verify_destroy, 0, JSON.stringify(result.destroyVerification));
    assert.equal(result.destroyVerification?.status, "PASS");
    assert.deepEqual(await environment.experimentResourcesLeft(), []);
  }

  function runnerExitCode(result: PipelineResult): string {
    return readFileSync(join(result.expDir, "results", "runner-exit-code"), "utf-8").trim();
  }

  async function recordedKeys(result: PipelineResult): Promise<Set<string>> {
    const runner = result.snapshot?.resources.runner;
    const prefix = `performance/results/${PRESET}/${result.name}/experiment/`;
    return new Set(await environment.listKeys(runner.results_bucket_name, prefix));
  }

  function assertHas(keys: Set<string>, expected: string[]) {
    for (const key of expected) {
      assert.ok(keys.has(key), `${key} was not recorded (recorded: ${[...keys].join(", ")})`);
    }
  }

  it("0: the experiment policies fit the managed policy size limit", () => {
    const sizes = environment.policySizes();
    console.log(`managed policy sizes without whitespace: ${JSON.stringify(sizes)}`);
    assert.deepEqual(Object.keys(sizes).sort(), [...EXPERIMENT_POLICIES].sort());
    for (const [name, size] of Object.entries(sizes)) {
      assert.ok(size <= MANAGED_POLICY_LIMIT, `${name} is ${size} characters, over ${MANAGED_POLICY_LIMIT}`);
    }
  });

  it("1: Runner PASS", { timeout: TIMEOUT }, async () => {
    const result = await runScenario("pass", "pass");
    assert.equal(result.steps.preflight, 0, JSON.stringify(result.preflight));
    assert.equal(result.build?.status, "SUCCEEDED");
    assert.ok(result.runnerFiles.includes("result.json"));
    assert.equal(runnerExitCode(result), "0");
    assert.equal(result.final?.status, "PASS", JSON.stringify(result.final));
    assert.deepEqual(result.final?.tuple, { W: 1, C: 2, T: 2 });
    assert.equal(result.final?.infrastructure.status, "PASS");
    assert.equal(result.steps.combine, 0);
    assert.equal(result.steps.gate, 0, "the run passes only when the verdict is PASS and destroy was verified");
    assertHas(await recordedKeys(result), ["final.json", "summary.md", "snapshot.json"]);
    await assertDestroyed(result);
  });

  it("2: measurement FAIL", { timeout: TIMEOUT }, async () => {
    const result = await runScenario("fail", "fail");
    assert.equal(result.build?.status, "FAILED");
    assert.equal(runnerExitCode(result), "1");
    assert.ok(result.runnerFiles.includes("result.json"));
    assert.equal(result.final?.status, "FAIL", JSON.stringify(result.final));
    assert.equal(result.final?.runner.status, "FAIL");
    assert.deepEqual(result.final?.tuple, { W: 1, C: 2, T: 2 });
    assert.equal(result.steps.combine, 1);
    assert.equal(result.steps.gate, 1, "a measurement FAIL fails the run");
    assertHas(await recordedKeys(result), ["final.json", "summary.md"]);
    await assertDestroyed(result);
  });

  it("3: Runner error", { timeout: TIMEOUT }, async () => {
    const result = await runScenario("error", "error");
    assert.equal(result.build?.status, "FAILED");
    assert.equal(runnerExitCode(result), "2");
    assert.ok(result.runnerFiles.includes("failure.json"));
    assert.ok(!result.runnerFiles.includes("result.json"));
    assert.equal(result.final?.status, "ERROR", JSON.stringify(result.final));
    assert.equal(result.final?.runner.failure.phase, "report");
    assert.equal(result.steps.combine, 2);
    assert.equal(result.steps.gate, 1, "a Runner error fails the run");
    assertHas(await recordedKeys(result), ["final.json", "summary.md"]);
    await assertDestroyed(result);
  });

  it("4: a failed preflight stops before the Runner", { timeout: TIMEOUT }, async () => {
    const buildsBefore = await environment.runnerBuildCount();
    const result = await runScenario("preflight", "pass", { seedQueueMessage: true });
    assert.equal(result.steps.preflight, 1);
    assert.equal(result.preflight?.status, "FAIL");
    const failed = (result.preflight?.checks as { name: string; status: string }[])
      .filter((item) => item.status !== "PASS")
      .map((item) => item.name);
    assert.deepEqual(failed, ["sqs.source.gb-workitems"]);
    assert.ok(!("start_build" in result.steps));
    assert.ok(!("collect" in result.steps), "no evidence is collected without a build");
    assert.equal(await environment.runnerBuildCount(), buildsBefore, "no Runner build may start");
    assert.equal(result.final?.status, "ERROR");
    assert.equal(result.final?.stage, "preflight");
    assert.equal(result.final?.runner.status, "NOT_RUN");
    assert.equal(result.steps.gate, 1, "a failed preflight fails the run");
    assertHas(await recordedKeys(result), ["final.json", "preflight.json"]);
    await assertDestroyed(result);
  });
});
