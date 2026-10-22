import assert from "node:assert/strict";
import { buildSessionContext, type CompactionEntryDraft } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { assistant, deferred, fixture } from "./async-compaction-fixture.js";

async function ready(priorCompaction = false, systemUpdate = false) {
  const h = fixture({ asyncAutoApply: true, logCompaction: true });
  const run = new AbortController();
  Object.defineProperty(h.ctx, "signal", { configurable: true, get: () => run.signal });
  await h.emit("session_start", {});
  if (systemUpdate) {
    h.manager.appendMessage({ role: "system", content: "updated system", timestamp: 3 });
    h.manager.appendMessage(assistant("after system update"));
  }
  if (priorCompaction) h.manager.appendCompaction("old summary", h.first, 80_000);
  await h.start();
  await h.started;
  h.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.ctx.isIdle = () => false;
  h.ctx.compact = () => {
    throw new Error("Must not abort the active run");
  };
  return { ...h, run };
}

test("ready checkpoint becomes one native turn draft while the run stays active", async () => {
  const h = await ready();
  const tail = h.manager.appendMessage({ role: "user", content: "new tail", timestamp: 3 });
  const before = JSON.stringify(h.manager.getBranch());
  const custom = { type: "custom", customType: "other", data: {} };
  const result = (await h.emit("turn_end", { outcome: "completed", entries: [custom] })) as {
    entries: CompactionEntryDraft[];
  };
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0], custom);
  const draft = result.entries[1];
  assert.equal(draft.type, "compaction");
  assert.equal(JSON.stringify(h.manager.getBranch()), before, "returning a draft does not commit");
  assert.equal(
    h.notifications.some(({ message }) => message.includes("committed at")),
    false,
  );
  h.manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 70_000, draft.details, true, draft.usage);
  await h.emit("turn_start", {});
  assert.equal(h.notifications.filter(({ message }) => message.includes("committed at")).length, 1);
  await h.emit("turn_start", {});
  assert.equal(h.notifications.filter(({ message }) => message.includes("committed at")).length, 1);
  assert.ok(h.manager.getBranch().some((entry) => entry.id === tail));
  assert.equal(h.fetches, 1);
  assert.equal(h.run.signal.aborted, false);
  assert.equal(h.sentMessages.length, 0);
  assert.equal(h.sentUserMessages.length, 0);
});

for (const phase of ["ready", "auth"])
  test(`Escape during ${phase} preserves ready checkpoint for manual compaction`, async () => {
    const h = await ready();
    let applying: Promise<unknown> | undefined;
    const gate = deferred<void>();
    if (phase === "auth") {
      const started = deferred<void>();
      const original = h.ctx.modelRegistry.getApiKeyAndHeaders.bind(h.ctx.modelRegistry);
      h.ctx.modelRegistry.getApiKeyAndHeaders = async (...args) => {
        started.resolve();
        await gate.promise;
        return original(...args);
      };
      applying = h.emit("turn_end", { outcome: "completed", entries: [] });
      await started.promise;
    }
    h.run.abort();
    gate.resolve();
    await applying;
    await h.emit("turn_end", { outcome: "aborted", entries: [] });
    await h.emit("agent_settled", { aborted: true });
    Object.defineProperty(h.ctx, "signal", { configurable: true, get: () => undefined });
    h.ctx.isIdle = () => true;
    await h.emit("input", {});
    const result = await h.compact("manual");
    assert.ok(result && typeof result === "object" && "compaction" in result);
    assert.equal(h.fetches, 1);
    assert.equal(
      h.notifications.some(({ message }) => message.includes("discarded")),
      false,
    );
  });

test("uncommitted or replaced boundary draft remains manually reusable without false completion", async () => {
  const h = await ready();
  await h.emit("turn_end", { outcome: "completed", entries: [] });
  await h.emit("turn_start", {});
  assert.equal(
    h.notifications.some(({ message }) => message.includes("committed at")),
    false,
  );
  const result = await h.compact("manual");
  assert.ok(result && typeof result === "object" && "compaction" in result);
  assert.equal(h.fetches, 1);
});

for (const kind of ["auth", "prefix", "unpaired", "toggle", "other-compaction"])
  test(`native boundary rejects ${kind} without inference`, async () => {
    const h = await ready();
    if (kind === "auth") h.setKey("changed");
    if (kind === "prefix") h.setPrompt("changed");
    if (kind === "toggle") await h.runtime.update({ asyncAutoApply: false });
    if (kind === "unpaired")
      h.manager.appendMessage({
        ...assistant(""),
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "unpaired", name: "test", arguments: {} }],
      });
    const entries =
      kind === "other-compaction" ? [{ type: "compaction", summary: "other", firstKeptEntryId: h.first }] : [];
    const result = await h.emit("turn_end", { outcome: "completed", entries });
    assert.equal(result, undefined);
    assert.equal(h.fetches, 1);
  });

test("a second native checkpoint retains raw history before the older summary entry", async () => {
  const h = await ready(true);
  const result = (await h.emit("turn_end", { outcome: "completed", entries: [] })) as {
    entries: CompactionEntryDraft[];
  };
  const draft = result.entries[0];
  assert.ok(draft.firstKeptEntryId);
  h.manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 70_000, draft.details, true, draft.usage);
  const messages = buildSessionContext(h.manager.getBranch()).messages;
  const projected = (await h.emit("context", { messages })) as { messages: unknown[] };
  assert.ok(projected?.messages, "native second checkpoint must replay successfully");
});

test("interleaved system entries fold into a replayable native checkpoint", async () => {
  const h = await ready(false, true);
  const result = (await h.emit("turn_end", { outcome: "completed", entries: [] })) as {
    entries: CompactionEntryDraft[];
  };
  const draft = result.entries[0];
  h.manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 70_000, draft.details, true, draft.usage);
  const messages = buildSessionContext(h.manager.getBranch()).messages;
  const projected = (await h.emit("context", { messages })) as { messages: unknown[] };
  assert.ok(projected?.messages);
});

test("a suffix mutation during authentication cannot be committed", async () => {
  const h = await ready();
  const original = h.ctx.modelRegistry.getApiKeyAndHeaders.bind(h.ctx.modelRegistry);
  h.ctx.modelRegistry.getApiKeyAndHeaders = async (...args) => {
    h.manager.appendMessage({ role: "user", content: "racing suffix", timestamp: 4 });
    return original(...args);
  };
  assert.equal(await h.emit("turn_end", { outcome: "completed", entries: [] }), undefined);
  assert.equal(h.fetches, 1);
});
