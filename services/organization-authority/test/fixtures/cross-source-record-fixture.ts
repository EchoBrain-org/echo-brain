import { join } from "node:path";
import type { JsonObject, Sha256Digest } from "@echo-brain/federation-protocol";
import {
  buildHumanActRecordInputV1,
  createOrganizationRecordEnvelopeV4,
  organizationAuthorityPinSha256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  verifyOrganizationAuthorityPin,
  verifyOrganizationRecordEnvelopeV4,
} from "../../../../packages/organization-protocol/src/index.js";
import {
  createPersonPolicyFactProjectorV2,
  createRecordPolicyFactProjectorRegistryV1,
  openOrganizationRecordDatabase,
  OrganizationRecordAppenderV4,
  type V4RecordEnvelopeView,
} from "@echo-brain/organization-record/organization-record-api-v1";
import { verifyAuthorityStateLineage } from "@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";
import { randomUUID } from "node:crypto";
import { MeetingSourceBridgeV1, pullAndAdmitSourceBatchV1 } from '@echo-brain/organization-processing/core';
import { SqliteSourceAdmissionStoreV1 } from '../../src/adapters/persistence/sqlite/source-admission-v1.js';
import { FileOrganizationAuthoritySigner } from "../../src/adapters/security/file-organization-authority-signer.js";
import { createReadableSearchGenerationReconcilerV1 } from "../../src/composition/readable-search-generation-composition.js";
import { authorizationWitness, humanAct, receiptFactory, RECORD_INPUT_CODECS, sourceProvenance as fixtureSourceProvenance, processorProvenance as fixtureProcessorProvenance } from "../../../../packages/organization-record/test/fixtures/record-append-fixture.js";
import { addMembership } from "./project-context-sqlite.js";

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
  readonly hidden_actor: {
    readonly organization_id: string;
    readonly principal_id: string;
    readonly membership_id: string;
    readonly membership_type: "employee";
  };
}

function sourceProvenance(input: CrossSourceRecordFixtureCoordinatesV1) {
  return { ...fixtureSourceProvenance(), authority_id: input.authority_id, organization_id: input.organization_id, state_lineage_id: input.state_lineage_id };
}

function processorProvenance(input: CrossSourceRecordFixtureCoordinatesV1) {
  return { ...fixtureProcessorProvenance(), authority_id: input.authority_id, organization_id: input.organization_id, state_lineage_id: input.state_lineage_id };
}

async function appendApprovedGranolaRecord(input: {
  readonly appender: OrganizationRecordAppenderV4;
  readonly signer: FileOrganizationAuthoritySigner;
  readonly pinned: ReturnType<typeof verifyOrganizationAuthorityPin>;
  readonly coordinates: CrossSourceRecordFixtureCoordinatesV1;
  readonly approval_id: string;
  readonly reviewer: { readonly principal_id: string; readonly membership_id: string };
  readonly policy_id:
    | typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID
    | typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID;
  readonly text: string;
}): Promise<Sha256Digest> {
  const seeded = humanAct(input.approval_id, "approve", input.policy_id, 1, undefined, input.text);
  const human = buildHumanActRecordInputV1({
    human_act_resolution_ref: {
      ...seeded.human_act_resolution_ref,
      authority_id: input.coordinates.authority_id,
      organization_id: input.coordinates.organization_id,
      state_lineage_id: input.coordinates.state_lineage_id,
    },
    event: seeded.event,
  });
  const receipt_factory = receiptFactory(
    { pinned: input.pinned, sign: input.signer.sign.bind(input.signer) },
    { sign_calls: { value: 0 }, state_lineage_id: input.coordinates.state_lineage_id },
  );
  const appended = await input.appender.append({
    approval_id: input.approval_id,
    action: "approve",
    semantic_idempotency_key: human.semantic_idempotency_key,
    receipt_issued_at: ISSUED_AT,
    authorization_witness: authorizationWitness(human, input.reviewer),
    envelope_factory: {
      async create(allocation) {
        return createOrganizationRecordEnvelopeV4(
          {
            envelope_id: `envelope-${input.approval_id}`,
            issued_at: ISSUED_AT,
            predecessor_position: allocation.predecessor_position,
            predecessor_record_sha256: allocation.predecessor_record_sha256,
            human_act_record_input: {
              human_act_resolution_ref: human.human_act_resolution_ref,
              event: human.event,
              idempotency: human.idempotency,
            },
            source_provenance: sourceProvenance(input.coordinates),
            processor_provenance: processorProvenance(input.coordinates),
          },
          input.pinned,
          input.coordinates.state_lineage_id,
          input.signer.sign.bind(input.signer),
          RECORD_INPUT_CODECS,
        ) as unknown as JsonObject;
      },
      verify(value) {
        return verifyOrganizationRecordEnvelopeV4(
          value,
          input.pinned,
          input.coordinates.state_lineage_id,
          RECORD_INPUT_CODECS,
        ) as unknown as V4RecordEnvelopeView & JsonObject;
      },
    },
    receipt_factory,
  });
  return appended.record_sha256;
}

/**
 * Appends public and reviewer-only Granola-approved records to an initialized
 * Authority state, then publishes the normal readable-search generation.
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
    const appender = new OrganizationRecordAppenderV4(record, coordinates);
    const approved_text = "Launchscope Granola decision: ship the cross-source rehearsal this Friday.";
    const hidden_text = "Launchscope HIDDEN-CROSS-SOURCE-REVIEWER-MARKER: defer the private contingency.";
    const unapproved_text = 'Launchscope UNAPPROVED-GRANOLA-SNAPSHOT-MARKER: retained custody is not a read grant.';
    const identity = { kind: 'meeting-source' as const, adapter_id: 'granola', instance_id: 'unapproved-fixture', version: '1.0.0' };
    await pullAndAdmitSourceBatchV1({
      source: new MeetingSourceBridgeV1({
        identity, validateConfig: () => ({ ok: true, errors: [] }),
        healthCheck: async () => ({ status: 'healthy' as const, checked_at: ISSUED_AT }),
        pull: async () => ({ meetings: [{ schema_version: 1 as const, id: 'unapproved-cross-source-meeting',
          provenance: { source: identity, external_id: 'unapproved-cross-source-meeting', canonical_revision: '1', observed_at: ISSUED_AT, normalizer_version: '1.0.0' },
          capture: { state: 'complete' as const, components: [{ kind: 'transcript' as const, state: 'available' as const }] },
          participants: [], artifacts: [], title: 'Launchscope unapproved meeting', content: [{ id: 'transcript', kind: 'transcript' as const, text: unapproved_text }],
        }], next_cursor: 'unapproved-fixture-next' }),
      }),
      request: { limit: 1 },
      admission: { store: new SqliteSourceAdmissionStoreV1(authority), scope: { organization_id: coordinates.organization_id, custody_ref: `organization:${coordinates.organization_id}`, access_policy_ref: 'cross-source-unapproved-fixture', analysis_policy: 'automatic' } },
    });
    const approved_record_sha256 = await appendApprovedGranolaRecord({
      appender,
      signer,
      pinned,
      coordinates,
      approval_id: "cross-source-public",
      reviewer: {
        principal_id: coordinates.owner_principal_id,
        membership_id: coordinates.owner_membership_id,
      },
      policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      text: approved_text,
    });
    await appendApprovedGranolaRecord({
      appender,
      signer,
      pinned,
      coordinates,
      approval_id: "cross-source-hidden",
      reviewer,
      policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      text: hidden_text,
    });
    const reconciler = createReadableSearchGenerationReconcilerV1({
      state_directory,
      root: lineage.root,
      authority,
      record,
      signer,
      policy_projectors: createRecordPolicyFactProjectorRegistryV1([
        createPersonPolicyFactProjectorV2(),
      ]),
    });
    await reconciler.reconcile(new AbortController().signal);
    return { approved_text, hidden_text, unapproved_text, approved_record_sha256, hidden_actor: reviewer };
  } finally {
    record.close();
    authority.close();
  }
}
