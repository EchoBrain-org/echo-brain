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
import { applyAuthorityBaselineV13 } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersonAnswerCitationV3 } from '@echo-brain/organization-api';
import { SqlitePersonRecordReadAuditV1 } from '../src/adapters/persistence/sqlite/person-record-read-audit-v1.js';
import type { PersonOriginalContextEvidenceDeskPortV1 } from '../src/application/ports/person-original-context-retrieval-v1.js';
import { createPersonEvidenceDeskV1 } from '../src/composition/person-evidence-desk-v1.js';
import { createPersonRecordSearchRouteV1, type PersonEvidenceDeskRecordsV1 } from '../src/composition/person-record-search-route.js';
import { meetingWorld } from './fixtures/person-meeting-world.js';
import { COORDINATES, appendInput, database as recordDatabase, protocolAuthority } from '../../../packages/organization-record/test/fixtures/record-append-fixture.js';

import { SIGNED_APPROVAL_CODECS, SIGNED_APPROVAL_PROJECTORS, appendSignedApprovalV1 } from './fixtures/signed-approval-decision-v1.js';

const roots: string[] = [];
const closers: (() => void)[] = [];
const digest = (value: string): Sha256Digest => canonicalSha256({ value });
const RETRIEVAL_CONTRACT = digest('evidence-desk-retrieval-contract');

function stateRoot(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'echo-evidence-desk-records-')));
  chmodSync(path, 0o700);
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const close of closers.splice(0)) close();
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

function atom(input: { readonly record_sha256: Sha256Digest; readonly envelope_sha256: Sha256Digest }, text = 'Decision 0'): ReadableSearchAtomV1 {
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

function authorityDatabase() {
  const authority = openAuthorityDatabase(':memory:');
  applyAuthorityBaselineV13(authority);
  authority.prepare("INSERT INTO authority_metadata(singleton,authority_id,organization_id,organization_display_name,descriptor_json,created_at,last_observed_at) VALUES(1,?,?, 'Clean','{}','2026-09-27T00:00:00.000Z','2026-09-27T00:00:00.000Z')").run(COORDINATES.authority_id, COORDINATES.organization_id);
  return authority;
}

/** Builds and warms a one-atom readable-search generation, then publishes its active pointer. */
function publish(authority: ReturnType<typeof openAuthorityDatabase>, state_directory: string, recordAtom: ReadableSearchAtomV1): void {
  const built = buildReadableSearchGenerationV1(generation(state_directory, [recordAtom]));
  const active = { generation_id: built.manifest.generation_id, manifest_sha256: built.manifest_sha256, retrieval_contract_sha256: RETRIEVAL_CONTRACT, exact_head: { ...COORDINATES, position: 1, record_sha256: recordAtom.record_sha256 } };
  warmReadableSearchActiveGenerationV1({ state_directory, active_generation: active });
  authority.prepare('INSERT INTO authority_readable_search_active_generation(singleton,organization_id,generation_id,manifest_sha256,retrieval_contract_sha256,record_head_position,record_head_hash,published_at) VALUES(1,?,?,?,?,?,?,?)').run(COORDINATES.organization_id, active.generation_id, active.manifest_sha256, RETRIEVAL_CONTRACT, 1, recordAtom.record_sha256, '2026-09-27T00:00:00.000Z');
}

async function fixture(options: { readonly active?: boolean; readonly corrupt?: boolean; readonly forged_pointer?: boolean; readonly atom_text?: string; readonly atom_envelope_sha256?: Sha256Digest } = {}) {
  const authority = authorityDatabase();
  const record = recordDatabase();
  closers.push(() => { record.close(); authority.close(); });
  const appended = await new OrganizationRecordAppenderV4(record, COORDINATES).append(appendInput({ authority: protocolAuthority(), policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, ...(options.atom_text === undefined ? {} : { decision_text: options.atom_text }) }));
  const state_directory = stateRoot();
  const recordAtom = atom({ ...appended, envelope_sha256: options.atom_envelope_sha256 ?? appended.envelope_sha256 }, options.atom_text);
  if (options.active !== false) {
    publish(authority, state_directory, recordAtom);
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
  return { authority, route, recordAtom, makeDesk, revoke: () => { revoked = true; } };
}

describe('Person evidence desk over the real approved-record route', () => {
  it.each([
    { kind: 'note', includeRecords: false, ref: `note:ctx_${'a'.repeat(64)}` },
    { kind: 'document_passage', includeRecords: false, ref: `document:doc_${'b'.repeat(64)}` },
    { kind: 'note', includeRecords: true, ref: `note:ctx_${'a'.repeat(64)}` },
  ] as const)('searches $kind evidence with record kinds requested: $includeRecords', async ({ kind, includeRecords, ref }) => {
    const value = await fixture();
    const originals = emptyOriginals();
    const release = {
      ...originals.deskSearch({ access_token: 'token', scope: { kind: 'global' } }),
      items: [{
        kind, text: 'Decision from the original', visibility: 'team' as const, label: 'Original decision',
        received_at: '2026-09-27T00:00:00.000Z', version: '1', ref,
        citation: { kind: 'source_revision' as const, source_id: 'source-original', revision_id: 'revision-original',
          source_sha256: digest('source'), representation_sha256: digest('representation'), anchor_sha256: digest('anchor') },
      }],
      truncated: false,
    };
    const deskSearch = vi.fn(() => release);
    const searchBatch = vi.fn((input: Parameters<typeof value.route.searchBatch>[0]) => value.route.searchBatch(input));
    const desk = createPersonEvidenceDeskV1({
      access_token: 'token', scope: { kind: 'global' }, originals: { ...originals, deskSearch }, records: { ...value.route, searchBatch },
    });
    const searched = await desk.search({ query: 'Decision', kinds: includeRecords ? [kind, 'decision'] : [kind] });
    expect(deskSearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'Decision', kinds: [kind] }));
    expect(searched.items.map(item => item.kind)).toEqual(includeRecords ? [kind, 'decision'] : [kind]);
    // Record items carry their meeting ref; original items keep their store ref.
    expect(searched.items.map(item => [item.citation.kind, item.ref])).toEqual(includeRecords
      ? [['source_revision', ref], ['approved_record', `meeting:${value.recordAtom.record_sha256}`]]
      : [['source_revision', ref]]);
    expect(searched.items[0]).toMatchObject({ text: 'Decision from the original', receipt_sha256: release.receipt });
    expect(searched.receipt_digests).toContain(release.receipt);
    if (includeRecords) expect(searchBatch).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['decision'] }));
    else expect(searchBatch).not.toHaveBeenCalled();
    await desk.revalidate({});
  });

  it('returns real record search text, inventory metadata, and fresh-citation open packets', async () => {
    const value = await fixture();
    const meeting = `meeting:${value.recordAtom.record_sha256}`;
    const desk = value.makeDesk();
    const searched = await desk.search({ query: 'Decision', limit: 10 });
    const hit = searched.items.find(item => item.citation.kind === 'approved_record');
    expect(hit).toMatchObject({ kind: 'decision', text: value.recordAtom.text, visibility: 'team', attributes: { status: 'decided' }, ref: meeting });
    expect(searched.receipt_digests).not.toHaveLength(0);

    // Inventory items, opened items and fresh citation opens carry the same ref.
    const inventoryDesk = value.makeDesk();
    const inventory = await inventoryDesk.search({ limit: 10 });
    const inventoryItem = inventory.items.find(item => item.citation.kind === 'approved_record');
    expect(inventoryItem).toMatchObject({ label: 'Approved meeting', ref: meeting });
    expect(inventoryItem).not.toHaveProperty('text');
    const inventoryOpened = await inventoryDesk.open({ item: inventoryItem!.id });
    expect(inventoryOpened.items[0]).toMatchObject({ id: inventoryItem!.id, text: value.recordAtom.text, ref: meeting });

    const fresh = value.makeDesk();
    const opened = await fresh.openCitation({ citation: hit!.citation as PersonAnswerCitationV3 });
    expect(opened.items).toEqual(expect.arrayContaining([expect.objectContaining({ citation: hit!.citation, text: value.recordAtom.text })]));
    expect(opened.items.map(item => item.ref)).toEqual([meeting]);
    await fresh.revalidate({});
  });

  it('fails closed when a retained record release is revoked or its active pointer drifts', async () => {
    const revoked = await fixture();
    const revokedDesk = revoked.makeDesk();
    await revokedDesk.search({ query: 'Decision', limit: 10 });
    revoked.revoke();
    await expect(revokedDesk.revalidate({})).rejects.toThrow('person authentication failed');

    const drifted = await fixture();
    const driftedDesk = drifted.makeDesk();
    await driftedDesk.search({ query: 'Decision', limit: 10 });
    drifted.authority.prepare('UPDATE authority_readable_search_active_generation SET manifest_sha256=? WHERE singleton=1').run(digest('drift'));
    await expect(driftedDesk.revalidate({})).rejects.toThrow('person authentication failed');
  });

  it('does not turn a valid release witness into authority for a forged atom anchor', async () => {
    const value = await fixture();
    const batch = value.route.searchBatch({ access_token: 'token', queries: ['Decision'], desk: true });
    const anchor = batch.desk_items![0]!;
    expect(() => value.route.openDeskBatch({
      access_token: 'token',
      release: batch.release,
      anchor: { ...anchor, atom_id: digest('forged-record-atom') },
    })).toThrow('exact-head readable-search generation is not available');
  });

  it('keeps a 3,072-byte record atom, but omits 3,073- and 4,096-byte atoms with truncation', async () => {
    const accepted = await fixture({ atom_text: `Decision ${'x '.repeat(1_532).slice(0, 3_063)}` });
    expect(Buffer.byteLength(accepted.recordAtom.text, 'utf8')).toBe(3_072);
    const result = await accepted.makeDesk().search({ query: 'Decision', limit: 10 });
    expect(result.items.filter(item => item.citation.kind === 'approved_record')).toHaveLength(1);
    expect(result.truncated).toBe(false);
    const inventoryDesk = accepted.makeDesk();
    const inventory = await inventoryDesk.search({ limit: 10 });
    const item = inventory.items.find(value => value.citation.kind === 'approved_record');
    expect(item).toBeDefined();
    await expect(inventoryDesk.open({ item: item!.id })).resolves.toMatchObject({
      items: [expect.objectContaining({ text: accepted.recordAtom.text })],
    });

    for (const bytes of [3_073, 4_096]) {
      const value = await fixture({ atom_text: `Decision ${'x '.repeat(2_100).slice(0, bytes - 9)}` });
      expect(Buffer.byteLength(value.recordAtom.text, 'utf8')).toBe(bytes);
      const result = await value.makeDesk().search({ query: 'Decision', limit: 10 });
      expect(result.items.filter(item => item.citation.kind === 'approved_record')).toEqual([]);
      expect(result.truncated).toBe(true);
    }
  });

  it('writes one final record-read audit for a fresh citation open', async () => {
    const value = await fixture();
    const desk = value.makeDesk();
    const searched = await desk.search({ query: 'Decision', limit: 10 });
    const citation = searched.items.find(item => item.citation.kind === 'approved_record')!.citation;
    if (citation.kind !== 'approved_record') throw new Error('missing record citation');
    const count = () => (value.authority.prepare("SELECT count(*) AS n FROM authority_person_read_decision_audit_v2 WHERE context_kind='record_read'").get() as { readonly n: number }).n;
    const before = count();
    await desk.openCitation({ citation });
    expect(count()).toBe(before + 1);
  });

  it('fails closed when raw-record metadata no longer binds the warmed envelope', async () => {
    const value = await fixture({ atom_envelope_sha256: digest('corrupt-envelope') });
    await expect(value.makeDesk().search({ query: 'Decision', limit: 10 })).rejects.toThrow('record evidence metadata is unavailable');
  });

  it('treats an unavailable index at request start as a records-only notice, but propagates corruption', async () => {
    const lagged = await fixture({ active: false });
    const result = await lagged.makeDesk().search({ query: 'launch', limit: 10 });
    expect(result.items.filter(item => item.citation.kind === 'approved_record')).toEqual([]);
    expect(result.notice).toContain('Meeting records were unavailable');

    const corrupt = await fixture({ corrupt: true });
    await expect(corrupt.makeDesk().search({ query: 'launch', limit: 10 })).rejects.toThrow('corrupt readable index');

    const forged = await fixture({ forged_pointer: true });
    await expect(forged.makeDesk().search({ query: 'Decision', limit: 10 })).rejects.toBeInstanceOf(AuthorityOperationError);
  });
});

describe('Person evidence desk: one source at a time', () => {
  it('lists meeting records without text, one source only', async () => {
    const value = await fixture();
    const listed = await value.makeDesk().list({ source: 'meeting', kinds: ['decision'] });
    expect(listed.items).toEqual([expect.objectContaining({ kind: 'decision', label: 'Approved meeting' })]);
    expect(listed.items[0]).not.toHaveProperty('text');
  });

  it('reads no Slack: a Slack-only search or list returns nothing, with no Slack receipt', async () => {
    const value = await fixture();
    const desk = value.makeDesk();
    const searched = await desk.search({ query: 'Decision', kinds: ['slack_message'], limit: 8 });
    expect(searched.items).toEqual([]);
    expect(searched.notice).toBeUndefined();
    const listed = await desk.list({ source: 'slack', channel: 'hw-dvt' });
    expect(listed).toMatchObject({ items: [], truncated: false });
  });
});

describe('Person evidence desk over an approval-decision record with a confirmed owner', () => {
  async function approvedFixture(withCodecs: boolean) {
    const authority = authorityDatabase();
    const record = recordDatabase();
    closers.push(() => { record.close(); authority.close(); });
    const signer = protocolAuthority();
    const approval_id = 'apr_desk_owner_v3';
    await appendSignedApprovalV1(new OrganizationRecordAppenderV4(record, COORDINATES, SIGNED_APPROVAL_PROJECTORS), signer, {
      // Only me, approved by the reader the desk's route authenticates.
      approval_id, audit_sequence: 1, projects: [], final_approver: { principal_id: 'principal_reader', membership_id: 'membership_reader' },
      signals: { decisions: 1, actions: 2 }, action_owners: [{ signal_id: `action-${approval_id}-1`, owner: 'Jules' }],
    });
    const row = record.prepare('SELECT record_sha256, envelope_sha256 FROM organization_record_log WHERE position = 1').get() as { record_sha256: Sha256Digest; envelope_sha256: Sha256Digest };
    const text = 'Action 1 Owner: Jules.';
    const recordAtom = { ...atom(row, text), approval_id, atom_order: 2, item_kind: 'action' as const, atom_id: sha256Digest('owner-atom'), signal_id_sha256: sha256Digest(`action-${approval_id}-1`) };
    let checks = 0;
    const state_directory = stateRoot();
    publish(authority, state_directory, recordAtom);
    const route = createPersonRecordSearchRouteV1({ state_directory, ...COORDINATES, retrieval_contract_sha256: RETRIEVAL_CONTRACT, sessions: { authenticateAccess: () => ({ ...authorization(), checked_at: new Date(Date.UTC(2026, 8, 27, 1, 0, checks++)).toISOString() }) }, authority, record, audit: new SqlitePersonRecordReadAuditV1(authority), expand_related_atoms: expandReadableSearchRelatedAtomsV1, ...(withCodecs ? { record_input_codecs: SIGNED_APPROVAL_CODECS } : {}) });
    return createPersonEvidenceDeskV1({ access_token: 'token', scope: { kind: 'global' }, originals: emptyOriginals(), records: route });
  }

  it('reads the confirmed owner from the signed approval, and matches the owned search text exactly', async () => {
    const desk = await approvedFixture(true);
    const searched = await desk.search({ query: 'Jules', limit: 10 });
    expect(searched.items.find(item => item.citation.kind === 'approved_record')).toMatchObject({ kind: 'action', text: 'Action 1 Owner: Jules.', attributes: { owner: 'Jules' } });
  });

  it('needs the Authority record codecs to read an approval-decision record at all', async () => {
    const desk = await approvedFixture(false);
    await expect(desk.search({ query: 'Jules', limit: 10 })).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('Person evidence desk: mine (ADR-0024)', () => {
  it('passes mine, never a project, to every record call, and returns only the caller\'s own approvals', async () => {
    const w = await meetingWorld();
    closers.push(w.close);
    const route = w.route();
    const calls: { readonly method: string; readonly input: object }[] = [];
    const records: PersonEvidenceDeskRecordsV1 = {
      ...route,
      initializeDesk(input) { calls.push({ method: 'initializeDesk', input }); return route.initializeDesk.call(this, input); },
      searchBatch(input) { calls.push({ method: 'searchBatch', input }); return route.searchBatch(input); },
      listDeskBatch(input) { calls.push({ method: 'listDeskBatch', input }); return route.listDeskBatch(input); },
      openDeskCitation(input) { calls.push({ method: 'openDeskCitation', input }); return route.openDeskCitation(input); },
    };
    const desk = createPersonEvidenceDeskV1({ access_token: 'emp_a', scope: { kind: 'mine' }, originals: emptyOriginals(), records });
    expect(desk.scope).toEqual({ kind: 'mine' });
    const recordsOf = (items: readonly { readonly citation: { readonly kind: string; readonly record_sha256?: string } }[]) =>
      [...new Set(items.flatMap((item) => item.citation.kind === 'approved_record' ? [item.citation.record_sha256] : []))];
    const searched = await desk.search({ query: 'Decision' });
    expect(recordsOf(searched.items)).toEqual([w.digest('r4')]);
    expect(recordsOf((await desk.search({})).items)).toEqual([w.digest('r4')]);
    expect(recordsOf((await desk.list({ source: 'meeting' })).items)).toEqual([w.digest('r4')]);
    const own = searched.items.find((item) => item.citation.kind === 'approved_record')!.citation as PersonAnswerCitationV3;
    expect(recordsOf((await desk.openCitation({ citation: own })).items)).toEqual([w.digest('r4')]);
    const other = route.searchBatch({ access_token: 'emp_a', queries: ['Decision'], desk: true }).desk_items!.find((item) => item.record_sha256 === w.digest('r1'))!;
    await expect(desk.openCitation({ citation: { kind: 'approved_record', atom_id: other.atom_id, record_sha256: other.record_sha256, policy_id: other.policy_id } as PersonAnswerCitationV3 })).rejects.toMatchObject({ code: 'not_found' });
    await desk.revalidate({});
    expect(new Set(calls.map((call) => call.method))).toEqual(new Set(['initializeDesk', 'searchBatch', 'listDeskBatch', 'openDeskCitation']));
    for (const call of calls) {
      expect(call.input).toMatchObject({ mine: true });
      expect(call.input).not.toHaveProperty('project_id');
    }
  });
});
