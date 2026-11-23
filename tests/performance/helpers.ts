// Small helpers for the script unit tests.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import type { Check, Dict } from "../../scripts/performance/common.ts";

/** A temporary directory removed (by its explicit path) when the test ends. */
export function tempDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "perf-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function byName(result: { checks: Check[] }): Record<string, Check> {
  return Object.fromEntries(result.checks.map((item) => [item.name, item]));
}

export function notPassing(result: Dict): Dict[] {
  return (result.checks as Dict[]).filter((item) => item.status !== "PASS");
}

/** Capture what a function prints with console.log. */
export async function captureStdout(body: () => Promise<unknown>): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...parts: unknown[]) => {
    lines.push(parts.join(" "));
  };
  try {
    await body();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}
