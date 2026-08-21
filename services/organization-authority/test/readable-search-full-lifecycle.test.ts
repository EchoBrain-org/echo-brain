import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCanonicalJson, sha256Digest } from '@echo-brain/federation-protocol';
import {
  buildStoppedReadableSearchGeneration,
  createReadableSearchAnalyzerDescriptor,
  readableSearchRetrievalContractSha256,
  readableSearchSourceBytesSha256,
} from '@echo-brain/organization-retrieval/build';
import { admitReadableSearchGenerationDirectory } from '@echo-brain/organization-retrieval/serve';
import { openOrganizationRecordDatabase } from '@echo-brain/organization-record/maintenance';
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
import { readableSearchCanonicalInput } from '../src/composition/readable-search-layer1.js';
import { fenceAuthorizationRelevantAuthorityMutations } from '../src/composition/readable-search-authorization-writes.js';
import { composeReviewerRecentDecisions } from '../src/composition/reviewer-recent-decisions.js';
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

function readableSearchQueryAuditCount(authorityDatabasePath: string): number {
  const database = new Database(authorityDatabasePath, { readonly: true });
  try {
    return (database.prepare(
      'SELECT count(*) AS count FROM authority_readable_search_query_audit',
    ).get() as { readonly count: number }).count;
  } finally {
    database.close();
  }
}

function buildAndPublish(
  input: { readonly fixture: RecordIngestFixture; readonly runtime: OrganizationRecordRuntime },
): void {
  const database = openOrganizationRecordDatabase(
    input.fixture.recordLogDatabasePath,
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
      restricted_reviewer_policy_contract_sha256:
        reviewerPolicyContractSha256(),
      reviewer_validator: reviewerValidator,
      organization_member_validator: memberValidator,
    });
    const batch = source.readAt(source.record_head);
    const canonicalInput = readableSearchCanonicalInput(
      input.fixture.organizationId,
      batch,
    );
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
      upstream_input_preimage: canonicalInput.upstream_input_preimage,
      retrieval_contract_sha256: retrievalContract,
      organization_member_policy_contract_sha256: memberContract,
      restricted_reviewer_policy_contract_sha256: reviewerContract,
      analyzer,
      source_revision: 'layer-2-local-lifecycle-test',
      builder_artifact_sha256: readableSearchSourceBytesSha256(release),
      sqlite_version: (database.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version,
      atoms: canonicalInput.atoms,
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
    const authorizationFence = new ReadableSearchAuthorizationFence();
    let wrongRootAdmissions = 0;
    const wrongRootOpenings: string[] = [];
    const wrongRootService = createReadableSearchRuntimeAdapter({
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
      fence: authorizationFence,
      fence_timeout_ms: 5_000,
      admit_generation: (input) => {
        wrongRootAdmissions += 1;
        const admitted = admitReadableSearchGenerationDirectory(input);
        return Object.freeze({
          ...admitted,
          manifest: Object.freeze({
            ...admitted.manifest,
            upstream_input_root: sha256Digest('different-current-layer-1-input'),
          }),
        });
      },
      handle_observer: { opened: (plane, segmentId) => wrongRootOpenings.push(`${plane}:${segmentId}`) },
    });
    expect(wrongRootAdmissions).toBe(1);
    const activeBeforeWrongRoot = fixture.application.readableSearchActiveGeneration();
    await expect(
      wrongRootService.search(await fixture.readableSearchRequest('launch roadmap')),
    ).rejects.toMatchObject({ code: 'unavailable' } satisfies Partial<ReadableSearchError>);
    expect(wrongRootOpenings).toEqual([]);
    expect(readableSearchQueryAuditCount(join(fixture.directory, 'authority.sqlite'))).toBe(0);
    expect(fixture.application.readableSearchActiveGeneration()).toEqual(
      activeBeforeWrongRoot,
    );
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
      fence: authorizationFence,
      fence_timeout_ms: 5_000,
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

    // The request above enrolled Lin after the content was approved. The real
    // Authority mutation shares the service's authorization fence, so the next
    // signed request must observe revocation before retrieval can open a plane.
    const authorityDatabase = new Database(join(fixture.directory, 'authority.sqlite'), {
      readonly: true,
    });
    let replacementMembershipId: string;
    try {
      const row = authorityDatabase.prepare(
        `SELECT membership.membership_id
         FROM authority_memberships AS membership
         JOIN authority_principals AS principal
           ON principal.principal_id = membership.principal_id
         WHERE principal.display_name = 'Lin Replacement'
           AND membership.status = 'active'`,
      ).get() as { membership_id: string } | undefined;
      if (row === undefined) throw new Error('replacement membership was not created');
      replacementMembershipId = row.membership_id;
    } finally {
      authorityDatabase.close();
    }
    await fenceAuthorizationRelevantAuthorityMutations(
      fixture.application,
      authorizationFence,
    ).revokeMembership(replacementMembershipId, 'test employee departure');
    openings.splice(0);
    const revokedResponse = await service.search(
      await fixture.replacementReadableSearchRequest('launch roadmap'),
    );
    expect(revokedResponse.status_code).toBe(404);
    expect(handoff(revokedResponse)).toEqual(
      Buffer.from('{"error":{"code":"not_found","message":"resource was not found"}}'),
    );
    expect(openings).toEqual([]);
    const revokedAuditDatabase = new Database(
      join(fixture.directory, 'authority.sqlite'),
      { readonly: true },
    );
    try {
      const rows = revokedAuditDatabase.prepare(
        `SELECT detail_json FROM authority_readable_search_query_audit
         ORDER BY audit_sequence ASC`,
      ).all() as readonly { readonly detail_json: string }[];
      expect(rows).toHaveLength(3);
      const revokedAudit = validateReadableSearchQueryAuditDetail(
        parseCanonicalJson(rows[2]!.detail_json),
      ) as Record<string, unknown>;
      expect(revokedAudit['decision']).toBe('deny');
      expect(revokedAudit['reason_code']).toBe(
        'inactive_or_unbound_organization_membership',
      );
      expect(revokedAudit['returned_policy_ids']).toBeUndefined();
    } finally {
      revokedAuditDatabase.close();
    }

    const appendedReviewerText = 'Reviewer decision appended after the Layer 2 build.';
    await restarted.submitRecordEnvelope({
      record_envelope: await fixture.reviewerApprovalEnvelope({
        approval_id: approvalId('layer-2-stale'),
        brief: recordBrief({
          decisions: [
            { ...recordBrief().decisions[0]!, text: appendedReviewerText },
          ],
        }),
      }),
    });
    await expect(service.search(await fixture.readableSearchRequest('launch'))).rejects.toMatchObject({
      code: 'unavailable',
    } satisfies Partial<ReadableSearchError>);
    const reviewerRecent = composeReviewerRecentDecisions(
      fixture.application,
      restarted,
      fixture.integrations,
    ).reviewerRecentDecisions(await fixture.reviewerRecentDecisionsRequest());
    expect(reviewerRecent.status_code).toBe(200);
    expect(reviewerRecent.body.toString('utf8')).toContain(appendedReviewerText);
  });

  it.each([
    { label: 'missing append-atomic v2 fact', policy: 'reviewer', corruption: 'fact' },
    { label: 'corrupt v2 integration-audit reproof', policy: 'reviewer', corruption: 'audit' },
    { label: 'missing append-atomic v3 fact', policy: 'member', corruption: 'fact' },
    { label: 'corrupt v3 integration-audit reproof', policy: 'member', corruption: 'audit' },
  ] as const)(
    'does not admit or serve an old generation after restart with $label',
    async ({ label, policy, corruption }) => {
      fixture = await createRecordIngestFixture();
      await fixture.runtime.submitRecordEnvelope({
        record_envelope: await fixture.reviewerApprovalEnvelope({
          approval_id: approvalId(`layer-1-reviewer-${label}`),
        }),
      });
      await fixture.runtime.submitRecordEnvelope({
        record_envelope: await fixture.organizationMemberApprovalEnvelope({
          approval_id: approvalId(`layer-1-member-${label}`),
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
      expect(restarted.readableSearchLayer1Admission).not.toBeNull();
      buildAndPublish({ fixture, runtime: restarted });
      const activeBeforeCorruption = fixture.application.readableSearchActiveGeneration();
      expect(activeBeforeCorruption).not.toBeNull();
      await restarted.close();
      restarted = undefined;

      let restoreAudit: (() => void) | undefined;
      if (corruption === 'fact') {
        const database = new Database(fixture.recordLogDatabasePath);
        try {
          const trigger = database
            .prepare(
              `SELECT sql FROM sqlite_master
               WHERE type = 'trigger'
                 AND name = ?`,
            )
            .get(
              policy === 'reviewer'
                ? 'organization_record_reviewer_policy_fact_immutable_delete'
                : 'organization_member_readable_policy_fact_immutable_delete',
            ) as { sql: string };
          const table = policy === 'reviewer'
            ? 'organization_record_reviewer_policy_fact'
            : 'organization_member_readable_policy_fact';
          const triggerName = policy === 'reviewer'
            ? 'organization_record_reviewer_policy_fact_immutable_delete'
            : 'organization_member_readable_policy_fact_immutable_delete';
          database.exec(`DROP TRIGGER ${triggerName}`);
          database.exec(`DELETE FROM ${table}`);
          database.exec(trigger.sql);
        } finally {
          database.close();
        }
      } else {
        const audit = policy === 'reviewer'
          ? vi.spyOn(
              fixture.integrations,
              'findAllowedReviewerAuthorizationEvidenceById',
            ).mockReturnValue({ status: 'mismatch' })
          : vi.spyOn(
              fixture.integrations,
              'findAllowedOrganizationMemberAuthorizationEvidenceById',
            ).mockReturnValue({ status: 'mismatch' });
        restoreAudit = () => audit.mockRestore();
      }
      try {
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
        expect(
          policy === 'reviewer'
            ? restarted.reviewerRestrictedHealth.kind
            : restarted.organizationMemberReadableHealth.kind,
        ).toBe('degraded');
        expect(
          policy === 'reviewer'
            ? restarted.organizationMemberReadableHealth.kind
            : restarted.reviewerRestrictedHealth.kind,
        ).toBe('ready');
        expect(restarted.readableSearchLayer1Admission).toBeNull();

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
        let admissions = 0;
        const openings: string[] = [];
        const service = createReadableSearchRuntimeAdapter({
          authority: fixture.application,
          records: restarted,
          generation_directories: {
            directoryFor: (generationId) =>
              join(stateDirectory, 'record-retrieval', 'generations', generationId),
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
          fence_timeout_ms: 5_000,
          admit_generation: (input) => {
            admissions += 1;
            return admitReadableSearchGenerationDirectory(input);
          },
          handle_observer: {
            opened: (plane, segmentId) => openings.push(`${plane}:${segmentId}`),
          },
        });
        expect(admissions).toBe(0);
        await expect(
          service.search(await fixture.readableSearchRequest('launch')),
        ).rejects.toMatchObject({ code: 'unavailable' } satisfies Partial<ReadableSearchError>);
        expect(admissions).toBe(0);
        expect(openings).toEqual([]);
        expect(
          readableSearchQueryAuditCount(join(fixture.directory, 'authority.sqlite')),
        ).toBe(0);
        expect(fixture.application.readableSearchActiveGeneration()).toEqual(
          activeBeforeCorruption,
        );
      } finally {
        restoreAudit?.();
      }
    },
  );
});
