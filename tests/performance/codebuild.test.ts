import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { main, MAX_CONSECUTIVE_POLL_FAILURES, startBuild, stopBuild, waitForBuild } from "../../scripts/performance/codebuild.ts";
import type { WaitHooks } from "../../scripts/performance/codebuild.ts";
import type { Dict } from "../../scripts/performance/common.ts";
import { clientError, FakeBuildLogs, FakeCodeBuild, FakeServiceError, makeClients, networkError, transientError } from "./fakes.ts";
import { tempDirectory } from "./helpers.ts";

const ENV: Record<string, string> = {
  BACKEND_COMMIT: "0".repeat(40),
  API_URL: "http://api",
  TARGET_URL: "http://target",
  TARGET_MODEL: "model",
  TARGET_REVISION: "rev",
  SCENARIO_PATH: "performance/scenarios/smoke.yaml",
  DATASET_PATH: "performance/datasets/base.yaml",
  RESULT_S3_PREFIX: "s3://bucket/performance/results/run/",
};

function sdk(codebuild: FakeCodeBuild) {
  return codebuild as never;
}

/** Hooks with a constant clock, recorded sleeps and captured output. */
function hooks(overrides: Partial<WaitHooks> = {}): { hooks: WaitHooks; sleeps: number[]; printed: string[] } {
  const sleeps: number[] = [];
  const printed: string[] = [];
  return {
    hooks: {
      sleep: async (seconds) => {
        sleeps.push(seconds);
      },
      monotonic: () => 0,
      print: (line) => printed.push(line),
      ...overrides,
    },
    sleeps,
    printed,
  };
}

describe("codebuild", () => {
  it("passes every value as an override", async () => {
    const fake = new FakeCodeBuild(["IN_PROGRESS"]);
    const started = await startBuild(sdk(fake), "perf-runner", ENV);
    assert.equal(started.build_id, "perf-runner:1");
    const sent = Object.fromEntries(fake.started[0].env.map((item) => [item.name, item.value]));
    assert.deepEqual(sent, ENV);
    assert.ok(fake.started[0].env.every((item) => item.type === "PLAINTEXT"));
  });

  for (const name of ["BACKEND_COMMIT", "API_URL", "RESULT_S3_PREFIX"]) {
    it(`rejects a missing required value: ${name}`, async () => {
      const env = { ...ENV, [name]: "" };
      await assert.rejects(startBuild(sdk(new FakeCodeBuild(["IN_PROGRESS"])), "p", env), new RegExp(name));
    });
  }

  it("treats the target revision as optional", async () => {
    const env = { ...ENV };
    delete env.TARGET_REVISION;
    await startBuild(sdk(new FakeCodeBuild(["IN_PROGRESS"])), "p", env);
  });

  it("polls until a terminal state and prints the logs", async () => {
    const fake = new FakeCodeBuild(["IN_PROGRESS", "IN_PROGRESS", "SUCCEEDED"]);
    const { hooks: waitHooks, sleeps, printed } = hooks();
    const summary = await waitForBuild(
      makeClients({ codebuild: fake, logs: new FakeBuildLogs(["hello from build"]) }),
      "perf-runner:1",
      600,
      5,
      waitHooks,
    );
    assert.equal(summary.status, "SUCCEEDED");
    assert.deepEqual(sleeps, [5, 5]);
    assert.ok(printed.join("\n").includes("hello from build"));
    assert.equal(summary.wait_timed_out, false);
  });

  it("reports a failed build instead of raising", async () => {
    const summary = await waitForBuild(
      makeClients({ codebuild: new FakeCodeBuild(["FAILED"]), logs: new FakeBuildLogs() }),
      "perf-runner:1",
      600,
      5,
      hooks().hooks,
    );
    assert.equal(summary.status, "FAILED");
    assert.equal(summary.build_id, "perf-runner:1");
  });

  it("keeps waiting when the logs are missing", async () => {
    const logs = new FakeBuildLogs([], clientError("ResourceNotFoundException", "no stream"));
    const summary = await waitForBuild(
      makeClients({ codebuild: new FakeCodeBuild(["SUCCEEDED"]), logs }),
      "perf-runner:1",
      600,
      5,
      hooks().hooks,
    );
    assert.equal(summary.status, "SUCCEEDED");
  });

  it("stops the build on timeout", async () => {
    const fake = new FakeCodeBuild(["IN_PROGRESS"]);
    const clock = [0, 10, 20, 30, 40][Symbol.iterator]();
    const summary = await waitForBuild(
      makeClients({ codebuild: fake, logs: new FakeBuildLogs() }),
      "perf-runner:1",
      15,
      5,
      hooks({ monotonic: () => clock.next().value as number }).hooks,
    );
    assert.equal(summary.wait_timed_out, true);
    assert.deepEqual(fake.stopped, ["perf-runner:1"]);
  });

  describe("polling failures", () => {
    const wait = (fake: FakeCodeBuild, waitHooks: WaitHooks, timeout = 600) =>
      waitForBuild(makeClients({ codebuild: fake, logs: new FakeBuildLogs() }), "perf-runner:1", timeout, 5, waitHooks);

    it("recovers after a transient error and waits one poll interval", async () => {
      const fake = new FakeCodeBuild(["SUCCEEDED"]);
      fake.failures = [transientError()];
      const { hooks: waitHooks, sleeps } = hooks();
      const summary = await wait(fake, waitHooks);
      assert.equal(summary.status, "SUCCEEDED");
      assert.deepEqual(sleeps, [5]);
    });

    it("tolerates the allowed number of consecutive failures", async () => {
      const fake = new FakeCodeBuild(["SUCCEEDED"]);
      fake.failures = Array.from({ length: MAX_CONSECUTIVE_POLL_FAILURES }, () => transientError());
      assert.equal((await wait(fake, hooks().hooks)).status, "SUCCEEDED");
    });

    it("fails when the consecutive failures exceed the limit", async () => {
      const fake = new FakeCodeBuild(["SUCCEEDED"]);
      fake.failures = Array.from({ length: MAX_CONSECUTIVE_POLL_FAILURES + 1 }, (_, index) => transientError(`failure ${index + 1}`));
      await assert.rejects(wait(fake, hooks().hooks), /failure 6/);
      assert.equal(fake.polls, 0);
    });

    it("resets the counter after a successful poll", async () => {
      const fake = new FakeCodeBuild(["IN_PROGRESS", "IN_PROGRESS", "SUCCEEDED"]);
      const burst = () => Array.from({ length: MAX_CONSECUTIVE_POLL_FAILURES }, () => transientError());
      fake.failures = [...burst(), null, ...burst(), null, ...burst()];
      assert.equal((await wait(fake, hooks().hooks)).status, "SUCCEEDED");
      assert.equal(fake.failures.length, 0);
    });

    const retryable: [string, () => Error][] = [
      ["throttling", () => clientError("ThrottlingException", "Rate exceeded")],
      ["a 5xx response", () => new FakeServiceError("InternalFailure", "oops", { status: 500 })],
      ["a 429 response", () => new FakeServiceError("SomethingElse", "slow down", { status: 429 })],
      ["an error the SDK marks as retryable", () => new FakeServiceError("Odd", "odd", { retryable: true })],
      ["a connection reset", () => networkError("ECONNRESET")],
      ["a timeout", () => networkError("ETIMEDOUT")],
      ["a timeout error name", () => Object.assign(new Error("timed out"), { name: "TimeoutError" })],
      ["a network error in the cause", () => new Error("fetch failed", { cause: networkError("ECONNRESET") })],
    ];
    for (const [label, make] of retryable) {
      it(`retries ${label}`, async () => {
        const fake = new FakeCodeBuild(["SUCCEEDED"]);
        fake.failures = [make()];
        assert.equal((await wait(fake, hooks().hooks)).status, "SUCCEEDED");
      });
    }

    const permanent: [string, () => Error][] = [
      ["AccessDeniedException", () => clientError("AccessDeniedException", "not allowed")],
      ["AccessDenied with a 5xx status", () => new FakeServiceError("AccessDenied", "denied", { status: 500 })],
      ["ValidationException", () => clientError("ValidationException", "bad id")],
      ["InvalidInputException", () => clientError("InvalidInputException", "bad input")],
      ["ResourceNotFoundException", () => clientError("ResourceNotFoundException", "gone")],
      ["an unrecognized error", () => new Error("something odd")],
    ];
    for (const [label, make] of permanent) {
      it(`fails at once on ${label}`, async () => {
        const fake = new FakeCodeBuild(["SUCCEEDED"]);
        const error = make();
        fake.failures = [error, null];
        const { hooks: waitHooks, sleeps } = hooks();
        await assert.rejects(wait(fake, waitHooks), (thrown) => thrown === error);
        assert.deepEqual(sleeps, []);
        assert.equal(fake.failures.length, 1, "no second poll");
      });
    }

    it("fails at once when the build does not exist", async () => {
      const fake = new FakeCodeBuild(["SUCCEEDED"]);
      fake.send = async () => ({ builds: [] });
      const { hooks: waitHooks, sleeps } = hooks();
      await assert.rejects(wait(fake, waitHooks), /not found/);
      assert.deepEqual(sleeps, []);
    });

    it("keeps the overall deadline while retrying", async () => {
      const fake = new FakeCodeBuild(["IN_PROGRESS"]);
      fake.failures = [null, transientError(), null];
      const clock = [0, 10, 20, 30, 40, 50][Symbol.iterator]();
      const summary = await wait(fake, hooks({ monotonic: () => clock.next().value as number }).hooks, 15);
      assert.equal(summary.wait_timed_out, true);
      assert.equal(summary.status, "IN_PROGRESS");
      assert.deepEqual(fake.stopped, ["perf-runner:1"]);
    });

    it("throws the polling error when the deadline passes before any build was seen", async () => {
      const fake = new FakeCodeBuild(["IN_PROGRESS"]);
      fake.failures = [transientError("first"), null];
      const clock = [0, 100][Symbol.iterator]();
      await assert.rejects(wait(fake, hooks({ monotonic: () => clock.next().value as number }).hooks, 15), /first/);
    });
  });

  it("does not stop a finished build", async () => {
    const fake = new FakeCodeBuild(["SUCCEEDED"]);
    assert.equal(await stopBuild(sdk(fake), "perf-runner:1"), "SUCCEEDED");
    assert.deepEqual(fake.stopped, []);
  });

  it("requests a stop for a running build", async () => {
    const fake = new FakeCodeBuild(["IN_PROGRESS"]);
    assert.equal(await stopBuild(sdk(fake), "perf-runner:1"), "STOP_REQUESTED");
    assert.deepEqual(fake.stopped, ["perf-runner:1"]);
  });

  it("runs start, wait and stop through the CLI", async (t) => {
    const clients = makeClients({ codebuild: new FakeCodeBuild(["SUCCEEDED"]), logs: new FakeBuildLogs() });
    const root = tempDirectory(t);
    writeFileSync(join(root, "env.json"), JSON.stringify(ENV), "utf-8");
    const { hooks: waitHooks } = hooks();
    const start = ["start", "--project", "perf-runner", "--env-file", join(root, "env.json"), "--output", join(root, "start.json")];
    assert.equal(await main(start, clients, waitHooks), 0);
    const wait = ["wait", "--start-file", join(root, "start.json"), "--output", join(root, "build.json"), "--poll-seconds", "0"];
    assert.equal(await main(wait, clients, waitHooks), 0);
    assert.equal((JSON.parse(readFileSync(join(root, "build.json"), "utf-8")) as Dict).status, "SUCCEEDED");
    assert.equal(await main(["stop", "--start-file", join(root, "start.json")], clients, waitHooks), 0);
  });

  it("rejects an incomplete environment through the CLI", async (t) => {
    const clients = makeClients({ codebuild: new FakeCodeBuild(["IN_PROGRESS"]) });
    const root = tempDirectory(t);
    writeFileSync(join(root, "env.json"), JSON.stringify({ API_URL: "x" }), "utf-8");
    const code = await main(
      ["start", "--project", "p", "--env-file", join(root, "env.json"), "--output", join(root, "o.json")],
      clients,
    );
    assert.equal(code, 2);
  });
});
