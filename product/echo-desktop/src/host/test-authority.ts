// Test hook only (compiled out of release bundles): a synthetic session and a
// fixture Authority behind the real person client, the same pattern as
// tests/fixtures/echo-projects-cli-bridge.mjs. Every request is logged to
// <home>/calls.jsonl so tests can assert what the app actually sent.
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AUTHORITY = 'https://authority.example';
const IDENTITY_PROVIDER = 'https://accounts.example';
const NOW = '2026-09-21T22:01:00.000Z';
/** Past the access token's expiry, still inside the week. */
const LATER = '2026-09-21T22:30:00.000Z';

interface Operation { id: string; http: { method: string; status: number; response: Record<string, unknown> } }
interface Note { context_id: string; received_at: string; audience: Record<string, unknown>; title: string; text: string }
interface DesktopFixtures {
  projects: { project_id: string; name: string; role: 'lead' | 'member' }[];
  /** Saved V3 notes the person can read, for search. */
  notes: Note[];
  answer: Record<string, unknown>;
  evidence_text: string;
  evidence_label: string;
}

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
    membership_id: 'mem_22222222-2222-4222-8222-222222222222', display_name: 'Ari', membership_type: 'employee',
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
  let writeAttempts = 0;
  let documentAttempts = 0;
  let projectLists = 0;
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
    globalThis.fetch(handoff.url, { method: 'POST', body: form }).catch(() => undefined);
    return true;
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
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
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
      if (mode === 'signout-slow') await new Promise(resolveLater => setTimeout(resolveLater, 1_500));
      return new Response(null, { status: 204 });
    }

    if (method === 'GET' && path === '/v1/person/projects') {
      const response = fixture('projects-list');
      const all = mode === 'many-projects'
        ? Array.from({ length: 13 }, (_, index) => ({
          project_id: `prj_${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`, name: `Project ${index + 1}`, role: 'member',
        }))
        : desktop.projects;
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
      const response = fixture('projects-feed');
      response.schema_version = 2; response.kind = 'echo-project-context-feed-v2';
      response.project_id = body?.project_id;
      (response.items as Record<string, unknown>[]).forEach(item => { item.audience = { kind: 'projects', project_ids: [body?.project_id] }; });
      return json(response);
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
      const response = fixture('projects-read-context');
      response.schema_version = 2; response.kind = 'echo-project-context-read-v2';
      response.project_id = context[1];
      response.audience = { kind: 'projects', project_ids: [context[1]] };
      return json(response);
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
      if (mode === 'ask-unavailable') return failure('unavailable', 503);
      if (mode === 'ask-hangs') return new Promise<Response>(() => undefined);
      const scope = typeof body?.project_id === 'string' ? { kind: 'project', project_id: body.project_id } : { kind: 'global' };
      return json({ ...desktop.answer, scope });
    }
    if (method === 'POST' && path === '/v2/person/ask/source') {
      return json({
        schema_version: 1, kind: 'echo-person-source-evidence-v1', scope: body?.scope,
        citation: { ...(body?.citation as Record<string, unknown>), label: desktop.evidence_label },
        text: mode === 'long-evidence' ? 'x'.repeat(3_000) : desktop.evidence_text,
      });
    }
    return failure('not_found', 404);
  };

  return {
    dependencies: { fetch, now: () => clock, open_authorization_url: openAuthorizationUrl },
    now: () => Date.parse(clock),
  };
}
