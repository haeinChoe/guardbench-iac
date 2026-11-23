// Last step of the experiment workflow: decide whether the whole run passed.
//
// The run passes only when the infrastructure was applied, the final verdict is PASS, and the
// experiment layer was destroyed and verified gone. Anything else, including a missing or
// unreadable final.json and a step that was skipped or cancelled, fails the run.
// Exit code: 0 passed, 1 did not pass (2 for a command line the script cannot use).

import { existsSync, readFileSync } from "node:fs";

import { PASS, isObject, parseCli, requiredString, withUsageErrors } from "./common.ts";

export const MISSING = "missing";
export const UNREADABLE = "unreadable";
const SUCCESS = "success";

export interface GateInput {
  apply: string;
  destroy: string;
  verify: string;
  /** Path of final.json; the file may not exist. */
  final: string;
}

export interface GateResult {
  passed: boolean;
  verdict: string;
  /** What each stage reported, in one line. */
  line: string;
  /** Why the run did not pass; empty when it passed. */
  failures: string[];
}

/** The `status` of final.json, or `missing` / `unreadable` when there is no usable verdict. */
export function readVerdict(path: string): string {
  if (!existsSync(path)) {
    return MISSING;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return UNREADABLE;
  }
  return isObject(parsed) && typeof parsed.status === "string" && parsed.status !== "" ? parsed.status : MISSING;
}

export function evaluate(input: GateInput): GateResult {
  const verdict = readVerdict(input.final);
  const failures: string[] = [];
  if (input.apply !== SUCCESS) {
    failures.push(`terraform apply: ${input.apply || "no outcome"}`);
  }
  if (verdict !== PASS) {
    failures.push(`verdict: ${verdict}`);
  }
  if (input.destroy !== SUCCESS) {
    failures.push(`terraform destroy: ${input.destroy || "no outcome"}`);
  }
  if (input.verify !== SUCCESS) {
    failures.push(`destroy verification: ${input.verify || "no outcome"}`);
  }
  return {
    passed: failures.length === 0,
    verdict,
    line: `apply=${input.apply} verdict=${verdict} destroy=${input.destroy} verify=${input.verify}`,
    failures,
  };
}

export async function main(argv: string[]): Promise<number> {
  return withUsageErrors(async () => {
    const args = parseCli(argv, {
      "apply-outcome": requiredString,
      "destroy-outcome": requiredString,
      "verify-outcome": requiredString,
      final: requiredString,
    });
    const result = evaluate({
      apply: args["apply-outcome"],
      destroy: args["destroy-outcome"],
      verify: args["verify-outcome"],
      final: args.final,
    });
    console.log(result.line);
    if (!result.passed) {
      console.log(`::error::The experiment did not pass: ${result.line} (${result.failures.join("; ")})`);
      return 1;
    }
    console.log("The experiment passed.");
    return 0;
  });
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
