import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { startBackgroundJob } from "../src/background-job.js";
import type {
  ApplicationGuard,
  CheckpointPreparation,
  PreparedCheckpoint,
} from "../src/prepared-compaction-protocol.js";
import { type BackgroundCompactionSettingsRuntime, DEFAULT_BACKGROUND_COMPACTION_SETTINGS } from "../src/settings.js";

function fixture(timeout = 1000) {
  let resolve!: (value: PreparedCheckpoint) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<PreparedCheckpoint>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const owner = new AbortController();
  const run = new AbortController();
  let snapshotCurrent = true;
  let ownerCurrent = true;
  let guard!: ApplicationGuard & { deadlineSignal?: AbortSignal; ownsStatus(): boolean };
  const settings = { ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS, asyncEnabled: true };
  const runtime = { get: () => ({ settings }) } as BackgroundCompactionSettingsRuntime;
  const preparation: CheckpointPreparation = {
    requestTimeoutMs: timeout,
    reason: "system prompt changed",
    isCurrent: () => snapshotCurrent,
    start(value) {
      guard = value;
      return promise;
    },
  };
  const handle = { usable: true } as PreparedCheckpoint;
  const ctx = { signal: run.signal } as ExtensionContext;
  const start = () => startBackgroundJob(preparation, ctx, runtime, owner.signal, () => ownerCurrent);
  return {
    owner,
    run,
    settings,
    preparation,
    handle,
    resolve,
    reject,
    start,
    get guard() {
      return guard;
    },
    invalidateSnapshot: () => {
      snapshotCurrent = false;
    },
    invalidateOwner: () => {
      ownerCurrent = false;
    },
  };
}

test("preparation is nonblocking and completed work survives run abort", async () => {
  const h = fixture();
  const job = h.start();
  assert.equal(job.state, "Preparing");
  assert.equal(h.guard.ownsStatus(), false);
  h.resolve(h.handle);
  assert.equal(await job.promise, h.handle);
  assert.equal(job.state, "Ready");
  h.run.abort();
  assert.equal(job.isCurrent(), true);
  assert.equal(job.controller.signal.aborted, false);
  h.owner.abort();
  assert.equal(job.isCurrent(), false);
});

for (const action of ["run", "owner", "controller"] as const)
  test(`${action} abort bounds a provider that ignores ownership cancellation`, async () => {
    const h = fixture();
    const job = h.start();
    const result = assert.rejects(job.promise);
    if (action === "controller") job.controller.abort();
    else h[action].abort();
    await result;
    assert.equal(job.state, "Failed");
    assert.equal(job.isCurrent(), false);
  });

for (const kind of ["owner", "snapshot", "settings"] as const)
  test(`${kind} invalidation rejects a completed candidate`, async () => {
    const h = fixture();
    const job = h.start();
    h.resolve(h.handle);
    await job.promise;
    if (kind === "owner") h.invalidateOwner();
    if (kind === "snapshot") h.invalidateSnapshot();
    if (kind === "settings") h.settings.asyncThresholdPercent = 75;
    assert.equal(job.isCurrent(), false);
    if (kind === "snapshot") assert.equal(job.validationFailure, "system prompt changed");
  });

test("logging and auto-apply changes preserve manually reusable work", async () => {
  const h = fixture();
  const job = h.start();
  h.resolve(h.handle);
  await job.promise;
  h.settings.logCompaction = true;
  h.settings.asyncAutoApply = true;
  assert.equal(job.isCurrent(), true);
});

test("failed prepared handle survives for engine retry-budget handoff", async () => {
  const h = fixture();
  const job = h.start();
  const failed = { usable: false, failure: "background preparation failed" } as PreparedCheckpoint;
  h.resolve(failed);
  assert.equal(await job.promise, failed);
  assert.equal(job.state, "Failed");
  assert.equal(job.isCurrent(), true);
  assert.equal(job.applicationFailure, "background preparation failed");
});

test("deadline is separate from ownership and preserves failure metadata", async () => {
  const h = fixture(1);
  h.preparation.start = (guard) =>
    new Promise((resolve) => {
      guard.deadlineSignal?.addEventListener(
        "abort",
        () => {
          assert.equal(guard.signal.aborted, false);
          assert.equal(guard.isCurrent(), true);
          resolve({ usable: false, failure: "request timed out" } as PreparedCheckpoint);
        },
        { once: true },
      );
    });
  const job = h.start();
  const result = await job.promise;
  assert.equal(result.failure, "request timed out");
  assert.equal(job.isCurrent(), true);
});

test("rejected preparation marks failure without retaining raw error in diagnostics", async () => {
  const h = fixture();
  const job = h.start();
  const result = assert.rejects(job.promise);
  h.reject(new Error("PRIVATE-CREDENTIAL"));
  await result;
  assert.equal(job.applicationFailure, "background preparation failed");
  assert.equal(job.state, "Failed");
});
