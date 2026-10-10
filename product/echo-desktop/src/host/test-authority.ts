// Test hook only (compiled out of release bundles): a synthetic session and a
// fixture Authority behind the real person client. Every request is logged to
// <home>/calls.jsonl so tests can assert what the app actually sent.
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const AUTHORITY = 'https://authority.example';
const IDENTITY_PROVIDER = 'https://accounts.example';
const NOW = '2026-09-21T22:01:00.000Z';
/** Past the access token's expiry, still inside the week. */
const LATER = '2026-09-21T22:30:00.000Z';

interface Operation { id: string; http: { method: string; status: number; response: Record<string, unknown> } }
interface Note { context_id: string; received_at: string; audience: Record<string, unknown>; title: string; text: string }
/** A saved document: its metadata, its original's text, and its extracted text in pages. */
interface StoredDocument {
  document_id: string; request_id: string; filename: string; title: string; original: string; detected_media_type: string;
  audience: Record<string, unknown>; association_project_ids: string[]; received_at: string; extraction_state: string;
  pages: { ordinal: number; anchor_kind: string; anchor_start: number; text: string }[][];
}
interface DesktopFixtures {
  projects: { project_id: string; name: string; role: 'lead' | 'member' }[];
  /** Saved V3 notes the person can read, for search. */
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

/** The requests and responses the fixture checks with the contract's own validators. */
interface Contract {
  validateOrganizationDirectorySearchV1(value: unknown): { query?: string; limit?: number; cursor?: string };
  validateOrganizationDirectoryV1(value: unknown): unknown;
  validatePersonListRequestV1(value: unknown): { project_id?: string; mine?: true; cursor?: string };
  validatePersonListResponseV1(value: unknown): unknown;
  validatePersonOpenRequestV1(value: unknown): { ref: string; cursor?: string };
  validatePersonOpenResponseV1(value: unknown): unknown;
  validatePersonAnswerRequestV3(value: unknown): { question: string; project_id?: string; mine?: true };
  validatePersonRunsRequestV1(value: unknown): RunsRequest;
  validatePersonRunsResultV1(operation: string, value: unknown): unknown;
}

/** A runs request, as the contract's validator returns it. */
interface RunsRequest {
  operation: string; run_id?: string; scope?: 'mine' | 'run' | 'record' | 'project'; id?: string; summary_only?: true; open_only?: true;
  item_id?: string; command_id?: string; state?: 'open' | 'done' | 'not_relevant';
  items?: { item_id: string; include: boolean; owner_membership_id?: string }[];
}

/** An open item's last check: the verdict alone, who ran it and when (a check keeps no sentence). */
interface Check { verdict: 'landed' | 'still_open' | 'changed' | 'unreadable'; checked_at: string; checked_by: string }

/**
 * One open item (open items and Home v1): an item a decision's impact check
 * found, one shared row, as the Authority keeps it. Rows hold pointers and
 * ECHO's own words; what an item says now is read live, and reaches a viewer
 * (as `current`) only when that viewer could open it.
 */
interface OpenItem {
  item_id: string; run_id: string; kind: 'ticket' | 'page';
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
  owner: { membership_id: string; name: string; match: 'jira_account' | 'name' | 'picked' | 'approver' };
  state: 'unsent' | 'open' | 'done' | 'not_relevant';
  created_at: string; sent_at: string | null; state_set_at: string | null;
  check: Check | null;
}

/**
 * A sweep run (open items and Home v1, section 6): it rechecks the open items
 * in its scope (`scope`: the scope and its id) that were open when it was
 * asked for, and keeps a verdict on each. `requeued`: an attempt of it went
 * back to the queue.
 */
interface SweepRun {
  run_id: string; event_ref: string; scope: string; created_at: string; state: 'pending' | 'running' | 'done'; lists: number; items: string[]; requeued?: true;
}

/** The granola modes whose projects are the meeting's: Thermostat redesign (Ari leads it) and Supplier review. */
const GRANOLA_PROJECTS = new Set(['granola', 'granola-owner', 'granola-owner-outage', 'granola-home-fails-once', 'granola-all', 'granola-checked', 'granola-review',
  'granola-sweep', 'granola-sweep-requeued', 'granola-alike']);
const THERMOSTAT = 'prj_11111111-1111-4111-8111-111111111111';
const SUPPLIER = 'prj_44444444-4444-4444-8444-444444444444';
/** Who an impact check names, besides Ari: fictional people of the organization. */
const MINA = { membership_id: 'mem_77777777-7777-4777-8777-777777777777', name: 'Mina Patel' };
const RAFAEL = { membership_id: 'mem_88888888-8888-4888-8888-888888888888', name: 'Rafael Moreno' };
const OKAFOR = { membership_id: 'mem_99999999-9999-4999-8999-999999999999', name: 'S. Okafor' };
/** Another meeting waiting for Ari's approval, beside Pilot planning: granola-all's whole Home. */
const SUPPLIER_SYNC = {
  approval_id: 'apr_' + 'b'.repeat(64), title: 'Supplier sync', project_ids: [SUPPLIER], status: 'pending', decided_on: null,
  first_line: 'Lead time stays six weeks.', action_count: 1, meeting_at: '2026-10-02T15:00:00.000Z',
};

/**
 * A fake-only list page: ten rows, so the desktop's More is exercised
 * without seeding 25 (the Authority's own page).
 */
const LIST_PAGE = 10;
/** An opened meeting's page: at most 25 parts, whose atoms stay within 32 KiB; a longer atom comes in parts of 3 KiB. */
const OPEN_ATOMS = 25;
const OPEN_ATOMS_BYTES = 32 * 1024;
const ATOM_PART_BYTES = 3 * 1024;

/** The modes where Ari has added notes, uploads and approved meetings of their own; `mine-empty` has none yet. */
const MINE_MODES = new Set(['mine', 'owner-mine', 'mine-empty', 'mine-fails-once', 'mine-meetings-held', 'mine-unauthorized', 'mine-live-missing', 'mine-live-unavailable']);
const PRICING_REVIEW = `sha256:${'7'.repeat(64)}`;
const BEACON_KICKOFF = `sha256:${'8'.repeat(64)}`;
const PRICING_MEMO = `doc_${'9'.repeat(64)}`;
const LAUNCH_CHECKLIST = `ctx_${'b'.repeat(64)}`;
/** One action long enough to come in three parts, across the first page's end. */
const LONG_ACTION = `Draft the renewal terms.${' Clause.'.repeat(872)}`;

/** An approved meeting, as list and open release it. */
interface Meeting {
  record_sha256: string; title: string; added_at: string; meeting_date: string; visibility: 'only_me' | 'team' | 'project';
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
const CONFLUENCE_CONNECT_LINK = 'https://connect.nango.example/confluence';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function failure(code: string, status: number): Response {
  return json({ error: { code, message: 'request failed' } }, status);
}
/** As the Authority searches: every word of the query in the title or text. */
function found(query: unknown, entry: { title: string; text?: string; excerpt?: string }): boolean {
  const haystack = `${entry.title}\n${entry.text ?? entry.excerpt ?? ''}`.normalize('NFC').toLowerCase();
  const terms = String(query).normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.length > 0 && terms.every(term => haystack.includes(term));
}
/** A search result's excerpt: the start of the original text. */
function excerpt(text: string): string { return [...text.trim()].slice(0, 300).join(''); }

/** The modes whose project list comes ten at a time. */
const LIST_PAGES = new Set(['many-projects', 'many-projects-lead', 'long-project-names', 'over-twenty-projects']);
/** A project ID, as the API writes one. */
const PROJECT_ID = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The most projects a capture is filed in, or read by (PERSON_UPLOAD_PROJECT_SET_MAX). */
const MAX_PROJECT_SET = 20;

const LONG_NAMES = [
  'Upload validation d92c717 Beta', 'Northwind renewal, annual pricing and the pilot clause', 'tdk', 'lin', 'echo', 'stout', 'Q4 planning',
  'Hiring: senior backend engineer', 'Customer research interviews', 'Security questionnaire for Contoso', 'Board deck', 'Onboarding',
  'Pricing', 'Launch', 'Design system', 'Support escalations', 'Partnerships',
  'A project whose name is far too long to fit on one line of the Capture sheet, however wide the window is made', 'Legal', 'Finance',
];

export function installTestAuthority(home: string, fixturesDirectory: string, SessionStore: new (home: string) => unknown) {
  const repository = join(process.env.ECHO_PERSON_CLIENT_ENTRY!, '..', '..', '..', '..', '..');
  const operations = (JSON.parse(readFileSync(join(repository, 'tests/fixtures/project-context-v1/operations.json'), 'utf8')) as {
    operations: Operation[];
  }).operations;
  const desktop = JSON.parse(readFileSync(join(fixturesDirectory, 'desktop-v1.json'), 'utf8')) as DesktopFixtures;
  const contract = () => import(pathToFileURL(join(repository, 'packages/organization-api/dist/index.js')).href) as Promise<Contract>;
  const mode = process.env.ECHO_DESKTOP_TEST_MODE ?? '';
  let granolaImported = false, granolaApproved = false, granolaWatch = false, granolaBaselineHomeReads = 0;
  let granolaPublicationReads = 0;
  let granolaReview: Record<string, unknown> | undefined;
  // The impact check of the approved meeting: none until it is approved.
  let granolaRun: { state: 'pending' | 'running' | 'done' | 'failed'; error_code: string | null; lists: number; retried: boolean } | null = null;
  // The people a meeting's impact check names, to pick as owners.
  if (mode.startsWith('granola')) desktop.people.push(...[MINA, RAFAEL, OKAFOR].map(person => ({ membership_id: person.membership_id, display_name: person.name })));
  // Thirteen people: the organization's directory comes in two pages.
  if (mode === 'many-people') {
    desktop.people.push(...Array.from({ length: 9 }, (_, index) => ({
      membership_id: `mem_0000000${index + 1}-6666-4666-8666-666666666666`, display_name: `Colleague ${index + 1}`,
    })));
  }
  const fixture = (id: string) => {
    const found = operations.find(entry => entry.id === id);
    if (!found) throw new Error(`missing fixture ${id}`);
    return structuredClone(found.http.response);
  };

  const store = new SessionStore(realpathSync(home)) as Store;
  const expired = mode === 'expired-claim';
  const clock = mode.startsWith('refresh-') ? LATER : NOW;
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
  if (!existsSync(store.paths.live) && mode !== 'signed-out') {
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
  // No longer a lead of the first project, though the list said so.
  if (mode === 'demoted') members[desktop.projects[0]!.project_id] = members[desktop.projects[0]!.project_id]!.map(entry => ({ ...entry, role: entry.role === 'lead' ? 'member' : 'lead' }));
  const documents = structuredClone(desktop.documents);
  const feedItem = fixture('projects-feed').items as Record<string, unknown>[];
  const readable = fixture('projects-read-context');
  const catalog = new Map<string, { received_at: string; title: string; text: string; audience: Record<string, unknown> }>([
    [String(feedItem[0]!.context_id), { received_at: String(feedItem[0]!.received_at), title: String(feedItem[0]!.title),
      // Shared with several projects; a reader sees only the one it is read in (ADR-0023).
      text: String(readable.text), audience: { kind: 'projects' } }],
    ...desktop.notes.map(note => [note.context_id, note] as const),
  ]);
  const filed = new Map<string, string[]>(desktop.projects.map(project => [project.project_id, [String(feedItem[0]!.context_id)]]));
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
  // What Ari added: notes they saved, documents they uploaded, and meetings they approved.
  const mineNotes = new Set<string>();
  const mineDocuments = new Set<string>();
  const meetings: Meeting[] = [];
  const [apollo, beacon] = desktop.projects.map(project => project.project_id) as [string, string];
  if (MINE_MODES.has(mode)) {
    // Beacon's kickoff: approved by Maya, so it is in Beacon but not in Mine.
    meetings.push({
      record_sha256: BEACON_KICKOFF, title: 'Beacon kickoff', added_at: '2026-09-19T16:00:00.000Z', meeting_date: '2026-09-19', visibility: 'project',
      project_ids: [beacon], approver: 'mem_33333333-3333-4333-8333-333333333333', started_at: '2026-09-19T15:00:00.000Z', timezone: 'Europe/London',
      participants: ['Maya Chen', 'Ari'], approved_by: 'Maya Chen',
      atoms: [{ kind: 'decision', text: 'Kick off Beacon in October.' }, { kind: 'action', text: 'Invite the design team.', owner: 'Maya Chen' }],
    });
  }
  if (MINE_MODES.has(mode) && mode !== 'mine-empty') {
    meetings.push({
      record_sha256: PRICING_REVIEW, title: 'Pricing review', added_at: '2026-09-21T20:30:00.000Z', meeting_date: '2026-09-21', visibility: 'only_me',
      project_ids: [], approver: session.membership_id, started_at: '2026-09-21T19:00:00.000Z', timezone: 'America/Los_Angeles',
      participants: ['Ari', 'Maya Chen'], approved_by: 'Ari',
      atoms: [
        ...Array.from({ length: 20 }, (_, index) => ({ kind: 'decision' as const, text: `Decision ${index + 1}: keep plan ${index + 1} as priced.`,
          ...(index === 0 ? { status: 'proposed' } : {}) })),
        { kind: 'action', text: 'Send the annual price sheet.', owner: 'Maya Chen' },
        { kind: 'action', text: 'Update the pricing page.' },
        { kind: 'action', text: 'Brief the sales team.' },
        { kind: 'action', text: LONG_ACTION },
        { kind: 'action', text: 'Book the follow-up review.' },
        { kind: 'rationale', text: 'Annual plans fund the launch.' },
        { kind: 'rationale', text: 'Teams asked for one price sheet.' },
      ],
    });
    documents.push({
      document_id: PRICING_MEMO, request_id: '00000000-0000-4000-8000-0000000000d9', filename: 'Pricing memo.pdf', title: 'Pricing memo',
      original: '%PDF-1.4 Pricing memo\n', detected_media_type: 'application/pdf', audience: { kind: 'project', project_id: apollo },
      association_project_ids: [apollo], received_at: '2026-09-21T18:00:00.000Z', extraction_state: 'ready',
      pages: [[{ ordinal: 0, anchor_kind: 'page', anchor_start: 1, text: 'Annual plans lead the price sheet.' }]],
    });
    mineDocuments.add(PRICING_MEMO);
    catalog.set(LAUNCH_CHECKLIST, {
      received_at: '2026-09-20T12:00:00.000Z', title: 'Launch checklist', text: 'Book the venue.\nSend the invites.\n', audience: { kind: 'team' },
    });
    filed.set(apollo, [...filed.get(apollo)!, LAUNCH_CHECKLIST]);
    filed.set(beacon, [...filed.get(beacon)!, LAUNCH_CHECKLIST]);
    // Eight quick notes of Ari's own, a day earlier: Mine runs past one page.
    const standups = Array.from({ length: 8 }, (_, index) => `ctx_${'f'.repeat(62)}${(index + 1).toString(16).padStart(2, '0')}`);
    standups.forEach((id, index) => catalog.set(id, {
      received_at: new Date(Date.parse('2026-09-19T12:00:00.000Z') - (index + 1) * 3_600_000).toISOString(), title: `Standup ${index + 1}`,
      text: `Standup ${index + 1} notes.`, audience: { kind: 'only_me' },
    }));
    for (const id of [...desktop.notes.map(saved => saved.context_id), LAUNCH_CHECKLIST, ...standups]) mineNotes.add(id);
  }
  /** Changes applied, by request id: a resend of the same one gets the same receipt, anything else under it conflicts. */
  const jiraMappings = new Map<string, { revision: string | null; mapping: { cloud_id: string; project_id: string; project_key: string } | null }>();
  const confluenceMappings = new Map<string, { revision: string | null; mapping: { cloud_id: string; space_ids: string[] } | null }>();
  if (mode === 'confluence-member-read') confluenceMappings.set(desktop.projects[1]!.project_id, { revision: '00000000-0000-4000-8000-000000000071', mapping: { cloud_id: CONFLUENCE_CLOUD, space_ids: ['100'] } });
  if (mode === 'confluence-spaces-unavailable') confluenceMappings.set(desktop.projects[0]!.project_id, { revision: '00000000-0000-4000-8000-000000000072', mapping: { cloud_id: CONFLUENCE_CLOUD, space_ids: ['100'] } });
  let jiraMappingWrites = 0;
  let confluenceMappingWrites = 0;
  const applied = new Map<string, { command: string; receipt: Record<string, unknown>; status: number }>();
  /** The organization's employees, as their owner lists them. */
  const employees = [
    { email: 'ana@example.com', display_name: 'Ana Mills', membership_status: 'active', invitation_state: 'redeemed' },
    { email: 'raj@example.com', display_name: 'Raj Kumar', membership_status: 'active', invitation_state: 'pending' },
    { email: 'lee@example.com', display_name: 'Lee Park', membership_status: 'revoked', invitation_state: 'expired' },
  ];
  let employeeWrites = 0;
  let employeeLists = 0;
  let changes = 0;
  let memberAdds = 0;
  let writeAttempts = 0;
  let documentAttempts = 0;
  let evidenceReads = 0;
  let asks = 0;
  let projectLists = 0;
  let lists = 0;
  let mineLists = 0;
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
  // The browser, never a real one: past Google, the Authority's callback page
  // posts the new session to the loopback receiver the sign-in began with.
  const openAuthorizationUrl = (address: string): boolean => {
    // A tool's consent page: the person is "in the browser" until the attempt's reads settle it.
    if (address === JIRA_CONNECT_LINK || address === CONFLUENCE_CONNECT_LINK) return true;
    const url = new URL(address);
    const state = url.searchParams.get('state') ?? '';
    const handoff = url.origin === IDENTITY_PROVIDER ? handoffs.get(state) : undefined;
    if (!handoff) return false;
    handoffs.delete(state);
    const form = new URLSearchParams({ token: handoff.token, session: Buffer.from(JSON.stringify(session)).toString('base64url') });
    const post = () => { globalThis.fetch(handoff.url, { method: 'POST', body: form }).catch(() => undefined); };
    // Still in the browser when a slow sign-out finishes.
    if (mode === 'signout-slow-browser') setTimeout(post, 4_000); else post();
    return true;
  };

  const roleOf = (projectId: string, membershipId: string) => members[projectId]?.find(entry => entry.membership_id === membershipId)?.role;
  const nameOf = (membershipId: string) => desktop.people.find(person => person.membership_id === membershipId)?.display_name ?? 'Someone';
  /** Ten at a time: the first page, or the rest after SECOND_PAGE. */
  const paged = <T>(all: readonly T[], cursor: unknown) => {
    const from = cursor === SECOND_PAGE ? PAGE : 0;
    return { items: all.slice(from, from + PAGE), next_cursor: from + PAGE < all.length ? SECOND_PAGE : null };
  };
  const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
  // The fixture's documents were saved by someone else, so their request IDs stay private (ADR-0023);
  // only one Ari uploaded (Mine's) carries its own.
  const documentMetadata = (document: StoredDocument) => ({
    schema_version: 2, kind: 'echo-person-document-metadata-v2', request_id: mineDocuments.has(document.document_id) ? document.request_id : null,
    filename: document.filename,
    title: document.title, content_length: Buffer.byteLength(document.original), sha256: sha(document.original), audience: document.audience,
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
    if (path.endsWith('/members/add')) memberAdds += 1;
    // Made, but the reply is lost on its way back: the first change, or the first person added.
    if ((mode === 'change-reply-lost' && changes === 1) || (mode === 'member-reply-lost' && memberAdds === 1 && path.endsWith('/members/add'))) {
      return failure('unavailable', 503);
    }
    return json(receipt, status);
  };
  /** Your projects, in the list's order, as the mode has them. */
  const listed = (): { project_id: string; name: string; role: 'lead' | 'member' }[] => {
    if (GRANOLA_PROJECTS.has(mode)) return [
      { project_id: 'prj_11111111-1111-4111-8111-111111111111', name: 'Thermostat redesign', role: 'lead' },
      { project_id: 'prj_44444444-4444-4444-8444-444444444444', name: 'Supplier review', role: 'member' },
    ];
    const numbered = (count: number, digit: string, name: (index: number) => string) => Array.from({ length: count }, (_, index) => ({
      project_id: `prj_${String(index + 1).padStart(8, '0')}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
      name: name(index), role: 'member' as const,
    }));
    if (mode === 'many-projects' || mode === 'many-projects-lead') return numbered(13, '1', index => `Project ${index + 1}`)
      .map((project, index) => mode === 'many-projects-lead' && index === 12 ? { ...project, role: 'lead' as const } : project);
    // Twenty in two pages, some with long names, one longer than Capture is wide.
    if (mode === 'long-project-names') return numbered(20, '2', index => LONG_NAMES[index]!);
    // More than a capture can be filed in: twenty-two, in three pages.
    if (mode === 'over-twenty-projects') return numbered(22, '3', index => `Project ${index + 1}`);
    // Added to a project made since the first list: the newest, it leads.
    if (mode === 'project-added' && projectLists > 0) {
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
  /** Everything in a scope, newest first, then by ref. */
  const rows = (scope: { mine: true } | { project_id: string }): Row[] => {
    const notes = 'mine' in scope ? [...mineNotes] : filed.get(scope.project_id) ?? [];
    const all = [
      ...notes.filter(id => catalog.has(id)).map(noteRow),
      ...documents.filter(document => 'mine' in scope ? mineDocuments.has(document.document_id) : document.association_project_ids.includes(scope.project_id))
        .map(documentRow),
      ...meetings.filter(meeting => 'mine' in scope ? meeting.approver === session.membership_id : meeting.project_ids.includes(scope.project_id))
        .map(meetingRow),
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
  /** A meeting's atoms as open pages them: each atom's text in parts of at most 3 KiB, its attributes on the first. */
  const atomParts = (meeting: Meeting) => meeting.atoms.flatMap(atom => {
    const count = Math.ceil(Buffer.byteLength(atom.text) / ATOM_PART_BYTES);
    const { text: whole, ...attributes } = atom;
    if (count === 1) return [atom];
    return Array.from({ length: count }, (_, index) => ({
      kind: atom.kind, text: whole.slice(index * ATOM_PART_BYTES, (index + 1) * ATOM_PART_BYTES), ...(index === 0 ? attributes : {}), part: { index: index + 1, count },
    }));
  });

  // Open items. Ari's own check of Pilot planning finds two once it is done;
  // in the owner modes Mina has sent Ari items of hers already.
  const ARI = { membership_id: session.membership_id, name: 'Ari' };
  const PILOT_RUN = 'run_00000000-0000-4000-8000-000000000020';
  const PILOT_RECORD = sha('record:Pilot planning');
  const ticket = (key: string, title: string, id: string) => ({ kind: 'ticket', label: `${key} · ${title}`, visibility: 'only_me', citation: {
    kind: 'ticket', tool_id: 'jira', external_scope_id: JIRA_CLOUD, ticket_id: id, permalink: `https://example.atlassian.net/browse/${key}`, text_sha256: sha(`${key}: ${title}`) } });
  const PRD_PAGE = { kind: 'page', label: 'Thermostat PRD · Pilot scope', visibility: 'only_me', citation: {
    kind: 'page', tool_id: 'confluence', external_scope_id: CONFLUENCE_CLOUD, page_id: '12345', section_id: 'pilot-scope', version: '7',
    permalink: 'https://example.atlassian.net/wiki/pages/viewpage.action?pageId=12345', text_sha256: sha('Thermostat PRD: Pilot scope') } };
  /** A supplier page in a Confluence space Ari cannot open: its title never reaches Ari. */
  const SUPPLIER_BRIEF = { kind: 'page', label: 'Supplier brief · Lead time', visibility: 'only_me', citation: {
    kind: 'page', tool_id: 'confluence', external_scope_id: CONFLUENCE_CLOUD, page_id: '23456', section_id: 'lead-time', version: '3',
    permalink: 'https://example.atlassian.net/wiki/pages/viewpage.action?pageId=23456', text_sha256: sha('Supplier brief: Lead time') } };
  const openItems: OpenItem[] = [];
  const minaSent = (item: Omit<OpenItem, 'approver' | 'state' | 'sent_at' | 'state_set_at' | 'check'> & { sent_at: string | null }): OpenItem =>
    ({ ...item, approver: MINA, state: item.sent_at === null ? 'unsent' : 'open', state_set_at: item.sent_at, check: null });
  // Owner modes receive someone else's items without Granola being available.
  // granola-owner-outage is granola-owner while Jira does not answer for its second item.
  const sentToAri = mode === 'granola-owner' || mode === 'granola-owner-outage';
  if (sentToAri || mode === 'granola-home-fails-once') {
    openItems.push(minaSent({
      item_id: 'itm_00000000-0000-4000-8000-000000000041', run_id: 'run_00000000-0000-4000-8000-000000000041', kind: 'ticket',
      decision: { approval_id: 'apr_' + 'c'.repeat(64), record_sha256: sha('record:Pilot planning, approved by Mina'), title: 'Pilot planning',
        first_line: 'Launch the pilot next week.', approved_at: '2026-10-06T18:00:00.000Z', project_ids: [THERMOSTAT] },
      readable: true, opens: true, live: { citation: ticket('ECHO-12', 'Pilot launch', '10012'), says_now: 'The pilot launch is planned for the end of the month.',
        assignee: 'Ari', status: 'In Progress', due_at: '2026-10-30' },
      relation: 'conflicts', expected: 'launch next week', owner: { ...ARI, match: 'jira_account' }, created_at: '2026-10-06T18:05:00.000Z', sent_at: '2026-10-06T19:00:00.000Z',
    }));
    // A decision reader who cannot open the item: Ari reads Pilot planning, but this ticket is in a
    // Jira project Ari has no access to. Its title, link and assignee never reach Ari. In
    // granola-owner-outage, Jira does not answer for it just now instead.
    if (sentToAri) {
      openItems.push(minaSent({
        item_id: 'itm_00000000-0000-4000-8000-000000000044', run_id: 'run_00000000-0000-4000-8000-000000000041', kind: 'ticket',
        decision: { approval_id: 'apr_' + 'c'.repeat(64), record_sha256: sha('record:Pilot planning, approved by Mina'), title: 'Pilot planning',
          first_line: 'Launch the pilot next week.', approved_at: '2026-10-06T18:00:00.000Z', project_ids: [THERMOSTAT] },
        readable: true, opens: false, outage: mode === 'granola-owner-outage',
        live: { citation: ticket('ECHO-31', 'Trace sign-off', '10031'), says_now: 'The trace is signed off after the launch.',
          assignee: 'S. Okafor', status: 'Blocked', due_at: '2026-11-12' },
        relation: 'conflicts', expected: 'confirm the trace by Friday', owner: { ...ARI, match: 'picked' }, created_at: '2026-10-06T18:05:00.000Z',
        sent_at: '2026-10-06T19:00:00.000Z',
      }));
    }
    // A ticket Ari cannot open, from a decision Ari cannot read: only Send told Ari of it. In
    // granola-home-fails-once Mina sends it after Home's second read.
    openItems.push(minaSent({
      item_id: 'itm_00000000-0000-4000-8000-000000000042', run_id: 'run_00000000-0000-4000-8000-000000000042', kind: 'ticket',
      decision: { approval_id: 'apr_' + 'd'.repeat(64), record_sha256: sha('record:Vendor review'), title: 'Vendor review',
        first_line: 'Order with six weeks of lead time.', approved_at: '2026-10-05T15:00:00.000Z', project_ids: [SUPPLIER] },
      readable: false, opens: false, live: { citation: ticket('ECHO-20', 'Vendor order', '10020'), says_now: 'The vendor order goes out in four weeks.',
        assignee: 'Rafael Moreno', status: 'To Do' },
      relation: 'conflicts', expected: 'order six weeks ahead', owner: { ...ARI, match: 'picked' },
      created_at: '2026-10-05T15:05:00.000Z', sent_at: sentToAri ? '2026-10-05T16:00:00.000Z' : null,
    }));
  }
  if (mode === 'granola-all') {
    openItems.push(minaSent({
      item_id: 'itm_00000000-0000-4000-8000-000000000043', run_id: 'run_00000000-0000-4000-8000-000000000043', kind: 'ticket',
      decision: { approval_id: 'apr_' + 'e'.repeat(64), record_sha256: sha('record:Kickoff review'), title: 'Kickoff review',
        first_line: 'Freeze the firmware after the pilot.', approved_at: '2026-10-03T15:00:00.000Z', project_ids: [THERMOSTAT] },
      readable: true, opens: true, live: { citation: ticket('ECHO-7', 'Firmware freeze', '10007'), says_now: 'The firmware freezes before the pilot.',
        assignee: 'Ari', status: 'To Do', due_at: '2026-11-04' },
      relation: 'conflicts', expected: 'freeze after the pilot', owner: { ...ARI, match: 'name' }, created_at: '2026-10-03T15:05:00.000Z', sent_at: '2026-10-03T16:00:00.000Z',
    }));
  }
  // granola-checked: Mina approved Kickoff review into Thermostat redesign and sent its three items to herself, Rafael and S.
  // Okafor; none is checked yet. Ari reads the decision, and none of its items involves Ari (canvas 9.7: "3 open" on its row).
  if (mode === 'granola-checked') {
    const kickoff = { approval_id: 'apr_' + 'e'.repeat(64), record_sha256: sha('record:Kickoff review'), title: 'Kickoff review',
      first_line: 'Freeze the firmware after the pilot.', approved_at: '2026-09-29T15:00:00.000Z', project_ids: [THERMOSTAT] };
    const sent = { run_id: 'run_00000000-0000-4000-8000-000000000045', kind: 'ticket' as const, decision: kickoff, readable: true, opens: true,
      relation: 'conflicts' as const, expected: 'freeze after the pilot', created_at: '2026-09-29T15:05:00.000Z', sent_at: '2026-09-29T16:00:00.000Z' };
    openItems.push(
      minaSent({ ...sent, item_id: 'itm_00000000-0000-4000-8000-000000000045', owner: { ...MINA, match: 'jira_account' },
        live: { citation: ticket('ECHO-7', 'Firmware freeze', '10007'), says_now: 'The firmware freezes before the pilot.', assignee: 'Mina Patel', status: 'To Do', due_at: '2026-11-04' } }),
      minaSent({ ...sent, item_id: 'itm_00000000-0000-4000-8000-000000000046', owner: { ...RAFAEL, match: 'name' },
        live: { citation: ticket('ECHO-8', 'Pilot firmware build', '10008'), says_now: 'The pilot build uses the frozen firmware.', assignee: 'Rafael Moreno', status: 'To Do' } }),
      minaSent({ ...sent, item_id: 'itm_00000000-0000-4000-8000-000000000047', owner: { ...OKAFOR, match: 'picked' },
        live: { citation: ticket('ECHO-9', 'Firmware sign-off', '10009'), says_now: 'Sign-off follows the freeze.', assignee: 'S. Okafor', status: 'Blocked' } }),
    );
  }
  // The meetings Mina approved that Ari can read, each once: in their project's feed, where their Impact line shows.
  for (const item of openItems.filter(entry => entry.readable)) {
    if (meetings.some(meeting => meeting.record_sha256 === item.decision.record_sha256)) continue;
    meetings.push({
      record_sha256: item.decision.record_sha256, title: item.decision.title, added_at: item.decision.approved_at, meeting_date: item.decision.approved_at.slice(0, 10),
      visibility: 'project', project_ids: item.decision.project_ids, approver: MINA.membership_id, started_at: item.decision.approved_at, timezone: 'Europe/London',
      participants: ['Mina Patel', 'Ari'], approved_by: 'Mina Patel', atoms: [{ kind: 'decision', text: item.decision.first_line ?? item.decision.title }],
    });
  }
  /** What Ari's check of Pilot planning found, written once when it is done: unsent, with exact owners or Ari. */
  const writeFound = () => {
    if (granolaRun?.state !== 'done' || openItems.some(item => item.run_id === PILOT_RUN)) return;
    const decision = { approval_id: 'apr_' + 'a'.repeat(64), record_sha256: PILOT_RECORD, title: 'Pilot planning', first_line: 'Launch the pilot next week.',
      approved_at: '2026-10-07T10:00:00.000Z', project_ids: Array.isArray(granolaReview?.project_ids) ? [...granolaReview.project_ids as string[]] : [] };
    const unsent = { run_id: PILOT_RUN, decision, readable: true, approver: ARI, state: 'unsent' as const, created_at: '2026-10-07T10:05:00.000Z', sent_at: null, state_set_at: null,
      check: null };
    openItems.push(
      { ...unsent, item_id: 'itm_00000000-0000-4000-8000-000000000031', kind: 'ticket', relation: 'conflicts', expected: 'launch next week',
        opens: true, live: { citation: ticket('ECHO-12', 'Pilot launch', '10012'), says_now: 'The pilot launch is planned for the end of the month.',
          assignee: 'Mina Patel', status: 'In Progress', due_at: '2026-10-30' }, owner: { ...MINA, match: 'jira_account' } },
      { ...unsent, item_id: 'itm_00000000-0000-4000-8000-000000000032', kind: 'page', relation: 'needs_updating', expected: 'pilot starts next week',
        opens: true, live: { citation: PRD_PAGE, says_now: 'starts after freeze' }, owner: { ...ARI, match: 'approver' } },
    );
  };
  /** Pilot planning, approved by Ari: in the projects it was approved into, where its record opens. */
  const pilotMeeting = (projectIds: string[]): Meeting => ({
    record_sha256: PILOT_RECORD, title: 'Pilot planning', added_at: '2026-10-07T10:00:00.000Z', meeting_date: '2026-10-06',
    visibility: projectIds.length > 0 ? 'project' : 'only_me', project_ids: projectIds, approver: session.membership_id,
    started_at: '2026-10-06T16:00:00.000Z', timezone: 'Europe/London', participants: ['Ari', 'Mina Patel', 'Rafael Moreno'], approved_by: 'Ari',
    atoms: [{ kind: 'decision', text: 'Launch the pilot next week.' }, { kind: 'action', text: 'Send the revised quote', owner: 'Rafael Moreno' },
      { kind: 'action', text: 'Confirm the trace', owner: 'Mina Patel' }],
  });
  /** What a sweep finds of Pilot planning's items: ECHO-12 landed, the PRD page changed, the supplier page unreadable. */
  const SWEPT: Readonly<Record<string, Check['verdict']>> = {
    'itm_00000000-0000-4000-8000-000000000031': 'landed', 'itm_00000000-0000-4000-8000-000000000032': 'changed',
    'itm_00000000-0000-4000-8000-000000000033': 'unreadable',
  };
  // granola-checked, granola-review, granola-sweep and granola-sweep-requeued: Ari approved Pilot
  // planning into Thermostat redesign and sent what its check found: ECHO-12 to Mina, the PRD page kept
  // by Ari, and a supplier page Ari cannot open to Rafael. In granola-checked Mina's sweep checked them
  // two hours ago; granola-review is the same, except that ECHO-12, Mina's to update, changed and still
  // does not match (a Review row on Ari's Home). In the sweep modes none has been checked, so Home says a
  // sweep is due. granola-alike: the
  // check is done and nothing is sent yet; it also found items whose titles nothing tells apart: two
  // supplier pages Ari cannot open, with the same expected phrase, and two tickets Jira did not answer
  // for just now, not assessed (no expected phrase).
  if (mode === 'granola-checked' || mode === 'granola-review' || mode.startsWith('granola-sweep') || mode === 'granola-alike') {
    granolaApproved = true;
    granolaReview = { action: 'approve', project_ids: [THERMOSTAT] };
    granolaRun = { state: 'done', error_code: null, lists: 0, retried: false };
    meetings.push(pilotMeeting([THERMOSTAT]));
    writeFound();
    const found = openItems.find(item => item.run_id === PILOT_RUN)!;
    if (mode === 'granola-alike') {
      const page = (id: string, label: string) => ({ kind: 'page', label: `Supplier brief · ${label}`, visibility: 'only_me', citation: {
        kind: 'page', tool_id: 'confluence', external_scope_id: CONFLUENCE_CLOUD, page_id: id, section_id: 'parts', version: '3',
        permalink: `https://example.atlassian.net/wiki/pages/viewpage.action?pageId=${id}`, text_sha256: sha(`Supplier brief: ${label}`) } });
      const theirs = { ...found, opens: false, owner: { ...ARI, match: 'approver' as const } };
      openItems.push(
        { ...theirs, item_id: 'itm_00000000-0000-4000-8000-000000000034', kind: 'page', expected: 'parts ordered for next week',
          live: { citation: page('23457', 'Tooling'), says_now: 'Tooling is ordered with six weeks of lead time.' } },
        { ...theirs, item_id: 'itm_00000000-0000-4000-8000-000000000035', kind: 'page', expected: 'parts ordered for next week',
          live: { citation: page('23458', 'Packaging'), says_now: 'Packaging is ordered with six weeks of lead time.' } },
        { ...theirs, item_id: 'itm_00000000-0000-4000-8000-000000000036', kind: 'ticket', relation: null, expected: null, outage: true,
          live: { citation: ticket('ECHO-41', 'Tooling order', '10041'), says_now: 'The tooling order goes out in October.' } },
        { ...theirs, item_id: 'itm_00000000-0000-4000-8000-000000000037', kind: 'ticket', relation: null, expected: null, outage: true,
          live: { citation: ticket('ECHO-42', 'Pilot freight', '10042'), says_now: 'Freight is booked for November.' } },
      );
    } else {
      openItems.push({ ...found, item_id: 'itm_00000000-0000-4000-8000-000000000033', kind: 'page', relation: 'conflicts', expected: 'parts ordered for next week',
        opens: false, live: { citation: SUPPLIER_BRIEF, says_now: 'Parts are ordered with six weeks of lead time.' }, owner: { ...RAFAEL, match: 'picked' } });
      const sentAt = '2026-10-07T11:00:00.000Z';
      const checkedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
      const checked: Readonly<Record<string, Check['verdict']>> = mode === 'granola-review' ? { ...SWEPT, 'itm_00000000-0000-4000-8000-000000000031': 'changed' } : SWEPT;
      for (const item of openItems.filter(entry => entry.run_id === PILOT_RUN)) {
        Object.assign(item, { state: 'open', sent_at: sentAt, state_set_at: sentAt,
          check: mode === 'granola-checked' || mode === 'granola-review' ? { verdict: checked[item.item_id]!, checked_at: checkedAt, checked_by: 'Mina Patel' } : null });
      }
    }
  }
  const mineAsOwner = (item: OpenItem) => item.owner.membership_id === ARI.membership_id;
  const involved = (item: OpenItem) => item.approver.membership_id === ARI.membership_id || mineAsOwner(item);
  /** Ari sees a row whose decision Ari can read, and an item sent to Ari as its owner. */
  const visible = (item: OpenItem) => item.readable || (mineAsOwner(item) && item.state !== 'unsent');
  /**
   * A row rebuilt for Ari: the decision only for a reader, what it says now only when Ari could open it,
   * and how its live read went: opened, refused to Ari, or not answered just now.
   */
  const itemView = (item: OpenItem) => {
    const reach = item.outage ? 'unavailable' : item.opens ? 'opened' : 'no_access';
    return {
      item_id: item.item_id, run_id: item.run_id, kind: item.kind, ...(item.readable ? { decision: item.decision } : {}), ...(reach === 'opened' ? { current: item.live } : {}),
      relation: item.relation, expected: item.expected, approver: { ...item.approver, active: true }, owner: { ...item.owner, active: true },
      waits_on: item.state === 'unsent' ? 'approver' : 'owner', state: item.state, created_at: item.created_at, sent_at: item.sent_at, state_set_at: item.state_set_at,
      check: item.check, can: { set_state: item.state !== 'unsent' && involved(item), assign: involved(item) }, reach,
    };
  };
  /** Send commands applied, by command id: a resend gets the same answer. */
  const sends = new Map<string, { sent: number; not_relevant: number }>();
  /** Ari's sweeps, newest first. */
  const sweepRuns: SweepRun[] = [];
  let homeReads = 0;
  let supplierSync: 'pending' | 'approved' | 'rejected' = 'pending';

  // Your connections to the organization's tools, as Tools changes them.
  let slackLinked = true;
  let jiraLinked = false;
  let confluenceLinked = false;
  let jiraAttempt: { attempt: string; expires_at: string; status: string; failure_reason: string | null; reads: number } | null = null;
  let confluenceAttempt: { attempt: string; expires_at: string; status: string; failure_reason: string | null; reads: number } | null = null;

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
          slackLinked ? tool('slack', 'Slack', 'linked', 'T0123ABCD', 'U0123ABCD') : tool('slack', 'Slack', 'unlinked', 'T0123ABCD', null),
          tool('jira', 'Jira', jiraLinked ? 'linked' : mode === 'tools-revoked' ? 'revoked' : 'unlinked', JIRA_CLOUD, jiraLinked ? 'atlassian-account-1' : null),
          tool('confluence', 'Confluence', confluenceLinked ? 'linked' : 'unlinked', CONFLUENCE_CLOUD, confluenceLinked ? 'atlassian-account-1' : null),
          mode.startsWith('granola') && !sentToAri ? tool('granola', 'Granola', 'linked', 'workspace', 'ari@example.test') : { tool_id: 'granola', display_name: 'Granola', availability: 'unavailable', personal_status: 'unavailable',
            external_scope_id: null, external_subject_id: null, organization_setup: null },
        ],
      });
    }
    if (method === 'POST' && path === '/v1/person/meetings' && mode.startsWith('granola')) {
      const meetingId = '00000000-0000-4000-8000-000000000010';
      const folderId = '00000000-0000-4000-8000-000000000011';
      const decidedOn = granolaApproved ? mode === 'granola-decided-in-slack' ? 'slack' : 'desktop' : null;
      const review = { approval_id: 'apr_' + 'a'.repeat(64), title: 'Pilot planning',
        project_ids: Array.isArray(granolaReview?.project_ids) ? granolaReview.project_ids : [],
        status: granolaApproved ? mode === 'granola-publishing' && granolaRun === null ? 'publishing' : 'approved' : 'pending', decided_on: decidedOn,
        first_line: 'Launch the pilot next week.', action_count: 2, meeting_at: '2026-10-06T16:00:00.000Z' };
      switch (body?.operation) {
        case 'home': return mode === 'granola-browse-unavailable' ? failure('unavailable', 503) : json({ connected: true, email: 'ari@example.test', workspace: 'EchoBrain', folders: [{ id: folderId, title: 'ECHO', count: 1 }], settings_sha256: 'sha256:' + 'a'.repeat(64),
          sources: mode === 'granola-preparing' && granolaWatch ? [{ source_key: 'pms_fixture', folder_id: folderId, folder_project_id: 'prj_11111111-1111-4111-8111-111111111111', baseline: granolaBaselineHomeReads++ > 0, pending_imports: [], checked_at: null, error: null }] : [] });
        case 'browse': return json({ meetings: [{ id: meetingId, title: 'Pilot planning', date: '2026-10-06' }] });
        case 'open': return json({ id: meetingId, title: 'Pilot planning', notes: 'Launch the pilot next week.', summary: 'Decision: launch.', truncated: false });
        case 'watch': granolaWatch = true; return json({ status: 'saved' });
        case 'import': granolaImported = true; return json({ status: 'queued' });
        case 'reviews': return json({ reviews: [
          ...(granolaImported || mode === 'granola-browse-unavailable' || mode === 'granola-decided-in-slack' ? [review] : []),
          ...(mode === 'granola-all' ? [{ ...SUPPLIER_SYNC, status: supplierSync, decided_on: supplierSync === 'pending' ? null : 'desktop' }] : []),
        ] });
        case 'review_open':
          if (body?.approval_id === SUPPLIER_SYNC.approval_id) {
            return json({ review: { ...SUPPLIER_SYNC, status: supplierSync, decided_on: supplierSync === 'pending' ? null : 'desktop' }, snapshot_sha256: 'sha256:' + 'c'.repeat(64),
              content: 'Supplier sync\nDecisions\nLead time stays six weeks.', owners: [{ signal_id: 'act-1', action: 'Update the supplier contract', proposed: 'Rafael Moreno' }],
              suggested_projects: [{ project_id: SUPPLIER, name: 'Supplier review' }] });
          }
          return json({ review, snapshot_sha256: 'sha256:' + 'b'.repeat(64), content: 'Pilot planning\nDecisions\nLaunch the pilot next week.',
          owners: [{ signal_id: 'act-1', action: 'Send the revised quote', proposed: 'Rafael Moreno' }, { signal_id: 'act-2', action: 'Confirm the trace', proposed: 'Mina Patel' }],
          suggested_projects: [{ project_id: 'prj_11111111-1111-4111-8111-111111111111', name: 'Thermostat redesign' }] });
        case 'review':
          if (body?.approval_id === SUPPLIER_SYNC.approval_id) {
            supplierSync = body?.action === 'approve' ? 'approved' : 'rejected';
            return json({ status: supplierSync, decided_on: 'desktop' });
          }
          granolaReview = body; granolaApproved = true;
          if (body?.action === 'approve' && granolaRun === null && mode !== 'granola-publishing') granolaRun = { state: 'pending', error_code: null, lists: 0, retried: false };
          // The approved meeting: in the projects it was approved into, where its record opens.
          if (body?.action === 'approve' && !meetings.some(meeting => meeting.record_sha256 === PILOT_RECORD)) {
            meetings.push(pilotMeeting(Array.isArray(body.project_ids) ? body.project_ids as string[] : []));
          }
          return json(mode === 'granola-decided-in-slack' ? { status: 'approved', decided_on: 'slack' } : { status: 'publishing', decided_on: 'desktop' });
      }
    }
    // Impact checks: approving queues one run; a start runs it, and the second
    // list after that finds it done (in granola-run-failed, failed until Try
    // again). A done check has found two open items. A sweep of a scope with
    // open items queues a sweep run, which starts once no impact check of
    // Ari's is pending or running; the second list after its start finds it
    // done, each item it checked carrying its verdict. A sweep is due only in
    // granola-sweep, until one is asked for. Every answer passes the
    // contract's own result check, as the Authority's does. Runs and shared
    // Home reads exist even when the meeting provider is unavailable.
    if (method === 'POST' && path === '/v1/person/runs') {
      const api = await contract();
      let request: RunsRequest;
      try {
        request = api.validatePersonRunsRequestV1(body);
      } catch {
        return failure('invalid_request', 400);
      }
      const runId = PILOT_RUN;
      // Real publication is asynchronous: the first post-approval list can have no run yet.
      if (mode === 'granola-publishing' && granolaApproved && granolaRun === null && request.operation === 'list' && ++granolaPublicationReads >= 2) {
        granolaRun = { state: 'pending', error_code: null, lists: 0, retried: false };
      }
      const run = granolaRun;
      const row = (value: NonNullable<typeof run>) => ({ run_id: runId, trigger: 'approved_record', event_ref: 'apr_' + 'a'.repeat(64), state: value.state,
        error_code: value.error_code, created_at: '2026-10-07T10:00:00.000Z', updated_at: '2026-10-07T10:05:00.000Z' });
      const sweepRow = (sweep: SweepRun) => ({ run_id: sweep.run_id, trigger: 'sweep', event_ref: sweep.event_ref, state: sweep.state, error_code: null,
        created_at: sweep.created_at, updated_at: sweep.created_at });
      const result = (operation: string, value: unknown) => json(api.validatePersonRunsResultV1(operation, value));
      const now = () => new Date().toISOString();
      if (request.operation === 'list' && run?.state === 'running' && ++run.lists >= 2) {
        Object.assign(run, mode === 'granola-run-failed' && !run.retried ? { state: 'failed', error_code: 'research_failed' } : { state: 'done' });
      }
      for (const sweep of sweepRuns) {
        if (request.operation !== 'list' || sweep.state !== 'running') continue;
        // granola-sweep-requeued: the first attempt times out, and the run goes back to the queue (the attempt rules impact checks have).
        if (mode === 'granola-sweep-requeued' && !sweep.requeued) { Object.assign(sweep, { state: 'pending', requeued: true }); continue; }
        if (++sweep.lists < 2) continue;
        // Done: each item it checked that is still open keeps this check as its last.
        const at = now();
        for (const item of openItems) {
          if (sweep.items.includes(item.item_id) && item.state === 'open') item.check = { verdict: SWEPT[item.item_id] ?? 'still_open', checked_at: at, checked_by: 'Ari' };
        }
        sweep.state = 'done';
      }
      writeFound();
      // Mina sends Ari another item after Home's second read.
      if (mode === 'granola-home-fails-once' && request.operation === 'home' && homeReads === 2) {
        const later = openItems.find(item => item.state === 'unsent' && item.approver.membership_id === MINA.membership_id);
        if (later) Object.assign(later, { state: 'open', sent_at: now(), state_set_at: now() });
      }
      const shown = openItems.filter(visible).sort((a, b) => a.created_at.localeCompare(b.created_at));
      /** An item in a scope: one Ari sent or owns, a run's, or, read by Ari, a decision's or a project's. */
      const inScope = (item: OpenItem, scope: RunsRequest['scope'], id: string | undefined) => scope === 'mine' ? involved(item) : scope === 'run' ? item.run_id === id
        : scope === 'record' ? item.readable && item.decision.record_sha256 === id : item.readable && item.decision.project_ids.includes(id!);
      switch (request.operation) {
        case 'list':
          // Newest first: Ari's sweeps came after the check of Pilot planning.
          return result('list', { runs: [...sweepRuns.map(sweepRow), ...(run ? [row(run)] : [])] });
        case 'start': {
          // One run goes at a time, and impact checks start before sweeps: a sweep waits while one is pending or running.
          const sweep = sweepRuns.find(entry => entry.run_id === request.run_id);
          if (sweep) {
            if (run?.state === 'pending' || run?.state === 'running' || sweepRuns.some(entry => entry !== sweep && entry.state === 'running')) {
              return result('start', { state: 'busy' });
            }
            if (sweep.state === 'pending') Object.assign(sweep, { state: 'running', lists: 0 });
            return result('start', { state: sweep.state });
          }
          if (!run || request.run_id !== runId) return failure('not_found', 404);
          if (sweepRuns.some(entry => entry.state === 'running')) return result('start', { state: 'busy' });
          if (run.state === 'pending') Object.assign(run, { state: 'running', lists: 0 });
          return result('start', { state: run.state });
        }
        case 'retry':
          if (run?.state !== 'failed' || request.run_id !== runId) return failure('not_found', 404);
          Object.assign(run, { state: 'pending', error_code: null, retried: true });
          return result('retry', { state: 'pending' });
        case 'view': {
          if (run?.state !== 'done' || request.run_id !== runId) return failure('not_found', 404);
          const record = (record_sha256: string, label: string) => ({ kind: 'decision', label, visibility: 'only_me',
            citation: { kind: 'approved_record', atom_id: sha(`atom:${label}`), record_sha256, policy_id: 'restricted-reviewer-person-v2' } });
          return result('view', { checked_at: '2026-10-07T10:05:00.000Z', hidden: 1, card: {
            status: 'assessed',
            decided: [{ text: 'Launch the pilot next week.', citation_index: 0 }],
            affected: [
              { citation_index: 1, says_now: 'The pilot launch is planned for the end of the month.', relation: 'conflicts', expected: 'launch next week', owner: 'Mina Patel',
                date_at_risk: { date: '2026-10-30', milestone: 'Pilot launch' } },
              { citation_index: 3, says_now: 'The pilot starts after the freeze.', relation: 'needs_updating', expected: 'pilot starts next week' },
              { citation_index: 2, says_now: 'The pricing review approved the pilot budget.', relation: 'confirms' },
            ],
            unconfirmed: ['No supplier contract for the pilot was found.'],
            people: [{ name: 'Mina Patel', items: [1] }],
            citations: [record(PILOT_RECORD, 'Pilot planning'), ticket('ECHO-12', 'Pilot launch', '10012'), record(PRICING_REVIEW, 'Pricing review'), PRD_PAGE],
          } });
        }
        // Home: the Send row while Ari's check has items not sent, the open items that wait on
        // Ari, and the open items Ari sent that ECHO saw change; then, of the open items Ari sent
        // or owns, how many landed, how many Ari sent wait on others, and when ECHO last checked
        // one. granola-home-fails-once fails the second read.
        case 'home': {
          homeReads += 1;
          if (mode === 'granola-home-fails-once' && homeReads === 2) return failure('unavailable', 503);
          const unsent = shown.filter(item => item.run_id === runId && item.state === 'unsent');
          const send = run?.state === 'done' && unsent.length > 0 ? [{
            run_id: runId, decision: unsent[0]!.decision, items: unsent.length, kinds: [...new Set(unsent.map(item => item.kind))],
            owners: [...new Set(unsent.filter(item => !mineAsOwner(item)).map(item => item.owner.name))], finished_at: '2026-10-07T10:05:00.000Z',
          }] : [];
          const sentAt = (item: OpenItem) => item.sent_at ?? item.created_at;
          const theirs = shown.filter(item => item.state === 'open' && involved(item));
          const waitsOnAri = (item: OpenItem) => mineAsOwner(item) || item.check?.verdict === 'changed';
          return result('home', {
            send, items: theirs.filter(waitsOnAri).sort((a, b) => sentAt(a).localeCompare(sentAt(b))).map(itemView),
            landed: theirs.filter(item => item.check?.verdict === 'landed').length,
            waiting: theirs.filter(item => item.approver.membership_id === ARI.membership_id && !mineAsOwner(item)).length,
            last_checked_at: theirs.flatMap(item => (item.check ? [item.check.checked_at] : [])).sort().at(-1) ?? null,
            sweep_due: mode.startsWith('granola-sweep') && sweepRuns.length === 0,
          });
        }
        case 'items': {
          const { scope, id } = request;
          const items = shown.filter(item => inScope(item, scope, id));
          const records = [...new Set(items.filter(item => item.readable).map(item => item.decision.record_sha256))];
          const count = (state: OpenItem['state'], of = items) => of.filter(item => item.state === state).length;
          // Last checks count on open items only: a check reads open items.
          const verdicts = (verdict: Check['verdict'], of = items) => of.filter(item => item.state === 'open' && item.check?.verdict === verdict).length;
          // Each decision's check: Ari's own (whatever its stage), and Mina's, done. Only Ari's is Ari's own.
          const pilotProjects = Array.isArray(granolaReview?.project_ids) ? granolaReview.project_ids as string[] : [];
          const pilot = run !== null && granolaApproved && (scope === 'mine' || (scope === 'run' && id === runId) || (scope === 'record' && id === PILOT_RECORD) ||
            (scope === 'project' && pilotProjects.includes(id!)));
          const stages = [
            ...(pilot ? [{ record_sha256: PILOT_RECORD, run_id: runId, state: run.state, error_code: run.error_code, mine: true }] : []),
            ...records.filter(record => record !== PILOT_RECORD).map(record => {
              const found = items.find(item => item.decision.record_sha256 === record)!;
              return { record_sha256: record, run_id: found.run_id, state: 'done', error_code: null, mine: found.approver.membership_id === ARI.membership_id };
            }),
          ];
          // Counts only (a project's or a decision's line): the summary and stages, no item. Open only (Your open items): the open
          // items alone, with the same summary.
          const listed = request.open_only === true ? items.filter(item => item.state === 'open') : items;
          return result('items', { items: request.summary_only === true ? [] : listed.map(itemView), next_cursor: null, stages, summary: {
            unsent: count('unsent'), open: count('open'), done: count('done'), not_relevant: count('not_relevant'),
            landed: verdicts('landed'), changed: verdicts('changed'), unreadable: verdicts('unreadable'), decisions: records.length,
            last_checked_at: items.flatMap(item => (item.check ? [item.check.checked_at] : [])).sort().at(-1) ?? null, by_decision: records.map(record => {
              const of = items.filter(item => item.decision.record_sha256 === record);
              // Of its open items, those whose last check landed, and those ECHO could not read.
              return { record_sha256: record, unsent: count('unsent', of), open: count('open', of), landed: verdicts('landed', of), unreadable: verdicts('unreadable', of) };
            }),
          } });
        }
        // Send: once per command; a card drawn before the items changed is refused, and nothing is written.
        case 'send': {
          if (run?.state !== 'done' || request.run_id !== runId) return failure('not_found', 404);
          const earlier = sends.get(request.command_id!);
          if (earlier) return result('send', earlier);
          const unsent = openItems.filter(item => item.run_id === runId && item.state === 'unsent');
          const asked = request.items ?? [];
          if (asked.length !== unsent.length || !unsent.every(item => asked.some(entry => entry.item_id === item.item_id))) return failure('conflict', 409);
          if (asked.some(entry => entry.owner_membership_id !== undefined && !desktop.people.some(person => person.membership_id === entry.owner_membership_id))) {
            return failure('invalid_request', 400);
          }
          const at = now();
          for (const entry of asked) {
            const item = unsent.find(candidate => candidate.item_id === entry.item_id)!;
            if (entry.owner_membership_id !== undefined) item.owner = { membership_id: entry.owner_membership_id, name: nameOf(entry.owner_membership_id), match: 'picked' };
            Object.assign(item, { state: entry.include ? 'open' : 'not_relevant', sent_at: at, state_set_at: at });
          }
          const sent = { sent: asked.filter(entry => entry.include).length, not_relevant: asked.filter(entry => !entry.include).length };
          sends.set(request.command_id!, sent);
          return result('send', sent);
        }
        // Done or Not relevant: only the approver or the owner, and only once it was sent.
        case 'set_state': {
          const item = shown.find(entry => entry.item_id === request.item_id && involved(entry));
          if (!item) return failure('not_found', 404);
          if (item.state === 'unsent') return failure('invalid_request', 400);
          Object.assign(item, { state: request.state, state_set_at: now() });
          return result('set_state', { state: request.state });
        }
        // A sweep of the open items Ari can see in a scope (mine: those Ari sent or owns), queued; with
        // none open, nothing to check. Asked for again while that scope's sweep waits, it is that one.
        case 'sweep': {
          const { scope, id } = request;
          const open = shown.filter(item => item.state === 'open' && inScope(item, scope, id));
          if (open.length === 0) return result('sweep', { state: 'nothing_to_check' });
          const key = `${scope}:${id ?? ''}`;
          const queued = sweepRuns.find(entry => entry.scope === key && entry.state === 'pending');
          if (queued) return result('sweep', { run_id: queued.run_id });
          sweepRuns.unshift({ run_id: `run_${randomUUID()}`, event_ref: `sweep_${randomUUID()}`, scope: key, created_at: now(), state: 'pending', lists: 0,
            items: open.map(item => item.item_id) });
          return result('sweep', { run_id: sweepRuns[0]!.run_id });
        }
      }
    }
    // Jira: the browser consent is never shown; the second status read finds it done,
    // or, in tools-mismatch, signed in as another Jira account.
    if (method === 'POST' && path === '/v1/person/tools/jira/connect') {
      if (JSON.stringify(body) !== '{"schema_version":1}') return failure('invalid_request', 400);
      jiraAttempt = { attempt: randomUUID(), expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), status: 'pending', failure_reason: null, reads: 0 };
      return json({ schema_version: 1, attempt: jiraAttempt.attempt, connect_link: JIRA_CONNECT_LINK, expires_at: jiraAttempt.expires_at });
    }
    if (method === 'POST' && (path === '/v1/person/tools/jira/status' || path === '/v1/person/tools/jira/cancel')) {
      if (!jiraAttempt || body?.attempt !== jiraAttempt.attempt) return failure('not_found', 404);
      if (path.endsWith('/cancel')) {
        if (jiraAttempt.status === 'pending') jiraAttempt.status = 'cancelled';
      } else if (jiraAttempt.status === 'pending' && ++jiraAttempt.reads >= 2 && mode !== 'tools-waiting') {
        if (mode === 'tools-mismatch') Object.assign(jiraAttempt, { status: 'failed', failure_reason: 'account_mismatch' });
        else { jiraAttempt.status = 'complete'; jiraLinked = true; }
      }
      const { attempt, expires_at, status, failure_reason } = jiraAttempt;
      return json({ schema_version: 1, attempt, expires_at, status, failure_reason });
    }
    if (method === 'POST' && path === '/v1/person/tools/jira/disconnect') {
      jiraLinked = false;
      return json({ schema_version: 1, connected: false });
    }
    // Confluence follows the same person-scoped browser lifecycle as Jira.
    if (method === 'POST' && path === '/v1/person/tools/confluence/connect') {
      if (JSON.stringify(body) !== '{"schema_version":1}') return failure('invalid_request', 400);
      confluenceAttempt = { attempt: randomUUID(), expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), status: 'pending', failure_reason: null, reads: 0 };
      return json({ schema_version: 1, attempt: confluenceAttempt.attempt, connect_link: CONFLUENCE_CONNECT_LINK, expires_at: confluenceAttempt.expires_at });
    }
    if (method === 'POST' && (path === '/v1/person/tools/confluence/status' || path === '/v1/person/tools/confluence/cancel')) {
      if (!confluenceAttempt || body?.attempt !== confluenceAttempt.attempt) return failure('not_found', 404);
      if (path.endsWith('/cancel')) {
        if (confluenceAttempt.status === 'pending') confluenceAttempt.status = 'cancelled';
      } else if (confluenceAttempt.status === 'pending' && ++confluenceAttempt.reads >= 2) {
        confluenceAttempt.status = 'complete'; confluenceLinked = true;
      }
      const { attempt, expires_at, status, failure_reason } = confluenceAttempt;
      return json({ schema_version: 1, attempt, expires_at, status, failure_reason });
    }
    if (method === 'POST' && path === '/v1/person/tools/confluence/disconnect') {
      confluenceLinked = false;
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
      // While it is on its way the client has set the session aside: status reads signed out.
      if (mode.startsWith('signout-slow')) await new Promise(resolveLater => setTimeout(resolveLater, 1_500));
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
      // The archived read is independent of the active list. It must not
      // advance fixtures that model a change in the active membership view.
      if (status === 'active') projectLists += 1;
      const demoted = (index: number) => status === 'active' && mode === 'role-changes' && projectLists > 1 && index === 0 ? { role: 'member' } : {};
      return json({ schema_version: 2, kind: 'echo-project-list-v2', items: page.map((project, index) => ({
        schema_version: 2, kind: 'echo-project-summary-v2', project_id: project.project_id, name: project.name, created_at: NOW,
        // Lists can be stale; People reads the current role separately.
        role: project.role, status, ...demoted(index),
      })), next_cursor: paged && from + 10 < all.length ? (from === 0 ? 'cGFnZTI' : 'cGFnZTM') : null });
    }
    const projectV2 = /^\/v2\/person\/projects\/(prj_[0-9a-f-]+)$/.exec(path);
    if (method === 'GET' && projectV2) {
      const known = listed().find(project => project.project_id === projectV2[1]);
      const role = roleOf(projectV2[1]!, session.membership_id);
      if (!known || !role) return failure('not_found', 404);
      // A direct read observes the same role transition as the active list.
      const currentRole = mode === 'role-changes' && projectLists > 1 && known.project_id === desktop.projects[0]?.project_id ? 'member' : role;
      return json({ schema_version: 2, kind: 'echo-project-summary-v2', project_id: known.project_id, name: known.name, created_at: NOW,
        role: currentRole, status: projectStatus.get(known.project_id) ?? 'active' });
    }
    // Mine, or one project's page: the desktop never lists all you may read.
    if (method === 'POST' && path === '/v1/person/list') {
      const api = await contract();
      let request: ReturnType<Contract['validatePersonListRequestV1']>;
      try {
        request = api.validatePersonListRequestV1(body);
      } catch {
        return failure('invalid_request', 400);
      }
      lists += 1;
      if (request.mine === undefined && request.project_id === undefined) return failure('invalid_request', 400);
      const projectId = request.project_id;
      const project = projectId === undefined ? undefined : joined().find(entry => entry.project_id === projectId);
      // A project you are not in is refused as ask --project refuses it.
      if (projectId !== undefined && (!project || mode === 'feed-unauthorized')) return failure('unauthorized', 401);
      // The same account, whose access changed: Mine is refused.
      if (request.mine && mode === 'mine-unauthorized') return failure('unauthorized', 401);
      if (request.mine) mineLists += 1;
      // Opened, then More: the read after a save, or the More, never comes back; Mine's first read fails once.
      if ((mode === 'long-feed-refresh-fails' && lists === 3) || (mode === 'long-feed-more-fails' && lists === 2) ||
          (mode === 'mine-fails-once' && request.mine && mineLists === 1)) return failure('unavailable', 503);
      const key = request.mine ? 'mine' : `project/${projectId}`;
      const from = pageFrom(key, request.cursor);
      if (from === null) return failure('invalid_request', 400);
      // Mine's second read comes while meetings wait to be indexed: they are held, with the notice.
      const held = mode === 'mine-meetings-held' && request.mine === true && mineLists === 2;
      const all = rows(request.mine ? { mine: true } : { project_id: projectId! }).filter(row => !held || row.kind !== 'meeting');
      return json(api.validatePersonListResponseV1({
        schema_version: 1, kind: 'echo-person-list-v1', scope: request.mine ? { kind: 'mine' } : { kind: 'project', project_id: projectId },
        ...(project && request.cursor === undefined ? { project: {
          project_id: project.project_id, name: project.name, role: roleOf(project.project_id, session.membership_id) ?? project.role,
          status: projectStatus.get(project.project_id) ?? 'active',
        } } : {}),
        items: all.slice(from, from + LIST_PAGE), next_cursor: from + LIST_PAGE < all.length ? pageCursor(key, from + LIST_PAGE) : null,
        ...(held ? { notice: 'meetings_unavailable' } : {}),
      }));
    }
    // One item by its ref, under your access: anything you cannot read is one not_found.
    if (method === 'POST' && path === '/v1/person/open') {
      const api = await contract();
      let request: ReturnType<Contract['validatePersonOpenRequestV1']>;
      try {
        request = api.validatePersonOpenRequestV1(body);
      } catch {
        return failure('invalid_request', 400);
      }
      const at = request.ref.indexOf(':');
      const [kind, id] = [request.ref.slice(0, at), request.ref.slice(at + 1)];
      const open = (fields: Record<string, unknown>) => json(api.validatePersonOpenResponseV1({ schema_version: 1, kind: 'echo-person-open-v1', ref: request.ref, ...fields }));
      if (kind === 'note' && catalog.has(id)) {
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
      const meeting = kind === 'meeting' ? meetings.find(entry => entry.record_sha256 === id) : undefined;
      if (meeting) {
        const parts = atomParts(meeting);
        const from = pageFrom(request.ref, request.cursor);
        if (from === null || (from > 0 && from >= parts.length)) return failure('not_found', 404);
        // At most 25 parts, and at least one, within the atoms' byte budget.
        let to = from;
        while (to < parts.length && to - from < OPEN_ATOMS && (to === from || Buffer.byteLength(JSON.stringify(parts.slice(from, to + 1))) <= OPEN_ATOMS_BYTES)) to += 1;
        return open({
          item: meetingRow(meeting),
          ...(request.cursor === undefined ? { meeting: {
            started_at: meeting.started_at, timezone: meeting.timezone, all_day: false, participants: meeting.participants, participants_more: false,
            approved_by: meeting.approved_by,
          } } : {}),
          atoms: parts.slice(from, to), next_cursor: to < parts.length ? pageCursor(request.ref, to) : null,
        });
      }
      return failure('not_found', 404);
    }
    if (method === 'POST' && path === '/v2/person/projects/context/search') {
      if (mode === 'search-fails') return failure('unauthorized', 401);
      const response = fixture('projects-search');
      response.schema_version = 2; response.kind = 'echo-project-context-search-result-v2';
      response.project_id = body?.project_id;
      response.items = (response.items as { title: string; excerpt: string }[])
        .filter(item => found(body?.query, item))
        .map(item => ({ ...item, audience: { kind: 'project', project_id: body?.project_id } }));
      return json(response);
    }
    // All context: saved notes, each version searched and read on its own.
    if (method === 'POST' && (path === '/v3/person/updates/search' || path === '/v2/person/updates/search')) {
      if (mode === 'search-fails') return failure('unavailable', 503);
      if (path.startsWith('/v2/')) {
        const response = fixture('updates-search-v2');
        response.results = (response.results as { title: string; excerpt: string }[]).filter(item => found(body?.query, item));
        return json(response);
      }
      const results = desktop.notes.filter(note => found(body?.query, note)).map(({ text, ...note }) => ({ ...note, excerpt: excerpt(text) }));
      return json({ schema_version: 3, kind: 'echo-person-upload-search-v3', results });
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
      jiraMappingWrites += 1;
      if (mode === 'jira-project-slow') while (!existsSync(join(home, 'release-jira-setting'))) await new Promise(resolveLater => setTimeout(resolveLater, 25));
      if ((mode === 'jira-project-conflict' && jiraMappingWrites === 1) || body?.expected_revision !== current.revision) return failure('conflict', 409);
      const value = { revision: randomUUID(), mapping: body?.jira_project === null ? null : { cloud_id: JIRA_CLOUD, project_id: '10000', project_key: String(body?.jira_project) } };
      jiraMappings.set(projectId, value);
      if (mode === 'jira-project-reply-lost' && jiraMappingWrites === 1) return failure('unavailable', 503);
      return json({ schema_version: 1, project_id: projectId, ...value });
    }
    if (method === 'POST' && path === '/v1/person/tools/confluence/spaces/list') {
      if (mode === 'confluence-spaces-unavailable') return failure('unavailable', 503);
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
      confluenceMappingWrites += 1;
      if ((mode === 'confluence-project-conflict' && confluenceMappingWrites === 1) || body?.expected_revision !== current.revision) return failure('conflict', 409);
      const space_ids = body?.space_ids;
      if (space_ids !== null && (!Array.isArray(space_ids) || space_ids.length < 1 || space_ids.length > 20 || !space_ids.every(id => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id)))) return failure('invalid_request', 400);
      const value = { revision: randomUUID(), mapping: space_ids === null ? null : { cloud_id: CONFLUENCE_CLOUD, space_ids } };
      confluenceMappings.set(projectId, value);
      if (mode === 'confluence-project-reply-lost' && confluenceMappingWrites === 1) return failure('unavailable', 503);
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
        // A slow Refresh: the list as it was when asked, answered a second after a change arrived.
        if (mode === 'owner-write-lost-slow-list' && ++employeeLists === 2) {
          for (let waited = 0; employeeWrites === 0 && waited < 10_000; waited += 50) await new Promise(resolveLater => setTimeout(resolveLater, 50));
          await new Promise(resolveLater => setTimeout(resolveLater, 1_000));
        }
        return json({ schema_version: 1, kind: 'echo-clean-person-employee-roster-v1', employees: listed });
      }
      employeeWrites += 1;
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
      // Made, but the first reply is lost on its way back.
      if (mode.startsWith('owner-write-lost') && employeeWrites === 1) return failure('unavailable', 503);
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return json({ login_grant: randomBytes(32).toString('base64url'), expires_at: '2026-09-28T22:01:00.000Z' }, method === 'POST' ? 201 : 200);
    }
    if (method === 'POST' && path === '/v1/person/projects/members') {
      const projectId = String(body?.project_id);
      if (!roleOf(projectId, session.membership_id)) return failure('not_found', 404);
      const all = (members[projectId] ?? []).map(entry => ({ membership_id: entry.membership_id, display_name: nameOf(entry.membership_id), role: entry.role }));
      return json({ schema_version: 1, kind: 'echo-project-members-v1', project_id: projectId, ...paged(all, body?.cursor) });
    }
    if (method === 'POST' && path === '/v1/person/projects/directory') {
      const projectId = String(body?.project_id);
      if (roleOf(projectId, session.membership_id) !== 'lead') return failure('not_found', 404);
      const all = desktop.people.filter(person => body?.query === undefined || found(body.query, { title: person.display_name }));
      return json({ schema_version: 1, kind: 'echo-project-directory-v1', project_id: projectId, ...paged(all, body?.cursor) });
    }
    // Everyone in your organization, for any member and with no project (ADR-0016). An
    // Authority from before it has no such route: not_found, as any unknown path.
    if (method === 'POST' && path === '/v1/person/directory' && mode !== 'no-person-directory') {
      const api = await contract();
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
      const all = desktop.people.filter(person => request.query === undefined || found(request.query, { title: person.display_name }));
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
        if (!roleOf(projectId, session.membership_id) || !catalog.has(contextId)) return failure('not_found', 404);
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
          'content-type': stored.detected_media_type, 'x-echo-document-sha256': sha(stored.original),
        } });
      }
      return json(documentMetadata(stored));
    }
    const link = /^\/v1\/person\/documents\/(doc_[0-9a-f]{64})\/(associate|dissociate)$/.exec(path);
    if (method === 'POST' && link) {
      const projectId = String(body?.project_id);
      return change(path, body, () => {
        const stored = findDocument(link[1]!, null);
        if (!stored || !roleOf(projectId, session.membership_id)) return failure('not_found', 404);
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
      if (mode === 'write-unavailable-then-refused') return failure('invalid_request', 400);
      const refused = refusedProjects(body);
      if (refused) return refused;
      // In the mine modes each save is its own note, of Ari's own, filed where the save said.
      const mine = MINE_MODES.has(mode);
      const receipt = {
        schema_version: 3, kind: 'echo-person-update-receipt-v3', request_id: body?.request_id,
        context_id: mine ? `ctx_${createHash('sha256').update(String(body?.request_id)).digest('hex')}` : 'ctx_' + 'c'.repeat(64), received_at: NOW,
        audience: body?.audience, association_project_ids: body?.association_project_ids, state: 'received',
      };
      writeFileSync(join(home, `saved-${String(body?.request_id)}.json`), JSON.stringify(receipt));
      if (mine) {
        catalog.set(receipt.context_id, { received_at: NOW, title: String(body?.title), text: String(body?.text), audience: body?.audience as Record<string, unknown> });
        for (const projectId of (body?.association_project_ids ?? []) as string[]) {
          filed.set(projectId, [...(filed.get(projectId) ?? []).filter(id => id !== receipt.context_id), receipt.context_id]);
        }
        mineNotes.add(receipt.context_id);
      }
      // A long feed files what is saved into it, newest, readable by whom the save said.
      if (mode.startsWith('long-feed')) {
        for (const projectId of (body?.association_project_ids ?? []) as string[]) {
          catalog.set(receipt.context_id, { received_at: NOW, title: String(body?.title), text: String(body?.title),
            audience: (body?.audience ?? { kind: 'project', project_id: projectId }) as Record<string, unknown> });
          filed.set(projectId, [...(filed.get(projectId) ?? []).filter(id => id !== receipt.context_id), receipt.context_id]);
        }
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
    if (method === 'POST' && (path === '/v3/person/ask' || path === '/v4/person/ask' || path === '/v5/person/ask')) {
      // Older accepted servers and unconfigured live connectors must not
      // prevent Mine from reading the ordinary retained-context Ask route.
      if (path !== '/v3/person/ask') {
        if (mode === 'mine-live-missing') return failure('not_found', 404);
        if (mode === 'mine-live-unavailable') return failure('unavailable', 503);
      }
      let request: ReturnType<Contract['validatePersonAnswerRequestV3']>;
      try {
        request = (await contract()).validatePersonAnswerRequestV3(body);
      } catch {
        return failure('invalid_request', 400);
      }
      asks += 1;
      if (mode === 'ask-unavailable') return failure('unavailable', 503);
      if (mode === 'ask-hangs') return new Promise<Response>(() => undefined);
      // One project, only what you added, or all you may read.
      const scope = request.project_id !== undefined ? { kind: 'project', project_id: request.project_id } : request.mine ? { kind: 'mine' } : { kind: 'global' };
      const question = request.question;
      const tickets = path === '/v4/person/ask';
      const live = path === '/v5/person/ask';
      const answer = { ...desktop.answer, ...(live ? { schema_version: 6, kind: 'echo-clean-person-answer-v6' } : tickets ? { schema_version: 5, kind: 'echo-clean-person-answer-v5' } : {}) };
      if (mode === 'ask-ticket') {
        const included = (tickets || live) && (scope.kind === 'global' || (scope.kind === 'project' && jiraMappings.get(scope.project_id!)?.mapping != null));
        return json({ ...answer, scope, outcome: included ? 'answered' : 'not_found',
          citations: included ? [{ kind: 'ticket', label: 'ECHO-7 · Jira launch', visibility: 'only_me', citation: {
            kind: 'ticket', tool_id: 'jira', external_scope_id: JIRA_CLOUD, ticket_id: '10007',
            permalink: 'https://example.atlassian.net/browse/ECHO-7', text_sha256: sha('ECHO-7: Jira launch'),
          } }] : [],
          parts: [{ question, status: included ? 'answered' : 'not_found', statements: included
            ? [{ text: 'ECHO-7 is titled Jira launch.', citation_indexes: [0], private: true }]
            : [], ...(included ? {} : { gap: 'No accessible Jira ticket was found.' }) }],
        });
      }
      const pageTool = mode === 'ask-confluence' ? 'confluence' : mode.startsWith('ask-page-') ? mode.slice(9) : undefined;
      if (pageTool !== undefined) {
        const included = live && (scope.kind === 'global' || (pageTool === 'confluence' && scope.kind === 'project' && confluenceMappings.get(scope.project_id!)?.mapping != null));
        return json({ ...answer, scope, outcome: included ? 'answered' : 'not_found',
          citations: included ? [{ kind: 'page', label: 'EVT readiness · ECHO product', visibility: 'only_me', citation: {
            kind: 'page', tool_id: pageTool, external_scope_id: CONFLUENCE_CLOUD, page_id: '12345', section_id: 'evt-readiness', version: '7',
            permalink: pageTool === 'confluence' ? 'https://example.atlassian.net/wiki/pages/viewpage.action?pageId=12345' : `https://${pageTool}.example.test/pages/12345?view=current`, text_sha256: sha('EVT readiness'),
          } }] : [],
          parts: [{ question, status: included ? 'answered' : 'not_found', statements: included
            ? [{ text: 'The Confluence EVT readiness page is current.', citation_indexes: [0], private: true }]
            : [], ...(included ? {} : { gap: 'No accessible Confluence page was found.' }) }],
        });
      }
      // The Agentic Ask answer: one part, the question itself, citing the fixture's two sources.
      const answered = (text?: string) => {
        const [part] = desktop.answer.parts as { statements: Record<string, unknown>[] }[];
        const statements = text === undefined ? part!.statements : [{ ...part!.statements[0], text }];
        return json({ ...answer, scope, parts: [{ ...part, question, statements }] });
      };
      if (mode === 'ask-slack') {
        const [part] = desktop.answer.parts as { statements: Record<string, unknown>[] }[];
        return json({ ...answer, scope,
          citations: [...desktop.answer.citations as unknown[], {
            kind: 'slack_message', label: '#launch · Maya', visibility: 'only_me', citation: {
              kind: 'slack_message', team_id: 'T01ABCDEF', channel_id: 'C01ABCDEF', message_ts: '1758873600.000100',
              permalink: 'https://acme.slack.com/archives/C01ABCDEF/p1758873600000100?thread_ts=1758873600.000100',
              text_sha256: sha('The launch is ready.'),
            },
          }],
          parts: [{ ...part, question, statements: [...part!.statements,
            { text: 'Maya confirmed the launch in Slack.', citation_indexes: [2], private: true }] }],
        });
      }
      // One file cited through two passages: one source, with both passages in its pane.
      if (mode === 'ask-passages') {
        const [record, passage] = desktop.answer.citations as { label: string; citation: Record<string, unknown> }[];
        const label = 'Apollo-launch-plan-v2.md';
        const first = { ...passage!, label, citation: { ...passage!.citation, label } };
        const second = { ...first, citation: { ...first.citation, anchor_sha256: sha('second passage') } };
        return json({ ...answer, scope, citations: [record, first, second],
          parts: [{ question, status: 'answered', statements: [
            { text: 'We agreed to ship Apollo with annual plans first.', citation_indexes: [0, 1], private: false },
            { text: 'Monthly plans follow the launch.', citation_indexes: [2], private: false },
          ] }] });
      }
      // Follow-ups: the second answer comes late, and the third question fails.
      if (mode === 'ask-follow-ups' && asks === 2) {
        // The test releases the reply after cancellation. A fixed delay races
        // the UI on slower Linux runners and can answer before Cancel is clicked.
        while (!existsSync(join(home, 'release-follow-up'))) {
          await new Promise(resolveLater => setTimeout(resolveLater, 25));
        }
        return answered('A late answer.');
      }
      if (mode === 'ask-follow-ups' && asks === 3) return failure('unavailable', 503);
      // Nothing in any project matches: the Authority's not-found answer, which
      // cites nothing. A question about another subject is off scope.
      if (mode === 'ask-project-empty' && scope.kind === 'project') {
        const offScope = question.startsWith('What is the weather');
        return json({
          schema_version: answer.schema_version, kind: answer.kind, scope, outcome: offScope ? 'off_scope' : 'not_found', citations: [],
          parts: [{ question, status: 'not_found', statements: [], gap: "I couldn't find this in the sources you can access." }],
        });
      }
      return answered();
    }
    if (method === 'POST' && path === '/v2/person/ask/source') {
      evidenceReads += 1;
      if (mode === 'evidence-fails-once' && evidenceReads === 1) return failure('unavailable', 503);
      const citation = body?.citation as Record<string, unknown>;
      // The second passage of ask-passages is markdown that starts with its file name, as real evidence can.
      const text = mode === 'long-evidence' ? 'x'.repeat(3_000)
        : citation?.anchor_sha256 === sha('second passage') ? 'Apollo-launch-plan-v2.md ## Pricing\n\n- **Monthly** plans follow the launch.'
          : desktop.evidence_text;
      return json({
        schema_version: 1, kind: 'echo-person-source-evidence-v1', scope: body?.scope,
        citation: { ...citation, label: desktop.evidence_label }, text,
      });
    }
    // One approved record, by the digest an answer cited. A record the person
    // cannot read comes back as an empty list, as the Authority's does.
    if (method === 'GET' && path === '/v1/person/records' && url.searchParams.has('record_sha256')) {
      const { record_sha256: digest, approved_by: approver, brief } = desktop.record;
      if ([...url.searchParams.keys()].length !== 1) return failure('invalid_request', 400);
      if (url.searchParams.get('record_sha256') !== digest || mode === 'record-gone') {
        return json({ schema_version: 1, kind: 'echo-clean-person-record-list-v1', records: [] });
      }
      const event = { kind: 'approved', policy_id: 'organization-member-readable-person-v2', approved_snapshot: { approved_payload: { brief } } };
      return json({
        schema_version: 1, kind: 'echo-clean-person-record-list-v1',
        records: [{
          position: 1, approval_id: 'apr_fixture', record_sha256: digest, envelope: { record_sha256: digest, body: { event } },
          source_metadata: { record_approved_by: { display_name: approver } },
        }],
      });
    }
    return failure('not_found', 404);
  };

  return {
    dependencies: { fetch, now: () => clock, open_authorization_url: openAuthorizationUrl },
    now: () => Date.parse(clock),
  };
}
