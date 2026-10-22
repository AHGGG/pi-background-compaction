import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { fixture, model } from "./async-compaction-fixture.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const pauses = (h: ReturnType<typeof fixture>) =>
  h.notifications.filter(({ message }) => message.includes("Warm-ahead paused"));
const resume = (h: ReturnType<typeof fixture>) => h.commands.get("background-compaction")?.handler("resume", h.ctx);
async function ready() {
  const h = fixture({ asyncAutoApply: true, logCompaction: false, maxRetries: 0 });
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  h.release();
  await tick();
  return h;
}

for (const failure of ["transport", "auth", "timeout"] as const)
  test(`preparation ${failure} pauses once without logging and leaves foreground available`, async () => {
    const h = fixture({ maxRetries: 0, requestTimeoutMs: 30_000 });
    await h.emit("session_start", {});
    if (failure === "timeout") vi.useFakeTimers();
    try {
      if (failure === "transport") h.fail();
      if (failure === "auth")
        h.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
          throw new Error("PRIVATE-AUTH");
        };
      await h.start();
      if (failure !== "auth") await h.started;
      if (failure === "timeout") await vi.advanceTimersByTimeAsync(30_000);
      else {
        h.release();
        await tick();
      }
      assert.equal(pauses(h).length, 1);
      assert.doesNotMatch(pauses(h)[0].message, /PRIVATE-AUTH|fixture-key/);
      const calls = h.fetches;
      await h.start();
      await h.start();
      assert.equal(h.fetches, calls);
      assert.equal(pauses(h).length, 1);
      h.release();
      h.fail();
      assert.equal(
        await h.compact("manual"),
        undefined,
        "foreground still hands ordinary failure to native compaction",
      );
      await h.start();
      assert.equal(pauses(h).length, 1);
    } finally {
      h.release();
      await h.emit("session_shutdown", {});
      vi.useRealTimers();
    }
  });

for (const mode of ["tui", "rpc", "print", "json"] as const)
  test(`explicit resume clears binding failure only in memory in ${mode}`, async () => {
    const h = await ready();
    h.setKey("changed");
    await h.start();
    assert.equal(pauses(h).length, 1);
    await h.start();
    assert.equal(h.fetches, 1);
    const update = vi.spyOn(h.runtime, "update");
    h.ctx.mode = mode;
    h.ctx.hasUI = mode === "tui" || mode === "rpc";
    await resume(h);
    assert.equal(update.mock.calls.length, 0);
    assert.equal(h.fetches, 1, "resume never starts a request immediately");
    await h.start();
    await tick();
    assert.equal(h.fetches, 2);
    await h.emit("session_shutdown", {});
  });

for (const change of ["escape", "prompt", "settings", "model", "navigation"])
  test(`${change} invalidation is not a failure`, async () => {
    const h = fixture();
    const controller = new AbortController();
    h.ctx.signal = controller.signal;
    await h.emit("session_start", {});
    await h.start();
    await h.started;
    if (change === "escape") controller.abort();
    else if (change === "prompt") h.setPrompt("new prompt");
    else if (change === "settings") await h.runtime.update({ asyncThresholdPercent: 60 });
    else if (change === "model") h.ctx.model = { ...model, id: "changed" };
    else await h.emit("session_before_fork", {});
    h.release();
    await tick();
    assert.equal(pauses(h).length, 0);
    await h.emit("session_shutdown", {});
  });

for (const outcome of ["throw", "throw-cancel", "error", "cancel", "aborted-event"] as const)
  test(`idle auto-application ${outcome} classification`, async () => {
    const h = await ready();
    h.ctx.isIdle = () => true;
    h.ctx.hasPendingMessages = () => false;
    h.ctx.compact = (options) => {
      if (outcome === "throw") throw new Error("PRIVATE-ERROR");
      if (outcome === "throw-cancel") throw new Error("Compaction cancelled");
      void (async () => {
        if (outcome === "aborted-event") await h.emit("session_compact_failed", { aborted: true });
        options?.onError?.(new Error(outcome === "cancel" ? "Compaction cancelled" : "PRIVATE-ERROR"));
      })();
    };
    await h.emit("input", {});
    assert.equal(pauses(h).length, outcome === "throw" || outcome === "error" ? 1 : 0);
    assert.doesNotMatch(h.notifications.map(({ message }) => message).join("\n"), /PRIVATE-ERROR/);
    await h.emit("session_shutdown", {});
  });

test("session restart clears pause and late old callbacks cannot pause the replacement", async () => {
  const h = await ready();
  let callback: ((error: Error) => void) | undefined;
  h.ctx.isIdle = () => true;
  h.ctx.hasPendingMessages = () => false;
  h.ctx.compact = (options) => {
    callback = options?.onError;
  };
  const pending = h.emit("input", {});
  assert.ok(callback);
  await h.emit("session_start", {});
  callback(new Error("late error"));
  await pending;
  assert.equal(pauses(h).length, 0);
  await h.start();
  await tick();
  assert.equal(h.fetches, 2);
  await h.emit("session_shutdown", {});
});

test("resume survives a late auto-apply callback after a binding rejection", async () => {
  const h = await ready();
  let callback: ((error: Error) => void) | undefined;
  h.ctx.isIdle = () => true;
  h.ctx.hasPendingMessages = () => false;
  h.ctx.compact = (options) => {
    callback = options?.onError;
  };
  const pending = h.emit("input", {});
  h.setKey("changed");
  assert.deepEqual(await h.compact("manual"), { cancel: true });
  assert.equal(pauses(h).length, 1);
  await resume(h);
  callback?.(new Error("late error"));
  await pending;
  await h.start();
  await tick();
  assert.equal(pauses(h).length, 1);
  assert.equal(h.fetches, 2);
  await h.emit("session_shutdown", {});
});

test("settings toggles and successful manual compaction do not silently resume warm-ahead", async () => {
  const h = await ready();
  h.setKey("changed");
  await h.start();
  assert.equal(pauses(h).length, 1);
  await h.runtime.update({ asyncEnabled: false });
  await h.runtime.update({ asyncEnabled: true });
  const result = await h.compact("manual");
  assert.ok(result && typeof result === "object" && "compaction" in result);
  await h.emit("session_compact", {});
  await h.start();
  await tick();
  assert.equal(h.fetches, 2, "manual compaction is available but warm-ahead remains paused");
  await h.emit("session_start", {});
  await h.start();
  await tick();
  assert.equal(h.fetches, 3, "a new session start resets the pause");
  await h.emit("session_shutdown", {});
});

test("resume completion is advertised and unknown or trailing arguments are rejected", async () => {
  const h = fixture();
  const command = h.commands.get("background-compaction");
  assert.ok(command);
  assert.deepEqual(command.getArgumentCompletions?.("res"), [
    { value: "resume", label: "resume — retry background preparation" },
  ]);
  for (const args of ["resume now", "unknown"])
    await assert.rejects(async () => command.handler(args, h.ctx), /Usage:/);
});

for (const event of ["session_before_fork", "model_select"])
  test(`late auto-apply error after ${event} is ordinary invalidation`, async () => {
    const h = await ready();
    let callback: ((error: Error) => void) | undefined;
    h.ctx.isIdle = () => true;
    h.ctx.hasPendingMessages = () => false;
    h.ctx.compact = (options) => {
      callback = options?.onError;
    };
    const pending = h.emit("input", {});
    await h.emit(event, { model });
    callback?.(new Error("late error"));
    await pending;
    assert.equal(pauses(h).length, 0);
    await h.emit("session_shutdown", {});
  });
