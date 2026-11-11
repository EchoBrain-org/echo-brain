// Test hook only (compiled out of release bundles): a synthetic session and a
// fixture Authority behind the real person client. Every request is logged to
// <home>/calls.jsonl so tests can assert what the app actually sent.
import * as organizationApi from '@echo-brain/organization-api';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AUTHORITY = 'https://authority.example';
const IDENTITY_PROVIDER = 'https://accounts.example';
const NOW = '2026-09-21T22:01:00.000Z';
/** Past the access token's expiry, still inside the week. */
const LATER = '2026-09-21T22:30:00.000Z';
/** Half an hour past the weekly sign-in of the session the fixture installs. */
const WEEK_LATER = '2026-09-28T22:30:00.000Z';
/** When the answer's meeting, Tuesday sync, was approved. */
const TUESDAY_ADDED = '2026-09-15T18:00:00.000Z';

interface Note { context_id: string; received_at: string; audience: Record<string, unknown>; title: string; text: string }
/** A saved document: its metadata, its original's text, and its extracted text in pages. */
interface StoredDocument {
  document_id: string; request_id: string; filename: string; title: string; original: string; detected_media_type: string;
  audience: Record<string, unknown>; association_project_ids: string[]; received_at: string; extraction_state: string;
  pages: { ordinal: number; anchor_kind: string; anchor_start: number; text: string }[][];
}
interface DesktopFixtures {
  projects: { project_id: string; name: string; role: 'lead' | 'member' }[];
  /** Saved V3 notes the person can read. */
  notes: Note[];
  answer: Record<string, unknown>;
  /** The approved record the answer cites, as its brief was approved. */
  record: { record_sha256: string; approved_by: string; brief: Record<string, unknown> };
  evidence_text: string;
  evidence_label: string;
  /** Everyone in the organization, as the project and organization directories find them. */
  people: { membership_id: string; display_name: string }[];
  /** Each project's members and their roles. */
  members: Record<string, { membership_id: string; role: 'lead' | 'member' }[]>;
  documents: StoredDocument[];
}

/** The one continuation the fixture hands out: the second page, from the eleventh item. */
const SECOND_PAGE = 'cGFnZTI';
const PAGE = 10;
const EXTRACTOR = 'fixture-extractor-v1';

/** The requests and responses the fixture checks with the contract's own validators, typed as loosely as it reads them. */
interface Contract {
  validateOrganizationDirectorySearchV1(value: unknown): { query?: string; limit?: number; cursor?: string };
  validateOrganizationDirectoryV1(value: unknown): unknown;
  validatePersonListRequestV1(value: unknown): { project_id?: string; only_me?: true; cursor?: string };
  validatePersonListResponseV1(value: unknown): unknown;
  validatePersonOpenRequestV1(value: unknown): { ref: string; cursor?: string };
  validatePersonOpenResponseV1(value: unknown): unknown;
  validatePersonAnswerRequestV3(value: unknown): { question: string; project_id?: string };
  /** The Ask timeline's reads (ADR-0047): the source check's request and answer, and what arrived in your projects. */
  validatePersonAskCheckRequestV1(value: unknown): { items: { citation: Record<string, unknown>; marker?: string }[] };
  validatePersonAskCheckV1(value: unknown): unknown;
  validatePersonProjectActivityV1(value: unknown): unknown;
  validatePersonRunsRequestV1(value: unknown): RunsRequest;
  validatePersonRunsResultV1(operation: string, value: unknown): unknown;
  /** Personal review requests never select a provider. */
  validatePersonReviewRequestV1(value: unknown): unknown;
  /** Ask progress V3 on `/v7` (research tool contract v1): one event, which may name a project, a person, a tool or a tool's container, as its frame. */
  formatPersonAskProgressEventV3(event: unknown): string;
}
const api = organizationApi as unknown as Contract;

/** A runs request, as the contract's validator returns it. */
interface RunsRequest {
  operation: string; run_id?: string; scope?: 'mine' | 'involved' | 'run' | 'record' | 'project'; id?: string; cursor?: string; read?: 'rows' | 'counts'; states?: OpenItem['state'][];
  changed_since?: string;
  item_id?: string; command_id?: string; state?: 'open' | 'done' | 'not_relevant'; owner_membership_id?: string;
  items?: { item_id: string; include: boolean; owner_membership_id?: string }[];
}

/** Someone an item names: who set its state or its owner. */
interface Named { membership_id: string; name: string }

/**
 * One open item (open items and Home v1; follow-ups thread v1): an action the
 * approved meeting decided, or an item its impact check found, one shared row,
 * as the Authority keeps it. Rows hold pointers and ECHO's own words; what an
 * item says now is read live, and reaches a viewer (as `current`) only when
 * that viewer could open it. A meeting's action is never read live.
 */
interface OpenItem {
  item_id: string; run_id: string; kind: 'action' | 'ticket' | 'page';
  decision: { approval_id: string; record_sha256: string; title: string; first_line: string | null; approved_at: string; project_ids: string[] };
  /** Ari can read its decision. */
  readable: boolean;
  /** What a live open of it reads, for someone with access to it in its tool. */
  live: Record<string, unknown>;
  /** Ari can open it in its tool: only then does its live read reach Ari. */
  opens: boolean;
  /** Its tool did not answer just now (an outage or a rate limit): Ari is told ECHO couldn't read it, not that Ari can't open it. */
  outage?: boolean;
  /** Null for a row the check did not assess: it has no expected phrase either (ruling 12). */
  relation: 'conflicts' | 'needs_updating' | null; expected: string | null;
  approver: { membership_id: string; name: string };
  owner: { membership_id: string; name: string; match: 'jira_account' | 'name' | 'picked' | 'approver' | 'reassigned' };
  state: 'unsent' | 'open' | 'done' | 'not_relevant';
  created_at: string; sent_at: string | null; state_set_at: string | null; state_set_by: Named | null;
  /** When and by whom its owner was last picked or reassigned; null while the owner is the one ECHO matched. */
  owner_set_at: string | null; owner_set_by: Named | null;
  /** Whether Send included it: null before Send. */
  send_included: boolean | null;
}

/** The granola modes whose projects are the meeting's: Thermostat redesign (Ari leads it) and Supplier review. */
const GRANOLA_PROJECTS = new Set(['granola', 'granola-owner', 'granola-review-assign-lost']);
const THERMOSTAT = 'prj_11111111-1111-4111-8111-111111111111';
const SUPPLIER = 'prj_44444444-4444-4444-8444-444444444444';
/** Who an impact check names, besides Ari: fictional people of the organization. */
const MINA = { membership_id: 'mem_77777777-7777-4777-8777-777777777777', name: 'Mina Patel' };
const RAFAEL = { membership_id: 'mem_88888888-8888-4888-8888-888888888888', name: 'Rafael Moreno' };
const OKAFOR = { membership_id: 'mem_99999999-9999-4999-8999-999999999999', name: 'S. Okafor' };

/**
 * A fake-only list page: ten rows, so the desktop's More is exercised
 * without seeding 25 (the Authority's own page).
 */
const LIST_PAGE = 10;

/** Ari's own notes, uploads and approved meetings, some only Ari can read (ADR-0049). */
const ONLY_ME_MODES = new Set(['only-me']);
const PRICING_REVIEW = `sha256:${'7'.repeat(64)}`;
const BEACON_KICKOFF = `sha256:${'8'.repeat(64)}`;
const PRICING_MEMO = `doc_${'9'.repeat(64)}`;
const LAUNCH_CHECKLIST = `ctx_${'b'.repeat(64)}`;
/** Ari's own notes on a supplier call, filed in Apollo under the Only me lock. */
const SUPPLIER_CALL = `ctx_${'5'.repeat(64)}`;
/** Maya's, filed in Apollo under her own lock: Ari never sees it. */
const MAYA_DRAFT = `ctx_${'6'.repeat(64)}`;
/** Pilot planning's actions, as its proposal names them and their owners. */
const MEETING_ACTIONS = [
  { signal_id: 'act-1', text: 'Send the revised quote', owner: 'Rafael Moreno' }, { signal_id: 'act-2', text: 'Confirm the trace', owner: 'Mina Patel' },
] as const;
/**
 * Pilot planning as review_open gives it, in brief order: the decision, then the actions. Every signal quotes each unit it
 * cites (a note line, or a transcript part that may hold blank lines).
 */
const PILOT_ITEMS = [
  { signal_id: 'dec-1', kind: 'decision', text: 'Launch the pilot next week.', subject: null, status: 'decided', due_at: null,
    quotes: ['Launch the pilot next week.', '[09:02] Ari: Let\'s launch the pilot next week.\n\n[09:03] Mina Patel: Agreed. The freeze lifts on Friday.'] },
  { signal_id: 'act-1', kind: 'action', text: 'Send the revised quote', subject: null, status: null, due_at: null,
    quotes: ['[09:04] Ari: Rafael, can you send the revised quote?'] },
  { signal_id: 'act-2', kind: 'action', text: 'Confirm the trace', subject: null, status: null, due_at: '2026-10-10T12:00:00.000Z',
    quotes: ['[09:05] Mina Patel: I\'ll confirm the trace by Friday.'] },
] as const;
const PILOT_REASONS = [{ signal_id: 'why-1', text: 'The freeze lifts on Friday, so next week is the first clear window.', supports: ['dec-1'],
  quotes: ['[09:03] Mina Patel: Agreed. The freeze lifts on Friday.'] }];
/** One route per item of Pilot planning, each to `projects`. */
const routesTo = (projects: readonly string[] | null) => PILOT_ITEMS.map(item => ({ signal_id: item.signal_id, project_ids: projects === null ? null : [...projects] }));

/** An approved meeting, as list and open release it. */
interface Meeting {
  record_sha256: string; title: string; added_at: string; meeting_date: string; visibility: 'only_me' | 'project';
  project_ids: string[]; approver: string; started_at: string; timezone: string; participants: string[]; approved_by: string;
  atoms: { kind: 'decision' | 'action' | 'rationale'; text: string; status?: string; owner?: string }[];
}

interface Store {
  paths: { live: string; refreshing: string; refresh_claim: string };
  install(authority: string, authorityId: string, session: Record<string, string>): unknown;
}

const JIRA_CLOUD = '11111111-2222-4333-8444-555555555555';
const JIRA_CONNECT_LINK = 'https://connect.nango.example/jira';
const CONFLUENCE_CLOUD = '22222222-3333-4444-8555-666666666666';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function failure(code: string, status: number): Response {
  return json({ error: { code, message: 'request failed' } }, status);
}
/** As the directory finds a person: every word of the query in their name. */
function found(query: unknown, name: string): boolean {
  const haystack = name.normalize('NFC').toLowerCase();
  const terms = String(query).normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.length > 0 && terms.every(term => haystack.includes(term));
}

/** The modes whose project list comes ten at a time. */
const LIST_PAGES = new Set(['many-projects']);
/** A project ID, as the API writes one. */
const PROJECT_ID = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The most projects a capture is filed in, or read by (PERSON_UPLOAD_PROJECT_SET_MAX). */
const MAX_PROJECT_SET = 20;

/** A digest, as the Authority writes one, of any text. */
const digestOf = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
/** A Confluence page or a Jira ticket the THERM answer cites. A page is the team's to read; a ticket only yours. */
const thermPage = (id: string, title: string) => ({ kind: 'page', label: title, visibility: 'team', citation: {
  kind: 'page', tool_id: 'confluence', external_scope_id: CONFLUENCE_CLOUD, page_id: id, section_id: 'summary', version: '3',
  permalink: `https://example.atlassian.net/wiki/pages/viewpage.action?pageId=${id}`, text_sha256: digestOf(title) } });
const thermTicket = (key: string, title: string, id: string) => ({ kind: 'ticket', label: `${key} · ${title}`, visibility: 'only_me', citation: {
  kind: 'ticket', tool_id: 'jira', external_scope_id: JIRA_CLOUD, ticket_id: id, permalink: `https://example.atlassian.net/browse/${key}`, text_sha256: digestOf(`${key}: ${title}`) } });
/** What `ask-blocks`'s THERM answer cites: the soak's plan and report and the PVT readiness review, then three tickets. */
const THERM_BLOCK_CITATIONS = [
  thermPage('31020', 'Soak test plan'), thermPage('31021', 'Soak test report'), thermPage('31022', 'PVT readiness review'),
  thermTicket('THERM-48', 'Soak sign-off', '20048'), thermTicket('THERM-52', 'Thermal pad supplier', '20052'), thermTicket('THERM-55', 'Line fixture', '20055'),
];

/**
 * `ask-blocks`'s V8 answer (answer layout v2, ADR-0051), THERM's, in every
 * block: the answer; the open tickets, a list statement that reads as a
 * table right after it; the soak as a timeline; THERM-48 as a card; the
 * steps before PVT; the open risk as titled text; and Noor's words as a
 * quote. Each statement reads as the Authority writes it from its block: an
 * event from its day, who and what happened, a fact from its card's kind and
 * title and its label and value, a quote from its source and words.
 */
export function blocksAnswer(question: string, scope: Record<string, unknown>): Record<string, unknown> {
  const said = (text: string, cited: number[]) => ({ text, citation_indexes: cited, private: cited.some(at => THERM_BLOCK_CITATIONS[at]!.visibility === 'only_me') });
  const row = (cells: string[], cited: number) => ({ cells, citation_indexes: [cited] });
  const events = [{ date: '2026-10-20', text: 'Approved the soak plan.', who: 'Noor Haddad' }, { date: '2026-10-23', text: 'The 72-hour soak passed.', who: 'Noor Haddad' }];
  const facts = [{ label: 'Status', value: 'In review' }, { label: 'Owner', value: 'Tomas Okafor' }];
  const quote = { text: 'Start PVT once the soak passes.', from: 'Noor Haddad, Oct 23 review' };
  const event = (at: number) => `${events[at]!.date}, ${events[at]!.who}: ${events[at]!.text}`;
  const fact = (at: number) => `Ticket: THERM-48; ${facts[at]!.label}: ${facts[at]!.value}.`;
  return {
    schema_version: 8, kind: 'echo-clean-person-answer-v8', scope, outcome: 'answered', citations: THERM_BLOCK_CITATIONS,
    parts: [{
      question, status: 'answered',
      statements: [
        said('Yes, PVT can start: the 72-hour soak passed on Oct 23.', [1]),
        said('2 Jira tickets are open: THERM-52 · Thermal pad supplier; THERM-55 · Line fixture.', [4, 5]),
        said(event(0), [0]),
        said(event(1), [1]),
        said(fact(0), [3]),
        said(fact(1), [3]),
        said('Freeze the firmware at 1.4.2.', [2]),
        said('Ship the build to the line.', [2]),
        said('Sensor self-heating is still unexplained, so the soak report keeps it on the PVT watch list.', [1]),
        said(`${quote.from}: “${quote.text}”`, [2]),
      ],
      blocks: [
        { kind: 'answer', statements: [0] },
        { kind: 'table', statements: [1], columns: ['Item', 'Status', 'Owner', 'Due'], caption: '2 Jira tickets are open', rows: [
          row(['THERM-52 · Thermal pad supplier', 'In Progress', 'Tomas Okafor', '2026-11-04'], 4),
          row(['THERM-55 · Line fixture', 'To Do', 'You', '2026-10-30'], 5),
        ] },
        { kind: 'timeline', title: 'Soak test', statements: [2, 3], events },
        { kind: 'card', title: 'THERM-48', entity: 'ticket', statements: [4, 5], facts },
        { kind: 'points', title: 'Before PVT', ordered: true, statements: [6, 7] },
        { kind: 'text', title: 'Open risk', statements: [8] },
        { kind: 'quote', statements: [9], ...quote },
      ],
    }],
  };
}

/**
 * Every other answer's blocks (answer layout v2, ADR-0051), which each part
 * with statements carries: an untitled text block a statement, so each reads
 * as its own paragraph.
 */
export function paragraphs(statements: readonly unknown[]): { kind: 'text'; statements: number[] }[] {
  return statements.map((_, at) => ({ kind: 'text', statements: [at] }));
}

// ---- the Ask timeline (ADR-0047) --------------------------------------------------

/** The Ask timeline's source checks and follow-ups share the earlier turn's citations. */
/** An answer citation, as a V8 answer carries it. */
type TimelineCitation = { kind: string; label: string; visibility: string; citation: Record<string, unknown>; ref?: string };
/** What the timeline's answers cite: a THERM ticket (only yours), the DVT plan page (the team's), and a follow-up. */
const THERM_482: TimelineCitation = thermTicket('THERM-482', 'Sensor drift', '20482');
const DVT_PLAN: TimelineCitation = thermPage('31010', 'DVT plan');
const TRACE_FOLLOW_UP: TimelineCitation = { kind: 'follow_up', label: 'Confirm the trace', visibility: 'team', ref: 'follow_up:itm_timeline-1',
  citation: { kind: 'follow_up', item_id: 'itm_timeline-1' } };

/** A sentence citing some of `citations`: private exactly when one it cites is only yours, as the contract checks. */
function cites(citations: readonly TimelineCitation[], text: string, cited: readonly number[]) {
  return { text, citation_indexes: [...cited], private: cited.some(at => citations[at]!.visibility === 'only_me') };
}

/** A ticket's key, as its label begins: "THERM-482". */
const ticketKey = (citation: TimelineCitation) => citation.label.split(' · ')[0]!;

/** A follow-up's question with its subject named: "who owns it?" asked of THERM-482 is "Who owns THERM-482?". */
function naming(question: string, key: string): string {
  const named = question.replace(/\b(that ticket|that one|it)\b/iu, key);
  const full = named === question ? `${question.replace(/\?$/u, '')} (${key})?` : named;
  return full.charAt(0).toUpperCase() + full.slice(1);
}

/** A V8 answer of one part, answering `question` from `citations`, a paragraph a statement. */
function timelineV8(question: string, scope: Record<string, unknown>, citations: readonly TimelineCitation[], statements: readonly ReturnType<typeof cites>[]) {
  return { schema_version: 8, kind: 'echo-clean-person-answer-v8', scope, outcome: 'answered', citations: [...citations],
    parts: [{ question, status: 'answered', statements: [...statements], blocks: paragraphs(statements) }] };
}

/** A follow-up names the earlier answer's single ticket; an initial answer cites the ticket, plan and follow-up. */
function timelineAnswer(question: string, scope: Record<string, unknown>, previous: Record<string, unknown> | undefined): Record<string, unknown> {
  if (previous?.purpose === 'follow_up') {
    const tickets = (previous.citations as TimelineCitation[]).filter(citation => citation.citation.kind === 'ticket');
    if (tickets.length !== 1) throw new Error('Expected the earlier turn to contain one ticket');
    const ticket = tickets[0]!;
    const full = naming(question, ticketKey(ticket));
    return { ...timelineV8(full, scope, [ticket], [cites([ticket], `Dev owns ${ticketKey(ticket)}, since Oct 21.`, [0])]), question: full };
  }
  const citations = [THERM_482, DVT_PLAN, TRACE_FOLLOW_UP];
  return timelineV8(question, scope, citations, [cites(citations, 'THERM-482, Sensor drift, is open.', [0]), cites(citations, 'The DVT plan moved the retest to Oct 30.', [1]),
    cites(citations, 'Confirm the trace is still open.', [2])]);
}

/**
 * Readability only: the follow-up is no longer readable, everything else is. A readable ticket still carries a marker, as
 * the Authority keeps sending one for a release (SVC-13) and released clients refuse a readable ticket without it.
 */
function timelineCheck(items: readonly { citation: Record<string, unknown> }[]): Record<string, unknown> {
  return { schema_version: 1, kind: 'echo-person-ask-check-v1', items: items.map(({ citation }) => {
    if (citation.kind === 'ticket') return { state: 'same', marker: digestOf(`marker:${String(citation.ticket_id)}`) };
    return { state: citation.kind === 'follow_up' ? 'unreadable' : 'same' };
  }) };
}

/** Project activity (C2): every project you are in, with its newest arrival from someone else, or null. */
function projectActivityOf(projects: readonly { project_id: string }[], arrivals: ReadonlyMap<string, string>): Record<string, unknown> {
  return { schema_version: 1, kind: 'echo-person-project-activity-v1', items: projects.map(project => ({ project_id: project.project_id, latest_at: arrivals.get(project.project_id) ?? null })) };
}

export function installTestAuthority(home: string, fixturesDirectory: string, SessionStore: new (home: string) => unknown) {
  const desktop = JSON.parse(readFileSync(join(fixturesDirectory, 'desktop-v1.json'), 'utf8')) as DesktopFixtures;
  const mode = process.env.ECHO_DESKTOP_TEST_MODE ?? '';
  const importedNotes = mode === 'ask-imported-meeting' || mode === 'ask-imported-mixed';
  if (importedNotes) {
    // A pre-deploy answer keeps the historical label and v1 packet coordinates. The proof read below
    // returns the current neutral label and live review state without changing those coordinates.
    const label = 'Imported meeting (unapproved): Pilot';
    const text = 'The notes propose shipping the pilot.';
    desktop.evidence_text = `${label}\n${text}`;
    desktop.evidence_label = 'Imported meeting: Pilot';
    const citation = { kind: 'source_revision', source_id: `source:${'1'.repeat(64)}`, revision_id: 'rev-1', source_sha256: `sha256:${'2'.repeat(64)}`,
      representation_sha256: canonicalSha256({ kind: 'imported-meeting-notes-v1', text }),
      anchor_sha256: canonicalSha256({ kind: 'text', context_id: `cap_${'3'.repeat(64)}`, segment: 0, text: desktop.evidence_text }) };
    desktop.answer.citations = [{ kind: 'imported_meeting', label, citation: { ...citation, label }, visibility: 'only_me' }];
    desktop.answer.parts = [{ question: 'What do the pilot notes say?', status: 'answered', statements: [{ text, citation_indexes: [0], private: true }],
      blocks: [{ kind: 'text', statements: [0] }] }];
    if (mode === 'ask-imported-mixed') {
      const updated = 'The updated notes defer the pilot.';
      (desktop.answer.citations as unknown[]).push({ kind: 'imported_meeting', label, visibility: 'only_me', citation: { ...citation,
        revision_id: 'rev-2', source_sha256: `sha256:${'4'.repeat(64)}`, representation_sha256: canonicalSha256({ kind: 'imported-meeting-notes-v1', text: updated }),
        anchor_sha256: canonicalSha256({ kind: 'text', context_id: `cap_${'5'.repeat(64)}`, segment: 0, text: `${label}\n${updated}` }) } });
      desktop.answer.parts = [{ question: 'What do the pilot notes say?', status: 'answered', statements: [{ text: 'The original notes propose shipping; the updated notes defer the pilot.', citation_indexes: [0, 1], private: true }],
        blocks: [{ kind: 'text', statements: [0] }] }];
    }
  }
  const syntheticReview = mode === 'synthetic-review';
  let granolaImported = syntheticReview, granolaApproved = false, granolaBaselineHomeReads = 0;
  // The automatic import granola-preparing saved: what it watches and the project it suggests.
  let granolaWatch: { watch: string; folder_id: string | null; project_id: string | null } | undefined;
  let granolaReview: Record<string, unknown> | undefined;
  // The impact check of the approved meeting's first record: none until it is approved.
  let granolaRun: { state: 'pending' | 'running' | 'done' | 'failed'; error_code: string | null } | null = null;
  // A check for each further destination of an approved meeting.
  let extraRuns: { run_id: string; record: { approval_id: string; project_ids: string[]; private?: true }; record_sha256: string; state: 'pending' | 'running' | 'done' | 'failed';
    error_code: string | null }[] = [];
  // The people a meeting's impact check names, to pick as owners.
  if (mode.startsWith('granola')) desktop.people.push(...[MINA, RAFAEL, OKAFOR].map(person => ({ membership_id: person.membership_id, display_name: person.name })));

  const store = new SessionStore(realpathSync(home)) as Store;
  const expired = mode === 'expired-claim';
  const clock = mode.startsWith('refresh-') ? LATER : mode === 'weekly-passed' ? WEEK_LATER : NOW;
  const session = {
    organization_id: 'org_00000000-0000-4000-8000-000000000001',
    principal_id: 'prn_00000000-0000-4000-8000-000000000001',
    // The owner modes sign Ari in as the organization's owner.
    membership_id: 'mem_22222222-2222-4222-8222-222222222222', display_name: 'Ari', membership_type: mode.startsWith('owner') ? 'owner' : 'employee',
    identity_binding_id: 'oib_00000000-0000-4000-8000-000000000001',
    session_family_id: 'psf_00000000-0000-4000-8000-000000000001',
    access_token: 'A'.repeat(43), refresh_token: 'R'.repeat(43),
    access_expires_at: '2026-09-21T22:11:00.000Z', refresh_expires_at: '2026-09-28T22:00:00.000Z',
    hard_reauthentication_at: '2026-09-28T22:00:00.000Z',
  };
  if (!existsSync(store.paths.live) && !mode.startsWith('signed-out')) {
    store.install(AUTHORITY, 'oau_00000000-0000-4000-8000-000000000001', {
      // A week-old session: every deadline already passed, consistently.
      ...session, ...(expired ? {
        access_expires_at: '2026-09-20T12:00:00.000Z', refresh_expires_at: '2026-09-21T00:00:00.000Z',
        hard_reauthentication_at: '2026-09-21T00:00:00.000Z',
      } : {}),
    });
    if (expired) {
      // What an older client's weekly expiry left behind: the session set aside under a claim.
      renameSync(store.paths.live, store.paths.refreshing);
      writeFileSync(store.paths.refresh_claim, '00000000-0000-4000-8000-000000000099\n', { mode: 0o600 });
    }
  }
  // The organization as it is now: its projects, who is in each, and what is filed in it.
  const projects = mode === 'no-projects' ? [] : structuredClone(desktop.projects);
  const projectStatus = new Map<string, 'active' | 'archived'>(projects.map(project => [project.project_id, 'active']));
  const members = structuredClone(desktop.members);
  const documents = structuredClone(desktop.documents);
  // Apollo update, filed in every project.
  const apolloUpdate = `ctx_${'a'.repeat(64)}`;
  const catalog = new Map<string, { received_at: string; title: string; text: string; audience: Record<string, unknown> }>([
    [apolloUpdate, { received_at: '2026-09-21T22:01:00.000Z', title: 'Apollo update',
      // Shared with several projects; a reader sees only the one it is read in (ADR-0023).
      text: 'We agreed to ship.\n', audience: { kind: 'projects' } }],
    ...desktop.notes.map(note => [note.context_id, note] as const),
  ]);
  const filed = new Map<string, string[]>(desktop.projects.map(project => [project.project_id, [apolloUpdate]]));
  if (mode.startsWith('long-feed')) {
    // Twelve notes in Beacon, hours apart; its document falls between the eleventh and the twelfth.
    const beacon = desktop.projects[1]!.project_id;
    const ids = Array.from({ length: 12 }, (_, index) => `ctx_${(index + 1).toString(16).padStart(64, '0')}`);
    ids.forEach((id, index) => catalog.set(id, {
      received_at: new Date(Date.parse('2026-09-20T21:00:00.000Z') - (index < 11 ? index : 13) * 3_600_000).toISOString(),
      title: `Note ${index + 1}`, text: `Note ${index + 1} text.`, audience: { kind: 'project', project_id: beacon },
    }));
    filed.set(beacon, ids);
  }
  // What Ari added: notes they saved (the fixture's own among them, except in only-me-empty), documents they uploaded,
  // and meetings they approved.
  const ownNotes = new Set<string>((desktop.notes.map(note => note.context_id)));
  const ownDocuments = new Set<string>();
  const meetings: Meeting[] = [];
  const [apollo, beacon] = desktop.projects.map(project => project.project_id) as [string, string];
  if (ONLY_ME_MODES.has(mode)) {
    // Beacon's kickoff: approved by Maya, so it is in Beacon but not in Ari's Only me.
    meetings.push({
      record_sha256: BEACON_KICKOFF, title: 'Beacon kickoff', added_at: '2026-09-19T16:00:00.000Z', meeting_date: '2026-09-19', visibility: 'project',
      project_ids: [beacon], approver: 'mem_33333333-3333-4333-8333-333333333333', started_at: '2026-09-19T15:00:00.000Z', timezone: 'Europe/London',
      participants: ['Maya Chen', 'Ari'], approved_by: 'Maya Chen',
      atoms: [{ kind: 'decision', text: 'Kick off Beacon in October.' }, { kind: 'action', text: 'Invite the design team.', owner: 'Maya Chen' }],
    });
  }
  if ((ONLY_ME_MODES.has(mode))) {
    // Pricing review: approved the morning after it met, and long, more decisions than a section once kept (32).
    meetings.push({
      record_sha256: PRICING_REVIEW, title: 'Pricing review', added_at: '2026-09-22T09:15:00.000Z', meeting_date: '2026-09-21', visibility: 'only_me',
      project_ids: [], approver: session.membership_id, started_at: '2026-09-21T19:00:00.000Z', timezone: 'America/Los_Angeles',
      participants: ['Ari', 'Maya Chen'], approved_by: 'Ari',
      atoms: [{ kind: 'decision', text: 'Keep annual plans as priced.' },
        ...Array.from({ length: 33 }, (_, index) => ({ kind: 'decision' as const, text: `Hold price point ${index + 2}.` })),
        { kind: 'action', text: 'Send the annual price sheet.', owner: 'Maya Chen' }],
    });
    documents.push({
      document_id: PRICING_MEMO, request_id: '00000000-0000-4000-8000-0000000000d9', filename: 'Pricing memo.pdf', title: 'Pricing memo',
      original: '%PDF-1.4 Pricing memo\n', detected_media_type: 'application/pdf', audience: { kind: 'project', project_id: apollo },
      association_project_ids: [apollo], received_at: '2026-09-21T18:00:00.000Z', extraction_state: 'ready',
      pages: [[{ ordinal: 0, anchor_kind: 'page', anchor_start: 1, text: 'Annual plans lead the price sheet.' }]],
    });
    ownDocuments.add(PRICING_MEMO);
    catalog.set(LAUNCH_CHECKLIST, {
      received_at: '2026-09-20T12:00:00.000Z', title: 'Launch checklist', text: 'Book the venue.\nSend the invites.\n', audience: { kind: 'team' },
    });
    filed.set(apollo, [...filed.get(apollo)!, LAUNCH_CHECKLIST]);
    filed.set(beacon, [...filed.get(beacon)!, LAUNCH_CHECKLIST]);
    // Filed in Apollo, each under its owner's lock: Ari's own lists for Ari, in Apollo and in Only me; Maya's in neither.
    catalog.set(SUPPLIER_CALL, {
      received_at: '2026-09-21T19:00:00.000Z', title: 'Supplier call notes', text: 'Lead times slip two weeks.\n', audience: { kind: 'only_me' },
    });
    catalog.set(MAYA_DRAFT, {
      received_at: '2026-09-21T19:30:00.000Z', title: 'Maya\'s draft', text: 'Not for anyone else yet.\n', audience: { kind: 'only_me' },
    });
    filed.set(apollo, [...filed.get(apollo)!, SUPPLIER_CALL, MAYA_DRAFT]);
    // Eight quick notes of Ari's own, a day earlier: Only me runs past one page.
    const standups = Array.from({ length: 8 }, (_, index) => `ctx_${'f'.repeat(62)}${(index + 1).toString(16).padStart(2, '0')}`);
    standups.forEach((id, index) => catalog.set(id, {
      received_at: new Date(Date.parse('2026-09-19T12:00:00.000Z') - (index + 1) * 3_600_000).toISOString(), title: `Standup ${index + 1}`,
      text: `Standup ${index + 1} notes.`, audience: { kind: 'only_me' },
    }));
    for (const id of [LAUNCH_CHECKLIST, SUPPLIER_CALL, ...standups]) ownNotes.add(id);
  }
  /** Changes applied, by request id: a resend of the same one gets the same receipt, anything else under it conflicts. */
  const jiraMappings = new Map<string, { revision: string | null; mapping: { cloud_id: string; project_id: string; project_key: string } | null }>();
  const confluenceMappings = new Map<string, { revision: string | null; mapping: { cloud_id: string; space_ids: string[] } | null }>();
  const applied = new Map<string, { command: string; receipt: Record<string, unknown>; status: number }>();
  /** The organization's employees, as their owner lists them. */
  const employees = [
    { email: 'ana@example.com', display_name: 'Ana Mills', membership_status: 'active', invitation_state: 'redeemed' },
    { email: 'raj@example.com', display_name: 'Raj Kumar', membership_status: 'active', invitation_state: 'pending' },
    { email: 'lee@example.com', display_name: 'Lee Park', membership_status: 'revoked', invitation_state: 'expired' },
  ];
  let changes = 0;
  let writeAttempts = 0;
  let documentAttempts = 0;
  // Sign-in: the descriptor a new session is checked against, and the client's
  // loopback receiver for each sign-in begun, by its OIDC state.
  const signingKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' });
  const descriptor = {
    schema_version: 1, kind: 'echo-organization-authority', authority_id: 'oau_00000000-0000-4000-8000-000000000001',
    organization_id: session.organization_id, signing_key: {
      key_id: `sha256:${createHash('sha256').update(signingKey).digest('hex')}`, algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: signingKey.toString('base64'),
    },
  };
  const handoffs = new Map<string, { url: string; token: string }>();
  // Signing in starts a new week, from the fixture's clock.
  const signedIn = mode === 'weekly-passed'
    ? { ...session, access_expires_at: '2026-09-29T10:30:00.000Z', refresh_expires_at: '2026-10-05T22:30:00.000Z', hard_reauthentication_at: '2026-10-05T22:30:00.000Z' }
    : session;
  // The browser, never a real one: past Google, the Authority's callback page
  // posts the new session to the loopback receiver the sign-in began with.
  const openAuthorizationUrl = (address: string): boolean => {
    // A tool's consent page: the person is "in the browser" until the attempt's reads settle it.
    if (address === JIRA_CONNECT_LINK) return true;
    const url = new URL(address);
    const state = url.searchParams.get('state') ?? '';
    const handoff = url.origin === IDENTITY_PROVIDER ? handoffs.get(state) : undefined;
    if (!handoff) return false;
    handoffs.delete(state);
    // signed-out-not-bound: a Google account the organization never invited; the callback page says so instead.
    const form = new URLSearchParams(mode === 'signed-out-not-bound' ? { token: handoff.token, error: 'identity_not_bound' }
      : { token: handoff.token, session: Buffer.from(JSON.stringify(signedIn)).toString('base64url') });
    const post = async () => {
      // Hold the browser callback until the test has put ECHO in the background.
      for (let waited = 0; existsSync(join(home, 'hold-signin')) && waited < 30_000; waited += 25) await new Promise(resolve => setTimeout(resolve, 25));
      await globalThis.fetch(handoff.url, { method: 'POST', body: form }).catch(() => undefined);
    };
    void post();
    return true;
  };

  const roleOf = (projectId: string, membershipId: string) => members[projectId]?.find(entry => entry.membership_id === membershipId)?.role;
  /** The Authority's filing rule: a member files only what they added, and takes out what they added or anything from a project they lead. */
  const mayFile = (projectId: string, theirs: boolean, operation: string) => {
    const role = roleOf(projectId, session.membership_id);
    return role !== undefined && (theirs || (operation === 'dissociate' && role === 'lead'));
  };
  const nameOf = (membershipId: string) => desktop.people.find(person => person.membership_id === membershipId)?.display_name ?? 'Someone';
  /** Ten at a time: the first page, or the rest after SECOND_PAGE. */
  const paged = <T>(all: readonly T[], cursor: unknown) => {
    const from = cursor === SECOND_PAGE ? PAGE : 0;
    return { items: all.slice(from, from + PAGE), next_cursor: from + PAGE < all.length ? SECOND_PAGE : null };
  };
  // The fixture's documents were saved by someone else, so their request IDs stay private (ADR-0023);
  // only one Ari uploaded carries its own.
  const documentMetadata = (document: StoredDocument) => ({
    schema_version: 2, kind: 'echo-person-document-metadata-v2', request_id: ownDocuments.has(document.document_id) ? document.request_id : null,
    filename: document.filename,
    title: document.title, content_length: Buffer.byteLength(document.original), sha256: digestOf(document.original), audience: document.audience,
    association_project_ids: document.association_project_ids, document_id: document.document_id,
    detected_media_type: document.detected_media_type, received_at: document.received_at, state: 'saved',
    extraction_state: document.extraction_state, extraction_detail: null, extractor: EXTRACTOR,
    extracted_text_bytes: document.pages.flat().reduce((total, chunk) => total + Buffer.byteLength(chunk.text), 0),
  });
  /** A document you can read here: any of yours, or, asked in a project, one filed in it. */
  const findDocument = (id: string, projectId: string | null) => documents.find(document => document.document_id === id &&
    (projectId === null || document.association_project_ids.includes(projectId)));
  /**
   * A change, as the Authority makes one: once per request id. `apply` returns
   * the receipt, or a failure the change was refused with.
   */
  const change = (path: string, body: Record<string, unknown> | undefined, apply: () => Record<string, unknown> | Response, status = 200): Response => {
    const requestId = String(body?.request_id);
    const command = JSON.stringify([path, body]);
    const earlier = applied.get(requestId);
    if (earlier) return earlier.command === command ? json(earlier.receipt, earlier.status) : failure('conflict', 409);
    const receipt = apply();
    if (receipt instanceof Response) return receipt;
    applied.set(requestId, { command, receipt, status });
    changes += 1;
    // Made, but the first change's reply is lost on its way back.
    if (mode === 'change-reply-lost' && changes === 1) {
      return failure('unavailable', 503);
    }
    return json(receipt, status);
  };
  /**
   * A change made elsewhere, once the test says so (a file of that name in its home): the change check sees it, and so does
   * the next read of what it changed.
   */
  const elsewhere = (name: string) => existsSync(join(home, name));
  /** Your projects, in the list's order, as the mode has them; renamed elsewhere (`renamed`), the first one's name says so. */
  const listed = (): { project_id: string; name: string; role: 'lead' | 'member' }[] => {
    const rows = listedNow();
    return elsewhere('renamed') && rows[0] ? [{ ...rows[0], name: `${rows[0].name}, renamed` }, ...rows.slice(1)] : rows;
  };
  const listedNow = (): { project_id: string; name: string; role: 'lead' | 'member' }[] => {
    if (GRANOLA_PROJECTS.has(mode)) return [
      { project_id: THERMOSTAT, name: 'Thermostat redesign', role: 'lead' },
      { project_id: SUPPLIER, name: 'Supplier review', role: 'member' },
    ];
    const numbered = (count: number, digit: string, name: (index: number) => string) => Array.from({ length: count }, (_, index) => ({
      project_id: `prj_${String(index + 1).padStart(8, '0')}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
      name: name(index), role: 'member' as const,
    }));
    if (mode === 'many-projects') return numbered(13, '1', index => `Project ${index + 1}`);
    // Added to a project made since the desktop first looked: the newest, it leads.
    if (mode === 'project-added' && elsewhere('project-added')) {
      return [{ project_id: 'prj_55555555-5555-4555-8555-555555555555', name: 'Comet', role: 'member' }, ...projects];
    }
    return projects;
  };
  /**
   * A capture's projects, as the Authority takes them: the projects it is
   * filed in and the projects whose members can read it are each a sorted,
   * unique set of at most twenty (a projects audience names at least one), and
   * every one is yours. The refusal, or null.
   */
  const refusedProjects = (body: Record<string, unknown> | undefined): Response | null => {
    const canonical = (value: unknown, minimum: number): value is string[] => Array.isArray(value) &&
      value.length >= minimum && value.length <= MAX_PROJECT_SET &&
      value.every((id: unknown, index) => typeof id === 'string' && PROJECT_ID.test(id) && (index === 0 || value[index - 1] < id));
    const audience = (body?.audience ?? {}) as Record<string, unknown>;
    const keys = Object.keys(audience).sort().join(',');
    const single = [audience.project_id];
    const readers = audience.kind === 'projects' && keys === 'kind,project_ids' && canonical(audience.project_ids, 1) ? audience.project_ids
      : audience.kind === 'project' && keys === 'kind,project_id' && canonical(single, 1) ? single
        : (audience.kind === 'only_me' || audience.kind === 'team') && keys === 'kind' ? [] : null;
    const filed = body?.association_project_ids;
    if (readers === null || !canonical(filed, 0)) return failure('invalid_request', 400);
    const yours = new Set(listed().filter(project => (projectStatus.get(project.project_id) ?? 'active') === 'active').map(project => project.project_id));
    return [...filed, ...readers].every(id => yours.has(id)) ? null : failure('not_found', 404);
  };
  /** A project keeps at least one lead. */
  const leadsAfter = (projectId: string, membershipId: string, role: 'lead' | 'member' | null) =>
    (members[projectId] ?? []).filter(entry => (entry.membership_id === membershipId ? role : entry.role) === 'lead').length;

  // Person list and open: your notes, documents and approved meetings, as rows, and each one opened by its ref.
  /** A project that is yours: listed, and one you have not left. The numbered modes' projects have no member list. */
  const joined = () => listed().filter(project => members[project.project_id] === undefined || roleOf(project.project_id, session.membership_id));
  const visibility = (audience: Record<string, unknown>) => audience.kind === 'only_me' ? 'only_me' : audience.kind === 'team' ? 'team' : 'project';
  /** A row's projects: yours only, in your projects' order. */
  const rowProjects = (ids: readonly string[]) => joined().filter(project => ids.includes(project.project_id))
    .map(project => ({ project_id: project.project_id, name: project.name }));
  type Row = Record<string, unknown> & { ref: string; added_at: string };
  const noteRow = (id: string): Row => {
    const note = catalog.get(id)!;
    return { ref: `note:${id}`, kind: 'note', title: note.title, added_at: new Date(note.received_at).toISOString(), visibility: visibility(note.audience),
      projects: rowProjects([...filed].filter(([, ids]) => ids.includes(id)).map(([projectId]) => projectId)) };
  };
  const documentRow = (document: StoredDocument): Row => ({
    ref: `document:${document.document_id}`, kind: 'document', title: document.title, added_at: new Date(document.received_at).toISOString(),
    visibility: visibility(document.audience), projects: rowProjects(document.association_project_ids), media_type: document.detected_media_type,
    extraction_state: document.extraction_state, size_bytes: Buffer.byteLength(document.original),
  });
  const meetingRow = (meeting: Meeting): Row => ({
    ref: `meeting:${meeting.record_sha256}`, kind: 'meeting', title: meeting.title, added_at: meeting.added_at, visibility: meeting.visibility,
    projects: rowProjects(meeting.project_ids), meeting_date: meeting.meeting_date,
  });
  /**
   * An approved record as `GET /v1/person/records?record_sha256` lists it, or null for none you can read: the answer's
   * own (Tuesday sync), its brief as approved; or a meeting's, its atoms as the brief's signals, each with the transcript
   * line it came from, its owners as the approver confirmed them. Its envelope was issued when the meeting was added.
   */
  const listedRecord = (digest: string): Record<string, unknown> | null => {
    const meeting = meetings.find(entry => entry.record_sha256 === digest);
    const answers = digest === desktop.record.record_sha256;
    if (!answers && !meeting) return null;
    const signals = (meeting?.atoms ?? []).map((atom, index) => ({ ...atom, id: `s${index + 1}` }));
    const brief = answers ? desktop.record.brief : {
      meeting: { id: digest, title: meeting!.title, time: { actual_start_at: meeting!.started_at, timezone: meeting!.timezone },
        participants: meeting!.participants.map((name, index) => ({ id: `p${index + 1}`, display_name: name })) },
      ...Object.fromEntries((['decision', 'action', 'rationale'] as const).map(kind => [`${kind}s`,
        signals.filter(signal => signal.kind === kind).map(({ owner: _owner, ...signal }) => ({
          ...signal, evidence: [{ quote: `[10:00] ${meeting!.participants[0]}: ${signal.text}` }],
        }))])),
    };
    const owners = signals.flatMap(signal => (signal.owner === undefined ? [] : [{ signal_id: signal.id, owner: signal.owner }]));
    const event = { kind: 'approved', policy_id: meeting?.visibility === 'only_me' ? 'restricted-reviewer-person-v2' : 'project-members-readable-person-v1',
      approved_snapshot: { approved_payload: { brief } } };
    return {
      position: 1, approval_id: 'apr_fixture', record_sha256: digest,
      envelope: { record_sha256: digest, body: { issued_at: meeting?.added_at ?? TUESDAY_ADDED, event, human_act_resolution_ref: { action_owners: owners } } },
      source_metadata: { record_approved_by: { display_name: answers ? desktop.record.approved_by : meeting!.approved_by } },
    };
  };
  /** Ari's access admits a note or a document: any audience but Only me, and Only me when it is Ari's own (ADR-0049). */
  const readsNote = (id: string) => catalog.get(id)?.audience.kind !== 'only_me' || ownNotes.has(id);
  const readsDocument = (document: StoredDocument) => document.audience.kind !== 'only_me' || ownDocuments.has(document.document_id);
  /**
   * Everything in a scope, newest first, then by ref: what only Ari can read, filed or not (Ari's own notes and documents
   * under the Only me lock, and the meetings only their approver can read), or what is filed in a project that Ari's access
   * admits, a locked item there only when it is Ari's.
   */
  const rows = (scope: { only_me: true } | { project_id: string }): Row[] => {
    const notes = 'only_me' in scope ? [...ownNotes].filter(id => catalog.get(id)?.audience.kind === 'only_me') : (filed.get(scope.project_id) ?? []).filter(readsNote);
    const all = [
      ...notes.filter(id => catalog.has(id)).map(noteRow),
      ...documents.filter(document => 'only_me' in scope ? document.audience.kind === 'only_me' && ownDocuments.has(document.document_id)
        : document.association_project_ids.includes(scope.project_id) && readsDocument(document)).map(documentRow),
      ...meetings.filter(meeting => 'only_me' in scope ? meeting.visibility === 'only_me' && meeting.approver === session.membership_id
        : meeting.project_ids.includes(scope.project_id)).map(meetingRow),
    ];
    return all.sort((a, b) => a.added_at === b.added_at ? (a.ref < b.ref ? -1 : 1) : a.added_at > b.added_at ? -1 : 1);
  };
  const pageCursor = (key: string, from: number) => Buffer.from(`${key}|${from}`).toString('base64url');
  /** Where a cursor this fixture gave goes on from, or null for any other. */
  const pageFrom = (key: string, cursor: string | undefined): number | null => {
    if (cursor === undefined) return 0;
    const [given, from] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    return given === key && /^[1-9][0-9]*$/.test(from ?? '') ? Number(from) : null;
  };

  // Ask progress (ADR-0039). The fixture answer's meeting is Tuesday sync, whose decision d1 an answer cites by its atom id.
  const TUESDAY = desktop.record.record_sha256;
  const atomOf = (signal: string) => organizationApi.personRecordAtomIdV1(TUESDAY, signal);
  /** What the Ask reads, each as a citation: Tuesday sync's decision, a note's passage and a Jira ticket. */
  const progressItems = () => {
    const [record, passage] = desktop.answer.citations as { citation: Record<string, unknown>; label: string; visibility: string }[];
    return [
      { citation: { ...record!.citation, atom_id: atomOf('d1') }, kind: 'decision', label: 'Tuesday sync', visibility: 'team', ref: `meeting:${TUESDAY}` },
      { ...passage!, kind: 'note', ref: `note:${desktop.notes[0]!.context_id}` },
      thermTicket('ECHO-7', 'Jira launch', '10007'),
    ];
  };
  /**
   * A streamed Ask: research progress, then its answer and receipt once the test writes `release-ask`. A client that stops
   * the request first ends the research, and `ask-stopped` holds the question it stopped.
   */
  /** Every Ask streams (ADR-0039): an answer at once, with nothing looked through. */
  const answered = (response: unknown): Response => new Response(api.formatPersonAskProgressEventV3({ type: 'answer', response, receipt: { looked_through: 0, elapsed_ms: 0, rows: [] } }),
    { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
  const progressStream = (question: string, scope: Record<string, unknown>, signal: AbortSignal | undefined): Response => {
    const format = api.formatPersonAskProgressEventV3;
    const items = progressItems();
    const searched = { type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'documents' }, { kind: 'tickets', tool_id: 'jira' }], found: 3 };
    const [part] = desktop.answer.parts as Record<string, unknown>[];
    const response = { ...desktop.answer, schema_version: 8, kind: 'echo-clean-person-answer-v8', scope, citations: items.slice(0, 2), parts: [{ ...part, question }] };
    const steps = [{ type: 'stage', stage: 'searching' }, searched, { type: 'stage', stage: 'reading', pending: items.length }, { type: 'read', items }];
    const receipt = { looked_through: items.length, elapsed_ms: 48_000, rows: [searched, { type: 'read', items }] };
    const encoder = new TextEncoder();
    let cancelled = false;
    const frames = (async function* () {
      for (const step of steps) yield format(step);
      while (!existsSync(join(home, 'release-ask'))) {
        if (cancelled || signal?.aborted) { writeFileSync(join(home, 'ask-stopped'), question); return; }
        await new Promise(resolveLater => setTimeout(resolveLater, 25));
      }
      yield format({ type: 'stage', stage: 'writing' });
      yield format({ type: 'stage', stage: 'checking_access' });
      yield format({ type: 'answer', response, receipt });
    })();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await frames.next();
        if (next.done) controller.close(); else controller.enqueue(encoder.encode(next.value));
      },
      cancel() { cancelled = true; },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
  };

  // Open items. Ari's own check of Pilot planning finds two once it is done;
  // in the owner modes Mina has sent Ari items of hers already.
  const ARI = { membership_id: session.membership_id, name: 'Ari' };
  const PILOT_RUN = 'run_00000000-0000-4000-8000-000000000020';
  const PILOT_RECORD = digestOf('record:Pilot planning');
  const PRD_PAGE = { kind: 'page', label: 'Thermostat PRD · Pilot scope', visibility: 'only_me', citation: {
    kind: 'page', tool_id: 'confluence', external_scope_id: CONFLUENCE_CLOUD, page_id: '12345', section_id: 'pilot-scope', version: '7',
    permalink: 'https://example.atlassian.net/wiki/pages/viewpage.action?pageId=12345', text_sha256: digestOf('Thermostat PRD: Pilot scope') } };
  /** A supplier page in a Confluence space Ari cannot open: its title never reaches Ari. */
  const SUPPLIER_BRIEF = { kind: 'page', label: 'Supplier brief · Lead time', visibility: 'only_me', citation: {
    kind: 'page', tool_id: 'confluence', external_scope_id: CONFLUENCE_CLOUD, page_id: '23456', section_id: 'lead-time', version: '3',
    permalink: 'https://example.atlassian.net/wiki/pages/viewpage.action?pageId=23456', text_sha256: digestOf('Supplier brief: Lead time') } };
  const openItems: OpenItem[] = [];
  /** An item Mina sent, or has not sent yet; an owner she picked she picked as she sent it. */
  const minaSent = (item: Omit<OpenItem, 'approver' | 'state' | 'sent_at' | 'state_set_at' | 'state_set_by' | 'owner_set_at' | 'owner_set_by' | 'send_included'>
    & { sent_at: string | null }): OpenItem => {
    const picked = item.owner.match === 'picked' && item.sent_at !== null;
    return { ...item, approver: MINA, state: item.sent_at === null ? 'unsent' : 'open', state_set_at: item.sent_at, state_set_by: item.sent_at === null ? null : MINA,
      owner_set_at: picked ? item.sent_at : null, owner_set_by: picked ? MINA : null, send_included: item.sent_at === null ? null : true };
  };
  // Owner modes receive someone else's items without Granola being available.
  // granola-owner-later holds one back until the test has Mina send it.
  const sentToAri = mode === 'granola-owner';
  if (sentToAri || mode === 'granola-owner-later') {
    openItems.push(minaSent({
      item_id: 'itm_00000000-0000-4000-8000-000000000041', run_id: 'run_00000000-0000-4000-8000-000000000041', kind: 'ticket',
      decision: { approval_id: 'apr_' + 'c'.repeat(64), record_sha256: digestOf('record:Pilot planning, approved by Mina'), title: 'Pilot planning',
        first_line: 'Launch the pilot next week.', approved_at: '2026-10-06T18:00:00.000Z', project_ids: [THERMOSTAT] },
      readable: true, opens: true, live: { citation: thermTicket('ECHO-12', 'Pilot launch', '10012'), says_now: 'The pilot launch is planned for the end of the month.',
        assignee: 'Ari', status: 'In Progress', due_at: '2026-10-30' },
      relation: 'conflicts', expected: 'launch next week', owner: { ...ARI, match: 'jira_account' }, created_at: '2026-10-06T18:05:00.000Z', sent_at: '2026-10-06T19:00:00.000Z',
    }));
    // A decision reader who cannot open the item: Ari reads Pilot planning, but this ticket is in a
    // Jira project Ari has no access to. Its title, link and assignee never reach Ari.
    if (sentToAri) {
      openItems.push(minaSent({
        item_id: 'itm_00000000-0000-4000-8000-000000000044', run_id: 'run_00000000-0000-4000-8000-000000000041', kind: 'ticket',
        decision: { approval_id: 'apr_' + 'c'.repeat(64), record_sha256: digestOf('record:Pilot planning, approved by Mina'), title: 'Pilot planning',
          first_line: 'Launch the pilot next week.', approved_at: '2026-10-06T18:00:00.000Z', project_ids: [THERMOSTAT] },
        readable: true, opens: false,
        live: { citation: thermTicket('ECHO-31', 'Trace sign-off', '10031'), says_now: 'The trace is signed off after the launch.',
          assignee: 'S. Okafor', status: 'Blocked', due_at: '2026-11-12' },
        relation: 'conflicts', expected: 'confirm the trace by Friday', owner: { ...ARI, match: 'picked' }, created_at: '2026-10-06T18:05:00.000Z',
        sent_at: '2026-10-06T19:00:00.000Z',
      }));
    }
    // A ticket Ari cannot open, from a decision Ari cannot read: only Send told Ari of it. In
    // granola-owner-later Mina sends it when the test asks.
    openItems.push(minaSent({
      item_id: 'itm_00000000-0000-4000-8000-000000000042', run_id: 'run_00000000-0000-4000-8000-000000000042', kind: 'ticket',
      decision: { approval_id: 'apr_' + 'd'.repeat(64), record_sha256: digestOf('record:Vendor review'), title: 'Vendor review',
        first_line: 'Order with six weeks of lead time.', approved_at: '2026-10-05T15:00:00.000Z', project_ids: [SUPPLIER] },
      readable: false, opens: false, live: { citation: thermTicket('ECHO-20', 'Vendor order', '10020'), says_now: 'The vendor order goes out in four weeks.',
        assignee: 'Rafael Moreno', status: 'To Do' },
      relation: 'conflicts', expected: 'order six weeks ahead', owner: { ...ARI, match: 'picked' },
      created_at: '2026-10-05T15:05:00.000Z', sent_at: sentToAri ? '2026-10-05T16:00:00.000Z' : null,
    }));
  }
  // altitude (Home altitude v1): Apollo is off track (Mina's ticket open nine days, a follow-up ECHO found no owner for, Rafael's
  // done), Beacon at risk (Rafael's page open four days, Ari's open since today). Times count back from now, as Home measures.
  if (mode === 'altitude') {
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const fanCurve = { approval_id: 'apr_' + '6'.repeat(64), record_sha256: digestOf('record:Fan curve'), title: 'Fan curve', first_line: 'Peak at 60%.',
      approved_at: ago(10), project_ids: [THERMOSTAT] };
    const vendor = { approval_id: 'apr_' + '7'.repeat(64), record_sha256: digestOf('record:Vendor review'), title: 'Vendor review', first_line: 'Two suppliers.',
      approved_at: ago(5), project_ids: [SUPPLIER] };
    const item = (n: number, rest: Pick<OpenItem, 'kind' | 'decision' | 'owner' | 'state' | 'expected'> & { sent: number | null; made: number; set?: number }): OpenItem => ({
      item_id: `itm_00000000-0000-4000-8000-0000000000${n}`, run_id: `run_00000000-0000-4000-8000-0000000000${n}`, readable: true, opens: true,
      live: { citation: thermTicket(`ECHO-${n}`, rest.expected ?? 'Follow-up', `100${n}`), says_now: 'As it was.' }, relation: rest.kind === 'action' ? null : 'needs_updating',
      approver: ARI, created_at: ago(rest.made), sent_at: rest.sent === null ? null : ago(rest.sent), state_set_at: rest.sent === null ? null : ago(rest.set ?? rest.sent),
      state_set_by: rest.sent === null ? null : ARI, owner_set_at: null, owner_set_by: null, send_included: rest.sent === null ? null : true,
      kind: rest.kind, decision: rest.decision, owner: rest.owner, state: rest.state, expected: rest.expected,
    });
    openItems.push(
      item(61, { kind: 'ticket', decision: fanCurve, owner: { ...MINA, match: 'name' }, state: 'open', expected: 'Spec page says 60%', sent: 9, made: 9 }),
      item(62, { kind: 'action', decision: fanCurve, owner: { ...ARI, match: 'approver' }, state: 'unsent', expected: 'Heat-sink sourcing', sent: null, made: 2 }),
      item(63, { kind: 'action', decision: fanCurve, owner: { ...RAFAEL, match: 'name' }, state: 'done', expected: 'Soak test plan', sent: 6, made: 6, set: 1 }),
      { ...item(64, { kind: 'page', decision: vendor, owner: { ...RAFAEL, match: 'name' }, state: 'open', expected: 'Lead time', sent: 4, made: 4 }), live: { citation: SUPPLIER_BRIEF, says_now: 'Four weeks.' } },
      item(65, { kind: 'action', decision: vendor, owner: { ...ARI, match: 'name' }, state: 'open', expected: 'Order samples', sent: 0, made: 0 }),
    );
  }
  // The meetings Mina approved that Ari can read, each once: in their project's feed, where their follow-ups line shows.
  for (const item of openItems.filter(entry => entry.readable)) {
    if (meetings.some(meeting => meeting.record_sha256 === item.decision.record_sha256)) continue;
    meetings.push({
      record_sha256: item.decision.record_sha256, title: item.decision.title, added_at: item.decision.approved_at, meeting_date: item.decision.approved_at.slice(0, 10),
      visibility: 'project', project_ids: item.decision.project_ids, approver: MINA.membership_id, started_at: item.decision.approved_at, timezone: 'Europe/London',
      participants: ['Mina Patel', 'Ari'], approved_by: 'Mina Patel', atoms: [{ kind: 'decision', text: item.decision.first_line ?? item.decision.title }],
    });
  }
  /**
   * What Ari's check of Pilot planning found, written once when it is done: unsent, with exact owners or Ari. The
   * affected items first (ECHO-12, Mina's in Jira; the PRD page, no one's, so Ari's: Pick owner), then the meeting's own
   * actions, each the person Ari confirmed on Approve when exactly one member has that name, else Ari.
   */
  const writeFound = () => {
    if (granolaRun?.state !== 'done' || openItems.some(item => item.run_id === PILOT_RUN)) return;
    const first = recordsOf(granolaReview)[0];
    const decision = { approval_id: first?.approval_id ?? 'apr_' + 'a'.repeat(64), record_sha256: PILOT_RECORD, title: 'Pilot planning', first_line: 'Launch the pilot next week.',
      approved_at: '2026-10-07T10:00:00.000Z', project_ids: [...first?.project_ids ?? []] };
    const unsent = { run_id: PILOT_RUN, decision, readable: true, approver: ARI, state: 'unsent' as const, created_at: '2026-10-07T10:05:00.000Z', sent_at: null, state_set_at: null,
      state_set_by: null, owner_set_at: null, owner_set_by: null, send_included: null };
    const confirmed = Array.isArray(granolaReview?.owners) ? granolaReview.owners as { signal_id: string; owner: string }[] : [];
    const ownerOf = (signalId: string): OpenItem['owner'] => {
      const named = desktop.people.filter(person => person.display_name === confirmed.find(entry => entry.signal_id === signalId)?.owner);
      return named.length === 1 ? { membership_id: named[0]!.membership_id, name: named[0]!.display_name, match: 'name' } : { ...ARI, match: 'approver' };
    };
    openItems.push(
      { ...unsent, item_id: 'itm_00000000-0000-4000-8000-000000000031', kind: 'ticket', relation: 'conflicts', expected: 'launch next week',
        opens: true, live: { citation: thermTicket('ECHO-12', 'Pilot launch', '10012'), says_now: 'The pilot launch is planned for the end of the month.',
          assignee: 'Mina Patel', status: 'In Progress', due_at: '2026-10-30' }, owner: { ...MINA, match: 'jira_account' } },
      { ...unsent, item_id: 'itm_00000000-0000-4000-8000-000000000032', kind: 'page', relation: 'needs_updating', expected: 'pilot starts next week',
        opens: true, live: { citation: PRD_PAGE, says_now: 'starts after freeze' }, owner: { ...ARI, match: 'approver' } },
      ...MEETING_ACTIONS.map((action, index): OpenItem => ({ ...unsent, item_id: `itm_00000000-0000-4000-8000-00000000003${8 + index}`, kind: 'action',
        relation: 'needs_updating', expected: action.text, opens: false, live: {}, owner: ownerOf(action.signal_id) })),
    );
  };
  /** A destination group's key: its projects, and whether they are kept for Ari alone (the route says `private: true`). */
  function destinationKey(destination: { readonly project_ids: readonly string[] | null; readonly private?: true }): string {
    return JSON.stringify([destination.private === true, destination.project_ids]);
  }
  /**
   * The records an approval wrote: one per destination group of its routes (projects, kept private or not), ordered by each
   * group's first item, each under its own approval id. The first is Pilot planning's record (PILOT_RECORD); its check is PILOT_RUN.
   */
  function recordsOf(decided: Record<string, unknown> | undefined): { approval_id: string; project_ids: string[]; private?: true }[] {
    const routes = decided?.action === 'approve' && Array.isArray(decided.routes) ? decided.routes as { signal_id: string; project_ids: string[] | null; private?: true }[] : [];
    const groups = new Map<string, { project_ids: string[]; private?: true }>();
    for (const route of routes) {
      if (route.project_ids !== null && !groups.has(destinationKey(route))) {
        groups.set(destinationKey(route), { project_ids: route.project_ids, ...(route.private === true ? { private: true as const } : {}) });
      }
    }
    // A private group's id hashes `private` in, as the Authority's does, so it is never the id of the same projects shared.
    return [...groups.values()].map(group => ({ approval_id: 'apr_' + digestOf(`route:${JSON.stringify(group.project_ids)}${group.private === true ? ':private' : ''}`).slice(7), ...group }));
  }
  /** Pilot planning, approved by Ari: in the projects it was approved into, where its record opens; for Ari alone when kept private there. */
  const pilotMeeting = (projectIds: string[], kept = false): Meeting => ({
    record_sha256: PILOT_RECORD, title: 'Pilot planning', added_at: '2026-10-07T10:00:00.000Z', meeting_date: '2026-10-06',
    visibility: projectIds.length > 0 && !kept ? 'project' : 'only_me', project_ids: projectIds, approver: session.membership_id,
    started_at: '2026-10-06T16:00:00.000Z', timezone: 'Europe/London', participants: ['Ari', 'Mina Patel', 'Rafael Moreno'], approved_by: 'Ari',
    atoms: [{ kind: 'decision', text: 'Launch the pilot next week.' }, { kind: 'action', text: 'Send the revised quote', owner: 'Rafael Moreno' },
      { kind: 'action', text: 'Confirm the trace', owner: 'Mina Patel' }],
  });
  // Ari sent Pilot planning's follow-ups. The first assignment reply will be lost.
  if (mode === 'granola-review-assign-lost') {
    granolaApproved = true;
    granolaReview = { action: 'approve', routes: routesTo([THERMOSTAT]), owners: MEETING_ACTIONS.map(action => ({ signal_id: action.signal_id, owner: action.owner })) };
    granolaRun = { state: 'done', error_code: null };
    meetings.push(pilotMeeting([THERMOSTAT]));
    writeFound();
    const found = openItems.find(item => item.run_id === PILOT_RUN)!;
    const sentAt = '2026-10-07T11:00:00.000Z';
    openItems.push({ ...found, item_id: 'itm_00000000-0000-4000-8000-000000000033', kind: 'page', relation: 'conflicts', expected: 'parts ordered for next week',
      opens: false, live: { citation: SUPPLIER_BRIEF, says_now: 'Parts are ordered with six weeks of lead time.' }, owner: { ...RAFAEL, match: 'picked' },
      owner_set_at: sentAt, owner_set_by: ARI });
    // Everything was sent.
    for (const item of openItems.filter(entry => entry.run_id === PILOT_RUN)) {
      Object.assign(item, { state: 'open', sent_at: sentAt, state_set_at: sentAt, state_set_by: ARI, send_included: true });
    }
  }
  const mineAsOwner = (item: OpenItem) => item.owner.membership_id === ARI.membership_id;
  const involved = (item: OpenItem) => item.approver.membership_id === ARI.membership_id || mineAsOwner(item);
  /** Ari sees a row whose decision Ari can read, and an item sent to Ari as its owner. */
  const visible = (item: OpenItem) => item.readable || (mineAsOwner(item) && item.state !== 'unsent');
  /**
   * A row rebuilt for Ari: the decision only for a reader, what it says now only when Ari could open it (and `live`: a
   * rows read opens nothing), and how its live read went: opened, refused to Ari, or not answered just now. A
   * meeting's action is never read. Before Send only its approver may change it, by picking its owner.
   */
  const itemView = (item: OpenItem, live: boolean) => {
    const reach = item.kind === 'action' || !live ? 'not_read' : item.outage ? 'unavailable' : item.opens ? 'opened' : 'no_access';
    const person = (named: Named | null) => (named === null ? null : { ...named, active: true });
    return {
      item_id: item.item_id, run_id: item.run_id, kind: item.kind, ...(item.readable ? { decision: item.decision } : {}), ...(reach === 'opened' ? { current: item.live } : {}),
      relation: item.relation, expected: item.expected, approver: { ...item.approver, active: true }, owner: { ...item.owner, active: true },
      waits_on: item.state === 'unsent' ? 'approver' : 'owner', state: item.state, created_at: item.created_at, sent_at: item.sent_at, state_set_at: item.state_set_at,
      state_set_by: person(item.state_set_by), owner_set_at: item.owner_set_at, owner_set_by: person(item.owner_set_by),
      // `check` is retired with sweeps: null, as the Authority sends it until V17.
      send_included: item.send_included, check: null,
      can: { set_state: item.state !== 'unsent' && involved(item), assign: item.state === 'unsent' ? item.approver.membership_id === ARI.membership_id : involved(item) },
      reach,
    };
  };
  /** Send commands applied, by command id, with the exact items each listed: a resend gets the same answer, other items under it conflict. */
  const sends = new Map<string, { items: string; result: { sent: number; not_relevant: number } }>();
  /** Mina has marked done what Ari sent her (the `mina-done` file in the test's home). */
  let minaDone = false;
  let assigns = 0;

  // Your connections to the organization's tools, as Tools changes them.
  let slackLinked = true;
  // Modes that map a project to a tool start connected to it, as a lead must be to pick.
  let jiraLinked = (mode === 'ask-ticket');
  const confluenceLinked = (mode === 'ask-confluence');
  let jiraAttempt: { attempt: string; expires_at: string; status: string; failure_reason: string | null; reads: number } | null = null;

  /** Mina marks done the open items Ari sent her (the `mina-done` file), and sends Ari another (the `mina-sends` file). */
  const followUpsElsewhere = () => {
    const at = new Date().toISOString();
    if (!minaDone && elsewhere('mina-done')) {
      minaDone = true;
      for (const item of openItems) {
        if (item.state === 'open' && item.owner.membership_id === MINA.membership_id && item.approver.membership_id === ARI.membership_id) {
          Object.assign(item, { state: 'done', state_set_at: at, state_set_by: MINA });
        }
      }
    }
    if (mode === 'granola-owner-later' && elsewhere('mina-sends')) minaSendsAnother();
  };
  const minaSendsAnother = () => {
    const at = new Date().toISOString();
    const later = openItems.find(item => item.state === 'unsent' && item.approver.membership_id === MINA.membership_id);
    if (later) Object.assign(later, { state: 'open', sent_at: at, state_set_at: at, state_set_by: MINA, send_included: true });
  };
  /**
   * The change check (desktop refresh and notifications v1): one fingerprint per area of what Ari may read, as the Authority
   * builds them, and the pace the test's `changes-seconds` file says.
   */
  // `project-activity`: once a test writes `activity-arrived`, Mina's note reached Apollo just then, by this computer's clock, the
  // clock the page keeps when you last opened a project: Apollo's newest arrival, and a row of its list.
  const arrivals = new Map<string, string>();
  const arrive = () => {
    if (mode !== 'project-activity' || arrivals.size > 0 || !elsewhere('activity-arrived')) return;
    const apollo = desktop.projects[0]!.project_id;
    const at = new Date().toISOString();
    const id = `ctx_${'d'.repeat(64)}`;
    catalog.set(id, { received_at: at, title: 'Launch checklist v2', text: 'Mina added the launch checklist v2.', audience: { kind: 'projects' } });
    filed.set(apollo, [...filed.get(apollo) ?? [], id]);
    arrivals.set(apollo, at);
  };

  const changeCheck = () => {
    followUpsElsewhere();
    const digest = (rows: unknown) => digestOf(JSON.stringify(rows));
    const projectsNow = listed().map(project => [project.project_id, project.name, projectStatus.get(project.project_id) ?? 'active', project.role]);
    const followUps = openItems.filter(item => visible(item) && (involved(item) || item.owner_set_by?.membership_id === ARI.membership_id))
      .map(item => [item.item_id, item.state, item.owner.membership_id, item.owner_set_at, item.state_set_at, item.sent_at]);
    const reviews = [granolaImported, granolaApproved, granolaRun?.state ?? null, ...extraRuns.map(extra => extra.state)];
    // An hour unless the test says, so a test's own reads never wait on, or race, a check it did not ask for; but 15 s while
    // one of Ari's checks is queued or running, as the Authority paces it (DSK-1), so the next check checks in, or sees it end.
    const going = [granolaRun, ...extraRuns].some(entry => entry?.state === 'pending' || entry?.state === 'running');
    const seconds = elsewhere('changes-seconds') ? Number(readFileSync(join(home, 'changes-seconds'), 'utf8')) : going ? 15 : 3600;
    return { kind: 'echo-person-changes-v1', areas: { projects: digest(projectsNow), follow_ups: digest(followUps), reviews: digest(reviews) },
      check_again_after_seconds: seconds };
  };

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';
    // A document's metadata travels in a header; its bytes are the streamed body.
    const metadata = new Headers(init?.headers).get('x-echo-document-metadata');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown>
      : metadata ? JSON.parse(Buffer.from(metadata, 'base64url').toString('utf8')) as Record<string, unknown> : undefined;
    appendFileSync(join(home, 'calls.jsonl'), `${JSON.stringify({ method, path: url.pathname, query: url.search, body })}\n`);
    if (url.origin !== AUTHORITY) throw new Error('Unexpected authority');
    const path = url.pathname;
    // Kim signs in on this computer while the request named in `switch-on` is on its way; it is still answered.
    if (elsewhere('switch-on') && readFileSync(join(home, 'switch-on'), 'utf8') === path) {
      unlinkSync(join(home, 'switch-on'));
      store.install(AUTHORITY, 'oau_00000000-0000-4000-8000-000000000001', { ...session, membership_id: 'mem_55555555-5555-4555-8555-555555555555', display_name: 'Kim' });
    }

    if (method === 'GET' && path === '/v1/authority-descriptor') return json({ authority_descriptor: descriptor });
    if (method === 'POST' && path === '/v2/session/oidc/begin') {
      const handoff = body?.loopback_handoff as { url: string; token: string } | undefined;
      // An existing identity, or an invitation's one-time grant (with the invited address, from a v2 invitation).
      const keys = Object.keys(body ?? {}).sort().join(',');
      const known = body?.kind === 'existing_identity_login' ? keys === 'kind,loopback_handoff'
        : body?.kind === 'identity_bootstrap' && /^[A-Za-z0-9_-]{43}$/.test(String(body.login_grant)) &&
          ['kind,login_grant,loopback_handoff', 'kind,login_grant,login_hint,loopback_handoff'].includes(keys);
      if (!known || !handoff) return failure('invalid_request', 400);
      const state = randomUUID();
      handoffs.set(state, handoff);
      return json({ authorization_url: `${IDENTITY_PROVIDER}/authorize?state=${state}`, expires_at: '2026-09-21T22:11:00.000Z' }, 201);
    }
    if (method === 'POST' && path === '/v2/session/refresh') {
      if (mode === 'refresh-fails') return failure('unavailable', 503);
      // What fetch throws when the network is not up yet: no connection was made.
      if (mode === 'refresh-offline') {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', syscall: 'connect' }) });
      }
      if (mode === 'refresh-refused') return failure('unauthorized', 401);
      if (mode === 'refresh-hangs') return new Promise<Response>(() => undefined);
      return json({ ...session, access_token: 'B'.repeat(43), refresh_token: 'S'.repeat(43), access_expires_at: '2026-09-22T10:30:00.000Z' });
    }
    if (method === 'GET' && path === '/v4/person/tools') {
      const tool = (tool_id: string, display_name: string, personal_status: string, scope: string | null, subject: string | null) => ({
        tool_id, display_name, availability: 'enabled', personal_status, external_scope_id: scope, external_subject_id: subject, organization_setup: null,
      });
      return json({
        schema_version: 4, kind: 'echo-organization-person-tools', organization_id: session.organization_id, membership_id: session.membership_id,
        tools: [
          slackLinked ? tool('slack', 'Slack (approval notifications)', 'linked', 'T0123ABCD', 'U0123ABCD') : tool('slack', 'Slack (approval notifications)', 'unlinked', 'T0123ABCD', null),
          tool('jira', 'Jira', jiraLinked ? 'linked' : ('unlinked'), JIRA_CLOUD, jiraLinked ? 'atlassian-account-1' : null),
          tool('confluence', 'Confluence', confluenceLinked ? 'linked' : 'unlinked', CONFLUENCE_CLOUD, confluenceLinked ? 'atlassian-account-1' : null),
          mode.startsWith('granola') && !sentToAri ? tool('granola', 'Granola', 'linked', 'workspace', 'ari@example.test') : { tool_id: 'granola', display_name: 'Granola', availability: 'unavailable', personal_status: 'unavailable',
            external_scope_id: null, external_subject_id: null, organization_setup: null },
        ],
      });
    }
    const reviewsRequest = method === 'POST' && path === '/v1/person/reviews';
    if (reviewsRequest) {
      api.validatePersonReviewRequestV1(body);
      if (!mode.startsWith('granola') && !syntheticReview) {
        return body?.operation === 'reviews' ? json({ reviews: [] }) : failure('not_found', 404);
      }
    }
    if ((method === 'POST' && path === '/v1/person/meetings' && mode.startsWith('granola')) || reviewsRequest) {
      const meetingId = '00000000-0000-4000-8000-000000000010';
      const folderId = '00000000-0000-4000-8000-000000000011';
      const decidedOn = granolaApproved ? ('desktop') : null;
      // Decided: where each item went, and the records those routes wrote, one per destination.
      const records = granolaApproved ? recordsOf(granolaReview) : [];
      const routed = new Map((granolaApproved && Array.isArray(granolaReview?.routes) ? granolaReview.routes as { signal_id: string; project_ids: string[] | null; private?: true }[] : [])
        .map(route => [route.signal_id, route]));
      const review = { approval_id: 'apr_' + 'a'.repeat(64), title: syntheticReview ? 'SYNTHETIC STAGING CANARY' : 'Pilot planning',
        project_ids: [...new Set(records.flatMap(record => record.project_ids))].sort(),
        status: granolaApproved ? 'approved' : 'pending', decided_on: decidedOn,
        first_line: 'Launch the pilot next week.', action_count: 2, meeting_at: '2026-10-06T16:00:00.000Z', all_day: false, records };
      switch (body?.operation) {
        case 'home': {
          // A saved watch prepares on its first home read and has been checked on the next.
          const watching = mode === 'granola-preparing' && granolaWatch !== undefined && granolaWatch.watch !== 'off', baseline = watching && granolaBaselineHomeReads++ > 0;
          return json({ connected: true, email: 'ari@example.test', workspace: 'EchoBrain', folders: [{ id: folderId, title: 'ECHO', count: 1 }], settings_sha256: 'sha256:' + 'a'.repeat(64),
            sources: mode === 'granola-preparing' && granolaWatch !== undefined ? [{ source_key: 'pms_fixture', ...granolaWatch, baseline, pending_imports: [],
              checked_at: baseline ? '2026-10-24T17:04:00.000Z' : null, error: null }] : [] });
        }
        // Your recent meetings, or one folder's: the same meeting here.
        case 'browse': return json({ meetings: [{ id: meetingId, title: 'Pilot planning', date: 'Oct 6, 2026 6:30 PM PDT' }] });
        case 'open': return json({ id: meetingId, title: 'Pilot planning', notes: 'Launch the pilot next week.', summary: 'Decision: launch.', truncated: false });
        case 'watch':
          granolaWatch = { watch: body?.watch as string, folder_id: body?.folder_id as string | null, project_id: body?.project_id as string | null }; return json({ status: 'saved' });
        case 'import': granolaImported = true; return json({ status: 'queued' });
        case 'reviews':
          return json({ reviews: granolaImported ? [review] : [] });
        case 'review_open': {
          // The proposal, by its own id or by one of its records' (whose proposal the Authority answers).
          if (body?.approval_id !== review.approval_id && !records.some(record => record.approval_id === body?.approval_id)) return failure('not_found', 404);
          // Pending: each item starts at the suggestion (Thermostat redesign) with the owner the meeting proposes. Decided: where
          // each went (null: not kept) and the owner Ari confirmed.
          const confirmed = new Map((Array.isArray(granolaReview?.owners) ? granolaReview.owners as { signal_id: string; owner: string }[] : []).map(entry => [entry.signal_id, entry.owner]));
          const items = PILOT_ITEMS.map(item => {
            const proposed = MEETING_ACTIONS.find(action => action.signal_id === item.signal_id)?.owner ?? null;
            const route = routed.get(item.signal_id);
            return granolaApproved
              ? { ...item, quotes: [...item.quotes], owner: item.kind === 'action' ? confirmed.get(item.signal_id) ?? null : null, owner_editable: false,
                project_ids: route?.project_ids ?? null, ...(route?.private === true ? { private: true as const } : {}) }
              : { ...item, quotes: [...item.quotes], owner: proposed, owner_editable: proposed !== null, project_ids: [THERMOSTAT] };
          });
          const names = new Map([[THERMOSTAT, 'Thermostat redesign'], [SUPPLIER, 'Supplier review']]);
          const named = [...new Set(items.flatMap(item => item.project_ids ?? []))].sort().flatMap(project_id => {
            const name = names.get(project_id); return name === undefined ? [] : [{ project_id, name }];
          });
          return json({ review, snapshot_sha256: 'sha256:' + 'b'.repeat(64), participants: ['Ari', 'Mina Patel', 'Rafael Moreno'], items, reasons: PILOT_REASONS,
            suggested_projects: named, records });
        }
        case 'review':
          granolaReview = body; granolaApproved = true;
          if (body?.action === 'approve' && granolaRun === null) {
            granolaRun = { state: 'pending', error_code: null };
            // A check per further destination, each of its own record.
            extraRuns = recordsOf(body).slice(1).map((record, index) => ({ run_id: `run_00000000-0000-4000-8000-0000000000${21 + index}`, record,
              record_sha256: digestOf(`record:Pilot planning:${record.approval_id}`), state: 'pending' as const, error_code: null }));
          }
          // The approved meeting's first record: in the projects it was sent to, where it opens.
          if (body?.action === 'approve' && !meetings.some(meeting => meeting.record_sha256 === PILOT_RECORD)) {
            const first = recordsOf(body)[0];
            meetings.push(pilotMeeting(first?.project_ids ?? [], first?.private === true));
          }
          return json({ status: 'publishing', decided_on: 'desktop' });
      }
    }
    // Impact checks: approving queues one run per destination; a check-in
    // (`next`) starts the oldest queued one, and the first list after that finds
    // it done. A done check has found two open items. Every answer passes the
    // contract's own result check, as the Authority's does. Runs and shared Home
    // reads exist even when the meeting provider is unavailable.
    if (method === 'GET' && path === '/v1/person/changes') return json(changeCheck());
    if (method === 'POST' && path === '/v1/person/runs') {
      let request: RunsRequest;
      try {
        request = api.validatePersonRunsRequestV1(body);
      } catch {
        return failure('invalid_request', 400);
      }
      // A read that opens items live in their tools waits while the test holds them (the `hold-live` file in its home), as a
      // slow tool would; a rows or counts read never does.
      const live = ['home', 'items', 'item'].includes(request.operation) && request.read === undefined;
      for (let waited = 0; live && existsSync(join(home, 'hold-live')) && waited < 30_000; waited += 25) await new Promise(resolve => setTimeout(resolve, 25));
      const runId = PILOT_RUN;
      const run = granolaRun;
      // Each record's check is keyed by its own approval id.
      const row = (value: NonNullable<typeof run>) => ({ run_id: runId, trigger: 'approved_record', event_ref: recordsOf(granolaReview)[0]?.approval_id ?? 'apr_' + 'a'.repeat(64),
        state: value.state, error_code: value.error_code, created_at: '2026-10-07T10:00:00.000Z', updated_at: '2026-10-07T10:05:00.000Z' });
      const extraRow = (extra: (typeof extraRuns)[number]) => ({ run_id: extra.run_id, trigger: 'approved_record', event_ref: extra.record.approval_id, state: extra.state,
        error_code: extra.error_code, created_at: '2026-10-07T10:00:00.000Z', updated_at: '2026-10-07T10:05:00.000Z' });
      const result = (operation: string, value: unknown) => json(api.validatePersonRunsResultV1(operation, value));
      const now = () => new Date().toISOString();
      if (request.operation === 'list' && run?.state === 'running') {
        run.state = 'done';
      }
      for (const extra of extraRuns) {
        if (request.operation !== 'list' || extra.state !== 'running') continue;
        Object.assign(extra, ({ state: 'done' }));
      }
      writeFound();
      followUpsElsewhere();
      const shown = openItems.filter(visible).sort((a, b) => a.created_at.localeCompare(b.created_at));
      /**
       * An item in a scope: one Ari sent or owns (`involved`: or last handed on), a run's, or, read by Ari, a decision's or a
       * project's.
       */
      const inScope = (item: OpenItem, scope: RunsRequest['scope'], id: string | undefined) => scope === 'mine' ? involved(item)
        : scope === 'involved' ? involved(item) || item.owner_set_by?.membership_id === ARI.membership_id : scope === 'run' ? item.run_id === id
        : scope === 'record' ? item.readable && item.decision.record_sha256 === id : item.readable && item.decision.project_ids.includes(id!);
      switch (request.operation) {
        case 'list':
          return result('list', { runs: [...(run ? [row(run)] : []), ...extraRuns.map(extraRow)] });
        // A check-in (DSK-1), as the Authority answers it: Ari's oldest queued check starts, unless another of Ari's runs;
        // with none queued, idle, even while one runs.
        case 'next': {
          const checks = [...(run ? [run] : []), ...extraRuns];
          const oldest = checks.find(entry => entry.state === 'pending');
          if (!oldest) return result('next', { state: 'idle' });
          if (checks.some(entry => entry.state === 'running')) return result('next', { state: 'busy' });
          oldest.state = 'running';
          return result('next', { state: 'running' });
        }
        // Home: the Send row while Ari's check has items not sent, and the open items that wait on
        // Ari; then how many of the open items Ari sent wait on others. Rows only: no live read.
        // `landed`, `last_checked_at` and `sweep_due` are retired with sweeps: 0, null and false, as
        // the Authority sends them until V17.
        case 'home': {
          const unsent = shown.filter(item => item.run_id === runId && item.state === 'unsent');
          const send = run?.state === 'done' && unsent.length > 0 ? [{
            run_id: runId, decision: unsent[0]!.decision, items: unsent.length, kinds: [...new Set(unsent.map(item => item.kind))],
            owners: [...new Set(unsent.filter(item => !mineAsOwner(item)).map(item => item.owner.name))], finished_at: '2026-10-07T10:05:00.000Z',
          }] : [];
          // The newest first by when each started waiting (sent, owner set, or reopened), as the Authority orders them, rows
          // only or not.
          const since = (item: OpenItem) => [item.sent_at, item.owner_set_at, item.state_set_at].reduce<string>((latest, at) => (at !== null && at > latest ? at : latest), item.created_at);
          const theirs = shown.filter(item => item.state === 'open' && involved(item));
          return result('home', {
            send, items: theirs.filter(mineAsOwner).sort((a, b) => since(b).localeCompare(since(a))).slice(0, 20).map(item => itemView(item, live)),
            landed: 0, waiting: theirs.filter(item => item.approver.membership_id === ARI.membership_id && !mineAsOwner(item)).length,
            last_checked_at: null, sweep_due: false,
          });
        }
        case 'items': {
          const { scope, id } = request;
          const items = shown.filter(item => inScope(item, scope, id));
          const records = [...new Set(items.filter(item => item.readable).map(item => item.decision.record_sha256))];
          const count = (state: OpenItem['state'], of = items) => of.filter(item => item.state === state).length;
          // Each decision's check: Ari's own (whatever its stage), and Mina's, done. Only Ari's is Ari's own.
          const pilotProjects = recordsOf(granolaReview)[0]?.project_ids ?? [];
          const pilot = run !== null && granolaApproved && (scope === 'mine' || (scope === 'run' && id === runId) || (scope === 'record' && id === PILOT_RECORD) ||
            (scope === 'project' && pilotProjects.includes(id!)));
          const stages = [
            ...(pilot ? [{ record_sha256: PILOT_RECORD, run_id: runId, state: run.state, error_code: run.error_code, mine: true }] : []),
            ...extraRuns.filter(extra => scope === 'run' && id === extra.run_id)
              .map(extra => ({ record_sha256: extra.record_sha256, run_id: extra.run_id, state: extra.state, error_code: extra.error_code, mine: true })),
            ...records.filter(record => record !== PILOT_RECORD).map(record => {
              const found = items.find(item => item.decision.record_sha256 === record)!;
              return { record_sha256: record, run_id: found.run_id, state: 'done', error_code: null, mine: found.approver.membership_id === ARI.membership_id };
            }),
          ];
          // Counts only (a project's or a meeting's line): the summary and stages, no item. States: the items in those states
          // alone, with the same summary, paged with a cursor over those states only. Rows only:
          // the same page, nothing read live.
          const { states, changed_since: changedSince } = request;
          // Changed since a time: sent, handed on or set at or after it.
          const since = changedSince === undefined ? null : Date.parse(changedSince);
          const changed = (item: OpenItem) => since === null || [item.sent_at, item.owner_set_at, item.state_set_at].some(at => at !== null && Date.parse(at) >= since);
          const listed = (states === undefined ? items : items.filter(item => states.includes(item.state))).filter(changed);
          const pageKey = `items:${scope}:${id ?? ''}:${states?.join(',') ?? ''}:${changedSince ?? ''}`;
          const from = pageFrom(pageKey, request.cursor);
          if (from === null) return failure('invalid_request', 400);
          const size = (50);
          const counts = request.read === 'counts';
          const paged = counts ? [] : listed.slice(from, from + size);
          const next = !counts && from + size < listed.length ? pageCursor(pageKey, from + size) : null;
          // The verdict counts and `last_checked_at` are retired with sweeps: 0 and null, as the Authority sends them until V17.
          return result('items', { items: paged.map(item => itemView(item, live)), next_cursor: next, stages, summary: {
            unsent: count('unsent'), open: count('open'), done: count('done'), not_relevant: count('not_relevant'),
            landed: 0, changed: 0, unreadable: 0, decisions: records.length, last_checked_at: null, by_decision: records.map(record => {
              const of = items.filter(item => item.decision.record_sha256 === record);
              return { record_sha256: record, unsent: count('unsent', of), open: count('open', of), landed: 0, unreadable: 0 };
            }),
          } });
        }
        // Send (follow-ups thread v1, F1): any of the run's unsent items, to their owners (`include`) or dismissed; the ones
        // not listed stay unsent. Once per command: the same items again replay it, other items under it conflict. A listed
        // item no longer unsent is a conflict too, and nothing is written.
        case 'send': {
          if (run?.state !== 'done' || request.run_id !== runId) return failure('not_found', 404);
          const asked = request.items ?? [];
          const listed = JSON.stringify(asked);
          const earlier = sends.get(request.command_id!);
          if (earlier) return earlier.items === listed ? result('send', earlier.result) : failure('conflict', 409);
          const unsent = openItems.filter(item => item.run_id === runId && item.state === 'unsent');
          if (!asked.every(entry => unsent.some(item => item.item_id === entry.item_id))) return failure('conflict', 409);
          if (asked.some(entry => entry.owner_membership_id !== undefined && !desktop.people.some(person => person.membership_id === entry.owner_membership_id))) {
            return failure('invalid_request', 400);
          }
          const at = now();
          for (const entry of asked) {
            const item = unsent.find(candidate => candidate.item_id === entry.item_id)!;
            const pick = entry.owner_membership_id;
            if (pick !== undefined && (pick !== item.owner.membership_id || item.owner.match === 'approver')) {
              Object.assign(item, { owner: { membership_id: pick, name: nameOf(pick), match: 'picked' }, owner_set_at: at, owner_set_by: ARI });
            }
            Object.assign(item, { state: entry.include ? 'open' : 'not_relevant', sent_at: at, state_set_at: at, state_set_by: ARI, send_included: entry.include });
          }
          const sent = { sent: asked.filter(entry => entry.include).length, not_relevant: asked.filter(entry => !entry.include).length };
          sends.set(request.command_id!, { items: listed, result: sent });
          return result('send', sent);
        }
        // Done, Dismissed or open again: only the approver or the owner, and only once it was sent. The same state writes nothing.
        case 'set_state': {
          const item = shown.find(entry => entry.item_id === request.item_id && involved(entry));
          if (!item) return failure('not_found', 404);
          if (item.state === 'unsent') return failure('invalid_request', 400);
          if (item.state !== request.state) Object.assign(item, { state: request.state, state_set_at: now(), state_set_by: ARI });
          return result('set_state', { state: request.state });
        }
        // An owner picked (F2): before Send by its approver only (`picked`), after it by its approver or owner (`reassigned`).
        // Its owner again writes nothing, unless the item only fell back to its approver: then the pick claims it.
        case 'assign': {
          const item = shown.find(entry => entry.item_id === request.item_id && involved(entry));
          const person = desktop.people.find(entry => entry.membership_id === request.owner_membership_id);
          if (!item) return failure('not_found', 404);
          if (item.state === 'unsent' && item.approver.membership_id !== ARI.membership_id) return failure('invalid_request', 400);
          if (!person) return failure('invalid_request', 400);
          if (person.membership_id !== item.owner.membership_id || item.owner.match === 'approver') {
            Object.assign(item, { owner: { membership_id: person.membership_id, name: person.display_name, match: item.state === 'unsent' ? 'picked' : 'reassigned' },
              owner_set_at: now(), owner_set_by: ARI });
          }
          // Made, but the first reply is lost on its way back.
          if (mode === 'granola-review-assign-lost' && ++assigns === 1) return failure('unavailable', 503);
          return result('assign', { owner: { membership_id: person.membership_id, name: person.display_name, active: true } });
        }
        // One item, as Ari sees it now; read as rows, nothing read live.
        case 'item': {
          const item = shown.find(entry => entry.item_id === request.item_id);
          return item ? result('item', { item: itemView(item, live) }) : failure('not_found', 404);
        }
      }
    }
    // Jira: the browser consent is never shown; the second status read finds it done, unless `tools-waiting` keeps the
    // person in the browser until the app cancels.
    if (method === 'POST' && path === '/v1/person/tools/jira/connect') {
      if (JSON.stringify(body) !== '{"schema_version":1}') return failure('invalid_request', 400);
      jiraAttempt = { attempt: randomUUID(), expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), status: 'pending', failure_reason: null, reads: 0 };
      return json({ schema_version: 1, attempt: jiraAttempt.attempt, connect_link: JIRA_CONNECT_LINK, expires_at: jiraAttempt.expires_at });
    }
    if (method === 'POST' && (path === '/v1/person/tools/jira/status' || path === '/v1/person/tools/jira/cancel')) {
      if (!jiraAttempt || body?.attempt !== jiraAttempt.attempt) return failure('not_found', 404);
      if (path.endsWith('/cancel')) {
        if (jiraAttempt.status === 'pending') jiraAttempt.status = 'cancelled';
      } else if (jiraAttempt.status === 'pending' && mode !== 'tools-waiting' && ++jiraAttempt.reads >= 2) {
        jiraAttempt.status = 'complete'; jiraLinked = true;
      }
      const { attempt, expires_at, status, failure_reason } = jiraAttempt;
      return json({ schema_version: 1, attempt, expires_at, status, failure_reason });
    }
    if (method === 'POST' && path === '/v1/person/tools/jira/disconnect') {
      jiraLinked = false;
      return json({ schema_version: 1, connected: false });
    }
    if (method === 'POST' && path === '/v2/person/external-identities/slack/disconnect') {
      slackLinked = false;
      return json({ schema_version: 2, kind: 'echo-organization-person-tools', organization_id: session.organization_id, membership_id: session.membership_id,
        tools: [{ provider: 'slack', availability: 'enabled', personal_status: 'unlinked', workspace_id: 'T0123ABCD', account_id: null }] });
    }
    // Sign-out: the Authority ends the session; its request body is always empty.
    if (method === 'POST' && path === '/v2/session/revocations') {
      if (body === undefined || Object.keys(body).length !== 0) return failure('invalid_request', 400);
      return new Response(null, { status: 204 });
    }

    if (method === 'GET' && path === '/v2/person/projects') {
      const status = url.searchParams.get('status') === 'archived' ? 'archived' : 'active';
      // Synthetic list modes generate projects after the state map is made;
      // they model newly created projects whose initial status is active.
      const all = listed().filter(project => (projectStatus.get(project.project_id) ?? 'active') === status);
      const paged = LIST_PAGES.has(mode);
      const from = !paged ? 0 : url.searchParams.get('cursor') === 'cGFnZTM' ? 20 : url.searchParams.get('cursor') === 'cGFnZTI' ? 10 : 0;
      const page = paged ? all.slice(from, from + 10) : all;
      return json({ schema_version: 2, kind: 'echo-project-list-v2', items: page.map(project => ({
        schema_version: 2, kind: 'echo-project-summary-v2', project_id: project.project_id, name: project.name, created_at: NOW,
        role: project.role, status,
      })), next_cursor: paged && from + 10 < all.length ? (from === 0 ? 'cGFnZTI' : 'cGFnZTM') : null });
    }
    const projectV2 = /^\/v2\/person\/projects\/(prj_[0-9a-f-]+)$/.exec(path);
    if (method === 'GET' && projectV2) {
      const known = listed().find(project => project.project_id === projectV2[1]);
      const role = roleOf(projectV2[1]!, session.membership_id);
      if (!known || !role) return failure('not_found', 404);
      return json({ schema_version: 2, kind: 'echo-project-summary-v2', project_id: known.project_id, name: known.name, created_at: NOW,
        role, status: projectStatus.get(known.project_id) ?? 'active' });
    }
    // Only me, or one project's page: the desktop never lists all you may read, nor Mine any more (ADR-0049).
    if (method === 'POST' && path === '/v1/person/list') {
      let request: ReturnType<Contract['validatePersonListRequestV1']>;
      try {
        request = api.validatePersonListRequestV1(body);
      } catch {
        return failure('invalid_request', 400);
      }
      arrive();
      if (request.only_me === undefined && request.project_id === undefined) return failure('invalid_request', 400);
      const projectId = request.project_id;
      const project = projectId === undefined ? undefined : joined().find(entry => entry.project_id === projectId);
      // A project you are not in is refused as ask --project refuses it.
      if (projectId !== undefined && !project) return failure('unauthorized', 401);
      const key = request.only_me ? 'only_me' : `project/${projectId}`;
      const from = pageFrom(key, request.cursor);
      if (from === null) return failure('invalid_request', 400);
      const all = rows(request.only_me ? { only_me: true } : { project_id: projectId! });
      return json(api.validatePersonListResponseV1({
        schema_version: 1, kind: 'echo-person-list-v1', scope: request.only_me ? { kind: 'only_me' } : { kind: 'project', project_id: projectId },
        ...(project && request.cursor === undefined ? { project: {
          project_id: project.project_id, name: project.name, role: roleOf(project.project_id, session.membership_id) ?? project.role,
          status: projectStatus.get(project.project_id) ?? 'active',
        } } : {}),
        items: all.slice(from, from + LIST_PAGE), next_cursor: from + LIST_PAGE < all.length ? pageCursor(key, from + LIST_PAGE) : null,
      }));
    }
    // One item by its ref, under your access: anything you cannot read is one not_found.
    if (method === 'POST' && path === '/v1/person/open') {
      let request: ReturnType<Contract['validatePersonOpenRequestV1']>;
      try {
        request = api.validatePersonOpenRequestV1(body);
      } catch {
        return failure('invalid_request', 400);
      }
      const at = request.ref.indexOf(':');
      const [kind, id] = [request.ref.slice(0, at), request.ref.slice(at + 1)];
      const open = (fields: Record<string, unknown>) => json(api.validatePersonOpenResponseV1({ schema_version: 1, kind: 'echo-person-open-v1', ref: request.ref, ...fields }));
      if (kind === 'note' && catalog.has(id) && readsNote(id)) {
        return open({ item: noteRow(id), text: catalog.get(id)!.text, next_cursor: null });
      }
      const document = kind === 'document' ? documents.find(entry => entry.document_id === id) : undefined;
      if (document) {
        const from = pageFrom(request.ref, request.cursor);
        if (from === null || from >= Math.max(document.pages.length, 1)) return failure('not_found', 404);
        return open({
          item: documentRow(document), filename: document.filename,
          chunks: (document.pages[from] ?? []).map(chunk => ({ anchor: { kind: chunk.anchor_kind, start: chunk.anchor_start }, text: chunk.text })),
          next_cursor: from + 1 < document.pages.length ? pageCursor(request.ref, from + 1) : null,
        });
      }
      // A meeting is read as a record (GET /v1/person/records), whole: the desktop never opens one here.
      return failure('not_found', 404);
    }

    // New project: made once per request id, with you as its lead.
    if (method === 'POST' && path === '/v1/person/projects') {
      const name = body?.name;
      if (Object.keys(body ?? {}).sort().join(',') !== 'kind,name,request_id,schema_version' || body?.schema_version !== 1 ||
          body?.kind !== 'echo-project-create-v1' || typeof name !== 'string') return failure('invalid_request', 400);
      return change(path, body, () => {
        const projectId = `prj_${randomUUID()}`;
        projects.push({ project_id: projectId, name, role: 'lead' });
        projectStatus.set(projectId, 'active');
        members[projectId] = [{ membership_id: session.membership_id, role: 'lead' }];
        filed.set(projectId, []);
        return {
          schema_version: 1, kind: 'echo-project-create-receipt-v1', request_id: body?.request_id, project_id: projectId, created_at: NOW, state: 'created',
        };
      }, 201);
    }
    if (method === 'POST' && path === '/v1/person/projects/rename') {
      const projectId = String(body?.project_id);
      const name = body?.name;
      if (Object.keys(body ?? {}).sort().join(',') !== 'kind,name,project_id,request_id,schema_version' || body?.schema_version !== 1 ||
          body?.kind !== 'echo-project-rename-v1' || typeof name !== 'string') return failure('invalid_request', 400);
      return change(path, body, () => {
        const project = projects.find(entry => entry.project_id === projectId);
        if (!project || roleOf(projectId, session.membership_id) !== 'lead') return failure('not_found', 404);
        project.name = name;
        return { schema_version: 1, kind: 'echo-project-settings-receipt-v1', request_id: body?.request_id, project_id: projectId,
          operation: 'rename', received_at: NOW, state: 'applied' };
      });
    }
    if (method === 'POST' && (path === '/v1/person/tools/jira/project/read' || path === '/v1/person/tools/jira/project/set')) {
      const projectId = String(body?.project_id);
      const role = roleOf(projectId, session.membership_id);
      if (!role) return failure('not_found', 404);
      const current = jiraMappings.get(projectId) ?? { revision: null, mapping: null };
      if (path.endsWith('/read')) return json({ schema_version: 1, project_id: projectId, ...current });
      if (role !== 'lead') return failure('unauthorized', 401);
      if (body?.expected_revision !== current.revision) return failure('conflict', 409);
      const value = { revision: randomUUID(), mapping: body?.jira_project === null ? null : { cloud_id: JIRA_CLOUD, project_id: '10000', project_key: String(body?.jira_project) } };
      jiraMappings.set(projectId, value);
      return json({ schema_version: 1, project_id: projectId, ...value });
    }
    if (method === 'POST' && path === '/v1/person/tools/confluence/spaces/list') {
      if (body?.schema_version !== 1 || (body?.cursor !== undefined && body?.cursor !== 'next-spaces')) return failure('invalid_request', 400);
      return json(body?.cursor === 'next-spaces'
        ? { schema_version: 1, items: [{ id: '300', key: 'ENG', name: 'Engineering' }], next_cursor: null }
        : { schema_version: 1, items: [{ id: '100', key: 'ECHO', name: 'ECHO product' }, { id: '200', key: 'OPS', name: 'Operations' }], next_cursor: 'next-spaces' });
    }
    if (method === 'POST' && (path === '/v1/person/tools/confluence/project/read' || path === '/v1/person/tools/confluence/project/set')) {
      const projectId = String(body?.project_id); const role = roleOf(projectId, session.membership_id);
      if (!role) return failure('not_found', 404);
      const current = confluenceMappings.get(projectId) ?? { revision: null, mapping: null };
      if (path.endsWith('/read')) return json({ schema_version: 1, project_id: projectId, ...current });
      if (role !== 'lead' || body?.schema_version !== 1 || typeof body?.request_id !== 'string') return failure('unauthorized', 401);
      if (body?.expected_revision !== current.revision) return failure('conflict', 409);
      const space_ids = body?.space_ids;
      if (space_ids !== null && (!Array.isArray(space_ids) || space_ids.length < 1 || space_ids.length > 20 || !space_ids.every(id => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id)))) return failure('invalid_request', 400);
      const value = { revision: randomUUID(), mapping: space_ids === null ? null : { cloud_id: CONFLUENCE_CLOUD, space_ids } };
      confluenceMappings.set(projectId, value);
      return json({ schema_version: 1, project_id: projectId, ...value });
    }
    if (method === 'POST' && path === '/v1/person/projects/archive') {
      const projectId = String(body?.project_id);
      if (Object.keys(body ?? {}).sort().join(',') !== 'archived,kind,project_id,request_id,schema_version' || body?.schema_version !== 1 ||
          body?.kind !== 'echo-project-archive-v1' || typeof body?.archived !== 'boolean') return failure('invalid_request', 400);
      return change(path, body, () => {
        if (!projects.some(entry => entry.project_id === projectId) || roleOf(projectId, session.membership_id) !== 'lead') return failure('not_found', 404);
        projectStatus.set(projectId, body!.archived ? 'archived' : 'active');
        return { schema_version: 1, kind: 'echo-project-settings-receipt-v1', request_id: body?.request_id, project_id: projectId,
          operation: 'archive', received_at: NOW, state: 'applied' };
      });
    }
    if (method === 'POST' && path === '/v1/person/projects/leave') {
      const projectId = String(body?.project_id);
      if (Object.keys(body ?? {}).sort().join(',') !== 'kind,project_id,request_id,schema_version' || body?.schema_version !== 1 ||
          body?.kind !== 'echo-project-leave-v1') return failure('invalid_request', 400);
      return change(path, body, () => {
        const role = roleOf(projectId, session.membership_id);
        if (!role) return failure('not_found', 404);
        if (role === 'lead' && leadsAfter(projectId, session.membership_id, null) === 0) return failure('conflict', 409);
        members[projectId] = (members[projectId] ?? []).filter(entry => entry.membership_id !== session.membership_id);
        return { schema_version: 1, kind: 'echo-project-settings-receipt-v1', request_id: body?.request_id, project_id: projectId,
          operation: 'leave', received_at: NOW, state: 'applied' };
      });
    }
    // People & invites, for the owner: list, invite (POST), reissue (PUT) and revoke (DELETE), each by email.
    if (path === '/v1/person/employees') {
      if (session.membership_type !== 'owner') return failure('unauthorized', 401);
      if (method === 'GET') {
        const listed = structuredClone(employees);
        return json({ schema_version: 1, kind: 'echo-clean-person-employee-roster-v1', employees: listed });
      }
      const email = String(body?.email);
      const existing = employees.find(employee => employee.email === email && employee.membership_status === 'active');
      if (method === 'POST') {
        if (Object.keys(body ?? {}).sort().join(',') !== 'email,name') return failure('invalid_request', 400);
        if (existing) return failure('conflict', 409);
        employees.push({ email, display_name: String(body?.name), membership_status: 'active', invitation_state: 'pending' });
      } else if (method === 'PUT' || method === 'DELETE') {
        if (Object.keys(body ?? {}).join(',') !== 'email') return failure('invalid_request', 400);
        if (!existing) return failure('not_found', 404);
        if (method === 'PUT' && existing.invitation_state === 'redeemed') return failure('conflict', 409);
        if (method === 'PUT') existing.invitation_state = 'pending';
        else Object.assign(existing, { membership_status: 'revoked', invitation_state: existing.invitation_state === 'pending' ? 'expired' : existing.invitation_state });
      } else {
        return failure('not_found', 404);
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return json({ login_grant: randomBytes(32).toString('base64url'), expires_at: '2026-09-28T22:01:00.000Z' }, method === 'POST' ? 201 : 200);
    }
    if (method === 'POST' && path === '/v1/person/projects/members') {
      const projectId = String(body?.project_id);
      if (!roleOf(projectId, session.membership_id)) return failure('not_found', 404);
      const all = (members[projectId] ?? []).map(entry => ({ membership_id: entry.membership_id, display_name: nameOf(entry.membership_id), role: entry.role }));
      return json({ schema_version: 1, kind: 'echo-project-members-v1', project_id: projectId, ...paged(all, body?.cursor) });
    }
    // Everyone in your organization, for any member and with no project (ADR-0016).
    if (method === 'POST' && path === '/v1/person/directory') {
      let request: ReturnType<Contract['validateOrganizationDirectorySearchV1']>;
      try {
        request = api.validateOrganizationDirectorySearchV1(body);
      } catch {
        return failure('invalid_request', 400);
      }
      // The client sends the request as the validator returns it, its limit included; a cursor is only one this fixture gave.
      const sorted = (value: object) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
      if (sorted(request) !== sorted(body ?? {}) || (request.cursor !== undefined && request.cursor !== SECOND_PAGE)) {
        return failure('invalid_request', 400);
      }
      const limit = request.limit ?? PAGE;
      const from = request.cursor === SECOND_PAGE ? limit : 0;
      const all = desktop.people.filter(person => request.query === undefined || found(request.query, person.display_name));
      return json(api.validateOrganizationDirectoryV1({
        schema_version: 1, kind: 'echo-organization-directory-v1', items: all.slice(from, from + limit),
        next_cursor: from + limit < all.length ? SECOND_PAGE : null,
      }));
    }
    if (method === 'POST' && path.startsWith('/v1/person/projects/members/')) {
      const projectId = String(body?.project_id);
      const membershipId = String(body?.membership_id);
      const operation = path.endsWith('/remove') ? 'member_remove' : 'member_set';
      return change(path, body, () => {
        if (roleOf(projectId, session.membership_id) !== 'lead') return failure('not_found', 404);
        const role = path.endsWith('/set') ? body?.role as 'lead' | 'member' : path.endsWith('/add') ? roleOf(projectId, membershipId) ?? 'member' : null;
        if (leadsAfter(projectId, membershipId, role) === 0) return failure('conflict', 409);
        const rest = (members[projectId] ?? []).filter(entry => entry.membership_id !== membershipId);
        const at = (members[projectId] ?? []).findIndex(entry => entry.membership_id === membershipId);
        if (role !== null) rest.splice(at < 0 ? rest.length : at, 0, { membership_id: membershipId, role });
        members[projectId] = rest;
        return {
          schema_version: 1, kind: 'echo-project-mutation-receipt-v1', request_id: body?.request_id, project_id: projectId, operation,
          membership_id: membershipId, received_at: NOW, state: 'applied',
        };
      });
    }
    if (method === 'POST' && (path === '/v1/person/projects/context/associate' || path === '/v1/person/projects/context/dissociate')) {
      const projectId = String(body?.project_id);
      const contextId = String(body?.context_id);
      const operation = path.endsWith('/associate') ? 'associate' : 'dissociate';
      return change(path, body, () => {
        if (!catalog.has(contextId) || !readsNote(contextId) || !mayFile(projectId, ownNotes.has(contextId), operation)) return failure('not_found', 404);
        const rest = (filed.get(projectId) ?? []).filter(id => id !== contextId);
        filed.set(projectId, operation === 'associate' ? [...rest, contextId] : rest);
        return {
          schema_version: 1, kind: 'echo-project-mutation-receipt-v1', request_id: body?.request_id, project_id: projectId, operation,
          context_id: contextId, received_at: NOW, state: 'applied',
        };
      });
    }

    // Documents: a saved one's original, and where it is filed.
    const document = /^\/v2\/person\/documents\/(doc_[0-9a-f]{64})(\/original)?$/.exec(path);
    if (method === 'GET' && document) {
      const stored = findDocument(document[1]!, url.searchParams.get('project_id'));
      if (!stored) return failure('not_found', 404);
      if (document[2] === '/original') {
        return new Response(stored.original, { status: 200, headers: {
          'content-type': stored.detected_media_type, 'x-echo-document-sha256': digestOf(stored.original),
        } });
      }
      return json(documentMetadata(stored));
    }
    const link = /^\/v2\/person\/documents\/(doc_[0-9a-f]{64})\/(associate|dissociate)$/.exec(path);
    if (method === 'POST' && link) {
      const projectId = String(body?.project_id);
      return change(path, body, () => {
        const stored = findDocument(link[1]!, null);
        if (!stored || !readsDocument(stored) || !mayFile(projectId, ownDocuments.has(stored.document_id), link[2]!)) return failure('not_found', 404);
        const rest = stored.association_project_ids.filter(id => id !== projectId);
        stored.association_project_ids = (link[2] === 'associate' ? [...rest, projectId] : rest).sort();
        return {
          schema_version: 1, kind: 'echo-person-document-association-receipt-v1', request_id: body?.request_id,
          document_id: stored.document_id, project_id: projectId, operation: link[2], received_at: NOW, state: 'applied',
        };
      });
    }
    if (method === 'POST' && path === '/v3/person/updates') {
      writeAttempts += 1;
      if (mode === 'write-unavailable' || (mode.startsWith('write-unavailable-') && writeAttempts === 1)) return failure('unavailable', 503);
      const refused = refusedProjects(body);
      if (refused) return refused;
      // In the only-me modes each save is its own note, of Ari's own, filed where the save said.
      const own = ONLY_ME_MODES.has(mode);
      const receipt = {
        schema_version: 3, kind: 'echo-person-update-receipt-v3', request_id: body?.request_id,
        context_id: own ? `ctx_${createHash('sha256').update(String(body?.request_id)).digest('hex')}` : 'ctx_' + 'c'.repeat(64), received_at: NOW,
        audience: body?.audience, association_project_ids: body?.association_project_ids, state: 'received',
      };
      writeFileSync(join(home, `saved-${String(body?.request_id)}.json`), JSON.stringify(receipt));
      if (own) {
        catalog.set(receipt.context_id, { received_at: NOW, title: String(body?.title), text: String(body?.text), audience: body?.audience as Record<string, unknown> });
        for (const projectId of (body?.association_project_ids ?? []) as string[]) {
          filed.set(projectId, [...(filed.get(projectId) ?? []).filter(id => id !== receipt.context_id), receipt.context_id]);
        }
        ownNotes.add(receipt.context_id);
      }
      // Stored, but the reply never comes: the host dies or the app quits first.
      if (mode === 'write-hangs') return new Promise<Response>(() => undefined);
      return json(receipt, 202);
    }
    const noteStatus = /^\/v3\/person\/updates\/([0-9a-f-]+)$/.exec(path);
    if (method === 'GET' && noteStatus) {
      const saved = join(home, `saved-${noteStatus[1]}.json`);
      if (!existsSync(saved)) return failure('not_found', 404);
      const receipt = JSON.parse(readFileSync(saved, 'utf8')) as Record<string, unknown>;
      delete receipt.state;
      return json({ ...receipt, kind: 'echo-person-update-status-v3', status: 'stored', metadata: 'ready' });
    }
    const upload = /^\/v2\/person\/documents\/([0-9a-f-]{36})$/.exec(path);
    if (method === 'PUT' && upload) {
      documentAttempts += 1;
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of init?.body as unknown as AsyncIterable<Uint8Array>) { hash.update(chunk); size += chunk.byteLength; }
      if (`sha256:${hash.digest('hex')}` !== body?.sha256 || size !== body?.content_length) return failure('invalid_request', 400);
      const refused = refusedProjects(body);
      if (refused) return refused;
      // One document per request: a resend of the same request gets the same receipt.
      const saved = join(home, `document-${upload[1]}.json`);
      if (!existsSync(saved)) {
        writeFileSync(saved, JSON.stringify({
          ...body, kind: 'echo-person-document-receipt-v2', document_id: `doc_${createHash('sha256').update(upload[1]!).digest('hex')}`,
          detected_media_type: 'text/plain', received_at: NOW, state: 'saved', extraction_state: 'extracting',
        }));
      }
      // Stored, but the first reply is lost on its way back.
      if (mode === 'document-reply-lost' && documentAttempts === 1) return failure('unavailable', 503);
      return json(JSON.parse(readFileSync(saved, 'utf8')), 201);
    }
    const documentStatus = /^\/v2\/person\/documents\/requests\/([0-9a-f-]{36})$/.exec(path);
    if (method === 'GET' && documentStatus) {
      const saved = join(home, `document-${documentStatus[1]}.json`);
      if (!existsSync(saved)) return failure('not_found', 404);
      return json({
        ...JSON.parse(readFileSync(saved, 'utf8')) as Record<string, unknown>, kind: 'echo-person-document-metadata-v2',
        extraction_detail: null, extractor: null, extracted_text_bytes: 0,
      });
    }
    // The Ask timeline's reads (ADR-0047): the source check, by citation, and what arrived in your projects. Each is checked
    // by the contract's validator; other modes return 404 for the source check.
    if (method === 'POST' && path === '/v1/person/ask/check' && mode === 'ask-timeline-unreadable') {
      let items: ReturnType<Contract['validatePersonAskCheckRequestV1']>['items'];
      try {
        ({ items } = api.validatePersonAskCheckRequestV1(body));
      } catch {
        return failure('invalid_request', 400);
      }
      const checked = timelineCheck(items);
      api.validatePersonAskCheckV1(checked);
      return json(checked);
    }
    if (method === 'GET' && path === '/v1/person/project-activity') {
      arrive();
      const activity = projectActivityOf(listed(), arrivals);
      api.validatePersonProjectActivityV1(activity);
      return json(activity);
    }
    // Ask, `/v7` (research tool contract v1): the V8 answer, which every Ask asks for.
    if (method === 'POST' && path === '/v7/person/ask') {
      let request: ReturnType<Contract['validatePersonAnswerRequestV3']>;
      try {
        request = api.validatePersonAnswerRequestV3(body);
      } catch {
        return failure('invalid_request', 400);
      }
      // One project, or all you may read.
      const scope = request.project_id !== undefined ? { kind: 'project', project_id: request.project_id } : { kind: 'global' };
      const question = request.question;
      const answer = { ...desktop.answer, schema_version: 8, kind: 'echo-clean-person-answer-v8' };
      // The Ask timeline's answers, by the earlier turn the Ask carries; every other mode's take one and answer as if none came.
      if (mode === 'ask-timeline-unreadable') return answered(timelineAnswer(question, scope, body?.previous as Record<string, unknown> | undefined));
      // `ask-progress` streams the Ask's steps, then its answer and receipt; every other mode streams its answer alone.
      if (mode === 'ask-progress') return progressStream(question, scope, init?.signal ?? undefined);
      // `ask-completion` answers what it can and says, typed, that it cannot make changes.
      if (mode === 'ask-completion') {
        const [original] = desktop.answer.parts as Record<string, unknown>[];
        return answered({ ...answer, scope, outcome: 'partial', citations: desktop.answer.citations,
          parts: [{ question, status: 'partial', statements: original!.statements, blocks: original!.blocks,
            gap: 'The list did not reach the end. Unchecked entries and sentences did not fit.', gap_details: { unsupported_action: true } }],
        });
      }
      // `ask-ticket` answers from one Jira ticket read live.
      if (mode === 'ask-ticket') {
        return answered({ ...answer, scope, outcome: 'answered', citations: [thermTicket('ECHO-7', 'Jira launch', '10007')],
          parts: [{ question, status: 'answered', statements: [{ text: 'ECHO-7 is titled Jira launch.', citation_indexes: [0], private: true }], blocks: [{ kind: 'text', statements: [0] }] }] });
      }
      // `ask-blocks` answers THERM's question in every block of answer layout v2 (ADR-0051).
      if (mode === 'ask-blocks') return answered(blocksAnswer(question, scope));
      if (mode === 'ask-scroll') {
        const statements = question === 'Quick status' ? [{ text: 'The release remains scheduled for Friday, and the team has confirmed the owner and the remaining checks.', citation_indexes: [0], private: false }] : Array.from({ length: 12 }, (_, index) => ({
          text: `${question} Item ${index + 1}: The team reviewed the supplier report, the manufacturing checklist, and the latest test results. The next review will compare those results with the release requirements before confirming the schedule and assigning the remaining follow-ups.`,
          citation_indexes: [0], private: false,
        }));
        return answered({ ...answer, scope, citations: THERM_BLOCK_CITATIONS.slice(0, 1), parts: [{ question, status: 'answered', statements,
          blocks: [{ kind: 'text', statements: statements.map((_, index) => index) }],
        }] });
      }
      // The Agentic Ask answer: one part, the question itself, citing the fixture's two sources.
      const [part] = desktop.answer.parts as Record<string, unknown>[];
      return answered({ ...answer, scope, parts: [{ ...part, question }] });
    }
    if (method === 'POST' && path === '/v2/person/ask/source') {
      const citation = body?.citation as Record<string, unknown>;
      const newer = mode === 'ask-imported-mixed' && citation.revision_id === 'rev-2';
      // The mixed-revision pane must not infer a shared review state before both proofs arrive.
      for (let waited = 0; newer && existsSync(join(home, 'hold-imported-newer')) && waited < 10_000; waited += 25) await new Promise(resolve => setTimeout(resolve, 25));
      // An imported meeting's packet always carries its review state.
      return json({
        schema_version: 1, kind: 'echo-person-source-evidence-v1', scope: body?.scope,
        citation: { ...citation, label: desktop.evidence_label }, text: newer ? 'Imported meeting (unapproved): Pilot\nThe updated notes defer the pilot.' : desktop.evidence_text,
        ...(importedNotes ? { imported_meeting_review: newer ? 'not_reviewed' : mode === 'ask-imported-mixed' || existsSync(join(home, 'imported-reviewed')) ? 'reviewed' : 'not_reviewed' } : {}),
      });
    }
    // One approved record, by the digest an answer cited or a meeting's row names. A record the person
    // cannot read comes back as an empty list, as the Authority's does.
    if (method === 'GET' && path === '/v1/person/records' && url.searchParams.has('record_sha256')) {
      if ([...url.searchParams.keys()].length !== 1) return failure('invalid_request', 400);
      const listed = listedRecord(url.searchParams.get('record_sha256')!);
      return json({ schema_version: 1, kind: 'echo-clean-person-record-list-v1', records: listed === null ? [] : [listed] });
    }
    return failure('not_found', 404);
  };

  return {
    dependencies: { fetch, now: () => clock, open_authorization_url: openAuthorizationUrl },
    now: () => Date.parse(clock),
  };
}
