import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, canonicalSha256, sha256Digest, type Sha256Digest } from '@echo-brain/federation-protocol';
import { OrganizationRecordAppenderV4 } from '@echo-brain/organization-record/organization-record-api-v1';
import {
  buildReadableSearchGenerationV1,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
  READABLE_SEARCH_CONTENT_BASELINE_V2,
  READABLE_SEARCH_FACTS_BASELINE_SCHEMA_VERSION_V3,
  READABLE_SEARCH_FACTS_BASELINE_V3,
  READABLE_SEARCH_LEXICAL_BASELINE_V2,
  readableSearchPlaneBaselineSha256,
  warmReadableSearchActiveGenerationV1,
  type BuildReadableSearchGenerationV1Input,
  type ReadableSearchAtomV1,
} from '@echo-brain/organization-retrieval/readable-search-engine-v1';
import { applyAuthorityBaseline } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersonAnswerCitationV3 } from '@echo-brain/organization-api';
import { SqlitePersonRecordReadAuditV1 } from '../src/adapters/persistence/sqlite/person-record-read-audit-v1.js';
import type { PersonOriginalContextEvidenceDeskPortV1 } from '../src/application/ports/person-original-context-retrieval-v1.js';
import { createPersonEvidenceDeskV1 } from '../src/composition/person-evidence-desk-v1.js';
import { createPersonRecordSearchRouteV1, type PersonEvidenceDeskRecordsV1 } from '../src/composition/person-record-search-route.js';
import * as recordHeadReader from '../src/composition/readable-search-generation-reconciler.js';
import { meetingWorld, EMP_A, SHARED } from './fixtures/person-meeting-world.js';
import { COORDINATES, RECORD_POLICY_PROJECTORS, appendInput, database as recordDatabase, protocolAuthority, recordApprovalId } from '../../../packages/organization-record/test/fixtures/record-append-fixture.js';

import { SIGNED_APPROVAL_CODECS, SIGNED_APPROVAL_PROJECTORS, appendSignedApprovalV1 } from './fixtures/signed-approval-decision-v1.js';

const roots: string[] = [];
const closers: (() => void)[] = [];
const digest = (value: string): Sha256Digest => canonicalSha256({ value });
const RETRIEVAL_CONTRACT = digest('evidence-desk-retrieval-contract');
/** The reader every route here authenticates; the fixture record is kept for it alone (Only me). */
const READER = { principal_id: 'principal_reader', membership_id: 'membership_reader' } as const;

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
    record_sha256: input.record_sha256, envelope_sha256: input.envelope_sha256, approval_id: recordApprovalId('approval-1'), atom_id: sha256Digest('atom'), atom_order: 0,
    signal_id_sha256: sha256Digest('signal'), item_kind: 'decision', text, text_sha256: sha256Digest(text),
    policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2, policy_contract_sha256: sha256Digest('restricted-policy'),
    authorization_audit_event_id: 'audit-1', authorization_audit_sequence: 1, authorization_audit_entry_sha256: sha256Digest('audit'),
    provider_action_sha256: sha256Digest('provider'), authorization_proof_sha256: sha256Digest('proof'), reviewer_principal_id: READER.principal_id, reviewer_membership_id: READER.membership_id,
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
    release: { authorization: { principal_id: 'principal_reader', membership_id: 'membership_reader', session_family_id: 'session_reader', checked_at: '2026-09-27T01:00:00.000Z' }, scope: { kind: 'global' as const }, grants_sha256: canonicalSha256([]), released_atoms: [] },
    receipt: digest('empty-original-release'), items: [],
  };
  return {
    deskAuthorize: () => ({ checked_at: '2026-09-27T01:00:00.000Z' }), deskSearch: () => release, deskOpen: () => release, revalidateDeskRelease: () => ({ checked_at: '2026-09-27T01:00:00.000Z' }),
  } as unknown as PersonOriginalContextEvidenceDeskPortV1;
}

function authorityDatabase() {
  const authority = openAuthorityDatabase(':memory:');
  applyAuthorityBaseline(authority);
  authority.prepare("INSERT INTO authority_metadata(singleton,authority_id,organization_id,organization_display_name,descriptor_json,created_at,last_observed_at) VALUES(1,?,?, 'Clean','{}','2026-09-27T00:00:00.000Z','2026-09-27T00:00:00.000Z')").run(COORDINATES.authority_id, COORDINATES.organization_id);
  return authority;
}

/** Builds and warms a one-atom readable-search generation, then publishes its active pointer. */
function publish(authority: ReturnType<typeof openAuthorityDatabase>, state_directory: string, recordAtom: ReadableSearchAtomV1, head = { position: 1, record_sha256: recordAtom.record_sha256 }): void {
  const exact_head = { ...COORDINATES, ...head };
  const built = buildReadableSearchGenerationV1({ ...generation(state_directory, [recordAtom]), exact_head });
  const active = { generation_id: built.manifest.generation_id, manifest_sha256: built.manifest_sha256, retrieval_contract_sha256: RETRIEVAL_CONTRACT, exact_head };
  warmReadableSearchActiveGenerationV1({ state_directory, active_generation: active });
  authority.prepare('INSERT OR REPLACE INTO authority_readable_search_active_generation(singleton,organization_id,generation_id,manifest_sha256,retrieval_contract_sha256,record_head_position,record_head_hash,published_at) VALUES(1,?,?,?,?,?,?,?)').run(COORDINATES.organization_id, active.generation_id, active.manifest_sha256, RETRIEVAL_CONTRACT, head.position, head.record_sha256, '2026-09-27T00:00:00.000Z');
}

async function fixture(options: { readonly active?: boolean; readonly corrupt?: boolean; readonly forged_pointer?: boolean; readonly atom_text?: string; readonly atom_envelope_sha256?: Sha256Digest } = {}) {
  const authority = authorityDatabase();
  const record = recordDatabase();
  closers.push(() => { record.close(); authority.close(); });
  const appended = await new OrganizationRecordAppenderV4(record, COORDINATES, RECORD_POLICY_PROJECTORS).append(appendInput({ authority: protocolAuthority(), reviewer: READER, ...(options.atom_text === undefined ? {} : { decision_text: options.atom_text }) }));
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
    sessions, authority, record, audit: new SqlitePersonRecordReadAuditV1(authority), record_input_codecs: SIGNED_APPROVAL_CODECS,
    ...(options.corrupt ? { search_generation: () => { throw new Error('corrupt readable index'); } } : {}),
  });
  const makeDesk = () => createPersonEvidenceDeskV1({ access_token: 'token', scope: { kind: 'global' }, originals: emptyOriginals(), records: route });
  return { authority, record, route, recordAtom, state_directory, makeDesk, revoke: () => { revoked = true; } };
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
    expect(hit).toMatchObject({ kind: 'decision', text: value.recordAtom.text, visibility: 'approver_only', attributes: { status: 'decided' }, ref: meeting });
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
    await expect(driftedDesk.revalidate({})).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('reports a verified appended head as a snapshot change, but access revocation still wins', async () => {
    const value = await fixture();
    const desk = value.makeDesk();
    await desk.search({ query: 'Decision' });
    await new OrganizationRecordAppenderV4(value.record, COORDINATES, RECORD_POLICY_PROJECTORS).append(appendInput({ authority: protocolAuthority(), reviewer: READER, approval_id: 'approval-2' }));
    await expect(desk.revalidate({})).rejects.toMatchObject({ name: 'PersonRecordSearchSnapshotChangedV1', code: 'unavailable' });
    value.revoke();
    await expect(desk.revalidate({})).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it.each([false, true])('restarts pinned search and list after an append (index published: %s)', async published => {
    const value = await fixture();
    const release = value.route.searchBatch({ access_token: 'token', query: 'Decision' }).release;
    const appended = await new OrganizationRecordAppenderV4(value.record, COORDINATES, RECORD_POLICY_PROJECTORS).append(appendInput({ authority: protocolAuthority(), reviewer: READER, approval_id: 'approval-2' }));
    if (published) publish(value.authority, value.state_directory, value.recordAtom, { position: 2, record_sha256: appended.record_sha256 });
    const input = { access_token: 'token', expected_pointer: release.active_pointer };
    for (const read of [() => value.route.searchBatch({ ...input, query: 'Decision' }), () => value.route.listDeskBatch(input)]) {
      expect(read).toThrow(expect.objectContaining({ name: 'PersonRecordSearchSnapshotChangedV1' }));
    }
    value.revoke();
    expect(() => value.route.searchBatch({ ...input, query: 'Decision' })).toThrow(expect.objectContaining({ code: 'unauthorized' }));
  });

  it('classifies a verified advance observed at the search final fence as retryable', async () => {
    const value = await fixture();
    const before = recordHeadReader.readReadableSearchRecordHeadV1(value.record);
    await new OrganizationRecordAppenderV4(value.record, COORDINATES, RECORD_POLICY_PROJECTORS).append(appendInput({ authority: protocolAuthority(), reviewer: READER, approval_id: 'approval-2' }));
    // The first head read sees the pre-append snapshot; the final fence sees the real new log.
    const read = vi.spyOn(recordHeadReader, 'readReadableSearchRecordHeadV1').mockReturnValueOnce(before);
    try {
      expect(() => value.route.searchBatch({ access_token: 'token', query: 'Decision' })).toThrow(expect.objectContaining({ name: 'PersonRecordSearchSnapshotChangedV1' }));
    } finally { read.mockRestore(); }
  });

  it('does not retry a pinned generation whose identity changed without a verified append', async () => {
    const value = await fixture();
    const release = value.route.searchBatch({ access_token: 'token', query: 'Decision' }).release;
    value.authority.prepare('UPDATE authority_readable_search_active_generation SET manifest_sha256=? WHERE singleton=1').run(digest('unknown-manifest'));
    const input = { access_token: 'token', expected_pointer: release.active_pointer };
    for (const read of [() => value.route.searchBatch({ ...input, query: 'Decision' }), () => value.route.listDeskBatch(input)]) {
      expect(read).toThrow(expect.objectContaining({ name: 'AuthorityOperationError', code: 'unavailable' }));
    }
  });

  it('re-reads only original releases made since its last check in an incremental check, while session and record pins run every time', async () => {
    const value = await fixture();
    const originals = emptyOriginals();
    const empty = originals.deskSearch({ access_token: 'token', scope: { kind: 'global' } });
    const releases = [1, 2].map(index => ({ ...empty, receipt: digest(`original-${index}`) }));
    let next = 0;
    const deskAuthorize = vi.fn(() => ({ checked_at: '2026-09-27T01:00:00.000Z' }));
    const revalidateDeskRelease = vi.fn<PersonOriginalContextEvidenceDeskPortV1['revalidateDeskRelease']>(() => ({ checked_at: '2026-09-27T01:00:00.000Z' }));
    const desk = createPersonEvidenceDeskV1({ access_token: 'token', scope: { kind: 'global' }, records: value.route,
      originals: { ...originals, deskAuthorize, deskSearch: () => releases[next++]!, revalidateDeskRelease } });
    const checks = () => revalidateDeskRelease.mock.calls.splice(0).map(([input]) => [input.release.receipt, input.items_checked === true ? 'pins' : 'items']);
    await desk.search({ query: 'Decision', limit: 10 });
    await desk.revalidate({ mode: 'incremental' });
    expect(checks()).toEqual([[digest('original-1'), 'items']]);
    // A repair with no new evidence re-reads no item.
    await desk.revalidate({ mode: 'incremental' });
    expect(checks()).toEqual([[digest('original-1'), 'pins']]);
    await desk.search({ query: 'Decision', limit: 10 });
    // A failed check fails the same way and leaves the new release pending.
    revalidateDeskRelease.mockImplementationOnce(() => ({ checked_at: '2026-09-27T01:00:00.000Z' }))
      .mockImplementationOnce(() => { throw new AuthorityOperationError('unauthorized', 'person authentication failed'); });
    await expect(desk.revalidate({ mode: 'incremental' })).rejects.toThrow('person authentication failed');
    expect(checks()).toEqual([[digest('original-1'), 'pins'], [digest('original-2'), 'items']]);
    await desk.revalidate({ mode: 'incremental' });
    expect(checks()).toEqual([[digest('original-1'), 'pins'], [digest('original-2'), 'items']]);
    // The full check re-reads every release.
    await desk.revalidate({});
    expect(checks()).toEqual([[digest('original-1'), 'items'], [digest('original-2'), 'items']]);
    expect(deskAuthorize.mock.calls.length).toBeGreaterThanOrEqual(5);
    // The record snapshot pin is checked on an incremental check too.
    value.authority.prepare('UPDATE authority_readable_search_active_generation SET manifest_sha256=? WHERE singleton=1').run(digest('drift'));
    await expect(desk.revalidate({ mode: 'incremental' })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('does not turn a valid release witness into authority for a forged atom anchor', async () => {
    const value = await fixture();
    const batch = value.route.searchBatch({ access_token: 'token', query: 'Decision', desk: true });
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
    // A record's text is released whole: the open says its anchor was not cut (ADR-0041).
    await expect(inventoryDesk.open({ item: item!.id })).resolves.toMatchObject({
      items: [expect.objectContaining({ text: accepted.recordAtom.text })], truncated: false, anchor_truncated: false,
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

describe('Person evidence desk: private items fenced off (ADR-0046)', () => {
  it('never offers what only the reader may see when asked to leave private items out, and offers it otherwise', async () => {
    const value = await fixture();
    const originals = emptyOriginals();
    const original = (visibility: 'only_me' | 'team', name: string) => ({
      kind: 'note' as const, text: `${name} decision`, visibility, label: name, received_at: '2026-09-27T00:00:00.000Z', version: '1', ref: `note:ctx_${name.padEnd(64, 'a')}` as const,
      citation: { kind: 'source_revision' as const, source_id: `source-${name}`, revision_id: `revision-${name}`,
        source_sha256: digest(`source-${name}`), representation_sha256: digest(`representation-${name}`), anchor_sha256: digest(`anchor-${name}`) },
    });
    const release = { ...originals.deskSearch({ access_token: 'token', scope: { kind: 'global' } }), items: [original('only_me', 'private'), original('team', 'shared')], truncated: false };
    // The meeting record as an Only-me one: what its approver alone reads.
    const onlyMe = <T extends { readonly desk_items?: readonly { readonly visibility: string }[] }>(result: T): T =>
      ({ ...result, desk_items: result.desk_items?.map(item => ({ ...item, visibility: 'approver_only' as const })) });
    const searchBatch = (input: Parameters<typeof value.route.searchBatch>[0]) => onlyMe(value.route.searchBatch(input));
    const openDeskCitation = (input: Parameters<typeof value.route.openDeskCitation>[0]) => onlyMe(value.route.openDeskCitation(input));
    const desk = (exclude?: { readonly private: boolean }) => createPersonEvidenceDeskV1({
      access_token: 'token', scope: { kind: 'global' }, originals: { ...originals, deskSearch: () => release }, records: { ...value.route, searchBatch, openDeskCitation },
      ...(exclude === undefined ? {} : { exclude: { records: [], sources: [], ...exclude } }),
    });
    const kinds = async (made: ReturnType<typeof desk>) => (await made.search({ query: 'decision', kinds: ['note', 'decision'] })).items.map(item => `${item.citation.kind}:${item.label}`).sort();
    expect(await kinds(desk({ private: true }))).toEqual(['source_revision:shared']);
    expect(await kinds(desk())).toEqual(['approved_record:Approved meeting', 'source_revision:private', 'source_revision:shared']);
    // Nor is a private record opened by its citation.
    const hit = (await desk().search({ query: 'decision', kinds: ['decision'] })).items.find(item => item.citation.kind === 'approved_record')!;
    expect((await desk({ private: true }).openCitation({ citation: hit.citation as PersonAnswerCitationV3 })).items).toEqual([]);
  });
});

describe('Person evidence desk: exclusions reach each store before its limit', () => {
  it('passes its fenced records, sources and Only-me rule to every search and inventory read, and nothing when it fences nothing', async () => {
    const value = await fixture();
    const originals = emptyOriginals();
    const deskSearch = vi.fn((input: Parameters<typeof originals.deskSearch>[0]) => originals.deskSearch(input));
    const searchBatch = vi.fn((input: Parameters<typeof value.route.searchBatch>[0]) => value.route.searchBatch(input));
    const listDeskBatch = vi.fn((input: Parameters<typeof value.route.listDeskBatch>[0]) => value.route.listDeskBatch(input));
    const sibling = canonicalSha256('a sibling record');
    const make = (exclude?: { readonly records: readonly Sha256Digest[]; readonly sources: readonly string[]; readonly private?: boolean }) => createPersonEvidenceDeskV1({
      access_token: 'token', scope: { kind: 'global' }, originals: { ...originals, deskSearch }, records: { ...value.route, searchBatch, listDeskBatch }, ...(exclude === undefined ? {} : { exclude }),
    });
    const fenced = make({ records: [sibling], sources: ['source-meeting'], private: true });
    await fenced.search({ query: 'Decision' });
    await fenced.search({ limit: 5 });
    const records = { exclude: { record_sha256s: [sibling], approver_only: true } };
    const sources = { exclude: { source_ids: ['source-meeting'], only_me: true } };
    expect(searchBatch).toHaveBeenLastCalledWith(expect.objectContaining(records));
    expect(listDeskBatch).toHaveBeenLastCalledWith(expect.objectContaining(records));
    expect(deskSearch.mock.calls.map(([input]) => input)).toEqual([expect.objectContaining(sources), expect.objectContaining(sources)]);
    // A desk that fences nothing sends no exclusion at all.
    deskSearch.mockClear(); searchBatch.mockClear(); listDeskBatch.mockClear();
    const open = make();
    await open.search({ query: 'Decision' });
    await open.search({ limit: 5 });
    for (const spy of [deskSearch, searchBatch, listDeskBatch]) for (const [input] of spy.mock.calls) expect(input).not.toHaveProperty('exclude');
  });
});

describe('Person evidence desk: one source at a time', () => {
  it('lists meeting records without text, one source only', async () => {
    const value = await fixture();
    const listed = await value.makeDesk().list({ source: 'meeting', kinds: ['decision'] });
    expect(listed.items).toEqual([expect.objectContaining({ kind: 'decision', label: 'Approved meeting' })]);
    expect(listed.items[0]).not.toHaveProperty('text');
    // The inventory reads one row past its limit and says truncated when more exist, so its end is confirmed (ADR-0041).
    expect(listed).toMatchObject({ truncated: false, page_full: false });
  });

  it('names a listed record by a line of its own text in its list label, keeps it when opened, and checks it with the row (ADR-0041)', async () => {
    const value = await fixture();
    const desk = value.makeDesk();
    const listed = await desk.list({ source: 'meeting', kinds: ['decision'] });
    // The row still has no text; its list label is released and audited with it.
    expect(listed.items).toEqual([expect.objectContaining({ kind: 'decision', label: 'Approved meeting', list_label: `${value.recordAtom.text} (Approved meeting)` })]);
    expect(listed.items[0]).not.toHaveProperty('text');
    const opened = await desk.open({ item: listed.items[0]!.id });
    expect(opened.items[0]).toMatchObject({ id: listed.items[0]!.id, text: value.recordAtom.text, list_label: listed.items[0]!.list_label });
    // A revoked release stops the label at the next check, as it stops the row.
    value.revoke();
    await expect(desk.revalidate({})).rejects.toThrow('person authentication failed');
  });
});

describe('Person evidence desk over an approval-decision record with a confirmed owner', () => {
  async function approvedFixture() {
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
    const route = createPersonRecordSearchRouteV1({ state_directory, ...COORDINATES, retrieval_contract_sha256: RETRIEVAL_CONTRACT, sessions: { authenticateAccess: () => ({ ...authorization(), checked_at: new Date(Date.UTC(2026, 8, 27, 1, 0, checks++)).toISOString() }) }, authority, record, audit: new SqlitePersonRecordReadAuditV1(authority), record_input_codecs: SIGNED_APPROVAL_CODECS });
    return createPersonEvidenceDeskV1({ access_token: 'token', scope: { kind: 'global' }, originals: emptyOriginals(), records: route });
  }

  it('reads the confirmed owner from the signed approval, and matches the owned search text exactly', async () => {
    const desk = await approvedFixture();
    const searched = await desk.search({ query: 'Jules', limit: 10 });
    const action = searched.items.find(item => item.citation.kind === 'approved_record');
    expect(action).toMatchObject({ kind: 'action', text: 'Action 1 Owner: Jules.', attributes: { owner: 'Jules' } });
    // Its list label is its own line; the owner is the row's own fact (ADR-0041).
    expect(action!.list_label).toMatch(/^Action 1 \(.+\)$/u);
    expect(action!.list_label).not.toContain('Jules');
  });
});

describe('Person evidence desk: mine (ADR-0024)', () => {
  it('selects action deadlines before the item cap without selecting the meeting day or other actions', async () => {
    const w = await meetingWorld({ extra: [{ name: 'deadlines', approval_id: 'apr_deadlines', projects: [SHARED], final_approver: EMP_A, signals: { decisions: 1, actions: 3 },
      brief: brief => ({ ...brief, meeting: { ...brief.meeting, time: { actual_start_at: '2026-10-01T12:00:00.000Z' } },
        actions: brief.actions.map((action, index) => ({ ...action, text: `Deadline action ${index}`, due_at: index === 2 ? '2026-10-20T12:00:00.000Z' : '2026-10-19T12:00:00.000Z' })) }),
    }] });
    closers.push(w.close);
    const desk = createPersonEvidenceDeskV1({ access_token: 'emp_a', scope: { kind: 'mine' }, originals: emptyOriginals(), records: w.route() });
    const filter = { since: '2026-10-20', until: '2026-10-20', date_field: 'due' as const, time_zone: 'America/Los_Angeles' };
    const page = await desk.list({ source: 'meeting', ...filter, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.attributes?.due_at).toBe('2026-10-20T12:00:00.000Z');
    expect(page.truncated).toBe(false);
    expect((await desk.search({ source: 'meeting', query: 'Deadline', ...filter, limit: 1 })).items[0]?.text).toContain('Deadline action 2');
    await desk.revalidate({});
  });

  it('filters by the meeting date before limiting, without admitting private records or undated meetings', async () => {
    const w = await meetingWorld();
    closers.push(w.close);
    const desk = createPersonEvidenceDeskV1({ access_token: 'emp_a', scope: { kind: 'global' }, originals: emptyOriginals(), records: w.route() });
    const page = await desk.list({ source: 'meeting', since: '2026-08-31', until: '2026-08-31', limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ citation: { record_sha256: w.digest('r1') }, occurred_at: '2026-08-31', date_kind: 'occurred' });
    expect((await desk.list({ source: 'meeting', since: '2026-09-02', until: '2026-09-02' })).items).toEqual([]);
    // Meetings with no recorded time are counted, with the date they do record, never a notice that makes the list unavailable
    // (research tool contract v1): r3, r7a and r7b.
    const emptyDate = await desk.list({ source: 'meeting', since: '2026-10-16', until: '2026-10-16' });
    expect(emptyDate.items).toEqual([]);
    expect(emptyDate).toMatchObject({ unchecked: { count: 3, dates: ['approved'] }, truncated: false });
    expect(emptyDate).not.toHaveProperty('notice');
    const searched = await desk.search({ source: 'meeting', query: 'Decision', since: '2026-10-16', until: '2026-10-16' });
    expect(searched).toMatchObject({ items: [], unchecked: { count: 3, dates: ['approved'] } });
    expect(searched).not.toHaveProperty('notice');
    // Each read says only what it could not test, and a read without dates tests nothing.
    const undated = await desk.list({ source: 'meeting' });
    expect(undated).not.toHaveProperty('notice');
    expect(undated).not.toHaveProperty('unchecked');
    // Their approvals are dates every record has.
    expect((await desk.list({ source: 'meeting', since: '2026-09-07', until: '2026-09-07', date_field: 'approved' })).items.map(item => (item.citation as { record_sha256: string }).record_sha256).sort())
      .toEqual([w.digest('r7a'), w.digest('r7b')].sort());
    expect(await desk.list({ source: 'meeting', since: '2026-09-07', until: '2026-09-07', date_field: 'any' })).not.toHaveProperty('unchecked');
    await desk.revalidate({});
  });

  it('does not disclose missing dates in records outside the caller scope', async () => {
    const w = await meetingWorld();
    closers.push(w.close);
    for (const [access_token, scope] of [['emp_a', { kind: 'mine' as const }]] as const) {
      const desk = createPersonEvidenceDeskV1({ access_token, scope, originals: emptyOriginals(), records: w.route() });
      const listed = await desk.list({ source: 'meeting', since: '2026-10-16', until: '2026-10-16' });
      expect(listed).not.toHaveProperty('notice');
      expect(listed).not.toHaveProperty('unchecked');
    }
  });

  it('sums what both halves of a dated meetings read could not test, and takes each source\'s own dates (research tool contract v1)', async () => {
    const w = await meetingWorld();
    closers.push(w.close);
    const originals = emptyOriginals();
    const deskSearch = vi.fn((input: Parameters<PersonOriginalContextEvidenceDeskPortV1['deskSearch']>[0]) => ({
      ...originals.deskSearch(input), ...(input.since === undefined ? {} : { unchecked: { count: 2, dates: ['occurred', 'received'] as const } }),
    }));
    const desk = createPersonEvidenceDeskV1({ access_token: 'emp_a', scope: { kind: 'global' }, originals: { ...originals, deskSearch }, records: w.route() });
    expect(await desk.list({ source: 'meeting', since: '2026-10-16', until: '2026-10-16', date_field: 'occurred' })).toMatchObject({ items: [], unchecked: { count: 5, dates: ['occurred', 'received', 'approved'] } });
    expect(await desk.search({ source: 'meeting', query: 'Decision', since: '2026-10-16', until: '2026-10-16' })).toMatchObject({ unchecked: { count: 5 } });
    // A document read reads no meeting record, so only its own half counts.
    expect(await desk.list({ source: 'document', since: '2026-10-16', until: '2026-10-16', date_field: 'any' })).toMatchObject({ unchecked: { count: 2, dates: ['occurred', 'received'] } });
    expect(await desk.list({ source: 'meeting' })).not.toHaveProperty('unchecked');
    // Each source takes the dates its capabilities declare; another is refused before either half is read.
    const calls = deskSearch.mock.calls.length;
    await expect(desk.list({ source: 'meeting', since: '2026-10-16', date_field: 'created' })).rejects.toMatchObject({ code: 'invalid_request', message: 'This source supports date_field: occurred, due, received, approved, any' });
    await expect(desk.list({ source: 'document', since: '2026-10-16', date_field: 'occurred' })).rejects.toMatchObject({ code: 'invalid_request', message: 'This source supports date_field: received, any' });
    expect(deskSearch.mock.calls.length).toBe(calls);
    await desk.revalidate({});
  });

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
    const other = route.searchBatch({ access_token: 'emp_a', query: 'Decision', desk: true }).desk_items!.find((item) => item.record_sha256 === w.digest('r1'))!;
    await expect(desk.openCitation({ citation: { kind: 'approved_record', atom_id: other.atom_id, record_sha256: other.record_sha256, policy_id: other.policy_id } as PersonAnswerCitationV3 })).rejects.toMatchObject({ code: 'not_found' });
    await desk.revalidate({});
    expect(new Set(calls.map((call) => call.method))).toEqual(new Set(['initializeDesk', 'searchBatch', 'listDeskBatch', 'openDeskCitation']));
    for (const call of calls) {
      expect(call.input).toMatchObject({ mine: true });
      expect(call.input).not.toHaveProperty('project_id');
    }
  });
});

describe('Person evidence desk: exclusions (an impact run\'s fence, ADR-0046)', () => {
  const SIBLING_SOURCE = `source:${'c'.repeat(64)}`;
  /** Originals with the meeting's own unapproved notes (SIBLING_SOURCE) and an unrelated note. */
  function originalsWith() {
    const base = emptyOriginals();
    const empty = base.deskSearch({ access_token: 'emp_a', scope: { kind: 'global' } });
    const item = (kind: 'note' | 'imported_meeting', source_id: string, ref: string, text: string) => ({
      kind, text, visibility: 'only_me' as const, label: text, received_at: '2026-09-27T00:00:00.000Z', version: '1', ref,
      citation: { kind: 'source_revision' as const, source_id, revision_id: `revision-${text}`, source_sha256: digest(`source ${text}`),
        representation_sha256: digest(`representation ${text}`), anchor_sha256: digest(`anchor ${text}`) },
    });
    const release = { ...empty, truncated: false, items: [
      item('imported_meeting', SIBLING_SOURCE, `imported_meeting:cap_${'d'.repeat(64)}`, 'Own notes decision'),
      item('note', `source:${'e'.repeat(64)}`, `note:ctx_${'f'.repeat(64)}`, 'Unrelated note decision'),
    ] };
    const deskOpen = vi.fn(() => release);
    return { originals: { ...base, deskSearch: () => release, deskOpen } as unknown as PersonOriginalContextEvidenceDeskPortV1, deskOpen };
  }
  const recordsOf = (items: readonly { readonly citation: { readonly kind: string; readonly record_sha256?: string } }[]) =>
    [...new Set(items.flatMap((item) => item.citation.kind === 'approved_record' ? [item.citation.record_sha256!] : []))];

  it('never offers an excluded record or an excluded source, in any read, and refuses a citation of one unread', async () => {
    const w = await meetingWorld();
    closers.push(w.close);
    const route = w.route();
    const opened: string[] = [];
    const records: PersonEvidenceDeskRecordsV1 = { ...route, openDeskCitation(input) { opened.push(input.record_sha256); return route.openDeskCitation(input); } };
    const siblings = [w.digest('r1'), w.digest('r4')];
    // Unfenced, the reader's search finds both records and every original.
    const plain = createPersonEvidenceDeskV1({ access_token: 'emp_a', scope: { kind: 'global' }, originals: originalsWith().originals, records });
    const unfenced = await plain.search({ query: 'Decision' });
    expect(recordsOf(unfenced.items)).toEqual(expect.arrayContaining(siblings));
    expect(unfenced.items.filter((item) => item.citation.kind === 'source_revision')).toHaveLength(2);
    const { originals, deskOpen } = originalsWith();
    const desk = createPersonEvidenceDeskV1({ access_token: 'emp_a', scope: { kind: 'global' }, originals, records, exclude: { records: siblings, sources: [SIBLING_SOURCE] } });
    for (const read of [() => desk.search({ query: 'Decision' }), () => desk.search({}), () => desk.list({ source: 'meeting' })]) {
      const { items } = await read();
      // Other records still come back, but never a sibling or the meeting's own notes.
      expect(recordsOf(items).length).toBeGreaterThan(0);
      expect(recordsOf(items).filter((record) => new Set<string>(siblings).has(record))).toEqual([]);
      expect(items.filter((item) => item.citation.kind === 'source_revision').map((item) => item.ref)).toEqual([`note:ctx_${'f'.repeat(64)}`]);
    }
    // A citation of a sibling or of the meeting's source is refused before either store reads it.
    const sibling = route.searchBatch({ access_token: 'emp_a', query: 'Decision', desk: true }).desk_items!.find((item) => item.record_sha256 === w.digest('r1'))!;
    await expect(desk.openCitation({ citation: { kind: 'approved_record', atom_id: sibling.atom_id, record_sha256: sibling.record_sha256, policy_id: sibling.policy_id } as PersonAnswerCitationV3 }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(desk.openCitation({ citation: { kind: 'source_revision', source_id: SIBLING_SOURCE, revision_id: 'revision-1', source_sha256: digest('s'), representation_sha256: digest('r'), anchor_sha256: digest('a') } as PersonAnswerCitationV3 }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(opened).toEqual([]);
    expect(deskOpen).not.toHaveBeenCalled();
    await desk.revalidate({});
  });
});
