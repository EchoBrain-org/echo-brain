import type { GranolaApiClient } from "../../adapters/meeting-sources/granola/index.js";
import { canonicalSha256, sha256Digest } from "./canonical-json.js";
import type { ProviderIdentityV1 } from "./contracts.js";
import { assertUtcMillisecondTimestamp } from "./identifiers.js";

const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 15_000;
const MAX_DIAGNOSTIC_TIMEOUT_MS = 120_000;

export interface GranolaFirstCaptureEvidenceV1 {
  schema_version: 1;
  kind: "echo-granola-first-capture-evidence";
  provider: "granola";
  operation: "list_notes";
  requested_page_size: 1;
  notes_observed: 1;
  observed_note_id_sha256: `sha256:${string}`;
  response_has_more: boolean;
  observed_at: string;
}

export interface GranolaProviderIdentitySnapshotV1 {
  provider: "granola";
  provider_identity: ProviderIdentityV1;
  evidence: GranolaFirstCaptureEvidenceV1;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function assertGranolaProviderIdentitySnapshot(
  snapshot: GranolaProviderIdentitySnapshotV1,
): void {
  const { evidence, provider_identity: identity } = snapshot;
  if (
    snapshot.provider !== "granola" ||
    evidence.schema_version !== 1 ||
    evidence.kind !== "echo-granola-first-capture-evidence" ||
    evidence.provider !== "granola" ||
    evidence.operation !== "list_notes" ||
    evidence.requested_page_size !== 1 ||
    evidence.notes_observed !== 1 ||
    !DIGEST_RE.test(evidence.observed_note_id_sha256) ||
    typeof evidence.response_has_more !== "boolean" ||
    identity.tenant !== null ||
    identity.subject !== null ||
    identity.verification.method !== "provider_first_capture" ||
    identity.verification.assurance !== "credential_observed" ||
    identity.verification.evidence_sha256 !== canonicalSha256(evidence)
  ) {
    throw new Error("Granola first-capture identity evidence is invalid");
  }
  assertUtcMillisecondTimestamp(
    evidence.observed_at,
    "Granola evidence observed_at",
  );
  if (identity.verification.verified_at !== evidence.observed_at) {
    throw new Error(
      "Granola identity verification time disagrees with its evidence",
    );
  }
}

export class GranolaConnectionEvidenceError extends Error {
  constructor(
    message: string,
    public readonly reason:
      "cancelled" | "timeout" | "no_observable_note" | "unbounded_response",
  ) {
    super(message);
    this.name = "GranolaConnectionEvidenceError";
  }
}

export interface ObserveGranolaConnectionOptions {
  /** Fixed test/evidence time. Production should prefer `now`. */
  observedAt?: string;
  /** Called only after the bounded provider response succeeds. */
  now?: () => string;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

function requestTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_DIAGNOSTIC_TIMEOUT_MS;
  if (
    !Number.isInteger(timeout) ||
    timeout <= 0 ||
    timeout > MAX_DIAGNOSTIC_TIMEOUT_MS
  ) {
    throw new RangeError(
      `Granola diagnostic timeout must be an integer between 1 and ${MAX_DIAGNOSTIC_TIMEOUT_MS}`,
    );
  }
  return timeout;
}

/**
 * Perform one bounded, read-only Granola list operation for connection
 * enrollment. This does not accept or emit a product cursor and never fetches
 * note detail, so it cannot advance capture state or persist meeting content.
 */
export async function observeGranolaConnection(
  client: GranolaApiClient,
  options: ObserveGranolaConnectionOptions,
): Promise<GranolaProviderIdentitySnapshotV1> {
  if ((options.observedAt === undefined) === (options.now === undefined)) {
    throw new Error(
      "Granola connection observation requires exactly one timestamp source",
    );
  }
  if (options.observedAt !== undefined) {
    assertUtcMillisecondTimestamp(
      options.observedAt,
      "Granola observation time",
    );
  }
  const timeoutMs = requestTimeout(options.requestTimeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const onParentAbort = () => {
    controller.abort(options.signal?.reason);
    rejectDeadline(
      new GranolaConnectionEvidenceError(
        "Granola connection diagnostic was cancelled",
        "cancelled",
      ),
    );
  };
  if (options.signal?.aborted === true) {
    throw new GranolaConnectionEvidenceError(
      "Granola connection diagnostic was cancelled",
      "cancelled",
    );
  }
  options.signal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectDeadline(
      new GranolaConnectionEvidenceError(
        "Granola connection diagnostic timed out",
        "timeout",
      ),
    );
  }, timeoutMs);

  try {
    if (controller.signal.aborted) {
      throw new GranolaConnectionEvidenceError(
        "Granola connection diagnostic was cancelled",
        "cancelled",
      );
    }
    const response = await Promise.race([
      client.listNotes({ page_size: 1 }, { signal: controller.signal }),
      deadline,
    ]);
    if (response.notes.length === 0) {
      throw new GranolaConnectionEvidenceError(
        "Granola credential is usable but no note exists for first-capture evidence",
        "no_observable_note",
      );
    }
    if (response.notes.length !== 1) {
      throw new GranolaConnectionEvidenceError(
        "Granola diagnostic response exceeded its one-note evidence bound",
        "unbounded_response",
      );
    }

    const observedAt = options.observedAt ?? options.now!();
    assertUtcMillisecondTimestamp(observedAt, "Granola observation time");
    const evidence: GranolaFirstCaptureEvidenceV1 = {
      schema_version: 1,
      kind: "echo-granola-first-capture-evidence",
      provider: "granola",
      operation: "list_notes",
      requested_page_size: 1,
      notes_observed: 1,
      observed_note_id_sha256: sha256Digest(response.notes[0]!.id),
      response_has_more: response.hasMore,
      observed_at: observedAt,
    };
    const snapshot: GranolaProviderIdentitySnapshotV1 = {
      provider: "granola",
      provider_identity: {
        tenant: null,
        subject: null,
        verification: {
          method: "provider_first_capture",
          assurance: "credential_observed",
          verified_at: observedAt,
          evidence_sha256: canonicalSha256(evidence),
        },
      },
      evidence,
    };
    assertGranolaProviderIdentitySnapshot(snapshot);
    return snapshot;
  } catch (error) {
    if (
      controller.signal.aborted &&
      !(error instanceof GranolaConnectionEvidenceError)
    ) {
      throw new GranolaConnectionEvidenceError(
        timedOut
          ? "Granola connection diagnostic timed out"
          : "Granola connection diagnostic was cancelled",
        timedOut ? "timeout" : "cancelled",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}
