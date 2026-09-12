import {
  type Sha256Digest
} from "@echo-brain/federation-protocol";
import { applyAuthorityBaselineV5 } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import Database from "better-sqlite3";
import type {
  ActionableMeetingProcessingCandidateV1,
  MeetingProcessingCandidateV1,
} from "../../../src/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import { legacyRestrictedReviewerReviewPolicySnapshotV1 } from "../../../src/admitted-meeting-processing/review-lineage-semantics.js";
import type {
  DecisionSet,
  MeetingDocument,
} from "../../../src/core/index.js";
export const FIXTURE_PROCESSOR_VERSION = '1.0.0';
const fixtureCursor = (cutoff: string) => 'fixture-source:v1:live:' + cutoff;
export const fixtureCursorPolicy = {
 source_adapter_id: 'fixture-source',
 assert_live_cursor(cursor: string) { if (!cursor.startsWith('fixture-source:v1:live:')) throw new Error('fixture cursor must be live'); },
};
export const ADMITTED_AT = "2026-08-22T02:03:04.005Z";

export const ADVANCED_AT = "2026-08-22T02:04:04.005Z";

export const NEXT_CUTOFF = "2026-08-22T02:05:04.005Z";

export const SHA: Sha256Digest = `sha256:${"a".repeat(64)}`;

export const REVIEW_POLICY = legacyRestrictedReviewerReviewPolicySnapshotV1;

export const sourceCursor = fixtureCursor(ADMITTED_AT);

export const nextCursor = fixtureCursor(NEXT_CUTOFF);

export const databases: Database.Database[] = [];

export function assertActionable(
  candidate: MeetingProcessingCandidateV1,
): asserts candidate is ActionableMeetingProcessingCandidateV1 {
  if (candidate.disposition !== "actionable") {
    throw new Error("test expected an actionable candidate");
  }
}

export const meeting: MeetingDocument = {
  schema_version: 1,
  id: "meeting-1",
  provenance: {
    source: {
      kind: "meeting-source",
      adapter_id: "fixture-source",
      instance_id: "founder-fixture-source",
      version: "2.2.0",
    },
    external_id: "note-1",
    canonical_revision: "sha256:note-1",
    observed_at: ADVANCED_AT,
    normalizer_version: "2.2.0",
  },
  capture: { state: "complete", components: [] },
  participants: [],
  content: [
    { id: "block-1", kind: "note", text: "Ship the cohort onboarding." },
  ],
  artifacts: [],
};

export const decisions: DecisionSet = {
  schema_version: 1,
  meeting_id: meeting.id,
  meeting_revision: meeting.provenance.canonical_revision,
  processor: {
    kind: "decision-processor",
    adapter_id: "llm",
    instance_id: "founder-llm",
    version: FIXTURE_PROCESSOR_VERSION,
  },
  generated_at: ADVANCED_AT,
  signals: [
    {
      id: "decision-1",
      kind: "decision",
      status: "decided",
      text: "Ship the cohort onboarding.",
      subject: null,
      confidence: 1,
      evidence: [{ meeting_id: "meeting-1", block_id: "block-1" }],
    },
  ],
};

export function database(): Database.Database {
  const value = new Database(":memory:");
  applyAuthorityBaselineV5(value);
  value
    .prepare(
      `INSERT INTO authority_metadata
       VALUES (1, 'oau_test', 'org_test', 'Test', '{}', ?, ?)`,
    )
    .run(ADMITTED_AT, ADMITTED_AT);
  value
    .prepare(
      `INSERT INTO authority_principals
       VALUES ('prn_test', 'org_test', 'Founder', ?)`,
    )
    .run(ADMITTED_AT);
  value
    .prepare(
      `INSERT INTO authority_memberships (
         membership_id, organization_id, principal_id, membership_type, status,
         provisioned_at, revoked_at, revocation_reason, employee_email_sha256
       ) VALUES ('mem_test', 'org_test', 'prn_test', 'owner', 'active', ?, NULL, NULL, NULL)`,
    )
    .run(ADMITTED_AT);
  value
    .prepare(
      `INSERT INTO authority_live_source_admission_v2 (
         singleton, organization_id, principal_id, membership_id,
         membership_type, source_adapter_id, source_adapter_version,
         source_adapter_instance_id, normalizer_version, source_custodian_sha256,
         source_custodian_assurance, source_custodian_observed_at,
         source_credential_reference_sha256, initial_cursor, cutoff_at,
         processor_adapter_id, processor_instance_id, processor_adapter_version,
         processor_configuration_sha256,
         processor_credential_reference_sha256, semantic_input_sha256,
         admitted_at
       ) VALUES (1, 'org_test', 'prn_test', 'mem_test', 'owner',
                 'fixture-source', '2.2.0', 'founder-fixture-source', '2.2.0', ?,
                 'provider_record_owner_observed', ?, ?, ?, ?,
                 'llm', 'founder-llm', ?, ?, ?, ?, ?)`,
    )
    .run(
      SHA,
      ADMITTED_AT,
      SHA,
      sourceCursor,
      ADMITTED_AT,
      FIXTURE_PROCESSOR_VERSION,
      SHA,
      SHA,
      SHA,
      ADMITTED_AT,
    );
  databases.push(value);
  return value;
}