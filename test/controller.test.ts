import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createBackgroundCompactionExtension } from "../src/background-compaction.js";
import {
  COMPACTION_ENGINE_AVAILABLE,
  COMPACTION_ENGINE_REQUEST,
  type CompactionEngineRequest,
  type CompactionEngineV1,
  type PreparedCompactionSource,
} from "../src/prepared-compaction-protocol.js";
import { type BackgroundCompactionSettingsRuntime, DEFAULT_BACKGROUND_COMPACTION_SETTINGS } from "../src/settings.js";

type Hook = (event: never, ctx: ExtensionContext) => unknown;
function fixture(order: "first" | "last" | "absent" = "first") {
  const hooks = new Map<string, Hook[]>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const commands = new Map<string, unknown>();
  const events = {
    on(name: string, listener: (value: unknown) => void) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    emit(name: string, value: unknown) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(value);
    },
  };
  const api = {
    events,
    on(name: string, hook: Hook) {
      hooks.set(name, [...(hooks.get(name) ?? []), hook]);
    },
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  const settings = {
    ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
    asyncEnabled: true,
    asyncAutoApply: true,
    logCompaction: true,
  };
  const state = { kind: "loaded" as const, path: "fixture.json", settings };
  const runtime = {
    get: () => state,
    reload: async () => state,
    flush: async () => undefined,
  } as BackgroundCompactionSettingsRuntime;
  let source: PreparedCompactionSource | undefined;
  let starts = 0;
  let attached = 0;
  let detached = 0;
  let revision = 0;
  let committed: string | undefined;
  const engine: CompactionEngineV1 = {
    version: 1,
    available: () => true,
    checkpointId: () => committed,
    captureBoundary: () => {
      const before = revision;
      return () => before === revision;
    },
    capture: () => ({
      requestTimeoutMs: 500,
      isCurrent: () => true,
      start: async () => {
        starts += 1;
        return {
          usable: true,
          checkpointId: "checkpoint",
          adopt: async () => ({ kind: "cancel" as const }),
          draft: async () => ({
            checkpointId: "checkpoint",
            draft: { type: "compaction" as const, summary: "summary", firstKeptEntryId: "entry", details: {} },
          }),
        };
      },
    }),
    attachSource(value) {
      if (source) throw new Error("duplicate");
      source = value;
      attached += 1;
      let live = true;
      return () => {
        if (live) {
          live = false;
          source = undefined;
          detached += 1;
        }
      };
    },
  };
  const installEngine = () => {
    events.on(COMPACTION_ENGINE_REQUEST, (request) => (request as CompactionEngineRequest).accept(engine));
    events.emit(COMPACTION_ENGINE_AVAILABLE, engine);
  };
  if (order === "first") installEngine();
  const installController = () => createBackgroundCompactionExtension({ settingsRuntime: runtime })(api);
  installController();
  if (order === "last") installEngine();
  const notices: string[] = [];
  let onNotify: ((message: string) => void) | undefined;
  const context = (id: string) =>
    ({
      sessionManager: { getSessionId: () => id },
      hasUI: true,
      mode: "tui",
      signal: new AbortController().signal,
      ui: {
        setStatus: () => undefined,
        notify: (message: string) => {
          notices.push(message);
          onNotify?.(message);
        },
      },
      getContextUsage: () => ({ tokens: 70, contextWindow: 100 }),
      isIdle: () => false,
      hasPendingMessages: () => false,
    }) as unknown as ExtensionContext;
  const ctx = context("one");
  const emit = async (name: string, event: unknown = {}, target = ctx) => {
    let result: unknown;
    for (const hook of hooks.get(name) ?? []) {
      const next = await hook(event as never, target);
      if (next !== undefined) result = next;
    }
    return result;
  };
  const turn = (target = ctx) => emit("turn_end", { outcome: "completed", entries: [] }, target);
  return {
    engine,
    events,
    context,
    ctx,
    settings,
    notices,
    emit,
    turn,
    installController,
    installEngine,
    get starts() {
      return starts;
    },
    get attached() {
      return attached;
    },
    get detached() {
      return detached;
    },
    get source() {
      return source;
    },
    listenerCount: () => listeners.get(COMPACTION_ENGINE_AVAILABLE)?.size ?? 0,
    commit: () => {
      committed = "checkpoint";
    },
    mutate: () => {
      revision += 1;
    },
    setNotify: (callback: (message: string) => void) => {
      onNotify = callback;
    },
  };
}
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const order of ["first", "last"] as const)
  test(`engine discovery is load-order neutral (${order})`, async () => {
    const h = fixture(order);
    await h.emit("session_start");
    await h.turn();
    await drain();
    assert.equal(h.starts, 1);
    assert.equal(h.attached, 1);
    await h.emit("session_shutdown");
    assert.equal(h.detached, 1);
    assert.equal(h.listenerCount(), 0);
  });

test("absent engine remains passive and explains enabled-but-unavailable state", async () => {
  const h = fixture("absent");
  await h.emit("session_start");
  await h.turn();
  assert.equal(h.starts, 0);
  assert.ok(h.notices.some((message) => message.includes("no compatible compaction engine")));
  await h.emit("session_shutdown");
});

test("duplicate companion cannot register a second controller or request", async () => {
  const h = fixture();
  h.installController();
  await h.emit("session_start");
  await h.turn();
  await drain();
  assert.equal(h.starts, 1);
  assert.equal(h.attached, 1);
  assert.ok(h.notices.some((message) => message.includes("already attached")));
  await h.emit("session_shutdown");
  assert.equal(h.detached, 1);
});

test("shutdown/restart removes subscriptions and reconnects exactly once", async () => {
  const h = fixture();
  await h.emit("session_start");
  await h.emit("session_shutdown");
  assert.equal(h.listenerCount(), 0);
  assert.equal(h.source, undefined);
  await h.emit("session_start");
  await h.turn();
  await drain();
  assert.equal(h.listenerCount(), 1);
  assert.equal(h.attached, 2);
  assert.equal(h.starts, 1);
  await h.emit("session_shutdown");
});

test("one manager shutting down does not disconnect another live manager", async () => {
  const h = fixture();
  const other = h.context("two");
  await h.emit("session_start");
  await h.emit("session_start", {}, other);
  await h.emit("session_shutdown");
  assert.equal(h.detached, 0);
  assert.equal(h.listenerCount(), 1);
  await h.turn(other);
  await drain();
  assert.equal(h.starts, 1);
  assert.ok(h.source);
  await h.emit("session_shutdown", {}, other);
  assert.equal(h.detached, 1);
  assert.equal(h.listenerCount(), 0);
});

test("returning a boundary draft is not a committed checkpoint", async () => {
  const h = fixture();
  await h.emit("session_start");
  await h.turn();
  await drain();
  assert.ok(await h.turn());
  assert.equal(
    h.notices.some((message) => message.includes("checkpoint committed")),
    false,
  );
  h.commit();
  await h.emit("turn_start");
  await h.emit("turn_start");
  assert.equal(h.notices.filter((message) => message.includes("checkpoint committed")).length, 1);
  await h.emit("session_shutdown");
});

test("reentrant notification invalidates the final boundary handoff", async () => {
  const h = fixture();
  await h.emit("session_start");
  await h.turn();
  await drain();
  h.setNotify((message) => {
    if (message.includes("reusing the async checkpoint")) h.mutate();
  });
  assert.equal(await h.turn(), undefined);
  assert.equal(
    h.notices.some((message) => message.includes("checkpoint committed")),
    false,
  );
  assert.equal(h.starts, 1);
  await h.emit("session_shutdown");
});
