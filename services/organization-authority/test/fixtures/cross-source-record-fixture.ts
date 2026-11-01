import { join } from "node:path";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import {
  organizationAuthorityPinSha256,
  verifyOrganizationAuthorityPin,
} from "../../../../packages/organization-protocol/src/index.js";
import {
  openOrganizationRecordDatabase,
  OrganizationRecordAppenderV4,
} from "@echo-brain/organization-record/organization-record-api-v1";
import { verifyAuthorityStateLineage } from "@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";
import { randomUUID } from "node:crypto";
import { MeetingSourceBridgeV1, pullAndAdmitSourceBatchV1 } from '@echo-brain/organization-processing/core';
import { SqliteSourceAdmissionStoreV1 } from '../../src/adapters/persistence/sqlite/source-admission-v1.js';
import { FileOrganizationAuthoritySigner } from "../../src/adapters/security/file-organization-authority-signer.js";
import { AUTHORITY_RECORD_INPUT_CODECS_V1, authorityRecordPolicyProjectorsV1 } from "../../src/composition/authority-record-protocols-v1.js";
import { createReadableSearchGenerationReconcilerV1 } from "../../src/composition/readable-search-generation-composition.js";
import { addMembership } from "./project-context-sqlite.js";
import { appendSignedApprovalV1 } from "./signed-approval-decision-v1.js";

const ISSUED_AT = "2026-10-02T12:00:00.000Z";

export interface CrossSourceRecordFixtureCoordinatesV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly owner_principal_id: string;
  readonly owner_membership_id: string;
}

export interface SeededCrossSourceRecordsV1 {
  readonly approved_text: string;
  readonly hidden_text: string;
  readonly unapproved_text: string;
  readonly approved_record_sha256: Sha256Digest;
  /** The approved record's own approval id (its destination's, derived from its proposal). */
  readonly approved_approval_id: string;
  readonly hidden_actor: {
    readonly organization_id: string;
    readonly principal_id: string;
    readonly membership_id: string;
    readonly membership_type: "employee";
  };
}

/** One real approval decision kept for its approver (Only me) whose one decision is `text`; returns its record digest and approval id. */
async function appendApprovedGranolaRecord(input: {
  readonly appender: OrganizationRecordAppenderV4;
  readonly record: ReturnType<typeof openOrganizationRecordDatabase>;
  readonly signer: FileOrganizationAuthoritySigner;
  readonly pinned: ReturnType<typeof verifyOrganizationAuthorityPin>;
  readonly coordinates: CrossSourceRecordFixtureCoordinatesV1;
  readonly approval_id: string;
  readonly audit_sequence: number;
  readonly reviewer: { readonly principal_id: string; readonly membership_id: string };
  readonly text: string;
}): Promise<{ readonly record_sha256: Sha256Digest; readonly approval_id: string }> {
  const approval_id = await appendSignedApprovalV1(input.appender, { pinned: input.pinned, sign: input.signer.sign.bind(input.signer) }, {
    approval_id: input.approval_id, audit_sequence: input.audit_sequence, projects: [], final_approver: input.reviewer, issued_at: ISSUED_AT,
    coordinates: input.coordinates,
    brief: (brief) => ({ ...brief, decisions: brief.decisions.map((decision) => ({ ...decision, text: input.text })) }),
  });
  const row = input.record.prepare("SELECT record_sha256 FROM organization_record_log WHERE approval_id = ?").get(approval_id) as { readonly record_sha256: Sha256Digest };
  return { record_sha256: row.record_sha256, approval_id };
}

/**
 * Appends two Granola-approved records to an initialized Authority state, then publishes the normal readable-search
 * generation: the owner's own (the owner reads it) and a hidden reviewer's (only that reviewer reads it).
 */
export async function seedCrossSourceRecords(
  state_directory: string,
  coordinates: CrossSourceRecordFixtureCoordinatesV1,
): Promise<SeededCrossSourceRecordsV1> {
  const lineage = verifyAuthorityStateLineage(state_directory);
  if (
    lineage.root.authority_id !== coordinates.authority_id ||
    lineage.root.organization_id !== coordinates.organization_id ||
    lineage.root.state_lineage_id !== coordinates.state_lineage_id
  ) {
    throw new Error("cross-source fixture coordinates do not match state lineage");
  }
  const authority = openAuthorityDatabase(join(state_directory, "authority.sqlite"), {
    fileMustExist: true,
  });
  const record = openOrganizationRecordDatabase(join(state_directory, "record-log.sqlite"), {
    fileMustExist: true,
  });
  try {
    const signer = FileOrganizationAuthoritySigner.openExisting({
      directory: join(state_directory, "keys"),
      authority_id: coordinates.authority_id,
      organization_id: coordinates.organization_id,
    });
    const descriptor = signer.inspectSync();
    const pinned = verifyOrganizationAuthorityPin(
      descriptor,
      organizationAuthorityPinSha256(descriptor),
    );
    const reviewer = {
      organization_id: coordinates.organization_id,
      principal_id: `prn_${randomUUID()}`,
      membership_id: `mem_${randomUUID()}`,
      membership_type: "employee" as const,
    };
    addMembership(authority, reviewer, 'Hidden reviewer', 'hidden-reviewer@example.test');
    const appender = new OrganizationRecordAppenderV4(record, coordinates, authorityRecordPolicyProjectorsV1());
    const approved_text = "Launchscope Granola decision: ship the cross-source rehearsal this Friday.";
    const hidden_text = "Launchscope HIDDEN-CROSS-SOURCE-REVIEWER-MARKER: defer the private contingency.";
    const unapproved_text = 'Launchscope UNAPPROVED-GRANOLA-SNAPSHOT-MARKER: retained custody is not a read grant.';
    const identity = { kind: 'meeting-source' as const, adapter_id: 'granola', instance_id: 'unapproved-fixture', version: '1.0.0' };
    await pullAndAdmitSourceBatchV1({
      source: new MeetingSourceBridgeV1({
        identity,
        pull: async () => ({ meetings: [{ schema_version: 1 as const, id: 'unapproved-cross-source-meeting',
          provenance: { source: identity, external_id: 'unapproved-cross-source-meeting', canonical_revision: '1', observed_at: ISSUED_AT, normalizer_version: '1.0.0' },
          capture: { state: 'complete' as const, components: [{ kind: 'transcript' as const, state: 'available' as const }] },
          participants: [], artifacts: [], title: 'Launchscope unapproved meeting', content: [{ id: 'transcript', kind: 'transcript' as const, text: unapproved_text }],
        }], next_cursor: 'unapproved-fixture-next' }),
      }),
      request: { limit: 1 },
      admission: { store: new SqliteSourceAdmissionStoreV1(authority), scope: { organization_id: coordinates.organization_id, custody_ref: `organization:${coordinates.organization_id}`, access_policy_ref: 'cross-source-unapproved-fixture', analysis_policy: 'automatic' } },
    });
    const approved = await appendApprovedGranolaRecord({
      appender,
      record,
      signer,
      pinned,
      coordinates,
      approval_id: "cross-source-public",
      audit_sequence: 1,
      reviewer: {
        principal_id: coordinates.owner_principal_id,
        membership_id: coordinates.owner_membership_id,
      },
      text: approved_text,
    });
    await appendApprovedGranolaRecord({
      appender,
      record,
      signer,
      pinned,
      coordinates,
      approval_id: "cross-source-hidden",
      audit_sequence: 2,
      reviewer,
      text: hidden_text,
    });
    const reconciler = createReadableSearchGenerationReconcilerV1({
      state_directory,
      root: lineage.root,
      authority,
      record,
      signer,
      policy_projectors: authorityRecordPolicyProjectorsV1(),
      record_input_codecs: AUTHORITY_RECORD_INPUT_CODECS_V1,
    });
    await reconciler.reconcile(new AbortController().signal);
    return { approved_text, hidden_text, unapproved_text, approved_record_sha256: approved.record_sha256, approved_approval_id: approved.approval_id, hidden_actor: reviewer };
  } finally {
    record.close();
    authority.close();
  }
}
