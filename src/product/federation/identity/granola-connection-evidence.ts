import { canonicalSha256 } from "../foundation/canonical-json.js";
import type { ProviderIdentityV1 } from "../contracts.js";
import { assertUtcMillisecondTimestamp } from "../foundation/identifiers.js";

/**
 * Persisted Granola first-capture evidence shapes and their validation. The
 * observation code that produced them is retired; stored evidence is still
 * parsed and cross-checked when old founder residue is inspected.
 */

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
