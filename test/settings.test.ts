import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import { lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
  compactionSettingsKey,
  createBackgroundCompactionSettingsRuntime,
  DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
  loadBackgroundCompactionSettings,
  normalizeBackgroundCompactionSettings,
} from "../src/settings.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), rename: vi.fn(actual.rename) };
});

const directories: string[] = [];
async function settingsPath() {
  const directory = await mkdtemp(join(tmpdir(), "pi-background-settings-"));
  directories.push(directory);
  return join(directory, "pi-background-compaction.json");
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("defaults enable preparation, application and notices at 70%; validation remains bounded", () => {
  assert.deepEqual(DEFAULT_BACKGROUND_COMPACTION_SETTINGS, {
    asyncEnabled: true,
    asyncAutoApply: true,
    logCompaction: true,
    asyncThresholdPercent: 70,
  });
  assert.deepEqual(normalizeBackgroundCompactionSettings({}), DEFAULT_BACKGROUND_COMPACTION_SETTINGS);
  for (const field of ["asyncEnabled", "asyncAutoApply", "logCompaction"]) {
    for (const value of [null, "true", 0, {}, []])
      assert.equal(normalizeBackgroundCompactionSettings({ [field]: value }), undefined);
  }
  for (const value of [0, 100, 65.5, NaN, Infinity, "65"])
    assert.equal(normalizeBackgroundCompactionSettings({ asyncThresholdPercent: value }), undefined);
  for (const value of [1, 65, 99])
    assert.equal(normalizeBackgroundCompactionSettings({ asyncThresholdPercent: value })?.asyncThresholdPercent, value);
  assert.equal(normalizeBackgroundCompactionSettings([]), undefined);
  assert.equal(normalizeBackgroundCompactionSettings(null), undefined);
});

test("log and automatic-application toggles do not invalidate prepared work", () => {
  const settings = { ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS };
  assert.equal(
    compactionSettingsKey(settings),
    compactionSettingsKey({ ...settings, logCompaction: false, asyncAutoApply: false }),
  );
  assert.notEqual(compactionSettingsKey(settings), compactionSettingsKey({ ...settings, asyncEnabled: false }));
  assert.notEqual(compactionSettingsKey(settings), compactionSettingsKey({ ...settings, asyncThresholdPercent: 75 }));
});

test("missing-file load is side-effect free, including a missing parent directory", async () => {
  const path = join(dirname(await settingsPath()), "absent", "pi-background-compaction.json");
  const loaded = await loadBackgroundCompactionSettings(path);
  assert.equal(loaded.kind, "missing");
  assert.equal(loaded.source, "defaults");
  assert.deepEqual(loaded.settings, DEFAULT_BACKGROUND_COMPACTION_SETTINGS);
  await assert.rejects(stat(dirname(path)), { code: "ENOENT" });
});

test("read-only legacy fallback preserves all owned opt-ins without copying provider fields", async () => {
  const path = await settingsPath();
  const legacy = join(dirname(path), "pi-codex-compact.json");
  const original = JSON.stringify({
    asyncEnabled: true,
    asyncAutoApply: true,
    asyncThresholdPercent: 75,
    logCompaction: true,
    protocol: "auto",
    unrelated: "leave here",
  });
  await writeFile(legacy, original);
  const runtime = createBackgroundCompactionSettingsRuntime(path);
  const loaded = await runtime.reload();
  assert.equal(loaded.source, "legacy");
  assert.deepEqual(loaded.settings, {
    asyncEnabled: true,
    asyncAutoApply: true,
    asyncThresholdPercent: 75,
    logCompaction: true,
  });
  await assert.rejects(stat(path), { code: "ENOENT" });
  await runtime.update({ logCompaction: false });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    asyncEnabled: true,
    asyncAutoApply: true,
    asyncThresholdPercent: 75,
    logCompaction: false,
  });
  assert.equal(await readFile(legacy, "utf8"), original);
  assert.equal(runtime.get().source, "canonical");
});

test("canonical file wins entirely over legacy preferences, including explicit false", async () => {
  const path = await settingsPath();
  await writeFile(join(dirname(path), "pi-codex-compact.json"), '{"asyncEnabled":true,"asyncAutoApply":true}');
  await writeFile(path, '{"asyncEnabled":false}');
  const loaded = await loadBackgroundCompactionSettings(path);
  assert.equal(loaded.source, "canonical");
  assert.equal(loaded.settings.asyncEnabled, false);
  assert.equal(loaded.settings.asyncAutoApply, true);
});

test("invalid canonical never falls back; invalid canonical and legacy both disable preparation", async () => {
  const path = await settingsPath();
  const legacy = join(dirname(path), "pi-codex-compact.json");
  await writeFile(legacy, '{"asyncEnabled":true}');
  await writeFile(path, "{invalid");
  const runtime = createBackgroundCompactionSettingsRuntime(path);
  assert.equal((await runtime.reload()).kind, "invalid");
  assert.equal(runtime.get().settings.asyncEnabled, false);
  assert.equal(runtime.get().settings.asyncAutoApply, false);
  await assert.rejects(runtime.update({ logCompaction: true }), /Cannot overwrite/);
  assert.equal(await readFile(path, "utf8"), "{invalid");
  await rm(path);
  await writeFile(legacy, '{"asyncEnabled":"bad"}');
  assert.equal((await runtime.reload()).source, "legacy");
  assert.equal(runtime.get().kind, "invalid");
  assert.equal(runtime.get().settings.asyncEnabled, false);
  assert.equal(runtime.get().settings.asyncAutoApply, false);
  await assert.rejects(runtime.update({ logCompaction: true }), /Cannot overwrite/);
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("first save is private and queued updates preserve latest unknown fields", async () => {
  const path = await settingsPath();
  const runtime = createBackgroundCompactionSettingsRuntime(path);
  await runtime.update({ asyncEnabled: true });
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, '{"asyncEnabled":true,"future":{"keep":1}}');
  await Promise.all([
    runtime.update({ logCompaction: true }),
    runtime.update({ asyncThresholdPercent: 75 }),
    runtime.reload(),
    runtime.update({ asyncAutoApply: true }),
  ]);
  await runtime.flush();
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    asyncEnabled: true,
    future: { keep: 1 },
    logCompaction: true,
    asyncThresholdPercent: 75,
    asyncAutoApply: true,
  });
  assert.deepEqual(
    (await readdir(dirname(path))).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("failed/aborted writes preserve runtime and do not poison later updates", async () => {
  const path = await settingsPath();
  const runtime = createBackgroundCompactionSettingsRuntime(path);
  await runtime.update({ asyncEnabled: true });
  const before = runtime.get();
  await assert.rejects(runtime.update({ asyncThresholdPercent: 100 }), /Refusing to save invalid/);
  assert.deepEqual(runtime.get(), before);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runtime.update({ asyncEnabled: false }, controller.signal), /aborted/i);
  assert.deepEqual(runtime.get(), before);
  await runtime.update({ logCompaction: true });
  assert.equal(runtime.get().settings.logCompaction, true);
});

test("oversized files and symlinks are rejected without writes", async () => {
  const path = await settingsPath();
  await writeFile(path, JSON.stringify({ padding: "x".repeat(70 * 1024) }));
  assert.match((await loadBackgroundCompactionSettings(path)).issue ?? "", /64 KiB/);
  await rm(path);
  const target = join(dirname(path), "target.json");
  await writeFile(target, "{}");
  await symlink(target, path, "file");
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  const loaded = await loadBackgroundCompactionSettings(path);
  assert.match(loaded.issue ?? "", /symbolic links/);
  assert.equal(loaded.settings.asyncEnabled, false);
  assert.equal(loaded.kind, "invalid");
  const runtime = createBackgroundCompactionSettingsRuntime(path);
  await assert.rejects(runtime.update({ logCompaction: false }), /Cannot overwrite/);
  assert.equal(await readFile(target, "utf8"), "{}");
  assert.equal((await lstat(path)).isSymbolicLink(), true);
});

test("atomic publication failure leaves the prior document and runtime intact", async () => {
  const path = await settingsPath();
  const runtime = createBackgroundCompactionSettingsRuntime(path);
  await runtime.update({ asyncEnabled: true });
  const previousDocument = await readFile(path, "utf8");
  const previousState = runtime.get();
  const rename = vi.mocked(fsPromises.rename).mockRejectedValueOnce(new Error("simulated rename failure"));
  try {
    await assert.rejects(runtime.update({ asyncEnabled: false }), /simulated rename failure/);
    assert.equal(await readFile(path, "utf8"), previousDocument);
    assert.deepEqual(runtime.get(), previousState);
    assert.deepEqual(
      (await readdir(dirname(path))).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    rename.mockClear();
  }
  await runtime.update({ logCompaction: true });
  assert.equal(runtime.get().settings.logCompaction, true);
});

for (const source of ["canonical", "legacy"] as const) {
  test(`${source} preserves saved off values and old threshold; missing fields use current defaults`, async () => {
    const path = await settingsPath();
    const input = source === "canonical" ? path : join(dirname(path), "pi-codex-compact.json");
    const saved = { asyncEnabled: false, asyncAutoApply: false, logCompaction: false, asyncThresholdPercent: 65 };
    await writeFile(input, JSON.stringify(saved));
    const runtime = createBackgroundCompactionSettingsRuntime(path);
    assert.deepEqual((await runtime.reload()).settings, saved);
    await runtime.update({ logCompaction: true });
    assert.deepEqual(runtime.get().settings, { ...saved, logCompaction: true });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ...saved, logCompaction: true });
    if (source === "legacy") {
      assert.deepEqual(JSON.parse(await readFile(input, "utf8")), saved);
      await rm(path);
    }
    await writeFile(input, JSON.stringify({ asyncEnabled: false }));
    assert.deepEqual((await runtime.reload()).settings, {
      ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
      asyncEnabled: false,
    });
    assert.deepEqual(JSON.parse(await readFile(input, "utf8")), { asyncEnabled: false });
  });
}

for (const source of ["canonical", "legacy"] as const) {
  for (const dangling of [false, true]) {
    test(`${source} ${dangling ? "dangling" : "live"} symlink is invalid, never defaults or writable`, async () => {
      const path = await settingsPath();
      const input = source === "canonical" ? path : join(dirname(path), "pi-codex-compact.json");
      const target = join(dirname(path), "target.json");
      if (!dangling) await writeFile(target, "{}");
      await symlink(target, input, "file");
      assert.equal((await lstat(input)).isSymbolicLink(), true);
      const loaded = await loadBackgroundCompactionSettings(path);
      assert.equal(loaded.kind, "invalid");
      assert.equal(loaded.settings.asyncEnabled, false);
      assert.match(loaded.issue ?? "", /symbolic links/);
      const runtime = createBackgroundCompactionSettingsRuntime(path);
      await assert.rejects(runtime.update({ logCompaction: true }), /Cannot overwrite/);
      assert.equal((await lstat(input)).isSymbolicLink(), true);
      if (dangling) await assert.rejects(stat(target), { code: "ENOENT" });
      else assert.equal(await readFile(target, "utf8"), "{}");
      if (source === "legacy") await assert.rejects(stat(path), { code: "ENOENT" });
    });
  }
}

test("path replacement or disappearance after open fails closed", async () => {
  const path = await settingsPath();
  await writeFile(path, "{}");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const original = await actual.lstat(path, { bigint: true });
  const mock = vi.mocked(fsPromises.lstat);
  for (const mutation of ["symlink", "identity", "missing"] as const) {
    mock.mockImplementationOnce(actual.lstat).mockImplementationOnce(async () => {
      if (mutation === "missing") throw Object.assign(new Error("removed"), { code: "ENOENT" });
      return Object.assign(Object.create(Object.getPrototypeOf(original)), original, {
        ino: mutation === "identity" ? original.ino + 1n : original.ino,
        isSymbolicLink: () => mutation === "symlink",
      });
    });
    try {
      const loaded = await loadBackgroundCompactionSettings(path);
      assert.equal(loaded.kind, "invalid");
      assert.equal(loaded.settings.asyncEnabled, false);
      assert.match(
        loaded.issue ?? "",
        mutation === "symlink" ? /symbolic links/ : mutation === "identity" ? /changed while opening/ : /removed/,
      );
      assert.equal(await readFile(path, "utf8"), "{}");
    } finally {
      mock.mockReset().mockImplementation(actual.lstat);
    }
  }
});
