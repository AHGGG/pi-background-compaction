import assert from "node:assert/strict";
import { test } from "vitest";
import { readPreparationDiagnostics } from "../src/preparation-diagnostics.js";
import type { CheckpointPreparation } from "../src/prepared-compaction-protocol.js";

test("diagnostic snapshots are bounded and terminal-safe while preserving report lines", () => {
  const snapshot = readPreparationDiagnostics({
    diagnostics: () => ({
      status: `elapsed=5s\u001b[31m\u202e${"a".repeat(1000)}`,
      report: `first\r\nsecond\u0007\u202e\n${"x".repeat(20_000)}`,
      warning: `still waiting\n${"b".repeat(1000)}`,
    }),
  } as CheckpointPreparation);
  assert.ok(snapshot);
  assert.ok(snapshot.status.length <= 320);
  assert.ok(snapshot.report.length <= 16_384);
  assert.ok((snapshot.warning?.length ?? 0) <= 512);
  assert.match(snapshot.report, /^first\nsecond\n/);
  assert.doesNotMatch(JSON.stringify(snapshot), /\\u001b|\\u0007|\u202e/);
});

test("old, malformed, and throwing diagnostics never expose exceptions or break jobs", () => {
  assert.equal(readPreparationDiagnostics({} as CheckpointPreparation), undefined);
  for (const value of [undefined, null, {}, { status: 1, report: "safe" }, { status: "safe", report: {} }])
    assert.equal(
      readPreparationDiagnostics({ diagnostics: () => value } as unknown as CheckpointPreparation),
      undefined,
    );
  assert.equal(
    readPreparationDiagnostics({
      diagnostics() {
        throw new Error("PRIVATE-CREDENTIAL");
      },
    } as CheckpointPreparation),
    undefined,
  );
});
