import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import {
  PERSON_ASK_CHECK_PATH_V1,
  PERSON_ASK_CHECK_REQUEST_KIND_V1,
  validatePersonAskCheckRequestV1,
  validatePersonAskCheckV1,
  type PersonAskCheckItemV1,
} from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { meetingSourceEnvelopeV1 } from '@echo-brain/organization-processing/core';
import { SqlitePersonDocumentRepositoryV1 } from '../src/adapters/persistence/sqlite/document-v1.js';
import { SqlitePersonOriginalContextRetrievalV1 } from '../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js';
import { SqlitePersonTextSourceInboxV1 } from '../src/adapters/persistence/sqlite/person-text-source-v1.js';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { SqliteSourceAdmissionStoreV1 } from '../src/adapters/persistence/sqlite/source-admission-v1.js';
import { createPersonDocumentApplicationV1 } from '../src/application/document-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import type { PersonPageCheckV1, PersonTicketCheckV1 } from '../src/application/ports/person-source-check-v1.js';
import { createPersonAskCheckV1, type CreatePersonAskCheckV1Options, type PersonAskCheckLiveFailureV1 } from '../src/composition/person-ask-check-v1.js';
import { PersonDocumentProcessingV1 } from '../src/composition/person-document-processing-v1.js';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import { CLOUD, assign, sentFixture, setState, type FixturePerson } from './fixtures/open-items.js';

const GLOBAL = { kind: 'global' } as const;
const SITE = 'https://echo-fixture.atlassian.net';
const signal = () => new AbortController().signal;
const ticket = (ticket_id: string, text = 'ticket text') => ({ kind: 'ticket' as const, tool_id: 'jira', external_scope_id: CLOUD, ticket_id, permalink: `${SITE}/browse/ECHO-${ticket_id}`, text_sha256: sha256Digest(text) });
const page = (page_id: string, fields: { readonly version?: string; readonly section?: string; readonly text?: string } = {}) => ({
  kind: 'page' as const, tool_id: 'confluence', external_scope_id: CLOUD, page_id, section_id: fields.section ?? 's2', version: fields.version ?? '3',
  permalink: `${SITE}/wiki/pages/viewpage.action?pageId=${page_id}`, text_sha256: sha256Digest(fields.text ?? 'Pilot starts next week.'),
});
const SAME: PersonAskCheckItemV1 = { state: 'same' };
const CHANGED: PersonAskCheckItemV1 = { state: 'changed' };
const UNREADABLE: PersonAskCheckItemV1 = { state: 'unreadable' };
const UNKNOWN: PersonAskCheckItemV1 = { state: 'unknown' };

/**
 * The open items world (Ari approved a meeting into project A, sent its follow-ups: the ticket to Mina, the action to
 * himself), plus originals: Ari's imported meeting, Ari's team note, Mina's Only-me note, Ari's project A note and Ari's team
 * document. Each original's citation is the one its author's desk released.
 */
async function world(options: Parameters<typeof sentFixture>[0] = {}) {
  const f = await sentFixture(options);
  const sessions = f.openItemsOptions.sessions;
  const organization = f.person.organization_id;
  const authenticate = (access_token: string) => sessions.authenticateAccess({ access_token });
  const now = () => f.clock().toISOString();
  const projects = createProjectContextApplicationV1({ authenticate, repository: new SqliteProjectContextRepositoryV1(f.db, now) });
  const documents = new SqlitePersonDocumentRepositoryV1(f.db, now);
  const worker = new PersonDocumentProcessingV1(documents, undefined, new SqlitePersonTextSourceInboxV1(f.db, now));
  const originals = new SqlitePersonOriginalContextRetrievalV1(f.db, sessions, organization);
  const note = async (who: FixturePerson, text: string, audience: unknown) => {
    const receipt = projects.submitUploadV3(who, { schema_version: 3, kind: 'echo-person-update-submit-v3', request_id: randomUUID(), title: `${who} note`, text,
      association_project_ids: [], audience } as never);
    expect(await worker.runOnce(signal())).toBe('admitted');
    return `note:${receipt.context_id}`;
  };
  const refs = {
    team: await note('ari', 'Kestrel ships on Friday for everyone.', { kind: 'team' }),
    private: await note('mina', 'Kestrel worries Mina keeps to herself.', { kind: 'only_me' }),
    project: await note('ari', 'Kestrel pilot plan for project A only.', { kind: 'project', project_id: f.projectA }),
  };
  const bytes = Buffer.from('Kestrel launch checklist for the whole team.');
  const saved = createPersonDocumentApplicationV1({ repository: documents, authenticate }).uploadV2('ari', {
    schema_version: 2, kind: 'echo-person-document-upload-v2', request_id: randomUUID(), filename: 'launch.md', title: 'Launch checklist',
    content_length: bytes.byteLength, sha256: sha256Digest(bytes), audience: { kind: 'team' }, association_project_ids: [] } as never, bytes);
  const claim = documents.claimExtraction()!;
  expect(documents.completeExtraction(claim, { status: 'ready', sourceSha256: claim.source_sha256, extractorVersion: 'fixture-1',
    chunks: [{ anchor_kind: 'paragraph', anchor_start: 1, text: bytes.toString() }], message: null })).toBe(true);
  /** The citation `who`'s desk released for `ref`, as an answer would carry it. */
  const citationOf = (who: FixturePerson, ref: string) => {
    const found = [...originals.deskSearch({ access_token: who, scope: GLOBAL, query: 'Kestrel' }).items, ...originals.deskSearch({ access_token: who, scope: GLOBAL, kinds: ['imported_meeting'] }).items]
      .find(item => item.ref === ref || (ref === 'imported_meeting' && item.kind === 'imported_meeting'));
    if (found === undefined) throw new Error(`${who} reads no ${ref}`);
    return found.citation;
  };
  const cited = {
    team: citationOf('ari', refs.team), private: citationOf('mina', refs.private), project: citationOf('ari', refs.project),
    document: citationOf('ari', `document:${saved.document_id}`), meeting: citationOf('ari', 'imported_meeting'),
  };
  /** Ari edits his imported meeting: a newer revision of the same source, captured later. */
  const editMeeting = () => {
    const meeting = { ...f.first.meeting, title: 'Pilot sync (edited)',
      provenance: { ...f.first.meeting.provenance, canonical_revision: canonicalSha256('edited revision'), observed_at: '2026-10-09T09:00:00.000Z' } };
    new SqliteSourceAdmissionStoreV1(f.db).admit({ source: meetingSourceEnvelopeV1(meeting), scope: { organization_id: organization,
      custody_ref: `person:${f.person.membership_id}`, access_policy_ref: `personal-meeting:${f.sourceKey}`, analysis_policy: 'automatic' } });
  };
  return { ...f, originals, cited, editMeeting };
}
type World = Awaited<ReturnType<typeof world>>;

/** The check over the world, with whatever live tools a test gives it; every answer passes the API's own validator against its request. */
function askCheckOf(f: World, overrides: Partial<CreatePersonAskCheckV1Options> = {}) {
  const failures: PersonAskCheckLiveFailureV1[] = [];
  const app = createPersonAskCheckV1({
    database: f.db, sessions: f.openItemsOptions.sessions, projects: new SqliteProjectContextRepositoryV1(f.db), records: f.records, originals: f.originals,
    items: f.items, people: f.directory, on_live_failure: event => { failures.push(event); }, ...overrides,
  });
  const requestOf = (items: readonly unknown[]) => validatePersonAskCheckRequestV1({ schema_version: 1, kind: PERSON_ASK_CHECK_REQUEST_KIND_V1, items });
  const check = async (who: string, items: readonly unknown[], input: { readonly signal?: AbortSignal } = {}) => {
    const request = requestOf(items);
    return validatePersonAskCheckV1(await app.check({ access_token: who, request, ...input }), request).items;
  };
  return { app, check, failures, requestOf };
}
const item = (citation: unknown, asked_at = '2026-10-08T09:00:00.000Z', marker?: string) => ({ asked_at, citation, ...(marker === undefined ? {} : { marker }) });

/** A ticket tool whose markers are `markers` for every reader, or as `read` answers them. */
function ticketTool(read: (input: { readonly access_token: string; readonly ticket_ids: readonly string[]; readonly signal?: AbortSignal }) => Promise<ReadonlyMap<string, string>>, tool_id = 'jira') {
  return { kind: 'ticket' as const, tool_id, external_scope_id: CLOUD, markers: vi.fn(read) } satisfies PersonTicketCheckV1;
}
/** A page tool with these pages' versions and the section digests of their bodies. */
function pageTool(pages: Readonly<Record<string, { readonly version: string; readonly sections?: readonly string[] }>>, fail: { versions?: unknown; sections?: unknown } = {}) {
  return { kind: 'page' as const, tool_id: 'confluence', external_scope_id: CLOUD,
    versions: vi.fn(async ({ page_ids }: { readonly page_ids: readonly string[] }) => {
      if (fail.versions !== undefined) throw fail.versions;
      return new Map(page_ids.flatMap(id => (pages[id] === undefined ? [] : [[id, pages[id]!.version] as const])));
    }),
    sections: vi.fn(async ({ page_ids }: { readonly page_ids: readonly string[] }) => {
      if (fail.sections !== undefined) throw fail.sections;
      return new Map(page_ids.flatMap(id => (pages[id]?.sections === undefined ? [] : [[id, pages[id]!.sections!.map(text => sha256Digest(text))] as const])));
    }) } satisfies PersonPageCheckV1;
}

describe('Ask source check: the database kinds', () => {
  it('answers a readable approved record same, and unreadable to someone who cannot read it, hidden or never recorded', async () => {
    const f = await world();
    const { check } = askCheckOf(f);
    const record = f.decisionCitation;
    const never = { ...record, record_sha256: canonicalSha256('never recorded'), atom_id: canonicalSha256('never an atom') };
    for (const who of ['ari', 'mina', 'rafael'] as const) expect(await check(who, [item(record)]), who).toEqual([SAME]);
    expect(await check('okafor', [item(record), item(never)])).toEqual([UNREADABLE, UNREADABLE]);
    expect(await check('ari', [item(never)])).toEqual([UNREADABLE]);
    // A record is immutable: however long ago the turn was asked, it is the same.
    expect(await check('ari', [item(record, '2000-01-01T00:00:00.000Z')])).toEqual([SAME]);
    // Leaving project A loses the record.
    f.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=? AND membership_id=? AND status='active'").run(f.clock().toISOString(), f.projectA, f.membership('rafael'));
    expect(await check('rafael', [item(record)])).toEqual([UNREADABLE]);
  });

  it('answers originals through their ACL: notes and documents never change, an edited import is changed for its importer alone', async () => {
    const f = await world();
    const { check } = askCheckOf(f);
    const { team, private: mine, project, document, meeting } = f.cited;
    expect(await check('ari', [item(team), item(project), item(document), item(meeting), item(mine)])).toEqual([SAME, SAME, SAME, SAME, UNREADABLE]);
    expect(await check('mina', [item(team), item(project), item(document), item(meeting), item(mine)])).toEqual([SAME, SAME, SAME, UNREADABLE, SAME]);
    // Okafor is not in project A, and the import is Ari's alone.
    expect(await check('okafor', [item(team), item(project), item(document), item(meeting), item(mine)])).toEqual([SAME, UNREADABLE, SAME, UNREADABLE, UNREADABLE]);
    f.editMeeting();
    expect(await check('ari', [item(meeting), item(team)])).toEqual([CHANGED, SAME]);
    // Still unreadable, never changed, for anyone else.
    expect(await check('mina', [item(meeting)])).toEqual([UNREADABLE]);
    // A revision cited after the edit is the newest one: the same.
    const edited = f.originals.deskSearch({ access_token: 'ari', scope: GLOBAL, kinds: ['imported_meeting'] }).items[0]!.citation;
    expect(edited.revision_id).not.toBe(meeting.revision_id);
    expect(await check('ari', [item(edited), item(meeting)])).toEqual([SAME, CHANGED]);
    // Leaving project A loses its note.
    f.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=? AND membership_id=? AND status='active'").run(f.clock().toISOString(), f.projectA, f.membership('mina'));
    expect(await check('mina', [item(project), item(team)])).toEqual([UNREADABLE, SAME]);
  });

  it('answers a follow-up changed only when its owner, state or send moved after the turn was asked, and only to whoever sees its row', async () => {
    const f = await world();
    const { check } = askCheckOf(f);
    const followUp = (itemId: string) => ({ kind: 'follow_up', item_id: itemId });
    const sentAt = f.ticket.sent_at!;
    const before = new Date(Date.parse(sentAt) - 1).toISOString();
    const at = f.clock().toISOString();
    expect(await check('ari', [item(followUp(f.ticket.item_id), before), item(followUp(f.ticket.item_id), sentAt), item(followUp(f.ticket.item_id), at)])).toEqual([CHANGED, SAME, SAME]);
    // Mina and Rafael read the decision, so they see both rows.
    expect(await check('mina', [item(followUp(f.ticket.item_id), at), item(followUp(f.action.item_id), at)])).toEqual([SAME, SAME]);
    expect(await check('rafael', [item(followUp(f.action.item_id), before)])).toEqual([CHANGED]);
    // Mina closes it, then Ari hands it to Rafael: each moves it for whoever still sees it.
    f.advance(1_000);
    await setState(f, 'mina', f.ticket.item_id, 'done');
    expect(await check('mina', [item(followUp(f.ticket.item_id), at)])).toEqual([CHANGED]);
    const closed = f.clock().toISOString();
    expect(await check('ari', [item(followUp(f.ticket.item_id), closed)])).toEqual([SAME]);
    f.advance(1_000);
    await assign(f, 'ari', f.ticket.item_id, 'rafael');
    expect(await check('ari', [item(followUp(f.ticket.item_id), closed)])).toEqual([CHANGED]);
    expect(await check('rafael', [item(followUp(f.ticket.item_id), closed)])).toEqual([CHANGED]);
    // A check of the row changes nothing.
    const checked = f.clock().toISOString();
    f.advance(1_000);
    f.check(f.ticket.item_id, 'changed');
    expect(await check('ari', [item(followUp(f.ticket.item_id), checked)])).toEqual([SAME]);
    // Okafor, who cannot read the decision, sees no row: hidden and never-made follow-ups read the same.
    expect(await check('okafor', [item(followUp(f.ticket.item_id), before), item(followUp('itm_00000000-never-made'), before)])).toEqual([UNREADABLE, UNREADABLE]);
  });

  it('answers every kind in request order, the same source once per turn that cited it', async () => {
    const f = await world();
    const { check } = askCheckOf(f);
    const followUp = { kind: 'follow_up', item_id: f.ticket.item_id };
    const asked = f.clock().toISOString();
    f.editMeeting();
    expect(await check('ari', [item(f.cited.meeting), item(f.decisionCitation), item(followUp, asked), item(f.cited.team), item(followUp, '2026-10-01T00:00:00.000Z'), item(f.cited.meeting)]))
      .toEqual([CHANGED, SAME, SAME, SAME, CHANGED, CHANGED]);
  });

  it('refuses a person whose session or membership is gone, before any read', async () => {
    const f = await world();
    const tickets = ticketTool(async () => new Map());
    const { check } = askCheckOf(f, { live: [tickets] });
    await expect(check('stranger', [item(f.decisionCitation), item(ticket('10012'))])).rejects.toMatchObject({ code: 'unauthorized' });
    f.revoke('mina');
    await expect(check('mina', [item(ticket('10012'))])).rejects.toMatchObject({ code: 'unauthorized' });
    expect(tickets.markers).not.toHaveBeenCalled();
  });
});

describe('Ask source check: unreadable says nothing (ADR-0012)', () => {
  it('answers a hidden, a deleted and a never-existing source of every kind alike, with no marker', async () => {
    const f = await world();
    // The live tools read nothing for these: hidden and deleted tickets and pages simply do not come back.
    const live = [ticketTool(async () => new Map()), pageTool({})];
    const { app, requestOf } = askCheckOf(f, { live });
    const unreadable = [
      item(f.decisionCitation), item({ ...f.decisionCitation, record_sha256: canonicalSha256('never') }),
      item(f.cited.private), item({ ...f.cited.private, source_id: `source:${'0'.repeat(64)}` }),
      item(f.cited.meeting), item({ ...f.cited.meeting, revision_id: 'never-captured' }),
      item({ kind: 'follow_up', item_id: f.ticket.item_id }), item({ kind: 'follow_up', item_id: 'itm_00000000-never' }),
      item(ticket('10012')), item(ticket('99999')), item(page('200')), item(page('99999')),
    ];
    const request = requestOf(unreadable);
    const answer = await app.check({ access_token: 'okafor', request });
    expect(answer.items).toEqual(unreadable.map(() => UNREADABLE));
    expect(JSON.stringify(answer)).toBe(JSON.stringify({ schema_version: 1, kind: 'echo-person-ask-check-v1', items: unreadable.map(() => UNREADABLE) }));
  });

  it('answers a ticket or page cited on another site unreadable without reading it', async () => {
    const f = await world();
    const tickets = ticketTool(async () => new Map([['10012', canonicalSha256('marker')]]));
    const pages = pageTool({ 200: { version: '3' } });
    const { check } = askCheckOf(f, { live: [tickets, pages] });
    const elsewhere = '00000000-0000-4000-8000-0000000000e9';
    expect(await check('ari', [item({ ...ticket('10012'), external_scope_id: elsewhere }), item({ ...page('200'), external_scope_id: elsewhere })])).toEqual([UNREADABLE, UNREADABLE]);
    expect(tickets.markers).not.toHaveBeenCalled();
    expect(pages.versions).not.toHaveBeenCalled();
  });
});

describe('Ask source check: tickets and pages', () => {
  it('returns a readable ticket same with its marker as the baseline, and compares a marker it is given', async () => {
    const f = await world();
    const now = canonicalSha256('ticket now');
    const tickets = ticketTool(async ({ ticket_ids }) => new Map(ticket_ids.filter(id => id !== '10099').map(id => [id, now])));
    const { check } = askCheckOf(f, { live: [tickets] });
    expect(await check('ari', [item(ticket('10012')), item(ticket('10012'), undefined, now), item(ticket('10012'), undefined, canonicalSha256('ticket then')), item(ticket('10099'), undefined, now)]))
      .toEqual([{ state: 'same', marker: now }, { state: 'same', marker: now }, { state: 'changed', marker: now }, UNREADABLE]);
    // One read for the tool, of each ticket once, with the caller's own token.
    expect(tickets.markers).toHaveBeenCalledTimes(1);
    expect(tickets.markers.mock.calls[0]![0]).toMatchObject({ access_token: 'ari', ticket_ids: ['10012', '10099'] });
  });

  it('compares a page by its version, then by its cited section on the current page', async () => {
    const f = await world();
    const cited = 'Pilot starts next week.';
    const pages = pageTool({
      200: { version: '3' },
      // Version 4 added a section above the cited one: the cited text is still on the page.
      201: { version: '4', sections: ['A new first section.', cited] },
      202: { version: '4', sections: ['The pilot moved to next month.'] },
      // Its body is gone by the time it is read: unreadable, never changed.
      203: { version: '4' },
      204: { version: '4', sections: [cited] },
    });
    const { check } = askCheckOf(f, { live: [pages] });
    const inventory = { ...page('204'), section_id: 'inventory', text_sha256: sha256Digest('') };
    expect(await check('ari', [item(page('200')), item(page('201')), item(page('202')), item(page('203')), item(inventory), item(page('205'))]))
      .toEqual([SAME, SAME, CHANGED, UNREADABLE, CHANGED, UNREADABLE]);
    // The unchanged version and the inventory needed no body; three pages did.
    expect(pages.versions).toHaveBeenCalledTimes(1);
    expect(pages.sections).toHaveBeenCalledTimes(1);
    expect(pages.sections.mock.calls[0]![0].page_ids).toEqual(['201', '202', '203']);
  });

  it('answers unknown for a tool that is not connected, fails or is not composed, and reports each failure without content', async () => {
    const f = await world();
    const notConnected = ticketTool(async () => { throw new AuthorityOperationError('unauthorized', 'Jira live evidence operation could not be completed'); });
    const outage = pageTool({}, { versions: new AuthorityOperationError('unavailable', 'Confluence live evidence operation could not be completed') });
    const { check, failures } = askCheckOf(f, { live: [notConnected, outage] });
    expect(await check('ari', [item(ticket('10012')), item(page('200')), item(f.decisionCitation), item({ ...ticket('7'), tool_id: 'linear' })]))
      .toEqual([UNKNOWN, UNKNOWN, SAME, UNKNOWN]);
    expect(failures).toEqual([{ kind: 'person_ask_check_live_read', reason: 'tickets', code: 'unauthorized' }, { kind: 'person_ask_check_live_read', reason: 'pages', code: 'unavailable' }]);
    // A body read that fails leaves the pages that needed it unknown, and the others as their versions said.
    const bodies = pageTool({ 200: { version: '3' }, 201: { version: '4' } }, { sections: new Error('Confluence is down') });
    const second = askCheckOf(f, { live: [bodies] });
    expect(await second.check('ari', [item(page('200')), item(page('201'))])).toEqual([SAME, UNKNOWN]);
    expect(second.failures).toEqual([{ kind: 'person_ask_check_live_read', reason: 'page_bodies', code: 'error' }]);
    // With no live tool composed, tickets and pages are unknown and nothing is reported.
    const none = askCheckOf(f);
    expect(await none.check('ari', [item(ticket('10012')), item(page('200'))])).toEqual([UNKNOWN, UNKNOWN]);
    expect(none.failures).toEqual([]);
  });

  it('reads at most ten page bodies a request, the first pages first, and leaves the rest unknown', async () => {
    const f = await world();
    const cited = 'Pilot starts next week.';
    const ids = Array.from({ length: 12 }, (_, index) => String(300 + index));
    const pages = pageTool(Object.fromEntries(ids.map(id => [id, { version: '4', sections: [cited] }])));
    const { check } = askCheckOf(f, { live: [pages] });
    // Every page twice: a page's body serves every turn that cited it.
    expect(await check('ari', [...ids, ...ids].map(id => item(page(id))))).toEqual([...ids.map((_, index) => (index < 10 ? SAME : UNKNOWN)), ...ids.map((_, index) => (index < 10 ? SAME : UNKNOWN))]);
    expect(pages.versions.mock.calls.map(([input]) => input.page_ids)).toEqual([ids]);
    expect(pages.sections.mock.calls.map(([input]) => input.page_ids)).toEqual([ids.slice(0, 10)]);
  });

  it('reads one tool once for up to a hundred distinct sources, whatever else the request holds', async () => {
    const f = await world();
    const ids = Array.from({ length: 100 }, (_, index) => String(10_000 + index));
    const tickets = ticketTool(async ({ ticket_ids }) => new Map(ticket_ids.map(id => [id, canonicalSha256(id)])));
    const { check } = askCheckOf(f, { live: [tickets] });
    const answers = await check('ari', ids.map(id => item(ticket(id))));
    expect(answers).toEqual(ids.map(id => ({ state: 'same', marker: canonicalSha256(id) })));
    expect(tickets.markers).toHaveBeenCalledTimes(1);
    expect(tickets.markers.mock.calls[0]![0].ticket_ids).toEqual(ids);
  });
});

describe('Ask source check: deadline and cancellation', () => {
  it('answers what finished by the deadline, leaves the rest unknown, and reports the cut read', async () => {
    const f = await world();
    // Jira never answers: only the deadline stops it.
    const slow = ticketTool(({ signal: aborted }) => new Promise((_resolve, reject) => { aborted?.addEventListener('abort', () => reject(aborted.reason), { once: true }); }));
    const pages = pageTool({ 200: { version: '3' } });
    const { check, failures } = askCheckOf(f, { live: [slow, pages], deadline_ms: 50 });
    const started = performance.now();
    expect(await check('ari', [item(ticket('10012')), item(page('200')), item(f.decisionCitation)])).toEqual([UNKNOWN, SAME, SAME]);
    expect(performance.now() - started).toBeLessThan(2_000);
    await vi.waitFor(() => expect(failures).toEqual([{ kind: 'person_ask_check_live_read', reason: 'tickets', code: 'deadline' }]));
    // A read that answers after the deadline changes nothing already answered.
    let release: (value: ReadonlyMap<string, string>) => void = () => {};
    const late = ticketTool(() => new Promise(resolve => { release = resolve; }));
    const second = askCheckOf(f, { live: [late], deadline_ms: 20 });
    expect(await second.check('ari', [item(ticket('10012'))])).toEqual([UNKNOWN]);
    release(new Map([['10012', canonicalSha256('late')]]));
  });

  it('stops a request whose client went away, reporting nothing', async () => {
    const f = await world();
    const controller = new AbortController();
    const hanging = ticketTool(({ signal: aborted }) => new Promise((_resolve, reject) => {
      aborted?.addEventListener('abort', () => reject(aborted.reason), { once: true });
      queueMicrotask(() => controller.abort());
    }));
    const { check, failures } = askCheckOf(f, { live: [hanging] });
    await expect(check('ari', [item(ticket('10012'))], { signal: controller.signal })).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(failures).toEqual([]);
    // Cancelled before it starts, it reads nothing.
    await expect(check('ari', [item(f.decisionCitation)], { signal: AbortSignal.abort() })).rejects.toThrow();
  });
});

describe('Ask source check: cost', () => {
  it('reads the database in one read transaction, writes nothing (no audit row) and takes no write lock', async () => {
    const f = await world({ file: true });
    const inTransaction: boolean[] = [];
    const traced = <T extends (...args: never[]) => unknown>(call: T): T => ((...args: Parameters<T>) => { inTransaction.push(f.db.inTransaction); return call(...args); }) as T;
    const repository = new SqliteProjectContextRepositoryV1(f.db);
    const live = [ticketTool(async ({ ticket_ids }) => { inTransaction.push(f.db.inTransaction); return new Map(ticket_ids.map(id => [id, canonicalSha256(id)])); })];
    const { check } = askCheckOf(f, {
      sessions: { authenticateAccess: traced(f.openItemsOptions.sessions.authenticateAccess) },
      projects: { personChangeView: traced(repository.personChangeView.bind(repository)) },
      records: { readableDecisionProjects: traced(f.records.readableDecisionProjects) },
      originals: { checkSourceRevisions: traced(f.originals.checkSourceRevisions.bind(f.originals)) },
      items: { read: traced(f.items.read.bind(f.items)) },
      people: { people: traced(f.directory.people.bind(f.directory)), leadsAny: traced(f.directory.leadsAny.bind(f.directory)) },
      live,
    });
    const everything = [item(f.decisionCitation), item(f.cited.team), item(f.cited.meeting), item(f.cited.document), item({ kind: 'follow_up', item_id: f.ticket.item_id }), item(ticket('10012'))];
    const audits = () => Object.fromEntries((f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%audit%' ORDER BY name").pluck().all() as string[])
      .map(table => [table, f.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()]));
    const changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
    const before = { audits: audits(), changes: changes(), opens: f.openCitation.mock.calls.length, binds: f.bindDesk.mock.calls.length };
    for (const who of ['ari', 'mina', 'rafael', 'okafor'] as const) await check(who, everything);
    expect({ audits: audits(), changes: changes(), opens: f.openCitation.mock.calls.length, binds: f.bindDesk.mock.calls.length }).toEqual(before);
    // The database reads run inside the check's own read transaction; the live read runs after it.
    expect(inTransaction.length).toBeGreaterThan(4 * 5);
    expect(inTransaction.filter(value => !value)).toHaveLength(4);
    expect(f.db.inTransaction).toBe(false);
    // Another connection holds the write lock: the check still answers.
    const peer = await f.peer();
    f.db.pragma('busy_timeout = 0');
    peer.db.exec('BEGIN IMMEDIATE');
    try {
      expect(await check('ari', everything)).toHaveLength(everything.length);
      expect(() => repository.withReadTransaction(() => 0)).toThrow(/locked|busy/i);
    } finally { peer.db.exec('ROLLBACK'); }
  });
});

describe('Ask source check HTTP route', () => {
  const servers: ReturnType<typeof createOrganizationAuthorityHttpServer>[] = [];
  afterEach(async () => { for (const server of servers.splice(0)) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; } });
  async function origin(person_ask_check?: ReturnType<typeof createPersonAskCheckV1>) {
    const server = createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example',
      ...(person_ask_check === undefined ? {} : { person_ask_check }) });
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('address unavailable');
    return `http://127.0.0.1:${address.port}`;
  }

  it('authenticates like every Person read, validates the request and answers the exact shape', async () => {
    const f = await world();
    const { app } = askCheckOf(f, { live: [ticketTool(async () => new Map([['10012', canonicalSha256('marker')]]))] });
    const base = await origin(app);
    const body = { schema_version: 1, kind: PERSON_ASK_CHECK_REQUEST_KIND_V1, items: [item(f.decisionCitation), item(ticket('10012')), item(f.cited.private)] };
    const post = (authorization: string | null, value: unknown, path: string = PERSON_ASK_CHECK_PATH_V1) => fetch(`${base}${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization === null ? {} : { authorization }) }, body: typeof value === 'string' ? value : JSON.stringify(value) });
    expect((await post(null, body)).status).toBe(401);
    const stranger = await post('Bearer stranger', body);
    expect(stranger.status).toBe(401);
    expect(await stranger.json()).toEqual({ error: { code: 'unauthorized', message: 'request failed' } });
    const response = await post('Bearer ari', body);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const answered = await response.json() as unknown;
    expect(validatePersonAskCheckV1(answered, validatePersonAskCheckRequestV1(body))).toEqual({ schema_version: 1, kind: 'echo-person-ask-check-v1',
      items: [SAME, { state: 'same', marker: canonicalSha256('marker') }, UNREADABLE] });
    // Kinds outside the check, a marker off a ticket, a bad shape, a query and a body over 64 KiB are invalid requests.
    for (const invalid of [
      { ...body, items: [item({ kind: 'project', project_id: 'prj_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10' })] },
      { ...body, items: [item({ kind: 'tool', tool_id: 'jira' })] },
      { ...body, items: [item(f.decisionCitation, undefined, canonicalSha256('marker'))] },
      { ...body, items: [] },
      { ...body, kind: 'echo-person-ask-check-v1' },
      'not json',
    ]) {
      const refused = await post('Bearer ari', invalid);
      expect(refused.status, JSON.stringify(invalid)).toBe(400);
      expect(await refused.json()).toEqual({ error: { code: 'invalid_request', message: 'request failed' } });
    }
    expect((await post('Bearer ari', body, `${PERSON_ASK_CHECK_PATH_V1}?since=1`)).status).toBe(404);
    expect((await post('Bearer ari', `${JSON.stringify(body)}${' '.repeat(64 * 1024)}`)).status).toBe(400);
    // Only POST is served.
    expect((await fetch(`${base}${PERSON_ASK_CHECK_PATH_V1}`, { headers: { authorization: 'Bearer ari' } })).status).toBe(404);
  });

  it('is reserved for the Authority, and unavailable when not composed', async () => {
    expect(() => createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example',
      person_tools: { routes: [{ route_id: 'collision', method: 'POST', path: PERSON_ASK_CHECK_PATH_V1 }], accept: async () => ({ status: 200, body: {} }) } })).toThrow('collides with Authority route');
    const base = await origin();
    const response = await fetch(`${base}${PERSON_ASK_CHECK_PATH_V1}`, { method: 'POST', headers: { authorization: 'Bearer ari', 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 1, kind: PERSON_ASK_CHECK_REQUEST_KIND_V1, items: [item({ kind: 'follow_up', item_id: 'itm_0000-0000' })] }) });
    expect(response.status).toBe(503);
  });
});
