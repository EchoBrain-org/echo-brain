import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { OrganizationRecordLogStore } from '@echo-brain/organization-record/append';
import { verifyOrganizationAuthorityPin } from '@echo-brain/organization-protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../src/processing/core/approval/approval-gate.js';
import { ReadableSearchAuthorizationFence } from '../src/application/readable-search-authorization-fence.js';
import type { DecisionSet } from '../src/processing/core/contracts/decision.js';
import type { DecisionBrief } from '../src/processing/core/contracts/delivery.js';
import type { MeetingDocument } from '../src/processing/core/contracts/meeting.js';
import { SqliteResolvedOrganizationRecordMetadataLookup } from '../src/processing/record/adapters/organization-member-record-metadata.js';
import { ResolvedOrganizationRecordActWriter } from '../src/processing/record/adapters/resolved-organization-record-act-writer.js';
import { ProtocolOrganizationRecordEnvelopeBuilder } from '../src/processing/record/protocol-record-envelope-builder.js';
import {
  SqliteAuthorityProcessingStore,
  type AuthorityProcessingSourceConfigurationBinding,
  type AuthorityProcessingStoreBinding,
  type AuthorityTerminalRecordAct,
} from '../src/processing/storage/sqlite-authority-processing-store.js';
import {
  recoverAuthorityTerminalRecordActs,
  recoverTerminalRecordActsFromStore,
  type TerminalRecordRecoveryStore,
} from '../src/composition/terminal-record-recovery.js';
import {
  createRecordIngestFixture,
  recordBrief,
  RECORD_MEETING_ID,
  RECORD_SOURCE,
  type RecordIngestFixture,
} from './support/record-ingest-fixture.js';

const fixtures: RecordIngestFixture[] = [];
const SOURCE_CONFIGURATION: AuthorityProcessingSourceConfigurationBinding = {
  owner_email_sha256: `sha256:${'a'.repeat(64)}`,
  credential_scope: 'organization',
  credential_reference_sha256: `sha256:${'b'.repeat(64)}`,
};

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

function approvalId(processingKey: string): string {
  return createHash('sha256').update(processingKey, 'utf8').digest('hex');
}

function processingBinding(
  fixture: RecordIngestFixture,
): AuthorityProcessingStoreBinding {
  return {
    organization_id: fixture.organizationId,
    principal_id: fixture.otherPrincipalId,
    membership_id: fixture.otherMembershipId,
    membership_type: 'employee',
    source_adapter_id: RECORD_SOURCE.adapter_id,
    source_instance_id: RECORD_SOURCE.instance_id,
  };
}

function meeting(): MeetingDocument {
  const brief = recordBrief();
  return {
    schema_version: 1,
    id: RECORD_MEETING_ID,
    title: brief.meeting.title,
    capture: {
      state: 'complete',
      components: [{ kind: 'transcript', state: 'available' }],
    },
    participants: brief.meeting.participants,
    content: [
      {
        id: 'block-12',
        kind: 'transcript',
        text: 'Adopt usage-based pricing.',
      },
    ],
    artifacts: [],
    provenance: {
      source: {
        kind: 'meeting-source',
        adapter_id: RECORD_SOURCE.adapter_id,
        instance_id: RECORD_SOURCE.instance_id,
        version: '1.0.0',
      },
      external_id: RECORD_SOURCE.external_id,
      canonical_revision: brief.provenance.meeting_revision,
      observed_at: '2026-08-08T12:00:00.000Z',
      normalizer_version: '1.0.0',
    },
  };
}

function decisionSet(input: MeetingDocument): DecisionSet {
  const brief = recordBrief();
  return {
    schema_version: 1,
    meeting_id: input.id,
    meeting_revision: input.provenance.canonical_revision,
    processor: brief.provenance.processor,
    generated_at: brief.provenance.generated_at,
    signals: [
      ...brief.decisions,
      ...brief.actions,
      ...brief.rationales,
    ],
  };
}

async function stageTerminalApproval(
  fixture: RecordIngestFixture,
  store: SqliteAuthorityProcessingStore,
  processingKey: string,
): Promise<void> {
  const input = meeting();
  const decisions = decisionSet(input);
  const brief = recordBrief() as DecisionBrief;
  const request: ApprovalRequest = {
    processing_key: processingKey,
    meeting: input,
    decisions,
    brief,
    requested_at: fixture.clock.now(),
  };
  await store.admitAndSaveMeeting(input, processingKey);
  await store.saveDecisionSet(processingKey, input, decisions);
  const staged = await store.ensureRequested(request);
  expect(staged.approval_id).toBe(approvalId(processingKey));
  const authorization = fixture.authorize({
    approval_id: staged.approval_id,
    action: 'approve',
  });
  await store.resolve({
    approvalId: staged.approval_id,
    status: 'approved',
    reviewedBy: 'Ada Founder',
    surface: 'slack-authority-v1',
    metadata: { authorization: authorization as never },
    reviewedAt: authorization.evaluated_at,
  });
}

function recoveryStore(
  fixture: RecordIngestFixture,
): SqliteAuthorityProcessingStore {
  return new SqliteAuthorityProcessingStore(
    join(fixture.directory, 'authority.sqlite'),
    processingBinding(fixture),
    {
      bindingMode: 'require-existing',
      sourceConfiguration: SOURCE_CONFIGURATION,
      fileMustExist: true,
    },
  );
}

function realWriter(
  fixture: RecordIngestFixture,
  store: SqliteAuthorityProcessingStore,
  ensureAccess = vi.fn(async () => undefined),
): ResolvedOrganizationRecordActWriter {
  const enrollment = fixture.authorityRepository.read((transaction) =>
    transaction.enrollmentByInstallation(fixture.installationId),
  );
  if (enrollment === undefined) throw new Error('fixture enrollment is missing');
  return new ResolvedOrganizationRecordActWriter({
    metadata: new SqliteResolvedOrganizationRecordMetadataLookup(store),
    recordEnvelopes: store,
    recordEnvelopeBuilder: new ProtocolOrganizationRecordEnvelopeBuilder({
      pinnedAuthority: verifyOrganizationAuthorityPin(
        fixture.application.descriptor(),
        fixture.application.authorityPinSha256(),
      ),
      installationSigningKey: enrollment.installation_signing_key,
      sign: async (bytes) => fixture.signEnvelopeBytes(Buffer.from(bytes)),
    }),
    installationAccess: { ensureCurrentInstallationAccess: ensureAccess },
    records: fixture.runtime,
  });
}

function logRows(fixture: RecordIngestFixture): readonly {
  readonly canonical_envelope: string;
}[] {
  const log = OrganizationRecordLogStore.open(fixture.recordLogDatabasePath, {
    organization_id: fixture.organizationId,
    authority_id: fixture.authorityId,
  });
  try {
    return log.database
      .prepare(
        'SELECT canonical_envelope FROM organization_record_log ORDER BY position',
      )
      .all() as { canonical_envelope: string }[];
  } finally {
    log.close();
  }
}

async function terminalFixture(
  revokeSource = true,
): Promise<{
  readonly fixture: RecordIngestFixture;
  readonly processingKey: string;
}> {
  const fixture = await createRecordIngestFixture();
  fixtures.push(fixture);
  const processingKey = 'processing:v2:revoked-source-recovery';
  const store = new SqliteAuthorityProcessingStore(
    join(fixture.directory, 'authority.sqlite'),
    processingBinding(fixture),
    {
      bindingMode: 'provision',
      sourceConfiguration: SOURCE_CONFIGURATION,
      fileMustExist: true,
    },
  );
  try {
    await stageTerminalApproval(fixture, store, processingKey);
  } finally {
    store.close();
  }
  if (revokeSource) {
    await fixture.application.revokeMembership(
      fixture.otherMembershipId,
      'source custodian left after the human act was durable',
    );
  }
  return { fixture, processingKey };
}

function actualRecoveryOptions(fixture: RecordIngestFixture) {
  return {
    config: {
      authority_id: fixture.authorityId,
      organization_id: fixture.organizationId,
      state_directory: fixture.directory,
      database_path: join(fixture.directory, 'authority.sqlite'),
      active_lease_ttl_ms: 5 * 60 * 1000,
    } as never,
    authority: fixture.application,
    authorityRepository: fixture.authorityRepository,
    authorizationFence: new ReadableSearchAuthorizationFence(),
    // Recovery calls only the bridge's current-installation check. It never
    // performs a new permission decision or touches a provider surface.
    integrations: {} as never,
    records: fixture.runtime,
  };
}

describe('terminal record recovery composition', () => {
  it('has no meeting-source, processor, approval, or delivery adapter dependency', () => {
    const sources = [
      new URL('../src/composition/terminal-record-recovery.ts', import.meta.url),
      new URL(
        '../src/composition/server-installation-record-writer.ts',
        import.meta.url,
      ),
    ].map((path) => readFileSync(path, 'utf8'));
    for (const source of sources) {
      expect(source).not.toMatch(
        /meeting-sources|decision-processors|approval-surfaces|delivery-surfaces|createGranolaMeetingSourceAdapter|createLlmDecisionProcessor|createSlackReactionsApprovalSurface|SlackDeliverySurface/,
      );
    }
  });

  it('restarts after source revocation and replays byte-identically through normal Record ingest', async () => {
    const { fixture, processingKey } = await terminalFixture();
    expect(fixture.otherMembershipId).not.toBe(fixture.membershipId);
    fixture.writeProcessingInstallationKeyState();
    vi.useFakeTimers();
    vi.setSystemTime(fixture.clock.now());

    await expect(
      recoverAuthorityTerminalRecordActs(actualRecoveryOptions(fixture)),
    ).resolves.toEqual({
      source_binding: 'inactive',
      recovered_processing_keys: [processingKey],
    });

    const processingDatabase = new Database(
      join(fixture.directory, 'authority.sqlite'),
      { readonly: true },
    );
    const frozen = processingDatabase
      .prepare(
        `SELECT envelope_json
           FROM authority_processing_frozen_record_envelopes
          WHERE processing_key = ?`,
      )
      .get(processingKey) as { envelope_json: string };
    expect(
      processingDatabase
        .prepare(
          `SELECT COUNT(*) AS count
             FROM authority_processing_processed_markers
            WHERE processing_key = ?`,
        )
        .get(processingKey),
    ).toEqual({ count: 0 });
    processingDatabase.close();
    expect(logRows(fixture)).toEqual([
      { canonical_envelope: frozen.envelope_json },
    ]);

    await expect(
      recoverAuthorityTerminalRecordActs(actualRecoveryOptions(fixture)),
    ).resolves.toEqual({
      source_binding: 'inactive',
      recovered_processing_keys: [processingKey],
    });
    expect(logRows(fixture)).toEqual([
      { canonical_envelope: frozen.envelope_json },
    ]);
  });

  it('runs before polling without weakening an active source store', async () => {
    const { fixture, processingKey } = await terminalFixture(false);
    fixture.writeProcessingInstallationKeyState();
    vi.useFakeTimers();
    vi.setSystemTime(fixture.clock.now());
    await expect(
      recoverAuthorityTerminalRecordActs(actualRecoveryOptions(fixture)),
    ).resolves.toEqual({
      source_binding: 'active',
      recovered_processing_keys: [processingKey],
    });

    const normal = recoveryStore(fixture);
    await normal.initialize();
    await expect(normal.getCandidate(processingKey)).resolves.toMatchObject({
      processing_key: processingKey,
    });
    normal.close();
  });

  it('still denies normal Record ingest when the installation authority is revoked', async () => {
    const { fixture } = await terminalFixture();
    await fixture.revokeInstallation();
    const restarted = recoveryStore(fixture);
    await expect(
      recoverTerminalRecordActsFromStore(restarted, (store) =>
        realWriter(fixture, store),
      ),
    ).rejects.toThrow();
    restarted.close();
    expect(logRows(fixture)).toEqual([]);
  });

  it('paginates beyond 100 acts and fails fast before later writes', async () => {
    const acts = Array.from({ length: 101 }, (_, index) => {
      const processingKey = `processing-${String(index).padStart(3, '0')}`;
      const input = meeting();
      const decisions = decisionSet(input);
      const brief = recordBrief() as DecisionBrief;
      return {
        cursor: {
          resolved_at: `2026-08-08T12:00:${String(index % 60).padStart(2, '0')}.000Z`,
          processing_key: processingKey,
        },
        act: {
          candidate: {
            processing_key: processingKey,
            admitted_at: '2026-08-08T12:00:00.000Z',
            meeting: input,
            first_decision: decisions,
            first_request: {
              processing_key: processingKey,
              meeting: input,
              decisions,
              brief,
              requested_at: '2026-08-08T12:00:00.000Z',
            },
          },
          decision: {
            status: 'approved' as const,
            reviewed_at: '2026-08-08T12:01:00.000Z',
            reviewed_by: 'Reviewer',
            reason: null,
            approved_brief: brief,
          },
          metadata: {
            approval_id: approvalId(processingKey),
            surface: 'slack-authority-v1',
            metadata: {},
            resolved_at: '2026-08-08T12:01:00.000Z',
          },
        } satisfies AuthorityTerminalRecordAct,
      };
    });
    let initialized = 0;
    const store: TerminalRecordRecoveryStore = {
      async initializeTerminalRecordRecovery() {
        initialized += 1;
      },
      listTerminalRecordRecoveryPage(input = {}) {
        const start =
          input.after === undefined
            ? 0
            : acts.findIndex(
                ({ cursor }) =>
                  canonicalJson(cursor) === canonicalJson(input.after),
              ) + 1;
        return acts.slice(start, start + (input.limit ?? 100)).map(({ cursor }) => cursor);
      },
      readTerminalRecordAct(processingKey) {
        return acts.find(({ cursor }) => cursor.processing_key === processingKey)?.act ?? null;
      },
    };
    const writes: string[] = [];
    await expect(
      recoverTerminalRecordActsFromStore(store, () => ({
        async write(input) {
          writes.push(input.processing_key);
        },
      })),
    ).resolves.toHaveLength(101);
    expect(initialized).toBe(1);
    expect(writes).toHaveLength(101);

    writes.length = 0;
    await expect(
      recoverTerminalRecordActsFromStore(store, () => ({
        async write(input) {
          writes.push(input.processing_key);
          throw new Error('first append failed closed');
        },
      })),
    ).rejects.toThrow('first append failed closed');
    expect(writes).toEqual(['processing-000']);
  });
});
