import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  PERSON_CHANGES_AREAS_V1,
  PERSON_CHANGES_ROUTE_V1,
  validatePersonChangesV1,
  validateProjectListV2,
  type PersonChangesAreaV1,
  type ProjectStatusV2,
} from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { createPersonChangesV1, type CreatePersonChangesV1Options, type PersonChangesReviewsFailureV1 } from '../src/composition/person-changes-v1.js';
import { openItemViewerV1, visiblePersonalOpenItemsV1 } from '../src/composition/person-open-items-v1.js';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import { CLOUD, assign, openItemsFixture, sendAll, sentFixture, setState, type FixturePerson, type OpenItemsFixtureV1 } from './fixtures/open-items.js';

const PEOPLE: readonly FixturePerson[] = ['ari', 'mina', 'rafael', 'okafor'];
type Areas = Readonly<Record<PersonChangesAreaV1, string>>;

/** The change check over the open-items fixture's Authority; Ari's reviews are the approval core's proposal statuses for him. */
function changesOf(f: OpenItemsFixtureV1, overrides: Partial<CreatePersonChangesV1Options> = {}, withReviews = true) {
  const app = createPersonChangesV1({
    database: f.db, sessions: f.openItemsOptions.sessions, projects: new SqliteProjectContextRepositoryV1(f.db), items: f.items, people: f.directory, records: f.records,
    ...(withReviews ? { reviews: async () => (person: Parameters<typeof f.core.proposalStatuses>[0]) => f.core.proposalStatuses(person) } : {}),
    ...overrides,
  });
  const read = async (access_token: FixturePerson) => validatePersonChangesV1(await app.read({ access_token }));
  const all = async (): Promise<Record<FixturePerson, Areas>> => Object.fromEntries(await Promise.all(PEOPLE.map(async name => [name, (await read(name)).areas] as const))) as Record<FixturePerson, Areas>;
  /** Which areas moved for each person across `action`. */
  const step = async (action: () => unknown): Promise<Record<FixturePerson, readonly PersonChangesAreaV1[]>> => {
    const before = await all();
    await action();
    const after = await all();
    const movedFor = (name: FixturePerson) => PERSON_CHANGES_AREAS_V1.filter(area => before[name][area] !== after[name][area]);
    return { ari: movedFor('ari'), mina: movedFor('mina'), rafael: movedFor('rafael'), okafor: movedFor('okafor') };
  };
  return { app, read, all, step };
}
const moved = (changes: Partial<Record<FixturePerson, readonly PersonChangesAreaV1[]>>) => ({ ari: [], mina: [], rafael: [], okafor: [], ...changes });
/** The fingerprint the check states for these tuples: their canonical SHA-256 in canonical order. */
const digestOf = (tuples: readonly (readonly (string | null)[])[]) => canonicalSha256([...tuples].sort((left, right) => (canonicalJson(left) < canonicalJson(right) ? -1 : 1)));

const items = (f: OpenItemsFixtureV1, access_token: FixturePerson, scope: 'mine' | 'involved', fields: Record<string, unknown> = {}) =>
  f.app.items({ access_token, request: { schema_version: 1, operation: 'items', scope, ...fields } as never });
const ids = async (f: OpenItemsFixtureV1, who: FixturePerson, scope: 'mine' | 'involved') => (await items(f, who, scope, { read: 'rows' })).items.map(item => item.item_id).sort();
const projectsApp = (f: OpenItemsFixtureV1) => createProjectContextApplicationV1({
  authenticate: access_token => f.openItemsOptions.sessions.authenticateAccess({ access_token }), repository: new SqliteProjectContextRepositoryV1(f.db),
});
const request = () => ({ schema_version: 1 as const, request_id: randomUUID() });

describe('change check: what it answers', () => {
  it("answers one fingerprint per area and the contract's default wait, the same on every read", async () => {
    const f = await sentFixture();
    const { app, read } = changesOf(f);
    const first = await app.read({ access_token: 'mina' });
    expect(Object.keys(first).sort()).toEqual(['areas', 'check_again_after_seconds', 'kind']);
    expect(first.check_again_after_seconds).toBe(60);
    expect(await read('mina')).toEqual(first);
    // Fingerprints are per person: Mina and Ari share a project and a follow-up, not a view.
    expect((await read('ari')).areas.follow_ups).not.toBe(first.areas.follow_ups);
  });

  it('fingerprints exactly what the matching reads list: the V2 project list, runs items involved, and reviews', async () => {
    const f = await sentFixture();
    const { read } = changesOf(f);
    const projects = projectsApp(f);
    f.archiveProject(f.projectB);
    await f.otherProposal();
    for (const who of PEOPLE) {
      const listed: (string | null)[][] = [];
      for (const status of ['active', 'archived'] as const satisfies readonly ProjectStatusV2[]) {
        let cursor: string | undefined;
        do {
          const page = validateProjectListV2(projects.listProjectsV2(who, { limit: 10, status, ...(cursor === undefined ? {} : { cursor }) }));
          listed.push(...page.items.map(project => [project.project_id, project.name, project.status, project.role]));
          cursor = page.next_cursor ?? undefined;
        } while (cursor !== undefined);
      }
      const involved: (string | null)[][] = [];
      let cursor: string | undefined;
      do {
        const page = await items(f, who, 'involved', { read: 'rows', ...(cursor === undefined ? {} : { cursor }) });
        involved.push(...page.items.map(item => [item.item_id, item.state, item.owner.membership_id, item.owner_set_at, item.state_set_at, item.sent_at]));
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      const person = f.openItemsOptions.sessions.authenticateAccess({ access_token: who });
      const reviews = f.core.proposals(person).map(view => [view.approval_id, view.status]);
      expect((await read(who)).areas, who).toEqual({ projects: digestOf(listed), follow_ups: digestOf(involved), reviews: digestOf(reviews) });
    }
    expect((await read('ari')).areas.reviews).not.toBe(canonicalSha256([]));
    // With no personal meeting runtime composed, nobody has a review waiting.
    expect((await changesOf(f, {}, false).read('ari')).areas.reviews).toBe(canonicalSha256([]));
  });

  it('refuses a person whose session or membership is gone', async () => {
    const f = await sentFixture();
    const { app } = changesOf(f);
    await expect(app.read({ access_token: 'stranger' })).rejects.toMatchObject({ code: 'unauthorized' });
    f.revoke('rafael');
    await expect(app.read({ access_token: 'rafael' })).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('answers projects and follow-ups when reviews cannot be read, with no reviews, and reports it', async () => {
    const f = await sentFixture();
    await f.otherProposal();
    const reported: PersonChangesReviewsFailureV1[] = [];
    const whole = await changesOf(f).read('ari');
    const notReady = await changesOf(f, { reviews: async () => { throw new AuthorityOperationError('unavailable', 'approval core unavailable'); }, on_reviews_failure: event => { reported.push(event); } }).read('ari');
    expect(notReady).toEqual({ ...whole, areas: { ...whole.areas, reviews: canonicalSha256([]) } });
    expect(whole.areas.reviews).not.toBe(canonicalSha256([]));
    const unreadable = await changesOf(f, { reviews: async () => () => { throw new Error('proposal row unreadable'); }, on_reviews_failure: event => { reported.push(event); } }).read('ari');
    expect(unreadable).toEqual(notReady);
    expect(reported).toEqual([{ kind: 'person_changes_reviews', reason: 'ready', code: 'unavailable' }, { kind: 'person_changes_reviews', reason: 'read', code: 'error' }]);
  });
});

describe('change check: follow_ups', () => {
  it('moves on a send, done, not relevant, reopen, a reassignment and a handoff, for those involved only; never on a check', async () => {
    const f = await openItemsFixture(); await f.finishImpactRun();
    const { step } = changesOf(f);
    const unsent = (await f.runItems()).items;
    const ticket = unsent.find(item => item.kind === 'ticket')!.item_id;
    const action = unsent.find(item => item.kind === 'record')!.item_id;
    // Ari sent both, Mina owns the ticket: Rafael reads the decision but is involved in nothing, Okafor reads nothing.
    expect(await step(() => sendAll(f, unsent))).toEqual(moved({ ari: ['follow_ups'], mina: ['follow_ups'] }));
    f.advance(1_000);
    // A sweep's check wakes nobody.
    expect(await step(() => { f.check(ticket, 'landed'); f.check(action, 'changed', 'mina'); })).toEqual(moved({}));
    for (const [who, state] of [['mina', 'done'], ['ari', 'open'], ['ari', 'not_relevant'], ['mina', 'open']] as const) {
      f.advance(1_000);
      expect(await step(() => setState(f, who, ticket, state)), `${who} sets ${state}`).toEqual(moved({ ari: ['follow_ups'], mina: ['follow_ups'] }));
    }
    // Ari reassigns the ticket to Rafael: it leaves Mina, reaches Rafael.
    f.advance(1_000);
    expect(await step(() => assign(f, 'ari', ticket, 'rafael'))).toEqual(moved({ ari: ['follow_ups'], mina: ['follow_ups'], rafael: ['follow_ups'] }));
    // Rafael hands it to Okafor: Rafael stays involved as the last to hand it on; Okafor owns it now that it was sent.
    f.advance(1_000);
    expect(await step(() => assign(f, 'rafael', ticket, 'okafor'))).toEqual(moved({ ari: ['follow_ups'], rafael: ['follow_ups'], okafor: ['follow_ups'] }));
    // Okafor hands it to Mina: Rafael is no longer involved, and Okafor, who cannot read the decision, no longer sees it.
    f.advance(1_000);
    expect(await step(() => assign(f, 'okafor', ticket, 'mina'))).toEqual(moved({ ari: ['follow_ups'], mina: ['follow_ups'], rafael: ['follow_ups'], okafor: ['follow_ups'] }));
    // What happens to it now moves nothing of Okafor's, though he was the last to hand it on.
    f.advance(1_000);
    expect(await step(() => setState(f, 'mina', ticket, 'done'))).toEqual(moved({ ari: ['follow_ups'], mina: ['follow_ups'] }));
  });
});

describe('runs items scope involved', () => {
  it('lists what mine lists plus what the caller last handed on, nothing unreadable, and drops it once someone else hands it on', async () => {
    const f = await sentFixture();
    const { ticket, action } = f;
    // The approver and the owner: involved lists what mine lists, page, summary and stages alike.
    for (const who of PEOPLE) {
      for (const fields of [{}, { read: 'rows' }, { read: 'counts' }, { states: ['open'], read: 'rows' }]) {
        expect(await items(f, who, 'involved', fields), `${who} ${JSON.stringify(fields)}`).toEqual(await items(f, who, 'mine', fields));
      }
    }
    expect(await ids(f, 'ari', 'involved')).toEqual([action.item_id, ticket.item_id].sort());
    expect(await ids(f, 'mina', 'involved')).toEqual([ticket.item_id]);
    expect(await ids(f, 'rafael', 'involved')).toEqual([]);
    // Mina hands the ticket to Rafael: no longer hers, but she handed it on.
    await assign(f, 'mina', ticket.item_id, 'rafael');
    expect(await ids(f, 'mina', 'mine')).toEqual([]);
    expect(await ids(f, 'mina', 'involved')).toEqual([ticket.item_id]);
    const handedOn = (await items(f, 'mina', 'involved', { read: 'rows' })).items[0]!;
    expect(handedOn).toMatchObject({ owner: { membership_id: f.membership('rafael') }, owner_set_by: { membership_id: f.membership('mina') }, reach: 'not_read' });
    expect((await items(f, 'mina', 'involved', { read: 'counts' })).summary).toMatchObject({ open: 1, decisions: 1 });
    expect((await items(f, 'mina', 'involved', { states: ['done'], read: 'rows' })).items).toEqual([]);
    expect(await ids(f, 'rafael', 'involved')).toEqual([ticket.item_id]);
    // Rafael hands it to Okafor, who cannot read the decision but owns it now: Mina is no longer involved.
    await assign(f, 'rafael', ticket.item_id, 'okafor');
    expect(await ids(f, 'mina', 'involved')).toEqual([]);
    expect(await ids(f, 'rafael', 'involved')).toEqual([ticket.item_id]);
    expect(await ids(f, 'okafor', 'involved')).toEqual([ticket.item_id]);
    // Okafor hands it on to Mina: he is its last hand, but he cannot read it, so involved never lists it to him.
    await assign(f, 'okafor', ticket.item_id, 'mina');
    expect(await ids(f, 'okafor', 'involved')).toEqual([]);
    expect((await items(f, 'okafor', 'involved', { read: 'counts' })).summary).toMatchObject({ open: 0, decisions: 0 });
    expect(await ids(f, 'rafael', 'involved')).toEqual([]);
    expect(await ids(f, 'mina', 'involved')).toEqual([ticket.item_id]);
    // The approver stays involved through every hand.
    expect(await ids(f, 'ari', 'involved')).toEqual([action.item_id, ticket.item_id].sort());
  });
});

describe('runs items changed_since', () => {
  const since = (f: OpenItemsFixtureV1, who: FixturePerson, scope: 'mine' | 'involved', changed_since: string, fields: Record<string, unknown> = {}) =>
    items(f, who, scope, { read: 'rows', changed_since, ...fields });
  const listed = async (f: OpenItemsFixtureV1, who: FixturePerson, scope: 'mine' | 'involved', changed_since: string, fields: Record<string, unknown> = {}) =>
    (await since(f, who, scope, changed_since, fields)).items.map(item => item.item_id).sort();

  it('lists the items sent, handed on or set at or after a time, before any paging, and the whole scope in the summary', async () => {
    const f = await sentFixture();
    const { ticket, action } = f;
    const sentAt = ticket.sent_at!;
    const at = f.clock().toISOString();
    // Mina closes the ticket at exactly `at`: the boundary is inclusive.
    await setState(f, 'mina', ticket.item_id, 'done');
    const closed = { states: ['done', 'not_relevant'] };
    expect(await listed(f, 'ari', 'involved', at, closed)).toEqual([ticket.item_id]);
    expect(await listed(f, 'mina', 'involved', at, closed)).toEqual([ticket.item_id]);
    expect(await listed(f, 'ari', 'involved', new Date(Date.parse(at) + 1).toISOString(), closed)).toEqual([]);
    // The action was sent before `at` and has not changed since.
    expect(await listed(f, 'ari', 'involved', at)).toEqual([ticket.item_id]);
    expect(await listed(f, 'ari', 'mine', sentAt)).toEqual([action.item_id, ticket.item_id].sort());
    expect(await listed(f, 'ari', 'mine', new Date(Date.parse(sentAt) + 1).toISOString())).toEqual([ticket.item_id]);
    // The summary still counts the whole scope; without the field, mine and involved list everything as before.
    const page = await since(f, 'ari', 'involved', at);
    expect(page.summary).toMatchObject({ open: 1, done: 1, decisions: 1 });
    expect(page.summary).toEqual((await items(f, 'ari', 'involved', { read: 'rows' })).summary);
    expect(await ids(f, 'ari', 'mine')).toEqual([action.item_id, ticket.item_id].sort());
    expect(await ids(f, 'ari', 'involved')).toEqual([action.item_id, ticket.item_id].sort());
    // Rafael, involved in nothing, sees nothing changed.
    expect(await listed(f, 'rafael', 'involved', sentAt)).toEqual([]);
  });

  it('never lists a row the caller cannot read, however recently it changed', async () => {
    const f = await sentFixture();
    const at = f.clock().toISOString();
    // Okafor owns the ticket for a moment and hands it on: he is its last hand, but cannot read its decision.
    await assign(f, 'mina', f.ticket.item_id, 'okafor');
    expect(await listed(f, 'okafor', 'involved', at)).toEqual([f.ticket.item_id]);
    await assign(f, 'okafor', f.ticket.item_id, 'rafael');
    expect(await listed(f, 'okafor', 'involved', at)).toEqual([]);
    expect(await listed(f, 'okafor', 'involved', at, { states: ['open'] })).toEqual([]);
    expect(await listed(f, 'rafael', 'involved', at)).toEqual([f.ticket.item_id]);
  });

  it('pages the changed rows with the same cursor, keeping the filter', async () => {
    const f = await sentFixture();
    f.advance(1_000);
    const run = f.runs.read(f.person, f.runId)!;
    f.db.transaction(() => f.items.insertForRun(f.db, run, Array.from({ length: 53 }, (_, index) => ({
      item_key: canonicalSha256(`changed extra ${index}`), relation: 'conflicts' as const, expected: 'launch next week', owner_membership_id: f.membership('mina'), owner_match: 'jira_account' as const,
      pointer: { kind: 'ticket', tool_id: 'jira', external_scope_id: CLOUD, ticket_id: String(40_000 + index), permalink: `https://echo-fixture.atlassian.net/browse/ECHO-${400 + index}`, text_sha256: canonicalSha256(`changed extra text ${index}`) },
    }))))();
    // More than a page: read from the store, as a run lists them fifty at a time.
    const extra = f.items.forRun(f.runId).filter(row => row.state === 'unsent').map(row => ({ item_id: row.item_id }));
    expect(extra).toHaveLength(53);
    f.advance(1_000);
    const at = f.clock().toISOString();
    for (let start = 0; start < extra.length; start += 10) await sendAll(f, extra.slice(start, start + 10), `send-changed-${start}`);
    const first = await since(f, 'mina', 'involved', at);
    expect(first.items).toHaveLength(50);
    expect(first.next_cursor).not.toBeNull();
    const second = await since(f, 'mina', 'involved', at, { cursor: first.next_cursor });
    expect(second.items).toHaveLength(3);
    expect(second.next_cursor).toBeNull();
    // Only the newly sent items, oldest first, never the ticket sent before `at`.
    expect([...first.items, ...second.items].map(item => item.item_id).sort()).toEqual(extra.map(item => item.item_id).sort());
    expect([...first.items, ...second.items].map(item => item.item_id)).not.toContain(f.ticket.item_id);
    // Without the filter, the same cursor position pages the whole list.
    expect((await items(f, 'mina', 'involved', { read: 'rows' })).items.map(item => item.item_id)).toContain(f.ticket.item_id);
  });
});

describe('change check: projects', () => {
  it('moves on an add, a removal, a rename, an archive and a role change, for the members whose own rows changed', async () => {
    const f = await openItemsFixture();
    const { step, read } = changesOf(f);
    const projects = projectsApp(f);
    const project_id = f.projectA;
    expect(await step(() => projects.renameProject('ari', { ...request(), kind: 'echo-project-rename-v1', project_id, name: 'Pilot launch' })))
      .toEqual(moved({ ari: ['projects'], mina: ['projects'], rafael: ['projects'] }));
    expect(await step(() => projects.setMember('ari', { ...request(), kind: 'echo-project-member-set-v1', project_id, membership_id: f.membership('mina'), role: 'lead' })))
      .toEqual(moved({ mina: ['projects'] }));
    const beforeArchive = (await read('rafael')).areas.projects;
    expect(await step(() => projects.archiveProject('ari', { ...request(), kind: 'echo-project-archive-v1', project_id, archived: true })))
      .toEqual(moved({ ari: ['projects'], mina: ['projects'], rafael: ['projects'] }));
    expect(await step(() => projects.archiveProject('ari', { ...request(), kind: 'echo-project-archive-v1', project_id, archived: false })))
      .toEqual(moved({ ari: ['projects'], mina: ['projects'], rafael: ['projects'] }));
    // The same rows, the same fingerprint.
    expect((await read('rafael')).areas.projects).toBe(beforeArchive);
    expect(await step(() => projects.addMember('ari', { ...request(), kind: 'echo-project-member-add-v1', project_id, membership_id: f.membership('okafor') })))
      .toEqual(moved({ okafor: ['projects'] }));
    expect(await step(() => projects.removeMember('ari', { ...request(), kind: 'echo-project-member-remove-v1', project_id, membership_id: f.membership('okafor') })))
      .toEqual(moved({ okafor: ['projects'] }));
    // A project created elsewhere moves only its creator's projects.
    expect(await step(() => projects.createProject('okafor', { ...request(), kind: 'echo-project-create-v1', name: 'Okafor private' })))
      .toEqual(moved({ okafor: ['projects'] }));
  });
});

describe('change check: reviews', () => {
  it("moves when a meeting is ready for the reviewer and when it is decided, and for nobody else", async () => {
    const f = await openItemsFixture();
    const { step } = changesOf(f);
    let approvalId = '';
    expect(await step(async () => { approvalId = (await f.otherProposal()).approvalId; })).toEqual(moved({ ari: ['reviews'] }));
    expect(await step(() => f.core.decide('desktop', f.reject({ approval_id: approvalId, command_id: 'desk-reject-other' }), () => f.session)))
      .toEqual(moved({ ari: ['reviews'] }));
  });
});

describe('change check: privacy (ADR-0012)', () => {
  it("leaves every fingerprint of a person unchanged by others' changes to items and projects that person cannot read", async () => {
    // Okafor is matched as the ticket's owner, but cannot read its decision and is never sent it.
    const f = await openItemsFixture({ ticketOwner: 'okafor' }); await f.finishImpactRun();
    const { read } = changesOf(f);
    const unsent = (await f.runItems()).items;
    const ticket = unsent.find(item => item.kind === 'ticket')!;
    expect(ticket.owner.membership_id).toBe(f.membership('okafor'));
    expect(await ids(f, 'okafor', 'involved')).toEqual([]);
    const revision = () => f.db.prepare('SELECT revision FROM authority_project_authorization_state_v1').pluck().get() as number;
    const startRevision = revision();
    const okafor = (await read('okafor')).areas;
    const rafael = (await read('rafael')).areas;
    // Ari picks Mina for the ticket before Send, sends it, Mina closes it, Ari reopens it, and a sweep checks it.
    await assign(f, 'ari', ticket.item_id, 'mina');
    f.advance(1_000);
    await sendAll(f, unsent);
    f.advance(1_000);
    await setState(f, 'mina', ticket.item_id, 'done');
    f.advance(1_000);
    await setState(f, 'ari', ticket.item_id, 'open');
    f.check(ticket.item_id, 'changed');
    // Projects Okafor is not in are renamed, archived and joined.
    const projects = projectsApp(f);
    await projects.renameProject('ari', { ...request(), kind: 'echo-project-rename-v1', project_id: f.projectA, name: 'Renamed pilot' });
    await projects.setMember('ari', { ...request(), kind: 'echo-project-member-set-v1', project_id: f.projectA, membership_id: f.membership('rafael'), role: 'lead' });
    f.db.prepare("UPDATE authority_projects_v1 SET name='Renamed C' WHERE project_id=?").run(f.projectC);
    f.archiveProject(f.projectB);
    // A meeting waits for Ari's review, and is decided.
    const other = await f.otherProposal();
    f.core.decide('desktop', f.reject({ approval_id: other.approvalId, command_id: 'desk-reject-other' }), () => f.session);
    // The organization's authorization revision moved; nothing that stands in for it reached Okafor.
    expect(revision()).toBeGreaterThan(startRevision);
    expect((await read('okafor')).areas).toEqual(okafor);
    // Rafael reads the decision and is in project A, but is involved in no follow-up: only his own role moved.
    const after = (await read('rafael')).areas;
    expect(after.follow_ups).toBe(rafael.follow_ups);
    expect(after.reviews).toBe(rafael.reviews);
    expect(after.projects).not.toBe(rafael.projects);
  });

  it('reads every involved row before any bound, so a change to an unreadable item never moves another row into view', async () => {
    const f = await sentFixture();
    // Mina hands the ticket to Okafor, who owns it (it was sent), then he hands it on to Rafael: as its last hand Okafor is
    // involved, but he cannot read its decision, so he never sees it. It is his oldest involved row.
    await assign(f, 'mina', f.ticket.item_id, 'okafor');
    await assign(f, 'okafor', f.ticket.item_id, 'rafael');
    // Three newer items, sent to Okafor, which he sees as their owner.
    f.advance(1_000);
    const run = f.runs.read(f.person, f.runId)!;
    f.db.transaction(() => f.items.insertForRun(f.db, run, Array.from({ length: 3 }, (_, index) => ({
      item_key: canonicalSha256(`okafor extra ${index}`), relation: 'conflicts' as const, expected: 'launch next week', owner_membership_id: f.membership('okafor'), owner_match: 'jira_account' as const,
      pointer: { kind: 'ticket', tool_id: 'jira', external_scope_id: CLOUD, ticket_id: String(30_000 + index), permalink: `https://echo-fixture.atlassian.net/browse/ECHO-${300 + index}`, text_sha256: canonicalSha256(`okafor extra text ${index}`) },
    }))))();
    const extra = (await f.runItems()).items.filter(item => item.state === 'unsent');
    expect(extra).toHaveLength(3);
    await sendAll(f, extra, 'send-extra');
    expect(await ids(f, 'okafor', 'involved')).toEqual(extra.map(item => item.item_id).sort());
    // Read a page at a time, two rows a page: the unreadable ticket and the first new item fill the first page.
    const viewer = openItemViewerV1('okafor', f.openItemsOptions.sessions.authenticateAccess({ access_token: 'okafor' }));
    const seen = (page?: number) => visiblePersonalOpenItemsV1(f.openItemsOptions, viewer, 'involved', page).assessed.map(entry => entry.row.item_id).sort();
    const { read } = changesOf(f);
    const before = (await read('okafor')).areas.follow_ups;
    for (const page of [1, 2, undefined]) expect(seen(page), `page ${String(page)}`).toEqual(extra.map(item => item.item_id).sort());
    expect(() => seen(0)).toThrow('positive whole number');
    // Rafael hands the ticket on: it leaves Okafor's involvement, which he could never see.
    f.advance(1_000);
    await assign(f, 'rafael', f.ticket.item_id, 'mina');
    for (const page of [1, 2, undefined]) expect(seen(page), `page ${String(page)}`).toEqual(extra.map(item => item.item_id).sort());
    expect((await read('okafor')).areas.follow_ups).toBe(before);
  });
});

describe('change check: cost', () => {
  it('reads in one read transaction, writes nothing (no audit row), reads nothing live and takes no write lock', async () => {
    const f = await sentFixture({ file: true });
    const inTransaction: boolean[] = [];
    const seen = <T extends (...args: never[]) => unknown>(call: T): T => ((...args: Parameters<T>) => { inTransaction.push(f.db.inTransaction); return call(...args); }) as T;
    const repository = new SqliteProjectContextRepositoryV1(f.db);
    const reviewer = (person: Parameters<typeof f.core.proposalStatuses>[0]) => f.core.proposalStatuses(person);
    const inTransactionBy = new Map<string, boolean[]>();
    const traced = <T extends (...args: never[]) => unknown>(name: string, call: T): T => seen(((...args: Parameters<T>) => {
      inTransactionBy.set(name, [...(inTransactionBy.get(name) ?? []), f.db.inTransaction]);
      return call(...args);
    }) as T);
    const { app } = changesOf(f, {
      sessions: { authenticateAccess: traced('sessions', f.openItemsOptions.sessions.authenticateAccess) },
      projects: { personChangeView: traced('projects', repository.personChangeView.bind(repository)) },
      items: { involving: traced('items', f.items.involving.bind(f.items)) },
      people: { people: traced('people', f.directory.people.bind(f.directory)), leadsAny: traced('leads', f.directory.leadsAny.bind(f.directory)) },
      records: { readableDecisionProjects: traced('records', f.records.readableDecisionProjects) },
      reviews: async () => traced('reviews', reviewer),
    });
    const audits = () => Object.fromEntries((f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%audit%' ORDER BY name").pluck().all() as string[])
      .map(table => [table, f.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()]));
    const changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
    const before = { audits: audits(), changes: changes(), binds: f.bindDesk.mock.calls.length, opens: f.openCitation.mock.calls.length };
    for (const who of PEOPLE) await app.read({ access_token: who });
    expect({ audits: audits(), changes: changes(), binds: f.bindDesk.mock.calls.length, opens: f.openCitation.mock.calls.length }).toEqual(before);
    // Every database read after the session check runs inside the one read transaction: projects, items, people, records, reviews.
    expect([...inTransactionBy.keys()].sort()).toEqual(['items', 'leads', 'people', 'projects', 'records', 'reviews', 'sessions']);
    expect(inTransactionBy.get('reviews')).toHaveLength(PEOPLE.length);
    expect(inTransaction.length).toBeGreaterThan(PEOPLE.length * 4);
    expect(inTransaction.every(Boolean)).toBe(true);
    expect(f.db.inTransaction).toBe(false);
    // Another connection holds the write lock: the check still answers, where a read that takes the write lock cannot.
    const peer = await f.peer();
    f.db.pragma('busy_timeout = 0');
    peer.db.exec('BEGIN IMMEDIATE');
    try {
      for (const who of PEOPLE) expect(validatePersonChangesV1(await app.read({ access_token: who })).kind).toBe('echo-person-changes-v1');
      expect(() => repository.withReadTransaction(() => 0)).toThrow(/locked|busy/i);
    } finally { peer.db.exec('ROLLBACK'); }
    expect(f.db.inTransaction).toBe(false);
  });
});

describe('change check HTTP route', () => {
  const servers: ReturnType<typeof createOrganizationAuthorityHttpServer>[] = [];
  afterEach(async () => { for (const server of servers.splice(0)) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; } });
  async function origin(person_changes?: ReturnType<typeof createPersonChangesV1>, sessions: unknown = {}) {
    const server = createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: sessions as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example',
      ...(person_changes === undefined ? {} : { person_changes }) });
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('address unavailable');
    return `http://127.0.0.1:${address.port}`;
  }

  it('authenticates like every Person read, answers the exact shape, and takes no query or body', async () => {
    const f = await sentFixture();
    const { app, read } = changesOf(f);
    const base = await origin(app, f.openItemsOptions.sessions);
    const get = (authorization: string | null, path: string = PERSON_CHANGES_ROUTE_V1) => fetch(`${base}${path}`, { headers: authorization === null ? {} : { authorization } });
    expect((await get(null)).status).toBe(401);
    const stranger = await get('Bearer stranger');
    expect(stranger.status).toBe(401);
    expect(await stranger.json()).toEqual({ error: { code: 'unauthorized', message: 'request failed' } });
    const response = await get('Bearer mina');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(validatePersonChangesV1(body)).toEqual(body);
    expect(body).toEqual(await read('mina'));
    expect((await get('Bearer mina', `${PERSON_CHANGES_ROUTE_V1}?since=1`)).status).toBe(400);
    // The session is checked before the request's shape, as capabilities checks it.
    expect((await get('Bearer stranger', `${PERSON_CHANGES_ROUTE_V1}?since=1`)).status).toBe(401);
    const withBody = (authorization: string) => new Promise<number>((resolve, reject) => {
      const url = new URL(`${base}${PERSON_CHANGES_ROUTE_V1}`);
      const sent = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers: { authorization, 'content-type': 'application/json', 'content-length': '2' } },
        response => { response.resume(); resolve(response.statusCode ?? 0); });
      sent.on('error', reject);
      sent.end('{}');
    });
    expect(await withBody('Bearer mina')).toBe(400);
    expect(await withBody('Bearer stranger')).toBe(401);
    // Only GET is served; another method finds no route.
    expect((await fetch(`${base}${PERSON_CHANGES_ROUTE_V1}`, { method: 'POST', headers: { authorization: 'Bearer mina', 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
  });

  it('is reserved for the Authority, and unavailable when not composed', async () => {
    expect(() => createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example',
      person_tools: { routes: [{ route_id: 'collision', method: 'GET', path: PERSON_CHANGES_ROUTE_V1 }], accept: async () => ({ status: 200, body: {} }) } })).toThrow('collides with Authority route');
    const base = await origin();
    expect((await fetch(`${base}${PERSON_CHANGES_ROUTE_V1}`, { headers: { authorization: 'Bearer mina' } })).status).toBe(503);
  });
});
