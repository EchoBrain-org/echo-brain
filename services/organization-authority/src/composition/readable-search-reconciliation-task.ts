/** The lifecycle's sole post-startup search owner: one active run and one wake. */
export class ReadableSearchReconciliationTask {
  private readonly controller = new AbortController();
  private pending = false;
  private suspended = 0;
  private immediate: ReturnType<typeof setImmediate> | undefined;
  private active: Promise<void> | undefined;
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | undefined;

  constructor(
    private readonly run: (signal: AbortSignal) => Promise<{ readonly status: string } | void>,
    private readonly report: (error: unknown) => void,
  ) {}

  request(): void {
    if (this.controller.signal.aborted) return;
    this.pending = true;
    if (this.resolveIdle === undefined) {
      this.idle = new Promise((resolve) => { this.resolveIdle = resolve; });
    }
    this.schedule();
  }

  private schedule(): void {
    if (!this.pending || this.active !== undefined || this.immediate !== undefined ||
        this.suspended > 0 || this.controller.signal.aborted) return;
    // Snapshot and synchronous build work must never start on the writer stack.
    this.immediate = setImmediate(() => {
      this.immediate = undefined;
      this.pending = false;
      this.active = Promise.resolve().then(() => this.execute());
    });
  }

  private async execute(): Promise<void> {
    try {
      const result = await this.run(this.controller.signal);
      if (result?.status === "superseded") this.request();
    } catch (error) {
      if (!this.controller.signal.aborted) {
        try { this.report(error); } catch { /* observational only */ }
      }
      // A failure consumes this attempt. Only an actual queued wake or a later
      // normal trigger can retry it; failure itself never generates a wake.
    } finally {
      this.active = undefined;
      if (this.pending) this.schedule();
      else this.finishIdle();
    }
  }

  /** Operator work keeps its original exclusion from both writers and search. */
  suspend(): void {
    this.suspended++;
    this.cancelImmediate();
  }

  resume(): void {
    this.suspended--;
    this.schedule();
  }

  async waitForActive(): Promise<void> { await this.active; }

  async drain(): Promise<void> {
    // A completion callback may enqueue the next wake before this continuation.
    while (this.resolveIdle !== undefined) await this.idle;
  }

  async close(): Promise<void> {
    this.controller.abort();
    this.pending = false;
    this.cancelImmediate();
    // Abort is advisory: an adapter that ignores it still owns its resources
    // until it settles. Never race this await against a shutdown timeout.
    await this.active;
    this.finishIdle();
  }

  private cancelImmediate(): void {
    if (this.immediate !== undefined) clearImmediate(this.immediate);
    this.immediate = undefined;
  }

  private finishIdle(): void {
    this.resolveIdle?.();
    this.resolveIdle = undefined;
  }
}
