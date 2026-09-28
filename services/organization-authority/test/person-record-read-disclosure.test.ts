import { canonicalSha256, sha256Digest, type JsonObject } from "@echo-brain/federation-protocol";
import {
  HUMAN_ACT_RECORD_INPUT_CODEC_V1,
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  createRecordInputCodecRegistryV4,
  projectMembersReadablePersonPolicyContractSha256,
  restrictedReviewerPersonPolicyContractSha256,
} from "@echo-brain/organization-protocol";
import {
  OrganizationRecordAppenderV4,
  PersonRecordReaderV1,
  createRecordPolicyFactProjectorRegistryV1,
  type V4RecordEnvelopeView,
} from "@echo-brain/organization-record/organization-record-api-v1";
import { applyAuthorityBaselineV5 } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import { SIGNED_SLACK_BLOCK_ACTION_V1_KIND } from "@echo-brain/provider-slack-server/organization-protocol/private-slack-block-approval-record-input-v1";
import {
  PRIVATE_SLACK_BLOCK_APPROVAL_CONSEQUENCE_V2_KIND,
  PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V2,
  PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V2_KIND,
  buildPrivateSlackBlockApprovalRecordInputV2,
  privateSlackBlockApprovalConsequenceV2Sha256,
} from "@echo-brain/provider-slack-server/organization-protocol/private-slack-block-approval-record-input-v2";
import { createPrivateSlackBlockApprovalPolicyProjectorV2 } from "@echo-brain/provider-slack-server/organization-record/adapters/record-policy-projection/slack/private-slack-block-approval-policy-projector-v2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvedDecisionSnapshotV2Sha256,
  type HumanActEventV1,
} from "../../../packages/organization-protocol/src/human-act-record-input-v1.js";
import {
  createOrganizationRecordEnvelopeV4,
  verifyOrganizationRecordEnvelopeV4,
} from "../../../packages/organization-protocol/src/record-envelope-v4.js";
import {
  COORDINATES,
  databaseV4,
  humanAct,
  processorProvenance,
  protocolAuthority,
  receiptFactory,
  sourceProvenance,
  type ProtocolAuthority,
} from "../../../packages/organization-record/test/fixtures/record-append-fixture.js";
import { SqlitePersonRecordReadAuditV1 } from "../src/adapters/persistence/sqlite/person-record-read-audit-v1.js";
import { createPersonRecordReadRouteV1 } from "../src/composition/person-record-read-route.js";
import type { PersonRecordReadResponseV1 } from "../src/presentation/person-record-read-http-application.js";

/**
 * Characterizes what the Layer 1 record list discloses beyond the records a
 * reader may read. The `it.fails` cases state the minimized-projection target
 * proposed in ADR-0020 and fail against today's full signed-envelope passthrough.
 * Remove `.fails` when that projection is implemented, or replace these cases
 * with an explicit accepted-exposure pin if ADR-0020 is rejected.
 */

const CODECS = createRecordInputCodecRegistryV4([
  HUMAN_ACT_RECORD_INPUT_CODEC_V1,
  PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V2,
]);
const PROJECTORS = createRecordPolicyFactProjectorRegistryV1([
  createPrivateSlackBlockApprovalPolicyProjectorV2(),
]);
const ISSUED_AT = "2026-08-21T12:02:00.000Z";
const OWNER = { principal_id: "principal-owner", membership_id: "membership-owner" };
const OWNER_SLACK_SUBJECT = "U0OWNERSUBJECT";
const SHARED_PROJECT = "prj_00000000-0000-4000-8000-000000000011";
const UNJOINED_PROJECT = "prj_00000000-0000-4000-8000-000000000012";

/** One real signed V2 Slack approval: project audience, or Only me when empty. */
async function approve(
  app: OrganizationRecordAppenderV4,
  authority: ProtocolAuthority,
  approval_id: string,
  audit_sequence: number,
  projects: string[],
): Promise<void> {
  const policy_id = projects.length === 0
    ? RESTRICTED_REVIEWER_PERSON_POLICY_ID
    : PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID;
  const policy_contract_sha256 = projects.length === 0
    ? restrictedReviewerPersonPolicyContractSha256()
    : projectMembersReadablePersonPolicyContractSha256();
  const snapshot = (humanAct(approval_id, "approve", RESTRICTED_REVIEWER_PERSON_POLICY_ID, 1)
    .event as Extract<HumanActEventV1, { kind: "approved" }>).approved_snapshot;
  const approved_snapshot_sha256 = approvedDecisionSnapshotV2Sha256(snapshot);
  const transcript_source = {
    source_id: `source-${approval_id}`, revision_id: "revision-1", source_sha256: sha256Digest(`source-${approval_id}`),
  };
  const consequence = {
    schema_version: 2 as const, kind: PRIVATE_SLACK_BLOCK_APPROVAL_CONSEQUENCE_V2_KIND, policy_id,
    audience_project_ids: projects, association_project_ids: projects, share_transcript: false, transcript_source,
  };
  const policy_consequence_sha256 = privateSlackBlockApprovalConsequenceV2Sha256(consequence);
  const provider_action_sha256 = sha256Digest(`action-${approval_id}`);
  const authorization_proof_sha256 = sha256Digest(`proof-${approval_id}`);
  const audit_entry = {
    ...COORDINATES, audit_event_id: `audit-${approval_id}`, audit_sequence, actor_class: "provider_human" as const,
    ...OWNER, action: "approve" as const, subject_kind: "approval" as const, subject_id: approval_id,
    detail_digest: authorization_proof_sha256, provider_action_sha256,
  };
  const ref = {
    schema_version: 2 as const, kind: PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V2_KIND, ...COORDINATES,
    command_id: `command-${approval_id}`, approval_id,
    candidate_sha256: sha256Digest(`candidate-${approval_id}`), frozen_card_sha256: sha256Digest(`card-${approval_id}`),
    approved_snapshot_sha256, final_approver: OWNER,
    current_slack_identity_link: {
      provider: "slack" as const, external_identity_link_id: "clm_owner",
      external_identity_link_contract_sha256: sha256Digest("link-owner"), provider_subject_id: OWNER_SLACK_SUBJECT,
    },
    action: "approve" as const, selected_policy_id: policy_id, policy_contract_sha256, policy_consequence_sha256, comment: null,
    audit_event_id: audit_entry.audit_event_id, audit_sequence, audit_entry_sha256: canonicalSha256(audit_entry),
    provider_action_kind: SIGNED_SLACK_BLOCK_ACTION_V1_KIND, provider_action_schema_version: 1 as const,
    provider_action_sha256, authorization_proof_sha256,
    audience_project_ids: projects, association_project_ids: projects, share_transcript: false, transcript_source,
  };
  const input = buildPrivateSlackBlockApprovalRecordInputV2({
    private_slack_block_approval_resolution_ref_v2: ref,
    event: {
      kind: "approved", approved_snapshot: snapshot, approved_snapshot_sha256, policy_id,
      policy_contract_sha256, policy_consequence: consequence, policy_consequence_sha256,
    },
  });
  const witness = {
    authorization_allow: {
      ...COORDINATES, approval_id, action: "approve" as const, final_approver: OWNER, selected_policy_id: policy_id,
      policy_contract_sha256, policy_consequence_sha256, audience_project_ids: projects, association_project_ids: projects,
      share_transcript: false, transcript_source, provider_action_sha256, decision: "allow" as const,
    },
    authorization_proof_sha256, provider_action_kind: SIGNED_SLACK_BLOCK_ACTION_V1_KIND,
    provider_action_schema_version: 1 as const, audit_entry, audit_entry_sha256: ref.audit_entry_sha256,
  };
  await app.append({
    approval_id, action: "approve", semantic_idempotency_key: input.semantic_idempotency_key,
    receipt_issued_at: ISSUED_AT, authorization_witness: witness,
    envelope_factory: {
      create: async (allocation) => createOrganizationRecordEnvelopeV4({
        envelope_id: `envelope-${approval_id}`, issued_at: ISSUED_AT,
        predecessor_position: allocation.predecessor_position,
        predecessor_record_sha256: allocation.predecessor_record_sha256,
        human_act_record_input: {
          private_slack_block_approval_resolution_ref_v2: input.private_slack_block_approval_resolution_ref_v2,
          event: input.event,
        },
        source_provenance: sourceProvenance(), processor_provenance: processorProvenance(),
      }, authority.pinned, COORDINATES.state_lineage_id, authority.sign, CODECS) as unknown as JsonObject,
      verify: (value) => verifyOrganizationRecordEnvelopeV4(
        value, authority.pinned, COORDINATES.state_lineage_id, CODECS,
      ) as unknown as V4RecordEnvelopeView & JsonObject,
    },
    receipt_factory: receiptFactory(authority, { sign_calls: { value: 0 } }, CODECS),
  });
}

/** An employee with one current project grant: the shared project only. */
const member: PersonAccessAuthorization = {
  organization_id: COORDINATES.organization_id,
  principal_id: "principal-member",
  membership_id: "membership-member",
  membership_type: "employee",
  identity_binding_id: "identity-member",
  session_family_id: "session-member",
  access_credential_sha256: sha256Digest("access-member"),
  access_expires_at: "2026-08-22T01:00:00.000Z",
  hard_reauthentication_at: "2026-08-22T02:00:00.000Z",
  person_state_sha256: sha256Digest("person-member"),
  session_state_sha256: sha256Digest("session-member"),
  checked_at: "2026-08-22T00:00:00.000Z",
};

/** Every global record-log coordinate a response carries, by JSON path. */
function recordLogCoordinates(value: unknown, path = "$"): { readonly path: string; readonly value: unknown }[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`;
    const found = ["position", "predecessor_position", "predecessor_record_sha256"].includes(key)
      ? [{ path: childPath, value: child }]
      : [];
    return [...found, ...recordLogCoordinates(child, childPath)];
  });
}

describe("Person Layer 1 record list disclosure", () => {
  const record = databaseV4();
  const authorityDatabase = openAuthorityDatabase(":memory:");
  let response: PersonRecordReadResponseV1;

  beforeAll(async () => {
    applyAuthorityBaselineV5(authorityDatabase);
    const authority = protocolAuthority();
    const app = new OrganizationRecordAppenderV4(record, COORDINATES, PROJECTORS);
    // Positions 1 and 3 are released to the member; position 2 is the owner's Only me record.
    await approve(app, authority, "approval-shared-and-unjoined", 1, [SHARED_PROJECT, UNJOINED_PROJECT]);
    await approve(app, authority, "approval-owner-only", 2, []);
    await approve(app, authority, "approval-shared", 3, [SHARED_PROJECT]);
    const route = createPersonRecordReadRouteV1({
      ...COORDINATES,
      sessions: { authenticateAccess: () => member },
      records: new PersonRecordReaderV1(record),
      audit: new SqlitePersonRecordReadAuditV1(authorityDatabase),
      capture_projects: () => ({ project_ids: [SHARED_PROJECT], grants_sha256: canonicalSha256([SHARED_PROJECT]) }),
    });
    response = route.list({ access_token: "bearer-member" });
    // Guard the expected-failure cases below: only a correct fixture may reach them.
    expect(response.records.map((item) => item.approval_id)).toEqual(["approval-shared", "approval-shared-and-unjoined"]);
  });

  afterAll(() => {
    record.close();
    authorityDatabase.close();
  });

  it.fails("does not name a project the reader is not a member of", () => {
    expect(JSON.stringify(response)).not.toContain(UNJOINED_PROJECT);
  });

  it.fails("does not let the reader count records it cannot see", () => {
    // Today: item positions 3 and 1, and an envelope predecessor_position of 2,
    // reveal exactly one hidden append between the two released records.
    expect(recordLogCoordinates(response)).toEqual([]);
  });
});
