import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";

export interface ReadableSearchRecordHeadV1 {
  readonly position: number;
  readonly record_sha256: Sha256Digest | null;
}

export interface ReadableSearchSnapshotV1 {
  readonly record_head: ReadableSearchRecordHeadV1;
}

export interface BuiltReadableSearchGenerationV1 {
  readonly generation_id: Sha256Digest;
  readonly manifest_sha256: Sha256Digest;
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly record_head: ReadableSearchRecordHeadV1;
}

export type ReadableSearchGenerationReconciliationV1 =
  | {
      readonly status: "current";
      readonly record_head: ReadableSearchRecordHeadV1;
    }
  | {
      readonly status: "published";
      readonly record_head: ReadableSearchRecordHeadV1;
      readonly generation_id: Sha256Digest;
      readonly manifest_sha256: Sha256Digest;
    }
  | {
      readonly status: "superseded";
      readonly captured_head: ReadableSearchRecordHeadV1;
      readonly current_head: ReadableSearchRecordHeadV1;
    };

export interface ReadableSearchGenerationReconcilerV1Options<
  Snapshot extends ReadableSearchSnapshotV1,
> {
  readonly authority: Database.Database;
  readonly organization_id: string;
  readonly retrieval_contract_sha256: Sha256Digest;
  /** Cheap exact-head read used before snapshotting and again before publish. */
  readonly read_record_head: () => ReadableSearchRecordHeadV1;
  /** Materializes the complete verified Layer 1 input and releases its read transaction. */
  readonly capture_snapshot: () => Snapshot;
  /** Builds and atomically renames immutable files, but never mutates the pointer. */
  readonly build_generation: (
    snapshot: Snapshot,
  ) => BuiltReadableSearchGenerationV1;
  /** Complete immutable validation must succeed before current/publication. */
  readonly prepare_generation?: (
    generation: BuiltReadableSearchGenerationV1,
  ) => void;
  readonly invalidate_generation?: () => void;
  readonly now?: () => string;
}

interface StoredActiveGeneration {
  readonly organization_id: string;
  readonly generation_id: Sha256Digest;
  readonly manifest_sha256: Sha256Digest;
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly record_head_position: number;
  readonly record_head_hash: Sha256Digest | null;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function digest(value: string, label: string): Sha256Digest {
  if (!DIGEST.test(value)) throw new Error(`${label} is not a SHA-256 digest`);
  return value as Sha256Digest;
}

function head(
  value: ReadableSearchRecordHeadV1,
  label: string,
): ReadableSearchRecordHeadV1 {
  if (!Number.isSafeInteger(value.position) || value.position < 0) {
    throw new Error(`${label} position is invalid`);
  }
  if (
    (value.position === 0 && value.record_sha256 !== null) ||
    (value.position > 0 &&
      (value.record_sha256 === null || !DIGEST.test(value.record_sha256)))
  ) {
    throw new Error(`${label} digest is invalid`);
  }
  return Object.freeze({ ...value });
}

function sameHead(
  left: ReadableSearchRecordHeadV1,
  right: ReadableSearchRecordHeadV1,
): boolean {
  return (
    left.position === right.position &&
    left.record_sha256 === right.record_sha256
  );
}

function pointerHead(
  pointer: StoredActiveGeneration,
): ReadableSearchRecordHeadV1 {
  return head(
    {
      position: pointer.record_head_position,
      record_sha256: pointer.record_head_hash,
    },
    "readable-search pointer head",
  );
}

/**
 * One single-flight exact-head reconciler for the admitted-search V1 flow.
 *
 * The serialized processing worker is the only V4 writer and invokes this after its
 * coalesced append phase. The snapshot closes before generation IO begins. A
 * final head comparison prevents an obsolete completed generation from being
 * published if that ownership rule is widened later.
 */
export class ReadableSearchGenerationReconcilerV1<
  Snapshot extends ReadableSearchSnapshotV1,
> {
  private readonly now: () => string;

  constructor(
    private readonly options: ReadableSearchGenerationReconcilerV1Options<Snapshot>,
  ) {
    if (options.organization_id.length === 0) {
      throw new Error("readable-search organization_id is empty");
    }
    digest(
      options.retrieval_contract_sha256,
      "readable-search retrieval contract",
    );
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async reconcile(
    signal: AbortSignal,
  ): Promise<ReadableSearchGenerationReconciliationV1> {
    signal.throwIfAborted();
    const observedHead = head(
      this.options.read_record_head(),
      "readable-search observed record head",
    );
    const active = this.activeGeneration();
    if (
      active !== null &&
      active.organization_id !== this.options.organization_id
    ) {
      throw new Error(
        "readable-search pointer belongs to another organization",
      );
    }
    if (
      active !== null &&
      active.retrieval_contract_sha256 ===
        this.options.retrieval_contract_sha256 &&
      sameHead(pointerHead(active), observedHead)
    ) {
      this.options.prepare_generation?.({
        generation_id: active.generation_id,
        manifest_sha256: active.manifest_sha256,
        retrieval_contract_sha256: active.retrieval_contract_sha256,
        record_head: pointerHead(active),
      });
      return Object.freeze({ status: "current", record_head: observedHead });
    }

    const snapshot = this.options.capture_snapshot();
    const capturedHead = head(
      snapshot.record_head,
      "readable-search captured record head",
    );
    if (!sameHead(capturedHead, observedHead)) {
      throw new Error(
        "readable-search snapshot did not capture the observed record head",
      );
    }
    signal.throwIfAborted();

    const built = this.options.build_generation(snapshot);
    const builtHead = head(
      built.record_head,
      "readable-search built record head",
    );
    if (
      !sameHead(builtHead, capturedHead) ||
      built.retrieval_contract_sha256 !==
        this.options.retrieval_contract_sha256
    ) {
      throw new Error(
        "readable-search generation does not match its captured input",
      );
    }
    digest(built.generation_id, "readable-search generation_id");
    digest(built.manifest_sha256, "readable-search manifest");
    this.options.prepare_generation?.(built);
    signal.throwIfAborted();

    const currentHead = head(
      this.options.read_record_head(),
      "readable-search publish record head",
    );
    if (!sameHead(currentHead, capturedHead)) {
      this.options.invalidate_generation?.();
      return Object.freeze({
        status: "superseded",
        captured_head: capturedHead,
        current_head: currentHead,
      });
    }

    const publishedAt = this.now();
    if (new Date(publishedAt).toISOString() !== publishedAt) {
      throw new Error(
        "readable-search publication time is not a canonical UTC timestamp",
      );
    }
    this.options.authority.transaction(() => {
      this.options.authority
        .prepare(
          `INSERT INTO authority_readable_search_active_generation (
             singleton, organization_id, generation_id, manifest_sha256,
             retrieval_contract_sha256, record_head_position,
             record_head_hash, published_at
           ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(singleton) DO UPDATE SET
             organization_id = excluded.organization_id,
             generation_id = excluded.generation_id,
             manifest_sha256 = excluded.manifest_sha256,
             retrieval_contract_sha256 = excluded.retrieval_contract_sha256,
             record_head_position = excluded.record_head_position,
             record_head_hash = excluded.record_head_hash,
             published_at = excluded.published_at`,
        )
        .run(
          this.options.organization_id,
          built.generation_id,
          built.manifest_sha256,
          built.retrieval_contract_sha256,
          builtHead.position,
          builtHead.record_sha256,
          publishedAt,
        );
    })();
    return Object.freeze({
      status: "published",
      record_head: builtHead,
      generation_id: built.generation_id,
      manifest_sha256: built.manifest_sha256,
    });
  }

  private activeGeneration(): StoredActiveGeneration | null {
    const row = this.options.authority
      .prepare(
        `SELECT organization_id, generation_id, manifest_sha256,
                retrieval_contract_sha256, record_head_position,
                record_head_hash
           FROM authority_readable_search_active_generation
          WHERE singleton = 1`,
      )
      .get() as StoredActiveGeneration | undefined;
    if (row === undefined) return null;
    digest(row.generation_id, "readable-search active generation_id");
    digest(row.manifest_sha256, "readable-search active manifest");
    digest(
      row.retrieval_contract_sha256,
      "readable-search active retrieval contract",
    );
    pointerHead(row);
    return Object.freeze({ ...row });
  }
}
