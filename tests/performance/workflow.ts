// The performance experiment workflow as data: parsing, condition evaluation and a small step
// runner. The contract test checks the workflow file with it, and the Floci harness runs the
// workflow's steps through it, so both follow the conditions written in the file itself.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";

export const WORKFLOW_PATH = resolve(import.meta.dirname, "../../.github/workflows/performance-experiment.yml");

export interface WorkflowStep {
  name: string;
  id?: string;
  if?: string;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

export interface Workflow {
  jobs: { experiment: { "timeout-minutes": number; steps: WorkflowStep[] } };
  [key: string]: unknown;
}

export function loadWorkflow(path = WORKFLOW_PATH): Workflow {
  return parse(readFileSync(path, "utf-8")) as Workflow;
}

export function workflowSteps(workflow: Workflow): WorkflowStep[] {
  return workflow.jobs.experiment.steps;
}

export type Outcome = "success" | "failure" | "cancelled" | "skipped";

/** What the conditions can see: the outcome and outputs of the steps that have been evaluated. */
export class RunState {
  readonly outcomes = new Map<string, Outcome>();
  readonly outputs = new Map<string, Record<string, string>>();
  /** A step failed (and was not allowed to continue on error) or the run was cancelled. */
  failed = false;
  cancelled = false;

  outcome(id: string): Outcome | undefined {
    return this.outcomes.get(id);
  }
}

const STATUS_FUNCTIONS = ["always()", "success()", "failure()", "cancelled()"];

/**
 * Evaluate a step `if`. Only the forms the workflow uses are understood: terms joined by `&&`,
 * each a status function or an equality of a step outcome or output with a quoted string.
 * Anything else throws, so a new kind of condition cannot slip past the tests unnoticed.
 * Like GitHub, a condition without a status function also requires the job to be successful.
 */
export function evaluateIf(expression: string | undefined, state: RunState): boolean {
  if (expression === undefined) {
    return !state.failed && !state.cancelled;
  }
  const terms = expression.split("&&").map((term) => term.trim());
  const hasStatusFunction = terms.some((term) => STATUS_FUNCTIONS.includes(term));
  let result = hasStatusFunction || (!state.failed && !state.cancelled);
  for (const term of terms) {
    result = result && evaluateTerm(term, state);
  }
  return result;
}

function evaluateTerm(term: string, state: RunState): boolean {
  switch (term) {
    case "always()":
      return true;
    case "success()":
      return !state.failed && !state.cancelled;
    case "failure()":
      return state.failed;
    case "cancelled()":
      return state.cancelled;
  }
  const outcome = /^steps\.([a-z_]+)\.outcome == '([a-z]+)'$/.exec(term);
  if (outcome) {
    return state.outcome(outcome[1]) === outcome[2];
  }
  const output = /^steps\.([a-z_]+)\.outputs\.([a-z_]+) == '([a-z]+)'$/.exec(term);
  if (output) {
    return state.outputs.get(output[1])?.[output[2]] === output[3];
  }
  throw new Error(`unsupported condition term: ${term} (in an if expression)`);
}

/** Steps that need GitHub or real AWS; the Floci harness skips them. */
export const NOT_SIMULATED_STEPS: ReadonlySet<string> = new Set([
  "Require the dev branch",
  "Check out this repository",
  "Validate inputs and prepare the work directory",
  "Set up Node.js",
  "Install script dependencies",
  "Set up Terraform",
  "Configure AWS credentials",
  "Refresh AWS credentials for cleanup",
  "Show the summary",
  "Upload the experiment files",
]);

/** What a step action returns: `ok: false` is a failed step, like a non-zero exit code. */
export interface ActionResult {
  ok: boolean;
  outputs?: Record<string, string>;
}
export type Action = (state: RunState) => Promise<ActionResult>;

export interface StepReport {
  name: string;
  id?: string;
  ran: boolean;
  outcome: Outcome;
  conclusion: Outcome;
}

export interface StepError {
  step: string;
  error: unknown;
}

export interface RunReport {
  steps: StepReport[];
  errors: StepError[];
}

/**
 * Run the workflow's steps in order. Each step is either an action of the caller, or listed as
 * not simulated (it needs GitHub or real AWS). A step that has neither is an error before
 * anything runs, so a workflow change cannot go unnoticed. An action that throws is a failed
 * step: the later steps still follow their conditions, as they do in the workflow, and the
 * thrown errors are collected in order.
 */
export async function runWorkflow(
  workflow: Workflow,
  actions: Readonly<Record<string, Action>>,
  notSimulated: ReadonlySet<string>,
): Promise<RunReport> {
  const steps = workflowSteps(workflow);
  const names = new Set(steps.map((step) => step.name));
  for (const step of steps) {
    if (!(step.name in actions) && !notSimulated.has(step.name)) {
      throw new Error(`workflow step "${step.name}" has no action and is not listed as not simulated`);
    }
    if (notSimulated.has(step.name) && step.id !== undefined) {
      throw new Error(`workflow step "${step.name}" has an id, so later conditions may depend on it; it cannot be skipped`);
    }
  }
  for (const name of [...Object.keys(actions), ...notSimulated]) {
    if (!names.has(name)) {
      throw new Error(`"${name}" is not a step of the workflow`);
    }
  }

  const state = new RunState();
  const report: RunReport = { steps: [], errors: [] };
  for (const step of steps) {
    if (notSimulated.has(step.name)) {
      continue;
    }
    let outcome: Outcome = "skipped";
    let ran = false;
    if (evaluateIf(step.if, state)) {
      ran = true;
      try {
        const result = await actions[step.name](state);
        outcome = result.ok ? "success" : "failure";
        if (step.id !== undefined && result.outputs) {
          state.outputs.set(step.id, result.outputs);
        }
      } catch (error) {
        outcome = "failure";
        report.errors.push({ step: step.name, error });
      }
    }
    const conclusion: Outcome = outcome === "failure" && step["continue-on-error"] === true ? "success" : outcome;
    if (conclusion === "failure") {
      state.failed = true;
    }
    if (step.id !== undefined) {
      state.outcomes.set(step.id, outcome);
    }
    report.steps.push({ name: step.name, id: step.id, ran, outcome, conclusion });
  }
  return report;
}

/** Why a run failed: the first failing step's error comes first, later failures are appended. */
export class RunFailure extends Error {
  override name = "RunFailure";
  readonly errors: readonly StepError[];

  constructor(errors: readonly StepError[]) {
    const [first, ...later] = errors;
    const lines = [`${first.step}: ${describe(first.error)}`];
    if (later.length > 0) {
      lines.push("Later failures, which do not replace the one above:");
      lines.push(...later.map((item) => `- ${item.step}: ${describe(item.error)}`));
    }
    super(lines.join("\n"), { cause: first.error });
    this.errors = errors;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Throw a RunFailure when a step threw an error; the original error stays its cause. */
export function throwIfFailed(report: RunReport): void {
  if (report.errors.length > 0) {
    throw new RunFailure(report.errors);
  }
}
