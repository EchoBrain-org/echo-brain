import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Digest, type Sha256Digest } from '@echo-brain/federation-protocol';
import { PERSON_PROJECT_ACTIVITY_PATH_V1, validatePersonProjectActivityV1 } from '@echo-brain/organization-api';
import { composeRecordApproverProjectorsV1 } from '@echo-brain/organization-record/organization-record-api-v1';
import { SqlitePersonDocumentRepositoryV1 } from '../src/adapters/persistence/sqlite/document-v1.js';
import { SqlitePersonProjectActivityV1 } from '../src/adapters/persistence/sqlite/person-project-activity-v1.js';
import { SqlitePersonRecordReadAuditV1 } from '../src/adapters/persistence/sqlite/person-record-read-audit-v1.js';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { createPersonDocumentApplicationV1 } from '../src/application/document-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { AUTHORITY_RECORD_APPROVER_PROJECTORS_V1, AUTHORITY_RECORD_INPUT_CODECS_V1 } from '../src/composition/authority-record-protocols-v1.js';
import { createPersonProjectActivityV1, type CreatePersonProjectActivityV1Options } from '../src/composition/person-project-activity-v1.js';
import { createRecordProjectAuthorizationV1 } from '../src/composition/person-record-project-scope-v1.js';
import { createPersonRecordSearchRouteV1, type CreatePersonRecordSearchRouteV1Options, type PersonRecordSearchRouteV1 } from '../src/composition/person-record-search-route.js';
import { readableSearchGenerationContractV1 } from '../src/composition/readable-search-generation-composition.js';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import { assign, openItemsFixture, sendAll, setState, type FixturePerson, type OpenItemsFixtureV1 } from './fixtures/open-items.js';
import { OWNER, PROJ_X, SHARED, UNJOINED, meetingWorld } from './fixtures/person-meeting-world.js';

/**
 * Project activity over the open-items fixture's Authority and its real record log: Ari approved a meeting into project A,
 * whose members are Ari (lead), Mina and Rafael; Ari is also in project B; project C is another person's; S. Okafor is in no
 * project.
 */
const PEOPLE: readonly FixturePerson[] = ['ari', 'mina', 'rafael', 'okafor'];
type Audience = { readonly kind: 'only_me' | 'team' } | { readonly kind: 'project'; readonly project_id: string } | { readonly kind: 'projects'; readonly project_ids: readonly string[] };

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** The records route over the fixture's record log, composed as the runtime composes it. */
function recordRoute(f: OpenItemsFixtureV1, overrides: Partial<CreatePersonRecordSearchRouteV1Options> = {}): PersonRecordSearchRouteV1 {
  const state_directory = mkdtempSync(join(tmpdir(), 'echo-project-activity-')); directories.push(state_directory);
  return createPersonRecordSearchRouteV1({
    state_directory, ...f.context.coordinates, retrieval_contract_sha256: readableSearchGenerationContractV1().retrieval_contract_sha256,
    sessions: f.openItemsOptions.sessions, authority: f.db, record: f.recordLog, audit: new SqlitePersonRecordReadAuditV1(f.db),
    capture_projects: createRecordProjectAuthorizationV1(new SqliteProjectContextRepositoryV1(f.db)),
    record_input_codecs: AUTHORITY_RECORD_INPUT_CODECS_V1, record_approver: composeRecordApproverProjectorsV1(AUTHORITY_RECORD_APPROVER_PROJECTORS_V1),
    ...overrides,
  });
}

function activityOf(f: OpenItemsFixtureV1, overrides: Partial<CreatePersonProjectActivityV1Options> = {}) {
  const rows = new SqlitePersonProjectActivityV1(f.db);
  const app = createPersonProjectActivityV1({
    database: f.db, sessions: f.openItemsOptions.sessions, projects: new SqliteProjectContextRepositoryV1(f.db),
    originals: rows, approvals: rows, items: f.items, people: f.directory, records: recordRoute(f), ...overrides,
  });
  const read = async (access_token: FixturePerson) => validatePersonProjectActivityV1(await app.read({ access_token }));
  /** Each listed project's latest_at, by project id. */
  const latest = async (who: FixturePerson): Promise<Record<string, string | null>> => Object.fromEntries((await read(who)).items.map(item => [item.project_id, item.latest_at]));
  const all = async () => Object.fromEntries(await Promise.all(PEOPLE.map(async who => [who, await latest(who)] as const))) as Record<FixturePerson, Record<string, string | null>>;
  return { app, read, latest, all };
}

/** Notes and documents, filed as people file them, on the fixture's clock. */
function originalsOf(f: OpenItemsFixtureV1) {
  const now = () => f.clock().toISOString();
  const authenticate = (access_token: string) => f.openItemsOptions.sessions.authenticateAccess({ access_token });
  const projects = createProjectContextApplicationV1({ authenticate, repository: new SqliteProjectContextRepositoryV1(f.db, now) });
  const documents = createPersonDocumentApplicationV1({ authenticate, repository: new SqlitePersonDocumentRepositoryV1(f.db, now) });
  return {
    note: (who: FixturePerson, audience: Audience, association_project_ids: readonly string[]) => projects.submitUploadV3(who, {
      schema_version: 3, kind: 'echo-person-update-submit-v3', request_id: randomUUID(), title: 'Pilot note', text: 'The pilot moves a week.', association_project_ids, audience,
    }).context_id,
    document: (who: FixturePerson, audience: Audience, association_project_ids: readonly string[]) => {
      const bytes = Buffer.from('The pilot plan.');
      const saved = documents.uploadV2(who, { schema_version: 2, kind: 'echo-person-document-upload-v2', request_id: randomUUID(), filename: 'plan.md', title: 'Pilot plan',
        content_length: bytes.byteLength, sha256: sha256Digest(bytes), audience, association_project_ids }, bytes);
      return (saved as { readonly document_id: string }).document_id;
    },
    fileNote: (who: FixturePerson, context_id: string, project_id: string) =>
      projects.associateContext(who, { schema_version: 1, kind: 'echo-project-context-associate-v1', request_id: randomUUID(), project_id, context_id }),
    unfileNote: (who: FixturePerson, context_id: string, project_id: string) =>
      projects.dissociateContext(who, { schema_version: 1, kind: 'echo-project-context-dissociate-v1', request_id: randomUUID(), project_id, context_id }),
    fileDocument: (who: FixturePerson, document_id: string, project_id: string) =>
      documents.associate(who, { schema_version: 1, kind: 'echo-person-document-associate-v1', request_id: randomUUID(), document_id, project_id }),
  };
}

/** When a record arrived: its receipt time, as the log stores it. */
const arrivalOf = (f: OpenItemsFixtureV1, record: string = f.record): string =>
  new Date(f.recordLog.prepare('SELECT receipt_issued_at FROM organization_record_log WHERE record_sha256 = ?').pluck().get(record) as string).toISOString();
/** The fixture's clock a minute after the approved record arrived, so whatever happens next is newer. */
function afterArrival(f: OpenItemsFixtureV1): void {
  f.advance(Date.parse(arrivalOf(f)) + 60_000 - f.clock().getTime());
}
/** A second later on the fixture's clock: when whatever happens next happens. */
function tick(f: OpenItemsFixtureV1): string {
  f.advance(1_000);
  return f.clock().toISOString();
}
const grant = (f: OpenItemsFixtureV1, who: FixturePerson, project_id: string) => f.db.prepare(`INSERT INTO authority_project_memberships_v1
  (project_membership_id, project_id, organization_id, principal_id, membership_id, membership_type, role, status, granted_at)
  VALUES (?, ?, ?, ?, ?, ?, 'member', 'active', ?)`).run(`pgm_${randomUUID()}`, project_id, f.person.organization_id, f.people[who].principal_id, f.people[who].membership_id, f.people[who].membership_type, f.clock().toISOString());
/** Ari approves another meeting of his source into these projects, and it is published. */
async function approveAnother(f: OpenItemsFixtureV1, projectIds: readonly string[], external: string): Promise<Sha256Digest> {
  const other = await f.otherProposal(true, external);
  f.core.decide('desktop', f.approve({ approval_id: other.approvalId, command_id: `desk-approve-${external}`, routes: f.routes(projectIds, other.approvalId) }), () => f.session);
  await f.publisher([]).appendFinalizedApprovalsToV4(new AbortController().signal);
  return f.recordLog.prepare('SELECT record_sha256 FROM organization_record_log ORDER BY position DESC LIMIT 1').pluck().get() as Sha256Digest;
}

describe('project activity: what it answers', () => {
  it('lists every active project the caller is a member of, newest first, null where nothing arrived from anyone else', async () => {
    const f = await openItemsFixture();
    const { app, read, latest } = activityOf(f);
    const first = await app.read({ access_token: 'mina' });
    expect(Object.keys(first).sort()).toEqual(['items', 'kind', 'schema_version']);
    expect(first).toEqual({ schema_version: 1, kind: 'echo-person-project-activity-v1', items: [{ project_id: f.projectA, latest_at: arrivalOf(f) }] });
    // The same rows, the same answer.
    expect(await read('mina')).toEqual(first);
    // Ari approved the only meeting, so nothing in A or B came from anyone else; C is another person's; Okafor is in nothing.
    expect((await read('ari')).items).toEqual([{ project_id: f.projectA, latest_at: null }, { project_id: f.projectB, latest_at: null }]);
    expect(await latest('rafael')).toEqual({ [f.projectA]: arrivalOf(f) });
    expect((await read('okafor')).items).toEqual([]);
  });

  it('leaves out archived projects and projects the caller left', async () => {
    const f = await openItemsFixture();
    const { latest } = activityOf(f);
    f.archiveProject(f.projectB);
    expect(await latest('ari')).toEqual({ [f.projectA]: null });
    f.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked', revoked_at=? WHERE project_id=? AND membership_id=? AND status='active'")
      .run(f.clock().toISOString(), f.projectA, f.membership('rafael'));
    expect(await latest('rafael')).toEqual({});
    expect(await latest('mina')).toEqual({ [f.projectA]: arrivalOf(f) });
  });

  it('refuses a person whose session or membership is gone', async () => {
    const f = await openItemsFixture();
    const { app } = activityOf(f);
    await expect(app.read({ access_token: 'stranger' })).rejects.toMatchObject({ code: 'unauthorized' });
    f.revoke('rafael');
    await expect(app.read({ access_token: 'rafael' })).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('project activity: what moves it', () => {
  it('moves on a note filed into the project by someone else, when it was filed, and not on the caller\'s own', async () => {
    const f = await openItemsFixture();
    afterArrival(f);
    const { all } = activityOf(f);
    const originals = originalsOf(f);
    const recordAt = arrivalOf(f);
    const noteAt = tick(f);
    const note = originals.note('mina', { kind: 'team' }, [f.projectA]);
    expect(await all()).toEqual({ ari: { [f.projectA]: noteAt, [f.projectB]: null }, mina: { [f.projectA]: recordAt }, rafael: { [f.projectA]: noteAt }, okafor: {} });
    // Mina files an earlier unfiled note later: it arrived in A when she filed it.
    const unfiled = originals.note('mina', { kind: 'team' }, []);
    tick(f);
    const filedAt = tick(f);
    originals.fileNote('mina', unfiled, f.projectA);
    expect((await all()).rafael).toEqual({ [f.projectA]: filedAt });
    // Taken out of the project, it no longer counts.
    originals.unfileNote('mina', unfiled, f.projectA);
    expect((await all()).rafael).toEqual({ [f.projectA]: noteAt });
    // Ari files his own note into B: news to nobody, as no one else is in B.
    tick(f);
    originals.note('ari', { kind: 'team' }, [f.projectA, f.projectB]);
    expect((await all()).ari).toEqual({ [f.projectA]: noteAt, [f.projectB]: null });
    expect(note).toMatch(/^ctx_/);
  });

  it('moves on a document filed into the project by someone else, at upload or filed later, and not on the caller\'s own', async () => {
    const f = await openItemsFixture();
    afterArrival(f);
    const { all } = activityOf(f);
    const originals = originalsOf(f);
    const recordAt = arrivalOf(f);
    const uploadedAt = tick(f);
    originals.document('rafael', { kind: 'project', project_id: f.projectA }, [f.projectA]);
    expect(await all()).toEqual({ ari: { [f.projectA]: uploadedAt, [f.projectB]: null }, mina: { [f.projectA]: uploadedAt }, rafael: { [f.projectA]: recordAt }, okafor: {} });
    // Uploaded unfiled, filed into A later by its uploader: it arrived when it was filed.
    const later = originals.document('mina', { kind: 'team' }, []);
    tick(f);
    const filedAt = tick(f);
    originals.fileDocument('mina', later, f.projectA);
    expect(await all()).toEqual({ ari: { [f.projectA]: filedAt, [f.projectB]: null }, mina: { [f.projectA]: uploadedAt }, rafael: { [f.projectA]: filedAt }, okafor: {} });
  });

  it('moves on a meeting approved into the project by someone else, the newest one, never on the caller\'s own approval', async () => {
    const f = await openItemsFixture();
    const { latest } = activityOf(f);
    expect(await latest('mina')).toEqual({ [f.projectA]: arrivalOf(f) });
    const second = await approveAnother(f, [f.projectA], 'note-2');
    expect(second).not.toBe(f.record);
    expect(await latest('mina')).toEqual({ [f.projectA]: arrivalOf(f, second) });
    expect(await latest('rafael')).toEqual({ [f.projectA]: arrivalOf(f, second) });
    // Both are Ari's own approvals.
    expect(await latest('ari')).toEqual({ [f.projectA]: null, [f.projectB]: null });
    // A meeting approved into B only: Mina and Rafael are not in B, and to Ari it is his own.
    await approveAnother(f, [f.projectB], 'note-3');
    expect(await latest('ari')).toEqual({ [f.projectA]: null, [f.projectB]: null });
    expect(await latest('mina')).toEqual({ [f.projectA]: arrivalOf(f, second) });
  });

  it("knows the caller's own approval by their published decision, and by the approver its signed record names before the decision's receipt is written", async () => {
    const f = await openItemsFixture();
    const nothingPublished = { approvedRecords: () => new Set<string>() };
    // The decision alone, with no approver projectors in the records route.
    expect(await activityOf(f, { records: recordRoute(f, { record_approver: undefined }) }).latest('ari')).toEqual({ [f.projectA]: null, [f.projectB]: null });
    // The signed record alone, as while the publisher has appended the record but not yet written the decision's receipt.
    expect(await activityOf(f, { approvals: nothingPublished }).latest('ari')).toEqual({ [f.projectA]: null, [f.projectB]: null });
    // With neither, the record would read as someone else's: each one is what keeps it Ari's own.
    expect(await activityOf(f, { approvals: nothingPublished, records: recordRoute(f, { record_approver: undefined }) }).latest('ari'))
      .toEqual({ [f.projectA]: arrivalOf(f), [f.projectB]: null });
  });

  it('moves on a follow-up someone else sent, handed on or set, for those who read its decision; never on a check or their own move', async () => {
    const f = await openItemsFixture();
    afterArrival(f);
    const { all } = activityOf(f);
    const recordAt = arrivalOf(f);
    await f.finishImpactRun();
    // The impact run found the items: none was moved by anyone yet.
    expect(await all()).toEqual({ ari: { [f.projectA]: null, [f.projectB]: null }, mina: { [f.projectA]: recordAt }, rafael: { [f.projectA]: recordAt }, okafor: {} });
    const unsent = (await f.runItems()).items;
    const ticket = unsent.find(item => item.kind === 'ticket')!.item_id;
    const sentAt = tick(f);
    await sendAll(f, unsent);
    // Ari sent them: news to Mina, who owns the ticket, and to Rafael, who reads the decision; Ari's own send is not.
    expect(await all()).toEqual({ ari: { [f.projectA]: null, [f.projectB]: null }, mina: { [f.projectA]: sentAt }, rafael: { [f.projectA]: sentAt }, okafor: {} });
    // A sweep's check moves nothing.
    tick(f);
    f.check(ticket, 'landed', 'mina');
    expect((await all()).rafael).toEqual({ [f.projectA]: sentAt });
    const doneAt = tick(f);
    await setState(f, 'mina', ticket, 'done');
    expect(await all()).toEqual({ ari: { [f.projectA]: doneAt, [f.projectB]: null }, mina: { [f.projectA]: sentAt }, rafael: { [f.projectA]: doneAt }, okafor: {} });
    // Ari reopens it and hands it to Rafael: Rafael and Mina see it moved. The row keeps only its last state change, Ari's own,
    // so to Ari nothing someone else did is left.
    tick(f);
    await setState(f, 'ari', ticket, 'open');
    const handedAt = tick(f);
    await assign(f, 'ari', ticket, 'rafael');
    expect(await all()).toEqual({ ari: { [f.projectA]: null, [f.projectB]: null }, mina: { [f.projectA]: handedAt }, rafael: { [f.projectA]: handedAt }, okafor: {} });
  });

  it('takes the newest of every source', async () => {
    const f = await openItemsFixture();
    afterArrival(f);
    const { latest } = activityOf(f);
    const originals = originalsOf(f);
    await f.finishImpactRun();
    const unsent = (await f.runItems()).items;
    tick(f);
    await sendAll(f, unsent);
    const noteAt = tick(f);
    originals.note('rafael', { kind: 'team' }, [f.projectA]);
    expect(await latest('mina')).toEqual({ [f.projectA]: noteAt });
    const handedAt = tick(f);
    await assign(f, 'ari', unsent.find(item => item.kind === 'ticket')!.item_id, 'rafael');
    expect(await latest('mina')).toEqual({ [f.projectA]: handedAt });
    const documentAt = tick(f);
    originals.document('ari', { kind: 'team' }, [f.projectA]);
    expect(await latest('mina')).toEqual({ [f.projectA]: documentAt });
  });
});

describe('project activity: only what the caller can read', () => {
  it('never counts a note or a document the caller cannot read, or a quarantined note', async () => {
    const f = await openItemsFixture();
    afterArrival(f);
    const { all, latest } = activityOf(f);
    const originals = originalsOf(f);
    const recordAt = arrivalOf(f);
    const before = await all();
    // Mina files a note only she reads, and a document only project B reads (she is in B for this), into A.
    grant(f, 'mina', f.projectB);
    tick(f);
    originals.note('mina', { kind: 'only_me' }, [f.projectA]);
    tick(f);
    originals.document('mina', { kind: 'only_me' }, [f.projectA]);
    const shared = tick(f);
    originals.document('mina', { kind: 'project', project_id: f.projectB }, [f.projectA]);
    // Rafael, in A but not in B, reads neither; Ari, in B, reads the document shared with B.
    expect(await latest('rafael')).toEqual(before.rafael);
    expect(await latest('ari')).toEqual({ [f.projectA]: shared, [f.projectB]: null });
    expect(await latest('mina')).toEqual({ [f.projectA]: recordAt, [f.projectB]: null });
    // A team note, until the source inbox quarantines it.
    const noteAt = tick(f);
    const note = originals.note('mina', { kind: 'team' }, [f.projectA]);
    expect(await latest('rafael')).toEqual({ [f.projectA]: noteAt });
    f.db.prepare("INSERT INTO authority_person_text_source_failures_v1 (organization_id, api_version, context_id, disposition, recorded_at) VALUES (?, 3, ?, 'invalid_retained_text', ?)")
      .run(f.person.organization_id, note, f.clock().toISOString());
    expect(await latest('rafael')).toEqual(before.rafael);
  });

  it('counts a meeting only through the exact record check', async () => {
    const f = await openItemsFixture();
    // A records route that reads no project audience: project A's meeting is no longer readable, so it is not news.
    expect(await activityOf(f, { records: recordRoute(f, { capture_projects: undefined }) }).latest('mina')).toEqual({ [f.projectA]: null });
    expect(await activityOf(f).latest('mina')).toEqual({ [f.projectA]: arrivalOf(f) });
  });

  it('never counts a follow-up whose decision the caller cannot read, even one sent to them', async () => {
    const f = await openItemsFixture();
    afterArrival(f);
    const route = recordRoute(f);
    await f.finishImpactRun();
    const unsent = (await f.runItems()).items;
    const sentAt = tick(f);
    await sendAll(f, unsent);
    // As if Mina could not read the decision: she still sees the ticket she owns, but never which project it is filed in.
    const blind = activityOf(f, { records: { projectRecordActivity: route.projectRecordActivity,
      readableDecisionProjects: input => (input.access_token === 'mina' ? new Map() : route.readableDecisionProjects(input)) } });
    expect(await blind.latest('mina')).toEqual({ [f.projectA]: arrivalOf(f) });
    expect(await blind.latest('rafael')).toEqual({ [f.projectA]: sentAt });
  });

  it('counts what arrived before the caller joined, as the project page lists it to them', async () => {
    const f = await openItemsFixture();
    afterArrival(f);
    const { latest } = activityOf(f);
    const originals = originalsOf(f);
    const noteAt = tick(f);
    originals.note('mina', { kind: 'project', project_id: f.projectA }, [f.projectA]);
    expect(await latest('okafor')).toEqual({});
    tick(f);
    grant(f, 'okafor', f.projectA);
    expect(await latest('okafor')).toEqual({ [f.projectA]: noteAt });
  });

  it("leaves a person's answer unchanged by activity they cannot see (ADR-0012)", async () => {
    // Okafor is matched as the ticket's owner, but is in no project and is never sent it.
    const f = await openItemsFixture({ ticketOwner: 'okafor' });
    afterArrival(f);
    const { latest } = activityOf(f);
    const originals = originalsOf(f);
    const revision = () => f.db.prepare('SELECT revision FROM authority_project_authorization_state_v1').pluck().get() as number;
    const startRevision = revision();
    await f.finishImpactRun();
    const rafael = await latest('rafael');
    const okafor = await latest('okafor');
    grant(f, 'mina', f.projectB);
    tick(f);
    // Mina's private note and a document only B reads, filed into A; a note filed into B; Ari's meeting approved into B.
    originals.note('mina', { kind: 'only_me' }, [f.projectA]);
    tick(f);
    originals.document('mina', { kind: 'project', project_id: f.projectB }, [f.projectA]);
    tick(f);
    originals.note('mina', { kind: 'team' }, [f.projectB]);
    await approveAnother(f, [f.projectB], 'note-2');
    // Projects Rafael and Okafor are not in are renamed and joined.
    f.db.prepare("UPDATE authority_projects_v1 SET name='Renamed C' WHERE project_id=?").run(f.projectC);
    grant(f, 'mina', f.projectC);
    // The organization's authorization revision moved; nothing that stands in for it reached Rafael or Okafor.
    expect(revision()).toBeGreaterThan(startRevision);
    expect(await latest('rafael')).toEqual(rafael);
    expect(await latest('okafor')).toEqual(okafor);
    expect(okafor).toEqual({});
  });
});

describe('project activity: cost', () => {
  it('reads in one read transaction, writes nothing (no audit row), reads nothing live and takes no write lock', async () => {
    const f = await openItemsFixture({ file: true });
    afterArrival(f);
    await f.finishImpactRun();
    const unsent = (await f.runItems()).items;
    tick(f);
    await sendAll(f, unsent);
    originalsOf(f).note('mina', { kind: 'team' }, [f.projectA]);
    originalsOf(f).document('mina', { kind: 'team' }, [f.projectA]);
    const route = recordRoute(f);
    const repository = new SqliteProjectContextRepositoryV1(f.db);
    const rows = new SqlitePersonProjectActivityV1(f.db);
    const inTransactionBy = new Map<string, boolean[]>();
    const traced = <T extends (...args: never[]) => unknown>(name: string, call: T): T => ((...args: Parameters<T>) => {
      inTransactionBy.set(name, [...(inTransactionBy.get(name) ?? []), f.db.inTransaction]);
      return call(...args);
    }) as T;
    const { app, read } = activityOf(f, {
      sessions: { authenticateAccess: traced('sessions', f.openItemsOptions.sessions.authenticateAccess) },
      projects: { personChangeView: traced('projects', repository.personChangeView.bind(repository)) },
      originals: { originals: traced('originals', rows.originals.bind(rows)) },
      approvals: { approvedRecords: traced('approvals', rows.approvedRecords.bind(rows)) },
      items: { forRecords: traced('items', f.items.forRecords.bind(f.items)) },
      people: { people: traced('people', f.directory.people.bind(f.directory)), leadsAny: traced('leads', f.directory.leadsAny.bind(f.directory)) },
      records: { projectRecordActivity: traced('records', route.projectRecordActivity), readableDecisionProjects: traced('decisions', route.readableDecisionProjects) },
    });
    const audits = () => Object.fromEntries((f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%audit%' ORDER BY name").pluck().all() as string[])
      .map(table => [table, f.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()]));
    const changes = () => [f.db.prepare('SELECT total_changes()').pluck().get(), f.recordLog.prepare('SELECT total_changes()').pluck().get()];
    const before = { audits: audits(), changes: changes(), binds: f.bindDesk.mock.calls.length, opens: f.openCitation.mock.calls.length };
    for (const who of PEOPLE) await app.read({ access_token: who });
    expect({ audits: audits(), changes: changes(), binds: f.bindDesk.mock.calls.length, opens: f.openCitation.mock.calls.length }).toEqual(before);
    // Every database read after the session check runs inside the one read transaction.
    expect([...inTransactionBy.keys()].sort()).toEqual(['approvals', 'decisions', 'items', 'leads', 'originals', 'people', 'projects', 'records', 'sessions']);
    expect([...inTransactionBy.values()].flat().every(Boolean)).toBe(true);
    expect(f.db.inTransaction).toBe(false);
    // Another connection holds the write lock: the read still answers, where a read that takes the write lock cannot.
    const peer = await f.peer();
    f.db.pragma('busy_timeout = 0');
    peer.db.exec('BEGIN IMMEDIATE');
    try {
      for (const who of PEOPLE) expect((await read(who)).kind).toBe('echo-person-project-activity-v1');
      expect(() => repository.withReadTransaction(() => 0)).toThrow(/locked|busy/i);
    } finally { peer.db.exec('ROLLBACK'); }
    expect(f.db.inTransaction).toBe(false);
  });

  it('refuses to run inside a transaction it did not open', async () => {
    const f = await openItemsFixture();
    const { app } = activityOf(f);
    f.db.exec('BEGIN');
    try {
      await expect(app.read({ access_token: 'mina' })).rejects.toThrow('opens its own read transaction');
    } finally { f.db.exec('ROLLBACK'); }
  });
});

describe('project activity HTTP route', () => {
  const servers: ReturnType<typeof createOrganizationAuthorityHttpServer>[] = [];
  afterEach(async () => { for (const server of servers.splice(0)) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; } });
  async function origin(person_project_activity?: ReturnType<typeof createPersonProjectActivityV1>, sessions: unknown = {}) {
    const server = createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: sessions as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example',
      ...(person_project_activity === undefined ? {} : { person_project_activity }) });
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('address unavailable');
    return `http://127.0.0.1:${address.port}`;
  }

  it('authenticates like every Person read, answers the exact shape, and takes no query or body', async () => {
    const f = await openItemsFixture();
    const { app, read } = activityOf(f);
    const base = await origin(app, f.openItemsOptions.sessions);
    const get = (authorization: string | null, path: string = PERSON_PROJECT_ACTIVITY_PATH_V1) => fetch(`${base}${path}`, { headers: authorization === null ? {} : { authorization } });
    expect((await get(null)).status).toBe(401);
    const stranger = await get('Bearer stranger');
    expect(stranger.status).toBe(401);
    expect(await stranger.json()).toEqual({ error: { code: 'unauthorized', message: 'request failed' } });
    const response = await get('Bearer mina');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(validatePersonProjectActivityV1(body)).toEqual(body);
    expect(body).toEqual(await read('mina'));
    expect((await get('Bearer mina', `${PERSON_PROJECT_ACTIVITY_PATH_V1}?since=1`)).status).toBe(400);
    // The session is checked before the request's shape.
    expect((await get('Bearer stranger', `${PERSON_PROJECT_ACTIVITY_PATH_V1}?since=1`)).status).toBe(401);
    const withBody = (authorization: string) => new Promise<number>((resolve, reject) => {
      const url = new URL(`${base}${PERSON_PROJECT_ACTIVITY_PATH_V1}`);
      const sent = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers: { authorization, 'content-type': 'application/json', 'content-length': '2' } },
        response => { response.resume(); resolve(response.statusCode ?? 0); });
      sent.on('error', reject);
      sent.end('{}');
    });
    expect(await withBody('Bearer mina')).toBe(400);
    expect(await withBody('Bearer stranger')).toBe(401);
    // Only GET is served; another method finds no route.
    expect((await fetch(`${base}${PERSON_PROJECT_ACTIVITY_PATH_V1}`, { method: 'POST', headers: { authorization: 'Bearer mina', 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
  });

  it('is reserved for the Authority, and unavailable when not composed', async () => {
    expect(() => createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example',
      person_tools: { routes: [{ route_id: 'collision', method: 'GET', path: PERSON_PROJECT_ACTIVITY_PATH_V1 }], accept: async () => ({ status: 200, body: {} }) } })).toThrow('collides with Authority route');
    const base = await origin();
    expect((await fetch(`${base}${PERSON_PROJECT_ACTIVITY_PATH_V1}`, { headers: { authorization: 'Bearer mina' } })).status).toBe(503);
  });
});

describe('records route: what was filed in a person\'s projects (Ask timeline v1, C2)', () => {
  it('lists each held project\'s records newest first, and when the newest the reader reads and did not approve arrived, auditing nothing', async () => {
    const w = await meetingWorld();
    try {
      const route = w.route();
      const projectsOf = (access_token: string) => createRecordProjectAuthorizationV1(new SqliteProjectContextRepositoryV1(w.authority))(w.sessions.authenticateAccess({ access_token }));
      const activity = (access_token: string, own: readonly string[] = [], limit = 500, project_ids: readonly string[] = [SHARED, UNJOINED, PROJ_X]) =>
        Object.fromEntries(route.projectRecordActivity({ access_token, projects: projectsOf(access_token), project_ids, own: new Set(own), limit }));
      const arrival = (name: string) => w.record.prepare('SELECT receipt_issued_at FROM organization_record_log WHERE record_sha256 = ?').pluck().get(w.digest(name)) as string;
      const audits = w.authority.prepare('SELECT count(*) FROM authority_person_read_decision_audit_v2').pluck().get();
      // SHARED holds r4 (approved by EMP_A) and r3 (by OWNER); EMP_A left PROJ_X and never joined UNJOINED, so neither is listed.
      expect(activity('emp_a')).toEqual({ [SHARED]: { meeting_at: arrival('r3'), filed: [w.digest('r4'), w.digest('r3')] } });
      expect(activity('owner')).toEqual({ [SHARED]: { meeting_at: arrival('r4'), filed: [w.digest('r4'), w.digest('r3')] } });
      // A record the reader's published decisions name is theirs, whatever its signed record says.
      expect(activity('owner', [w.digest('r4')])).toEqual({ [SHARED]: { meeting_at: null, filed: [w.digest('r4'), w.digest('r3')] } });
      expect(activity('emp_a', [w.digest('r3')])).toEqual({ [SHARED]: { meeting_at: null, filed: [w.digest('r4'), w.digest('r3')] } });
      expect(activity('emp_a', [], 1)).toEqual({ [SHARED]: { meeting_at: arrival('r3'), filed: [w.digest('r4')] } });
      expect(activity('owner', [], 500, [])).toEqual({});
      // Current grants decide what is held.
      w.grant(UNJOINED, OWNER);
      expect(activity('owner')).toEqual({
        [SHARED]: { meeting_at: arrival('r4'), filed: [w.digest('r4'), w.digest('r3')] },
        [UNJOINED]: { meeting_at: null, filed: [w.digest('r3')] },
      });
      expect(activity('emp_c')).toEqual({});
      expect(w.authority.prepare('SELECT count(*) FROM authority_person_read_decision_audit_v2').pluck().get()).toBe(audits);
      const invalid = expect.objectContaining({ code: 'invalid_request' });
      expect(() => activity('owner', [], 0)).toThrow(invalid);
      expect(() => activity('owner', [], 501)).toThrow(invalid);
      expect(() => route.projectRecordActivity({ access_token: 'nobody', projects: projectsOf('owner'), project_ids: [SHARED], own: new Set(), limit: 500 }))
        .toThrow(expect.objectContaining({ code: 'unauthorized' }));
    } finally { w.close(); }
  });
});
