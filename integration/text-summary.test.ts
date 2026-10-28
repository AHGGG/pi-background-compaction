import assert from "node:assert/strict";
import { buildSessionContext, type CompactionEntryDraft } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CODEX_COMPACT_SETTINGS } from "@integration/engine/settings.js";
import { test } from "vitest";
import { assistant, fixture } from "./async-compaction-fixture.js";

const supported = "compactionMode" in DEFAULT_CODEX_COMPACT_SETTINGS;
if (process.env.REQUIRE_TEXT_SUMMARY === "1")
  assert.ok(supported, "The paired engine must support Text summary preparation");
const summary = "The user asked for a fixture task. Continue with the retained recent messages.";
function summaryResponse(completed = true) {
  const item = {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: summary }],
  };
  const events: Record<string, unknown>[] = [{ type: "response.output_item.done", item }];
  if (completed) events.push({ type: "response.completed", response: { status: "completed", output: [item] } });
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}
function textFixture(overrides = {}) {
  const h = fixture({ compactionMode: "text-summary", asyncAutoApply: true, logCompaction: true, ...overrides });
  h.setReply(summaryResponse);
  return h;
}
async function ready() {
  const h = textFixture();
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  h.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return h;
}
function commit(h: ReturnType<typeof fixture>, draft: CompactionEntryDraft) {
  h.manager.appendCompaction(
    draft.summary,
    draft.firstKeptEntryId,
    draft.tokensBefore ?? 65_000,
    draft.details,
    true,
    draft.usage,
  );
}
function assertRetained(h: ReturnType<typeof fixture>) {
  const messages = buildSessionContext(h.manager.getBranch()).messages;
  const text = JSON.stringify(messages);
  assert.ok(text.includes(summary));
  assert.equal(
    messages.some((message) => message.role === "user" && message.content === "snapshot user"),
    false,
    "the summarized prefix must be replaced, not duplicated",
  );
  assert.equal(messages.filter((message) => message.role === "user" && message.content === "new tail").length, 1);
  assert.equal(messages.filter((message) => message.role === "toolResult").length, 1);
  assert.equal(h.fetches, 1, "applying a prepared text summary must not make a second provider request");
  assert.ok(h.engine().checkpointId(h.ctx), "plaintext result identity must confirm successful application");
  assert.equal(h.sentMessages.length, 0);
  assert.equal(h.sentUserMessages.length, 0);
}
function appendTail(h: ReturnType<typeof fixture>) {
  h.manager.appendMessage({ role: "user", content: "new tail", timestamp: 3 });
  h.manager.appendMessage({
    ...assistant(""),
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "tail-tool", name: "read", arguments: {} }],
  });
  h.manager.appendMessage({
    role: "toolResult",
    toolCallId: "tail-tool",
    toolName: "read",
    content: [{ type: "text", text: "tail result" }],
    isError: false,
    timestamp: 4,
  });
}

for (const boundary of ["turn_end", "input"])
  test.skipIf(!supported)(`text summary auto-applies at ${boundary} and preserves appended tool pairs`, async () => {
    const h = await ready();
    try {
      appendTail(h);
      if (boundary === "turn_end") {
        h.ctx.isIdle = () => false;
        h.ctx.compact = () => {
          throw new Error("Must not abort an active run");
        };
        const result = (await h.emit("turn_end", { outcome: "completed", entries: [] })) as {
          entries: CompactionEntryDraft[];
        };
        assert.equal(result.entries.length, 1);
        commit(h, result.entries[0]);
        await h.emit("turn_start", {});
      } else {
        h.ctx.compact = (options) => {
          void h
            .compact("manual")
            .then(async (result) => {
              const draft = (result as { compaction: CompactionEntryDraft }).compaction;
              commit(h, draft);
              await h.emit("session_compact", { reason: "manual", fromExtension: true });
              options?.onComplete?.(draft);
            })
            .catch((error) => options?.onError?.(error));
        };
        await h.emit("input", {});
      }
      assertRetained(h);
      const payload = h.payloads[0] as Record<string, unknown>;
      assert.equal(payload.context_management, undefined);
      assert.equal(payload.tool_choice, "none");
      assert.ok((h.outputBudgets[0] ?? 0) > 1);
    } finally {
      await h.emit("session_shutdown", {});
    }
  });

test.skipIf(!supported)("manual compaction waits for the same in-flight text summary", async () => {
  const h = textFixture();
  try {
    await h.emit("session_start", {});
    await h.start();
    await h.started;
    let completed = false;
    const applying = h.compact("manual").then((result) => {
      completed = true;
      return result;
    });
    await Promise.resolve();
    assert.equal(completed, false);
    h.release();
    const result = (await applying) as { compaction: CompactionEntryDraft };
    assert.ok(result.compaction.summary.includes(summary));
    assert.equal(h.fetches, 1);
  } finally {
    h.release();
    await h.emit("session_shutdown", {});
  }
});

for (const invalidation of ["settings", "prompt", "prefix"])
  test.skipIf(!supported)(`text summary rejects ${invalidation} changes without replacing history`, async () => {
    const h = await ready();
    try {
      if (invalidation === "settings") await h.runtime.update({ compactionMode: "provider-checkpoint" });
      else if (invalidation === "prompt") h.setPrompt("changed system prompt");
      else h.manager.appendContextEdit(h.first, { content: "edited captured history" });
      const before = JSON.stringify(h.manager.getBranch());
      h.ctx.compact = () => {
        throw new Error("Invalid result must not apply");
      };
      await h.emit("input", {});
      assert.equal(JSON.stringify(h.manager.getBranch()), before);
      assert.equal(h.fetches, 1);
    } finally {
      await h.emit("session_shutdown", {});
    }
  });

test.skipIf(!supported)(
  "cancelling a manual wait for a text summary does not apply or send replacement inference",
  async () => {
    const h = textFixture();
    try {
      await h.emit("session_start", {});
      await h.start();
      await h.started;
      const before = JSON.stringify(h.manager.getBranch());
      const controller = new AbortController();
      const applying = h.compact("manual", controller.signal);
      controller.abort();
      const result = await applying;
      assert.deepEqual(result, { cancel: true });
      assert.equal(JSON.stringify(h.manager.getBranch()), before);
      assert.equal(h.fetches, 1);
    } finally {
      h.release();
      await h.emit("session_shutdown", {});
    }
  },
);

test.skipIf(!supported)("text summary without a terminal event preserves history and pauses preparation", async () => {
  const h = textFixture();
  h.setReply(() => summaryResponse(false));
  try {
    await h.emit("session_start", {});
    const before = JSON.stringify(h.manager.getBranch());
    await h.start();
    await h.started;
    h.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await h.emit("input", {});
    await h.start();
    assert.equal(JSON.stringify(h.manager.getBranch()), before);
    assert.equal(h.fetches, 1);
    assert.ok(h.notifications.some(({ message }) => message.includes("Warm-ahead paused")));
  } finally {
    h.release();
    await h.emit("session_shutdown", {});
  }
});

test.skipIf(!supported)("text summary auto-applies without a newly appended tail", async () => {
  const h = await ready();
  try {
    h.ctx.isIdle = () => false;
    const result = (await h.emit("turn_end", { outcome: "completed", entries: [] })) as {
      entries: CompactionEntryDraft[];
    };
    assert.equal(result.entries.length, 1);
    commit(h, result.entries[0]);
    await h.emit("turn_start", {});
    const messages = buildSessionContext(h.manager.getBranch()).messages;
    assert.ok(JSON.stringify(messages).includes(summary));
    assert.equal(
      messages.filter((message) => message.role === "assistant").length,
      1,
      "keep the raw final complete message as the native cut anchor",
    );
    assert.ok(h.engine().checkpointId(h.ctx));
    assert.equal(h.fetches, 1);
    assert.equal(h.notifications.filter(({ message }) => message.includes("committed at")).length, 1);
  } finally {
    await h.emit("session_shutdown", {});
  }
});
