import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { createCheckpointDetails, fallbackSummary, latestCheckpoint } from "@integration/engine/checkpoint.js";
import { capturePrefixCompactionBranch } from "@integration/engine/compaction-ownership.js";
import { test, vi } from "vitest";
import { assistant, deferred, fixture, model } from "./async-compaction-fixture.js";

test("pending warmup does not block turns or publish; adoption preserves every new message once", async () => {
  const h = fixture();
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  await h.start();
  assert.equal(h.fetches, 1);
  assert.equal(latestCheckpoint(h.manager.getBranch()), undefined);
  const userId = h.manager.appendMessage({ role: "user", content: "new user", timestamp: 3 });
  h.manager.appendMessage(assistant("new assistant"));
  const adoption = h.compact();
  await Promise.resolve();
  assert.equal(h.fetches, 1);
  h.release();
  const result = (await adoption) as {
    compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown };
  };
  assert.equal(h.fetches, 1);
  assert.equal(h.statuses.get("background-compaction"), undefined);
  assert.equal(result.compaction.firstKeptEntryId, userId);
  h.manager.appendCompaction(
    result.compaction.summary,
    result.compaction.firstKeptEntryId,
    result.compaction.tokensBefore,
    result.compaction.details,
  );
  const projected = (await h.emit("context", { messages: buildSessionContext(h.manager.getBranch()).messages })) as {
    messages: AgentMessage[];
  };
  assert.deepEqual(projected.messages.slice(1), buildSessionContext(h.manager.getBranch()).messages.slice(1));
  assert.equal(
    projected.messages.filter((message) => message.role === "user" && message.content === "new user").length,
    1,
  );
  assert.equal(h.sentMessages.length, 0);
  assert.equal(h.sentUserMessages.length, 0);
  await h.emit("session_shutdown", {});
});

for (const reason of ["threshold", "manual"] as const)
  for (const change of ["auth", "settings", "prompt", "model", "tools", "edit"] as const)
    test(`stale ${change} candidate uses ordinary ${reason} foreground history`, async () => {
      const h = fixture();
      await h.emit("session_start", {});
      await h.start();
      await h.started;
      h.release();
      if (reason === "manual") await new Promise<void>((resolve) => setImmediate(resolve));
      switch (change) {
        case "auth":
          h.setKey("changed-key");
          break;
        case "settings":
          await h.runtime.update({ replacementTokenBudget: 32_000 });
          break;
        case "prompt":
          h.setPrompt("changed prompt");
          break;
        case "model":
          h.ctx.model = { ...model, name: "Changed" };
          break;
        case "tools":
          h.rawPi.setActiveTools(["read"]);
          break;
        case "edit":
          h.manager.appendContextEdit(h.first, { content: "changed snapshot" });
          break;
      }
      const result = await h.compact(reason);
      assert.ok(result && typeof result === "object" && "compaction" in result);
      assert.equal(h.fetches, 2);
      await h.emit("session_shutdown", {});
    });

for (const event of [
  "session_shutdown",
  "session_start",
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
  "model_select",
  "thinking_level_select",
  "agent_settled",
] as const)
  test(`${event} cancels background without native fallback or continuation`, async () => {
    const h = fixture();
    await h.emit("session_start", {});
    await h.start();
    await h.started;
    await h.emit(event, event === "model_select" ? { model } : { aborted: true });
    assert.equal(h.requestSignals[0].aborted, true);
    h.release();
    await Promise.resolve();
    assert.equal(h.notifications.length, 0);
    assert.equal(h.sentMessages.length, 0);
    assert.equal(latestCheckpoint(h.manager.getBranch()), undefined);
    await h.emit("session_shutdown", {});
  });

test("manual compaction waits for warmup and adopts it without a fresh request", async () => {
  const h = fixture();
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  let settled = false;
  const pending = h.compact("manual").finally(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(h.fetches, 1);
  assert.equal(h.requestSignals[0].aborted, false);
  h.release();
  const result = await pending;
  assert.ok(result && typeof result === "object" && "compaction" in result);
  assert.equal(h.fetches, 1);
  await h.emit("session_shutdown", {});
});

for (const reason of ["threshold", "manual"] as const)
  test(`${reason} cancel while waiting never falls back or starts a duplicate request`, async () => {
    const h = fixture();
    await h.emit("session_start", {});
    await h.start();
    await h.started;
    const abort = new AbortController();
    const result = h.compact(reason, abort.signal);
    abort.abort();
    assert.deepEqual(await result, { cancel: true });
    assert.equal(h.fetches, 1);
    assert.equal(h.requestSignals[0].aborted, true);
    assert.equal(h.notifications.length, 0);
    h.release();
    await h.emit("session_shutdown", {});
  });

test("failed background request tries foreground once before native fallback", async () => {
  const h = fixture();
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  h.fail();
  h.release();
  assert.equal(await h.compact(), undefined);
  assert.equal(h.fetches, 2, "background failure permits one fresh foreground attempt");
  assert.match(h.notifications.map(({ message }) => message).join("\n"), /using Pi compaction/);
  await h.emit("session_shutdown", {});
});

test("owned background deadline permits exactly one fresh foreground request", async () => {
  vi.useFakeTimers();
  const h = fixture({ requestTimeoutMs: 30_000 });
  const timeouts: Array<number | undefined> = [];
  const stream = h.provider.stream;
  h.provider.stream = (...args) => {
    timeouts.push(args[2]?.timeoutMs);
    return stream(...args);
  };
  try {
    await h.emit("session_start", {});
    await h.start();
    await h.started;
    await vi.advanceTimersByTimeAsync(30_000);
    assert.equal(h.requestSignals[0].aborted, true);
    assert.equal(h.notifications.filter(({ message }) => message.includes("Warm-ahead paused")).length, 1);
    const foreground = h.compact();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(h.fetches, 2);
    assert.equal(h.requestSignals[1].aborted, false);
    assert.notEqual(h.requestSignals[1], h.requestSignals[0]);
    assert.deepEqual(timeouts, [30_000, 30_000], "each adapter receives its own configured timeout");
    // This deliberately noncompliant adapter ignores timeoutMs; settle its foreground call explicitly.
    h.fail();
    h.release();
    assert.equal(await foreground, undefined);
    assert.equal(h.fetches, 2);
    assert.match(h.notifications.map(({ message }) => message).join("\n"), /timed out/);
  } finally {
    h.release();
    await h.emit("session_shutdown", {});
    vi.useRealTimers();
  }
});

test("pending adoption waits for the original deadline before refreshing auth", async () => {
  vi.useFakeTimers();
  const h = fixture({ requestTimeoutMs: 30_000 });
  const authGate = deferred<void>();
  let prematureAuth = false;
  try {
    await h.emit("session_start", {});
    await h.start();
    await h.started;
    const getAuth = h.ctx.modelRegistry.getApiKeyAndHeaders.bind(h.ctx.modelRegistry);
    h.ctx.modelRegistry.getApiKeyAndHeaders = async (active) => {
      if (!h.requestSignals[0].aborted) {
        prematureAuth = true;
        await authGate.promise;
      }
      return getAuth(active);
    };
    const adoption = h.compact();
    await vi.advanceTimersByTimeAsync(30_000);
    assert.equal(prematureAuth, false);
    assert.equal(h.fetches, 2, "foreground starts only after the background deadline");
    assert.equal(h.requestSignals[1].aborted, false);
    h.fail();
    h.release();
    assert.equal(await adoption, undefined);
    assert.equal(h.fetches, 2);
    assert.match(h.notifications.map(({ message }) => message).join("\n"), /timed out/);
  } finally {
    authGate.resolve();
    h.release();
    await h.emit("session_shutdown", {});
    vi.useRealTimers();
  }
});

test("warm branch permits appended turns but rejects edits, duplicate IDs, and compaction", () => {
  const manager = SessionManager.inMemory();
  const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  const current = capturePrefixCompactionBranch(manager.getBranch());
  manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
  assert.equal(current(manager.getBranch()), true);
  manager.appendContextEdit(first, { content: "edited" });
  assert.equal(current(manager.getBranch()), false);
  const next = capturePrefixCompactionBranch(manager.getBranch());
  manager.appendCompaction("summary", first, 100);
  assert.equal(next(manager.getBranch()), false);
});

for (const settings of [{ asyncEnabled: false }, { enabled: false }])
  test(`disabled warmup does not inspect context or authenticate: ${JSON.stringify(settings)}`, async () => {
    const h = fixture(settings);
    h.ctx.getContextUsage = () => {
      throw new Error("disabled usage lookup");
    };
    await h.emit("session_start", {});
    await h.start();
    assert.equal(h.fetches, 0);
    assert.equal(h.captured.length, 0);
    await h.emit("session_shutdown", {});
  });

for (const context of [
  undefined,
  { tokens: null, contextWindow: 100_000, percent: null },
  { tokens: 64_999, contextWindow: 100_000, percent: 64.999 },
  { tokens: 90_000, contextWindow: 0, percent: null },
])
  test(`unknown or below-threshold usage does not prepare: ${JSON.stringify(context)}`, async () => {
    const h = fixture();
    h.ctx.getContextUsage = () => context;
    await h.emit("session_start", {});
    await h.start();
    assert.equal(h.fetches, 0);
    await h.emit("session_shutdown", {});
  });

test("successful settlement retains a ready candidate without publishing", async () => {
  const h = fixture();
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  h.release();
  await h.emit("agent_settled", { aborted: false });
  const result = await h.compact();
  assert.ok(result && typeof result === "object" && "compaction" in result);
  assert.equal(h.fetches, 1);
  assert.equal(latestCheckpoint(h.manager.getBranch()), undefined);
  await h.emit("session_shutdown", {});
});

for (const reason of ["threshold", "manual"] as const)
  test(`${reason} adoption preserves snapshot and later tool call/result pairs`, async () => {
    const h = fixture();
    await h.emit("session_start", {});
    await h.start();
    await h.started;
    const call = {
      ...assistant(""),
      content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "file" } }],
      stopReason: "toolUse",
    } as AssistantMessage;
    const callId = h.manager.appendMessage(call);
    const tool: AgentMessage = {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "output" }],
      isError: false,
      timestamp: 4,
    };
    h.manager.appendMessage(tool);
    h.manager.appendMessage(assistant("finished"));
    h.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = (await h.compact(reason)) as {
      compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown };
    };
    assert.equal(h.fetches, 1);
    assert.equal(result.compaction.firstKeptEntryId, callId);
    assert.equal(JSON.stringify(h.captured[0]).includes("read-1"), false);
    h.manager.appendCompaction(
      result.compaction.summary,
      result.compaction.firstKeptEntryId,
      result.compaction.tokensBefore,
      result.compaction.details,
    );
    const projected = (await h.emit("context", { messages: buildSessionContext(h.manager.getBranch()).messages })) as {
      messages: AgentMessage[];
    };
    assert.deepEqual(projected.messages.slice(1), [call, tool, assistant("finished")]);
    await h.emit("session_shutdown", {});
  });

test("never starts a snapshot with an unresolved tool call", async () => {
  const h = fixture();
  h.manager.appendMessage({
    ...assistant(""),
    content: [{ type: "toolCall", id: "pending", name: "read", arguments: {} }],
    stopReason: "toolUse",
  } as AssistantMessage);
  await h.emit("session_start", {});
  await h.start();
  assert.equal(h.fetches, 0);
  await h.emit("session_shutdown", {});
});

test("a new conversation message during adoption cannot be dropped", async () => {
  const h = fixture();
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  const adoption = h.compact();
  await Promise.resolve();
  h.manager.appendMessage({ role: "user", content: "concurrent input", timestamp: 3 });
  h.release();
  assert.deepEqual(await adoption, { cancel: true });
  assert.equal(h.fetches, 1);
  await h.emit("session_shutdown", {});
});

test("an oversized post-snapshot tail falls back to foreground without truncation", async () => {
  const h = fixture();
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  const text = "large tail ".repeat(40_000);
  h.manager.appendMessage({ role: "user", content: text, timestamp: 3 });
  h.release();
  const result = await h.compact();
  assert.ok(result && typeof result === "object" && "compaction" in result);
  assert.equal(h.fetches, 2);
  assert.ok(JSON.stringify(h.captured[1]).includes(text));
  await h.emit("session_shutdown", {});
});

function recoveryResponse() {
  const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] };
  return new Response(
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
  );
}
function priorCheckpoint(h: ReturnType<typeof fixture>) {
  const details = createCheckpointDetails({
    provider: model.provider,
    api: model.api,
    profile: "codex-responses-v1",
    modelId: model.id,
    protocol: "remote-v2",
    replacementHistory: [{ type: "compaction", encrypted_content: "old-opaque" }],
    keptMessages: buildSessionContext(h.manager.getBranch()).messages,
  });
  h.manager.appendCompaction(fallbackSummary(details.checkpointId), h.first, 60_000, details);
  h.manager.appendMessage({ role: "user", content: "work after old checkpoint", timestamp: 3 });
}

for (const mode of ["failure", "timeout"] as const)
  test(`${mode} with opaque history tries foreground once before recovering current suffix`, async () => {
    if (mode === "timeout") vi.useFakeTimers();
    const h = fixture({ requestTimeoutMs: 30_000 });
    priorCheckpoint(h);
    try {
      await h.emit("session_start", {});
      await h.start();
      await h.started;
      const call = {
        ...assistant(""),
        content: [{ type: "toolCall", id: "suffix-call", name: "read", arguments: {} }],
        stopReason: "toolUse",
      } as AssistantMessage;
      h.manager.appendMessage(call);
      h.manager.appendMessage({
        role: "toolResult",
        toolCallId: "suffix-call",
        toolName: "read",
        content: [{ type: "text", text: "suffix-result" }],
        isError: false,
        timestamp: 4,
      });
      h.manager.appendMessage(assistant("keep final"));
      h.setReply(recoveryResponse);
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(30_000);
      else h.failOnce();
      h.release();
      const result = (await h.compact()) as { compaction: { summary: string; details: unknown } };
      assert.equal(result.compaction.summary, "done");
      assert.equal(h.fetches, 3, "background, fresh checkpoint, then summary recovery");
      assert.equal(h.captured.length, 3);
      for (const request of h.captured.slice(1)) {
        assert.match(JSON.stringify(request), /suffix-call/);
        assert.match(JSON.stringify(request), /suffix-result/);
      }
      assert.equal(
        latestCheckpoint(h.manager.getBranch())?.details.replacementHistory[0].encrypted_content,
        "old-opaque",
      );
      assert.match(h.notifications.map(({ message }) => message).join("\n"), /checkpoint recovery/);
    } finally {
      h.release();
      await h.emit("session_shutdown", {});
      if (mode === "timeout") vi.useRealTimers();
    }
  });

test("opaque-history cancel policy preserves checkpoint after failed background", async () => {
  const h = fixture({ checkpointRecovery: "cancel" });
  priorCheckpoint(h);
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  h.fail();
  h.release();
  assert.deepEqual(await h.compact(), { cancel: true });
  assert.equal(h.fetches, 2, "one foreground checkpoint attempt before safe cancellation");
  assert.ok(latestCheckpoint(h.manager.getBranch()));
  await h.emit("session_shutdown", {});
});

test("provider reattachment invalidates a prepared binding", async () => {
  const h = fixture();
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  const previous = h.provider.stream;
  h.provider.stream = (...args) => previous(...args);
  h.release();
  const result = await h.compact();
  assert.ok(result && typeof result === "object" && "compaction" in result);
  assert.equal(h.fetches, 2);
  await h.emit("session_shutdown", {});
});

test("snapshot ending in a label replays after real Pi fork normalization", async () => {
  const h = fixture();
  const expectedCutoff = h.manager.getLeafId();
  h.manager.appendLabelChange(h.first, "bookmark");
  const oldLabelId = h.manager.getLeafId();
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  h.manager.appendMessage({ role: "user", content: "post-label suffix", timestamp: 3 });
  h.release();
  const result = (await h.compact()) as {
    compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown };
  };
  h.manager.appendCompaction(
    result.compaction.summary,
    result.compaction.firstKeptEntryId,
    result.compaction.tokensBefore,
    result.compaction.details,
  );
  assert.equal(latestCheckpoint(h.manager.getBranch())?.details.snapshotLeafId, expectedCutoff);
  const before = await h.emit("context", { messages: h.manager.buildSessionContext().messages });
  const leaf = h.manager.getLeafId();
  assert.ok(leaf);
  h.manager.createBranchedSession(leaf);
  assert.equal(
    h.manager.getBranch().some((entry) => entry.id === oldLabelId),
    false,
  );
  await h.emit("session_start", {});
  const after = await h.emit("context", { messages: h.manager.buildSessionContext().messages });
  assert.deepEqual(after, before);
  await h.emit("session_shutdown", {});
});

test("a late custom-provider callback cannot dispatch after the owned deadline", async () => {
  vi.useFakeTimers();
  const h = fixture({ requestTimeoutMs: 30_000 });
  const savedFetch = deferred<typeof globalThis.fetch>();
  const originalStream = h.provider.stream;
  h.provider.stream = (_model, _context, options) => {
    assert.ok(options?.fetch);
    savedFetch.resolve(options.fetch);
    return createAssistantMessageEventStream();
  };
  try {
    await h.emit("session_start", {});
    await h.start();
    const lateFetch = await savedFetch.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    // Deliberately omit init.signal, as a noncompliant adapter might.
    await assert.rejects(() => lateFetch("https://example.test/responses", { method: "POST" }), /timed out/);
    assert.equal(h.fetches, 0);
    h.provider.stream = originalStream;
    h.fail();
    h.release();
    assert.equal(await h.compact(), undefined);
    assert.equal(h.fetches, 1, "only the fresh foreground adapter may dispatch");
    await assert.rejects(() => lateFetch("https://example.test/responses", { method: "POST" }), /timed out/);
    assert.equal(h.fetches, 1, "the old callback remains blocked after foreground fallback");
  } finally {
    await h.emit("session_shutdown", {});
    vi.useRealTimers();
  }
});

test("a warmed Context Management checkpoint continues only after actual publication and only once", async () => {
  const h = fixture({ protocol: "context-management" });
  const boundary = () =>
    h.emit("agent_before_settle", {
      outcome: "completed",
      entries: [],
      continue: false,
      context: { canContinue: false, contextMessages: h.manager.buildSessionContext().messages },
    });
  await h.emit("session_start", {});
  await h.emit("before_agent_start", {});
  await h.start();
  await h.started;
  h.release();
  assert.equal(await boundary(), undefined);
  const result = (await h.compact()) as {
    compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown };
  };
  assert.equal(await boundary(), undefined, "returning a candidate is not publication");
  const id = h.manager.appendCompaction(
    result.compaction.summary,
    result.compaction.firstKeptEntryId,
    result.compaction.tokensBefore,
    result.compaction.details,
  );
  await h.emit("session_compact", {
    fromExtension: true,
    reason: "threshold",
    willRetry: false,
    compactionEntry: h.manager.getEntry(id),
  });
  const next = (await boundary()) as { continue: boolean; entries: Array<{ customType: string }> };
  assert.equal(next.continue, true);
  assert.equal(next.entries[0].customType, "codex-compact:continue-v1");
  assert.equal(await boundary(), undefined);
  assert.equal(h.fetches, 1);
  await h.emit("session_shutdown", {});
});

test("discarding an older warm job cannot clear a newer job's activity", async () => {
  const h = fixture();
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  await h.runtime.update({ asyncThresholdPercent: 60 });
  await h.start();
  // Let the aborted older request and replacement request cross their await points.
  for (let index = 0; index < 8; index++) await Promise.resolve();
  assert.equal(h.fetches, 2);
  assert.ok(h.statuses.get("background-compaction"));
  assert.equal(h.requestSignals[0].aborted, true);
  assert.equal(h.requestSignals[1].aborted, false);
  h.release();
  await h.emit("session_shutdown", {});
});

function lifecycleLogs(h: ReturnType<typeof fixture>) {
  return h.notifications
    .map(({ message }) => message)
    .filter((message) => message.startsWith("[background-compaction]"));
}

test("lifecycle logs default off and stay silent without UI", async () => {
  for (const options of [{}, { logCompaction: true }]) {
    const h = fixture(options);
    if ("logCompaction" in options) h.ctx.hasUI = false;
    await h.emit("session_start", {});
    await h.start();
    await h.started;
    h.release();
    await h.compact();
    await h.emit("session_compact", {});
    assert.deepEqual(
      lifecycleLogs(h).filter((line) => !line.includes("Async compaction ready:")),
      [],
    );
    await h.emit("session_shutdown", {});
  }
});

test("opt-in logs distinguish async preparation, waiting, reuse, and committed completion", async () => {
  const h = fixture({ logCompaction: true });
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  await h.start();
  const adoption = h.compact();
  assert.match(lifecycleLogs(h).join("\n"), /Async compaction triggered.*\n.*Actual compaction triggered.*\n.*waiting/);
  h.release();
  await adoption;
  assert.match(lifecycleLogs(h).join("\n"), /Async compaction ready.*\n.*reusing/);
  assert.equal(
    lifecycleLogs(h).some((line) => line.includes("completed:")),
    false,
  );
  await h.emit("session_compact", {});
  await h.emit("session_compact", {});
  assert.equal(lifecycleLogs(h).filter((line) => line.includes("completed:")).length, 1);
  assert.equal(lifecycleLogs(h).filter((line) => line.includes("Async compaction triggered")).length, 1);
  assert.doesNotMatch(lifecycleLogs(h).join("\n"), /fixture-key|snapshot user|opaque/);
  await h.emit("session_shutdown", {});
});

for (const logCompaction of [false, true])
  for (const event of ["session_start", "session_shutdown", "session_before_switch", "session_before_tree"])
    test(`logging ${logCompaction} suppresses late async notices after ${event}`, async () => {
      const h = fixture({ logCompaction });
      await h.emit("session_start", {});
      await h.start();
      await h.started;
      await h.emit(event, {});
      const before = lifecycleLogs(h);
      h.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(lifecycleLogs(h), before);
      assert.equal(
        before.some((line) => line.includes("ready:")),
        false,
      );
      await h.emit("session_shutdown", {});
    });

test("logging identifies manual waiting and checkpoint reuse", async () => {
  const h = fixture({ logCompaction: true });
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  const pending = h.compact("manual");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(lifecycleLogs(h).join("\n"), /Actual compaction triggered \(manual\).*\n.*waiting for the in-flight/);
  assert.equal(h.fetches, 1);
  h.release();
  await pending;
  assert.match(lifecycleLogs(h).join("\n"), /reusing the async checkpoint/);
  assert.equal(h.fetches, 1);
  await h.emit("session_shutdown", {});
});

test("logging reports failed warm preparation and native fallback without provider details", async () => {
  const h = fixture({ logCompaction: true, notifyOnFallback: false });
  await h.emit("session_start", {});
  h.fail();
  await h.start();
  await h.started;
  h.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await h.compact();
  const logs = lifecycleLogs(h).join("\n");
  assert.match(logs, /Async compaction failed: .*elapsed: \d+\.\ds/);
  assert.match(logs, /foreground compaction path/);
  assert.match(logs, /using the foreground compaction path/);
  assert.doesNotMatch(logs, /fixture failure|fixture-key/);
  await h.emit("session_compact_failed", {});
  assert.match(lifecycleLogs(h).at(-1) ?? "", /did not complete/);
  await h.emit("session_shutdown", {});
});

for (const event of ["session_start", "session_shutdown", "session_before_switch", "session_before_tree"])
  test(`logging suppresses completion from an operation discarded by ${event}`, async () => {
    const h = fixture({ logCompaction: true });
    await h.emit("session_start", {});
    h.release();
    await h.compact();
    await h.emit(event, {});
    await h.emit("session_compact", {});
    assert.equal(
      lifecycleLogs(h).some((line) => line.includes("completed:")),
      false,
    );
    await h.emit("session_shutdown", {});
  });

test("enabling logs preserves a pending async job and ready adoption skips waiting", async () => {
  const h = fixture();
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  await h.runtime.update({ logCompaction: true });
  h.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(lifecycleLogs(h).join("\n"), /Async compaction ready/);
  await h.compact();
  assert.equal(h.fetches, 1);
  assert.match(lifecycleLogs(h).join("\n"), /reusing/);
  assert.equal(
    lifecycleLogs(h).some((line) => line.includes("waiting")),
    false,
  );
  await h.emit("session_shutdown", {});
});

for (const mode of ["tui", "rpc", "print", "json"] as const)
  for (const logCompaction of [false, true])
    test(`ready notice is actionable once in ${mode}, logging ${logCompaction}`, async () => {
      const h = fixture({ logCompaction });
      h.ctx.mode = mode;
      h.ctx.hasUI = mode === "tui" || mode === "rpc";
      await h.emit("session_start", {});
      await h.start();
      await h.started;
      assert.equal(lifecycleLogs(h).filter((line) => line.includes("ready:")).length, 0);
      const before = h.manager.getBranch();
      h.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await h.start();
      const notices = lifecycleLogs(h).filter((line) => line.includes("ready:"));
      assert.equal(notices.length, h.ctx.hasUI ? 1 : 0);
      if (h.ctx.hasUI) {
        assert.match(notices[0], /run \/compact/);
        assert.match(notices[0], /History is unchanged/);
      }
      assert.deepEqual(h.manager.getBranch(), before);
      assert.equal(h.fetches, 1);
      assert.equal(h.sentMessages.length, 0);
      assert.equal(h.sentUserMessages.length, 0);
      await h.emit("session_shutdown", {});
    });

for (const customInstructions of ["Keep task details", "  Keep task details  "])
  test(`manual custom instructions bypass a ready checkpoint: ${JSON.stringify(customInstructions)}`, async () => {
    const h = fixture();
    await h.emit("session_start", {});
    await h.start();
    await h.started;
    h.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    h.manager.appendMessage({ role: "user", content: "fresh foreground tail", timestamp: 3 });
    const result = await h.compact("manual", undefined, customInstructions);
    assert.ok(result && typeof result === "object" && "compaction" in result);
    assert.equal(h.fetches, 2);
    assert.match(JSON.stringify(h.captured[1]), /fresh foreground tail/);
    await h.emit("session_shutdown", {});
  });

test("plain manual compaction adopts ready Context Management once without continuation", async () => {
  const h = fixture({ protocol: "context-management" });
  await h.emit("session_start", {});
  await h.emit("before_agent_start", {});
  await h.start();
  await h.started;
  h.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const result = (await h.compact("manual", undefined, "  ")) as {
    compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown };
  };
  assert.equal(h.fetches, 1);
  assert.equal(latestCheckpoint(h.manager.getBranch()), undefined);
  const id = h.manager.appendCompaction(
    result.compaction.summary,
    result.compaction.firstKeptEntryId,
    result.compaction.tokensBefore,
    result.compaction.details,
  );
  await h.emit("session_compact", {
    fromExtension: true,
    reason: "manual",
    willRetry: false,
    compactionEntry: h.manager.getEntry(id),
  });
  assert.equal(
    await h.emit("agent_before_settle", {
      outcome: "completed",
      entries: [],
      continue: false,
      context: { canContinue: false, contextMessages: h.manager.buildSessionContext().messages },
    }),
    undefined,
  );
  await h.compact("manual");
  assert.equal(h.fetches, 2, "a consumed ready checkpoint cannot be reused again");
  assert.equal(h.sentMessages.length, 0);
  assert.equal(h.sentUserMessages.length, 0);
  await h.emit("session_shutdown", {});
});

test("manual waiting falls back to a fresh request after preparation fails", async () => {
  const h = fixture({ maxRetries: 0 });
  await h.emit("session_start", {});
  h.failOnce();
  await h.start();
  await h.started;
  const pending = h.compact("manual");
  h.release();
  const result = await pending;
  assert.ok(result && typeof result === "object" && "compaction" in result);
  assert.equal(h.fetches, 2);
  await h.emit("session_shutdown", {});
});

for (const cancellation of ["resolve-race", "session-switch"] as const)
  test(`manual wait ${cancellation} cannot apply or start a replacement request`, async () => {
    const h = fixture();
    await h.emit("session_start", {});
    await h.start();
    await h.started;
    const abort = new AbortController();
    const pending = h.compact("manual", abort.signal);
    if (cancellation === "resolve-race") {
      h.release();
      abort.abort();
    } else {
      await h.emit("session_before_switch", {});
      h.release();
    }
    assert.deepEqual(await pending, { cancel: true });
    assert.equal(h.fetches, 1);
    assert.equal(latestCheckpoint(h.manager.getBranch()), undefined);
    await h.emit("session_shutdown", {});
  });

test("manual custom instructions replace pending preparation rather than waiting", async () => {
  const h = fixture();
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  const pending = h.compact("manual", undefined, "Preserve custom task details");
  await vi.waitFor(() => assert.equal(h.fetches, 2));
  assert.equal(h.requestSignals[0].aborted, true);
  h.release();
  const result = await pending;
  assert.ok(result && typeof result === "object" && "compaction" in result);
  assert.equal(h.fetches, 2);
  await h.emit("session_shutdown", {});
});
