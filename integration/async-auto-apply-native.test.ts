import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, InMemoryCredentialStore, type Model, type Provider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { latestCheckpoint } from "@integration/engine/checkpoint.js";
import { test, vi } from "vitest";
import { createBackgroundCompactionExtension } from "../src/background-compaction.js";
import { DEFAULT_BACKGROUND_COMPACTION_SETTINGS } from "../src/settings.js";

const model: Model<Api> = {
  id: "recovery-native-runtime",
  name: "Recovery native fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
};
const usage = {
  input: 10,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 11,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function textResponse(text: string, inputTokens = 10): Response {
  const item = {
    type: "message",
    id: "msg",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return new Response(
    [
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp",
          status: "completed",
          output: [item],
          usage: { input_tokens: inputTokens, output_tokens: 1, total_tokens: inputTokens + 1 },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

for (const boundary of ["settled", "input"] as const) {
  test(`real Pi auto-apply at ${boundary}: commits once without extra inference or active abort`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-auto-apply-native-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    const releaseMaintenance = deferred();
    const maintenanceStarted = deferred();
    let remoteCalls = 0;
    let workCalls = 0;
    let compactEvents = 0;
    const workSignals: AbortSignal[] = [];
    const order: string[] = [];
    try {
      vi.resetModules();
      const { createCodexCompactExtension } = await import("@integration/engine/codex-compact.js");
      const { DEFAULT_CODEX_COMPACT_SETTINGS } = await import("@integration/engine/settings.js");
      const specifier = "@earendil-works/pi-ai/providers/openai";
      const { openaiProvider } = (await import(specifier)) as { openaiProvider(): Provider };
      const native = openaiProvider();
      const credentials = new InMemoryCredentialStore();
      await credentials.modify("openai", async () => ({ type: "api_key", key: "fixture" }));
      const modelRuntime = await ModelRuntime.create({
        credentials,
        modelsPath: null,
        modelsStorePath: join(directory, "models.json"),
        refreshOnCreate: false,
      });
      modelRuntime.registerNativeProvider({
        ...native,
        streamSimple: (active, context, options) =>
          native.streamSimple(active, context, {
            ...options,
            maxRetries: 0,
            fetch: async (_url, init) => {
              workCalls += 1;
              order.push(`work-${workCalls}`);
              if (init?.signal) workSignals.push(init.signal);
              return textResponse("Work completed", workCalls === 1 ? 65_000 : 10);
            },
          }),
      });
      const state = {
        kind: "loaded" as const,
        path: join(directory, "compact.json"),
        document: {},
        settings: {
          ...DEFAULT_CODEX_COMPACT_SETTINGS,
          ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
          protocol: "context-management" as const,
          maxRetries: 0,
          asyncEnabled: true,
          asyncAutoApply: true,
        },
      };
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 15_000, keepRecentTokens: 150 },
        retry: { enabled: false },
      });
      const observer = (pi: ExtensionAPI) => {
        // The warm request starts at turn_end; hold settlement to cover a Ready result there.
        pi.on("agent_before_settle", async () => {
          if (boundary === "settled" && workCalls === 1) {
            await maintenanceStarted.promise;
            releaseMaintenance.resolve();
            await vi.waitFor(() => assert.equal(remoteCalls, 1));
            // Drain provider parsing and the Ready promise before allowing settlement.
            for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
          }
        });
        pi.on("session_before_compact", async () => {
          assert.equal(session?.isStreaming, false);
          if (boundary === "settled") {
            await session?.prompt("Second task queued during application");
            assert.equal(workCalls, 1, "settled must defer incoming prompts until compaction commits");
          }
        });
        pi.on("session_compact", (event) => {
          compactEvents += 1;
          assert.equal(event.reason, "manual");
          assert.equal(event.fromExtension, true);
          order.push("compacted");
        });
      };
      const resourceLoader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        agentsFilesOverride: () => ({ agentsFiles: [] }),
        extensionFactories: [
          createCodexCompactExtension({
            fetch: async () => {
              remoteCalls += 1;
              maintenanceStarted.resolve();
              await releaseMaintenance.promise;
              const item = { type: "compaction", encrypted_content: "native-auto-apply-opaque" };
              return new Response(
                `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
                { headers: { "content-type": "text/event-stream" } },
              );
            },
            settingsRuntime: {
              get: () => state,
              reload: async () => state,
              update: async () => state,
              flush: async () => {},
            },
          }),
          createBackgroundCompactionExtension({
            settingsRuntime: {
              get: () => state,
              reload: async () => state,
              update: async () => state,
              flush: async () => {},
            },
          }),
          observer,
        ],
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const manager = SessionManager.inMemory(directory);
      manager.appendMessage({ role: "user", content: `Prior history ${"details ".repeat(2000)}`, timestamp: 1 });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Prior reply" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: "stop",
        timestamp: 2,
      });
      ({ session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        modelRuntime,
        model,
        resourceLoader,
        settingsManager,
        sessionManager: manager,
        noTools: "all",
      }));
      await session.bindExtensions({ mode: "print" });
      await session.prompt("First task");
      if (boundary === "input") {
        assert.equal(compactEvents, 0);
        await maintenanceStarted.promise;
        releaseMaintenance.resolve();
        for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
        assert.equal(compactEvents, 0, "Ready completion alone must never compact");
      } else assert.equal(compactEvents, 1);
      if (boundary === "input") await session.prompt("Second task");
      assert.equal(compactEvents, 1);
      assert.equal(remoteCalls, 1);
      assert.equal(workCalls, 2, "no synthetic continuation or native summarizer");
      assert.deepEqual(order, ["work-1", "compacted", "work-2"]);
      assert.ok(latestCheckpoint(manager.getBranch()));
      assert.equal(session.isIdle, true);
      assert.ok(workSignals.every((signal) => !signal.aborted));
    } finally {
      releaseMaintenance.resolve();
      if (session) {
        await session.abort();
        session.dispose();
      }
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
