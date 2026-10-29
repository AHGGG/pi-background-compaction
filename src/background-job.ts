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

/** Small retained metadata only; never retains the producer, promise, history or checkpoint. */
export interface PreparationRecord {
  state: "Preparing" | "Ready" | "Failed" | "Discarded" | "Cancelled";
  validationFailure?: string;
  applicationFailure?: string;
  elapsedMs?: number;
  diagnostics?: PreparationDiagnostics;
  diagnosticsUnavailable?: boolean;
  diagnosticContext: string;
}

/** Controller-owned lifetime. Engines return opaque results, never schedule jobs. */
export interface BackgroundJob extends PreparationRecord {
  controller: AbortController;
  promise: Promise<PreparedCheckpoint>;
  isCurrent(): boolean;
  /** Cheap lifetime/settings check only; never rebuilds the engine snapshot. */
  isProgressCurrent(): boolean;
  refreshDiagnostics(): PreparationDiagnostics | undefined;
  retain(): PreparationRecord;
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
  let producerSettled = false;
  let retained: PreparationRecord | undefined;
  const captureDiagnostics = () => {
    const snapshot = readPreparationDiagnostics(preparation);
    job.diagnosticsUnavailable = !snapshot || !producerSettled;
    if (snapshot)
      job.diagnostics = { ...snapshot, report: `${job.diagnosticContext}\n${snapshot.report}`.slice(0, 16_384) };
    if (retained) {
      retained.diagnostics = job.diagnostics;
      retained.diagnosticsUnavailable = job.diagnosticsUnavailable;
    }
  };
  const job: BackgroundJob = {
    controller,
    state: "Preparing",
    diagnosticContext: `companion=${BACKGROUND_COMPACTION_VERSION} background=${settings.asyncEnabled ? "on" : "off"} threshold=${settings.asyncThresholdPercent}% autoApply=${settings.asyncAutoApply ? "on" : "off"} lifecycleLogs=${settings.logCompaction ? "on" : "off"}`,
    promise: undefined as unknown as Promise<PreparedCheckpoint>,
    retain() {
      retained ??= { state: job.state, diagnosticContext: job.diagnosticContext };
      Object.assign(retained, {
        state: job.state,
        validationFailure: job.validationFailure,
        applicationFailure: job.applicationFailure,
        elapsedMs: job.elapsedMs,
        diagnostics: job.diagnostics,
        diagnosticsUnavailable: job.diagnosticsUnavailable,
      });
      return retained;
    },
    refreshDiagnostics() {
      if (job.state === "Preparing") {
        captureDiagnostics();
      }
      return job.diagnostics;
    },
    isProgressCurrent() {
      return !signal.aborted && ownsSession() && compactionSettingsKey(runtime.get().settings) === settingsKey;
    },
    isCurrent() {
      const reason = signal.aborted
        ? (job.validationFailure ?? "background job was cancelled")
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
    const request = preparation.start({
      signal: requestSignal,
      deadlineSignal: deadline.signal,
      isCurrent: () => job.isCurrent(),
      ownsStatus: () => false,
      failureReportOwner: "consumer",
    });
    // Cancellation bounds the consumer even if a producer ignores its signal.
    // Only the producer's settlement makes its diagnostics a final snapshot.
    const settled = () => {
      producerSettled = true;
      captureDiagnostics();
    };
    void request.then(settled, settled);
    job.promise = abortable(request, requestSignal);
  } catch (error) {
    producerSettled = true;
    job.promise = Promise.reject(error);
  }
  job.promise = job.promise
    .then(
      (prepared) => {
        job.refreshDiagnostics();
        const outcome = job.diagnostics?.outcome;
        job.state =
          outcome === "discarded"
            ? "Discarded"
            : outcome === "cancelled"
              ? "Cancelled"
              : prepared.usable
                ? "Ready"
                : "Failed";
        if (job.state === "Discarded" || job.state === "Cancelled")
          job.validationFailure ??= job.diagnostics?.reason ?? preparation.reason ?? "checkpoint is no longer current";
        else job.applicationFailure = prepared.failure;
        return prepared;
      },
      (error: unknown) => {
        job.refreshDiagnostics();
        job.state = signal.aborted ? "Cancelled" : "Failed";
        if (signal.aborted) job.validationFailure ??= "background job was cancelled";
        else
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
