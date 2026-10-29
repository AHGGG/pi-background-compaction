/** Public, provider-neutral prepared-compaction protocol, version 1. */
import type {
  CompactionEntryDraft,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";

export const COMPACTION_ENGINE_REQUEST = "pi.compaction-engine.v1:request";
export const COMPACTION_ENGINE_AVAILABLE = "pi.compaction-engine.v1:available";
export interface TimingSink {
  record(phase: "boundary" | "validation" | "preparedWait" | "authWait" | "rebind" | "preview", started: number): void;
  measure<T>(phase: "boundary" | "validation" | "preparedWait" | "authWait" | "rebind" | "preview", action: () => T): T;
  wait<T>(phase: "preparedWait" | "authWait", action: () => Promise<T>): Promise<T>;
}
export interface ApplicationGuard {
  signal: AbortSignal;
  isCurrent(): boolean;
  timings?: TimingSink;
}
export type CheckpointAdoption =
  | { kind: "ready"; result: SessionBeforeCompactResult }
  | { kind: "cancel" }
  | { kind: "failed" }
  | { kind: "stale"; reason: string; failure?: boolean };
export interface CheckpointDraft {
  draft?: CompactionEntryDraft;
  checkpointId?: string;
  reason?: string;
  failure?: boolean;
}
export interface PreparedCheckpoint {
  readonly checkpointId?: string;
  readonly usable: boolean;
  /** Producer-filtered safe summary only: no credentials, request/response bodies, session content or stacks. */
  readonly failure?: string;
  adopt(event: SessionBeforeCompactEvent, ctx: ExtensionContext, guard: ApplicationGuard): Promise<CheckpointAdoption>;
  draft(ctx: ExtensionContext, guard: ApplicationGuard): Promise<CheckpointDraft>;
}
/** Producer-filtered bounded metadata only; never include request/response content or credentials. */
export interface PreparationDiagnostics {
  status: string;
  report: string;
  warning?: string;
  /** Optional producer-owned terminal result and safe reason; never infer these from report text. */
  outcome?: "failed" | "prepared" | "ready" | "recovered" | "discarded" | "cancelled";
  reason?: string;
}
export interface CheckpointPreparation {
  readonly requestTimeoutMs: number;
  /** Optional additive diagnostics support; reporting stays producer-owned unless explicitly delegated. */
  diagnostics?(): PreparationDiagnostics;
  readonly reason?: string;
  isCurrent(): boolean;
  start(
    guard: ApplicationGuard & {
      ownsStatus(): boolean;
      deadlineSignal?: AbortSignal;
      /** Consumer will display the final preparation failure and diagnostics together. */
      failureReportOwner?: "consumer";
    },
  ): Promise<PreparedCheckpoint>;
}
export type PreparedSourceResult =
  | { kind: "absent" }
  | { kind: "cancel" }
  | { kind: "ready"; result: SessionBeforeCompactResult; isCurrent?(): boolean }
  | { kind: "fallback"; prepared?: PreparedCheckpoint };
export interface PreparedCompactionSource {
  beforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    guard: ApplicationGuard,
  ): Promise<PreparedSourceResult>;
}
export interface CompactionEngineV1 {
  readonly version: 1;
  available(ctx: ExtensionContext): boolean;
  capture(ctx: ExtensionContext): CheckpointPreparation | undefined;
  checkpointId(ctx: ExtensionContext): string | undefined;
  captureBoundary(ctx: ExtensionContext): () => boolean;
  /** Exactly one optional source; throws on a competing registration. Cleanup is idempotent. */
  attachSource(source: PreparedCompactionSource): () => void;
}
export interface CompactionEngineRequest {
  accept(engine: CompactionEngineV1): void;
}
