import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { ERROR, FAIL, PASS } from "../../scripts/performance/common.ts";
import type { Clients, Dict } from "../../scripts/performance/common.ts";
import { evaluate, main } from "../../scripts/performance/preflight.ts";
import { clientError, healthyClients, makeSnapshot } from "./fakes.ts";
import type { Fakes } from "./fakes.ts";
import { byName, notPassing, tempDirectory } from "./helpers.ts";

describe("preflight", () => {
  let snapshot: Dict;
  let clients: Clients;
  let fakes: Fakes;

  beforeEach(() => {
    snapshot = makeSnapshot();
    ({ clients, fakes } = healthyClients(snapshot));
  });

  const run = () => evaluate(snapshot, clients);

  it("passes when the state matches", async () => {
    const result = await run();
    assert.equal(result.status, PASS, JSON.stringify(notPassing(result)));
    const names = byName(result);
    for (const expected of [
      "ecs.api.desired_count",
      "ecs.worker.work_items_concurrency",
      "rds.instance_class",
      "sagemaker.status",
      "sqs.source.workitems",
      "sqs.dlq.workitems",
    ]) {
      assert.ok(expected in names, expected);
    }
  });

  it("fails on an RDS class mismatch", async () => {
    fakes.rds.instanceClass = "db.m7g.large";
    const result = await run();
    assert.equal(result.status, FAIL);
    assert.equal(byName(result)["rds.instance_class"].status, FAIL);
  });

  it("fails when the API running count is below desired", async () => {
    fakes.ecs.services["perf-app"].runningCount = 1;
    const result = await run();
    assert.equal(result.status, FAIL);
    assert.equal(byName(result)["ecs.api.running_count"].status, FAIL);
  });

  it("fails on an unfinished rollout", async () => {
    fakes.ecs.services["perf-worker"].deployments = [
      { status: "PRIMARY", rolloutState: "IN_PROGRESS" },
      { status: "ACTIVE", rolloutState: "COMPLETED" },
    ];
    const result = await run();
    assert.equal(result.status, FAIL);
    assert.equal(byName(result)["ecs.worker.rollout"].status, FAIL);
  });

  it("fails on a task definition mismatch", async () => {
    fakes.ecs.services["perf-app"].taskDefinition = "arn:other:1";
    assert.equal(byName(await run())["ecs.api.task_definition"].status, FAIL);
  });

  it("fails on a task size mismatch", async () => {
    const arn = snapshot.resources.ecs.api.task_definition_arn;
    fakes.ecs.definitions[arn].cpu = "1024";
    assert.equal(byName(await run())["ecs.api.task_cpu"].status, FAIL);
  });

  it("fails on a worker concurrency mismatch", async () => {
    const arn = snapshot.resources.ecs.worker.task_definition_arn;
    fakes.ecs.definitions[arn].containerDefinitions[0].environment[0].value = "9";
    assert.equal(byName(await run())["ecs.worker.work_items_concurrency"].status, FAIL);
  });

  it("fails when SageMaker is not InService", async () => {
    fakes.sagemaker.status = "Creating";
    assert.equal(byName(await run())["sagemaker.status"].status, FAIL);
  });

  it("fails on a SageMaker instance count mismatch", async () => {
    fakes.sagemaker.instanceCount = 2;
    assert.equal(byName(await run())["sagemaker.instance_count"].status, FAIL);
  });

  it("fails when the SageMaker variant is missing", async () => {
    fakes.sagemaker.variantName = "Other";
    assert.equal(byName(await run())["sagemaker.variant"].status, FAIL);
  });

  it("fails on a SageMaker endpoint config mismatch", async () => {
    fakes.sagemaker.endpointConfig = "someone-elses-config";
    assert.equal(byName(await run())["sagemaker.endpoint_config"].status, FAIL);
  });

  it("fails on a SageMaker instance type mismatch", async () => {
    fakes.sagemaker.instanceType = "ml.g5.2xlarge";
    assert.equal(byName(await run())["sagemaker.instance_type"].status, FAIL);
  });

  it("treats a lookup failure as an error, not a pass", async () => {
    fakes.rds.error = clientError("AccessDenied", "denied");
    const result = await run();
    assert.equal(result.status, ERROR);
    assert.equal(byName(result)["rds.instance"].status, ERROR);
  });

  it("treats an ECS lookup failure as an error", async () => {
    fakes.ecs.failDescribeServices = new Error("timeout");
    assert.equal((await run()).status, ERROR);
  });

  it("fails when a service is missing", async () => {
    delete fakes.ecs.services["perf-demo"];
    assert.equal(byName(await run())["ecs.demo_ai.exists"].status, FAIL);
  });

  it("fails on a residual source queue message", async () => {
    fakes.sqs.depths[snapshot.resources.sqs.source_queue_urls.workitems] = [0, 2, 0];
    const result = await run();
    assert.equal(result.status, FAIL);
    assert.equal(byName(result)["sqs.source.workitems"].status, FAIL);
  });

  it("fails on a dead letter message", async () => {
    fakes.sqs.depths[snapshot.resources.sqs.dlq_urls.resolve] = [1, 0, 0];
    assert.equal(byName(await run())["sqs.dlq.resolve"].status, FAIL);
  });

  it("counts delayed messages as residual", async () => {
    fakes.sqs.depths[snapshot.resources.sqs.source_queue_urls.finalize] = [0, 0, 3];
    assert.equal(byName(await run())["sqs.source.finalize"].status, FAIL);
  });

  it("treats a queue lookup failure as an error", async () => {
    fakes.sqs.errors[snapshot.resources.sqs.source_queue_urls.resolve] = clientError("QueueDoesNotExist", "gone");
    assert.equal((await run()).status, ERROR);
  });

  it("treats an unsupported schema version as an error", async () => {
    snapshot.schema_version = 2;
    assert.equal((await run()).status, ERROR);
  });

  it("treats an incomplete snapshot as an error", async () => {
    const broken = structuredClone(snapshot);
    delete broken.resources.sqs;
    assert.equal((await evaluate(broken, clients)).status, ERROR);
  });
});

describe("preflight CLI", () => {
  it("writes the result and exits 1 on a failed check", async (t) => {
    const snapshot = makeSnapshot();
    const { clients, fakes } = healthyClients(snapshot);
    fakes.rds.instanceClass = "db.m7g.large";
    const directory = tempDirectory(t);
    const snapshotPath = join(directory, "snapshot.json");
    const outputPath = join(directory, "preflight.json");
    writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf-8");
    const code = await main(["--snapshot", snapshotPath, "--output", outputPath], clients);
    assert.equal(code, 1);
    assert.equal(JSON.parse(readFileSync(outputPath, "utf-8")).status, FAIL);
  });

  it("exits non-zero with an ERROR result for an unreadable snapshot", async (t) => {
    const directory = tempDirectory(t);
    const outputPath = join(directory, "preflight.json");
    const { clients } = healthyClients(makeSnapshot());
    const code = await main(["--snapshot", join(directory, "missing.json"), "--output", outputPath], clients);
    assert.equal(code, 1);
    assert.equal(JSON.parse(readFileSync(outputPath, "utf-8")).status, ERROR);
  });
});
