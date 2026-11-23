// Contract of the performance experiment workflow: the conditions that make cleanup, evidence
// and the final decision run when an earlier step fails or the run is cancelled. A workflow edit
// that weakens one of them fails here.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadWorkflow, workflowSteps } from "./workflow.ts";
import type { Workflow, WorkflowStep } from "./workflow.ts";

const STEP_NAMES = [
  "Require the dev branch",
  "Check out this repository",
  "Validate inputs and prepare the work directory",
  "Set up Node.js",
  "Install script dependencies",
  "Set up Terraform",
  "Configure AWS credentials",
  "Terraform init",
  "Mark apply attempted",
  "Terraform apply",
  "Export the infrastructure snapshot",
  "Preflight check",
  "Prepare the Runner build environment",
  "Start the Runner build",
  "Wait for the Runner build",
  "Refresh AWS credentials for cleanup",
  "Stop the Runner build if it is still running",
  "Download the Runner results",
  "Collect infrastructure evidence",
  "Combine the verdict",
  "Show the summary",
  "Preserve the experiment record in the results bucket",
  "Terraform destroy",
  "Verify the experiment layer is gone",
  "Upload the experiment files",
  "Fail unless the experiment passed",
];

const APPLY_ATTEMPTED = "steps.apply_marker.outputs.attempted == 'true'";
const SNAPSHOT_SUCCEEDED = "steps.snapshot.outcome == 'success'";
const BUILD_STARTED = "steps.start_build.outcome == 'success'";

describe("performance experiment workflow", () => {
  const workflow: Workflow = loadWorkflow();
  const steps = workflowSteps(workflow);

  const step = (name: string): WorkflowStep => {
    const found = steps.find((item) => item.name === name);
    assert.ok(found, `step "${name}" does not exist`);
    return found;
  };
  const indexOf = (name: string): number => steps.findIndex((item) => item.name === name);

  it("keeps the step names and their order", () => {
    assert.deepEqual(steps.map((item) => item.name), STEP_NAMES);
  });

  it("has unique step ids", () => {
    const ids = steps.flatMap((item) => (item.id === undefined ? [] : [item.id]));
    assert.equal(new Set(ids).size, ids.length);
  });

  describe("cleanup", () => {
    it("destroys whenever an apply was attempted, even after a failure or a cancellation", () => {
      assert.equal(step("Terraform destroy").if, `always() && ${APPLY_ATTEMPTED}`);
    });

    it("verifies the destroy under the same condition", () => {
      assert.equal(step("Verify the experiment layer is gone").if, `always() && ${APPLY_ATTEMPTED}`);
    });

    it("marks the apply as attempted before it applies and after init", () => {
      assert.ok(indexOf("Terraform init") < indexOf("Mark apply attempted"));
      assert.ok(indexOf("Mark apply attempted") < indexOf("Terraform apply"));
      assert.equal(step("Mark apply attempted").id, "apply_marker");
      assert.match(step("Mark apply attempted").run ?? "", /attempted=true/);
    });

    it("refreshes the credentials for cleanup before anything that stops or destroys", () => {
      const refresh = step("Refresh AWS credentials for cleanup");
      assert.equal(refresh["continue-on-error"], true);
      assert.ok(refresh.if?.includes("always()"), refresh.if);
      assert.ok(refresh.if?.includes(APPLY_ATTEMPTED), refresh.if);
      assert.ok(indexOf(refresh.name) > indexOf("Wait for the Runner build"));
      for (const later of [
        "Stop the Runner build if it is still running",
        "Download the Runner results",
        "Collect infrastructure evidence",
        "Preserve the experiment record in the results bucket",
        "Terraform destroy",
        "Verify the experiment layer is gone",
      ]) {
        assert.ok(indexOf(refresh.name) < indexOf(later), `refresh must come before "${later}"`);
      }
    });

    it("stops the build, downloads and collects whenever a build was started", () => {
      for (const name of [
        "Stop the Runner build if it is still running",
        "Download the Runner results",
        "Collect infrastructure evidence",
      ]) {
        assert.equal(step(name).if, `always() && ${BUILD_STARTED}`, name);
      }
    });
  });

  describe("evidence", () => {
    it("lets preflight fail without failing the job", () => {
      assert.equal(step("Preflight check")["continue-on-error"], true);
      assert.equal(step("Preflight check").id, "preflight");
    });

    it("starts the build only after a passing preflight", () => {
      assert.equal(step("Prepare the Runner build environment").if, "steps.preflight.outcome == 'success'");
      assert.equal(step("Start the Runner build").if, "steps.build_env.outcome == 'success'");
      assert.equal(step("Wait for the Runner build").if, "steps.start_build.outcome == 'success'");
    });

    it("combines, summarizes and preserves the record whenever the snapshot was exported", () => {
      for (const name of ["Combine the verdict", "Show the summary", "Preserve the experiment record in the results bucket"]) {
        assert.equal(step(name).if, `always() && ${SNAPSHOT_SUCCEEDED}`, name);
      }
    });

    it("does not let a combine verdict fail the job before cleanup", () => {
      assert.equal(step("Combine the verdict")["continue-on-error"], true);
    });

    it("preserves the record before it destroys", () => {
      assert.ok(indexOf("Preserve the experiment record in the results bucket") < indexOf("Terraform destroy"));
      assert.ok(indexOf("Combine the verdict") < indexOf("Preserve the experiment record in the results bucket"));
    });

    it("uploads the experiment files whatever happened, with a short retention", () => {
      const upload = step("Upload the experiment files");
      assert.equal(upload.if, "always()");
      assert.equal(upload.with?.["retention-days"], 7);
    });
  });

  describe("final decision", () => {
    it("is the last step, runs always and calls gate.ts", () => {
      const last = steps[steps.length - 1];
      assert.equal(last.name, "Fail unless the experiment passed");
      assert.equal(last.if, "always()");
      assert.match(last.run ?? "", /node scripts\/performance\/gate\.ts/);
    });

    it("hands gate.ts the outcomes of apply, destroy and the destroy verification", () => {
      const last = steps[steps.length - 1];
      assert.deepEqual(last.env, {
        APPLY_OUTCOME: "${{ steps.apply.outcome }}",
        DESTROY_OUTCOME: "${{ steps.destroy.outcome }}",
        VERIFY_OUTCOME: "${{ steps.verify_destroy.outcome }}",
      });
      for (const option of ["--apply-outcome", "--destroy-outcome", "--verify-outcome", "--final"]) {
        assert.ok((last.run ?? "").includes(option), option);
      }
    });
  });

  describe("time contract", () => {
    const job = workflow.jobs.experiment;
    const CODEBUILD_MAX_MINUTES = 480;
    const WAIT_MINUTES = 485;

    it("bounds the job and the long steps", () => {
      assert.equal(job["timeout-minutes"], 600);
      assert.equal(step("Terraform apply")["timeout-minutes"], 45);
      assert.equal(step("Terraform destroy")["timeout-minutes"], 40);
      assert.equal(step("Verify the experiment layer is gone")["timeout-minutes"], 5);
    });

    it("waits 485 minutes, longer than the longest CodeBuild timeout", () => {
      const wait = step("Wait for the Runner build");
      assert.match(wait.run ?? "", new RegExp(`--timeout-seconds ${WAIT_MINUTES * 60}\\b`));
      assert.ok(CODEBUILD_MAX_MINUTES < WAIT_MINUTES);
    });

    it("fits the wait and the bounded steps in the job with room for the rest", () => {
      const bounded = [45, 40, 5].reduce((sum, minutes) => sum + minutes, 0);
      const drain = 5;
      const settle = 3;
      assert.ok(WAIT_MINUTES + bounded + drain + settle < job["timeout-minutes"]);
    });

    it("gets the first credentials for the whole job and the cleanup credentials for two hours", () => {
      assert.equal(step("Configure AWS credentials").with?.["role-duration-seconds"], job["timeout-minutes"] * 60);
      assert.equal(step("Refresh AWS credentials for cleanup").with?.["role-duration-seconds"], 7200);
    });
  });
});
