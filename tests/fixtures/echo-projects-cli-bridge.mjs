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
    const fixture = fixtures.find(entry => entry.id === action || entry.id === action + '-v2');
    if (!fixture || init?.method !== fixture.http.method || url.origin !== 'https://authority.example') throw new Error('Unexpected fixture request');
    if ((mode === 'cli-unsupported' && action === 'projects-list') || (mode === 'cli-inaccessible' && action === 'projects-read')) {
      const failure = failures.find(entry => entry.id === (mode === 'cli-unsupported' ? 'unavailable-project-capability' : 'individual-project-non-disclosure'));
      return json(failure.http, failure.http_status);
    }
    if (mode === 'cli-uncertain-mutation' && action === 'projects-member-set') {
      return json({ error: { code: 'unavailable', message: 'request failed' } }, 503);
    }
    let response = structuredClone(fixture.http.response);
    if (mode.startsWith('cli-ui-') && action === 'projects-list') {
      response.items.push({ ...response.items[0], project_id: 'prj_44444444-4444-4444-8444-444444444444', name: 'Beacon' });
    }
    if (response.request_id) response.request_id = value('--request-id');
    if (action === 'updates-submit') {
      response.audience = body.audience; response.project_id = body.project_id;
      writeFileSync(join(home, 'saved.json'), JSON.stringify(response));
      if (mode === 'cli-ui-upload-unknown') {
        const attempts = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.args[1] === 'updates' && x.args[2] === 'submit');
        return json({ error: { code: attempts.length === 1 ? 'unavailable' : 'conflict', message: 'request failed' } }, attempts.length === 1 ? 503 : 409);
      }
    }
    if (action === 'updates-status' && existsSync(join(home, 'saved.json'))) {
      response = { ...JSON.parse(readFileSync(join(home, 'saved.json'), 'utf8')), kind: 'echo-person-update-status-v2', status: 'stored', metadata: 'ready' };
      delete response.state;
    }
    return json(response, fixture.http.status);
  },
});
