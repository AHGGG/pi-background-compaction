import assert from "node:assert/strict";
import type { CompactionEntryDraft } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { assistant, fixture } from "./async-compaction-fixture.js";

async function ready() {
  const h = fixture({ asyncAutoApply: true, logCompaction: true });
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  h.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
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
  return { ...h, fail, idle };
}

test("ready checkpoint waits through model failures and applies once after successful retry", async () => {
  const h = await ready();
  await h.fail();
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
  assert.equal(h.notifications.filter(({ message }) => message.includes("committed at")).length, 1);
  assert.equal(h.fetches, 1);
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
