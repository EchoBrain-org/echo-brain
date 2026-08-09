import type { OrganizationRecordDeriveProgress } from '../application/contracts.js';
import { OrganizationRecordDeriveError } from '../application/errors.js';
import type {
  OrganizationRecordAlertPort,
  OrganizationRecordLogReaderPort,
} from '../application/ports.js';
import type { OrganizationRecordDerivedStore } from './derived-store.js';
import { projectOrganizationRecord } from './projection.js';

const DEFAULT_BATCH_SIZE = 64;

export interface OrganizationRecordFollowerDependencies {
  readonly logReader: OrganizationRecordLogReaderPort;
  readonly derived: OrganizationRecordDerivedStore;
  readonly alert?: OrganizationRecordAlertPort;
  readonly batchSize?: number;
}

/**
 * The derive follower: one serialized drain loop inside the same process.
 *
 * Waking is correctness, not optimization. An in-process nudge after each
 * append commit plus a full catch-up pass at process start is what makes the
 * cursor converge; concurrent nudges coalesce into the running pass, and there
 * is no standing poll timer. A crash between append and derive is healed by
 * the startup catch-up.
 *
 * A deterministic derive failure halts the loop after the operator alert.
 * Staleness stays visible and truth is untouched; the composition root decides
 * whether to make the halt process-fatal so the supervisor restart exercises
 * the same catch-up path.
 */
export class OrganizationRecordFollower {
  private readonly logReader: OrganizationRecordLogReaderPort;
  private readonly derived: OrganizationRecordDerivedStore;
  private readonly alert: OrganizationRecordAlertPort | null;
  private readonly batchSize: number;

  private running: Promise<void> | null = null;
  private pending = false;
  private haltedError: unknown = null;
  private recordsDerived = 0;

  constructor(dependencies: OrganizationRecordFollowerDependencies) {
    this.logReader = dependencies.logReader;
    this.derived = dependencies.derived;
    this.alert = dependencies.alert ?? null;
    this.batchSize = dependencies.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  get halted(): boolean {
    return this.haltedError !== null;
  }

  /** True while a drain chain is in flight, including its settle window. */
  get draining(): boolean {
    return this.running !== null;
  }

  get haltCause(): unknown {
    return this.haltedError;
  }

  /** Fire and forget. Never throws into the append path. */
  nudge(): void {
    this.pending = true;
    this.ensureRunning();
  }

  /**
   * Runs to a quiet cursor and resolves. This is both the process-start
   * catch-up and the way a caller waits for its own nudge to be absorbed.
   */
  async drain(): Promise<OrganizationRecordDeriveProgress> {
    this.pending = true;
    this.ensureRunning();
    while (this.running !== null) await this.running;
    return this.progress();
  }

  progress(): OrganizationRecordDeriveProgress {
    return {
      cursor_position: this.derived.cursorPosition(),
      records_derived: this.recordsDerived,
      halted: this.halted,
    };
  }

  private ensureRunning(): void {
    if (this.running !== null || this.halted) return;
    // Start on a microtask so nudges that arrive in the same synchronous burst
    // coalesce into one pass instead of queueing one pass each.
    this.running = Promise.resolve()
      .then(() => this.runLoop())
      .catch((error: unknown) => this.halt(error))
      .finally(() => {
        this.running = null;
        // The settle window: a nudge can land after runLoop read `pending`
        // for the last time and returned, but before this finalizer clears
        // `running`. That nudge found a non-null `running` and did nothing,
        // so without this restart it would be lost until some later nudge —
        // a record sitting underived in a process that looks caught up.
        if (this.pending && !this.halted) this.ensureRunning();
      });
  }

  private async runLoop(): Promise<void> {
    while (this.pending && !this.halted) {
      this.pending = false;
      await this.catchUp();
    }
  }

  private async catchUp(): Promise<void> {
    for (;;) {
      const cursor = this.derived.cursorPosition();
      const batch = this.logReader.readAfter(cursor, this.batchSize);
      if (batch.length === 0) return;
      for (const row of batch) {
        this.derived.commitRecord(projectOrganizationRecord(row));
        this.recordsDerived += 1;
      }
      // Yield between batches so a long catch-up never starves the process.
      await Promise.resolve();
    }
  }

  private halt(error: unknown): void {
    this.haltedError = error;
    this.alert?.({
      kind: 'derive-halted',
      message:
        error instanceof OrganizationRecordDeriveError
          ? error.message
          : `organization record derive halted: ${String(error)}`,
      log_position:
        error instanceof OrganizationRecordDeriveError ? error.log_position : null,
      cause: error,
    });
  }
}
