import type { CheckpointPreparation, PreparationDiagnostics } from "./prepared-compaction-protocol.js";
import { terminalText } from "./terminal.js";

const safeLine = (value: string, limit: number) =>
  terminalText(value.slice(0, limit))
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function supportsPreparationDiagnostics(preparation: CheckpointPreparation): boolean {
  try {
    return typeof preparation.diagnostics === "function";
  } catch {
    return false;
  }
}

/** The producer filters privacy-sensitive data. This consumer only bounds and terminal-sanitizes it. */
export function readPreparationDiagnostics(preparation: CheckpointPreparation): PreparationDiagnostics | undefined {
  try {
    const snapshot = preparation.diagnostics?.();
    if (!snapshot || typeof snapshot.status !== "string" || typeof snapshot.report !== "string") return undefined;
    return {
      status: safeLine(snapshot.status, 320),
      report: snapshot.report
        .slice(0, 16_384)
        .split(/\r?\n/)
        .map((line) => safeLine(line, 2048))
        .join("\n")
        .trim(),
      ...(typeof snapshot.warning === "string" ? { warning: safeLine(snapshot.warning, 512) } : {}),
      ...(["failed", "prepared", "ready", "recovered", "discarded", "cancelled"].includes(snapshot.outcome ?? "")
        ? { outcome: snapshot.outcome }
        : {}),
      ...(typeof snapshot.reason === "string" ? { reason: safeLine(snapshot.reason, 512) } : {}),
    };
  } catch {
    // Optional diagnostics must never fail the preparation or expose a raw engine exception.
    return undefined;
  }
}
