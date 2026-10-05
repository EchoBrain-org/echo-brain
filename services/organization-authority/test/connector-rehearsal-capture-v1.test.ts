import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import { createGranolaPostCutoffCursor, createGranolaMeetingSourceAdapter } from '../../../providers/granola/src/source/meeting-source-adapter.js';
import { granolaAdmittedMeetingSourceCursorPolicyV1 } from '../../../providers/granola/src/granola-admitted-meeting-source-cursor-policy-v1.js';
import type { GranolaApiClient, GranolaListParams, GranolaNoteDetail } from '../../../providers/granola/src/source/granola-api-client.js';
import { bootstrapOrganizationAuthorityState } from '../src/composition/organization-authority-state-bootstrap.js';
import { openConnectorRehearsalCaptureV1 } from '../src/composition/connector-rehearsal-capture-v1.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

const OWNER_TOKEN = 'owner-token';

class GranolaFixture implements GranolaApiClient {
  readonly list = vi.fn(async (_params: GranolaListParams) => ({
    notes: [{ id: 'note-1', created_at: '2026-10-02T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z' }],
    hasMore: false, cursor: null,
  }));
  readonly detail = vi.fn(async (): Promise<GranolaNoteDetail> => ({
    id: 'note-1', title: 'Private Granola meeting', created_at: '2026-10-02T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z',
    summary_text: 'The body must only remain in retained local custody.', transcript: [{ text: 'Capture this one meeting.' }],
  }));
  listNotes(params: GranolaListParams) { return this.list(params); }
  getNote(_id: string) { return this.detail(); }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'echo-connector-rehearsal-')); chmodSync(root, 0o700); roots.push(root);
  const initialized = bootstrapOrganizationAuthorityState({
    state_directory: join(root, 'state'), organization_display_name: 'Fixture', owner_display_name: 'Founder',
    created_at: '2026-10-01T00:00:00.000Z', creating_artifact_revision: 'connector-rehearsal-fixture',
  });
  const database = openAuthorityDatabase(join(initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
  const cutoff = '2026-10-01T00:00:00.000Z';
  const cursor = createGranolaPostCutoffCursor(cutoff);
  database.prepare(`INSERT INTO authority_live_source_admission_v2 (
    singleton, organization_id, principal_id, membership_id, membership_type,
    source_adapter_id, source_adapter_version, source_adapter_instance_id, normalizer_version,
    source_custodian_sha256, source_custodian_assurance, source_custodian_observed_at,
    source_credential_reference_sha256, initial_cursor, cutoff_at,
    processor_adapter_id, processor_adapter_version, processor_instance_id,
    processor_configuration_sha256, processor_credential_reference_sha256, semantic_input_sha256, admitted_at
  ) VALUES (1, ?, ?, ?, 'owner', 'granola', '2.2.0', 'primary', '2.2.0', ?, 'authority_initial_owner_identity', ?, ?, ?, ?, 'fixture-processor', '1.0.0', 'fixture-processor', ?, ?, ?, ?)`)
    .run(initialized.organization_id, initialized.owner_principal_id, initialized.owner_membership_id,
      canonicalSha256('owner'), cutoff, canonicalSha256('granola-credential'), cursor, cutoff,
      canonicalSha256('processor'), canonicalSha256('processor-credential'), canonicalSha256('admission'), cutoff);
  database.close();

  let authorization: PersonAccessAuthorization = {
    organization_id: initialized.organization_id, principal_id: initialized.owner_principal_id,
    membership_id: initialized.owner_membership_id, membership_type: 'owner', identity_binding_id: 'fixture-identity',
    session_family_id: 'fixture-session', access_credential_sha256: canonicalSha256('access'), person_state_sha256: canonicalSha256('person'),
    session_state_sha256: canonicalSha256('session'), checked_at: cutoff, access_expires_at: '2026-10-03T00:00:00.000Z', hard_reauthentication_at: '2026-10-04T00:00:00.000Z',
  };
  const authenticateAccess = vi.fn(({ access_token }: { access_token: string }) => {
    if (access_token !== OWNER_TOKEN) throw new Error('bad token');
    return authorization;
  });
  const granolaClient = new GranolaFixture();
  const granola = createGranolaMeetingSourceAdapter({ adapter_id: 'granola', instance_id: 'primary', settings: { page_size: 1 } }, {
    client: granolaClient, now: () => '2026-10-03T00:00:00.000Z',
  });

  const exclusive = { run_exclusive: async <T>(operation: (signal: AbortSignal) => Promise<T>) => operation(new AbortController().signal) };
  const open = (includeGranola = true, initialOwner = { organization_id: initialized.organization_id, principal_id: initialized.owner_principal_id, membership_id: initialized.owner_membership_id }) => openConnectorRehearsalCaptureV1({
    state_directory: initialized.state_directory,
    initial_owner: initialOwner,
    authenticate_access: { authenticateAccess }, exclusive,
    ...(includeGranola ? { granola: { source: granola, source_cursor_policy: granolaAdmittedMeetingSourceCursorPolicyV1, processor_adapter_id: 'fixture-processor' } } : {}),
  });
  return { initialized, cursor, authorization: (value?: PersonAccessAuthorization) => { if (value !== undefined) authorization = value; return authorization; }, granolaClient, open };
}

describe('connector rehearsal capture V1', () => {
  it('retains one Granola full snapshot only under the initial-owner qualification policy', async () => {
    const f = fixture(); const rehearsal = f.open();
    try {
      const receipt = await rehearsal.capture({ tool: 'granola', access_token: OWNER_TOKEN, limit: 1 });
      expect(receipt).toMatchObject({ counts: { captured: 1, admitted: 1 }, captures: [{ source_type: 'note', admission: 'admitted' }] });
      expect(JSON.stringify(receipt)).not.toContain('Private Granola meeting');
      const db = openAuthorityDatabase(join(f.initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
      try {
        expect(db.prepare("SELECT access_policy_ref FROM authority_sources_v1 WHERE access_policy_ref LIKE 'connector-rehearsal-granola-initial-owner:%'").all()).toHaveLength(1);
        // readAdmission can initialize the progress row, but rehearsal must never advance it.
        expect(db.prepare('SELECT cursor FROM authority_live_source_progress_v2 WHERE singleton=1').get()).toEqual({ cursor: f.cursor });
      } finally { db.close(); }
      expect(f.granolaClient.list).toHaveBeenCalledTimes(1);
      f.authorization({ ...f.authorization(), membership_type: 'employee' });
      await expect(rehearsal.capture({ tool: 'granola', access_token: OWNER_TOKEN, limit: 1 })).rejects.toThrow('Context capture rehearsal failed');
      expect(f.granolaClient.list).toHaveBeenCalledTimes(1);
    } finally { rehearsal.close(); }
  });


  it('requires the admitted Granola custodian to be the same initial owner before a provider read', async () => {
    const f = fixture();
    const db = openAuthorityDatabase(join(f.initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
    try {
      db.prepare("INSERT INTO authority_principals(principal_id,organization_id,display_name,provisioned_at) VALUES ('prn_other',?,'Other','2026-10-01T00:00:00.000Z')").run(f.initialized.organization_id);
      db.prepare("INSERT INTO authority_memberships(membership_id,organization_id,principal_id,membership_type,status,provisioned_at,revoked_at,revocation_reason) VALUES ('mem_other',?,'prn_other','owner','active','2026-10-01T00:00:00.000Z',NULL,NULL)").run(f.initialized.organization_id);
    } finally { db.close(); }
    f.authorization({ ...f.authorization(), principal_id: 'prn_other', membership_id: 'mem_other', membership_type: 'owner' });
    const rehearsal = f.open(true, { organization_id: f.initialized.organization_id, principal_id: 'prn_other', membership_id: 'mem_other' });
    try {
      await expect(rehearsal.capture({ tool: 'granola', access_token: OWNER_TOKEN, limit: 1 })).rejects.toThrow('Context capture rehearsal failed');
      expect(f.granolaClient.list).not.toHaveBeenCalled();
    } finally { rehearsal.close(); }
  });

  it.each(['jira', 'slack'])('refuses %s capture before any source work', async tool => {
    const f = fixture(); const rehearsal = f.open();
    try {
      await expect(rehearsal.capture({ tool: tool as 'granola', access_token: OWNER_TOKEN, limit: 1 }))
        .rejects.toThrow('Context capture rehearsal failed');
      expect(f.granolaClient.list).not.toHaveBeenCalled();
      const db = openAuthorityDatabase(join(f.initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
      try {
        for (const table of ['authority_sources_v1', 'authority_source_revisions_v1', 'authority_source_contents_v1', 'authority_source_representations_v1']) {
          expect(db.prepare(`SELECT 1 FROM ${table}`).all()).toHaveLength(0);
        }
      } finally { db.close(); }
    } finally { rehearsal.close(); }
  });
});
