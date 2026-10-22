import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { resolveMenuScreen } from "@narumitw/pi-tui-kit";
import { test } from "vitest";
import {
  type BackgroundCompactionSettingsRuntime,
  type BackgroundCompactionSettingsState,
  DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
} from "../src/settings.js";
import { createBackgroundCompactionMenu, showBackgroundCompactionMenu } from "../src/settings-menu.js";
import { createCustomSelectorHarness } from "./settings-ui-support.js";

function memoryRuntime() {
  let state: BackgroundCompactionSettingsState = {
    kind: "loaded",
    path: "/tmp/pi-background-compaction.json",
    settings: { ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS },
  };
  const patches: unknown[] = [];
  const runtime: BackgroundCompactionSettingsRuntime = {
    get: () => structuredClone(state),
    async reload() {
      return structuredClone(state);
    },
    async update(patch) {
      patches.push(patch);
      state = { ...state, settings: { ...state.settings, ...patch } };
      return structuredClone(state);
    },
    async flush() {},
  };
  return { runtime, patches };
}
function context(mode = "tui") {
  const notices: string[] = [];
  let customs = 0;
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      notify: (message: string) => notices.push(message),
      custom: () => {
        customs++;
        throw new Error("unexpected custom screen");
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notices, customs: () => customs };
}

test("main menu has Settings, Status and Help; pause and legacy source remain visible", () => {
  const { runtime } = memoryRuntime();
  const menu = createBackgroundCompactionMenu(runtime, {
    warmPauseReason: () => "provider changed",
    backgroundStatus: () => "Ready",
  });
  const main = resolveMenuScreen(menu, "main", {
    ...runtime.get(),
    source: "legacy",
    legacyPath: "/tmp/pi-codex-compact.json",
  });
  assert.equal(main.kind, "actions");
  if (main.kind !== "actions") assert.fail("expected actions");
  assert.deepEqual(
    main.items.map((item) => item.label),
    ["Resume background preparation", "Settings", "Status", "Help", "Close"],
  );
  assert.match(main.lines?.join("\n") ?? "", /provider changed/);
  assert.match(main.lines?.join("\n") ?? "", /Using legacy preferences/);
  const settings = resolveMenuScreen(menu, "settings", runtime.get());
  assert.equal(settings.kind, "settings");
  if (settings.kind !== "settings") assert.fail("expected settings");
  assert.deepEqual(
    settings.items.map((item) => item.id),
    ["asyncEnabled", "asyncAutoApply", "asyncThresholdPercent", "logCompaction"],
  );
});

test("settings patches are precise and only preparation changes invalidate jobs", async () => {
  const { runtime, patches } = memoryRuntime();
  const { ctx } = context();
  let changes = 0;
  const menu = createBackgroundCompactionMenu(runtime, {
    onSettingsChanged: () => {
      changes++;
    },
  });
  const action = (value: string) => ({
    ctx,
    state: runtime.get(),
    signal: new AbortController().signal,
    itemId: "setting",
    value,
  });
  await menu.actions["set-log"](action("On"));
  await menu.actions["set-auto-apply"](action("On"));
  assert.equal(changes, 0);
  await menu.actions["set-enabled"](action("On"));
  await menu.actions["set-threshold"](action("75%"));
  assert.equal(changes, 2);
  assert.deepEqual(patches, [
    { logCompaction: true },
    { asyncAutoApply: true },
    { asyncEnabled: true },
    { asyncThresholdPercent: 75 },
  ]);
});

test("failed save reports failure and does not invalidate work", async () => {
  const { runtime } = memoryRuntime();
  runtime.update = async () => {
    throw new Error("disk full");
  };
  const { ctx, notices } = context();
  let changes = 0;
  const menu = createBackgroundCompactionMenu(runtime, {
    onSettingsChanged: () => {
      changes++;
    },
  });
  const result = await menu.actions["set-enabled"]({
    ctx,
    state: runtime.get(),
    signal: new AbortController().signal,
    itemId: "asyncEnabled",
    value: "On",
  });
  assert.deepEqual(result, { kind: "rejected" });
  assert.equal(runtime.get().settings.asyncEnabled, false);
  assert.equal(changes, 0);
  assert.match(notices.join("\n"), /disk full/);
});

test("resume calls session callback without a settings write", async () => {
  const { runtime, patches } = memoryRuntime();
  let resumed = 0;
  const menu = createBackgroundCompactionMenu(runtime, {
    onResumeWarm: () => {
      resumed++;
    },
  });
  await menu.actions.resume({
    ctx: context().ctx,
    state: runtime.get(),
    signal: new AbortController().signal,
    itemId: "resume",
  });
  assert.equal(resumed, 1);
  assert.deepEqual(patches, []);
});

test("RPC emits settings path; print and JSON reject without opening UI", async () => {
  const { runtime } = memoryRuntime();
  const owner = { signal: new AbortController().signal, isCurrent: () => true };
  const rpc = context("rpc");
  await showBackgroundCompactionMenu(runtime, rpc.ctx, owner);
  assert.match(rpc.notices.join("\n"), /pi-background-compaction.json/);
  assert.equal(rpc.customs(), 0);
  for (const mode of ["print", "json"]) {
    const current = context(mode);
    await assert.rejects(showBackgroundCompactionMenu(runtime, current.ctx, owner), /requires TUI or RPC/);
    assert.equal(current.customs(), 0);
  }
});

test("TUI framing remains bounded and focused settings survive resize", async () => {
  const { runtime, patches } = memoryRuntime();
  let screens = 0;
  let changes = 0;
  let main: string[] = [];
  let normal: string[] = [];
  let constrained: string[] = [];
  const resized: Array<{ width: number; lines: string[] }> = [];
  const current = context();
  current.ctx.ui.custom = (async (factory: unknown) => {
    const harness = createCustomSelectorHarness(factory, 100);
    screens++;
    try {
      if (screens === 1) {
        main = harness.render();
        harness.handleInput("tui.select.confirm");
      } else if (screens === 2) {
        normal = harness.render();
        harness.handleInput("tui.select.confirm");
        await harness.waitForPending();
      } else if (screens === 3) {
        harness.handleInput("tui.select.down");
        harness.handleInput("tui.select.down");
        harness.handleInput("tui.select.confirm");
        await harness.waitForPending();
      } else {
        harness.setTerminalRows(8);
        constrained = harness.render();
        harness.setTerminalRows(4);
        for (const width of [0, 12, 32]) {
          harness.invalidate();
          resized.push({ width, lines: harness.render(width) });
        }
        harness.handleInput("\u0003");
        await harness.waitForPending();
      }
      return await harness.resultPromise;
    } finally {
      harness.dispose();
    }
  }) as ExtensionCommandContext["ui"]["custom"];
  await showBackgroundCompactionMenu(runtime, current.ctx, {
    signal: new AbortController().signal,
    isCurrent: () => true,
    backgroundStatus: () => "Ready",
    onSettingsChanged: () => {
      changes++;
    },
  });
  assert.equal(screens, 4);
  assert.match(main.join("\n"), /Prepared checkpoint: Ready/);
  assert.match(normal[0], /^─+$/);
  assert.match(normal.at(-1) ?? "", /^─+$/);
  assert.match(normal.join("\n"), /Background preparation/);
  assert.ok(constrained.length <= 5);
  assert.match(constrained.join("\n"), /Preparation threshold.*70%/);
  for (const { width, lines } of resized) {
    assert.ok(lines.length <= 1);
    assert.ok(lines.every((line) => visibleWidth(line) <= Math.max(1, width)));
  }
  assert.equal(changes, 2);
  assert.deepEqual(patches, [{ asyncEnabled: true }, { asyncThresholdPercent: 70 }]);
});

test("invalidation waits for durable save and failed save leaves displayed value unchanged", async () => {
  const memory = memoryRuntime();
  let release!: () => void;
  const pendingSave = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = false;
  const runtime: BackgroundCompactionSettingsRuntime = {
    ...memory.runtime,
    async update(patch) {
      await pendingSave;
      if (fail) throw new Error("disk failure");
      return memory.runtime.update(patch);
    },
  };
  const observed: boolean[] = [];
  const menu = createBackgroundCompactionMenu(runtime, {
    onSettingsChanged: () => {
      observed.push(runtime.get().settings.asyncEnabled);
    },
  });
  const current = context();
  const action = (value: string) => ({
    ctx: current.ctx,
    state: runtime.get(),
    signal: new AbortController().signal,
    itemId: "asyncEnabled",
    value,
  });
  const saving = menu.actions["set-enabled"](action("On"));
  assert.deepEqual(observed, []);
  release();
  assert.deepEqual(await saving, { kind: "stay" });
  assert.deepEqual(observed, [true]);
  fail = true;
  assert.deepEqual(await menu.actions["set-enabled"](action("Off")), { kind: "rejected" });
  assert.deepEqual(observed, [true]);
  const screen = resolveMenuScreen(menu, "settings", runtime.get());
  if (screen.kind !== "settings") assert.fail("expected settings");
  assert.equal(screen.items.find((item) => item.id === "asyncEnabled")?.currentValue, "On");
});
