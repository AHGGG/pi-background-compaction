import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { abortable } from "./abortable.js";
import { readPreparationDiagnostics } from "./preparation-diagnostics.js";
import type {
  CheckpointPreparation,
  PreparationDiagnostics,
  PreparedCheckpoint,
} from "./prepared-compaction-protocol.js";
import { type BackgroundCompactionSettingsRuntime, compactionSettingsKey } from "./settings.js";
import { BACKGROUND_COMPACTION_VERSION } from "./version.js";

/** Controller-owned lifetime. Engines return opaque results, never schedule jobs. */
export interface BackgroundJob {
  controller: AbortController;
  promise: Promise<PreparedCheckpoint>;
  state: "Preparing" | "Ready" | "Failed";
  isCurrent(): boolean;
  /** Cheap lifetime/settings check only; never rebuilds the engine snapshot. */
  isProgressCurrent(): boolean;
  validationFailure?: string;
  applicationFailure?: string;
  elapsedMs?: number;
  diagnostics?: PreparationDiagnostics;
  diagnosticContext: string;
  refreshDiagnostics(): PreparationDiagnostics | undefined;
}

export function startBackgroundJob(
  preparation: CheckpointPreparation,
  ctx: ExtensionContext,
  runtime: BackgroundCompactionSettingsRuntime,
  ownerSignal: AbortSignal,
  ownsSession: () => boolean,
): BackgroundJob {
  const started = performance.now();
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ownerSignal]);
  const settings = runtime.get().settings;
  const settingsKey = compactionSettingsKey(settings);
  const runSignal = ctx.signal;
  const cancelPreparing = () => controller.abort();
  runSignal?.addEventListener("abort", cancelPreparing, { once: true });
  const deadline = new AbortController();
  const timeout = setTimeout(
    () => deadline.abort(new Error("Background compaction request timed out")),
    preparation.requestTimeoutMs,
  );
  const job: BackgroundJob = {
    controller,
    state: "Preparing",
    diagnosticContext: `companion=${BACKGROUND_COMPACTION_VERSION} background=${settings.asyncEnabled ? "on" : "off"} threshold=${settings.asyncThresholdPercent}% autoApply=${settings.asyncAutoApply ? "on" : "off"} lifecycleLogs=${settings.logCompaction ? "on" : "off"}`,
    promise: undefined as unknown as Promise<PreparedCheckpoint>,
    refreshDiagnostics() {
      if (job.state === "Preparing") {
        const snapshot = readPreparationDiagnostics(preparation);
        if (snapshot)
          job.diagnostics = { ...snapshot, report: `${job.diagnosticContext}\n${snapshot.report}`.slice(0, 16_384) };
      }
      return job.diagnostics;
    },
    isProgressCurrent() {
      return !signal.aborted && ownsSession() && compactionSettingsKey(runtime.get().settings) === settingsKey;
    },
    isCurrent() {
      const reason = signal.aborted
        ? "background job was cancelled"
        : !ownsSession()
          ? "session ownership changed"
          : compactionSettingsKey(runtime.get().settings) !== settingsKey
            ? "background compaction settings changed"
            : !preparation.isCurrent()
              ? (preparation.reason ?? "compaction engine snapshot changed")
              : undefined;
      if (reason) job.validationFailure = reason;
      return reason === undefined;
    },
  };
  // Capture is synchronous, and the request begins immediately. Ready results no
  // longer belong to the initiating run: Escape cannot invalidate completed work.
  try {
    const requestSignal = signal;
    job.promise = abortable(
      preparation.start({
        signal: requestSignal,
        deadlineSignal: deadline.signal,
        isCurrent: () => job.isCurrent(),
        ownsStatus: () => false,
      }),
      requestSignal,
    );
  } catch (error) {
    job.promise = Promise.reject(error);
  }
  job.promise = job.promise
    .then(
      (prepared) => {
        job.refreshDiagnostics();
        job.state = prepared.usable ? "Ready" : "Failed";
        job.applicationFailure = prepared.failure;
        return prepared;
      },
      (error: unknown) => {
        job.refreshDiagnostics();
        job.state = "Failed";
        if (!signal.aborted)
          job.applicationFailure = deadline.signal.aborted
            ? "request timed out"
            : "background preparation failed (engine returned no safe diagnostic)";
        throw error;
      },
    )
    .finally(() => {
      job.elapsedMs = Math.max(0, performance.now() - started);
      runSignal?.removeEventListener("abort", cancelPreparing);
      clearTimeout(timeout);
      deadline.abort();
    });
  return job;
}
