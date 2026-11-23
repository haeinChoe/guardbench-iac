import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { ERROR, FAIL, PASS } from "../../scripts/performance/common.ts";
import type { Clients, Dict } from "../../scripts/performance/common.ts";
import { verify } from "../../scripts/performance/verify_destroyed.ts";
import { clientError, healthyClients, makeSnapshot } from "./fakes.ts";
import type { Fakes } from "./fakes.ts";
import { notPassing } from "./helpers.ts";

describe("verify_destroyed", () => {
  let snapshot: Dict;
  let clients: Clients;
  let fakes: Fakes;

  beforeEach(() => {
    snapshot = makeSnapshot();
    ({ clients, fakes } = healthyClients(snapshot));
    // After destroy: services inactive, task definitions inactive, SageMaker gone, no log groups.
    for (const service of Object.values(fakes.ecs.services)) {
      service.status = "INACTIVE";
    }
    for (const definition of Object.values(fakes.ecs.definitions)) {
      definition.status = "INACTIVE";
    }
    fakes.sagemaker.exists = false;
  });

  const run = (state: string[] = [], current: Dict | null = snapshot) => verify(state, current, clients);

  it("passes for a clean account", async () => {
    const result = await run();
    assert.equal(result.status, PASS, JSON.stringify(notPassing(result)));
  });

  it("fails when state remains", async () => {
    assert.equal((await run(["aws_ecs_service.performance_app"])).status, FAIL);
  });

  it("fails for an active service", async () => {
    fakes.ecs.services["perf-app"].status = "ACTIVE";
    assert.equal((await run()).status, FAIL);
  });

  it("fails for a draining service", async () => {
    fakes.ecs.services["perf-worker"].status = "DRAINING";
    assert.equal((await run()).status, FAIL);
  });

  it("counts a missing service as gone", async () => {
    delete fakes.ecs.services["perf-demo"];
    assert.equal((await run()).status, PASS);
  });

  it("fails for an active task definition", async () => {
    fakes.ecs.definitions[snapshot.resources.ecs.api.task_definition_arn].status = "ACTIVE";
    assert.equal((await run()).status, FAIL);
  });

  it("counts a deleted task definition as gone", async () => {
    delete fakes.ecs.definitions[snapshot.resources.ecs.api.task_definition_arn];
    assert.equal((await run()).status, PASS);
  });

  it("fails for an existing endpoint", async () => {
    fakes.sagemaker.exists = true;
    assert.equal((await run()).status, FAIL);
  });

  it("fails for a remaining log group", async () => {
    fakes.logs.existingGroups = new Set(["/ecs/perf/demo"]);
    assert.equal((await run()).status, FAIL);
  });

  it("does not treat an unexpected lookup error as gone", async () => {
    fakes.ecs.failDescribeServices = clientError("AccessDeniedException", "denied");
    assert.equal((await run()).status, ERROR);
  });

  it("checks only the state without a snapshot", async () => {
    assert.equal((await run([], null)).status, PASS);
    assert.equal((await run(["x"], null)).status, FAIL);
  });
});
