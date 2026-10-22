import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { type ExtensionContext, type SessionBeforeCompactEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { createCodexCompactExtension } from "@integration/engine/codex-compact.js";
import {
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  DEFAULT_CODEX_COMPACT_SETTINGS,
} from "@integration/engine/settings.js";
import { createMockContext, createMockPi } from "@integration/support";
import { createBackgroundCompactionExtension } from "../src/background-compaction.js";
import { COMPACTION_ENGINE_REQUEST, type CompactionEngineV1 } from "../src/prepared-compaction-protocol.js";
import { DEFAULT_BACKGROUND_COMPACTION_SETTINGS } from "../src/settings.js";
export const model = {
  id: "fixture",
  name: "Fixture",
  provider: "fixture",
  api: "openai-codex-responses",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<"openai-codex-responses">;
const usage = {
  input: 65_000,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 65_001,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: 2,
  };
}
function response() {
  const item = { type: "compaction", encrypted_content: "opaque" };
  return new Response(
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
  );
}
export function fixture(overrides = {}, order: "core-first" | "background-first" | "core-only" = "core-first") {
  const mock = createMockPi();
  const manager = SessionManager.inMemory();
  const first = manager.appendMessage({ role: "user", content: "snapshot user", timestamp: 1 });
  manager.appendMessage(assistant("snapshot assistant"));
  let state: CodexCompactSettingsState = {
    kind: "loaded",
    path: "/tmp/test-async.json",
    settings: {
      ...DEFAULT_CODEX_COMPACT_SETTINGS,
      ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
      asyncEnabled: true,
      ...overrides,
    },
    document: {},
  };
  const runtime: CodexCompactSettingsRuntime = {
    get: () => structuredClone(state),
    reload: async () => structuredClone(state),
    update: async (patch) => {
      state = { ...state, settings: { ...state.settings, ...patch } };
      return structuredClone(state);
    },
    flush: async () => {},
  };
  // Keep the old test-facing update helper while presenting independent settings
  // to each owner, as the installed packages do in production.
  const scopedRuntime = (keys: string[]) => {
    const get = () => {
      const current = runtime.get();
      return {
        ...current,
        settings: Object.fromEntries(keys.map((key) => [key, current.settings[key as keyof typeof current.settings]])),
      };
    };
    return { get, reload: async () => get(), update: runtime.update, flush: runtime.flush };
  };
  const coreRuntime = scopedRuntime(Object.keys(DEFAULT_CODEX_COMPACT_SETTINGS));
  const backgroundRuntime = scopedRuntime(Object.keys(DEFAULT_BACKGROUND_COMPACTION_SETTINGS));
  const started = deferred<void>();
  const gate = deferred<void>();
  let paused = true;
  let fetches = 0;
  let apiKey = "fixture-key";
  let prompt = "system";
  let fail = false;
  let failCount = 0;
  let reply = response;
  let fetchOverride: (() => Promise<Response>) | undefined;
  const requestSignals: AbortSignal[] = [];
  const captured: unknown[] = [];
  const provider: Provider = {
    id: model.provider,
    name: "Fixture",
    auth: {} as Provider["auth"],
    getModels: () => [model],
    stream(active, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          captured.push(structuredClone(context.messages));
          await options?.onPayload?.(
            {
              model: active.id,
              input: context.messages.map((message) => ({
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text:
                      typeof message.content === "string"
                        ? message.content
                        : message.content
                            .filter((part) => part.type === "text")
                            .map((part) => part.text)
                            .join("\n"),
                  },
                ],
              })),
            },
            active,
          );
          const result = await options?.fetch?.("https://example.test/responses", {
            method: "POST",
            signal: options.signal,
          });
          for (const line of ((await result?.text()) ?? "").split("\n"))
            if (line.startsWith("data: ")) await options?.onProviderStreamEvent?.(JSON.parse(line.slice(6)), active);
          const message = assistant("done") as Extract<AgentMessage, { role: "assistant" }>;
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        } catch (error) {
          const message = { ...assistant(""), stopReason: "error", errorMessage: String(error) } as Extract<
            AgentMessage,
            { role: "assistant" }
          >;
          stream.push({ type: "error", reason: "error", error: message });
          stream.end(message);
        }
      })();
      return stream;
    },
    streamSimple() {
      throw new Error("unused");
    },
  };
  const mockCtx = createMockContext({
    model,
    mode: "tui",
    sessionManager: manager,
    getSystemPrompt: () => prompt,
    getContextUsage: () => ({ tokens: 65_000, contextWindow: 100_000, percent: 65 }),
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey }), getProvider: () => provider },
  });
  const ctx = mockCtx.ctx as ExtensionContext;
  if (order === "background-first")
    createBackgroundCompactionExtension({ settingsRuntime: backgroundRuntime as never })(mock.pi);
  createCodexCompactExtension({
    settingsRuntime: coreRuntime as never,
    fetch: async (_input, init) => {
      fetches += 1;
      requestSignals.push(init?.signal as AbortSignal);
      started.resolve();
      if (fetchOverride) return fetchOverride();
      if (paused) await gate.promise;
      if (fail || failCount-- > 0) throw new Error("fixture failure");
      return reply();
    },
  })(mock.pi);
  if (order === "core-first")
    createBackgroundCompactionExtension({ settingsRuntime: backgroundRuntime as never })(mock.pi);
  const emit = async (name: string, event: unknown) => {
    let result: unknown;
    for (const hook of mock.events.get(name) ?? []) {
      const next = await hook(event, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  };
  const compact = (
    reason: SessionBeforeCompactEvent["reason"] = "threshold",
    signal = new AbortController().signal,
    customInstructions?: string,
  ) =>
    emit("session_before_compact", {
      type: "session_before_compact",
      reason,
      customInstructions,
      willRetry: false,
      signal,
      branchEntries: manager.getBranch(),
      preparation: {
        firstKeptEntryId: manager.getLeafId() ?? first,
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 90_000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 1000 },
      },
    } satisfies SessionBeforeCompactEvent);
  return {
    ...mock,
    ...mockCtx,
    ctx,
    manager,
    first,
    runtime,
    provider,
    captured,
    requestSignals,
    started: started.promise,
    emit,
    compact,
    get fetches() {
      return fetches;
    },
    release() {
      paused = false;
      gate.resolve();
    },
    setKey(value: string) {
      apiKey = value;
    },
    setPrompt(value: string) {
      prompt = value;
    },
    fail() {
      fail = true;
    },
    failOnce() {
      failCount = 1;
    },
    setReply(value: () => Response) {
      reply = value;
    },
    setFetch(value: () => Promise<Response>) {
      fetchOverride = value;
    },
    engine() {
      let engine: CompactionEngineV1 | undefined;
      mock.eventBus.emit(COMPACTION_ENGINE_REQUEST, {
        accept(value: CompactionEngineV1) {
          engine = value;
        },
      });
      if (!engine) throw new Error("Prepared-compaction engine was not registered");
      return engine;
    },
    start: () => emit("turn_end", { outcome: "completed" }),
  };
}
