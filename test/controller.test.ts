import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createBackgroundCompactionExtension } from "../src/background-compaction.js";
import {
  COMPACTION_ENGINE_AVAILABLE,
  COMPACTION_ENGINE_REQUEST,
  type CompactionEngineRequest,
  type CompactionEngineV1,
  type PreparedCheckpoint,
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
  const statuses: (string | undefined)[] = [];
  let onNotify: ((message: string) => void) | undefined;
  const context = (id: string, signal = new AbortController().signal) =>
    ({
      sessionManager: { getSessionId: () => id },
      hasUI: true,
      mode: "tui",
      signal,
      ui: {
        setStatus: (_key: string, value: string | undefined) => statuses.push(value),
        notify: (message: string) => {
          notices.push(message);
          onNotify?.(message);
        },
      },
      getContextUsage: () => ({ tokens: 70, contextWindow: 100 }),
      isIdle: () => false,
      hasPendingMessages: () => false,
    }) as unknown as ExtensionContext;
  const run = new AbortController();
  const ctx = context("one", run.signal);
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
    statuses,
    commands,
    run,
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

test("default threshold starts at 70%, not below, without an enable step", async () => {
  const h = fixture();
  await h.emit("session_start");
  h.ctx.getContextUsage = () => ({ tokens: 69, contextWindow: 100, percent: 69 });
  await h.turn();
  assert.equal(h.starts, 0);
  h.ctx.getContextUsage = () => ({ tokens: 70, contextWindow: 100, percent: 70 });
  await h.turn();
  await drain();
  assert.equal(h.starts, 1);
  assert.ok(h.notices.some((message) => message.includes("Async compaction")));
  await h.emit("session_shutdown");
});

test("saved Off and an unavailable engine prevent preparation with on-by-default settings", async () => {
  const h = fixture();
  h.settings.asyncEnabled = false;
  await h.emit("session_start");
  await h.turn();
  assert.equal(h.starts, 0);
  h.settings.asyncEnabled = true;
  h.engine.available = () => false;
  await h.turn();
  assert.equal(h.starts, 0);
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

test("one preparation warning shows safe cause and elapsed time", async () => {
  const h = fixture();
  const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
  h.engine.capture = () => ({
    requestTimeoutMs: 500,
    isCurrent: () => true,
    start: async () => {
      clock.mockReturnValue(3500);
      return { usable: false, failure: "HTTP 429: rate limited" } as PreparedCheckpoint;
    },
  });
  try {
    await h.emit("session_start");
    await h.turn();
    await drain();
    const warning = h.notices.find((message) => message.includes("Warm-ahead paused"));
    const log = h.notices.find((message) => message.includes("Async compaction failed"));
    assert.match(warning ?? "", /HTTP 429: rate limited \(elapsed: 2\.5s\)/);
    assert.match(log ?? "", /HTTP 429: rate limited \(elapsed: 2\.5s\)/);
    assert.equal(warning, log, "the failure and pause belong to the same copyable warning");
    assert.equal(h.notices.filter((message) => message.includes("Async compaction failed")).length, 1);
    assert.match(warning ?? "", /diagnostics unavailable/i);
  } finally {
    clock.mockRestore();
    await h.emit("session_shutdown");
  }
});

test("engine failure display is bounded and terminal safe", async () => {
  const h = fixture();
  h.engine.capture = () => ({
    requestTimeoutMs: 500,
    isCurrent: () => true,
    start: async () =>
      ({ usable: false, failure: `HTTP 500\n\u001b[31m\u202e ${"x".repeat(1000)}` }) as PreparedCheckpoint,
  });
  await h.emit("session_start");
  await h.turn();
  await drain();
  const warning = h.notices.find((message) => message.includes("Warm-ahead paused")) ?? "";
  assert.match(warning, /HTTP 500/);
  assert.match(warning, /elapsed: \d+\.\ds/);
  assert.ok(
    Array.from(warning).every((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code === 10 || (code >= 32 && (code < 127 || code > 159) && code !== 0x202e);
    }),
  );
  assert.doesNotMatch(warning, /x{201}/);
  await h.emit("session_shutdown");
});

test("unexpected rejected engine error is not exposed in the pause warning", async () => {
  const h = fixture();
  h.engine.capture = () => ({
    requestTimeoutMs: 500,
    isCurrent: () => true,
    start: async () => {
      throw new Error("Bearer PRIVATE-CREDENTIAL\nconversation-private-text");
    },
  });
  await h.emit("session_start");
  await h.turn();
  await drain();
  assert.match(h.notices.join("\n"), /engine returned no safe diagnostic.*elapsed:/);
  assert.doesNotMatch(h.notices.join("\n"), /PRIVATE-CREDENTIAL|conversation-private-text/);
  await h.emit("session_shutdown");
});

test("cancelled preparation does not emit a failure pause", async () => {
  const h = fixture();
  const run = new AbortController();
  const ctx = { ...h.ctx, signal: run.signal } as ExtensionContext;
  h.engine.capture = () => ({
    requestTimeoutMs: 500,
    isCurrent: () => true,
    start: async () => new Promise<PreparedCheckpoint>(() => {}),
  });
  await h.emit("session_start", {}, ctx);
  await h.turn(ctx);
  run.abort();
  await drain();
  assert.doesNotMatch(h.notices.join("\n"), /Warm-ahead paused|Async compaction failed/);
  await h.emit("session_shutdown", {}, ctx);
});

test("live diagnostics update status, warn once, and retain the last failure after resume", async () => {
  vi.useFakeTimers();
  try {
    const h = fixture();
    let finish!: (value: PreparedCheckpoint) => void;
    let status = "attempt=1 elapsed=0s";
    let report = "safe report\nattempt=1";
    let warning: string | undefined;
    h.engine.capture = () => ({
      requestTimeoutMs: 60_000,
      isCurrent: () => true,
      diagnostics: () => ({ status, report, warning }),
      start: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await h.emit("session_start");
    await h.turn();
    assert.equal(h.statuses.at(-1), status);
    status = "attempt=2 elapsed=5s";
    warning = "No data for 5 minutes; still waiting. No timeout triggered.";
    await vi.advanceTimersByTimeAsync(5_000);
    assert.equal(h.statuses.at(-1), status);
    await vi.advanceTimersByTimeAsync(5_000);
    assert.equal(h.notices.filter((notice) => notice.includes(warning ?? "missing")).length, 1);
    report = "safe report\nattempt=1 body=eof\nattempt=2 body=eof";
    finish({ usable: false, failure: "incomplete response" } as PreparedCheckpoint);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(vi.getTimerCount(), 0);
    const failures = h.notices.filter((notice) => notice.includes("Async compaction failed"));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /Warm-ahead paused[\s\S]*safe report[\s\S]*attempt=2 body=eof/);
    assert.equal(h.notices.filter((notice) => notice.includes("safe report")).length, 1);
    const command = h.commands.get("background-compaction") as { handler(args: string, ctx: unknown): Promise<void> };
    await command.handler("diagnostics", h.ctx);
    assert.match(h.notices.at(-1) ?? "", /attempt=1 body=eof\nattempt=2 body=eof/);
    await command.handler("resume", h.ctx);
    await command.handler("diagnostics", h.ctx);
    assert.match(h.notices.at(-1) ?? "", /Last failed preparation/);
    assert.match(h.notices.at(-1) ?? "", /attempt=2 body=eof/);
    await h.emit("session_shutdown");
  } finally {
    vi.useRealTimers();
  }
});

for (const event of ["session_before_switch", "session_shutdown", "run-abort"])
  test(`diagnostic polling stops on ${event} even if the provider never settles`, async () => {
    vi.useFakeTimers();
    try {
      const h = fixture();
      let reads = 0;
      h.engine.capture = () => ({
        requestTimeoutMs: 60_000,
        isCurrent: () => true,
        diagnostics: () => ({ status: `read=${++reads}`, report: "safe" }),
        start: () => new Promise(() => {}),
      });
      await h.emit("session_start");
      await h.turn();
      if (event === "run-abort") h.run.abort();
      else await h.emit(event);
      await vi.advanceTimersByTimeAsync(0);
      const settledReads = reads;
      await vi.advanceTimersByTimeAsync(10_000);
      assert.equal(reads, settledReads);
      assert.equal(vi.getTimerCount(), 0);
      if (event !== "session_shutdown") await h.emit("session_shutdown");
    } finally {
      vi.useRealTimers();
    }
  });

test("older engines have no progress polling timer", async () => {
  vi.useFakeTimers();
  try {
    const h = fixture();
    h.engine.capture = () => ({
      requestTimeoutMs: 60_000,
      isCurrent: () => true,
      start: () => new Promise(() => {}),
    });
    await h.emit("session_start");
    await h.turn();
    assert.equal(vi.getTimerCount(), 1); // Existing request deadline only.
    await h.emit("session_shutdown");
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

test("diagnostics remain optional when the getter itself throws", async () => {
  const h = fixture();
  const original = h.engine.capture;
  h.engine.capture = (ctx) => {
    const preparation = original(ctx);
    assert.ok(preparation);
    Object.defineProperty(preparation, "diagnostics", {
      get: () => {
        throw new Error("PRIVATE-CREDENTIAL");
      },
    });
    return preparation;
  };
  await h.emit("session_start");
  await h.turn();
  await drain();
  assert.match(h.notices.join("\n"), /Async compaction ready/);
  assert.doesNotMatch(h.notices.join("\n"), /PRIVATE-CREDENTIAL/);
  await h.emit("session_shutdown");
});

test("progress polling cancels stale settings without waiting for the provider", async () => {
  vi.useFakeTimers();
  try {
    const h = fixture();
    h.engine.capture = () => ({
      requestTimeoutMs: 60_000,
      isCurrent: () => true,
      diagnostics: () => ({ status: "Preparing", report: "safe" }),
      start: () => new Promise(() => {}),
    });
    await h.emit("session_start");
    await h.turn();
    h.settings.asyncThresholdPercent = 80;
    await vi.advanceTimersByTimeAsync(5_000);
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(h.statuses.at(-1), undefined);
    assert.doesNotMatch(h.notices.join("\n"), /Warm-ahead paused/);
    await h.emit("session_shutdown");
  } finally {
    vi.useRealTimers();
  }
});

test("failure warning includes companion version and captured settings even with lifecycle logs off", async () => {
  const h = fixture();
  h.settings.logCompaction = false;
  h.engine.capture = () => ({
    requestTimeoutMs: 60_000,
    isCurrent: () => true,
    start: async () => ({ usable: false, failure: "incomplete response" }) as PreparedCheckpoint,
  });
  await h.emit("session_start");
  await h.turn();
  await drain();
  const warning = h.notices.find((notice) => notice.includes("Warm-ahead paused"));
  assert.match(warning ?? "", /companion=\d+\.\d+\.\d+ background=on threshold=70% autoApply=on lifecycleLogs=off/);
  assert.equal(h.notices.filter((notice) => notice.includes("Async compaction failed")).length, 1);
  await h.emit("session_shutdown");
});

test("progress appears when an optional diagnostic getter becomes ready after startup", async () => {
  vi.useFakeTimers();
  try {
    const h = fixture();
    let ready = false;
    h.engine.capture = () => ({
      requestTimeoutMs: 60_000,
      isCurrent: () => true,
      diagnostics: () => (ready ? { status: "stream elapsed=5s", report: "safe" } : undefined) as never,
      start: () => new Promise(() => {}),
    });
    await h.emit("session_start");
    await h.turn();
    assert.equal(h.statuses.at(-1), "Preparing compaction…");
    ready = true;
    await vi.advanceTimersByTimeAsync(5_000);
    assert.equal(h.statuses.at(-1), "stream elapsed=5s");
    await h.emit("session_shutdown");
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

for (const mode of ["missing", "throwing", "delayed"] as const)
  test(`combined failure handles ${mode} diagnostics without reproduction or raw errors`, async () => {
    const h = fixture();
    h.settings.logCompaction = false;
    let final = false;
    h.engine.capture = () => {
      const preparation = {
        requestTimeoutMs: 60_000,
        isCurrent: () => true,
        start: async (guard: { failureReportOwner?: "consumer" }) => {
          assert.equal(guard.failureReportOwner, "consumer");
          final = true;
          return { usable: false, failure: "provider stream failed" } as PreparedCheckpoint;
        },
      };
      if (mode !== "missing")
        Object.defineProperty(preparation, "diagnostics", {
          get: () => {
            if (mode === "throwing") throw new Error("PRIVATE-DIAGNOSTIC-CREDENTIAL");
            return () =>
              final ? { status: "failed", report: "Compaction diagnostics schema=2\nbody=pipe-error" } : undefined;
          },
        });
      return preparation;
    };
    await h.emit("session_start");
    await h.turn();
    await drain();
    const failures = h.notices.filter((notice) => notice.includes("Async compaction failed"));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /Warm-ahead paused/);
    assert.match(failures[0], /companion=\d+\.\d+\.\d+/);
    if (mode === "delayed") assert.match(failures[0], /Compaction diagnostics schema=2\nbody=pipe-error/);
    else assert.match(failures[0], /diagnostics unavailable/i);
    assert.doesNotMatch(h.notices.join("\n"), /PRIVATE-DIAGNOSTIC-CREDENTIAL/);
    const command = h.commands.get("background-compaction") as { handler(args: string, ctx: unknown): Promise<void> };
    await command.handler("resume", h.ctx);
    await command.handler("diagnostics", h.ctx);
    assert.match(h.notices.at(-1) ?? "", /Last failed preparation/);
    if (mode === "delayed") assert.match(h.notices.at(-1) ?? "", /body=pipe-error/);
    else assert.match(h.notices.at(-1) ?? "", /diagnostics unavailable/i);
    await h.emit("session_shutdown");
  });

test("a failed final diagnostics read labels the retained snapshot instead of exposing the exception", async () => {
  const h = fixture();
  let finish!: (value: PreparedCheckpoint) => void;
  let settled = false;
  h.engine.capture = () => ({
    requestTimeoutMs: 60_000,
    isCurrent: () => true,
    diagnostics() {
      if (settled) throw new Error("PRIVATE-FINAL-GETTER");
      return { status: "stream", report: "safe earlier snapshot" };
    },
    start: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await h.emit("session_start");
  await h.turn();
  settled = true;
  finish({ usable: false, failure: "stream failed" } as PreparedCheckpoint);
  await drain();
  const failures = h.notices.filter((notice) => notice.includes("Async compaction failed"));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Final diagnostic snapshot unavailable; last available diagnostics follow/);
  assert.match(failures[0], /safe earlier snapshot/);
  assert.doesNotMatch(failures[0], /PRIVATE-FINAL-GETTER/);
  await h.emit("session_shutdown");
});

for (const logging of [true, false])
  test(`an unusable result without a failure keeps the existing no-pause policy with logs=${logging}`, async () => {
    const h = fixture();
    h.settings.logCompaction = logging;
    h.engine.capture = () => ({
      requestTimeoutMs: 60_000,
      isCurrent: () => true,
      diagnostics: () => ({ status: "not usable", report: "safe unusable-result report" }),
      start: async () => ({ usable: false }) as PreparedCheckpoint,
    });
    await h.emit("session_start");
    await h.turn();
    await drain();
    assert.doesNotMatch(h.notices.join("\n"), /Warm-ahead paused/);
    const failures = h.notices.filter((notice) => notice.includes("Async compaction failed"));
    assert.equal(failures.length, logging ? 1 : 0);
    if (logging) assert.match(failures[0], /safe unusable-result report/);
    const command = h.commands.get("background-compaction") as { handler(args: string, ctx: unknown): Promise<void> };
    await command.handler("resume", h.ctx);
    assert.match(h.notices.at(-1) ?? "", /Warm-ahead is not paused/);
    await command.handler("diagnostics", h.ctx);
    assert.match(h.notices.at(-1) ?? "", /safe unusable-result report/);
    await h.emit("session_shutdown");
  });
