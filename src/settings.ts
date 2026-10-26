import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const BACKGROUND_COMPACTION_SETTINGS_FILE = "pi-background-compaction.json";
export const MAX_SETTINGS_BYTES = 64 * 1024;

export interface BackgroundCompactionSettings {
  asyncEnabled: boolean;
  asyncAutoApply: boolean;
  logCompaction: boolean;
  asyncThresholdPercent: number;
}

/** Logging and application timing do not invalidate prepared work. */
export function compactionSettingsKey(settings: BackgroundCompactionSettings): string {
  return JSON.stringify([settings.asyncEnabled, settings.asyncThresholdPercent]);
}

export const DEFAULT_BACKGROUND_COMPACTION_SETTINGS: Readonly<BackgroundCompactionSettings> = Object.freeze({
  asyncEnabled: true,
  asyncAutoApply: true,
  logCompaction: true,
  asyncThresholdPercent: 70,
});

export interface BackgroundCompactionSettingsState {
  kind: "missing" | "loaded" | "invalid";
  path: string;
  settings: BackgroundCompactionSettings;
  document?: Record<string, unknown>;
  issue?: string;
  source?: "defaults" | "canonical" | "legacy";
  legacyPath?: string;
}

export interface BackgroundCompactionSettingsRuntime {
  get(): Readonly<BackgroundCompactionSettingsState>;
  reload(signal?: AbortSignal): Promise<Readonly<BackgroundCompactionSettingsState>>;
  update(
    patch: Partial<BackgroundCompactionSettings>,
    signal?: AbortSignal,
  ): Promise<Readonly<BackgroundCompactionSettingsState>>;
  flush(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeBackgroundCompactionSettings(value: unknown): BackgroundCompactionSettings | undefined {
  if (!isRecord(value)) return undefined;
  for (const field of ["asyncEnabled", "asyncAutoApply", "logCompaction"]) {
    if (Object.hasOwn(value, field) && typeof value[field] !== "boolean") return undefined;
  }
  if (
    Object.hasOwn(value, "asyncThresholdPercent") &&
    (typeof value.asyncThresholdPercent !== "number" ||
      !Number.isSafeInteger(value.asyncThresholdPercent) ||
      value.asyncThresholdPercent < 1 ||
      value.asyncThresholdPercent > 99)
  )
    return undefined;
  return {
    asyncEnabled:
      typeof value.asyncEnabled === "boolean"
        ? value.asyncEnabled
        : DEFAULT_BACKGROUND_COMPACTION_SETTINGS.asyncEnabled,
    asyncAutoApply:
      typeof value.asyncAutoApply === "boolean"
        ? value.asyncAutoApply
        : DEFAULT_BACKGROUND_COMPACTION_SETTINGS.asyncAutoApply,
    logCompaction:
      typeof value.logCompaction === "boolean"
        ? value.logCompaction
        : DEFAULT_BACKGROUND_COMPACTION_SETTINGS.logCompaction,
    asyncThresholdPercent:
      typeof value.asyncThresholdPercent === "number"
        ? value.asyncThresholdPercent
        : DEFAULT_BACKGROUND_COMPACTION_SETTINGS.asyncThresholdPercent,
  };
}

export function backgroundCompactionSettingsPath(): string {
  return join(getAgentDir(), BACKGROUND_COMPACTION_SETTINGS_FILE);
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Settings operation aborted", "AbortError");
}

async function loadSingleSettings(
  path = backgroundCompactionSettingsPath(),
  signal?: AbortSignal,
): Promise<BackgroundCompactionSettingsState> {
  aborted(signal);
  let observedPath = false;
  try {
    // O_NOFOLLOW is not enforced on every platform (notably Windows).
    const before = await lstat(path, { bigint: true });
    observedPath = true;
    if (before.isSymbolicLink()) throw new Error("symbolic links are not accepted");
    if (!before.isFile()) throw new Error("settings path is not a regular file");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let text: string;
    try {
      const stats = await handle.stat({ bigint: true });
      const current = await lstat(path, { bigint: true });
      aborted(signal);
      if (current.isSymbolicLink()) throw new Error("symbolic links are not accepted");
      if (
        before.dev !== stats.dev ||
        before.ino !== stats.ino ||
        current.dev !== stats.dev ||
        current.ino !== stats.ino
      )
        throw new Error("settings path changed while opening");
      if (!stats.isFile()) throw new Error("settings path is not a regular file");
      if (stats.size > BigInt(MAX_SETTINGS_BYTES)) throw new Error("settings file exceeds 64 KiB");
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    aborted(signal);
    const document = JSON.parse(text) as unknown;
    const settings = normalizeBackgroundCompactionSettings(document);
    if (!settings || !isRecord(document)) throw new Error("invalid settings shape or bounds");
    return { kind: "loaded", path, settings, document, source: "canonical" };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!observedPath && isNodeError(error) && error.code === "ENOENT") {
      return {
        kind: "missing",
        path,
        settings: { ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS },
        document: {},
      };
    }
    return {
      kind: "invalid",
      path,
      // Unreadable preferences must never implicitly authorize provider work.
      settings: { ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS, asyncEnabled: false, asyncAutoApply: false },
      issue:
        isNodeError(error) && error.code === "ELOOP"
          ? "symbolic links are not accepted"
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

/** Read legacy preferences only when the canonical file is absent. Never write or remove the legacy file. */
export async function loadBackgroundCompactionSettings(
  path = backgroundCompactionSettingsPath(),
  signal?: AbortSignal,
): Promise<BackgroundCompactionSettingsState> {
  const canonical = await loadSingleSettings(path, signal);
  if (canonical.kind !== "missing") return canonical;
  const legacyPath = join(dirname(path), "pi-codex-compact.json");
  const legacy = await loadSingleSettings(legacyPath, signal);
  if (legacy.kind === "missing") return { ...canonical, source: "defaults" };
  if (legacy.kind === "invalid")
    return {
      ...canonical,
      kind: "invalid",
      settings: legacy.settings,
      source: "legacy",
      legacyPath,
      issue: `Legacy settings could not be read: ${legacy.issue ?? "invalid settings"}`,
    };
  // Copy only this extension's fields: authentication/provider preferences remain engine-owned.
  const document: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_BACKGROUND_COMPACTION_SETTINGS)) {
    if (Object.hasOwn(legacy.document ?? {}, key)) document[key] = legacy.document?.[key];
  }
  return { ...canonical, settings: legacy.settings, document, source: "legacy", legacyPath };
}

async function savePatch(
  path: string,
  patch: Partial<BackgroundCompactionSettings>,
  signal?: AbortSignal,
): Promise<BackgroundCompactionSettingsState> {
  const latest = await loadBackgroundCompactionSettings(path, signal);
  if (latest.kind === "invalid") {
    throw new Error("Cannot overwrite an invalid pi-background-compaction.json; repair it and reload first");
  }
  const document = { ...latest.document, ...patch };
  const settings = normalizeBackgroundCompactionSettings(document);
  if (!settings) throw new Error("Refusing to save invalid background compaction settings");
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await mkdir(dirname(path), { recursive: true });
  aborted(signal);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    aborted(signal);
    const current = await loadBackgroundCompactionSettings(path, signal);
    if (
      current.kind === "invalid" ||
      current.kind !== latest.kind ||
      JSON.stringify(current.document) !== JSON.stringify(latest.document)
    ) {
      throw new Error("pi-background-compaction.json changed while saving; reopen settings and retry");
    }
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return { kind: "loaded", path, settings, document, source: "canonical" };
}

export function createBackgroundCompactionSettingsRuntime(
  path = backgroundCompactionSettingsPath(),
): BackgroundCompactionSettingsRuntime {
  let state: BackgroundCompactionSettingsState = {
    kind: "missing",
    path,
    settings: { ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS },
    document: {},
  };
  let queue = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    get: () => structuredClone(state),
    reload: (signal) =>
      enqueue(async () => {
        state = await loadBackgroundCompactionSettings(path, signal);
        return structuredClone(state);
      }),
    update: (patch, signal) =>
      enqueue(async () => {
        state = await savePatch(path, patch, signal);
        return structuredClone(state);
      }),
    flush: () => queue,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
