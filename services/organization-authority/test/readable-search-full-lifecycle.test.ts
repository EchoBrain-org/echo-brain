import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256, parseCanonicalJson, sha256Digest } from '@echo-brain/federation-protocol';
import {
  buildStoppedReadableSearchGeneration,
  createReadableSearchAnalyzerDescriptor,
  readableSearchRetrievalContractSha256,
  readableSearchSourceBytesSha256,
} from '@echo-brain/organization-retrieval/build';
import type { ReadableSearchAdmittedAtom } from '@echo-brain/organization-retrieval/build';
import { admitReadableSearchGenerationDirectory } from '@echo-brain/organization-retrieval/serve';
import {
  ORGANIZATION_RECORD_LOG_DATABASE,
  openOrganizationRecordDatabase,
} from '@echo-brain/organization-record/maintenance';
import { createOrganizationRecordRetrievalBuildPort } from '@echo-brain/organization-record/retrieval-build';
import { organizationMemberReadablePolicyContractSha256 } from '@echo-brain/organization-protocol';
import { reviewerPolicyContractSha256 } from '../src/application/reviewer-policy-contract.js';
import {
  ReadableSearchError,
} from '../src/application/readable-search.js';
import { ReadableSearchAuthorizationFence } from '../src/application/readable-search-authorization-fence.js';
import { createReadableSearchGenerationPublishedAudit } from '../src/application/readable-search-persistence.js';
import { validateReadableSearchQueryAuditDetail } from '../src/application/readable-search-persistence.js';
import { organizationMemberReadableEnvelopeValidator } from '../src/composition/organization-member-envelope-validator.js';
import {
  openOrganizationRecordRuntime,
  type OrganizationRecordRuntime,
} from '../src/composition/organization-record.js';
import { readableSearchReleaseDescriptor } from '../src/composition/operator-state.js';
import { createReadableSearchRuntimeAdapter } from '../src/composition/readable-search.js';
import {
  organizationMemberSegmentIdentity,
  reviewerSegmentIdentity,
} from '@echo-brain/organization-retrieval';
import { reviewerRestrictedEnvelopeValidator } from '../src/composition/reviewer-envelope-validator.js';
import {
  approvalId,
  createRecordIngestFixture,
  recordBrief,
  type RecordIngestFixture,
} from './support/record-ingest-fixture.js';

const roots: string[] = [];
let fixture: RecordIngestFixture | undefined;
let restarted: OrganizationRecordRuntime | undefined;

afterEach(async () => {
  const openRestarted = restarted;
  const openFixture = fixture;
  restarted = undefined;
  fixture = undefined;
  await openRestarted?.close().catch(() => undefined);
  await openFixture?.close().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function handoff(response: {
  handoff(send: (body: string) => void): void;
}): Buffer {
  let body: string | undefined;
  response.handoff((text) => {
    body = text;
  });
  if (body === undefined) {
    throw new Error('readable-search response did not hand off bytes');
  }
  return Buffer.from(body, 'utf8');
}

function admittedAtoms(
  organizationId: string,
  batch: ReturnType<ReturnType<typeof createOrganizationRecordRetrievalBuildPort>['readAt']>,
): readonly ReadableSearchAdmittedAtom[] {
  const reviewerContract = reviewerPolicyContractSha256();
  const reviewer: readonly ReadableSearchAdmittedAtom[] = batch.reviewer_items.map((item) => ({
    fact: {
      atom_id: item.atom_id,
      organization_id: organizationId,
      envelope_sha256: item.envelope_sha256,
      log_position: item.log_position,
      record_hash: item.record_hash,
      atom_order: item.atom_order,
      signal_id_sha256: item.signal_id_sha256,
      item_kind: item.item_kind,
      policy_id: item.policy_id,
      policy_contract_sha256: reviewerContract,
      approval_actor_principal_id: item.provenance.reviewer_principal_id,
      approval_actor_membership_id: item.provenance.reviewer_membership_id,
      reviewer_principal_id: item.provenance.reviewer_principal_id,
      reviewer_membership_id: item.provenance.reviewer_membership_id,
      release_draft_sha256: item.release_draft_sha256,
      approval_presentation_sha256: item.approval_presentation_sha256,
      semantic_intent_sha256: item.provenance.semantic_intent_sha256,
      message_presentation_sha256: item.message_presentation_sha256,
      authorization_audit_event_id: item.provenance.authorization_audit_event_id,
      authorization_audit_entry_sha256: item.provenance.authorization_audit_entry_sha256,
      evaluated_at: item.evaluated_at,
      authorization_proof_sha256: item.provenance.authorization_proof_sha256,
      content_binding_sha256: item.content_binding_sha256,
      provenance_binding_sha256: item.provenance_binding_sha256,
    },
    text: item.text,
    text_sha256: item.text_sha256,
  }));
  const member: readonly ReadableSearchAdmittedAtom[] = batch.organization_member_items.map((item) => ({
    fact: {
      atom_id: item.atom_id,
      organization_id: item.provenance.organization_id,
      envelope_sha256: item.envelope_sha256,
      log_position: item.log_position,
      record_hash: item.record_hash,
      atom_order: item.atom_order,
      signal_id_sha256: item.signal_id_sha256,
      item_kind: item.item_kind,
      policy_id: item.policy_id,
      policy_contract_sha256: item.provenance.policy_contract_sha256,
      approval_actor_principal_id: item.provenance.approving_principal_id,
      approval_actor_membership_id: item.provenance.approving_membership_id,
      reviewer_principal_id: null,
      reviewer_membership_id: null,
      release_draft_sha256: item.provenance.release_draft_sha256,
      approval_presentation_sha256: item.provenance.approval_presentation_sha256,
      semantic_intent_sha256: item.provenance.semantic_intent_sha256,
      message_presentation_sha256: item.provenance.message_presentation_sha256,
      authorization_audit_event_id: item.provenance.authorization_audit_event_id,
      authorization_audit_entry_sha256: item.provenance.authorization_audit_entry_sha256,
      evaluated_at: item.provenance.evaluated_at,
      authorization_proof_sha256: item.provenance.authorization_proof_sha256,
      content_binding_sha256: item.provenance.content_binding_sha256,
      provenance_binding_sha256: item.provenance.provenance_binding_sha256,
    },
    text: item.text,
    text_sha256: item.text_sha256,
  }));
  return Object.freeze([...reviewer, ...member]);
}

function buildAndPublish(
  input: { readonly fixture: RecordIngestFixture; readonly runtime: OrganizationRecordRuntime },
): void {
  const database = openOrganizationRecordDatabase(
    input.fixture.recordLogDatabasePath,
    ORGANIZATION_RECORD_LOG_DATABASE,
    { readonly: true, fileMustExist: true },
  );
  try {
    const reviewerValidator = reviewerRestrictedEnvelopeValidator({
      organization_id: input.fixture.organizationId,
      authority_id: input.fixture.authorityId,
    });
    const memberValidator = organizationMemberReadableEnvelopeValidator({
      organization_id: input.fixture.organizationId,
      authority_id: input.fixture.authorityId,
    });
    const source = createOrganizationRecordRetrievalBuildPort(database, {
      organization_id: input.fixture.organizationId,
      authority_id: input.fixture.authorityId,
      reviewer_validator: reviewerValidator,
      organization_member_validator: memberValidator,
    });
    const batch = source.readAt(source.record_head);
    const atoms = admittedAtoms(input.fixture.organizationId, batch);
    const memberContract = organizationMemberReadablePolicyContractSha256();
    const reviewerContract = reviewerPolicyContractSha256();
    const release = readableSearchReleaseDescriptor();
    const analyzer = createReadableSearchAnalyzerDescriptor({
      analyzer_source_sha256: readableSearchSourceBytesSha256(release),
      node_version: process.versions.node,
      unicode_version: process.versions.unicode ?? 'unknown',
      icu_version: process.versions.icu ?? 'unknown',
    });
    const retrievalContract = readableSearchRetrievalContractSha256({
      analyzer_contract_sha256: analyzer.analyzer_contract_sha256,
      organization_member_policy_contract_sha256: memberContract,
      restricted_reviewer_policy_contract_sha256: reviewerContract,
    });
    const stateDirectory = mkdtempSync(join(tmpdir(), 'echo-readable-lifecycle-'));
    roots.push(stateDirectory);
    const generated = buildStoppedReadableSearchGeneration({
      state_directory: stateDirectory,
      organization_id: input.fixture.organizationId,
      record_head: batch.record_head,
      upstream_input_root: canonicalSha256({
        schema_version: 1,
        kind: 'organization-record-retrieval-build-input-v1',
        record_head: batch.record_head,
        atoms,
      }),
      retrieval_contract_sha256: retrievalContract,
      organization_member_policy_contract_sha256: memberContract,
      restricted_reviewer_policy_contract_sha256: reviewerContract,
      analyzer,
      source_revision: 'layer-2-local-lifecycle-test',
      builder_artifact_sha256: readableSearchSourceBytesSha256(release),
      sqlite_version: (database.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version,
      atoms,
    });
    input.fixture.authorityRepository.write(input.fixture.clock.now(), (transaction) => {
      const publication = {
        organization_id: input.fixture.organizationId,
        generation_id: generated.manifest.generation_id,
        manifest_sha256: generated.manifest_sha256,
        retrieval_contract_sha256: retrievalContract,
        record_head_position: batch.record_head.position,
        record_head_hash: batch.record_head.record_hash,
      } as const;
      const prior = transaction.activeReadableSearchGeneration();
      transaction.publishReadableSearchActiveGeneration(publication);
      transaction.appendAudit(createReadableSearchGenerationPublishedAudit({
        publication,
        prior_generation: prior,
        published_at: input.fixture.clock.now(),
      }));
    });
  } finally {
    database.close();
  }
}

describe('Layer 2 local readable-search lifecycle', () => {
  it('keeps reviewer content private while publishing v2 and v3 facts, and becomes fixed-unavailable after a new append', async () => {
    fixture = await createRecordIngestFixture();
    const reviewerText = 'Reviewer-only roadmap exception.';
    const memberText = 'Organization-wide launch sequence.';
    await fixture.runtime.submitRecordEnvelope({
      record_envelope: await fixture.reviewerApprovalEnvelope({
        approval_id: approvalId('layer-2-reviewer'),
        brief: recordBrief({ decisions: [{ ...recordBrief().decisions[0]!, text: reviewerText }] }),
      }),
    });
    await fixture.runtime.submitRecordEnvelope({
      record_envelope: await fixture.organizationMemberApprovalEnvelope({
        approval_id: approvalId('layer-2-member'),
        brief: recordBrief({ decisions: [{ ...recordBrief().decisions[0]!, text: memberText }] }),
      }),
    });
    await fixture.runtime.close();
    restarted = await openOrganizationRecordRuntime({
      authority: fixture.application,
      evidence: fixture.integrations,
      organization_id: fixture.organizationId,
      authority_id: fixture.authorityId,
      record_log_database_path: fixture.recordLogDatabasePath,
      record_derived_database_path: fixture.recordDerivedDatabasePath,
      organization_recording_policy_v1: fixture.organizationRecordingPolicy,
      alert: () => undefined,
    });
    expect(restarted.reviewerRestrictedHealth.kind).toBe('ready');
    expect(restarted.organizationMemberReadableHealth.kind).toBe('ready');
    buildAndPublish({ fixture, runtime: restarted });

    const active = fixture.application.readableSearchActiveGeneration();
    expect(active).not.toBeNull();
    const stateDirectory = roots[0]!;
    const memberContract = organizationMemberReadablePolicyContractSha256();
    const reviewerContract = reviewerPolicyContractSha256();
    const release = readableSearchReleaseDescriptor();
    const analyzer = createReadableSearchAnalyzerDescriptor({
      analyzer_source_sha256: readableSearchSourceBytesSha256(release),
      node_version: process.versions.node,
      unicode_version: process.versions.unicode ?? 'unknown',
      icu_version: process.versions.icu ?? 'unknown',
    });
    const clock = fixture.clock;
    let admissions = 0;
    const openings: string[] = [];
    let advanceClockAtFirstHandle = false;
    const service = createReadableSearchRuntimeAdapter({
      authority: fixture.application,
      records: restarted,
      generation_directories: {
        directoryFor: (generationId) => join(stateDirectory, 'record-retrieval', 'generations', generationId),
      },
      retrieval_state_directory: stateDirectory,
      analyzer,
      contract: {
        retrieval_contract_sha256: readableSearchRetrievalContractSha256({
          analyzer_contract_sha256: analyzer.analyzer_contract_sha256,
          organization_member_policy_contract_sha256: memberContract,
          restricted_reviewer_policy_contract_sha256: reviewerContract,
        }),
        policy_contracts: [
          { policy_id: 'organization-member-readable-v1', policy_contract_sha256: memberContract },
          { policy_id: 'restricted-reviewer-v1', policy_contract_sha256: reviewerContract },
        ],
      },
      fence: new ReadableSearchAuthorizationFence(),
      admit_generation: (input) => {
        admissions += 1;
        return admitReadableSearchGenerationDirectory(input);
      },
      handle_observer: {
        opened: (plane, segmentId) => {
          openings.push(`${plane}:${segmentId}`);
          if (advanceClockAtFirstHandle) {
            advanceClockAtFirstHandle = false;
            clock.advance(1);
          }
        },
      },
    });
    expect(admissions).toBe(1);
    const initialAuthorizationAt = clock.now();
    advanceClockAtFirstHandle = true;
    const reviewerResponse = await service.search(await fixture.readableSearchRequest('launch roadmap'));
    const reviewerBytes = handoff(reviewerResponse);
    expect(reviewerResponse.status_code).toBe(200);
    expect(reviewerBytes.toString('utf8')).toContain(reviewerText);
    expect(reviewerBytes.toString('utf8')).toContain(memberText);
    // The reviewer legitimately opens its own segment.  The second request is
    // the physical-isolation assertion for a different, later member.
    openings.splice(0);
    const memberResponse = await service.search(await fixture.replacementReadableSearchRequest('launch roadmap'));
    const memberBytes = handoff(memberResponse);
    expect(memberResponse.status_code).toBe(200);
    expect(memberBytes.toString('utf8')).toContain(memberText);
    expect(memberBytes.toString('utf8')).not.toContain(reviewerText);
    const memberSegment = organizationMemberSegmentIdentity({
      organization_id: fixture.organizationId,
      policy_contract_sha256: memberContract,
    });
    const reviewerSegment = reviewerSegmentIdentity({
      organization_id: fixture.organizationId,
      policy_contract_sha256: reviewerContract,
      reviewer_principal_id: fixture.principalId,
      reviewer_membership_id: fixture.membershipId,
    });
    expect(admissions).toBe(1);
    expect(openings).toContain(`facts:${memberSegment.segment_id}`);
    expect(openings.every((value) => !value.endsWith(reviewerSegment.segment_id))).toBe(true);
    const authority = new Database(join(fixture.directory, 'authority.sqlite'), { readonly: true });
    try {
      const rows = authority.prepare(
        `SELECT detail_json FROM authority_readable_search_query_audit
         ORDER BY audit_sequence ASC`,
      ).all() as readonly { readonly detail_json: string }[];
      expect(rows).toHaveLength(2);
      const reviewerAudit = validateReadableSearchQueryAuditDetail(
        parseCanonicalJson(rows[0]!.detail_json),
      ) as Record<string, unknown>;
      const memberAudit = validateReadableSearchQueryAuditDetail(
        parseCanonicalJson(rows[1]!.detail_json),
      ) as Record<string, unknown>;
      expect(reviewerAudit['response_sha256']).toBe(sha256Digest(reviewerBytes));
      expect(reviewerAudit['evaluated_at']).toBe(
        new Date(Date.parse(initialAuthorizationAt) + 1).toISOString(),
      );
      expect(memberAudit['response_sha256']).toBe(sha256Digest(memberBytes));
      expect(memberAudit['returned_policy_ids']).toEqual([
        'organization-member-readable-v1',
      ]);
      expect(rows[1]!.detail_json).not.toContain(reviewerText);
    } finally {
      authority.close();
    }

    await restarted.submitRecordEnvelope({
      record_envelope: await fixture.organizationMemberApprovalEnvelope({
        approval_id: approvalId('layer-2-stale'),
      }),
    });
    await expect(service.search(await fixture.readableSearchRequest('launch'))).rejects.toMatchObject({
      code: 'unavailable',
    } satisfies Partial<ReadableSearchError>);
  });
});
