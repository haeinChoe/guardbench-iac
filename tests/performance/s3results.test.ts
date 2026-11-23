import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { downloadPrefix, parseS3Prefix, uploadDirectory } from "../../scripts/performance/s3results.ts";
import { FakeS3 } from "./fakes.ts";
import { tempDirectory } from "./helpers.ts";

const sdk = (fake: FakeS3) => fake as never;

describe("s3results", () => {
  it("requires a bucket and a prefix", () => {
    assert.deepEqual(parseS3Prefix("s3://b/a/b"), ["b", "a/b/"]);
    for (const bad of ["http://b/a", "s3://b", "s3://b/", "s3:///a"]) {
      assert.throws(() => parseS3Prefix(bad), Error, bad);
    }
  });

  it("keeps the relative layout on download", async (t) => {
    const s3 = new FakeS3({ "p/run/result.json": "{}", "p/run/runner-exit-code": "0\n", "p/other/x": "no" });
    const directory = tempDirectory(t);
    const files = await downloadPrefix(sdk(s3), "s3://b/p/run/", directory);
    assert.deepEqual(files, ["result.json", "runner-exit-code"]);
    assert.equal(readFileSync(join(directory, "runner-exit-code"), "utf-8"), "0\n");
  });

  it("rejects keys that escape the destination", async (t) => {
    const s3 = new FakeS3({ "p/run/../../escape": "x" });
    await assert.rejects(downloadPrefix(sdk(s3), "s3://b/p/run/", tempDirectory(t)), /outside the destination/);
  });

  it("returns nothing for an empty prefix", async (t) => {
    assert.deepEqual(await downloadPrefix(sdk(new FakeS3()), "s3://b/p/run/", tempDirectory(t)), []);
  });

  it("preserves relative names on upload", async (t) => {
    const s3 = new FakeS3();
    const root = tempDirectory(t);
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "final.json"), "a", "utf-8");
    writeFileSync(join(root, "sub", "summary.md"), "b", "utf-8");
    const files = await uploadDirectory(sdk(s3), root, "s3://b/p/run/");
    assert.deepEqual(files, ["final.json", "sub/summary.md"]);
    assert.deepEqual([...s3.uploads.keys()].sort(), ["b/p/run/final.json", "b/p/run/sub/summary.md"]);
  });
});
