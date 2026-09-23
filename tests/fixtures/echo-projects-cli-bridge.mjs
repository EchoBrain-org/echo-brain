// PC-05's offline Swift -> committed PC-04 CLI -> fake HTTP proof.
// All session values are synthetic and confined to the test's temporary home.
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPersonClientCli } from '../../src/product/person-client/dist/composition.js';
import { PersonSessionStore } from '../../src/product/person-client/dist/session-store.js';

const [mode, homePath, log, ...args] = process.argv.slice(2);
const home = realpathSync(homePath);
const fixtures = JSON.parse(readFileSync(new URL('./project-context-v1/operations.json', import.meta.url), 'utf8')).operations;
const failures = JSON.parse(readFileSync(new URL('./project-context-v1/invalid.json', import.meta.url), 'utf8')).errors;
const value = flag => args[args.indexOf(flag) + 1];
const session = new PersonSessionStore(home);
if (!existsSync(session.paths.live)) {
  session.install('https://authority.example', 'oau_00000000-0000-4000-8000-000000000001', {
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
appendFileSync(log, JSON.stringify({ args }) + '\n');
const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
process.exitCode = await runPersonClientCli(args.slice(1), {
  home_directory: home, now: () => '2026-09-21T22:01:00.000Z',
  fetch: async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    appendFileSync(join(home, 'http.jsonl'), JSON.stringify({ path: url.pathname, query: url.search, method: init?.method, body }) + '\n');
    const action = args[1] + '-' + args[2];
    const legacyAction = action
      .replace(/^(projects-(?:feed|search|read-context))-v2$/, '$1')
      .replace(/^updates-submit-v3$/, 'updates-submit-v2')
      .replace(/^updates-status-v3$/, 'updates-status-v2');
    const fixture = fixtures.find(entry => entry.id === action || entry.id === action + '-v2' || entry.id === legacyAction);
    if (!fixture || init?.method !== fixture.http.method || url.origin !== 'https://authority.example') throw new Error('Unexpected fixture request');
    const projectId = value('--project-id');
    const contextId = value('--context-id');
    const requestId = value('--request-id');
    const modernPath = action === 'projects-feed-v2' ? '/v2/person/projects/context/feed'
      : action === 'projects-search-v2' ? '/v2/person/projects/context/search'
      : action === 'projects-read-context-v2' ? `/v2/person/projects/${projectId}/context/${contextId}`
      : action === 'updates-submit-v3' ? '/v3/person/updates'
      : action === 'updates-status-v3' ? `/v3/person/updates/${requestId}`
      : undefined;
    if (modernPath !== undefined && url.pathname !== modernPath) throw new Error('Unexpected modern fixture route');
    if ((mode === 'cli-unsupported' && action === 'projects-list') || (mode === 'cli-inaccessible' && action === 'projects-read')) {
      const failure = failures.find(entry => entry.id === (mode === 'cli-unsupported' ? 'unavailable-project-capability' : 'individual-project-non-disclosure'));
      return json(failure.http, failure.http_status);
    }
    if (mode === 'cli-uncertain-mutation' && action === 'projects-member-set') {
      return json({ error: { code: 'unavailable', message: 'request failed' } }, 503);
    }
    let response = structuredClone(fixture.http.response);
    if (['projects-feed-v2', 'projects-search-v2', 'projects-read-context-v2'].includes(action)) {
      response.schema_version = 2;
      response.kind = action === 'projects-feed-v2' ? 'echo-project-context-feed-v2'
        : action === 'projects-search-v2' ? 'echo-project-context-search-result-v2' : 'echo-project-context-read-v2';
      const audience = { kind: 'projects', project_ids: [action === 'projects-read-context-v2' ? projectId : body.project_id] };
      if (Array.isArray(response.items)) response.items.forEach(item => { item.audience = audience; });
      else response.audience = audience;
    }
    if (mode.startsWith('cli-ui-') && action === 'projects-list') {
      response.items.push({ ...response.items[0], project_id: 'prj_44444444-4444-4444-8444-444444444444', name: 'Beacon' });
    }
    if (response.request_id) response.request_id = value('--request-id');
    if (action === 'updates-submit' || action === 'updates-submit-v3') {
      if (action === 'updates-submit-v3') {
        response = { schema_version: 3, kind: 'echo-person-update-receipt-v3', request_id: body.request_id,
          context_id: 'ctx_' + 'c'.repeat(64), received_at: '2026-09-21T22:01:00.000Z',
          audience: body.audience, association_project_ids: body.association_project_ids, state: 'received' };
      } else { response.audience = body.audience; response.project_id = body.project_id; }
      writeFileSync(join(home, 'saved.json'), JSON.stringify(response));
      if (mode === 'cli-ui-upload-unknown') {
        const attempts = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.args[1] === 'updates' && ['submit', 'submit-v3'].includes(x.args[2]));
        return json({ error: { code: attempts.length === 1 ? 'unavailable' : 'conflict', message: 'request failed' } }, attempts.length === 1 ? 503 : 409);
      }
    }
    if ((action === 'updates-status' || action === 'updates-status-v3') && existsSync(join(home, 'saved.json'))) {
      response = { ...JSON.parse(readFileSync(join(home, 'saved.json'), 'utf8')),
        schema_version: action === 'updates-status-v3' ? 3 : 2,
        kind: action === 'updates-status-v3' ? 'echo-person-update-status-v3' : 'echo-person-update-status-v2', status: 'stored', metadata: 'ready' };
      delete response.state;
    }
    return json(response, fixture.http.status);
  },
});
