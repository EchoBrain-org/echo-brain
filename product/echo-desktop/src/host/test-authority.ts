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
}

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
const MINE_MODES = new Set(['mine', 'owner-mine', 'mine-empty', 'mine-fails-once', 'mine-meetings-held', 'mine-unauthorized']);
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
    if (address === JIRA_CONNECT_LINK) return true;
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

  // Your connections to the organization's tools, as Tools changes them.
  let slackLinked = true;
  let jiraLinked = false;
  let jiraAttempt: { attempt: string; expires_at: string; status: string; failure_reason: string | null; reads: number } | null = null;

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
          { tool_id: 'granola', display_name: 'Granola', availability: 'unavailable', personal_status: 'unavailable',
            external_scope_id: null, external_subject_id: null, organization_setup: null },
        ],
      });
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

    if (method === 'GET' && path === '/v1/person/projects') {
      const response = fixture('projects-list');
      const all = listed();
      // Ten at a time in the modes with many: from the second page, then the third.
      const paged = LIST_PAGES.has(mode);
      const from = !paged ? 0 : url.searchParams.get('cursor') === 'cGFnZTM' ? 20 : url.searchParams.get('cursor') === 'cGFnZTI' ? 10 : 0;
      const page = paged ? all.slice(from, from + 10) : all;
      projectLists += 1;
      // A lead made a member since the first list.
      const demoted = (index: number) => mode === 'role-changes' && projectLists > 1 && index === 0 ? { role: 'member' } : {};
      response.items = page.map((project, index) => ({ ...(fixture('projects-read')), ...project, ...demoted(index) }));
      response.next_cursor = paged && from + 10 < all.length ? (from === 0 ? 'cGFnZTI' : 'cGFnZTM') : null;
      return json(response);
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

    // A project: your role in it, its members, and the people a lead can add.
    const project = /^\/v1\/person\/projects\/(prj_[0-9a-f-]+)$/.exec(path);
    if (method === 'GET' && project) {
      const known = projects.find(entry => entry.project_id === project[1]);
      const role = roleOf(project[1]!, session.membership_id);
      if (!known || !role) return failure('not_found', 404);
      return json({ ...fixture('projects-read'), project_id: known.project_id, name: known.name, role });
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
    if (method === 'POST' && path === '/v3/person/ask') {
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
      // The Agentic Ask answer: one part, the question itself, citing the fixture's two sources.
      const answered = (text?: string) => {
        const [part] = desktop.answer.parts as { statements: Record<string, unknown>[] }[];
        const statements = text === undefined ? part!.statements : [{ ...part!.statements[0], text }];
        return json({ ...desktop.answer, scope, parts: [{ ...part, question, statements }] });
      };
      if (mode === 'ask-slack') {
        const [part] = desktop.answer.parts as { statements: Record<string, unknown>[] }[];
        return json({ ...desktop.answer, scope,
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
        return json({ ...desktop.answer, scope, citations: [record, first, second],
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
          schema_version: 4, kind: 'echo-clean-person-answer-v4', scope, outcome: offScope ? 'off_scope' : 'not_found', citations: [],
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
