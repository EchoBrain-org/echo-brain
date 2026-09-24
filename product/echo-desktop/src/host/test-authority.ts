// Test hook only (compiled out of release bundles): a synthetic session and a
// fixture Authority behind the real person client, the same pattern as
// tests/fixtures/echo-projects-cli-bridge.mjs. Every request is logged to
// <home>/calls.jsonl so tests can assert what the app actually sent.
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const AUTHORITY = 'https://authority.example';
const NOW = '2026-09-21T22:01:00.000Z';

interface Operation { id: string; http: { method: string; status: number; response: Record<string, unknown> } }
interface DesktopFixtures {
  projects: { project_id: string; name: string; role: 'lead' | 'member' }[];
  answer: Record<string, unknown>;
  evidence_text: string;
  evidence_label: string;
}

interface Store {
  paths: { live: string };
  install(authority: string, authorityId: string, session: Record<string, string>): unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function failure(code: string, status: number): Response {
  return json({ error: { code, message: 'request failed' } }, status);
}

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
  if (!existsSync(store.paths.live) && mode !== 'signed-out') {
    store.install(AUTHORITY, 'oau_00000000-0000-4000-8000-000000000001', {
      organization_id: 'org_00000000-0000-4000-8000-000000000001',
      principal_id: 'prn_00000000-0000-4000-8000-000000000001',
      membership_id: 'mem_22222222-2222-4222-8222-222222222222', display_name: 'Ari', membership_type: 'employee',
      identity_binding_id: 'oib_00000000-0000-4000-8000-000000000001',
      session_family_id: 'psf_00000000-0000-4000-8000-000000000001',
      access_token: 'A'.repeat(43), refresh_token: 'R'.repeat(43),
      access_expires_at: '2026-09-21T22:11:00.000Z', refresh_expires_at: '2026-09-28T22:00:00.000Z',
      hard_reauthentication_at: '2026-09-28T22:00:00.000Z',
    });
  }

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    appendFileSync(join(home, 'calls.jsonl'), `${JSON.stringify({ method, path: url.pathname, query: url.search, body })}\n`);
    if (url.origin !== AUTHORITY) throw new Error('Unexpected authority');
    const path = url.pathname;

    if (method === 'GET' && path === '/v1/person/projects') {
      const response = fixture('projects-list');
      response.items = desktop.projects.map(project => ({ ...(fixture('projects-read')), ...project }));
      response.next_cursor = null;
      return json(response);
    }
    const read = /^\/v1\/person\/projects\/(prj_[0-9a-f-]+)$/.exec(path);
    if (method === 'GET' && read) {
      const project = desktop.projects.find(entry => entry.project_id === read[1]);
      return project ? json({ ...fixture('projects-read'), ...project }) : failure('not_found', 404);
    }
    if (method === 'POST' && path === '/v2/person/projects/context/feed') {
      const response = fixture('projects-feed');
      response.schema_version = 2; response.kind = 'echo-project-context-feed-v2';
      response.project_id = body?.project_id;
      (response.items as Record<string, unknown>[]).forEach(item => { item.audience = { kind: 'projects', project_ids: [body?.project_id] }; });
      return json(response);
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
      if (mode === 'write-unavailable') return failure('unavailable', 503);
      return json({
        schema_version: 3, kind: 'echo-person-update-receipt-v3', request_id: body?.request_id,
        context_id: 'ctx_' + 'c'.repeat(64), received_at: NOW, audience: body?.audience,
        association_project_ids: body?.association_project_ids, state: 'received',
      }, 202);
    }
    if (method === 'POST' && path === '/v2/person/ask') {
      if (mode === 'ask-unavailable') return failure('unavailable', 503);
      const scope = typeof body?.project_id === 'string' ? { kind: 'project', project_id: body.project_id } : { kind: 'global' };
      return json({ ...desktop.answer, scope });
    }
    if (method === 'POST' && path === '/v2/person/ask/source') {
      return json({
        schema_version: 1, kind: 'echo-person-source-evidence-v1', scope: body?.scope,
        citation: { ...(body?.citation as Record<string, unknown>), label: desktop.evidence_label }, text: desktop.evidence_text,
      });
    }
    return failure('not_found', 404);
  };

  return {
    dependencies: { fetch, now: () => NOW },
    now: () => Date.parse(NOW),
  };
}
