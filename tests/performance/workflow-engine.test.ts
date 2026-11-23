// The condition evaluator and step runner that the contract test and the Floci harness share,
// run against the real workflow with fake step actions.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateIf, loadWorkflow, NOT_SIMULATED_STEPS as NOT_SIMULATED, RunFailure, runWorkflow, RunState, throwIfFailed, workflowSteps } from "./workflow.ts";
import type { Action, RunReport, Workflow } from "./workflow.ts";

const OK = { ok: true };
const FAILED = { ok: false };

/** Every simulated step succeeds unless `results` says otherwise; records what ran. */
function fakeActions(
  workflow: Workflow,
  results: Record<string, Action | { ok: boolean }> = {},
): { actions: Record<string, Action>; ran: string[] } {
  const ran: string[] = [];
  const actions: Record<string, Action> = {};
  for (const step of workflowSteps(workflow)) {
    if (NOT_SIMULATED.has(step.name)) {
      continue;
    }
    actions[step.name] = async (state) => {
      ran.push(step.name);
      const result = results[step.name] ?? OK;
      if (typeof result === "function") {
        return result(state);
      }
      return step.name === "Mark apply attempted" ? { ok: true, outputs: { attempted: "true" } } : result;
    };
  }
  return { actions, ran };
}

describe("evaluateIf", () => {
  const state = (init: { outcomes?: Record<string, "success" | "failure" | "skipped">; failed?: boolean; attempted?: boolean } = {}) => {
    const result = new RunState();
    for (const [id, outcome] of Object.entries(init.outcomes ?? {})) {
      result.outcomes.set(id, outcome);
    }
    if (init.attempted) {
      result.outputs.set("apply_marker", { attempted: "true" });
    }
    result.failed = init.failed ?? false;
    return result;
  };

  it("runs a step without a condition only while the job is successful", () => {
    assert.equal(evaluateIf(undefined, state()), true);
    assert.equal(evaluateIf(undefined, state({ failed: true })), false);
  });

  it("runs always() regardless of earlier failures", () => {
    assert.equal(evaluateIf("always()", state({ failed: true })), true);
    assert.equal(evaluateIf("always()", state()), true);
  });

  it("needs a successful job for a condition without a status function", () => {
    const expression = "steps.preflight.outcome == 'success'";
    assert.equal(evaluateIf(expression, state({ outcomes: { preflight: "success" } })), true);
    assert.equal(evaluateIf(expression, state({ outcomes: { preflight: "success" }, failed: true })), false);
    assert.equal(evaluateIf(expression, state({ outcomes: { preflight: "failure" } })), false);
    assert.equal(evaluateIf(expression, state()), false);
  });

  it("joins terms with &&", () => {
    const expression = "always() && steps.apply_marker.outputs.attempted == 'true'";
    assert.equal(evaluateIf(expression, state({ attempted: true, failed: true })), true);
    assert.equal(evaluateIf(expression, state({ failed: true })), false);
  });

  it("supports success() and failure()", () => {
    assert.equal(evaluateIf("failure()", state({ failed: true })), true);
    assert.equal(evaluateIf("failure()", state()), false);
    assert.equal(evaluateIf("success()", state()), true);
  });

  it("rejects expressions it does not understand", () => {
    for (const expression of ["always() || failure()", "${{ always() }}", "steps.x.outcome != 'success'", "!cancelled()"]) {
      assert.throws(() => evaluateIf(expression, state()), /unsupported condition/, expression);
    }
  });
});

describe("runWorkflow with the performance experiment workflow", () => {
  const workflow = loadWorkflow();

  const run = async (results: Record<string, Action | { ok: boolean }> = {}): Promise<{ report: RunReport; ran: string[] }> => {
    const { actions, ran } = fakeActions(workflow, results);
    return { report: await runWorkflow(workflow, actions, NOT_SIMULATED), ran };
  };

  const cleanup = ["Terraform destroy", "Verify the experiment layer is gone"];
  const evidence = ["Combine the verdict", "Preserve the experiment record in the results bucket"];
  const buildSteps = [
    "Stop the Runner build if it is still running",
    "Download the Runner results",
    "Collect infrastructure evidence",
  ];

  it("runs every simulated step when everything succeeds", async () => {
    const { report, ran } = await run();
    assert.equal(ran.length, Object.keys(fakeActions(workflow).actions).length);
    assert.deepEqual(report.errors, []);
    assert.equal(ran[ran.length - 1], "Fail unless the experiment passed");
  });

  it("keeps the order of the workflow", async () => {
    const { ran } = await run();
    const order = workflowSteps(workflow).map((step) => step.name).filter((name) => ran.includes(name));
    assert.deepEqual(ran, order);
  });

  it("still destroys, verifies and decides when the apply fails, and skips the rest", async () => {
    const { ran } = await run({ "Terraform apply": FAILED });
    for (const name of [...cleanup, "Fail unless the experiment passed"]) {
      assert.ok(ran.includes(name), name);
    }
    for (const name of ["Export the infrastructure snapshot", "Preflight check", "Start the Runner build", ...evidence, ...buildSteps]) {
      assert.ok(!ran.includes(name), `${name} must not run`);
    }
  });

  it("does not destroy when init fails before the apply was attempted", async () => {
    const { ran } = await run({ "Terraform init": FAILED });
    assert.ok(!ran.includes("Mark apply attempted"));
    for (const name of cleanup) {
      assert.ok(!ran.includes(name), `${name} must not run`);
    }
    assert.ok(ran.includes("Fail unless the experiment passed"));
  });

  it("keeps the evidence and the cleanup when the preflight fails, and does not start a build", async () => {
    const { ran, report } = await run({ "Preflight check": FAILED });
    assert.ok(!ran.includes("Prepare the Runner build environment"));
    assert.ok(!ran.includes("Start the Runner build"));
    for (const name of [...evidence, ...cleanup]) {
      assert.ok(ran.includes(name), name);
    }
    const preflight = report.steps.find((step) => step.name === "Preflight check");
    assert.deepEqual([preflight?.outcome, preflight?.conclusion], ["failure", "success"]);
  });

  it("keeps the build handling, the evidence and the cleanup when the wait fails", async () => {
    const { ran } = await run({ "Wait for the Runner build": FAILED });
    for (const name of [...buildSteps, ...evidence, ...cleanup]) {
      assert.ok(ran.includes(name), name);
    }
  });

  it("keeps the evidence and the cleanup when the build could not be started", async () => {
    const { ran } = await run({ "Start the Runner build": FAILED });
    assert.ok(!ran.includes("Wait for the Runner build"));
    for (const name of buildSteps) {
      assert.ok(!ran.includes(name), `${name} must not run`);
    }
    for (const name of [...evidence, ...cleanup]) {
      assert.ok(ran.includes(name), name);
    }
  });

  it("verifies the destroy even when the destroy fails", async () => {
    const { ran } = await run({ "Terraform destroy": FAILED });
    assert.ok(ran.includes("Verify the experiment layer is gone"));
    assert.ok(ran.includes("Fail unless the experiment passed"));
  });

  it("lets a failing combine verdict step continue", async () => {
    const { ran, report } = await run({ "Combine the verdict": FAILED });
    assert.ok(ran.includes("Preserve the experiment record in the results bucket"));
    assert.equal(report.steps.find((step) => step.name === "Combine the verdict")?.conclusion, "success");
  });

  it("collects errors thrown by actions in order and keeps running the cleanup", async () => {
    const first = new Error("terraform apply broke");
    const second = new Error("destroy broke");
    const { ran, report } = await run({
      "Terraform apply": async () => {
        throw first;
      },
      "Terraform destroy": async () => {
        throw second;
      },
    });
    assert.deepEqual(report.errors.map((item) => [item.step, item.error]), [
      ["Terraform apply", first],
      ["Terraform destroy", second],
    ]);
    assert.ok(ran.includes("Verify the experiment layer is gone"));
  });

  it("refuses a step that has no action and is not listed as not simulated", async () => {
    const { actions } = fakeActions(workflow);
    delete actions["Terraform apply"];
    await assert.rejects(runWorkflow(workflow, actions, NOT_SIMULATED), /Terraform apply/);
  });

  it("refuses an action for a step the workflow does not have", async () => {
    const { actions } = fakeActions(workflow);
    actions["A step that was renamed"] = async () => OK;
    await assert.rejects(runWorkflow(workflow, actions, NOT_SIMULATED), /not a step of the workflow/);
  });

  it("refuses to skip a step that later conditions can refer to", async () => {
    const { actions } = fakeActions(workflow);
    delete actions["Terraform apply"];
    await assert.rejects(runWorkflow(workflow, actions, new Set([...NOT_SIMULATED, "Terraform apply"])), /has an id/);
  });
});

describe("RunFailure", () => {
  const workflow = loadWorkflow();
  const failing = (errors: Record<string, Error>) =>
    Object.fromEntries(
      Object.entries(errors).map(([step, error]) => [
        step,
        async (): Promise<never> => {
          throw error;
        },
      ]),
    );

  it("throws the original error first and appends a failing destroy", async () => {
    const original = new Error("terraform apply failed: quota exceeded");
    const destroyFailure = new Error("destroy timed out");
    const { actions } = fakeActions(workflow, failing({ "Terraform apply": original, "Terraform destroy": destroyFailure }));
    const report = await runWorkflow(workflow, actions, NOT_SIMULATED);
    assert.throws(
      () => throwIfFailed(report),
      (thrown: unknown) => {
        assert.ok(thrown instanceof RunFailure);
        assert.equal(thrown.cause, original);
        const lines = thrown.message.split("\n");
        assert.equal(lines[0], "Terraform apply: terraform apply failed: quota exceeded");
        assert.ok(thrown.message.includes("- Terraform destroy: destroy timed out"));
        assert.equal(thrown.errors.length, 2);
        return true;
      },
    );
  });

  it("reports a destroy error when nothing failed before it", async () => {
    const destroyFailure = new Error("destroy timed out");
    const { actions } = fakeActions(workflow, failing({ "Terraform destroy": destroyFailure }));
    const report = await runWorkflow(workflow, actions, NOT_SIMULATED);
    assert.throws(
      () => throwIfFailed(report),
      (thrown: unknown) => thrown instanceof RunFailure && thrown.cause === destroyFailure,
    );
  });

  it("keeps the original error when the verification fails after a failing destroy", async () => {
    const original = new Error("snapshot could not be read");
    const { actions } = fakeActions(
      workflow,
      failing({
        "Export the infrastructure snapshot": original,
        "Terraform destroy": new Error("destroy failed"),
        "Verify the experiment layer is gone": new Error("verification failed"),
      }),
    );
    const report = await runWorkflow(workflow, actions, NOT_SIMULATED);
    assert.throws(
      () => throwIfFailed(report),
      (thrown: unknown) => thrown instanceof RunFailure && thrown.cause === original && thrown.errors.length === 3,
    );
  });

  it("does not throw when no step threw", async () => {
    const { actions } = fakeActions(workflow, { "Terraform destroy": FAILED });
    throwIfFailed(await runWorkflow(workflow, actions, NOT_SIMULATED));
  });
});
