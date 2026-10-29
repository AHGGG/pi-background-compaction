import assert from "node:assert/strict";
import type { CompactionEntryDraft } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { assistant, fixture } from "./async-compaction-fixture.js";

async function ready(initiallyReady = true) {
  const h = fixture({ asyncAutoApply: true, logCompaction: true });
  const run = new AbortController();
  Object.assign(h.ctx, { signal: run.signal });
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  // Isolate reuse of this preparation from new threshold-triggered work after success.
  h.ctx.getContextUsage = () => ({ tokens: 10, contextWindow: 100_000, percent: 0.01 });
  if (initiallyReady) {
    h.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  let compacts = 0;
  h.ctx.isIdle = () => true;
  h.ctx.compact = () => {
    compacts += 1;
  };
  const fail = async () => {
    const id = h.manager.appendMessage({ ...assistant(""), stopReason: "error", errorMessage: "WebSocket closed" });
    await h.emit("turn_end", { outcome: "error", entries: [] });
    h.manager.appendContextEdit(id, null);
    await h.emit("context", { messages: h.manager.buildSessionContext().messages });
  };
  const idle = async () => {
    await h.emit("agent_settled", { aborted: false });
    await h.emit("input", {});
    assert.equal(compacts, 0, "failed turns must not trigger idle application");
  };
  return {
    ...h,
    run,
    fail,
    idle,
    get fetches() {
      return h.fetches;
    },
  };
}

for (const initiallyReady of [false, true])
  test(`valid preparation survives repeated model errors and applies once after retry (ready=${initiallyReady})`, async () => {
    const h = await ready(initiallyReady);
    const request = h.requestSignals[0];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await h.fail();
      await h.idle();
      if (!initiallyReady) assert.equal(request.aborted, false);
      assert.equal(h.fetches, 1);
    }
    if (!initiallyReady) {
      h.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.match(h.notifications.at(-1)?.message ?? "", /waiting for a successful completed turn/);
    }
    await h.idle();
    await h.fail();
    await h.idle();
    const suffix = h.manager.appendMessage(assistant("retry succeeded"));
    const result = (await h.emit("turn_end", { outcome: "completed", entries: [] })) as {
      entries: CompactionEntryDraft[];
    };
    assert.equal(result.entries.length, 1);
    const draft = result.entries[0];
    assert.equal(draft.type, "compaction");
    h.manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 70_000, draft.details, true, draft.usage);
    await h.emit("turn_start", {});
    assert.ok(h.manager.getBranch().some((entry) => entry.id === suffix));
    await h.emit("turn_end", { outcome: "completed", entries: [] });
    await h.idle();
    assert.equal(h.notifications.filter(({ message }) => message.includes("committed at")).length, 1);
    assert.equal(h.fetches, 1);
    assert.ok(!h.notifications.some(({ message }) => /cancelled|discarded|Warm-ahead paused/.test(message)));
    await h.emit("session_shutdown", {});
  });

for (const cancellation of ["aborted-turn", "run-abort", "stale-prefix", "provider-prompt"] as const)
  test(`preserved in-flight preparation still rejects ${cancellation} with the real engine`, async () => {
    const h = await ready(false);
    const request = h.requestSignals[0];
    await h.fail();
    assert.equal(request.aborted, false);
    if (cancellation === "aborted-turn") await h.emit("turn_end", { outcome: "aborted", entries: [] });
    else if (cancellation === "run-abort") {
      h.run.abort();
      await h.emit("turn_end", { outcome: "error", entries: [] });
    } else if (cancellation === "stale-prefix") {
      h.manager.appendContextEdit(h.first, null);
      await h.fail();
    } else {
      h.setPrompt("incompatible provider checkpoint prompt");
      await h.fail();
    }
    assert.equal(request.aborted, true);
    h.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await h.emit("turn_end", { outcome: "completed", entries: [] }), undefined);
    await h.idle();
    assert.equal(h.fetches, 1);
    assert.ok(
      !h.notifications.some(({ message }) => /checkpoint is no longer current|Warm-ahead paused/.test(message)),
    );
    await h.emit("session_shutdown", {});
  });

for (const suppress of ["abort", "already-attempted", "stale"] as const)
  test(`successful retry does not bypass ${suppress} suppression`, async () => {
    const h = await ready();
    if (suppress === "already-attempted") await h.emit("turn_end", { outcome: "completed", entries: [] });
    await h.fail();
    if (suppress === "abort") await h.emit("turn_end", { outcome: "aborted", entries: [] });
    if (suppress === "stale") h.setPrompt("changed prompt");
    h.manager.appendMessage(assistant("later success"));
    assert.equal(await h.emit("turn_end", { outcome: "completed", entries: [] }), undefined);
    await h.idle();
    if (suppress !== "stale") {
      const manual = await h.compact("manual");
      assert.ok(manual && typeof manual === "object" && "compaction" in manual);
    }
    assert.equal(h.fetches, 1);
  });

test("a failed run retains its ready checkpoint for manual compaction without retry success", async () => {
  const h = await ready();
  await h.fail();
  await h.idle();
  const manual = await h.compact("manual");
  assert.ok(manual && typeof manual === "object" && "compaction" in manual);
  assert.equal(h.fetches, 1);
});
