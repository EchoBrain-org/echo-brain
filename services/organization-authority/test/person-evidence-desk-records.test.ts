import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, canonicalSha256, sha256Digest, type Sha256Digest } from '@echo-brain/federation-protocol';
import { ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, OrganizationRecordAppenderV4 } from '@echo-brain/organization-record/organization-record-api-v1';
import {
  buildReadableSearchGenerationV1,
  expandReadableSearchRelatedAtomsV1,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
  READABLE_SEARCH_CONTENT_BASELINE_V2,
  READABLE_SEARCH_FACTS_BASELINE_SCHEMA_VERSION_V3,
  READABLE_SEARCH_FACTS_BASELINE_V3,
  READABLE_SEARCH_LEXICAL_BASELINE_V2,
  readableSearchPlaneBaselineSha256,
  warmReadableSearchActiveGenerationV1,
  type BuildReadableSearchGenerationV1Input,
  type ReadableSearchAtomV1,
} from '@echo-brain/organization-retrieval/readable-search-engine-v1';
import { applyAuthorityBaselineV10 } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersonRecordReadAuditV1 } from '../src/adapters/persistence/sqlite/person-record-read-audit-v1.js';
import type { PersonOriginalContextEvidenceDeskPortV1 } from '../src/application/ports/person-original-context-retrieval-v1.js';
import { createPersonEvidenceDeskV1 } from '../src/composition/person-evidence-desk-v1.js';
import { createPersonRecordSearchRouteV1 } from '../src/composition/person-record-search-route.js';
import { COORDINATES, appendInput, database as recordDatabase, protocolAuthority } from '../../../packages/organization-record/test/fixtures/record-append-fixture.js';

const roots: string[] = [];
const digest = (value: string): Sha256Digest => canonicalSha256({ value });
const RETRIEVAL_CONTRACT = digest('evidence-desk-retrieval-contract');

function stateRoot(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'echo-evidence-desk-records-')));
  chmodSync(path, 0o700);
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function authorization(): PersonAccessAuthorization {
  return {
    organization_id: COORDINATES.organization_id, principal_id: 'principal_reader', membership_id: 'membership_reader', membership_type: 'employee',
    identity_binding_id: 'identity_reader', session_family_id: 'session_reader', access_credential_sha256: digest('access'),
    access_expires_at: '2026-09-28T01:00:00.000Z', hard_reauthentication_at: '2026-09-28T02:00:00.000Z',
    person_state_sha256: digest('person'), session_state_sha256: digest('session'), checked_at: '2026-09-27T01:00:00.000Z',
  };
}

function atom(input: { readonly record_sha256: Sha256Digest; readonly envelope_sha256: Sha256Digest }): ReadableSearchAtomV1 {
  const text = 'Decision 0';
  return {
    authority_id: COORDINATES.authority_id, organization_id: COORDINATES.organization_id, state_lineage_id: COORDINATES.state_lineage_id, record_position: 1,
    record_sha256: input.record_sha256, envelope_sha256: input.envelope_sha256, approval_id: 'approval-1', atom_id: sha256Digest('atom'), atom_order: 0,
    signal_id_sha256: sha256Digest('signal'), item_kind: 'decision', text, text_sha256: sha256Digest(text),
    policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2, policy_contract_sha256: sha256Digest('member-policy'),
    authorization_audit_event_id: 'audit-1', authorization_audit_sequence: 1, authorization_audit_entry_sha256: sha256Digest('audit'),
    provider_action_sha256: sha256Digest('provider'), authorization_proof_sha256: sha256Digest('proof'), reviewer_principal_id: null, reviewer_membership_id: null,
  };
}

function generation(state_directory: string, atoms: readonly ReadableSearchAtomV1[]): BuildReadableSearchGenerationV1Input {
  const plane = (role: string, baseline: Parameters<typeof readableSearchPlaneBaselineSha256>[0], database_schema_version: 1 | 2 | 3) => {
    const schema_sha256 = readableSearchPlaneBaselineSha256(baseline);
    const manifest_json = canonicalJson({ schema_version: 1, kind: 'echo-state-lineage-database-manifest-v1', role, ...COORDINATES, database_schema_version, schema_sha256, created_at: '2026-09-27T00:00:00.000Z', creating_artifact_revision: 'test' });
    return { database_schema_version, schema_sha256, manifest_json, manifest_sha256: sha256Digest(manifest_json) };
  };
  return {
    state_directory,
    lineage: { ...COORDINATES, planes: {
      facts: plane('retrieval-facts', READABLE_SEARCH_FACTS_BASELINE_V3, READABLE_SEARCH_FACTS_BASELINE_SCHEMA_VERSION_V3),
      content: plane('retrieval-content', READABLE_SEARCH_CONTENT_BASELINE_V2, 2), lexical: plane('retrieval-lexical', READABLE_SEARCH_LEXICAL_BASELINE_V2, 2),
    } },
    exact_head: { ...COORDINATES, position: 1, record_sha256: atoms[0]!.record_sha256 },
    retrieval_contract_sha256: RETRIEVAL_CONTRACT, organization_member_policy_contract_sha256: sha256Digest('member-policy'), restricted_reviewer_policy_contract_sha256: sha256Digest('restricted-policy'),
    analyzer: { analyzer_contract_sha256: sha256Digest('analyzer-contract'), analyzer_source_sha256: sha256Digest('analyzer-source'), node_version: '22.22.1', unicode_version: '16.0', icu_version: '76.1' },
    source_revision: 'test', builder_artifact_sha256: sha256Digest('builder'), sqlite_version: '3.50.4', atoms,
  };
}

function emptyOriginals(): PersonOriginalContextEvidenceDeskPortV1 {
  const release = {
    release: { authorization: { principal_id: 'principal_reader', membership_id: 'membership_reader', session_family_id: 'session_reader', checked_at: '2026-09-27T01:00:00.000Z' }, scope: { kind: 'global' as const }, authorization_revision: 0, released_atoms: [] },
    receipt: digest('empty-original-release'), items: [],
  };
  return {
    deskAuthorize: () => ({ checked_at: '2026-09-27T01:00:00.000Z' }), deskSearch: () => release, deskOpen: () => release, revalidateDeskRelease: () => ({ checked_at: '2026-09-27T01:00:00.000Z' }),
  } as unknown as PersonOriginalContextEvidenceDeskPortV1;
}

async function fixture(options: { readonly active?: boolean; readonly corrupt?: boolean; readonly forged_pointer?: boolean } = {}) {
  const authority = openAuthorityDatabase(':memory:');
  applyAuthorityBaselineV10(authority);
  authority.prepare("INSERT INTO authority_metadata(singleton,authority_id,organization_id,organization_display_name,descriptor_json,created_at,last_observed_at) VALUES(1,?,?, 'Clean','{}','2026-09-27T00:00:00.000Z','2026-09-27T00:00:00.000Z')").run(COORDINATES.authority_id, COORDINATES.organization_id);
  const record = recordDatabase();
  const appended = await new OrganizationRecordAppenderV4(record, COORDINATES).append(appendInput({ authority: protocolAuthority(), policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID }));
  const state_directory = stateRoot();
  const recordAtom = atom(appended);
  if (options.active !== false) {
    const built = buildReadableSearchGenerationV1(generation(state_directory, [recordAtom]));
    const active = { generation_id: built.manifest.generation_id, manifest_sha256: built.manifest_sha256, retrieval_contract_sha256: RETRIEVAL_CONTRACT, exact_head: { ...COORDINATES, position: 1, record_sha256: recordAtom.record_sha256 } };
    warmReadableSearchActiveGenerationV1({ state_directory, active_generation: active });
    authority.prepare('INSERT INTO authority_readable_search_active_generation(singleton,organization_id,generation_id,manifest_sha256,retrieval_contract_sha256,record_head_position,record_head_hash,published_at) VALUES(1,?,?,?,?,?,?,?)').run(COORDINATES.organization_id, active.generation_id, active.manifest_sha256, RETRIEVAL_CONTRACT, 1, recordAtom.record_sha256, '2026-09-27T00:00:00.000Z');
    if (options.forged_pointer) authority.prepare('UPDATE authority_readable_search_active_generation SET record_head_hash = ? WHERE singleton = 1').run(digest('forged-head'));
  }
  let revoked = false;
  let authentication_count = 0;
  const sessions = {
    authenticateAccess: () => {
      if (revoked) throw new AuthorityOperationError('unauthorized', 'person authentication failed');
      return { ...authorization(), checked_at: new Date(Date.UTC(2026, 8, 27, 1, 0, authentication_count++)).toISOString() };
    },
  };
  const route = createPersonRecordSearchRouteV1({
    state_directory, ...COORDINATES, retrieval_contract_sha256: RETRIEVAL_CONTRACT,
    sessions, authority, record, audit: new SqlitePersonRecordReadAuditV1(authority), expand_related_atoms: expandReadableSearchRelatedAtomsV1,
    ...(options.corrupt ? { search_generation: () => { throw new Error('corrupt readable index'); } } : {}),
  });
  const makeDesk = () => createPersonEvidenceDeskV1({ access_token: 'token', scope: { kind: 'global' }, originals: emptyOriginals(), records: route });
  return { authority, record, route, recordAtom, makeDesk, revoke: () => { revoked = true; }, close: () => { record.close(); authority.close(); } };
}

describe('Person evidence desk over the real approved-record route', () => {
  it('returns real record search text, inventory metadata, and fresh-citation open packets', async () => {
    const value = await fixture();
    try {
      const desk = value.makeDesk();
      const searched = await desk.search({ query: 'Decision', limit: 10 });
      const hit = searched.items.find(item => item.citation.kind === 'approved_record');
      expect(hit).toMatchObject({ kind: 'decision', text: value.recordAtom.text, visibility: 'team', attributes: { status: 'decided' } });
      expect(searched.receipt_digests).not.toHaveLength(0);

      const inventoryDesk = value.makeDesk();
      const inventory = await inventoryDesk.search({ limit: 10 });
      const inventoryItem = inventory.items.find(item => item.citation.kind === 'approved_record');
      expect(inventoryItem).toMatchObject({ label: 'Approved meeting' });
      expect(inventoryItem).not.toHaveProperty('text');
      const inventoryOpened = await inventoryDesk.open({ item: inventoryItem!.id });
      expect(inventoryOpened.items[0]).toMatchObject({ id: inventoryItem!.id, text: value.recordAtom.text });

      const fresh = value.makeDesk();
      const opened = await fresh.openCitation({ citation: hit!.citation });
      expect(opened.items).toEqual(expect.arrayContaining([expect.objectContaining({ citation: hit!.citation, text: value.recordAtom.text })]));
      await fresh.revalidate({});
    } finally { value.close(); }
  });

  it('fails closed when a retained record release is revoked or its active pointer drifts', async () => {
    const revoked = await fixture();
    try {
      const desk = revoked.makeDesk();
      await desk.search({ query: 'Decision', limit: 10 });
      revoked.revoke();
      await expect(desk.revalidate({})).rejects.toThrow('person authentication failed');
    } finally { revoked.close(); }

    const drifted = await fixture();
    try {
      const desk = drifted.makeDesk();
      await desk.search({ query: 'Decision', limit: 10 });
      drifted.authority.prepare('UPDATE authority_readable_search_active_generation SET manifest_sha256=? WHERE singleton=1').run(digest('drift'));
      await expect(desk.revalidate({})).rejects.toThrow('person authentication failed');
    } finally { drifted.close(); }
  });

  it('treats an unavailable index at request start as a records-only notice, but propagates corruption', async () => {
    const lagged = await fixture({ active: false });
    try {
      const result = await lagged.makeDesk().search({ query: 'launch', limit: 10 });
      expect(result.items.filter(item => item.citation.kind === 'approved_record')).toEqual([]);
      expect(result.notice).toContain('Meeting records were unavailable');
    } finally { lagged.close(); }

    const corrupt = await fixture({ corrupt: true });
    try {
      await expect(corrupt.makeDesk().search({ query: 'launch', limit: 10 })).rejects.toThrow('corrupt readable index');
    } finally { corrupt.close(); }

    const forged = await fixture({ forged_pointer: true });
    try {
      await expect(forged.makeDesk().search({ query: 'Decision', limit: 10 })).rejects.toBeInstanceOf(AuthorityOperationError);
    } finally { forged.close(); }
  });
});
