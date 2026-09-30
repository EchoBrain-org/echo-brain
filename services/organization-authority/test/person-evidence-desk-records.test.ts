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
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersonAnswerCitationV3 } from '@echo-brain/organization-api';
import type { PersonSlackMessageV1, PersonSlackReaderV1, PersonSlackReleaseV1 } from '../src/application/ports/person-slack-reader-v1.js';
import { SqlitePersonRecordReadAuditV1 } from '../src/adapters/persistence/sqlite/person-record-read-audit-v1.js';
import type { PersonOriginalContextEvidenceDeskPortV1 } from '../src/application/ports/person-original-context-retrieval-v1.js';
import { createPersonEvidenceDeskV1 } from '../src/composition/person-evidence-desk-v1.js';
import { createPersonRecordSearchRouteV1, type PersonEvidenceDeskRecordsV1 } from '../src/composition/person-record-search-route.js';
import { meetingWorld } from './fixtures/person-meeting-world.js';
import { COORDINATES, appendInput, database as recordDatabase, protocolAuthority } from '../../../packages/organization-record/test/fixtures/record-append-fixture.js';

import { createRecordInputCodecRegistryV4, HUMAN_ACT_RECORD_INPUT_CODEC_V1, type HumanActEventV1 } from '@echo-brain/organization-protocol';
import { createPersonPolicyFactProjectorV2, createRecordPolicyFactProjectorRegistryV1 } from '@echo-brain/organization-record/organization-record-api-v1';
import { approvedDecisionSnapshotV2Sha256 } from '../../../packages/organization-protocol/src/human-act-record-input-v1.js';
import { resolvePinnedOrganizationAuthority } from '../../../packages/organization-protocol/src/authority-descriptor.js';
import { humanAct, processorProvenance, sourceProvenance } from '../../../packages/organization-record/test/fixtures/record-append-fixture.js';
import { PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V2, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V3 } from '../../../providers/slack/server/src/organization-protocol/private-slack-block-approval-record-input-v2.js';
import { createPrivateSlackBlockApprovalPolicyProjectorV2, createPrivateSlackBlockApprovalPolicyProjectorV3 } from '../../../providers/slack/server/src/organization-record/adapters/record-policy-projection/slack/private-slack-block-approval-policy-projector-v2.js';
import { privateApprovalResolutionV3, resolvePrivateApprovalPolicyV2 } from '../../../providers/slack/server/src/organization-control-plane/application/slack/private-approval-policy-resolution-v2.js';
import { createPrivateSlackBlockV4RecordWriterV1 } from '../../../providers/slack/server/src/processing/adapters/approval-resolution/slack/private-slack-block-v4-record-writer-v1.js';

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

async function fixture(options: { readonly active?: boolean; readonly corrupt?: boolean; readonly forged_pointer?: boolean; readonly atom_text?: string; readonly atom_envelope_sha256?: Sha256Digest } = {}) {
  const authority = openAuthorityDatabase(':memory:');
  applyAuthorityBaselineV10(authority);
  authority.prepare("INSERT INTO authority_metadata(singleton,authority_id,organization_id,organization_display_name,descriptor_json,created_at,last_observed_at) VALUES(1,?,?, 'Clean','{}','2026-09-27T00:00:00.000Z','2026-09-27T00:00:00.000Z')").run(COORDINATES.authority_id, COORDINATES.organization_id);
  const record = recordDatabase();
  const appended = await new OrganizationRecordAppenderV4(record, COORDINATES).append(appendInput({ authority: protocolAuthority(), policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, ...(options.atom_text === undefined ? {} : { decision_text: options.atom_text }) }));
  const state_directory = stateRoot();
  const recordAtom = atom({ ...appended, envelope_sha256: options.atom_envelope_sha256 ?? appended.envelope_sha256 }, options.atom_text);
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
  const makeDesk = (slack?: Parameters<typeof createPersonEvidenceDeskV1>[0]['slack'], now_ms?: () => number) => createPersonEvidenceDeskV1({ access_token: 'token', scope: { kind: 'global' }, originals: emptyOriginals(), records: route, ...(slack === undefined ? {} : { slack }), ...(now_ms === undefined ? {} : { now_ms }) });
  return { authority, record, route, recordAtom, makeDesk, revoke: () => { revoked = true; }, close: () => { record.close(); authority.close(); } };
}

describe('Person evidence desk over the real approved-record route', () => {
  it.each([
    { kind: 'note', includeRecords: false },
    { kind: 'document_passage', includeRecords: false },
    { kind: 'note', includeRecords: true },
  ] as const)('searches $kind evidence with record kinds requested: $includeRecords', async ({ kind, includeRecords }) => {
    const value = await fixture();
    try {
      const originals = emptyOriginals();
      const release = {
        ...originals.deskSearch({ access_token: 'token', scope: { kind: 'global' } }),
        items: [{
          kind, text: 'Decision from the original', visibility: 'team' as const, label: 'Original decision',
          received_at: '2026-09-27T00:00:00.000Z', version: '1',
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
      expect(searched.items[0]).toMatchObject({ text: 'Decision from the original', receipt_sha256: release.receipt });
      expect(searched.receipt_digests).toContain(release.receipt);
      if (includeRecords) expect(searchBatch).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['decision'] }));
      else expect(searchBatch).not.toHaveBeenCalled();
      await desk.revalidate({});
    } finally { value.close(); }
  });

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
      const opened = await fresh.openCitation({ citation: hit!.citation as PersonAnswerCitationV3 });
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

  it('does not turn a valid release witness into authority for a forged atom anchor', async () => {
    const value = await fixture();
    try {
      const batch = value.route.searchBatch({ access_token: 'token', queries: ['Decision'], desk: true });
      const anchor = batch.desk_items![0]!;
      expect(() => value.route.openDeskBatch({
        access_token: 'token',
        release: batch.release,
        anchor: { ...anchor, atom_id: digest('forged-record-atom') },
      })).toThrow('exact-head readable-search generation is not available');
    } finally { value.close(); }
  });

  it('keeps a 3,072-byte record atom, but omits 3,073- and 4,096-byte atoms with truncation', async () => {
    const accepted = await fixture({ atom_text: `Decision ${'x '.repeat(1_532).slice(0, 3_063)}` });
    try {
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
    } finally { accepted.close(); }

    for (const bytes of [3_073, 4_096]) {
      const value = await fixture({ atom_text: `Decision ${'x '.repeat(2_100).slice(0, bytes - 9)}` });
      try {
        expect(Buffer.byteLength(value.recordAtom.text, 'utf8')).toBe(bytes);
        const result = await value.makeDesk().search({ query: 'Decision', limit: 10 });
        expect(result.items.filter(item => item.citation.kind === 'approved_record')).toEqual([]);
        expect(result.truncated).toBe(true);
      } finally { value.close(); }
    }
  });

  it('writes one final record-read audit for a fresh citation open', async () => {
    const value = await fixture();
    try {
      const desk = value.makeDesk();
      const searched = await desk.search({ query: 'Decision', limit: 10 });
      const citation = searched.items.find(item => item.citation.kind === 'approved_record')!.citation;
      if (citation.kind !== 'approved_record') throw new Error('missing record citation');
      const count = () => (value.authority.prepare("SELECT count(*) AS n FROM authority_person_read_decision_audit_v2 WHERE context_kind='record_read'").get() as { readonly n: number }).n;
      const before = count();
      await desk.openCitation({ citation });
      expect(count()).toBe(before + 1);
    } finally { value.close(); }
  });

  it('fails closed when raw-record metadata no longer binds the warmed envelope', async () => {
    const value = await fixture({ atom_envelope_sha256: digest('corrupt-envelope') });
    try {
      await expect(value.makeDesk().search({ query: 'Decision', limit: 10 })).rejects.toThrow('record evidence metadata is unavailable');
    } finally { value.close(); }
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

function slackMessage(ts: string, text: string, options: Partial<PersonSlackMessageV1> = {}): PersonSlackMessageV1 {
  return { team_id: 'T0001', channel_id: 'C0001', channel_name: 'hw-dvt', channel_kind: 'public_channel', message_ts: ts, author: 'Priya', text, permalink: `https://acme.slack.com/archives/C0001/p${ts.replace('.', '')}`, ...options };
}

function fakeSlack(input: { search?: readonly PersonSlackMessageV1[] | Error; thread?: readonly PersonSlackMessageV1[]; history?: { found: boolean; messages: readonly PersonSlackMessageV1[]; next_cursor?: string }; check?: () => void } = {}) {
  const releases: PersonSlackReleaseV1[] = [];
  const reader: PersonSlackReaderV1 & { [K in keyof PersonSlackReaderV1]: ReturnType<typeof vi.fn> } = {
    search: vi.fn(async () => { if (input.search instanceof Error) throw input.search; return input.search ?? []; }),
    thread: vi.fn(async () => ({ messages: input.thread ?? [], truncated: false })),
    history: vi.fn(async () => input.history ?? { found: true, messages: [] }),
    check: vi.fn(async () => { input.check?.(); }),
  } as never;
  const audit = { record: vi.fn((release: PersonSlackReleaseV1) => { releases.push(release); return canonicalSha256({ slack_release: releases.length }); }) };
  return { reader, audit, releases, slack: { reader, audit } };
}

describe('Person evidence desk: live Slack (RFC-0003)', () => {
  it('searches Slack beside Echo, labels and scopes each message, and audits digests only', async () => {
    const value = await fixture();
    try {
      const thread = Array.from({ length: 5 }, (_, index) => slackMessage(`1758873600.00010${index}`, `Fixture thread message ${index}`, { thread_ts: '1758873600.000100' }));
      const dm = slackMessage('1758877200.000200', 'Vendor says fixtures may slip to Oct 16.', { channel_id: 'D0002', channel_name: 'Dana', channel_kind: 'im', permalink: 'https://acme.slack.com/archives/D0002/p1758877200000200' });
      const slack = fakeSlack({ search: [...thread, dm] });
      const desk = value.makeDesk(slack.slack);
      const searched = await desk.search({ query: 'Decision', limit: 8 });
      const slackItems = searched.items.filter(item => item.kind === 'slack_message');
      // At most three messages from one thread, interleaved after Echo's own results.
      expect(slackItems.filter(item => item.citation.kind === 'slack_message' && item.citation.channel_id === 'C0001')).toHaveLength(3);
      expect(searched.items[0]!.kind).toBe('decision');
      const direct = slackItems.find(item => item.citation.kind === 'slack_message' && item.citation.channel_id === 'D0002');
      expect(direct).toMatchObject({ label: 'DM with Dana · Priya · 2025-09-26', visibility: 'only_me', occurred_at: '2025-09-26', text: dm.text, citation: { kind: 'slack_message', team_id: 'T0001', message_ts: dm.message_ts, permalink: dm.permalink } });
      expect(slackItems[0]).toMatchObject({ visibility: 'team', label: expect.stringMatching(/^#hw-dvt · Priya · /u) });
      expect(slack.releases).toHaveLength(1);
      expect(JSON.stringify(slack.releases)).not.toContain('Vendor says');
      expect(slack.releases[0]!.messages).toHaveLength(4);
      expect(searched.receipt_digests).toContain(canonicalSha256({ slack_release: 1 }));
      expect(slackItems.every(item => item.receipt_sha256 === canonicalSha256({ slack_release: 1 }))).toBe(true);
    } finally { value.close(); }
  });

  it('keeps answering from Echo when Slack search fails, with a notice', async () => {
    const value = await fixture();
    try {
      const slack = fakeSlack({ search: new Error('rate limited') });
      const searched = await value.makeDesk(slack.slack).search({ query: 'Decision', limit: 8 });
      expect(searched.items.some(item => item.kind === 'decision')).toBe(true);
      expect(searched.notice).toContain('Slack could not be searched');
    } finally { value.close(); }
  });

  it('opens a Slack message as its thread, anchor first, and audits the thread release', async () => {
    const value = await fixture();
    try {
      const parent = slackMessage('1758873600.000100', 'Can we start DVT with 2 of 4 fixtures?', { thread_ts: '1758873600.000100', reply_count: 1 });
      const reply = slackMessage('1758873700.000100', 'Only if QA signs off.', { thread_ts: '1758873600.000100', author: 'Marco' });
      const slack = fakeSlack({ search: [reply], thread: [parent, reply] });
      const desk = value.makeDesk(slack.slack);
      const hit = (await desk.search({ query: 'Decision', limit: 8 })).items.find(item => item.kind === 'slack_message')!;
      const opened = await desk.open({ item: hit.id });
      expect(slack.reader.thread).toHaveBeenCalledWith(expect.objectContaining({ channel_id: 'C0001', thread_ts: '1758873600.000100', limit: 21 }));
      expect(opened.items.map(item => item.text)).toEqual(['Only if QA signs off.', 'Can we start DVT with 2 of 4 fixtures?']);
      expect(opened.items[1]!.label).toContain('#hw-dvt · Priya');
      expect(slack.releases.map(release => release.operation)).toEqual(['search', 'thread']);
    } finally { value.close(); }
  });

  it('lists a Slack channel by name within dates, and refuses a channel the asker cannot see', async () => {
    const value = await fixture();
    try {
      const slack = fakeSlack({ history: { found: true, messages: [slackMessage('1758873600.000100', 'Status: fixtures on track.')], next_cursor: 'next' } });
      const desk = value.makeDesk(slack.slack);
      const listed = await desk.list({ source: 'slack', channel: 'hw-dvt', since: '2025-09-20', until: '2025-09-27', limit: 50 });
      expect(slack.reader.history).toHaveBeenCalledWith(expect.objectContaining({ channel: 'hw-dvt', oldest: `${Date.parse('2025-09-20T00:00:00Z') / 1000}.000000`, latest: `${Date.parse('2025-09-27T00:00:00Z') / 1000 + 86_399}.000000`, limit: 50 }));
      expect(listed).toMatchObject({ next_cursor: 'next', items: [{ kind: 'slack_message', text: 'Status: fixtures on track.' }] });
      const hidden = fakeSlack({ history: { found: false, messages: [] } });
      await expect(value.makeDesk(hidden.slack).list({ source: 'slack', channel: 'secret' })).rejects.toMatchObject({ code: 'invalid_request' });
    } finally { value.close(); }
  });

  it('lists meeting records without text, one source only', async () => {
    const value = await fixture();
    try {
      const listed = await value.makeDesk().list({ source: 'meeting', kinds: ['decision'] });
      expect(listed.items).toEqual([expect.objectContaining({ kind: 'decision', label: 'Approved meeting' })]);
      expect(listed.items[0]).not.toHaveProperty('text');
      expect((await value.makeDesk().list({ source: 'slack', channel: 'hw-dvt' })).items).toEqual([]);
    } finally { value.close(); }
  });

  it('checks the Slack connection before model calls once Slack was read, at most every 30 s', async () => {
    const value = await fixture();
    try {
      let clock = 0; let revoked = false;
      const slack = fakeSlack({ search: [slackMessage('1758873600.000100', 'hello')], check: () => { if (revoked) throw new AuthorityOperationError('unauthorized', 'Slack disconnected'); } });
      const desk = value.makeDesk(slack.slack, () => clock);
      await desk.revalidate({});
      expect(slack.reader.check).not.toHaveBeenCalled();
      await desk.search({ query: 'Decision', limit: 8 });
      await desk.revalidate({}); clock = 10_000; await desk.revalidate({});
      expect(slack.reader.check).toHaveBeenCalledTimes(1);
      clock = 40_000; revoked = true;
      await expect(desk.revalidate({})).rejects.toThrow('Slack disconnected');
    } finally { value.close(); }
  });
});

describe('Person evidence desk over a Slack-approved record with a confirmed owner', () => {
  const codecs = createRecordInputCodecRegistryV4([HUMAN_ACT_RECORD_INPUT_CODEC_V1, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V2, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V3]);
  async function slackFixture(withCodecs: boolean) {
    const authority = openAuthorityDatabase(':memory:');
    applyAuthorityBaselineV10(authority);
    authority.prepare("INSERT INTO authority_metadata(singleton,authority_id,organization_id,organization_display_name,descriptor_json,created_at,last_observed_at) VALUES(1,?,?, 'Clean','{}','2026-09-27T00:00:00.000Z','2026-09-27T00:00:00.000Z')").run(COORDINATES.authority_id, COORDINATES.organization_id);
    const record = recordDatabase();
    const signer = protocolAuthority();
    const approval_id = 'apr_desk_owner_v3';
    const snapshot = (humanAct(approval_id, 'approve', ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, 1, { decisions: 1, actions: 2 }).event as Extract<HumanActEventV1, { kind: 'approved' }>).approved_snapshot;
    const approved_snapshot_sha256 = approvedDecisionSnapshotV2Sha256(snapshot);
    const owner = { principal_id: 'principal-owner', membership_id: 'membership-owner' };
    const link = { provider: 'slack' as const, external_identity_link_id: 'clm_desk_owner', external_identity_link_contract_sha256: sha256Digest('link'), provider_subject_id: 'U123' };
    const transcript_source = { source_id: 'source_desk_owner', revision_id: 'revision_desk_owner', source_sha256: sha256Digest('source') };
    const pending = { schema_version: 2 as const, kind: 'echo-private-approval-pending-v2' as const, approval_id, organization_id: COORDINATES.organization_id, candidate_sha256: sha256Digest('candidate'), frozen_card_sha256: sha256Digest('card'), approved_snapshot_sha256, assigned_owner: owner, assigned_owner_slack_identity_link: link, eligible_projects: [], transcript_source };
    const allow = { schema_version: 2 as const, kind: 'echo-private-approval-authorization-allow-v2' as const, approval_id, organization_id: COORDINATES.organization_id, candidate_sha256: pending.candidate_sha256, frozen_card_sha256: pending.frozen_card_sha256, approved_snapshot_sha256, authorized_assignee: owner, current_slack_identity_link: link, authorization_proof_sha256: sha256Digest('proof') };
    const v2 = resolvePrivateApprovalPolicyV2({ pending, command: { schema_version: 2, command_id: 'command-desk-owner', approval_id, action: 'approve', selected_policy_id: 'organization-member-readable-person-v2', selected_project_ids: [], share_transcript: false, comment: null }, authorization_allow: allow, selected_projects_current: [] });
    const projectors = createRecordPolicyFactProjectorRegistryV1([createPersonPolicyFactProjectorV2(), createPrivateSlackBlockApprovalPolicyProjectorV2(), createPrivateSlackBlockApprovalPolicyProjectorV3()]);
    const writer = await createPrivateSlackBlockV4RecordWriterV1({ append: new OrganizationRecordAppenderV4(record, COORDINATES, projectors), signer: { inspect: async () => resolvePinnedOrganizationAuthority(signer.pinned), sign: signer.sign }, state_lineage_id: COORDINATES.state_lineage_id, now: () => '2026-09-27T00:00:00.000Z', next_envelope_id: () => 'envelope-desk-owner' });
    const appended = await writer.appendApprovedV2({ outcome: 'approved', signed_action_receipt_sha256: sha256Digest('signed'), resolution: privateApprovalResolutionV3(v2, [{ action_index: 1, owner: 'Jules' }]), audit: { audit_event_id: 'audit-desk-owner', audit_sequence: 1, approval_id, outcome: 'approved' } },
      { ...COORDINATES, approval_id, candidate_sha256: pending.candidate_sha256, frozen_card_sha256: pending.frozen_card_sha256, approved_snapshot: snapshot, approved_snapshot_sha256, source_provenance: sourceProvenance(), processor_provenance: processorProvenance() });
    const row = record.prepare('SELECT record_sha256, envelope_sha256 FROM organization_record_log WHERE position = 1').get() as { record_sha256: Sha256Digest; envelope_sha256: Sha256Digest };
    expect(appended).toMatchObject({ outcome: 'appended' });
    const text = 'Action 1 Owner: Jules.';
    const recordAtom = { ...atom(row, text), approval_id, atom_order: 2, item_kind: 'action' as const, atom_id: sha256Digest('owner-atom'), signal_id_sha256: sha256Digest(`action-${approval_id}-1`) };
    let checks = 0;
    const state_directory = stateRoot();
    const built = buildReadableSearchGenerationV1(generation(state_directory, [recordAtom]));
    const active = { generation_id: built.manifest.generation_id, manifest_sha256: built.manifest_sha256, retrieval_contract_sha256: RETRIEVAL_CONTRACT, exact_head: { ...COORDINATES, position: 1, record_sha256: row.record_sha256 } };
    warmReadableSearchActiveGenerationV1({ state_directory, active_generation: active });
    authority.prepare('INSERT INTO authority_readable_search_active_generation(singleton,organization_id,generation_id,manifest_sha256,retrieval_contract_sha256,record_head_position,record_head_hash,published_at) VALUES(1,?,?,?,?,?,?,?)').run(COORDINATES.organization_id, active.generation_id, active.manifest_sha256, RETRIEVAL_CONTRACT, 1, row.record_sha256, '2026-09-27T00:00:00.000Z');
    const route = createPersonRecordSearchRouteV1({ state_directory, ...COORDINATES, retrieval_contract_sha256: RETRIEVAL_CONTRACT, sessions: { authenticateAccess: () => ({ ...authorization(), checked_at: new Date(Date.UTC(2026, 8, 27, 1, 0, checks++)).toISOString() }) }, authority, record, audit: new SqlitePersonRecordReadAuditV1(authority), expand_related_atoms: expandReadableSearchRelatedAtomsV1, ...(withCodecs ? { record_input_codecs: codecs } : {}) });
    const desk = createPersonEvidenceDeskV1({ access_token: 'token', scope: { kind: 'global' }, originals: emptyOriginals(), records: route });
    return { desk, close: () => { record.close(); authority.close(); } };
  }

  it('reads the confirmed owner from the signed approval, and matches the owned search text exactly', async () => {
    const value = await slackFixture(true);
    try {
      const searched = await value.desk.search({ query: 'Jules', limit: 10 });
      expect(searched.items.find(item => item.citation.kind === 'approved_record')).toMatchObject({ kind: 'action', text: 'Action 1 Owner: Jules.', attributes: { owner: 'Jules' } });
    } finally { value.close(); }
  });

  it('needs the Authority record codecs to read a Slack-approved record at all', async () => {
    const value = await slackFixture(false);
    try {
      await expect(value.desk.search({ query: 'Jules', limit: 10 })).rejects.toMatchObject({ code: 'unavailable' });
    } finally { value.close(); }
  });
});

describe('Person evidence desk: mine (ADR-0024)', () => {
  it('passes mine, never a project, to every record call, and returns only the caller\'s own approvals', async () => {
    const w = await meetingWorld();
    try {
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
    } finally { w.close(); }
  });
});

describe('Person evidence desk: refs (ADR-0024)', () => {
  it('gives record items their meeting ref, keeps each original item\'s store ref, and gives Slack items none', async () => {
    const value = await fixture();
    try {
      const originals = emptyOriginals();
      const ref = `note:ctx_${'a'.repeat(64)}` as const;
      const release = {
        ...originals.deskSearch({ access_token: 'token', scope: { kind: 'global' } }),
        items: [{
          kind: 'note' as const, text: 'Decision from the original', visibility: 'team' as const, label: 'Original decision',
          received_at: '2026-09-27T00:00:00.000Z', version: '1', ref,
          citation: { kind: 'source_revision' as const, source_id: 'source-original', revision_id: 'revision-original',
            source_sha256: digest('source'), representation_sha256: digest('representation'), anchor_sha256: digest('anchor') },
        }],
        truncated: false,
      };
      const slack = fakeSlack({ search: [slackMessage('1758873600.000100', 'Decision in Slack')] });
      const desk = createPersonEvidenceDeskV1({ access_token: 'token', scope: { kind: 'global' }, originals: { ...originals, deskSearch: () => release }, records: value.route, slack: slack.slack });
      const meeting = `meeting:${value.recordAtom.record_sha256}`;
      const searched = await desk.search({ query: 'Decision', limit: 10 });
      expect(searched.items.map((item) => [item.citation.kind, item.ref])).toEqual([
        ['source_revision', ref], ['approved_record', meeting], ['slack_message', undefined],
      ]);
      expect(searched.items.find((item) => item.kind === 'slack_message')).not.toHaveProperty('ref');
      // Inventory items, opened items and fresh citation opens carry the same ref.
      const inventoryDesk = value.makeDesk();
      const listed = (await inventoryDesk.search({ limit: 10 })).items.find((item) => item.citation.kind === 'approved_record')!;
      expect(listed.ref).toBe(meeting);
      expect((await inventoryDesk.open({ item: listed.id })).items[0]!.ref).toBe(meeting);
      const opened = await value.makeDesk().openCitation({ citation: listed.citation as PersonAnswerCitationV3 });
      expect(opened.items.map((item) => item.ref)).toEqual([meeting]);
    } finally { value.close(); }
  });
});
