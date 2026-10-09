import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { applyAuthorityBaselineV14 } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';
import { applyOrganizationRecordLogBaselineV4, OrganizationRecordAppenderV4 } from '@echo-brain/organization-record/organization-record-api-v1';
import { createStagingSyntheticPersonalMeetingProviderV1 } from '@echo-brain/provider-synthetic-demo/staging-synthetic-personal-meeting-provider-v1';
import { testAuthority } from '../../../packages/organization-protocol/test/fixtures/record-v4-fixture.js';
import { createPersonMeetingRuntimeV1 } from '../src/composition/person-meeting-runtime-v1.js';
import { authorityRecordPolicyProjectorsV1 } from '../src/composition/authority-record-protocols-v1.js';
import { runStagingSyntheticPersonalCanaryV1 } from '../src/composition/staging/staging-synthetic-personal-canary-v1.js';

const NOW = '2026-10-07T00:00:00.000Z';
const OWNER = { principal_id: 'prn_00000000-0000-4000-8000-000000000003', membership_id: 'mem_00000000-0000-4000-8000-000000000004' };
const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

function addOwner(db: Database.Database, organization_id: string, owner: typeof OWNER): void {
  db.prepare("INSERT INTO authority_principals VALUES (?, ?, 'Founder', ?)").run(owner.principal_id, organization_id, NOW);
  db.prepare(`INSERT INTO authority_memberships (membership_id, organization_id, principal_id, membership_type, status, provisioned_at, revoked_at, revocation_reason, employee_email_sha256)
    VALUES (?, ?, ?, 'owner', 'active', ?, NULL, NULL, NULL)`).run(owner.membership_id, organization_id, owner.principal_id, NOW);
}

/** Fresh V14 state, one active owner membership, and the synthetic provider as the only personal provider. */
async function syntheticWorld(options: { readonly signals?: boolean } = {}) {
  const authority = testAuthority();
  const organization_id = authority.descriptor.organization_id;
  const db = new Database(':memory:'); opened.push(db); db.pragma('foreign_keys = ON'); applyAuthorityBaselineV14(db);
  db.prepare("INSERT INTO authority_metadata VALUES (1, ?, ?, 'Test', '{}', ?, ?)").run(authority.descriptor.authority_id, organization_id, NOW, NOW);
  addOwner(db, organization_id, OWNER);
  const record = new Database(':memory:'); opened.push(record); record.pragma('foreign_keys = ON'); applyOrganizationRecordLogBaselineV4(record);
  const coordinates = { authority_id: authority.descriptor.authority_id, organization_id, state_lineage_id: 'lineage-test' };
  record.prepare('INSERT INTO organization_record_log_metadata VALUES (1,?,?,?,?)').run(coordinates.authority_id, coordinates.organization_id, coordinates.state_lineage_id, NOW);
  let extracted = 0, envelopes = 0;
  const runtime = createPersonMeetingRuntimeV1({
    database: db, sessions: { authenticateAccess() { throw new Error('The canary runs without a person session'); } },
    providers: [createStagingSyntheticPersonalMeetingProviderV1({})],
    processor: {
      processor_adapter_id: 'llm',
      current_commitments: instance_id => ({ adapter_id: 'llm', instance_id, version: '1.0.0', configuration_sha256: canonicalSha256('processor'), credential_reference_sha256: canonicalSha256('reference') }),
      assert_admission_commitments() {},
      create_processor(admission) {
        const identity = { kind: 'decision-processor' as const, adapter_id: 'llm', instance_id: admission.processor.instance_id, version: admission.processor.version };
        return { identity, validateConfig: () => ({ ok: true, errors: [] }), healthCheck: async () => ({ status: 'healthy' as const, checked_at: NOW }),
          async extract(meeting) {
            extracted++;
            return { schema_version: 1, meeting_id: meeting.id, meeting_revision: meeting.provenance.canonical_revision, processor: identity, generated_at: NOW,
              signals: options.signals === false ? [] : [{ id: 'canary-decision', kind: 'decision', status: 'decided', text: 'Verify owner approval of a staged meeting.',
                subject: null, confidence: 1, evidence: [{ meeting_id: meeting.id, block_id: 'synthetic-decision' }] }] };
          } };
      },
    },
    approval: { coordinates, signer: { inspect: async () => authority.descriptor, sign: authority.sign },
      record_append: new OrganizationRecordAppenderV4(record, coordinates, authorityRecordPolicyProjectorsV1()),
      next_envelope_id: () => `env_canary_${++envelopes}` },
    extraction_attempts: { reserve: () => ({ status: 'reserved', attempt: 1, claim_id: 'claim' }), complete() {}, inspect: () => undefined },
  });
  return { db, organization_id, runtime, extracted: () => extracted };
}

const RELEASE = 'clean-v1-staging-canary-one';
const run = (world: Awaited<ReturnType<typeof syntheticWorld>>, release_id = RELEASE) =>
  runStagingSyntheticPersonalCanaryV1({ database: world.db, runtime: world.runtime, release_id, signal: new AbortController().signal });

describe('staging synthetic personal canary', () => {
  it('stages the canary meeting as a proposal for the single active owner', async () => {
    const world = await syntheticWorld();
    const outcome = await run(world);
    expect(outcome.kind).toBe('staged');
    expect(outcome.approval_id).toMatch(/^apr_/);
    const source = world.db.prepare('SELECT source_adapter_id, source_custodian_assurance FROM authority_live_source_admission_v2').get();
    expect(source).toEqual({ source_adapter_id: 'staging-synthetic-meeting', source_custodian_assurance: 'staging_synthetic' });
    expect(world.db.prepare("SELECT count(*) FROM authority_live_source_admission_v2 WHERE source_key = ?").pluck().get('1')).toBe(0);
    expect(world.db.prepare('SELECT principal_id, membership_id FROM authority_live_source_admission_v2').get()).toEqual(OWNER);
    expect(world.db.prepare('SELECT state FROM authority_live_approval_outbox_v2 WHERE approval_id = ?').pluck().get(outcome.approval_id)).toBe('staged');
    expect(world.db.prepare("SELECT json_extract(meeting_json, '$.title') FROM authority_live_source_candidates_v2").pluck().get()).toContain(RELEASE);
  });

  it('reruns without a second proposal for the same release', async () => {
    const world = await syntheticWorld();
    const first = await run(world);
    const second = await run(world);
    expect(second).toEqual(first);
    expect(world.extracted()).toBe(1);
    expect(world.db.prepare('SELECT count(*) FROM authority_live_approval_outbox_v2').pluck().get()).toBe(1);
    expect(world.db.prepare('SELECT count(*) FROM authority_live_source_admission_v2').pluck().get()).toBe(1);
  });

  it('stages a new proposal for a new release and supersedes the undecided earlier canary', async () => {
    const world = await syntheticWorld();
    const first = await run(world);
    const second = await run(world, 'clean-v1-staging-canary-two');
    expect(second.kind).toBe('staged');
    expect(second.approval_id).toMatch(/^apr_/);
    expect(second.approval_id).not.toBe(first.approval_id);
    expect(world.extracted()).toBe(2);
    const state = world.db.prepare('SELECT state FROM authority_live_approval_outbox_v2 WHERE approval_id = ?').pluck();
    expect(state.get(first.approval_id)).toBe('superseded');
    expect(state.get(second.approval_id)).toBe('staged');
    // Both releases share the one canary meeting id; each release is its own revision.
    expect(world.db.prepare("SELECT DISTINCT json_extract(meeting_json, '$.provenance.external_id') FROM authority_live_source_candidates_v2").pluck().all()).toEqual(['synthetic-release-canary']);
    // A rerun of the earlier release reports its stale proposal, not the current one.
    await expect(run(world)).resolves.toEqual({ kind: 'not_staged', approval_id: first.approval_id });
    expect(world.extracted()).toBe(2);
  });

  it('refuses a release id outside the deploy shape before queueing anything', async () => {
    const world = await syntheticWorld();
    await expect(run(world, 'release one')).rejects.toThrow('release id is invalid');
    expect(world.db.prepare('SELECT count(*) FROM authority_live_source_admission_v2').pluck().get()).toBe(0);
  });

  it('reports a canary meeting without signals as not actionable', async () => {
    const world = await syntheticWorld({ signals: false });
    await expect(run(world)).resolves.toEqual({ kind: 'not_actionable', approval_id: null });
  });

  it('refuses unless exactly one active owner holds the synthetic source', async () => {
    const world = await syntheticWorld();
    addOwner(world.db, world.organization_id, { principal_id: 'prn_00000000-0000-4000-8000-000000000013', membership_id: 'mem_00000000-0000-4000-8000-000000000014' });
    await expect(run(world)).rejects.toThrow('exactly one active owner');
    expect(world.db.prepare('SELECT count(*) FROM authority_live_source_admission_v2').pluck().get()).toBe(0);
  });
});
