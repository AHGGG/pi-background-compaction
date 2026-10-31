import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
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
    assert.equal(job.state, "Cancelled");
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
  assert.equal(job.applicationFailure, "background preparation failed (engine returned no safe diagnostic)");
  assert.equal(job.state, "Failed");
});

test("failure records elapsed preparation time without extending the lifetime", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
  try {
    const h = fixture();
    const job = h.start();
    clock.mockReturnValue(3500);
    h.resolve({ usable: false, failure: "HTTP 429: rate limited" } as PreparedCheckpoint);
    await job.promise;
    assert.equal(job.elapsedMs, 2500);
    assert.equal(job.applicationFailure, "HTTP 429: rate limited");
    clock.mockReturnValue(9000);
    assert.equal(job.elapsedMs, 2500);
  } finally {
    clock.mockRestore();
  }
});

test("unexpected deadline rejection reports timeout without raw details", async () => {
  const h = fixture(1);
  h.preparation.start = (guard) =>
    new Promise((_resolve, reject) => {
      guard.deadlineSignal?.addEventListener("abort", () => reject(new Error("PRIVATE-CREDENTIAL")), { once: true });
    });
  const job = h.start();
  await assert.rejects(job.promise);
  assert.equal(job.applicationFailure, "request timed out");
  assert.equal(job.isCurrent(), true);
  assert.ok((job.elapsedMs ?? -1) >= 0);
});

test("the final safe diagnostic snapshot is captured and frozen when preparation settles", async () => {
  const h = fixture();
  let report = "attempt=1 elapsed=5s";
  h.preparation.diagnostics = () => ({ status: "Preparing", report });
  const job = h.start();
  assert.ok(job.refreshDiagnostics()?.report.endsWith(report));
  report = "attempt=1 body=eof\nattempt=2 body=eof";
  h.resolve({ usable: false, failure: "incomplete stream" } as PreparedCheckpoint);
  await job.promise;
  assert.ok(job.diagnostics?.report.endsWith(report));
  report = "MUTATED-AFTER-SETTLE";
  assert.ok(job.refreshDiagnostics()?.report.endsWith("attempt=1 body=eof\nattempt=2 body=eof"));
});

test("a throwing optional diagnostic getter cannot change preparation outcome", async () => {
  const h = fixture();
  h.preparation.diagnostics = () => {
    throw new Error("PRIVATE-CREDENTIAL");
  };
  const job = h.start();
  assert.equal(job.refreshDiagnostics(), undefined);
  h.resolve(h.handle);
  assert.equal(await job.promise, h.handle);
  assert.equal(job.state, "Ready");
});

test("progress checks never revalidate the potentially large engine snapshot", async () => {
  const h = fixture();
  let validations = 0;
  h.preparation.isCurrent = () => {
    validations++;
    return true;
  };
  const job = h.start();
  validations = 0; // Initial dispatch validates once; progress polling must remain cheap.
  assert.equal(job.isProgressCurrent(), true);
  assert.equal(job.isProgressCurrent(), true);
  assert.equal(validations, 0);
  h.settings.asyncThresholdPercent = 80;
  assert.equal(job.isProgressCurrent(), false);
  assert.equal(validations, 0);
  h.resolve(h.handle);
  await job.promise;
});

for (const outcome of ["discarded", "cancelled"] as const)
  test(`terminal ${outcome} is not a provider failure`, async () => {
    const h = fixture();
    h.preparation.diagnostics = () => ({ status: outcome, report: "final report", outcome, reason: "session changed" });
    const job = h.start();
    h.resolve({ usable: false, failure: "legacy generic failure" } as PreparedCheckpoint);
    await job.promise;
    assert.equal(job.state, outcome === "discarded" ? "Discarded" : "Cancelled");
    assert.equal(job.validationFailure, "session changed");
    assert.equal(job.applicationFailure, undefined);
    assert.equal(job.diagnosticsUnavailable, false);
  });

test("cancellation retains earlier diagnostics as non-final until the producer actually settles", async () => {
  const h = fixture();
  let report = "earlier progress";
  h.preparation.diagnostics = () => ({ status: "status", report });
  const job = h.start();
  job.refreshDiagnostics();
  job.validationFailure = "settings changed";
  job.controller.abort();
  await assert.rejects(job.promise);
  assert.equal(job.state, "Cancelled");
  assert.equal(job.diagnosticsUnavailable, true);
  assert.ok(job.diagnostics?.report.endsWith("earlier progress"));
  assert.equal(job.isCurrent(), false);
  assert.equal(job.validationFailure, "settings changed");
  report = "actual final cancellation";
  h.resolve({ usable: false } as PreparedCheckpoint);
  await Promise.resolve();
  assert.equal(job.diagnosticsUnavailable, false);
  assert.ok(job.diagnostics?.report.endsWith("actual final cancellation"));
  report = "changed after final";
  assert.ok(job.refreshDiagnostics()?.report.endsWith("actual final cancellation"));
});

test("retained records contain metadata only and receive the producer's later final diagnostics", async () => {
  const h = fixture();
  let report = "progress";
  h.preparation.diagnostics = () => ({ status: "status", report });
  const job = h.start();
  job.refreshDiagnostics();
  job.controller.abort();
  await assert.rejects(job.promise);
  const record = job.retain();
  assert.equal(record.state, "Cancelled");
  assert.equal("promise" in record, false);
  assert.equal("controller" in record, false);
  assert.equal(
    Object.values(record).some((value) => typeof value === "function"),
    false,
  );
  report = "terminal report";
  h.resolve({ usable: false } as PreparedCheckpoint);
  await Promise.resolve();
  assert.equal(record.diagnosticsUnavailable, false);
  assert.ok(record.diagnostics?.report.endsWith("terminal report"));
});

function retryFixture(retryCount = 1) {
  const h = fixture(60_000);
  h.settings.asyncRetryCount = retryCount;
  let starts = 0;
  let captures = 0;
  let current = true;
  const events: string[] = [];
  const results: PreparedCheckpoint[] = [];
  const candidate = (): CheckpointPreparation => ({
    requestTimeoutMs: 60_000,
    isCurrent: () => current,
    start: async () => {
      starts += 1;
      const result =
        results.shift() ?? ({ usable: false, retryable: true, failure: "transient" } as PreparedCheckpoint);
      return {
        ...result,
        retry: () => {
          captures += 1;
          return candidate();
        },
      };
    },
  });
  const start = () =>
    startBackgroundJob(
      candidate(),
      { signal: h.run.signal } as ExtensionContext,
      {
        get: () => ({ settings: h.settings }),
      } as BackgroundCompactionSettingsRuntime,
      h.owner.signal,
      () => true,
      {
        onRetry: (count, delay) => events.push(`wait ${count} ${delay}`),
        onAttempt: (count) => events.push(`start ${count}`),
      },
    );
  return {
    ...h,
    start,
    results,
    events,
    invalidate: () => {
      current = false;
    },
    get starts() {
      return starts;
    },
    get captures() {
      return captures;
    },
  };
}

test("configured two retries are sequential, bounded, and keep one promise until success", async () => {
  vi.useFakeTimers();
  try {
    const h = retryFixture(2);
    h.results.push(
      { usable: false, retryable: true } as PreparedCheckpoint,
      { usable: false, retryable: true } as PreparedCheckpoint,
      { usable: true } as PreparedCheckpoint,
    );
    const job = h.start();
    const promise = job.promise;
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(h.starts, 1);
    assert.equal(job.state, "Preparing");
    assert.equal(job.retryDelayMs, 5000);
    await vi.advanceTimersByTimeAsync(4999);
    assert.equal(h.starts, 1);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(h.starts, 2);
    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(h.starts, 3);
    assert.equal(await promise, await job.promise);
    assert.equal(job.state, "Ready");
    assert.equal(h.captures, 2);
    assert.deepEqual(h.events, ["wait 1 5000", "start 1", "wait 2 10000", "start 2"]);
    h.run.abort();
    assert.equal(job.isCurrent(), true);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

test("exhaustion and disabled retries return the final failed handle without further attempts", async () => {
  vi.useFakeTimers();
  try {
    for (const limit of [0, 1, 2]) {
      const h = retryFixture(limit);
      const job = h.start();
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await job.promise;
      assert.equal(result.usable, false);
      assert.equal(job.state, "Failed");
      assert.equal(h.starts, limit + 1);
      assert.equal(vi.getTimerCount(), 0);
    }
  } finally {
    vi.useRealTimers();
  }
});

for (const retryable of [undefined, false])
  test(`unclassified/permanent failure (${String(retryable)}) does not retry`, async () => {
    vi.useFakeTimers();
    try {
      const h = retryFixture();
      h.results.push({ usable: false, retryable } as PreparedCheckpoint);
      const job = h.start();
      await vi.advanceTimersByTimeAsync(60_000);
      await job.promise;
      assert.equal(h.starts, 1);
      assert.equal(h.captures, 0);
    } finally {
      vi.useRealTimers();
    }
  });

for (const change of ["run", "owner", "controller", "settings", "snapshot"] as const)
  test(`${change} during backoff prevents retry and clears timers`, async () => {
    vi.useFakeTimers();
    try {
      const h = retryFixture();
      const job = h.start();
      const outcome = job.promise.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      if (change === "run") h.run.abort();
      else if (change === "owner") h.owner.abort();
      else if (change === "controller") job.controller.abort();
      else if (change === "settings") h.settings.asyncRetryCount = 0;
      else h.invalidate();
      await vi.advanceTimersByTimeAsync(60_000);
      await outcome;
      assert.equal(h.starts, 1);
      assert.equal(h.captures, 0);
      assert.equal(job.isCurrent(), false);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      vi.useRealTimers();
    }
  });

test("retry backoff is bounded by the original total preparation deadline", async () => {
  vi.useFakeTimers();
  try {
    const h = fixture(1000);
    h.preparation.start = async () =>
      ({
        usable: false,
        retryable: true,
        retry: () => {
          captures += 1;
          return h.preparation;
        },
      }) as PreparedCheckpoint;
    let captures = 0;
    const job = startBackgroundJob(
      h.preparation,
      { signal: h.run.signal } as ExtensionContext,
      { get: () => ({ settings: h.settings }) } as BackgroundCompactionSettingsRuntime,
      h.owner.signal,
      () => true,
      {
        onRetry: () => {},
        onAttempt: () => {},
      },
    );
    await vi.advanceTimersByTimeAsync(1000);
    await job.promise;
    assert.equal(captures, 0);
    assert.equal(job.state, "Failed");
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

test("a retry hint without producer-owned recapture stays single-attempt", async () => {
  const h = fixture();
  h.preparation.start = async () => ({ usable: false, retryable: true }) as PreparedCheckpoint;
  let retries = 0;
  const job = startBackgroundJob(
    h.preparation,
    { signal: h.run.signal } as ExtensionContext,
    { get: () => ({ settings: h.settings }) } as BackgroundCompactionSettingsRuntime,
    h.owner.signal,
    () => true,
    {
      onRetry: () => {
        retries++;
      },
      onAttempt: () => {},
    },
  );
  await job.promise;
  assert.equal(retries, 0);
});

test("reentrant cancellation from retry-start status cannot dispatch new work", async () => {
  vi.useFakeTimers();
  const h = fixture(60_000);
  let starts = 0;
  const candidate: CheckpointPreparation = {
    requestTimeoutMs: 60_000,
    isCurrent: () => true,
    start: async () => {
      starts++;
      return { usable: false, retryable: true, retry: () => candidate } as PreparedCheckpoint;
    },
  };
  try {
    const job = startBackgroundJob(
      candidate,
      { signal: h.run.signal } as ExtensionContext,
      { get: () => ({ settings: h.settings }) } as BackgroundCompactionSettingsRuntime,
      h.owner.signal,
      () => true,
      { onRetry: () => {}, onAttempt: () => h.run.abort() },
    );
    const pending = job.promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    assert.equal(starts, 1);
    assert.equal(job.state, "Cancelled");
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});
