import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ERROR, FAIL, PASS } from "../../scripts/performance/common.ts";
import { evaluate, main, MISSING, readVerdict, UNREADABLE } from "../../scripts/performance/gate.ts";
import { captureStdout, tempDirectory } from "./helpers.ts";

const OUTCOMES = ["success", "failure", "cancelled", "skipped"];
const VERDICTS = [PASS, FAIL, ERROR, MISSING, UNREADABLE];

/** Write a final.json for a verdict (or none / an unreadable one) and return its path. */
function finalFile(root: string, verdict: string): string {
  const path = join(root, "final.json");
  if (verdict === UNREADABLE) {
    writeFileSync(path, "{not json", "utf-8");
  } else if (verdict !== MISSING) {
    writeFileSync(path, JSON.stringify({ status: verdict }), "utf-8");
  }
  return path;
}

describe("gate", () => {
  it("passes only for success everywhere and a PASS verdict, in every combination", (t) => {
    let combinations = 0;
    for (const verdict of VERDICTS) {
      const final = finalFile(tempDirectory(t), verdict);
      for (const apply of OUTCOMES) {
        for (const destroy of OUTCOMES) {
          for (const verify of OUTCOMES) {
            const result = evaluate({ apply, destroy, verify, final });
            const expected = apply === "success" && destroy === "success" && verify === "success" && verdict === PASS;
            assert.equal(result.passed, expected, result.line);
            assert.equal(result.failures.length === 0, expected, result.line);
            combinations += 1;
          }
        }
      }
    }
    assert.equal(combinations, VERDICTS.length * OUTCOMES.length ** 3);
  });

  it("reads the verdict from final.json", (t) => {
    for (const verdict of [PASS, FAIL, ERROR]) {
      assert.equal(readVerdict(finalFile(tempDirectory(t), verdict)), verdict);
    }
  });

  it("reports a missing final.json", (t) => {
    assert.equal(readVerdict(join(tempDirectory(t), "final.json")), MISSING);
  });

  it("reports an unreadable final.json", (t) => {
    assert.equal(readVerdict(finalFile(tempDirectory(t), UNREADABLE)), UNREADABLE);
  });

  it("reports a final.json without a status", (t) => {
    const path = join(tempDirectory(t), "final.json");
    for (const content of ["{}", "[]", '{"status": null}', '{"status": 3}', '{"status": ""}']) {
      writeFileSync(path, content, "utf-8");
      assert.equal(readVerdict(path), MISSING, content);
    }
  });

  it("names every stage that did not pass", (t) => {
    const final = finalFile(tempDirectory(t), FAIL);
    const result = evaluate({ apply: "success", destroy: "failure", verify: "skipped", final });
    assert.equal(result.line, "apply=success verdict=FAIL destroy=failure verify=skipped");
    assert.equal(result.failures.length, 3);
  });

  it("does not pass without an outcome", (t) => {
    const result = evaluate({ apply: "", destroy: "success", verify: "success", final: finalFile(tempDirectory(t), PASS) });
    assert.equal(result.passed, false);
    assert.ok(result.failures[0].includes("no outcome"));
  });
});

describe("gate CLI", () => {
  const argv = (final: string, apply = "success", destroy = "success", verify = "success") => [
    "--apply-outcome", apply,
    "--destroy-outcome", destroy,
    "--verify-outcome", verify,
    "--final", final,
  ];

  it("exits 0 and logs the stages when the run passed", async (t) => {
    const final = finalFile(tempDirectory(t), PASS);
    let code = -1;
    const output = await captureStdout(async () => {
      code = await main(argv(final));
    });
    assert.equal(code, 0);
    assert.ok(output.includes("apply=success verdict=PASS destroy=success verify=success"));
    assert.ok(!output.includes("::error::"));
  });

  it("exits 1 with an error annotation when the verdict is not PASS", async (t) => {
    for (const verdict of [FAIL, ERROR, MISSING, UNREADABLE]) {
      const final = finalFile(tempDirectory(t), verdict);
      let code = -1;
      const output = await captureStdout(async () => {
        code = await main(argv(final));
      });
      assert.equal(code, 1, verdict);
      assert.ok(output.includes("::error::The experiment did not pass"), verdict);
    }
  });

  it("exits 1 when a step did not succeed", async (t) => {
    const final = finalFile(tempDirectory(t), PASS);
    for (const outcome of ["failure", "cancelled", "skipped"]) {
      for (const args of [argv(final, outcome), argv(final, "success", outcome), argv(final, "success", "success", outcome)]) {
        let code = -1;
        await captureStdout(async () => {
          code = await main(args);
        });
        assert.equal(code, 1, args.join(" "));
      }
    }
  });

  it("exits 2 for a command line it cannot use", async () => {
    let code = -1;
    await captureStdout(async () => {
      code = await main(["--apply-outcome", "success"]);
    });
    assert.equal(code, 2);
  });
});
