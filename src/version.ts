import { readFileSync } from "node:fs";

/** Read only this installed package's version, never caller settings or environment variables. */
export const BACKGROUND_COMPACTION_VERSION = (() => {
  try {
    const version: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    return typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) && version.length <= 64
      ? version
      : "unknown";
  } catch {
    return "unknown";
  }
})();
