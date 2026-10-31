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
  retryCount?: number;
  attempt?: number;
  retryDelayMs?: number;
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
  retry?: {
    onRetry(count: number, delayMs: number): void;
    onAttempt(count: number): void;
  },
): BackgroundJob {
  const started = performance.now();
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ownerSignal]);
  const settings = runtime.get().settings;
  const settingsKey = compactionSettingsKey(settings);
  const runSignal = ctx.signal;
  const cancelPreparing = () => controller.abort();
  runSignal?.addEventListener("abort", cancelPreparing, { once: true });
  if (runSignal?.aborted) controller.abort();
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
      job.diagnostics = {
        ...snapshot,
        report: `${job.diagnosticContext} attempt=${job.attempt ?? 1}\n${snapshot.report}`.slice(0, 16_384),
      };
    if (retained) {
      retained.diagnostics = job.diagnostics;
      retained.diagnosticsUnavailable = job.diagnosticsUnavailable;
    }
  };
  const job: BackgroundJob = {
    controller,
    state: "Preparing",
    diagnosticContext: `companion=${BACKGROUND_COMPACTION_VERSION} background=${settings.asyncEnabled ? "on" : "off"} threshold=${settings.asyncThresholdPercent}% autoApply=${settings.asyncAutoApply ? "on" : "off"} lifecycleLogs=${settings.logCompaction ? "on" : "off"} retryLimit=${settings.asyncRetryCount}`,
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
        retryCount: job.retryCount,
        attempt: job.attempt,
        retryDelayMs: job.retryDelayMs,
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
  // One promise owns the entire bounded retry sequence. Foreground compaction
  // waits on this same promise; it never races a separately scheduled retry.
  const run = async (): Promise<PreparedCheckpoint> => {
    for (;;) {
      if (!job.isCurrent() || deadline.signal.aborted) throw new Error("Background preparation is no longer current");
      producerSettled = false;
      const request = preparation.start({
        signal,
        deadlineSignal: deadline.signal,
        isCurrent: () => job.isCurrent(),
        ownsStatus: () => false,
        failureReportOwner: "consumer",
      });
      const settled = () => {
        producerSettled = true;
        captureDiagnostics();
      };
      void request.then(settled, settled);
      const prepared = await abortable(request, signal);
      captureDiagnostics();
      const outcome = job.diagnostics?.outcome;
      const count = job.retryCount ?? 0;
      if (
        prepared.usable ||
        prepared.retryable !== true ||
        typeof prepared.retry !== "function" ||
        outcome === "cancelled" ||
        outcome === "discarded" ||
        !retry ||
        count >= settings.asyncRetryCount ||
        deadline.signal.aborted ||
        !job.isCurrent()
      )
        return prepared;
      const delayMs = Math.min(5_000 * 2 ** count, 30_000);
      job.retryCount = count + 1;
      job.retryDelayMs = delayMs;
      retry.onRetry(count + 1, delayMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await abortable(
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, delayMs);
          }),
          AbortSignal.any([signal, deadline.signal]),
        );
      } catch (error) {
        if (deadline.signal.aborted && !signal.aborted) return prepared;
        throw error;
      } finally {
        clearTimeout(timer);
        job.retryDelayMs = undefined;
      }
      if (deadline.signal.aborted || !job.isCurrent()) return prepared;
      const retrySignal = AbortSignal.any([signal, deadline.signal]);
      const next = prepared.retry({
        signal: retrySignal,
        isCurrent: () => !deadline.signal.aborted && job.isCurrent(),
      });
      // Producer-owned recapture preserves its original authentication binding.
      // Recapture and status callbacks can reenter; recheck ownership before start.
      if (!next || !job.isCurrent() || !next.isCurrent() || deadline.signal.aborted) return prepared;
      preparation = next;
      job.attempt = count + 2;
      job.diagnostics = undefined;
      job.diagnosticsUnavailable = true;
      retry.onAttempt(count + 1);
    }
  };
  job.promise = run();
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
