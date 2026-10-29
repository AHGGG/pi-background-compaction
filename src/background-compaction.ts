import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { abortable } from "./abortable.js";
import { type BackgroundJob, type PreparationRecord, startBackgroundJob } from "./background-job.js";
import { CompactionTimings } from "./compaction-timing.js";
import { supportsPreparationDiagnostics } from "./preparation-diagnostics.js";
import {
  COMPACTION_ENGINE_AVAILABLE,
  COMPACTION_ENGINE_REQUEST,
  type CompactionEngineV1,
  type PreparedCheckpoint,
  type PreparedCompactionSource,
  type PreparedSourceResult,
} from "./prepared-compaction-protocol.js";
import {
  type BackgroundCompactionSettingsRuntime,
  compactionSettingsKey,
  createBackgroundCompactionSettingsRuntime,
} from "./settings.js";
import { terminalText } from "./terminal.js";

const STATUS_KEY = "background-compaction";
// The engine owns privacy filtering; this boundary only makes its safe summary
// bounded and terminal-safe. Never substitute a raw rejected error here.
const failureText = (reason: string, limit = 240) =>
  terminalText(reason)
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
const preparationFailure = (job: BackgroundJob) =>
  `${failureText(job.applicationFailure ?? "checkpoint preparation failed", 200) || "checkpoint preparation failed"} (elapsed: ${((job.elapsedMs ?? 0) / 1000).toFixed(1)}s)`;
type Owner = {
  controller: AbortController;
  sessionId: string;
  job?: BackgroundJob;
  pauseReason?: string;
  lastPreparation?: PreparationRecord;
  lastFailedPreparation?: PreparationRecord;
  generation: number;
  operation?: AbortController;
  compactionPending?: boolean;
  boundaryCheckpoint?: { job: BackgroundJob; checkpointId: string; timing?: string };
  autoApply?: { job: BackgroundJob; done: Promise<void>; release(): void; cancelled?: boolean };
};

/** Optional controller. The engine remains the only foreground compaction hook. */
export function createBackgroundCompactionExtension(
  options: { settingsRuntime?: BackgroundCompactionSettingsRuntime } = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const runtime = options.settingsRuntime ?? createBackgroundCompactionSettingsRuntime();
    const owners = new WeakMap<object, Owner>();
    const activeManagers = new Set<object>();
    const attempted = new WeakSet<BackgroundJob>();
    // A model failure is not an application attempt. Wait for a successful
    // turn before re-enabling automatic application, including at idle input.
    const awaitingCompletedTurn = new WeakSet<BackgroundJob>();
    let engine: CompactionEngineV1 | undefined;
    let detachSource: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let connectionIssue: string | undefined;
    const ownerFor = (ctx: ExtensionContext) => {
      let owner = owners.get(ctx.sessionManager);
      if (owner?.controller.signal.aborted) return owner;
      const sessionId = ctx.sessionManager.getSessionId();
      if (!owner || owner.sessionId !== sessionId) {
        owner?.controller.abort();
        owner?.autoApply?.release();
        owner = { controller: new AbortController(), sessionId, generation: 0 };
        owners.set(ctx.sessionManager, owner);
        activeManagers.add(ctx.sessionManager);
      }
      return owner;
    };
    const owned = (ctx: ExtensionContext, owner: Owner) =>
      owners.get(ctx.sessionManager) === owner &&
      !owner.controller.signal.aborted &&
      owner.sessionId === ctx.sessionManager.getSessionId();
    const log = (ctx: ExtensionContext, message: string) => {
      const owner = owners.get(ctx.sessionManager);
      if (ctx.hasUI && runtime.get().settings.logCompaction && owner && owned(ctx, owner))
        ctx.ui.notify(`[background-compaction] ${message}`, "info");
    };
    const cancelJob = (ctx: ExtensionContext, reason?: string) => {
      const owner = owners.get(ctx.sessionManager);
      const job = owner?.job;
      if (!owner || !job) return;
      let notice: string | undefined;
      if (job.state !== "Failed") {
        job.validationFailure = reason ?? job.validationFailure ?? "checkpoint is no longer current";
        notice = `${job.state === "Ready" || job.state === "Discarded" ? "Async compaction checkpoint discarded." : "Async compaction cancelled."} Reason: ${job.validationFailure}.`;
        if (job.state !== "Discarded" && job.state !== "Cancelled")
          job.state = job.state === "Ready" ? "Discarded" : "Cancelled";
      }
      owner.lastPreparation = job.retain();
      if (owner.autoApply?.job === job) owner.autoApply.cancelled = true;
      owner.job = undefined;
      owner.boundaryCheckpoint = undefined;
      job.controller.abort();
      if (!owned(ctx, owner) || owner.job) return;
      ctx.ui.setStatus(STATUS_KEY, undefined);
      if (notice && owned(ctx, owner) && !owner.job) log(ctx, notice);
    };
    const preparationReport = (job: PreparationRecord) => {
      const available = job.diagnostics?.report;
      const report = available
        ? `${job.state !== "Preparing" && job.diagnosticsUnavailable ? "Final diagnostic snapshot unavailable; last available diagnostics follow.\n" : ""}${available}`
        : `${job.diagnosticContext}\nDetailed diagnostics unavailable from the loaded compaction engine (unsupported or unreadable snapshot).`;
      return report;
    };
    const preparationStatus = (job: PreparationRecord) =>
      `${job.state}${job.validationFailure || job.applicationFailure ? ` — ${failureText(job.validationFailure ?? job.applicationFailure ?? "")}` : ""}`;
    const diagnosticReports = (owner: Owner) => {
      const active = owner.job;
      if (active?.state === "Preparing") active.refreshDiagnostics();
      const current = active?.retain();
      const last = owner.lastPreparation;
      const failed = owner.lastFailedPreparation;
      return [
        ...(current && current !== last
          ? [`Current preparation (${preparationStatus(current)}):\n${preparationReport(current)}`]
          : []),
        ...(last
          ? [
              `${last === failed ? "Last failed preparation" : "Last preparation"} (${preparationStatus(last)}):\n${preparationReport(last)}`,
            ]
          : []),
        ...(failed && failed !== last && failed !== current
          ? [`Last failed preparation:\n${preparationReport(failed)}`]
          : []),
      ].join("\n\n");
    };
    const pause = (
      ctx: ExtensionContext,
      owner: Owner,
      reason: string,
      generation = owner.generation,
      failedPreparation?: BackgroundJob,
    ) => {
      if (!owned(ctx, owner) || owner.generation !== generation || owner.pauseReason) return;
      reason = failureText(reason) || "compaction failed";
      owner.pauseReason = reason;
      const recovery =
        "Manual /compact and Pi automatic compaction remain available. Use /background-compaction resume to retry.";
      if (failedPreparation) {
        owner.lastPreparation = failedPreparation.retain();
        owner.lastFailedPreparation = owner.lastPreparation;
        const report = preparationReport(failedPreparation);
        if (ctx.hasUI)
          ctx.ui.notify(
            `[background-compaction] Async compaction failed: ${reason}.\nWarm-ahead paused for this session. ${recovery}\n${report}`,
            "warning",
          );
      } else if (ctx.hasUI)
        ctx.ui.notify(
          `[background-compaction] Warm-ahead paused for this session. Reason: ${reason}. ${recovery}`,
          "warning",
        );
    };
    const resume = (ctx: ExtensionContext, owner: Owner) => {
      if (!owned(ctx, owner)) return;
      if (!owner.pauseReason) {
        if (ctx.hasUI) ctx.ui.notify("Warm-ahead is not paused.", "info");
        return;
      }
      owner.generation += 1;
      owner.pauseReason = undefined;
      cancelJob(ctx, "warm-ahead explicitly resumed");
      if (ctx.hasUI)
        ctx.ui.notify(
          "Warm-ahead resumed for this session; preparation can start after the next completed turn.",
          "info",
        );
    };
    const watchPreparation = (ctx: ExtensionContext, owner: Owner, job: BackgroundJob) => {
      let warned = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const stop = () => {
        if (timer) clearInterval(timer);
        timer = undefined;
        job.controller.signal.removeEventListener("abort", stop);
        owner.controller.signal.removeEventListener("abort", stop);
      };
      const update = () => {
        if (!owned(ctx, owner) || owner.job !== job || job.state !== "Preparing" || job.controller.signal.aborted) {
          stop();
          return;
        }
        if (!job.isProgressCurrent()) {
          cancelJob(ctx, "background preparation lifetime or settings changed");
          stop();
          return;
        }
        const diagnostics = job.refreshDiagnostics();
        if (diagnostics?.status) ctx.ui.setStatus(STATUS_KEY, diagnostics.status);
        if (diagnostics?.warning && !warned) {
          warned = true;
          ctx.ui.notify(`[background-compaction] ${diagnostics.warning}`, "info");
        }
      };
      timer = setInterval(update, 5_000);
      timer.unref?.();
      job.controller.signal.addEventListener("abort", stop, { once: true });
      owner.controller.signal.addEventListener("abort", stop, { once: true });
      void job.promise.then(stop, stop);
      update();
    };
    const confirmBoundary = (ctx: ExtensionContext) => {
      const owner = owners.get(ctx.sessionManager);
      const pending = owner?.boundaryCheckpoint;
      if (!owner || !pending || !owned(ctx, owner)) return;
      owner.boundaryCheckpoint = undefined;
      if (engine?.checkpointId(ctx) !== pending.checkpointId) return;
      if (owner.job === pending.job) owner.job = undefined;
      pending.job.controller.abort();
      ctx.ui.setStatus(STATUS_KEY, undefined);
      log(ctx, "Actual compaction completed: checkpoint committed at the turn boundary.");
      if (pending.timing) log(ctx, pending.timing);
    };
    const stopPreparation = (ctx: ExtensionContext) => {
      confirmBoundary(ctx);
      const job = owners.get(ctx.sessionManager)?.job;
      if (job?.state === "Ready" && job.isCurrent()) attempted.add(job);
      else if (job) cancelJob(ctx, job.validationFailure ?? "main run was cancelled");
    };
    const beforeCompact: PreparedCompactionSource["beforeCompact"] = async (event, ctx, guard) => {
      const owner = ownerFor(ctx);
      if (!owned(ctx, owner)) return { kind: "absent" };
      owner.operation?.abort();
      const operation = new AbortController();
      owner.operation = operation;
      owner.compactionPending = true;
      const automatic = owner.autoApply;
      const settingsKey = compactionSettingsKey(runtime.get().settings);
      const finishResult = (result: PreparedSourceResult): PreparedSourceResult => {
        if (result.kind === "cancel") {
          owner.compactionPending = false;
          log(ctx, "Actual compaction cancelled; history preserved.");
        }
        return result;
      };
      log(
        ctx,
        `Actual compaction triggered (${event.reason === "manual" ? "manual" : event.reason === "overflow" ? "overflow" : "threshold"}).`,
      );
      if (event.customInstructions?.trim()) cancelJob(ctx, "foreground compaction has custom instructions");
      const job = owner.job;
      const isCurrent = () =>
        owned(ctx, owner) &&
        owner.operation === operation &&
        !operation.signal.aborted &&
        guard.isCurrent() &&
        (!automatic || (runtime.get().settings.asyncEnabled && runtime.get().settings.asyncAutoApply));
      const signal = AbortSignal.any([guard.signal, event.signal, owner.controller.signal, operation.signal]);
      try {
        // A claim requests this exact result, not permission to start new inference.
        if (
          automatic &&
          (automatic.job !== job ||
            automatic.cancelled ||
            event.reason !== "manual" ||
            event.customInstructions?.trim() ||
            !runtime.get().settings.asyncEnabled ||
            !runtime.get().settings.asyncAutoApply)
        )
          return finishResult({ kind: "cancel" });
        if (!job) return { kind: "absent" };
        if (job.state === "Preparing" && job.isCurrent())
          log(ctx, "Actual compaction is waiting for the in-flight async checkpoint.");
        let prepared: PreparedCheckpoint | undefined;
        let outcome: PreparedSourceResult;
        if (!job.isCurrent()) {
          outcome = automatic ? { kind: "cancel" } : { kind: "fallback" };
        } else {
          try {
            prepared = await abortable(job.promise, signal);
            if (signal.aborted || !isCurrent()) return finishResult({ kind: "cancel" });
            const adoption = await prepared.adopt(event, ctx, {
              signal,
              isCurrent: () => isCurrent() && job.isCurrent(),
            });
            if (adoption.kind === "stale") {
              job.validationFailure = adoption.reason;
              if (adoption.failure) job.applicationFailure = adoption.reason;
            }
            if (automatic && !runtime.get().settings.asyncAutoApply && job.isCurrent())
              return finishResult({ kind: "cancel" });
            if (adoption.kind === "cancel") outcome = { kind: "cancel" };
            else if (adoption.kind === "ready") {
              log(ctx, "Actual compaction is reusing the async checkpoint.");
              outcome =
                isCurrent() && !signal.aborted
                  ? {
                      ...adoption,
                      isCurrent: () =>
                        owned(ctx, owner) &&
                        !operation.signal.aborted &&
                        compactionSettingsKey(runtime.get().settings) === settingsKey &&
                        guard.isCurrent() &&
                        (!automatic || (runtime.get().settings.asyncEnabled && runtime.get().settings.asyncAutoApply)),
                    }
                  : { kind: "cancel" };
            } else {
              log(
                ctx,
                `Async checkpoint application rejected. Reason: ${job.validationFailure ?? "background preparation failed"}.`,
              );
              outcome = automatic ? { kind: "cancel" } : { kind: "fallback", prepared };
            }
          } catch {
            outcome = signal.aborted || automatic ? { kind: "cancel" } : { kind: "fallback", prepared };
          }
        }
        if (automatic && job.applicationFailure && isCurrent() && !signal.aborted)
          pause(ctx, owner, job.applicationFailure, owner.generation, job.state === "Failed" ? job : undefined);
        if (owner.job === job) {
          if (outcome.kind === "ready") owner.job = undefined;
          else
            cancelJob(
              ctx,
              job.validationFailure ?? (outcome.kind === "cancel" ? "compaction was cancelled" : undefined),
            );
        }
        job.controller.abort();
        ctx.ui.setStatus(STATUS_KEY, undefined);
        if (outcome.kind === "fallback" && isCurrent())
          log(ctx, "Async checkpoint unavailable; using the foreground compaction path.");
        return finishResult(outcome);
      } finally {
        if (owner.operation === operation) owner.operation = undefined;
      }
    };
    const accept = (candidate: CompactionEngineV1) => {
      if (candidate?.version !== 1 || typeof candidate.attachSource !== "function") return;
      if (engine === candidate) return;
      if (engine) {
        connectionIssue = "More than one compaction engine is installed; using the first registered engine.";
        return;
      }
      try {
        const release = candidate.attachSource({ beforeCompact });
        engine = candidate;
        detachSource = release;
        connectionIssue = undefined;
      } catch {
        connectionIssue =
          "A prepared-compaction controller is already attached. Disable duplicate background extensions.";
      }
    };
    const connect = () => {
      unsubscribe ??= pi.events.on(COMPACTION_ENGINE_AVAILABLE, (value) => accept(value as CompactionEngineV1));
      pi.events.emit(COMPACTION_ENGINE_REQUEST, { accept });
    };
    // Only register callbacks here; session-owned requests begin at completed turns.
    connect();

    const applyAtIdleBoundary = async (ctx: ExtensionContext) => {
      const owner = owners.get(ctx.sessionManager);
      if (!owner) return;
      if (owner.autoApply) {
        await owner.autoApply.done;
        return;
      }
      const job = owner.job;
      const settings = runtime.get().settings;
      if (!settings.asyncEnabled || !settings.asyncAutoApply || owner.pauseReason || !job || job.state !== "Ready")
        return;
      if (!job.isCurrent()) {
        cancelJob(ctx);
        return;
      }
      if (
        !owned(ctx, owner) ||
        owner.operation ||
        owner.compactionPending ||
        !engine?.available(ctx) ||
        !ctx.isIdle() ||
        ctx.hasPendingMessages() ||
        attempted.has(job) ||
        awaitingCompletedTurn.has(job)
      )
        return;
      attempted.add(job);
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const generation = owner.generation;
      const runSignal = ctx.signal;
      const claim: NonNullable<Owner["autoApply"]> = {
        job,
        done,
        release: () => {
          if (owner.autoApply === claim) owner.autoApply = undefined;
          finish();
        },
      };
      owner.autoApply = claim;
      try {
        ctx.compact({
          onComplete: claim.release,
          onError: (error) => {
            if (
              error.message !== "Compaction cancelled" &&
              !claim.cancelled &&
              !runSignal?.aborted &&
              owner.autoApply === claim
            )
              pause(ctx, owner, "automatic checkpoint application failed", generation);
            log(ctx, "Automatic checkpoint application did not complete; history preserved.");
            claim.release();
          },
        });
      } catch (error) {
        if (
          !(error instanceof Error && error.message === "Compaction cancelled") &&
          !claim.cancelled &&
          !runSignal?.aborted &&
          owner.autoApply === claim
        )
          pause(ctx, owner, "automatic checkpoint application failed", generation);
        claim.release();
      }
      await done;
    };

    pi.registerCommand("background-compaction", {
      description: "Configure background compaction, show diagnostics, or resume a paused session",
      getArgumentCompletions: (prefix) =>
        [
          { value: "resume", label: "resume — retry background preparation" },
          { value: "diagnostics", label: "diagnostics — show current and last failed preparation reports" },
        ].filter(({ value }) => value.startsWith(prefix)),
      handler: async (args, ctx) => {
        if (args.trim() && !["resume", "diagnostics"].includes(args.trim()))
          throw new Error("Usage: /background-compaction [resume|diagnostics]");
        const owner = ownerFor(ctx);
        if (args.trim() === "resume") {
          resume(ctx, owner);
          return;
        }
        if (args.trim() === "diagnostics") {
          if (!owned(ctx, owner)) return;
          if (ctx.hasUI)
            ctx.ui.notify(diagnosticReports(owner) || "No preparation diagnostics available in this session.", "info");
          return;
        }
        const { showBackgroundCompactionMenu } = await import("./settings-menu.js");
        if (!owned(ctx, owner)) return;
        await showBackgroundCompactionMenu(runtime, ctx, {
          signal: owner.controller.signal,
          isCurrent: () => owned(ctx, owner),
          backgroundStatus: () =>
            owner.job?.state === "Preparing" || owner.job?.state === "Ready" ? owner.job.state : undefined,
          lastPreparationStatus: () => (owner.lastPreparation ? preparationStatus(owner.lastPreparation) : undefined),
          preparationStatus: () =>
            owner.job?.state === "Preparing" ? owner.job.refreshDiagnostics()?.status : undefined,
          diagnosticReport: () => diagnosticReports(owner),
          warmPauseReason: () =>
            owner.pauseReason ??
            (!engine ? (connectionIssue ?? "No compatible compaction engine installed.") : undefined),
          onResumeWarm: () => resume(ctx, owner),
          onSettingsChanged: () => {
            owner.operation?.abort();
            cancelJob(ctx, "settings changed in the compaction menu");
          },
        });
      },
    });
    pi.on("session_start", async (_event, ctx) => {
      const previous = owners.get(ctx.sessionManager);
      previous?.controller.abort();
      previous?.autoApply?.release();
      const owner: Owner = {
        controller: new AbortController(),
        sessionId: ctx.sessionManager.getSessionId(),
        generation: 0,
      };
      owners.set(ctx.sessionManager, owner);
      activeManagers.add(ctx.sessionManager);
      ctx.ui.setStatus(STATUS_KEY, undefined);
      connect();
      try {
        const state = await runtime.reload(owner.controller.signal);
        if (!owned(ctx, owner)) return;
        if (ctx.hasUI && state.kind === "invalid")
          ctx.ui.notify(
            `Invalid background compaction settings; background preparation is disabled without overwriting the file. ${terminalText(state.issue ?? "unknown validation error")}`,
            "warning",
          );
        if (ctx.hasUI && state.source === "legacy")
          ctx.ui.notify(
            "Background compaction is using your existing pi-codex-compact.json preferences. Save in /background-compaction to migrate them; the old file is unchanged.",
            "info",
          );
        if (ctx.hasUI && connectionIssue) ctx.ui.notify(connectionIssue, "warning");
        if (ctx.hasUI && state.settings.asyncEnabled && !engine)
          ctx.ui.notify(
            "Background compaction is enabled but no compatible compaction engine is installed. Update pi-codex-compact; ordinary /compact remains available.",
            "warning",
          );
      } catch (error) {
        if (owned(ctx, owner) && ctx.hasUI)
          ctx.ui.notify(
            `Could not load background compaction settings; using defaults. ${terminalText(error instanceof Error ? error.message : String(error))}`,
            "warning",
          );
      }
    });

    pi.on("turn_end", async (event, ctx) => {
      confirmBoundary(ctx);
      const owner = ownerFor(ctx);
      if (event.outcome !== "completed" || ctx.signal?.aborted) {
        const job = owner.job;
        if (
          event.outcome === "error" &&
          !ctx.signal?.aborted &&
          (job?.state === "Preparing" || job?.state === "Ready") &&
          job.isCurrent()
        )
          awaitingCompletedTurn.add(job);
        else stopPreparation(ctx);
        return;
      }
      const previous = owner.job;
      if (previous) awaitingCompletedTurn.delete(previous);
      const timings =
        previous?.state === "Ready" && ctx.hasUI && runtime.get().settings.logCompaction
          ? new CompactionTimings()
          : undefined;
      if (previous && !(timings ? timings.measure("validation", () => previous.isCurrent()) : previous.isCurrent()))
        cancelJob(ctx);
      const job = owner.job;
      const ownsApplication = () => {
        const settings = runtime.get().settings;
        return (
          !!engine &&
          settings.asyncEnabled &&
          settings.asyncAutoApply &&
          !owner.pauseReason &&
          owned(ctx, owner) &&
          owner.job === job &&
          !ctx.signal?.aborted &&
          !owner.operation &&
          !owner.compactionPending &&
          !owner.autoApply &&
          engine.available(ctx)
        );
      };
      if (
        job?.state === "Ready" &&
        ownsApplication() &&
        !attempted.has(job) &&
        !(event.entries ?? []).some((entry) => entry.type === "compaction" || entry.type === "context_edit")
      ) {
        attempted.add(job);
        let returned = false;
        try {
          const capture = () => engine?.captureBoundary(ctx) ?? (() => false);
          const exact = timings ? timings.measure("boundary", capture) : capture();
          const valid = () => ownsApplication() && job.isCurrent() && exact();
          const signal = AbortSignal.any([owner.controller.signal, ...(ctx.signal ? [ctx.signal] : [])]);
          let application: Awaited<ReturnType<PreparedCheckpoint["draft"]>> | undefined;
          try {
            const pending = () => abortable(job.promise, signal);
            const prepared = await (timings ? timings.wait("preparedWait", pending) : pending());
            application = await prepared.draft(ctx, { signal, isCurrent: ownsApplication, timings });
          } catch {
            if (valid()) job.applicationFailure = "automatic checkpoint validation failed";
          }
          if (application?.reason) job.validationFailure = application.reason;
          if (application?.failure)
            job.applicationFailure = application.reason ?? "automatic checkpoint validation failed";
          if (application?.draft) log(ctx, "Actual compaction is reusing the async checkpoint at the turn boundary.");
          const applicable = timings ? timings.measure("validation", valid) : valid();
          if (application?.draft && application.checkpointId && applicable) {
            owner.boundaryCheckpoint = { job, checkpointId: application.checkpointId, timing: timings?.message() };
            returned = true;
            return { entries: [...(event.entries ?? []), application.draft] };
          }
          if (job.applicationFailure && applicable) pause(ctx, owner, job.applicationFailure);
          if (!ctx.signal?.aborted && owner.job === job && runtime.get().settings.asyncAutoApply) cancelJob(ctx);
          return;
        } finally {
          if (timings && !returned) log(ctx, timings.message());
        }
      }
      const settings = runtime.get().settings;
      if (
        !engine ||
        !settings.asyncEnabled ||
        owner.pauseReason ||
        owner.job ||
        owner.operation ||
        owner.compactionPending ||
        !owned(ctx, owner) ||
        !engine.available(ctx)
      )
        return;
      const usage = ctx.getContextUsage();
      if (
        !usage ||
        usage.tokens === null ||
        !Number.isFinite(usage.tokens) ||
        !Number.isFinite(usage.contextWindow) ||
        usage.contextWindow <= 0 ||
        (usage.tokens / usage.contextWindow) * 100 < settings.asyncThresholdPercent
      )
        return;
      const preparation = engine.capture(ctx);
      if (!preparation) return;
      const started = startBackgroundJob(preparation, ctx, runtime, owner.controller.signal, () => owned(ctx, owner));
      owner.job = started;
      ctx.ui.setStatus(STATUS_KEY, "Preparing compaction…");
      if (ctx.hasUI && supportsPreparationDiagnostics(preparation)) watchPreparation(ctx, owner, started);
      log(ctx, "Async compaction triggered: preparing a compaction result in the background.");
      const settled = () => {
        if (owner.job !== started || !owned(ctx, owner)) return;
        ctx.ui.setStatus(STATUS_KEY, undefined);
        if (owner.job !== started || !owned(ctx, owner)) return;
        if (!started.isCurrent() || started.state === "Discarded" || started.state === "Cancelled") {
          if (started.state === "Failed") {
            started.state = started.controller.signal.aborted ? "Cancelled" : "Discarded";
            started.applicationFailure = undefined;
          }
          cancelJob(ctx);
          return;
        }
        if (started.state === "Ready") {
          if (ctx.hasUI)
            ctx.ui.notify(
              `[background-compaction] ${
                runtime.get().settings.asyncAutoApply
                  ? awaitingCompletedTurn.has(started)
                    ? "Async compaction ready: waiting for a successful completed turn before automatic application."
                    : "Async compaction ready: the prepared compaction will apply after the current model/tool batch, or at the next idle input boundary."
                  : "Async compaction ready: run /compact to apply the prepared compaction. History is unchanged until compaction."
              }`,
              "info",
            );
        } else {
          owner.lastPreparation = started.retain();
          owner.lastFailedPreparation = owner.lastPreparation;
          if (started.applicationFailure) pause(ctx, owner, preparationFailure(started), owner.generation, started);
          else
            log(
              ctx,
              `Async compaction failed: ${preparationFailure(started)}. Actual compaction will use the foreground recovery path.\n${preparationReport(started)}`,
            );
        }
      };
      void started.promise.then(settled, settled);
    });
    pi.on("session_compact", (_event, ctx) => {
      const owner = owners.get(ctx.sessionManager);
      if (owner?.compactionPending) {
        owner.compactionPending = false;
        log(ctx, "Actual compaction completed: checkpoint committed.");
      }
      confirmBoundary(ctx);
    });
    pi.on("session_compact_failed", (event, ctx) => {
      const owner = owners.get(ctx.sessionManager);
      if (owner?.autoApply && event.aborted) owner.autoApply.cancelled = true;
      if (owner?.compactionPending) {
        owner.compactionPending = false;
        log(ctx, "Actual compaction did not complete (failed or cancelled).");
      }
    });
    pi.on("input", async (_event, ctx) => {
      confirmBoundary(ctx);
      await applyAtIdleBoundary(ctx);
    });
    pi.on("agent_settled", async (event, ctx) => {
      confirmBoundary(ctx);
      if (event.aborted) stopPreparation(ctx);
      else await applyAtIdleBoundary(ctx);
    });
    pi.on("turn_start", (_event, ctx) => confirmBoundary(ctx));
    pi.on("context", (_event, ctx) => {
      confirmBoundary(ctx);
      const job = owners.get(ctx.sessionManager)?.job;
      if (job && !job.isCurrent()) cancelJob(ctx);
    });
    const navigate = (_event: unknown, ctx: ExtensionContext) => {
      const owner = owners.get(ctx.sessionManager);
      owner?.operation?.abort();
      if (owner) owner.compactionPending = false;
      cancelJob(ctx, "session navigation or model/thinking-level selection");
    };
    pi.on("session_before_switch", navigate);
    pi.on("session_before_fork", navigate);
    pi.on("session_before_tree", navigate);
    pi.on("thinking_level_select", (_event, ctx) => {
      const job = owners.get(ctx.sessionManager)?.job;
      // The engine owns format-specific validity. Older engines retain their strict check.
      if (job && !job.isCurrent()) navigate(_event, ctx);
    });
    pi.on("model_select", navigate);
    pi.on("session_tree", navigate);
    pi.on("session_shutdown", async (_event, ctx) => {
      const owner = ownerFor(ctx);
      owner.controller.abort();
      owner.job?.controller.abort();
      owner.job = undefined;
      owner.operation?.abort();
      owner.autoApply?.release();
      ctx.ui.setStatus(STATUS_KEY, undefined);
      activeManagers.delete(ctx.sessionManager);
      if (activeManagers.size === 0) {
        detachSource?.();
        detachSource = undefined;
        engine = undefined;
        unsubscribe?.();
        unsubscribe = undefined;
      }
      await runtime.flush();
    });
  };
}

export default createBackgroundCompactionExtension();
