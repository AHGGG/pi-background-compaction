/** Numeric, request-local diagnostics. Never retain session, provider, or auth data. */
export class CompactionTimings {
  private readonly started = performance.now();
  private readonly phases = {
    boundary: 0,
    validation: 0,
    preparedWait: 0,
    authWait: 0,
    rebind: 0,
    preview: 0,
  };
  private validations = 0;

  record(phase: keyof CompactionTimings["phases"], started: number): void {
    this.phases[phase] += performance.now() - started;
    if (phase === "validation") this.validations += 1;
  }

  measure<T>(phase: keyof CompactionTimings["phases"], action: () => T): T {
    const started = performance.now();
    try {
      return action();
    } finally {
      this.record(phase, started);
    }
  }

  async wait<T>(phase: "preparedWait" | "authWait", action: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await action();
    } finally {
      this.record(phase, started);
    }
  }

  message(): string {
    const phases = Object.entries(this.phases).map(([phase, ms]) => `${phase}=${ms.toFixed(1)}ms`);
    return `Async checkpoint application timing: extensionTotal=${(performance.now() - this.started).toFixed(1)}ms, ${phases.join(", ")}, validations=${this.validations}.`;
  }
}
