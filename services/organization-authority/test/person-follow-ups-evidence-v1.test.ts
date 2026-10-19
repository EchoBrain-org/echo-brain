import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { impactItemKeyV1 } from '@echo-brain/organization-authority-kernel/answer-composition/renderers/impact-card-storage-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { EvidenceDeskPortV1, EvidenceDeskResultV1 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v1';
import type { EvidenceDeskPortV2, EvidenceDeskResultV2 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
import { FOLLOW_UPS_SOURCE_DESCRIPTOR_V1 } from '@echo-brain/organization-authority-kernel/shared/follow-up-evidence-v1';
import type { PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { SqlitePersonAgenticAskAuditV1 } from '../src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.js';
import { createPersonFollowUpsEvidenceSourceV1 } from '../src/composition/person-follow-ups-evidence-v1.js';
import { PersonRecordSearchIndexLagV1 } from '../src/composition/person-record-search-route.js';
import { JIRA_LIVE_CONNECTOR_V1 } from '../src/composition/person-live-connector-registry-v1.js';
import { createRegisteredPersonLiveEvidenceDeskV2 } from '../src/composition/person-live-evidence-desk-v2.js';
import { openItemViewerV1 } from '../src/composition/person-open-items-v1.js';
import { CLOUD, assign, openItemsFixture, sentFixture, setState, type FixturePerson, type OpenItemsFixtureV1 } from './fixtures/open-items.js';

const GLOBAL = Object.freeze({ kind: 'global' as const });
const empty: EvidenceDeskResultV1 = Object.freeze({ items: [], truncated: false, receipt_digests: [] });
type Scope = { readonly kind: 'global' } | { readonly kind: 'project'; readonly project_id: `prj_${string}` };

/**
 * One Ask's desk for `name` over the open-items fixture (ADR-0040): ECHO's
 * desk opens records, Jira opens tickets, both as the fixture's fake desk
 * would for that person, and follow-ups read through this same desk.
 */
function askDesk(f: OpenItemsFixtureV1, name: FixturePerson, options: { readonly scope?: Scope; readonly followUps?: boolean } = {}) {
  const scope = options.scope ?? GLOBAL;
  const sessions = f.openItemsOptions.sessions;
  const authenticate = () => sessions.authenticateAccess({ access_token: name });
  const viewer = openItemViewerV1(name, authenticate());
  const request_id = `ask_${randomUUID()}`;
  const audit = new SqlitePersonAgenticAskAuditV1(f.db).forFollowUpRequest({
    authority_id: 'authority', organization_id: viewer.organization, state_lineage_id: 'lineage', principal_id: viewer.principal,
    membership_id: viewer.membership, session_family_id: viewer.authorization.session_family_id, request_id,
  });
  const open = ({ citation }: { readonly citation: unknown }) => f.openCitation(name, citation as never) as Promise<EvidenceDeskResultV2>;
  const base = {
    scope, search: vi.fn(async () => empty), list: vi.fn(async () => empty), open: vi.fn(async () => empty),
    revalidate: vi.fn(async () => ({ checked_at: f.clock().toISOString() })), openCitation: vi.fn(open),
  } satisfies EvidenceDeskPortV1 & { openCitation: unknown };
  const jira: PersonLiveEvidenceSourceV1 = {
    tool_id: 'jira', search: vi.fn(async () => empty as never), open: vi.fn(async () => empty as never), list: vi.fn(async () => empty as never),
    openCitation: vi.fn(open as never), revalidate: vi.fn(async () => {}), assertCurrent: vi.fn(() => {}),
  };
  const sources = { runs: f.runs, items: f.items, people: f.directory, records: f.records, on_live_failure: () => {} };
  const desk = createRegisteredPersonLiveEvidenceDeskV2(base, [{ descriptor: JIRA_LIVE_CONNECTOR_V1.descriptor, source: jira, scope }],
    options.followUps === false ? undefined : live => createPersonFollowUpsEvidenceSourceV1({ sources, viewer, authenticate, scope, desk: live, audit }));
  const audits = () => (f.db.prepare("SELECT row_sha256, body_json FROM authority_person_read_decision_audit_v2 WHERE context_kind = 'answer_composition'").all() as { row_sha256: string; body_json: string }[])
    .map(row => ({ row_sha256: row.row_sha256, body: JSON.parse(row.body_json) as Record<string, unknown> }))
    .filter(row => row.body.kind === 'echo-person-follow-up-release-audit-v1' && row.body.request_id === request_id)
    .sort((left, right) => (left.body.release_sequence as number) - (right.body.release_sequence as number));
  return { desk, base, jira, audits };
}
const search = (desk: EvidenceDeskPortV2, query: string, extra: Record<string, unknown> = {}) => desk.search({ source: 'follow_ups', kinds: ['follow_up'], query, limit: 8, ...extra });
const list = (desk: EvidenceDeskPortV2, extra: Record<string, unknown> = {}) => desk.list({ source: 'follow_ups', limit: 50, ...extra });
const titles = (result: EvidenceDeskResultV2) => result.items.map(item => item.label).sort();
const ACROSS = 'Follow-ups are found by a ticket key only when follow_ups is searched on its own.';
const CAPPED = 'This request has read as many follow-up items as it can, so a ticket key may not find every follow-up.';
/** Rows straight into the store, for the fixture's one decision: every decision reader sees them, nobody else does. */
function insertRows(f: OpenItemsFixtureV1, count: number, expected = 'launch next week', from = 0) {
  const run = f.runs.read(f.person, f.runId)!;
  f.db.transaction(() => f.items.insertForRun(f.db, run, Array.from({ length: count }, (_, offset) => from + offset).map(index => ({
    item_key: canonicalSha256(`extra ${index}`), relation: 'conflicts' as const, expected, owner_membership_id: f.membership('ari'), owner_match: 'approver' as const,
    pointer: { kind: 'ticket', tool_id: 'jira', external_scope_id: CLOUD, ticket_id: String(20_000 + index), permalink: `https://echo-fixture.atlassian.net/browse/ECHO-${100 + index}`, text_sha256: canonicalSha256(`extra text ${index}`) },
  }))))();
}
function leaveProject(f: OpenItemsFixtureV1, name: FixturePerson) {
  f.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked', revoked_at=? WHERE project_id=? AND membership_id=? AND status='active'")
    .run(f.clock().toISOString(), f.projectA, f.membership(name));
}

describe('follow-ups as an Ask source: what a search finds (ADR-0040)', () => {
  it("matches the decision, the expected phrase, the owner and a ticket's key, and reads each hit's title live once", async () => {
    const f = await sentFixture();
    const { desk } = askDesk(f, 'mina');
    const found = await search(desk, 'Pilot planning');
    expect(titles(found)).toEqual([`ECHO-12 ${f.outsideText}`, 'Thermostat rollout plan'].sort());
    const ticket = found.items.find(item => item.label.startsWith('ECHO-12'))!;
    expect(ticket).toEqual({
      id: `follow_up_${f.ticket.item_id}`, kind: 'follow_up', source_id: 'follow_ups',
      citation: { kind: 'follow_up', item_id: f.ticket.item_id }, ref: `follow_up:${f.ticket.item_id}`, label: `ECHO-12 ${f.outsideText}`,
      attributes: { owner: 'Mina Patel', status: 'open', due_at: '2026-10-30' },
      // ECHO's own dates, and links to its decision's items and the ticket it follows (research tool contract v1).
      dates: { created: f.ticket.created_at, sent: f.ticket.sent_at },
      links: { decision: ['desk-decision'], follows: ['desk-ticket'] },
      text: 'On: ticket\nExpected: launch next week\nLatest check: none yet\nDecision: Pilot planning\nDecided: The pilot starts next week.',
      // Its title is the asker's own Jira read, so it is no wider than that read.
      visibility: 'only_me', receipt_sha256: found.receipt_digests[0],
    });
    // The other decision's action, read live through ECHO's own desk, keeps the decision's audience.
    expect(found.items.find(item => item.label === 'Thermostat rollout plan')).toMatchObject({ attributes: { owner: 'Ari', status: 'open' }, visibility: 'project' });
    expect(titles(await search(desk, 'launch'))).toEqual([`ECHO-12 ${f.outsideText}`]);
    expect(titles(await search(desk, 'mina'))).toEqual([`ECHO-12 ${f.outsideText}`]);
    expect(titles(await search(desk, 'ECHO-12'))).toEqual([`ECHO-12 ${f.outsideText}`]);
    expect(titles(await search(desk, 'ari'))).toEqual(['Thermostat rollout plan']);             // its owner, the approver ECHO fell back to
    // Each tool item read once in the request, however many searches return it, and their one decision once.
    expect(f.opened.filter(open => open.token === 'mina').map(open => open.kind).sort()).toEqual(['approved_record', 'approved_record', 'ticket']);
  });

  it('never matches words read from a tool, nor a page pointer', async () => {
    const f = await sentFixture();
    const { desk } = askDesk(f, 'mina');
    // The ticket's live title and text say "Kestrel cooling fan drift"; ECHO holds none of those words.
    // The rollout's live text says "after the freeze"; that is a tool read too.
    for (const query of ['Kestrel', 'cooling fan drift', '0xC0FFEE', 'freeze', 'Oct 30', 'In Progress']) expect((await search(desk, query)).items).toEqual([]);
    // A page's pointer is never read for words.
    expect((await search(desk, 'Thermostat PRD')).items).toEqual([]);
  });

  it("never finds a follow-up the policy hides, by any word, and hidden rows change no count or truncation", async () => {
    const f = await sentFixture({ ticketOwner: 'okafor' });
    insertRows(f, 53);
    const okafor = askDesk(f, 'okafor').desk;
    // S. Okafor owns the ticket, sent to him, and reads no decision: his row alone, without its decision.
    const found = await search(okafor, 'launch');
    expect(found.items).toHaveLength(1);
    expect(found.truncated).toBe(false);
    expect(found.items[0]).toMatchObject({ attributes: { owner: 'S. Okafor', status: 'open' }, visibility: 'only_me' });
    expect(found.items[0]!.text).toBe('On: ticket\nExpected: launch next week\nLatest check: none yet');
    // Decision words do not find his item, and nothing names the decision.
    for (const query of ['Pilot planning', 'starts', 'rollout', 'Ari']) expect((await search(okafor, query)).items).toEqual([]);
    const listed = await list(okafor);
    expect(listed.items).toHaveLength(1);
    expect(listed).toMatchObject({ truncated: false });
    expect(listed).not.toHaveProperty('next_cursor');
    expect(JSON.stringify([found, listed])).not.toMatch(/Pilot planning|The pilot starts next week|meeting:sha256/);
    // A reader of the decision sees every one of them, five hits at a time.
    const mina = await search(askDesk(f, 'mina').desk, 'launch');
    expect(mina.items).toHaveLength(5);
    expect(mina.truncated).toBe(true);
  });

  it('releases a match on a ticket key alone only when the live read opened it', async () => {
    const f = await sentFixture();
    // The desk refuses Rafael the ticket: its key finds nothing, and says nothing of a hit.
    const rafael = askDesk(f, 'rafael').desk;
    expect(await search(rafael, 'ECHO-12')).toMatchObject({ items: [], truncated: false });
    // Found by ECHO's words instead, with ECHO's phrase as its title and no tool words.
    const found = await search(rafael, 'launch');
    expect(found.items[0]).toMatchObject({ label: 'launch next week', attributes: { owner: 'Mina Patel', status: 'open' }, visibility: 'project' });
    expect(found.items[0]!.attributes).not.toHaveProperty('due_at');
    expect(found.items[0]!.text).not.toContain('Expected:');
    expect(JSON.stringify(found)).not.toMatch(/ECHO-12|Kestrel|2026-10-30/);
    // An outage is not an opened item either.
    const down = await sentFixture({ openFails: { ticket: new AuthorityOperationError('unavailable', 'Jira is down') } });
    expect((await search(askDesk(down, 'mina').desk, 'ECHO-12')).items).toEqual([]);
    expect((await search(askDesk(down, 'mina').desk, 'launch')).items[0]).toMatchObject({ label: 'launch next week' });
  });

  it('says a key-only search was cut when one more key would have found another opened follow-up', async () => {
    const f = await sentFixture();
    // Six tickets keyed as ECHO keys them, that Jira opens for whoever may open tickets, and that only their keys match.
    const pointers = Array.from({ length: 6 }, (_, index) => ({ kind: 'ticket', tool_id: 'jira', external_scope_id: CLOUD, ticket_id: String(30_000 + index),
      permalink: `https://echo-fixture.atlassian.net/browse/ECHO-${100 + index}`, text_sha256: canonicalSha256(`gate ticket ${index}`) }));
    const run = f.runs.read(f.person, f.runId)!;
    f.db.transaction(() => f.items.insertForRun(f.db, run, pointers.map(pointer => ({ item_key: impactItemKeyV1(pointer)!, relation: 'conflicts' as const,
      expected: 'hold the gate', owner_membership_id: f.membership('ari'), owner_match: 'approver' as const, pointer }))))();
    const original = f.openCitation.getMockImplementation()!;
    f.openCitation.mockImplementation(async (name, citation) => {
      const pointer = pointers.find(value => value.ticket_id === (citation as { readonly ticket_id?: string }).ticket_id);
      if (pointer === undefined || name === 'rafael') return original(name, citation);
      const opened = await original(name, citation);
      return { items: [{ id: `desk-${pointer.ticket_id}`, citation: pointer, kind: 'ticket', label: `${pointer.permalink.split('/').pop()} Gate hold`, visibility: 'only_me',
        text: 'The gate stays on hold.', attributes: { status: 'To Do' }, receipt_sha256: opened.receipt_digests[0] }], truncated: false, receipt_digests: opened.receipt_digests };
    });
    const keys = pointers.map(pointer => pointer.permalink.split('/').pop()).join(' ');
    // Six follow-ups that only their keys match, each opened live: five come back, and the search says there are more.
    const capped = await search(askDesk(f, 'mina').desk, keys, { limit: 5 });
    expect(capped.items).toHaveLength(5);
    expect(capped.truncated).toBe(true);
    // Exactly as many as fit: nothing is cut, so nothing says so.
    const fits = await search(askDesk(f, 'mina').desk, keys.split(' ').slice(0, 5).join(' '), { limit: 5 });
    expect(fits.items).toHaveLength(5);
    expect(fits.truncated).toBe(false);
    // A key the asker cannot open is no hit, so it never makes a search look cut.
    expect(await search(askDesk(f, 'rafael').desk, keys, { limit: 5 })).toMatchObject({ items: [], truncated: false });
  });

  it('matches a word shaped like a ticket key where ECHO holds it as written, such as a build name', async () => {
    const f = await sentFixture();
    insertRows(f, 1, 'Ship the fan curve in the (EVT-2) build');
    insertRows(f, 1, 'Review the EVT build 3', 1);
    // Rafael opens no ticket, so only ECHO's own words can find these.
    const { desk } = askDesk(f, 'rafael');
    for (const query of ['EVT-2', 'evt-2', '"EVT-2"']) expect([query, titles(await search(desk, query))]).toEqual([query, ['Ship the fan curve in the (EVT-2) build']]);
    // The key's parts are not the key, and another build is not this one.
    for (const query of ['EVT-3', 'EVT-23']) expect((await search(desk, query)).items).toEqual([]);
  });

  it('never ranks a hit by a ticket key the asker could not open', async () => {
    const f = await sentFixture();
    insertRows(f, 53);
    // Rafael reads the decision but opens none of the tickets: a key next to his words moves nothing, and cuts nothing.
    const { desk } = askDesk(f, 'rafael');
    const words = await search(desk, 'launch');
    expect(words.items).toHaveLength(5);
    // A ticket whose follow-up the words alone leave out, and the one they return first.
    const ids = words.items.map(item => item.id);
    const cut = f.items.inOrganization(f.person.organization_id, { states: ['unsent'], limit: 100 }).find(row => !ids.includes(`follow_up_${row.item_id}`))!;
    const key = /\/browse\/(ECHO-\d+)$/u.exec(cut.pointer.permalink as string)![1]!;
    expect(ids[0]).toBe(`follow_up_${f.ticket.item_id}`);
    for (const query of [`${key} launch`, `launch ${key}`, 'ECHO-12 launch']) {
      const keyed = await search(desk, query);
      expect([query, keyed.items.map(item => item.id), keyed.truncated]).toEqual([query, words.items.map(item => item.id), words.truncated]);
    }
  });

  it('reads a meeting action from ECHO alone, never live', async () => {
    const f = await openItemsFixture({ meetingActions: [{ signal_id: 'act-1', text: 'Send the vendor the pilot plan', owner: 'Rafael Moreno' }] });
    await f.finishImpactRun();
    const { desk } = askDesk(f, 'ari');
    const opens = f.opened.length;
    const found = await search(desk, 'vendor');
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({ label: 'Send the vendor the pilot plan', attributes: { owner: 'Rafael Moreno', status: 'not sent yet' } });
    expect(found.items[0]!.text!.startsWith('On: meeting action\nLatest check: none yet\nDecision: Pilot planning')).toBe(true);
    // Nothing is read live for it: only its decision is opened, through ECHO's own desk, for its link.
    expect(f.opened.slice(opens).map(open => open.kind)).toEqual(['approved_record']);
    expect(found.items[0]!.links).toEqual({ decision: ['desk-decision'] });
  });
});

describe('follow-ups as an Ask source: lists, opens and bounds (ADR-0040)', () => {
  it('lists by owner, "me" and status, newest first, ten at a time', async () => {
    const f = await sentFixture();
    const { desk } = askDesk(f, 'mina');
    expect(titles(await list(desk, { owner: 'me' }))).toEqual([`ECHO-12 ${f.outsideText}`]);
    expect(titles(await list(desk, { owner: '@Mina patel' }))).toEqual([`ECHO-12 ${f.outsideText}`]);
    expect(titles(await list(desk, { owner: 'Ari' }))).toEqual(['Thermostat rollout plan']);
    expect((await list(desk, { owner: 'Dana' })).items).toEqual([]);
    expect((await list(desk, { owner: 'Pat' })).items).toEqual([]);                  // a part of "Patel" is not her name
    expect(titles(await list(desk, { status: 'open' }))).toHaveLength(2);
    expect((await list(desk, { status: 'done' })).items).toEqual([]);
    // A request reads its follow-ups once: the next request sees a state changed since.
    await setState(f, 'mina', f.ticket.item_id, 'done');
    expect((await list(desk, { owner: 'me', status: 'done' })).items).toEqual([]);
    const later = askDesk(f, 'mina').desk;
    expect(titles(await list(later, { owner: 'me', status: 'done' }))).toEqual([`ECHO-12 ${f.outsideText}`]);
    expect((await list(later, { owner: 'me', status: 'open' })).items).toEqual([]);
    // Fifteen more, unsent: newest first, ten a page, then the rest; a cursor belongs to its own selection.
    f.advance(1_000);
    insertRows(f, 15);
    const paged = askDesk(f, 'mina').desk;
    const first = await list(paged);
    expect(first.items).toHaveLength(10);
    expect(first.items.every(item => item.attributes?.status === 'not sent yet')).toBe(true);
    const second = await list(paged, { cursor: first.next_cursor });
    expect(second.items).toHaveLength(7);
    expect(second).not.toHaveProperty('next_cursor');
    // This source holds every matching follow-up, so no page leaves its list's end unverified (ADR-0041).
    expect([first.page_full, second.page_full]).toEqual([false, false]);
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(17);
    await expect(list(paged, { cursor: first.next_cursor, owner: 'me' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(list(paged, { cursor: 'follow_ups_99' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it("lists the asker's own follow-ups when the owner is their own name, though another member's name holds it", async () => {
    const f = await sentFixture();
    // Rafael, renamed "Ari Moreno", takes the ticket: Ari's whole name is one word of his.
    f.db.prepare('UPDATE authority_principals SET display_name=? WHERE principal_id=?').run('Ari Moreno', f.people.rafael.principal_id);
    await assign(f, 'ari', f.ticket.item_id, 'rafael');
    const { desk } = askDesk(f, 'ari');
    const ids = async (owner: string) => (await list(desk, { owner })).items.map(item => item.id);
    expect(await ids('Ari Moreno')).toEqual([`follow_up_${f.ticket.item_id}`]);
    for (const owner of ['Ari', ' ari ', '@ARI', 'me']) expect(await ids(owner)).toEqual([`follow_up_${f.action.item_id}`]);
    // Another asker's "Ari" is any Ari.
    expect((await list(askDesk(f, 'mina').desk, { owner: 'Ari' })).items.map(item => item.id).sort()).toEqual([`follow_up_${f.ticket.item_id}`, `follow_up_${f.action.item_id}`].sort());
  });

  it("reads the follow-ups a scope shows, and each decision's first line, once a request", async () => {
    const f = await sentFixture();
    insertRows(f, 12);
    const { desk } = askDesk(f, 'mina');
    const pages = vi.spyOn(f.items, 'inOrganization');
    const cards = vi.spyOn(f.runs, 'readUnfenced');
    const decisions = f.readable.mock.calls.length;
    await search(desk, 'launch');
    await search(desk, 'Pilot planning');
    const first = await list(desk);
    await list(desk, { cursor: first.next_cursor });
    await list(desk, { owner: 'me', status: 'open' });
    await desk.search({ query: 'launch', limit: 8 });
    expect(pages).toHaveBeenCalledTimes(1);
    expect(f.readable.mock.calls.length - decisions).toBe(1);
    expect(cards).toHaveBeenCalledTimes(1);
    // The checks still read every release again.
    await desk.revalidate({});
    expect(f.readable.mock.calls.length - decisions).toBe(2);
  });

  it("takes ECHO's own dates, and refuses a due date, which is its tool's, and the filters of other sources", async () => {
    const f = await sentFixture();
    const { desk } = askDesk(f, 'mina');
    // A due date shows only once a follow-up's tool item is read, so a list cannot filter on it (ADR-0040); nor on a date no follow-up records.
    for (const date_field of ['due', 'occurred', 'updated', 'received', 'approved']) {
      for (const read of [() => list(desk, { since: '2026-10-01', date_field }), () => search(desk, 'launch', { since: '2026-10-01', date_field })]) {
        await expect(read()).rejects.toMatchObject({ code: 'invalid_request', message: 'This source supports date_field: created, sent, reassigned, checked, any' });
      }
    }
    for (const dates of [{ since: '2026-10-01' }, { until: '2026-10-30' }, { since: '2026-10-01', date_field: 'created' }, { date_field: 'sent' }]) {
      expect((await list(desk, dates)).items).toHaveLength(2);
      expect((await search(desk, 'launch', dates)).items).toHaveLength(1);
    }
    await expect(list(desk, { channel: 'hw-dvt' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(list(desk, { owner: ' @ ' })).rejects.toMatchObject({ code: 'invalid_request' });
    // A time zone alone bounds nothing.
    expect((await list(desk, { time_zone: 'America/Los_Angeles' })).items).toHaveLength(2);
  });

  it('reads at most twenty tool items live in one request, each once, and releases the rest with ECHO text only', async () => {
    const f = await sentFixture();
    insertRows(f, 30, 'pilot starts next week');
    const { desk } = askDesk(f, 'mina');
    const opens = f.opened.length;
    const pages: EvidenceDeskResultV2[] = [];
    for (let cursor: string | undefined; pages.length === 0 || cursor !== undefined;) {
      const page = await list(desk, cursor === undefined ? {} : { cursor });
      pages.push(page); cursor = page.next_cursor;
    }
    expect(pages.flatMap(page => page.items)).toHaveLength(32);
    // Twenty tool items, and their one decision, once, for its link.
    expect(f.opened.length - opens).toBe(21);
    // The two oldest, past the bound, carry ECHO's phrases and no tool words.
    expect(pages.at(-1)!.items.map(item => item.label).sort()).toEqual(['launch next week', 'pilot starts next week']);
    expect(JSON.stringify(pages.at(-1))).not.toMatch(/ECHO-12|Kestrel|due_at/);
    await search(desk, 'pilot');
    await list(desk);
    expect(f.opened.length - opens).toBe(21);
    // Past the bound a ticket key cannot be checked, and the search says so whether or not any follow-up holds that key.
    for (const query of ['ECHO-12', 'ECHO-999']) expect([query, await search(desk, query)]).toEqual([query, expect.objectContaining({ items: [], notice: CAPPED })]);
    expect(f.opened.length - opens).toBe(21);
    // Within it, a key no follow-up holds says nothing.
    expect(await search(askDesk(f, 'mina').desk, 'ECHO-999')).not.toHaveProperty('notice');
  });

  it('opens a released follow-up again through the policy, and refuses one the asker no longer sees', async () => {
    const f = await sentFixture();
    const { desk } = askDesk(f, 'rafael');
    const [found] = (await list(desk, { owner: 'Ari' })).items;
    const opened = await desk.open({ item: found!.id });
    expect(opened.items).toEqual([{ ...found, receipt_sha256: opened.receipt_digests[0] }]);
    await expect(desk.open({ item: 'follow_up_itm_unknown' })).rejects.toMatchObject({ code: 'not_found' });
    leaveProject(f, 'rafael');
    await expect(desk.open({ item: found!.id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it("reads in a project only the decisions the asker reads there", async () => {
    const f = await sentFixture({ ticketOwner: 'okafor' });
    const projectA = f.projectA as `prj_${string}`;
    expect(titles(await search(askDesk(f, 'mina', { scope: { kind: 'project', project_id: projectA } }).desk, 'launch'))).toEqual([`ECHO-12 ${f.outsideText}`]);
    expect((await search(askDesk(f, 'mina', { scope: { kind: 'project', project_id: 'prj_00000000-0000-4000-8000-000000000000' } }).desk, 'launch')).items).toEqual([]);
    // S. Okafor owns the ticket but reads nothing in project A.
    expect((await list(askDesk(f, 'okafor', { scope: { kind: 'project', project_id: projectA } }).desk)).items).toEqual([]);
    expect((await list(askDesk(f, 'okafor').desk)).items).toHaveLength(1);
  });
});

describe('follow-ups as an Ask source: checks and audit (ADR-0040, ADR-0038)', () => {
  it('rechecks only what is new before a model call, everything at release, and refuses what the asker can no longer see', async () => {
    const f = await sentFixture();
    const { desk } = askDesk(f, 'mina');
    await desk.revalidate({ mode: 'incremental' });
    await search(desk, 'Pilot planning');
    const reads = () => f.readable.mock.calls.length;
    let before = reads();
    await desk.revalidate({ mode: 'incremental' });
    expect(reads()).toBeGreaterThan(before);
    before = reads();
    await desk.revalidate({ mode: 'incremental' });
    expect(reads()).toBe(before);                                    // nothing new since the last check
    await desk.revalidate({});
    expect(reads()).toBeGreaterThan(before);                          // the full check reads every release again
    // A state changed while it stays visible is not an access change.
    await setState(f, 'mina', f.ticket.item_id, 'done');
    await desk.revalidate({});
    // Mina leaves project A: she still owns the ticket, but a release carried its decision, and she no longer sees the rollout.
    leaveProject(f, 'mina');
    await expect(desk.revalidate({ mode: 'incremental' })).resolves.toBeDefined();   // nothing new to check
    await expect(desk.revalidate({})).rejects.toMatchObject({ code: 'stale_access_state' });
  });

  it('refuses at the check a release that carried its decision once the asker no longer reads it, though they still own the follow-up', async () => {
    const f = await sentFixture();
    const { desk } = askDesk(f, 'mina');
    // Her own follow-up alone, released with its decision.
    const listed = await list(desk, { owner: 'me' });
    expect(listed.items.map(item => item.id)).toEqual([`follow_up_${f.ticket.item_id}`]);
    expect(listed.items[0]!.text).toContain('Decision: Pilot planning');
    await desk.revalidate({ mode: 'incremental' });
    // Mina leaves project A: the ticket is still hers, so its row stays visible, but she no longer reads the decision it carried.
    leaveProject(f, 'mina');
    await expect(desk.revalidate({})).rejects.toMatchObject({ code: 'stale_access_state' });
    // The control: the same follow-up released without its decision passes the same check.
    const after = askDesk(f, 'mina').desk;
    const own = await list(after, { owner: 'me' });
    expect(own.items.map(item => item.id)).toEqual([`follow_up_${f.ticket.item_id}`]);
    expect(own.items[0]!.text).not.toContain('Decision:');
    await expect(after.revalidate({})).resolves.toBeDefined();
  });

  it('refuses at the check a follow-up its owner can no longer see, though it carried no decision', async () => {
    const f = await sentFixture({ ticketOwner: 'okafor' });
    const { desk } = askDesk(f, 'okafor');
    expect((await search(desk, 'launch')).items).toHaveLength(1);
    await desk.revalidate({ mode: 'incremental' });
    // Ari hands the ticket to Mina: S. Okafor no longer owns it, and never read its decision.
    await assign(f, 'ari', f.ticket.item_id, 'mina');
    await expect(desk.revalidate({})).rejects.toMatchObject({ code: 'stale_access_state' });
  });

  it('refuses before the next model call a follow-up hidden since it was released', async () => {
    const f = await sentFixture({ ticketOwner: 'okafor' });
    const { desk } = askDesk(f, 'okafor');
    expect((await search(desk, 'launch')).items).toHaveLength(1);
    // Handed to Mina before any check: the incremental check alone refuses it.
    await assign(f, 'ari', f.ticket.item_id, 'mina');
    await expect(desk.revalidate({ mode: 'incremental' })).rejects.toMatchObject({ code: 'stale_access_state' });
  });

  it("refuses at the check a project Ask's follow-up whose decision left the project, though the asker still reads it", async () => {
    const f = await sentFixture();
    const { desk } = askDesk(f, 'mina', { scope: { kind: 'project', project_id: f.projectA as `prj_${string}` } });
    expect((await search(desk, 'launch')).items).toHaveLength(1);
    await desk.revalidate({});
    // The decision is no longer in project A, and Mina still reads it everywhere else.
    vi.spyOn(f.records, 'projectRecords').mockReturnValue([]);
    expect((await search(askDesk(f, 'mina').desk, 'launch')).items).toHaveLength(1);
    await expect(desk.revalidate({})).rejects.toMatchObject({ code: 'stale_access_state' });
  });

  it('audits every release before it leaves, with ids and digests only', async () => {
    const f = await sentFixture();
    const { desk, audits } = askDesk(f, 'mina');
    const found = await search(desk, 'Pilot planning');
    await search(desk, 'nothing matches this');
    await list(desk, { owner: 'me' });
    await desk.open({ item: found.items[0]!.id });
    const rows = audits();
    expect(rows.map(row => row.body.operation)).toEqual(['search', 'search', 'list', 'open']);
    expect(rows[0]!.row_sha256).toBe(found.items[0]!.receipt_sha256);
    expect(found.receipt_digests).toContain(rows[0]!.row_sha256);
    expect(rows[1]!.body.items).toEqual([]);                          // an empty search is committed too
    expect(rows[0]!.body).toMatchObject({ schema_version: 1, context_kind: 'answer_composition', release_sequence: 1, organization_id: f.person.organization_id, membership_id: f.membership('mina') });
    expect((rows[0]!.body.items as { item_id: string; released_fields_sha256: string }[]).map(item => item.item_id).sort()).toEqual(found.items.map(item => (item.citation as { item_id: string }).item_id).sort());
    expect(Object.keys((rows[0]!.body.items as object[])[0]!).sort()).toEqual(['item_id', 'released_fields_sha256']);
    const text = JSON.stringify(rows);
    for (const word of ['Pilot planning', 'The pilot starts next week', 'launch next week', 'Mina Patel', 'Thermostat', 'ECHO-12', f.outsideText, 'meeting:']) expect(text).not.toContain(word);
    // The tool's own release of a title read live is the tool's receipt, bound to the same call.
    expect(found.receipt_digests.length).toBeGreaterThan(1);
  });
});

describe('follow-ups on the request desk (ADR-0040)', () => {
  it('joins a keyword search across sources, never a dated one, and is advertised only where bound', async () => {
    const f = await sentFixture();
    const bound = askDesk(f, 'mina');
    expect(bound.desk.live_sources).toEqual([expect.objectContaining({ source_id: 'jira' }), FOLLOW_UPS_SOURCE_DESCRIPTOR_V1]);
    expect(titles(await bound.desk.search({ query: 'launch', limit: 8 }))).toEqual(['launch next week']);
    expect((await bound.desk.search({ query: 'launch', limit: 8, since: '2026-10-01' })).items).toEqual([]);
    expect(bound.audits()).toHaveLength(1);
    // Meeting kinds alone never reach follow-ups, nor follow-up kinds the meetings.
    await bound.desk.search({ query: 'launch', kinds: ['decision'], limit: 8 });
    expect(bound.audits()).toHaveLength(1);
    await bound.desk.search({ query: 'launch', kinds: ['follow_up'], limit: 8 });
    expect(bound.audits()).toHaveLength(2);
    expect(bound.base.search).toHaveBeenCalledTimes(3);
    // Owner and status are never sent to another source: one that cannot apply them refuses the read rather than answer
    // wider than asked (ADR-0041).
    await expect(bound.desk.list({ source: 'meeting', owner: 'me', status: 'open', limit: 10 })).rejects.toMatchObject({ code: 'invalid_request', message: 'This source cannot be filtered by owner, status or role' });
    await expect(bound.desk.list({ source: 'jira', status: 'open', limit: 10 })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(bound.base.list).not.toHaveBeenCalled();

    const unbound = askDesk(f, 'mina', { followUps: false });
    expect(unbound.desk.live_sources).toEqual([expect.objectContaining({ source_id: 'jira' })]);
    await expect(search(unbound.desk, 'launch')).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(list(unbound.desk)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(unbound.desk.search({ query: 'launch', kinds: ['follow_up'], limit: 8 })).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await unbound.desk.search({ query: 'launch', limit: 8 })).items).toEqual([]);
    expect(unbound.audits()).toEqual([]);
  });

  it('reads nothing live for a search across sources, and says when a ticket key needs follow-ups on their own', async () => {
    const f = await sentFixture();
    const { desk, audits } = askDesk(f, 'mina');
    const opens = f.opened.length;
    // Across sources a follow-up carries ECHO-held text only: no live read is spent on an item the desk may drop.
    const across = await desk.search({ query: 'Pilot planning', limit: 8 });
    expect(titles(across)).toEqual(['launch next week', 'pilot starts next week']);
    expect(across.items.every(item => item.attributes?.due_at === undefined && item.visibility === 'project')).toBe(true);
    // Nothing is opened for a hit the desk may drop, so none links anywhere.
    expect(across.items.every(item => item.links === undefined)).toBe(true);
    expect(across).not.toHaveProperty('notice');
    expect(f.opened.length).toBe(opens);
    // A key alone needs a live open, so across sources it finds no follow-up, and says so whether or not one holds it.
    for (const query of ['ECHO-12', 'ECHO-999']) {
      const keyed = await desk.search({ query, limit: 8 });
      expect([query, keyed.items, keyed.notice]).toEqual([query, [], ACROSS]);
    }
    expect(f.opened.length).toBe(opens);
    expect(audits().map(row => (row.body.items as unknown[]).length)).toEqual([2, 0, 0]);
    // On their own, follow-ups read each hit's tool item live, once, and their one decision once for its link.
    expect(titles(await search(desk, 'ECHO-12'))).toEqual([`ECHO-12 ${f.outsideText}`]);
    expect(titles(await search(desk, 'Pilot planning'))).toEqual([`ECHO-12 ${f.outsideText}`, 'Thermostat rollout plan'].sort());
    expect(f.opened.slice(opens).map(open => open.kind).sort()).toEqual(['approved_record', 'approved_record', 'ticket']);
  });

  it('reserves the follow-ups selector, and refuses a follow-up search with kinds of another source', async () => {
    const f = await sentFixture();
    const { desk } = askDesk(f, 'mina');
    await expect(desk.search({ source: 'follow_ups', kinds: ['ticket'], query: 'launch', limit: 8 })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(desk.list({ source: 'meeting', kinds: ['follow_up'], limit: 10 })).rejects.toMatchObject({ code: 'unauthorized' });
    const jira = { tool_id: 'jira', search: vi.fn(), open: vi.fn(), list: vi.fn(), revalidate: vi.fn(), assertCurrent: vi.fn() } as unknown as PersonLiveEvidenceSourceV1;
    expect(() => createRegisteredPersonLiveEvidenceDeskV2(desk as never, [{ descriptor: { ...JIRA_LIVE_CONNECTOR_V1.descriptor, source_id: 'follow_ups' }, source: jira, scope: GLOBAL }]))
      .toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });
});

describe("follow-ups as an Ask source: ECHO's own dates and links (research tool contract v1)", () => {
  const DAY = 86_400_000;
  const day = (value: string) => ({ since: value.slice(0, 10), until: value.slice(0, 10) });
  const ids = (result: EvidenceDeskResultV2) => result.items.map(item => item.id).sort();

  it('carries when each follow-up was created, sent, reassigned and checked, and lists by any of them before the page', async () => {
    const f = await sentFixture();
    // A day on, the ticket is checked; a day after that, Ari hands the rollout to Rafael.
    f.advance(DAY);
    f.check(f.ticket.item_id, 'still_open');
    f.advance(DAY);
    await assign(f, 'ari', f.action.item_id, 'rafael');
    const ticket = f.items.read(f.ticket.item_id)!;
    const action = f.items.read(f.action.item_id)!;
    const [ticketId, actionId] = [`follow_up_${ticket.item_id}`, `follow_up_${action.item_id}`];
    const { desk } = askDesk(f, 'mina');
    expect(Object.fromEntries((await list(desk)).items.map(item => [item.id, item.dates]))).toEqual({
      [ticketId]: { created: ticket.created_at, sent: ticket.sent_at, checked: ticket.check!.at },
      [actionId]: { created: action.created_at, sent: action.sent_at, reassigned: action.owner_set_at },
    });
    // Each field reads its own date; what a field cannot test is counted, with the dates those follow-ups record, never listed.
    const checked = await list(desk, { ...day(ticket.check!.at), date_field: 'checked' });
    expect([ids(checked), checked.unchecked]).toEqual([[ticketId], { count: 1, dates: ['created', 'sent', 'reassigned'] }]);
    const reassigned = await list(desk, { ...day(action.owner_set_at!), date_field: 'reassigned' });
    expect([ids(reassigned), reassigned.unchecked]).toEqual([[actionId], { count: 1, dates: ['created', 'sent', 'checked'] }]);
    for (const date_field of ['created', 'sent'] as const) {
      const both = await list(desk, { ...day(ticket.created_at), date_field });
      expect([date_field, ids(both), both.unchecked]).toEqual([date_field, [actionId, ticketId].sort(), undefined]);
    }
    expect((await list(desk, { ...day(ticket.created_at), date_field: 'checked' })).items).toEqual([]);
    // No field is any of a follow-up's dates; every follow-up records its creation, so nothing is untested.
    const any = await list(desk, day(action.owner_set_at!));
    expect([ids(any), any.unchecked]).toEqual([[actionId], undefined]);
    expect(ids(await list(desk, { since: ticket.check!.at.slice(0, 10) }))).toEqual([actionId, ticketId].sort());
    expect(ids(await list(desk, { ...day(ticket.check!.at), date_field: 'any' }))).toEqual([ticketId]);
    // A window applies with owner and status, and counts only what they select.
    expect(await list(desk, { owner: 'Rafael', ...day(action.owner_set_at!), date_field: 'reassigned' })).toMatchObject({ items: [{ id: actionId }] });
    expect(await list(desk, { owner: 'Rafael', ...day(action.owner_set_at!), date_field: 'reassigned' })).not.toHaveProperty('unchecked');
    expect(await list(desk, { status: 'open', ...day(ticket.check!.at), date_field: 'checked' })).toMatchObject({ items: [{ id: ticketId }], unchecked: { count: 1 } });
    // A search applies the same window before it ranks or reads anything live, and counts over every follow-up the asker sees.
    const searched = await search(desk, 'launch', { ...day(action.owner_set_at!), date_field: 'reassigned' });
    expect([searched.items, searched.unchecked]).toEqual([[], { count: 1, dates: ['created', 'sent', 'checked'] }]);
    expect(ids(await search(desk, 'Pilot planning', { ...day(ticket.check!.at), date_field: 'checked' }))).toEqual([ticketId]);

    // Pages of a dated list share its window and its count; a cursor belongs to its own window.
    insertRows(f, 11);
    const later = askDesk(f, 'mina').desk;
    const first = await list(later, { since: ticket.created_at.slice(0, 10), date_field: 'created' });
    expect(first.items).toHaveLength(10);
    await expect(list(later, { cursor: first.next_cursor })).rejects.toMatchObject({ code: 'invalid_request' });
    const rest = await list(later, { since: ticket.created_at.slice(0, 10), date_field: 'created', cursor: first.next_cursor });
    expect(rest.items).toHaveLength(3);
    // The same window however it is spelled: no field is any of the dates.
    const implied = await list(later, { since: ticket.created_at.slice(0, 10) });
    expect((await list(later, { since: ticket.created_at.slice(0, 10), date_field: 'any', cursor: implied.next_cursor })).items).toHaveLength(3);
    const sent = await list(later, { since: ticket.created_at.slice(0, 10), date_field: 'sent' });
    expect([ids(sent), sent.unchecked]).toEqual([[actionId, ticketId].sort(), { count: 11, dates: ['created'] }]);
  });

  it('never counts a follow-up the asker cannot see', async () => {
    const f = await sentFixture({ ticketOwner: 'okafor' });
    insertRows(f, 53);
    // S. Okafor sees only the ticket he owns; the 55 others are his decision readers' alone.
    const listed = await list(askDesk(f, 'okafor').desk, { since: '2026-10-01', date_field: 'checked' });
    expect(listed).toMatchObject({ items: [], unchecked: { count: 1, dates: ['created', 'sent'] } });
    expect((await list(askDesk(f, 'mina').desk, { since: '2026-10-01', date_field: 'checked' })).unchecked).toEqual({ count: 55, dates: ['created', 'sent'] });
  });

  it("links each follow-up to its decision's items and to the tool item it follows, released by the desk that owns them, beside the rows", async () => {
    const f = await sentFixture();
    const { desk, base, jira } = askDesk(f, 'mina');
    const listed = await list(desk);
    const links = { [`follow_up_${f.ticket.item_id}`]: { decision: ['desk-decision'], follows: ['desk-ticket'] }, [`follow_up_${f.action.item_id}`]: { decision: ['desk-decision'], follows: ['desk-rollout'] } };
    expect(Object.fromEntries(listed.items.map(item => [item.id, item.links]))).toEqual(links);
    // The rows are the follow-ups alone; each linked item comes once, as the desk released it.
    expect(listed.items.every(item => item.kind === 'follow_up')).toBe(true);
    expect(listed.linked!.map(item => item.id).sort()).toEqual(['desk-decision', 'desk-rollout', 'desk-ticket']);
    expect(listed.linked!.find(item => item.id === 'desk-ticket')).toMatchObject({ kind: 'ticket', source_id: 'jira', text: `${f.outsideText} ships on Oct 30.` });
    expect(listed.linked!.find(item => item.id === 'desk-decision')).toMatchObject({ kind: 'decision', citation: f.decisionCitation, text: 'The pilot starts next week.' });
    // The decision is opened once in the request, by its record's anchor, and its release's receipt is bound with the read that linked it.
    const decisionOpens = () => f.openCitation.mock.calls.filter(([, citation]) => citation.kind === 'approved_record' && citation.record_sha256 === f.record).length;
    expect(decisionOpens()).toBe(1);
    expect(listed.receipt_digests).toContain(canonicalSha256('receipt'));
    const searched = await search(desk, 'launch');
    expect(searched.items[0]!.links).toEqual(links[`follow_up_${f.ticket.item_id}`]);
    expect(searched.linked!.map(item => item.id).sort()).toEqual(['desk-decision', 'desk-ticket']);
    const opened = await desk.open({ item: `follow_up_${f.action.item_id}` });
    expect(opened.items[0]!.links).toEqual(links[`follow_up_${f.action.item_id}`]);
    expect(decisionOpens()).toBe(1);
    // A linked item opens through the source that released it.
    await desk.open({ item: 'desk-decision' });
    expect(base.open).toHaveBeenCalledWith(expect.objectContaining({ item: 'desk-decision' }));
    await desk.open({ item: 'desk-ticket' });
    expect(jira.open).toHaveBeenCalledWith(expect.objectContaining({ item: 'desk-ticket' }));
  });

  it('links a decision only where the release carries it, and a tool item only where this request opened it', async () => {
    const f = await sentFixture({ ticketOwner: 'okafor' });
    // S. Okafor owns the ticket and reads no decision: his follow-up links to the ticket he opened, never to the decision.
    const okafor = await list(askDesk(f, 'okafor').desk);
    expect(okafor.items.map(item => item.links)).toEqual([{ follows: ['desk-ticket'] }]);
    expect(okafor.linked!.map(item => item.id)).toEqual(['desk-ticket']);
    expect(f.openCitation.mock.calls.some(([name, citation]) => name === 'okafor' && citation.kind === 'approved_record')).toBe(false);
    expect(JSON.stringify(okafor)).not.toMatch(/desk-decision|Pilot planning|The pilot starts next week|meeting:sha256/);
    // The desk refuses Rafael the ticket: that follow-up links to its decision alone.
    const rafael = await list(askDesk(f, 'rafael').desk);
    expect(Object.fromEntries(rafael.items.map(item => [item.id, item.links]))).toEqual({
      [`follow_up_${f.ticket.item_id}`]: { decision: ['desk-decision'] },
      [`follow_up_${f.action.item_id}`]: { decision: ['desk-decision'], follows: ['desk-rollout'] },
    });
    expect(rafael.linked!.map(item => item.id).sort()).toEqual(['desk-decision', 'desk-rollout']);
  });

  it('leaves a decision unlinked while it cannot be opened, and still releases its follow-ups', async () => {
    const f = await sentFixture();
    const anchor = vi.spyOn(f.records, 'recordAnchor').mockImplementation(() => { throw new PersonRecordSearchIndexLagV1(); });
    const { desk } = askDesk(f, 'mina');
    const listed = await list(desk);
    expect(listed.items.map(item => item.links).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
      .toEqual([{ follows: ['desk-rollout'] }, { follows: ['desk-ticket'] }]);
    expect(listed.items.every(item => item.text!.includes('Decision: Pilot planning'))).toBe(true);
    // A later release tries again.
    anchor.mockRestore();
    expect((await list(desk)).items.every(item => item.links?.decision?.[0] === 'desk-decision')).toBe(true);
  });
});
