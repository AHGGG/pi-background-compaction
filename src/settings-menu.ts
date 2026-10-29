import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type MenuDefinition, runMenu } from "@narumitw/pi-tui-kit";
import type {
  BackgroundCompactionSettings,
  BackgroundCompactionSettingsRuntime,
  BackgroundCompactionSettingsState,
} from "./settings.js";
import { terminalText as safeText } from "./terminal.js";

type Screen = "main" | "settings" | "status" | "help" | "invalid";
type Action = "resume" | "set-enabled" | "set-auto-apply" | "set-threshold" | "set-log";

export interface SettingsMenuOwner {
  signal: AbortSignal;
  isCurrent(): boolean;
  backgroundStatus?(): "Preparing" | "Ready" | undefined;
  warmPauseReason?(): string | undefined;
  lastPreparationStatus?(): string | undefined;
  preparationStatus?(): string | undefined;
  diagnosticReport?(): string | undefined;
  onResumeWarm?(): void;
  onSettingsChanged?(): void;
}

type MenuOptions = Pick<
  SettingsMenuOwner,
  | "backgroundStatus"
  | "warmPauseReason"
  | "lastPreparationStatus"
  | "preparationStatus"
  | "diagnosticReport"
  | "onResumeWarm"
  | "onSettingsChanged"
>;

export function createBackgroundCompactionMenu(
  runtime: BackgroundCompactionSettingsRuntime,
  options: MenuOptions = {},
): MenuDefinition<BackgroundCompactionSettingsState, Screen, Action, ExtensionCommandContext> {
  const save = async (
    ctx: ExtensionCommandContext,
    patch: Partial<BackgroundCompactionSettings>,
    signal: AbortSignal,
  ) => {
    try {
      await runtime.update(patch, signal);
      if (signal.aborted) return { kind: "rejected" as const };
      if (Object.keys(patch).some((key) => key !== "logCompaction" && key !== "asyncAutoApply"))
        options.onSettingsChanged?.();
      ctx.ui.notify("Background compaction settings saved.", "info");
      return { kind: "stay" as const };
    } catch (error) {
      if (signal.aborted) return { kind: "rejected" as const };
      ctx.ui.notify(
        `Could not save background compaction settings: ${safeText(error instanceof Error ? error.message : String(error))}`,
        "error",
      );
      return { kind: "rejected" as const };
    }
  };
  const status = (state: Readonly<BackgroundCompactionSettingsState>) => [
    `Background preparation: ${state.settings.asyncEnabled ? `On · ${state.settings.asyncThresholdPercent}%` : "Off"}`,
    `Apply when ready: ${state.settings.asyncAutoApply ? "On" : "Off"}`,
    `Lifecycle logs: ${state.settings.logCompaction ? "On" : "Off"}`,
    `Prepared compaction: ${options.backgroundStatus?.() ?? "none"}`,
    ...(options.lastPreparationStatus?.()
      ? [`Last preparation: ${safeText(options.lastPreparationStatus() ?? "")}`]
      : []),
    ...(options.preparationStatus?.() ? [`Preparation: ${safeText(options.preparationStatus() ?? "")}`] : []),
    ...(options.warmPauseReason?.() ? [`Paused: ${safeText(options.warmPauseReason() ?? "")}`] : []),
    `Settings: ${safeText(state.path)}`,
    ...(state.source === "legacy"
      ? [
          `Using legacy preferences from ${safeText(state.legacyPath ?? "pi-codex-compact.json")}; the first explicit save writes the new file.`,
        ]
      : []),
  ];
  return {
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "Background Compaction",
        lines: status(state),
        items: [
          ...(options.warmPauseReason?.()
            ? [{ id: "resume", label: "Resume background preparation", action: "resume" as const }]
            : []),
          {
            id: "settings",
            label: "Settings",
            to: state.kind === "invalid" ? ("invalid" as const) : ("settings" as const),
          },
          { id: "status", label: "Status", to: "status" as const },
          { id: "help", label: "Help", to: "help" as const },
          { id: "close", label: "Close", close: true },
        ],
        hint: "close",
      }),
      settings: ({ state }) => ({
        kind: "settings",
        title: "Background Compaction Settings",
        lines: [`User settings · ${safeText(state.path)}`],
        items: [
          {
            id: "asyncEnabled",
            label: "Background preparation (experimental)",
            description: "Prepare a compaction result after a completed turn. May consume quota even if unused.",
            currentValue: state.settings.asyncEnabled ? "On" : "Off",
            values: ["On", "Off"],
            action: "set-enabled",
          },
          {
            id: "asyncAutoApply",
            label: "Apply when ready",
            description: "Apply after the current model/tool batch or at the next idle input boundary.",
            currentValue: state.settings.asyncAutoApply ? "On" : "Off",
            values: ["On", "Off"],
            action: "set-auto-apply",
          },
          {
            id: "asyncThresholdPercent",
            label: "Preparation threshold",
            description: "Context-window usage that permits background preparation.",
            currentValue: `${state.settings.asyncThresholdPercent}%`,
            values: ["50%", "60%", "65%", "70%", "75%", "80%", "90%"],
            action: "set-threshold",
          },
          {
            id: "logCompaction",
            label: "Lifecycle logs",
            description: "Show background preparation and application notices in TUI and RPC.",
            currentValue: state.settings.logCompaction ? "On" : "Off",
            values: ["On", "Off"],
            action: "set-log",
          },
        ],
      }),
      status: ({ state }) => ({
        kind: "detail",
        title: "Background Compaction Status",
        lines: [
          ...status(state),
          ...(options.diagnosticReport?.()
            ? ["", "Preparation diagnostics:", ...(options.diagnosticReport() ?? "").split("\n").map(safeText)]
            : []),
        ],
        hint: "back",
      }),
      help: () => ({
        kind: "detail",
        title: "Background Compaction Help",
        lines: [
          "Requires a compatible prepared-compaction engine extension; it does not perform provider requests by itself.",
          "Background preparation and Apply when ready are on by default. Choose the output format in the engine settings.",
          "A prepared compaction result applies only at a safe Pi boundary. Manual /compact remains available.",
          "Use /background-compaction resume to clear a session-only failure pause.",
          "Failures print a complete report when the engine supports diagnostics; /background-compaction diagnostics shows retained reports.",
          "Preparation progress and inactivity advisories do not change the request deadline.",
          "Settings apply immediately and are saved in user action order; Escape does not undo saved changes.",
        ],
        hint: "back",
      }),
      invalid: ({ state }) => ({
        kind: "detail",
        title: "Background Compaction Settings · Read only",
        lines: [
          `Settings issue: ${safeText(state.issue ?? "invalid settings")}`,
          `Path: ${safeText(state.source === "legacy" ? (state.legacyPath ?? state.path) : state.path)}`,
          "Built-in defaults are active. Repair the file and run /reload; it will not be overwritten.",
        ],
        hint: "back",
      }),
    },
    actions: {
      resume: () => {
        options.onResumeWarm?.();
        return { kind: "stay" };
      },
      "set-enabled": ({ ctx, value, signal }) => save(ctx, { asyncEnabled: value === "On" }, signal),
      "set-auto-apply": ({ ctx, value, signal }) => save(ctx, { asyncAutoApply: value === "On" }, signal),
      "set-threshold": ({ ctx, value, signal }) =>
        save(ctx, { asyncThresholdPercent: Number.parseInt(value ?? "65", 10) }, signal),
      "set-log": ({ ctx, value, signal }) => save(ctx, { logCompaction: value === "On" }, signal),
    },
  };
}

export async function showBackgroundCompactionMenu(
  runtime: BackgroundCompactionSettingsRuntime,
  ctx: ExtensionCommandContext,
  owner: SettingsMenuOwner,
): Promise<void> {
  if (ctx.mode === "rpc" && ctx.hasUI) {
    ctx.ui.notify(`Edit background compaction settings at ${safeText(runtime.get().path)}.`, "info");
    return;
  }
  if (ctx.mode !== "tui") throw new Error("/background-compaction requires TUI or RPC UI support");
  if (owner.signal.aborted || !owner.isCurrent()) return;
  await runMenu(
    ctx,
    createBackgroundCompactionMenu(runtime, {
      backgroundStatus: owner.backgroundStatus,
      warmPauseReason: owner.warmPauseReason,
      lastPreparationStatus: owner.lastPreparationStatus,
      preparationStatus: owner.preparationStatus,
      diagnosticReport: owner.diagnosticReport,
      onResumeWarm: () => {
        if (!owner.signal.aborted && owner.isCurrent()) owner.onResumeWarm?.();
      },
      onSettingsChanged: () => {
        if (!owner.signal.aborted && owner.isCurrent()) owner.onSettingsChanged?.();
      },
    }),
    { getState: () => runtime.get(), signal: owner.signal, isCurrent: owner.isCurrent },
  );
}
