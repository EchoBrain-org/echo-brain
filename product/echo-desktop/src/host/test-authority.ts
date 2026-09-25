// Test hook only (compiled out of release bundles): a synthetic session and a
// fixture Authority behind the real person client, the same pattern as
// tests/fixtures/echo-projects-cli-bridge.mjs. Every request is logged to
// <home>/calls.jsonl so tests can assert what the app actually sent.
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  /** Everyone in the organization, as the project directory finds them. */
  people: { membership_id: string; display_name: string }[];
  /** Each project's members and their roles. */
  members: Record<string, { membership_id: string; role: 'lead' | 'member' }[]>;
  documents: StoredDocument[];
}

/** The one continuation the fixture hands out: the second page, from the eleventh item. */
const SECOND_PAGE = 'cGFnZTI';
const PAGE = 10;
const EXTRACTOR = 'fixture-extractor-v1';

interface Store {
  paths: { live: string; refreshing: string; refresh_claim: string };
  install(authority: string, authorityId: string, session: Record<string, string>): unknown;
}

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

export function installTestAuthority(home: string, fixturesDirectory: string, SessionStore: new (home: string) => unknown) {
  const repository = join(process.env.ECHO_PERSON_CLIENT_ENTRY!, '..', '..', '..', '..', '..');
  const operations = (JSON.parse(readFileSync(join(repository, 'tests/fixtures/project-context-v1/operations.json'), 'utf8')) as {
    operations: Operation[];
  }).operations;
  const desktop = JSON.parse(readFileSync(join(fixturesDirectory, 'desktop-v1.json'), 'utf8')) as DesktopFixtures;
  const mode = process.env.ECHO_DESKTOP_TEST_MODE ?? '';
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
  const members = structuredClone(desktop.members);
  // No longer a lead of the first project, though the list said so.
  if (mode === 'demoted') members[desktop.projects[0]!.project_id] = members[desktop.projects[0]!.project_id]!.map(entry => ({ ...entry, role: entry.role === 'lead' ? 'member' : 'lead' }));
  const documents = structuredClone(desktop.documents);
  const feedItem = fixture('projects-feed').items as Record<string, unknown>[];
  const readable = fixture('projects-read-context');
  const catalog = new Map<string, { received_at: string; title: string; text: string; audience: Record<string, unknown> }>([
    [String(feedItem[0]!.context_id), { received_at: String(feedItem[0]!.received_at), title: String(feedItem[0]!.title),
      // Readable by the members of whichever project it is read in.
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
  let writeAttempts = 0;
  let documentAttempts = 0;
  let evidenceReads = 0;
  let asks = 0;
  let projectLists = 0;
  let feedReads = 0;
  let documentLists = 0;
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
  const documentMetadata = (document: StoredDocument) => ({
    schema_version: 2, kind: 'echo-person-document-metadata-v2', request_id: document.request_id, filename: document.filename,
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
    // Made, but the reply is lost on its way back.
    if (mode === 'change-reply-lost' && changes === 1) return failure('unavailable', 503);
    return json(receipt, status);
  };
  /** A project keeps at least one lead. */
  const leadsAfter = (projectId: string, membershipId: string, role: 'lead' | 'member' | null) =>
    (members[projectId] ?? []).filter(entry => (entry.membership_id === membershipId ? role : entry.role) === 'lead').length;

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
    if (method === 'GET' && path === '/v3/person/tools') {
      return json({
        schema_version: 3, kind: 'echo-organization-person-tools', organization_id: session.organization_id, membership_id: session.membership_id,
        tools: [
          { tool_id: 'slack', display_name: 'Slack', availability: 'enabled', personal_status: 'linked',
            external_scope_id: 'T0123ABCD', external_subject_id: 'U0123ABCD' },
          { tool_id: 'granola', display_name: 'Granola', availability: 'unavailable', personal_status: 'unavailable',
            external_scope_id: null, external_subject_id: null },
        ],
      });
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
      const all = mode === 'many-projects'
        ? Array.from({ length: 13 }, (_, index) => ({
          project_id: `prj_${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`, name: `Project ${index + 1}`, role: 'member',
        }))
        : projects;
      const second = url.searchParams.get('cursor') === 'cGFnZTI';
      const page = mode === 'many-projects' ? (second ? all.slice(10) : all.slice(0, 10)) : all;
      projectLists += 1;
      // A lead made a member since the first list.
      const demoted = (index: number) => mode === 'role-changes' && projectLists > 1 && index === 0 ? { role: 'member' } : {};
      response.items = page.map((project, index) => ({ ...(fixture('projects-read')), ...project, ...demoted(index) }));
      response.next_cursor = mode === 'many-projects' && !second ? 'cGFnZTI' : null;
      return json(response);
    }
    if (method === 'POST' && path === '/v2/person/projects/context/feed' && mode === 'feed-unauthorized') {
      return failure('unauthorized', 401);
    }
    if (method === 'POST' && path === '/v2/person/projects/context/feed') {
      feedReads += 1;
      // Opened, then More: the read after a save never comes back.
      if (mode === 'long-feed-refresh-fails' && feedReads === 3) return failure('unavailable', 503);
      const projectId = String(body?.project_id);
      const notes = (filed.get(projectId) ?? []).map(id => ({ id, note: catalog.get(id)! }))
        .sort((a, b) => Date.parse(b.note.received_at) - Date.parse(a.note.received_at))
        .map(({ id, note }) => ({
          context_id: id, received_at: note.received_at, title: note.title, excerpt: excerpt(note.text),
          audience: note.audience.kind === 'projects' ? { kind: 'projects', project_ids: [projectId] } : note.audience,
        }));
      return json({ schema_version: 2, kind: 'echo-project-context-feed-v2', project_id: projectId, ...paged(notes, body?.cursor) });
    }
    if (method === 'POST' && path === '/v2/person/projects/context/search') {
      if (mode === 'search-fails') return failure('unauthorized', 401);
      const response = fixture('projects-search');
      response.schema_version = 2; response.kind = 'echo-project-context-search-result-v2';
      response.project_id = body?.project_id;
      response.items = (response.items as { title: string; excerpt: string }[])
        .filter(item => found(body?.query, item))
        .map(item => ({ ...item, audience: { kind: 'projects', project_ids: [body?.project_id] } }));
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
    const note = /^\/v3\/person\/updates\/content\/(ctx_[0-9a-f]{64})$/.exec(path);
    if (method === 'GET' && note) {
      const saved = desktop.notes.find(entry => entry.context_id === note[1]);
      if (!saved) return failure('not_found', 404);
      return json({ schema_version: 3, kind: 'echo-person-upload-content-v3', ...saved });
    }
    const olderNote = /^\/v2\/person\/updates\/content\/(ctx_[0-9a-f]{64})$/.exec(path);
    if (method === 'GET' && olderNote) {
      const saved = fixture('updates-read-v2');
      return saved.context_id === olderNote[1] ? json(saved) : failure('not_found', 404);
    }
    const context = /^\/v2\/person\/projects\/(prj_[0-9a-f-]+)\/context\/(ctx_[0-9a-f]+)$/.exec(path);
    if (method === 'GET' && context) {
      const note = catalog.get(context[2]!);
      if (!note || !filed.get(context[1]!)?.includes(context[2]!)) return failure('not_found', 404);
      return json({
        schema_version: 2, kind: 'echo-project-context-read-v2', project_id: context[1], context_id: context[2],
        received_at: note.received_at, title: note.title, text: note.text,
        audience: note.audience.kind === 'projects' ? { kind: 'projects', project_ids: [context[1]] } : note.audience,
      });
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
        members[projectId] = [{ membership_id: session.membership_id, role: 'lead' }];
        filed.set(projectId, []);
        return {
          schema_version: 1, kind: 'echo-project-create-receipt-v1', request_id: body?.request_id, project_id: projectId, created_at: NOW, state: 'created',
        };
      }, 201);
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

    // Documents: a project's, one read a page at a time, its original, and where it is filed.
    if (method === 'POST' && path === '/v2/person/documents/search') {
      documentLists += 1;
      if (mode === 'documents-fail-once' && documentLists === 1) return failure('unavailable', 503);
      const projectId = typeof body?.project_id === 'string' ? body.project_id : null;
      const all = documents
        .filter(document => (projectId === null || document.association_project_ids.includes(projectId)) &&
          (body?.query === '' || found(body?.query, { title: document.title, text: document.pages.flat().map(chunk => chunk.text).join(' ') })))
        .sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at))
        .map(document => ({ ...documentMetadata(document), excerpt: null, anchor: null }));
      const { items, next_cursor } = paged(all, body?.cursor);
      return json({ schema_version: 2, kind: 'echo-person-document-search-result-v2', documents: items, next_cursor });
    }
    const document = /^\/v2\/person\/documents\/(doc_[0-9a-f]{64})(\/text|\/original)?$/.exec(path);
    if (method === 'GET' && document) {
      const stored = findDocument(document[1]!, url.searchParams.get('project_id'));
      if (!stored) return failure('not_found', 404);
      if (document[2] === '/original') {
        return new Response(stored.original, { status: 200, headers: {
          'content-type': stored.detected_media_type, 'x-echo-document-sha256': sha(stored.original),
        } });
      }
      if (document[2] === '/text') {
        const at = url.searchParams.get('cursor') === SECOND_PAGE ? 1 : 0;
        return json({
          schema_version: 1, kind: 'echo-person-document-text-v1', document_id: stored.document_id, original_sha256: sha(stored.original),
          extractor: EXTRACTOR, extraction_state: stored.extraction_state, chunks: stored.pages[at] ?? [],
          next_cursor: at + 1 < stored.pages.length ? SECOND_PAGE : null,
        });
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
      const receipt = {
        schema_version: 3, kind: 'echo-person-update-receipt-v3', request_id: body?.request_id,
        context_id: 'ctx_' + 'c'.repeat(64), received_at: NOW, audience: body?.audience,
        association_project_ids: body?.association_project_ids, state: 'received',
      };
      writeFileSync(join(home, `saved-${String(body?.request_id)}.json`), JSON.stringify(receipt));
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
    if (method === 'POST' && path === '/v2/person/ask') {
      asks += 1;
      if (mode === 'ask-unavailable') return failure('unavailable', 503);
      if (mode === 'ask-hangs') return new Promise<Response>(() => undefined);
      const scope = typeof body?.project_id === 'string' ? { kind: 'project', project_id: body.project_id } : { kind: 'global' };
      // Follow-ups: the second answer comes late, and the third question fails.
      if (mode === 'ask-follow-ups' && asks === 2) {
        await new Promise(resolveLater => setTimeout(resolveLater, 1_500));
        return json({ ...desktop.answer, answer: 'A late answer.', scope });
      }
      if (mode === 'ask-follow-ups' && asks === 3) return failure('unavailable', 503);
      return json({ ...desktop.answer, scope });
    }
    if (method === 'POST' && path === '/v2/person/ask/source') {
      evidenceReads += 1;
      if (mode === 'evidence-fails-once' && evidenceReads === 1) return failure('unavailable', 503);
      return json({
        schema_version: 1, kind: 'echo-person-source-evidence-v1', scope: body?.scope,
        citation: { ...(body?.citation as Record<string, unknown>), label: desktop.evidence_label },
        text: mode === 'long-evidence' ? 'x'.repeat(3_000) : desktop.evidence_text,
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
