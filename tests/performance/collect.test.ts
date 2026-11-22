import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { collect, main, resolveWindow } from "../../scripts/performance/collect.ts";
import type { TimeHooks } from "../../scripts/performance/collect.ts";
import { ERROR, FAIL, PASS } from "../../scripts/performance/common.ts";
import type { Clients, Dict } from "../../scripts/performance/common.ts";
import { clientError, healthyClients, makeSnapshot } from "./fakes.ts";
import type { Fakes } from "./fakes.ts";
import { byName, notPassing, tempDirectory } from "./helpers.ts";

const START = new Date(Date.UTC(2026, 10, 22, 1, 0));
const END = new Date(Date.UTC(2026, 10, 22, 1, 10));
const NO_WAIT: TimeHooks = { sleep: async () => {}, monotonic: () => 0 };

describe("collect", () => {
  let snapshot: Dict;
  let clients: Clients;
  let fakes: Fakes;

  beforeEach(() => {
    snapshot = makeSnapshot();
    ({ clients, fakes } = healthyClients(snapshot));
  });

  // The drain timeout is measured on the injected clock: 0 means "no waiting", otherwise it
  // ticks one second per reading.
  const run = (drainTimeout = 0) => {
    let now = 0;
    const hooks: TimeHooks = drainTimeout === 0 ? NO_WAIT : { sleep: async () => {}, monotonic: () => now++ };
    return collect(snapshot, clients, START, END, drainTimeout, 0, hooks);
  };

  it("passes with drained queues and clean dead letters", async () => {
    const { infrastructure, logSample } = await run();
    assert.equal(infrastructure.status, PASS, JSON.stringify(notPassing(infrastructure)));
    assert.deepEqual(logSample, []);
    assert.ok("queue_drain.workitems" in byName(infrastructure as { checks: never[] }));
  });

  it("fails when a queue does not drain", async () => {
    fakes.sqs.depths[snapshot.resources.sqs.source_queue_urls.workitems] = [5, 0, 0];
    const { infrastructure } = await run();
    assert.equal(infrastructure.status, FAIL);
    assert.equal(byName(infrastructure as { checks: never[] })["queue_drain.workitems"].status, FAIL);
  });

  it("passes when a queue drains within the timeout", async () => {
    fakes.sqs.depths[snapshot.resources.sqs.source_queue_urls.workitems] = [5, 0, 0];
    fakes.sqs.drainAfterCalls = 3;
    const { infrastructure } = await run(60);
    assert.equal(infrastructure.status, PASS);
    assert.ok(fakes.sqs.calls > 3);
  });

  it("fails on a dead letter message", async () => {
    fakes.sqs.depths[snapshot.resources.sqs.dlq_urls.finalize] = [1, 0, 0];
    const { infrastructure } = await run();
    assert.equal(infrastructure.status, FAIL);
    assert.equal(byName(infrastructure as { checks: never[] })["dlq_empty.finalize"].status, FAIL);
  });

  it("treats a queue lookup failure as an error", async () => {
    fakes.sqs.errors[snapshot.resources.sqs.dlq_urls.resolve] = clientError("AccessDenied", "denied");
    assert.equal((await run()).infrastructure.status, ERROR);
  });

  it("treats a metric lookup failure as an error", async () => {
    fakes.cloudwatch.error = clientError("AccessDenied", "denied");
    const { infrastructure } = await run();
    assert.equal(infrastructure.status, ERROR);
    assert.equal(byName(infrastructure as { checks: never[] })["metrics.collection"].status, ERROR);
  });

  it("summarizes metrics without judging them", async () => {
    fakes.cloudwatch.values = {
      "ecs.api.CPUUtilization.Average": [10, 30],
      "rds.CPUUtilization.Maximum": [12, 80],
      "sagemaker.Invocations.Sum": [3, 4],
    };
    const { infrastructure } = await run();
    const metrics = infrastructure.metrics;
    assert.deepEqual(metrics["ecs.api.CPUUtilization.Average"], { datapoints: 2, value: 20 });
    assert.equal(metrics["rds.CPUUtilization.Maximum"].value, 80);
    assert.equal(metrics["sagemaker.Invocations.Sum"].value, 7);
    assert.equal(metrics["ecs.worker.CPUUtilization.Average"].value, null);
    assert.equal(infrastructure.status, PASS);
  });

  it("counts and samples the log events inside the window", async () => {
    const inside = START.getTime() + 1000;
    const outside = END.getTime() + 60_000;
    fakes.logs.events = {
      "/ecs/perf/app": [
        { timestamp: inside, message: "INFO started\n" },
        { timestamp: inside + 1, message: "ERROR TestRun 12 failed" },
        { timestamp: outside, message: "ERROR after the window" },
      ],
      "/ecs/perf/demo": [{ timestamp: inside, message: "INFO ok" }],
    };
    const { infrastructure, logSample } = await run();
    assert.deepEqual(infrastructure.logs["/ecs/perf/app"], { events: 2, error_events: 1 });
    assert.deepEqual(infrastructure.logs["/ecs/perf/demo"], { events: 1, error_events: 0 });
    assert.equal(logSample.length, 3);
    assert.equal(infrastructure.status, PASS);
  });

  it("treats a log lookup failure as an error", async () => {
    fakes.logs.errorGroups["/ecs/perf/demo"] = clientError("ResourceNotFoundException", "no group");
    assert.equal((await run()).infrastructure.status, ERROR);
  });

  it("writes the evidence and the log sample through the CLI", async (t) => {
    const root = tempDirectory(t);
    writeFileSync(join(root, "snapshot.json"), JSON.stringify(snapshot), "utf-8");
    const code = await main(
      [
        "--snapshot", join(root, "snapshot.json"),
        "--start", "2026-11-22T01:00:00Z",
        "--end", "2026-11-22T01:10:00Z",
        "--output", join(root, "infra.json"),
        "--logs-output", join(root, "logs.json"),
        "--drain-timeout-seconds", "0",
      ],
      clients,
    );
    assert.equal(code, 0);
    assert.equal(JSON.parse(readFileSync(join(root, "infra.json"), "utf-8")).status, PASS);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "logs.json"), "utf-8")), []);
  });

  it("prefers explicit window values, then the Runner result, then the build", (t) => {
    const root = tempDirectory(t);
    writeFileSync(
      join(root, "result.json"),
      JSON.stringify({ started_at: "2026-11-22T01:00:10Z", finished_at: "2026-11-22T01:03:10Z" }),
      "utf-8",
    );
    const build = { start_time: "2026-11-22T00:50:00Z", end_time: "2026-11-22T01:05:00Z" };
    const explicit = resolveWindow("2026-11-22T02:00:00Z", "2026-11-22T02:10:00Z", root, build);
    assert.equal(explicit[0].getUTCHours(), 2);
    const fromResult = resolveWindow(undefined, undefined, root, build);
    assert.deepEqual([fromResult[0].getUTCMinutes(), fromResult[1].getUTCMinutes()], [0, 3]);
    const empty = join(root, "empty");
    mkdirSync(empty);
    const fromBuild = resolveWindow(undefined, undefined, empty, build);
    assert.deepEqual([fromBuild[0].getUTCMinutes(), fromBuild[1].getUTCMinutes()], [50, 5]);
    assert.throws(() => resolveWindow(undefined, undefined, undefined, null));
  });

  it("still writes an ERROR result when the CLI fails", async (t) => {
    const root = tempDirectory(t);
    const code = await main(
      [
        "--snapshot", join(root, "missing.json"),
        "--start", "2026-11-22T01:00:00Z",
        "--end", "2026-11-22T01:10:00Z",
        "--output", join(root, "infra.json"),
        "--logs-output", join(root, "logs.json"),
      ],
      clients,
    );
    assert.equal(code, 2);
    assert.equal(JSON.parse(readFileSync(join(root, "infra.json"), "utf-8")).status, ERROR);
  });
});
