import assert from "node:assert/strict";
import type { CompactionEntryDraft } from "@earendil-works/pi-coding-agent";
import { captureExactCompactionBranch } from "@integration/engine/compaction-ownership.js";
import { test, vi } from "vitest";
import { deferred, fixture, model } from "./async-compaction-fixture.js";

async function ready(logCompaction = true, chatgpt = false) {
  const h = fixture({ asyncAutoApply: true, logCompaction });
  if (chatgpt) {
    h.ctx.model = { ...model, api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1" };
    h.ctx.modelRegistry.getProviderAuth = async () => ({ source: "OAuth", auth: { apiKey: "fixture-key" } });
    const leaf = h.manager.getLeafId();
    assert.ok(leaf);
    h.manager.appendCompaction("prior summary", leaf, 80_000);
  }
  await h.emit("session_start", {});
  await h.start();
  await h.started;
  h.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.ctx.isIdle = () => false;
  return h;
}

test("exact boundary guard compares persisted values and rejects even bookkeeping appends", () => {
  const h = fixture();
  const captured = h.manager.getBranch();
  const valid = captureExactCompactionBranch(captured);
  captured.length = 0;
  assert.equal(valid(structuredClone(h.manager.getBranch())), true);
  const entry = h.manager.getEntry(h.first);
  assert.ok(entry?.type === "message" && entry.message.role === "user");
  entry.message.content = "same identity, changed bytes";
  assert.equal(valid(h.manager.getBranch()), false);
  entry.message.content = "snapshot user";
  h.manager.appendCustomEntry("bookkeeping", {});
  assert.equal(valid(h.manager.getBranch()), false);
});

test("turn boundaries never serialize raw histories, archived bodies, or superseded blobs", async () => {
  const h = fixture({ asyncAutoApply: true });
  h.manager.appendCompaction("older native summary", h.first, 80_000, { blob: "SUPERSEDED-BLOB" });
  h.manager.appendMessage({ role: "user", content: "ARCHIVED-BODY", timestamp: 3 });
  const active = h.manager.appendMessage({ role: "user", content: "active tail", timestamp: 4 });
  h.manager.appendCompaction("latest native summary", active, 80_000);
  await h.emit("session_start", {});
  let wholeHistories = 0;
  let archivedPayloads = 0;
  const stringify = JSON.stringify;
  const spy = vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((entry) => entry && typeof entry === "object" && "id" in entry && "parentId" in entry)
    )
      wholeHistories += 1;
    const result = stringify(value, ...args);
    if (result && /ARCHIVED-BODY|SUPERSEDED-BLOB/.test(result)) archivedPayloads += 1;
    return result;
  });
  try {
    await h.start();
    await h.started;
    h.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(await h.start());
    assert.equal(wholeHistories, 0, "do not reintroduce an eager or retained full-history JSON string");
    assert.equal(archivedPayloads, 0, "irrelevant archived bodies and superseded payloads are never fingerprinted");
    assert.equal(h.fetches, 1);
  } finally {
    spy.mockRestore();
    h.release();
    await h.emit("session_shutdown", {});
  }
});

for (const [logging, hasUI] of [
  [true, true],
  [false, true],
  [true, false],
] as const)
  test(`application timings wait for commit and honor logging=${logging}, UI=${hasUI}`, async () => {
    const h = await ready(logging);
    h.ctx.hasUI = hasUI;
    const secret = "PRIVATE-SUFFIX";
    h.manager.appendMessage({ role: "user", content: secret, timestamp: 3 });
    try {
      const result = (await h.start()) as { entries: CompactionEntryDraft[] };
      assert.ok(result?.entries[0]);
      assert.equal(
        h.notifications.some(({ message }) => message.includes("application timing:")),
        false,
      );
      const draft = result.entries[0];
      h.manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 70_000, draft.details, true, draft.usage);
      await h.emit("turn_start", {});
      await h.emit("turn_start", {});
      const notices = h.notifications.filter(({ message }) => message.includes("application timing:"));
      assert.equal(notices.length, logging && hasUI ? 1 : 0);
      if (notices[0]) {
        assert.match(
          notices[0].message,
          /extensionTotal=\d+\.\dms, boundary=\d+\.\dms, validation=\d+\.\dms, preparedWait=\d+\.\dms, authWait=\d+\.\dms, rebind=\d+\.\dms, preview=\d+\.\dms, validations=7\./,
        );
        assert.doesNotMatch(notices[0].message, /PRIVATE-|fixture-key|example\.test|[a-f0-9]{64}/);
      }
      assert.equal(h.fetches, 1);
    } finally {
      await h.emit("session_shutdown", {});
    }
  });

test("rejected application timing contains no authentication error or history", async () => {
  const h = await ready();
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
    throw new Error("PRIVATE-AUTH-ERROR");
  };
  try {
    assert.equal(await h.start(), undefined);
    const notices = h.notifications.filter(({ message }) => message.includes("application timing:"));
    assert.equal(notices.length, 1);
    assert.doesNotMatch(notices[0].message, /PRIVATE-|fixture-key|example\.test|[a-f0-9]{64}/);
    assert.equal(h.fetches, 1);
  } finally {
    await h.emit("session_shutdown", {});
  }
});

test("notification callbacks run before the final draft validation", async () => {
  const h = await ready();
  const notify = h.ctx.ui.notify;
  h.ctx.ui.notify = (message, type) => {
    notify(message, type);
    if (message.includes("reusing the async checkpoint at the turn boundary"))
      h.manager.appendCustomEntry("reentrant-notification", {});
  };
  try {
    assert.equal(await h.start(), undefined);
    assert.equal(h.fetches, 1);
    assert.equal(
      h.manager.getBranch().some((entry) => entry.type === "compaction"),
      false,
    );
  } finally {
    await h.emit("session_shutdown", {});
  }
});

for (const phase of ["getApiKeyAndHeaders", "getProviderAuth"] as const)
  for (const change of ["hidden", "active", "append", "projection", "owner"] as const)
    test(`ChatGPT boundary ${change === "hidden" ? "accepts archived" : "rejects"} ${change} across ${phase}`, async () => {
      const h = await ready(true, true);
      const started = deferred<void>();
      const release = deferred<void>();
      const registry = h.ctx.modelRegistry;
      // Both public lookup methods use different parameter types; keep each
      // replacement typed at its own boundary rather than weakening the registry.
      if (phase === "getApiKeyAndHeaders") {
        const getAuth = registry.getApiKeyAndHeaders.bind(registry);
        registry.getApiKeyAndHeaders = async (...args) => {
          started.resolve();
          await release.promise;
          return getAuth(...args);
        };
      } else {
        const getAuth = registry.getProviderAuth.bind(registry);
        registry.getProviderAuth = async (...args) => {
          started.resolve();
          await release.promise;
          return getAuth(...args);
        };
      }
      const applying = h.start();
      try {
        await started.promise;
        if (change === "hidden") {
          const entry = h.manager.getEntry(h.first);
          assert.ok(entry?.type === "message" && entry.message.role === "user");
          entry.message.content = "same-ID hidden mutation";
        } else if (change === "active") {
          const entry = h.manager
            .getBranch()
            .find((entry) => entry.type === "message" && entry.message.role === "assistant");
          assert.ok(entry?.type === "message" && entry.message.role === "assistant");
          entry.message.content = [{ type: "text", text: "changed active assistant" }];
        } else if (change === "append") h.manager.appendCustomEntry("racing-bookkeeping", {});
        else if (change === "projection") h.manager.appendContextEdit(h.first, { content: "changed snapshot" });
        else await h.emit("session_start", {});
        release.resolve();
        if (change === "hidden") assert.ok(await applying);
        else assert.equal(await applying, undefined);
        assert.equal(h.fetches, 1);
        assert.equal(h.manager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
      } finally {
        release.resolve();
        await h.emit("session_shutdown", {});
      }
    });

for (const [mode, callback] of [
  ["ready", "notify"],
  ["ready", "cleanup"],
  ["foreground", "cleanup"],
] as const)
  for (const change of ["body", "prompt", "tools", "owner"] as const)
    test(`${mode} manual handoff rejects ${change} mutation from ${callback} callbacks`, async () => {
      const h = mode === "ready" ? await ready() : fixture({ logCompaction: true });
      if (mode === "foreground") {
        await h.emit("session_start", {});
        h.release();
      }
      let mutated = false;
      const mutate = () => {
        mutated = true;
        if (change === "prompt") h.setPrompt("changed after preparation");
        else if (change === "tools") h.rawPi.setActiveTools(["read"]);
        else if (change === "owner") void h.emit("session_shutdown", {});
        else {
          const entry = h.manager.getEntry(h.first);
          assert.ok(entry?.type === "message" && entry.message.role === "user");
          entry.message.content = "changed after preparation";
        }
      };
      const notify = h.ctx.ui.notify;
      const setStatus = h.ctx.ui.setStatus;
      if (callback === "notify") {
        h.ctx.ui.notify = (message, type) => {
          notify(message, type);
          if (message.includes("Actual compaction is reusing the async checkpoint.")) mutate();
        };
      }
      h.ctx.ui.setStatus = (key, value) => {
        setStatus(key, value);
        if (callback === "cleanup" && value === undefined && !mutated) mutate();
      };
      try {
        assert.deepEqual(await h.compact("manual"), { cancel: true });
        assert.equal(mutated, true);
        assert.equal(h.fetches, 1);
        assert.equal(
          h.manager.getBranch().some((entry) => entry.type === "compaction"),
          false,
        );
      } finally {
        h.ctx.ui.setStatus = setStatus;
        await h.emit("session_shutdown", {});
      }
    });

test("continuation bookkeeping cannot run mutable callbacks after the final foreground guard", async () => {
  const h = await ready();
  await h.emit("before_agent_start", {});
  let reuse = false;
  let cleanup = false;
  let reads = 0;
  let mutated = false;
  const notify = h.ctx.ui.notify;
  const setStatus = h.ctx.ui.setStatus;
  const get = h.runtime.get;
  h.ctx.ui.notify = (message, type) => {
    notify(message, type);
    if (message.includes("Actual compaction is reusing the async checkpoint.")) reuse = true;
  };
  h.ctx.ui.setStatus = (key, value) => {
    setStatus(key, value);
    if (reuse && value === undefined) cleanup = true;
  };
  h.runtime.get = () => {
    if (cleanup && ++reads === 2) {
      const entry = h.manager.getEntry(h.first);
      assert.ok(entry?.type === "message" && entry.message.role === "user");
      entry.message.content = "changed by continuation settings callback";
      mutated = true;
    }
    return get();
  };
  try {
    assert.deepEqual(await h.compact("threshold"), { cancel: true });
    assert.equal(mutated, true);
    assert.equal(h.fetches, 1);
  } finally {
    h.runtime.get = get;
    h.ctx.ui.setStatus = setStatus;
    await h.emit("session_shutdown", {});
  }
});
