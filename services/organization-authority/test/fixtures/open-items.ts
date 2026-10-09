import { randomUUID } from 'node:crypto';
import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonRunsResultV1, type PersonRunsRequestV1, type PersonRunsResultsV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { expect, vi } from 'vitest';
import { SqliteImpactItemsV1, type ImpactItemVerdictV1 } from '../../src/adapters/persistence/sqlite/impact-items-v1.js';
import { SqliteOpenItemPeopleV1 } from '../../src/adapters/persistence/sqlite/open-item-people-v1.js';
import { SqliteTriggerRunsV1, enqueueApprovedRecordRunV1 } from '../../src/adapters/persistence/sqlite/trigger-runs-v1.js';
import type { JiraOwnerAccountsV1 } from '../../src/application/ports/jira-owner-accounts-v1.js';
import { createPersonOpenItemsV1, type OpenItemsLiveFailureV1 } from '../../src/composition/person-open-items-v1.js';
import type { PersonReadableDecisionsV1 } from '../../src/composition/person-record-search-route.js';
import { createPersonTriggerRunsV1 } from '../../src/composition/person-trigger-runs-v1.js';
import type { PersonTriggerRunsHttpApplicationV1 } from '../../src/presentation/person-trigger-runs-http-application.js';
import { approvalCoreFixture } from './approval-core.js';
import { addMembership, revokeMembership } from './project-context-sqlite.js';

/**
 * Open items over a real Authority V13 database (open items and Home v1).
 * Ari approves a meeting into project A, whose members are Ari (lead), Mina
 * Patel and Rafael Moreno; S. Okafor is in the organization but not in project
 * A. Decision readers are project A's active members. The impact check finds
 * a Jira ticket (ECHO-12), another ECHO decision's action and a Confluence page
 * that already agrees. The fake desk opens what each person may open: it
 * refuses Rafael the ticket, and ECHO records to anyone outside project A.
 */
export const CLOUD = '00000000-0000-4000-8000-0000000000c1';
export type FixturePerson = 'ari' | 'mina' | 'rafael' | 'okafor';
const binding = (suffix: string) => ({ principal_id: `prn_00000000-0000-4000-8000-0000000${suffix}1`, membership_id: `mem_00000000-0000-4000-8000-0000000${suffix}2` });
const MEMBERS = { mina: { ...binding('0a1a'), name: 'Mina Patel' }, rafael: { ...binding('0b2b'), name: 'Rafael Moreno' }, okafor: { ...binding('0c3c'), name: 'S. Okafor' } } as const;
const START = '2026-10-08T09:00:00.000Z';
const signal = () => new AbortController().signal;

export interface OpenItemsFixtureOptionsV1 {
  /** Words read from outside ECHO: in the ticket's and the page's titles and text. */
  readonly outsideText?: string;
  /** Whose Jira account the ticket's assignee is; `none` leaves it unassigned. */
  readonly ticketOwner?: 'mina' | 'okafor' | 'none';
  /** The owner on the other decision's action. */
  readonly actionOwner?: string;
  /** A not-assessed card lists what research cited, with no relation. */
  readonly assessed?: boolean;
  /** A failed bulk assignee read. */
  readonly jiraFails?: boolean;
  /** The card also cites the ticket at a later text hash. */
  readonly duplicateTicket?: boolean;
  /**
   * What a live open throws, by the item's kind, once the desk has not refused
   * the viewer first: an outage or a rate limit in the tool itself.
   */
  readonly openFails?: Partial<Record<'ticket' | 'page' | 'approved_record', unknown>>;
  /** Where the open-items service reports a failed live read; otherwise the fixture keeps them in `liveFailures`. */
  readonly on_live_failure?: (event: OpenItemsLiveFailureV1) => void;
}

/** One impact card as the renderer returns it, with a copy of the ticket at another text hash when asked. */
export function fixtureCard(input: { readonly record: unknown; readonly outsideText: string; readonly actionOwner: string; readonly assessed: boolean; readonly duplicateTicket?: boolean }) {
  const ticket = { kind: 'ticket' as const, tool_id: 'jira', external_scope_id: CLOUD, ticket_id: '10012', permalink: 'https://echo-fixture.atlassian.net/browse/ECHO-12', text_sha256: canonicalSha256('ECHO-12 text') };
  const rollout = { kind: 'approved_record' as const, atom_id: canonicalSha256('rollout atom'), record_sha256: canonicalSha256('rollout record'), policy_id: 'project-members-readable-person-v1' as const };
  const page = { kind: 'page' as const, tool_id: 'confluence', external_scope_id: CLOUD, page_id: '200', section_id: 'section-1', version: '3',
    permalink: 'https://echo-fixture.atlassian.net/wiki/spaces/ECHO/pages/200', text_sha256: canonicalSha256('PRD text') };
  const entries = {
    decision: { citation: input.record, kind: 'decision', label: 'Pilot planning', visibility: 'project' },
    ticket: { citation: ticket, kind: 'ticket', label: `ECHO-12 ${input.outsideText}`, visibility: 'only_me' },
    rollout: { citation: rollout, kind: 'action', label: 'Thermostat rollout plan', visibility: 'project' },
    page: { citation: page, kind: 'page', label: `Thermostat PRD ${input.outsideText}`, visibility: 'only_me' },
    later: { citation: { ...ticket, text_sha256: canonicalSha256('ECHO-12 later text') }, kind: 'ticket', label: `ECHO-12 ${input.outsideText}`, visibility: 'only_me' },
  };
  const pointers = { ticket, rollout, page };
  if (!input.assessed) {
    // Not assessed: what research cited, with its details, and no relation, decision or expected phrase.
    return {
      status: 'not_assessed' as const, decided: [], unconfirmed: [], citations: [entries.ticket, entries.rollout],
      affected: [{ citation_index: 0, says_now: `ECHO-12 ${input.outsideText}; due 2026-10-30`, owner: 'Mina Patel' }, { citation_index: 1, says_now: 'Thermostat rollout plan', owner: input.actionOwner }],
      people: [{ name: 'Mina Patel', items: [0] }, { name: input.actionOwner, items: [1] }], pointers,
    };
  }
  const duplicate = input.duplicateTicket === true;
  return {
    status: 'assessed' as const,
    decided: [{ text: 'The pilot starts next week.', citation_index: 0 }],
    affected: [
      { citation_index: 1, says_now: `${input.outsideText} is due Oct 30.`, relation: 'needs_updating', expected: 'launch next week', owner: 'Mina Patel' },
      { citation_index: 2, says_now: 'The rollout plan starts the pilot after the freeze.', relation: 'conflicts', expected: 'pilot starts next week', owner: input.actionOwner },
      { citation_index: 3, says_now: `${input.outsideText} says the pilot starts next week.`, relation: 'confirms' },
      // The same ticket at a later text hash: one item.
      ...(duplicate ? [{ citation_index: 4, says_now: `${input.outsideText} is due Oct 31.`, relation: 'conflicts', expected: 'launch Monday', owner: 'Mina Patel' }] : []),
    ],
    unconfirmed: [],
    people: [{ name: 'Mina Patel', items: [1, ...(duplicate ? [4] : [])] }, { name: input.actionOwner, items: [2] }],
    citations: [entries.decision, entries.ticket, entries.rollout, entries.page, ...(duplicate ? [entries.later] : [])],
    pointers,
  };
}

export async function openItemsFixture(options: OpenItemsFixtureOptionsV1 = {}) {
  const outsideText = options.outsideText ?? 'Kestrel cooling fan drift 0xC0FFEE';
  let now = new Date(START);
  const f = await approvalCoreFixture();
  const { db } = f;
  const organization = f.person.organization_id;
  db.prepare('UPDATE authority_principals SET display_name=? WHERE principal_id=?').run('Ari', f.person.principal_id);
  const people: Record<FixturePerson, { readonly principal_id: string; readonly membership_id: string; readonly membership_type: 'owner' | 'employee' }> = {
    ari: { principal_id: f.person.principal_id, membership_id: f.person.membership_id, membership_type: 'owner' },
    mina: { ...MEMBERS.mina, membership_type: 'employee' }, rafael: { ...MEMBERS.rafael, membership_type: 'employee' }, okafor: { ...MEMBERS.okafor, membership_type: 'employee' },
  };
  for (const name of ['mina', 'rafael', 'okafor'] as const) {
    addMembership(db, { organization_id: organization, principal_id: MEMBERS[name].principal_id, membership_id: MEMBERS[name].membership_id, membership_type: 'employee' }, MEMBERS[name].name, `${name}@example.test`);
  }
  // Ari leads project A; Mina and Rafael are its members; S. Okafor is not in it.
  db.prepare("UPDATE authority_project_memberships_v1 SET role='lead' WHERE project_id=? AND membership_id=? AND status='active'").run(f.projectA, f.person.membership_id);
  for (const name of ['mina', 'rafael'] as const) {
    db.prepare(`INSERT INTO authority_project_memberships_v1 (project_membership_id, project_id, organization_id, principal_id, membership_id, membership_type, role, status, granted_at)
      VALUES (?, ?, ?, ?, ?, 'employee', 'member', 'active', ?)`).run(`pgm_${randomUUID()}`, f.projectA, organization, people[name].principal_id, people[name].membership_id, START);
  }
  f.core.decide('desktop', f.approve({ project_ids: [f.projectA] }), () => f.session);
  const runs = new SqliteTriggerRunsV1(db, () => now);
  await f.publisher([enqueueApprovedRecordRunV1(runs)]).appendFinalizedApprovalsToV4(signal());
  const run = runs.list(f.person, 1)[0]!;
  const recordSha256 = run.record_sha256!;
  const items = new SqliteImpactItemsV1(db, () => now);
  const directory = new SqliteOpenItemPeopleV1(db);
  const token = (value: string): FixturePerson => {
    if (!Object.hasOwn(people, value)) throw new AuthorityOperationError('unauthorized', 'person authentication failed');
    return value as FixturePerson;
  };
  const active = (membershipId: string) => db.prepare("SELECT 1 FROM authority_memberships WHERE membership_id=? AND status='active'").get(membershipId) !== undefined;
  /** Project A's active members read the decision. */
  const reads = (name: FixturePerson) => active(people[name].membership_id) && db.prepare(`SELECT 1 FROM authority_project_memberships_v1
    WHERE project_id=? AND membership_id=? AND status='active'`).get(f.projectA, people[name].membership_id) !== undefined;
  const sessions = {
    authenticateAccess: ({ access_token }: { readonly access_token: string }): PersonAccessAuthorization => {
      const name = token(access_token);
      if (!active(people[name].membership_id)) throw new AuthorityOperationError('unauthorized', 'person authentication failed');
      return { organization_id: organization, ...people[name], identity_binding_id: `oib_${name}`, session_family_id: `psf_${name}`,
        access_credential_sha256: canonicalSha256(name), access_expires_at: '2026-10-08T23:00:00.000Z', hard_reauthentication_at: '2026-10-09T23:00:00.000Z',
        person_state_sha256: canonicalSha256({ name }), session_state_sha256: canonicalSha256('session'), checked_at: now.toISOString() };
    },
  };
  const decisionCitation = { kind: 'approved_record' as const, atom_id: canonicalSha256('pilot planning atom'), record_sha256: recordSha256, policy_id: 'project-members-readable-person-v1' as const };
  const readable = vi.fn((input: { readonly access_token: string; readonly record_sha256s: readonly Sha256Digest[] }) => {
    const name = token(input.access_token);
    return new Map(input.record_sha256s.filter(sha => sha === recordSha256 && reads(name)).map(sha => [sha, Object.freeze({
      approval_id: f.approvalId, record_sha256: sha, title: 'Pilot planning', approved_at: '2026-10-07T09:00:00.000Z', project_ids: Object.freeze([f.projectA]) as never,
    })]));
  });
  const records: PersonReadableDecisionsV1 & Parameters<typeof createPersonTriggerRunsV1>[0]['records'] = {
    readableDecisions: readable,
    projectRecords: ({ access_token, project_id }) => (project_id === f.projectA && reads(token(access_token)) ? [recordSha256] : []),
    recordAnchor: () => decisionCitation,
    recordProjects: ({ access_token }) => {
      if (!reads(token(access_token))) throw new AuthorityOperationError('not_found', 'record evidence is not available');
      return [f.projectA as never];
    },
  };
  const card = fixtureCard({ record: decisionCitation, outsideText, actionOwner: options.actionOwner ?? 'Nobody Here', assessed: options.assessed !== false, duplicateTicket: options.duplicateTicket === true });
  const { pointers } = card;
  const receipt = canonicalSha256('receipt');
  const deskItems = {
    decision: { id: 'desk-decision', citation: decisionCitation, kind: 'decision', label: 'Pilot planning', visibility: 'project', text: 'The pilot starts next week.', receipt_sha256: receipt },
    ticket: { id: 'desk-ticket', citation: pointers.ticket, kind: 'ticket', label: `ECHO-12 ${outsideText}`, visibility: 'only_me', text: `${outsideText} ships on Oct 30.`,
      attributes: { owner: 'Mina Patel', due_at: '2026-10-30', status: 'In Progress' }, receipt_sha256: receipt },
    rollout: { id: 'desk-rollout', citation: pointers.rollout, kind: 'action', label: 'Thermostat rollout plan', visibility: 'project', text: 'Start the pilot after the freeze.',
      attributes: { owner: 'Nobody Here' }, receipt_sha256: receipt },
    page: { id: 'desk-page', citation: pointers.page, kind: 'page', label: `Thermostat PRD ${outsideText}`, visibility: 'only_me', text: `${outsideText} says the pilot starts next week.`, receipt_sha256: receipt },
  };
  const opened: { readonly token: string; readonly kind: string }[] = [];
  const revalidated: string[] = [];
  type Citation = { readonly kind: string; readonly record_sha256?: string };
  /** One live open on a desk bound to `name`: the desk's own refusals first, then the tool. */
  const openCitation = vi.fn(async (name: FixturePerson, citation: Citation) => {
    opened.push({ token: name, kind: citation.kind });
    const result = (found: readonly unknown[]) => ({ items: found, truncated: false, receipt_digests: [receipt] });
    if (citation.kind === 'ticket' && name === 'rafael') throw new AuthorityOperationError('not_found', 'The ticket is not available');
    if (citation.kind === 'approved_record' && !reads(name)) return result([]);
    const fails = options.openFails?.[citation.kind as keyof NonNullable<OpenItemsFixtureOptionsV1['openFails']>];
    if (fails !== undefined) throw fails;
    if (citation.kind === 'ticket') return result([deskItems.ticket]);
    if (citation.kind === 'page') return result([deskItems.page]);
    return result([citation.record_sha256 === recordSha256 ? deskItems.decision : deskItems.rollout]);
  });
  const bindDesk = vi.fn(async (_options: unknown, _sources: unknown, input: { readonly access_token: string }) => ({
    openCitation: ({ citation }: { readonly citation: Citation }) => openCitation(token(input.access_token), citation),
    async revalidate() { revalidated.push(input.access_token); return { checked_at: now.toISOString() }; },
  }));
  const research = vi.fn(() => ({ renderWithResearch: async () => ({
    rendered: (({ pointers: _pointers, ...rendered }) => rendered)(card),
    research: { items: card.citations.map(entry => ({ citation: entry.citation, title: entry.label })) },
  }) }));
  const accounts = { mina: 'acct-mina', okafor: 'acct-okafor', none: undefined };
  const assignee = accounts[options.ticketOwner ?? 'mina'];
  const jira_owners: JiraOwnerAccountsV1 = {
    cloud_id: CLOUD,
    assignees: vi.fn(async ({ ticket_ids }: { readonly ticket_ids: readonly string[] }) => {
      if (options.jiraFails === true) throw new Error('Jira is unavailable');
      return new Map(assignee === undefined ? [] : ticket_ids.map(id => [id, assignee] as const));
    }),
    people: vi.fn((account: string) => {
      const name = account === 'acct-mina' ? 'mina' : account === 'acct-okafor' ? 'okafor' : undefined;
      return name === undefined ? [] : [{ organization_id: organization, principal_id: people[name].principal_id, membership_id: people[name].membership_id }];
    }),
  };
  const bind_options = { authority_id: 'authority', state_lineage_id: 'lineage' } as never;
  const runsApp = createPersonTriggerRunsV1({ runs, sessions, records, bindDesk: bindDesk as never, audit: {} as never, bind_options, research: research as never,
    items, people: directory, jira_owners, lease_ms: 60_000 });
  const liveFailures: OpenItemsLiveFailureV1[] = [];
  /** The open-items service's options, so a test can build it again with one of them changed. */
  const openItemsOptions = { sessions, runs, items, people: directory, records, bindDesk: bindDesk as never, bind_options,
    on_live_failure: options.on_live_failure ?? ((event: OpenItemsLiveFailureV1) => { liveFailures.push(event); }) };
  const openItemsApp = createPersonOpenItemsV1(openItemsOptions);
  /** Every response passes the API's own result validator, as the desktop's client would apply it. */
  const checked = <K extends keyof PersonRunsResultsV1>(operation: K, read: (input: never) => Promise<unknown>) =>
    async (input: unknown): Promise<PersonRunsResultsV1[K]> => validatePersonRunsResultV1(operation, await read(input as never));
  type Request<K extends PersonRunsRequestV1['operation']> = { readonly access_token: string; readonly request: Extract<PersonRunsRequestV1, { readonly operation: K }> };
  const app = {
    start: (input: Parameters<typeof runsApp.start>[0]) => runsApp.start(input).then(value => validatePersonRunsResultV1('start', value)),
    view: (input: Parameters<typeof runsApp.view>[0]) => runsApp.view(input).then(value => validatePersonRunsResultV1('view', value)),
    home: checked('home', openItemsApp.home) as (input: { readonly access_token: string }) => Promise<PersonRunsResultsV1['home']>,
    items: checked('items', openItemsApp.items) as (input: Request<'items'>) => Promise<PersonRunsResultsV1['items']>,
    item: checked('item', openItemsApp.item) as (input: Request<'item'>) => Promise<PersonRunsResultsV1['item']>,
    send: checked('send', openItemsApp.send) as (input: Request<'send'>) => Promise<PersonRunsResultsV1['send']>,
    set_state: checked('set_state', openItemsApp.set_state) as (input: Request<'set_state'>) => Promise<PersonRunsResultsV1['set_state']>,
    assign: checked('assign', openItemsApp.assign) as (input: Request<'assign'>) => Promise<PersonRunsResultsV1['assign']>,
  } satisfies Partial<Record<keyof PersonTriggerRunsHttpApplicationV1, unknown>>;
  const finishImpactRun = async () => {
    await app.start({ access_token: 'ari', request: { schema_version: 1, operation: 'start', run_id: run.run_id } });
    await vi.waitFor(() => expect(runs.read(f.person, run.run_id)!.state).not.toBe('running'));
    expect(runs.read(f.person, run.run_id)!.state).toBe('done');
  };
  const runItems = (access_token: FixturePerson = 'ari') => app.items({ access_token, request: { schema_version: 1, operation: 'items', scope: 'run', id: run.run_id } });
  return {
    // `db` comes with `f`, typed by the approval fixture's named interface, so this inferred type can be emitted.
    ...f, runs, items, directory, records, readable, bindDesk, openCitation, opened, revalidated, liveFailures, openItemsOptions, jira_owners, research, card, app, runsApp, openItemsApp,
    runId: run.run_id, record: recordSha256, people, outsideText, finishImpactRun, runItems,
    membership: (name: FixturePerson) => people[name].membership_id,
    okaforMembership: people.okafor.membership_id,
    clock: () => now,
    advance(ms: number) { now = new Date(now.getTime() + ms); },
    revoke(name: FixturePerson) { revokeMembership(db, { organization_id: organization, ...people[name] }); },
    makeLead(name: FixturePerson) {
      db.prepare("UPDATE authority_project_memberships_v1 SET role='lead' WHERE project_id=? AND membership_id=? AND status='active'").run(f.projectA, people[name].membership_id);
    },
    /** Records a last check on an item, as a sweep of `by` finishing now would. */
    check(itemId: string, verdict: ImpactItemVerdictV1, by: FixturePerson = 'ari') {
      const sweep = runs.enqueueSweep({ organization_id: organization, principal_id: people[by].principal_id, membership_id: people[by].membership_id }, { kind: 'mine' });
      db.transaction(() => items.recordCheck(db, { item_id: itemId, verdict, by: people[by].membership_id, at: now.toISOString(), run_id: sweep.run_id }))();
    },
  };
}
export type OpenItemsFixtureV1 = Awaited<ReturnType<typeof openItemsFixture>>;

/** The impact run finished, and Ari sent every item: the ticket to its owner, the action to `owner` (or kept). */
export async function sentFixture(options: OpenItemsFixtureOptionsV1 & { readonly owner?: FixturePerson; readonly untickAction?: boolean } = {}) {
  const f = await openItemsFixture(options);
  await f.finishImpactRun();
  const unsent = (await f.runItems()).items;
  const owner = options.owner;
  f.advance(1_000);
  await f.app.send({ access_token: 'ari', request: { schema_version: 1, operation: 'send', run_id: f.runId, command_id: 'send-1', items: unsent.map(item => {
    if (item.kind === 'record' && options.untickAction === true) return { item_id: item.item_id, include: false };
    return { item_id: item.item_id, include: true, ...(owner !== undefined && item.owner.membership_id !== f.membership(owner) && item.kind === 'record' ? { owner_membership_id: f.membership(owner) } : {}) };
  }) } });
  const after = (await f.runItems()).items;
  f.advance(1_000);
  return { ...f, ticket: after.find(item => item.kind === 'ticket')!, action: after.find(item => item.kind === 'record')! };
}
