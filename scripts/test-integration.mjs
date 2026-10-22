import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [checkout, ...args] = process.argv.slice(2);
if (!checkout) throw new Error("Usage: npm run test:integration -- /path/to/pi-extensions [vitest filters]");
const core = resolve(checkout);
const engine = join(core, "packages/pi-codex-compact/src");
if (!existsSync(join(engine, "prepared-compaction-protocol.ts")))
  throw new Error("The supplied checkout must provide prepared-compaction protocol v1");
const directory = await mkdtemp(join(root, ".integration-"));
const config = join(directory, "vitest.config.mjs");
try {
  await writeFile(
    config,
    `export default ${JSON.stringify({ root, resolve: { alias: { "@integration/engine": engine, "@integration/support": join(core, "test/support.ts") } }, test: { include: ["integration/**/*.test.ts"], testTimeout: 5000, hookTimeout: 5000, maxWorkers: 1 } }, null, 2)};\n`,
  );
  const child = spawn(
    process.execPath,
    [join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", config, ...args],
    { cwd: root, stdio: "inherit" },
  );
  process.exitCode = await new Promise((ok, fail) => {
    child.on("error", fail);
    child.on("exit", (code) => ok(code ?? 1));
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
