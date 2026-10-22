import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { latestCheckpoint } from "@integration/engine/checkpoint.js";
import { test } from "vitest";
import { fixture } from "./async-compaction-fixture.js";

async function readyForAutoApply(overrides = {}) {
  const h = fixture({ asyncAutoApply: true, ...overrides });
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  h.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return h;
}

for (const boundary of ["agent_settled", "input"])
  test(`auto-apply adopts once at ${boundary} without inference or continuation`, async () => {
    const h = await readyForAutoApply();
    const suffix = h.manager.appendMessage({ role: "user", content: "untouched tail", timestamp: 3 });
    let calls = 0;
    h.ctx.compact = (options) => {
      calls++;
      void h.compact("manual").then(async (result) => {
        const compact = (
          result as {
            compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown };
          }
        ).compaction;
        assert.equal(compact.firstKeptEntryId, suffix);
        h.manager.appendCompaction(compact.summary, compact.firstKeptEntryId, compact.tokensBefore, compact.details);
        await h.emit("session_compact", { reason: "manual", fromExtension: true });
        options?.onComplete?.(compact);
      });
    };
    assert.equal(calls, 0, "readiness alone does not interrupt a prompt preflight");
    await h.emit(boundary, { aborted: false });
    await h.emit(boundary, { aborted: false });
    assert.equal(calls, 1);
    assert.equal(h.fetches, 1);
    assert.equal(h.sentMessages.length, 0);
    assert.equal(h.sentUserMessages.length, 0);
    assert.ok(latestCheckpoint(h.manager.getBranch()));
  });

for (const condition of ["off", "busy", "queued", "aborted", "stale", "disabled", "shutdown"])
  test(`auto-apply skips ${condition} boundary`, async () => {
    const h = await readyForAutoApply();
    let calls = 0;
    h.ctx.compact = () => {
      calls++;
    };
    if (condition === "off") await h.runtime.update({ asyncAutoApply: false });
    if (condition === "disabled") await h.runtime.update({ asyncEnabled: false });
    if (condition === "busy") h.ctx.isIdle = () => false;
    if (condition === "queued") h.ctx.hasPendingMessages = () => true;
    if (condition === "stale") h.setPrompt("changed");
    if (condition === "shutdown") await h.emit("session_shutdown", {});
    await h.emit("agent_settled", { aborted: condition === "aborted" });
    assert.equal(calls, 0);
  });

test("concurrent inputs await the same auto-apply and a failed attempt is not retried", async () => {
  const h = await readyForAutoApply();
  let calls = 0;
  let options: Parameters<ExtensionContext["compact"]>[0];
  h.ctx.compact = (value) => {
    calls++;
    options = value;
  };
  let completed = 0;
  const first = h.emit("input", {}).then(() => completed++);
  const second = h.emit("input", {}).then(() => completed++);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(completed, 0);
  options?.onError?.(new Error("failed"));
  await Promise.all([first, second]);
  await h.emit("input", {});
  assert.equal(completed, 2);
  assert.equal(calls, 1);
});

test("stale auth during auto-apply cancels instead of using foreground inference", async () => {
  const h = await readyForAutoApply();
  h.setKey("different-key");
  let result: unknown;
  h.ctx.compact = (options) => {
    void h.compact("manual").then((value) => {
      result = value;
      options?.onError?.(new Error("cancelled"));
    });
  };
  await h.emit("input", {});
  assert.deepEqual(result, { cancel: true });
  assert.equal(h.fetches, 1);
  assert.equal(latestCheckpoint(h.manager.getBranch()), undefined);
});

test("enabling auto-apply preserves an existing ready job", async () => {
  const h = await readyForAutoApply({ asyncAutoApply: false });
  await h.runtime.update({ asyncAutoApply: true });
  let result: unknown;
  h.ctx.compact = (options) => {
    void h.compact("manual").then((value) => {
      result = value;
      options?.onError?.(new Error("test did not commit"));
    });
  };
  await h.emit("input", {});
  assert.ok(result && typeof result === "object" && "compaction" in result);
  assert.equal(h.fetches, 1);
});

for (const change of ["toggle", "navigation", "shutdown"])
  test(`auto-apply cancels ${change} during auth revalidation without foreground work`, async () => {
    const h = await readyForAutoApply();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    const getAuth = h.ctx.modelRegistry.getApiKeyAndHeaders.bind(h.ctx.modelRegistry);
    h.ctx.modelRegistry.getApiKeyAndHeaders = async (...args) => {
      started();
      await gate;
      return getAuth(...args);
    };
    let result: unknown;
    let compacting: Promise<void> | undefined;
    h.ctx.compact = (options) => {
      compacting = h.compact("manual").then((value) => {
        result = value;
        options?.onError?.(new Error("cancelled"));
      });
    };
    const applying = h.emit("input", {});
    await reached;
    if (change === "toggle") await h.runtime.update({ asyncAutoApply: false });
    else await h.emit(change === "navigation" ? "session_before_switch" : "session_shutdown", {});
    release();
    await applying;
    await compacting;
    assert.deepEqual(result, { cancel: true });
    assert.equal(h.fetches, 1);
    assert.equal(latestCheckpoint(h.manager.getBranch()), undefined);
    if (change === "toggle") {
      const manual = await h.compact("manual");
      assert.ok(manual && typeof manual === "object" && "compaction" in manual);
      assert.equal(h.fetches, 1, "turning off auto-apply preserves manual reuse");
    }
  });
