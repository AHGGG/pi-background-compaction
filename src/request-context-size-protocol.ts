/** Optional value-only transport observation. No request contents or credentials. */
export const REQUEST_CONTEXT_SIZE_OBSERVED = "pi.request-context-size.v1:observed";
export interface RequestContextSizeObservation {
  sessionManager: object;
  sessionId: string;
  provider: string;
  model: string;
  /** UTF-8 bytes of a full request, even when the transport sends only a delta. */
  fullRequestBytes: number;
  /** Producer-owned request/session lifetime, not an exact pre-response history boundary. */
  isCurrent(): boolean;
}
export function isRequestContextSizeObservation(value: unknown): value is RequestContextSizeObservation {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RequestContextSizeObservation>;
  return (
    !!item.sessionManager &&
    typeof item.sessionManager === "object" &&
    typeof item.sessionId === "string" &&
    typeof item.provider === "string" &&
    typeof item.model === "string" &&
    typeof item.fullRequestBytes === "number" &&
    Number.isSafeInteger(item.fullRequestBytes) &&
    item.fullRequestBytes >= 0 &&
    typeof item.isCurrent === "function"
  );
}
