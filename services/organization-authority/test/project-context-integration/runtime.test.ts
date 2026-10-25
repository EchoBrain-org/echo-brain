import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startOrganizationAuthorityApiRuntime } from '../../src/composition/organization-authority-api-runtime.js';
import { ownerGenesis, port, signInInProcess, syntheticOidcProvider } from '../fixtures/owner-session.js';
import { PersonSessionStore } from '../../../../src/product/person-client/session-store.js';
import { runPersonClientCli } from '../../../../src/product/person-client/composition.js';

const oidc = {
  issuer: 'https://issuer.example', client_id: 'pc06-client',
  redirect_uri: 'https://authority.example/v2/session/oidc/callback',
  tenant: { kind: 'issuer' as const }, id_token_algorithms: ['RS256'],
};

it('uses default API composition and real Person session checks through CLI, including restart and revoked-session denial', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc06-real-runtime-')));
  chmodSync(root, 0o700);
  let runtime: Awaited<ReturnType<typeof startOrganizationAuthorityApiRuntime>> | undefined;
  try {
    const owner = ownerGenesis({ root, oidc, email: 'owner@example.test', authority_url: 'https://authority.example', revision: 'pc06-disposable-runtime-test' });
    const { initialized, pkce: key } = owner;
    const provider = syntheticOidcProvider(oidc, () => 'owner@example.test');
    const session = await signInInProcess(owner, oidc, provider);
    const config = { state_directory: initialized.state_directory, host: '127.0.0.1' as const, port: await port(),
      authority_url: 'https://authority.example', oidc, client_authentication: { method: 'none' as const }, pkce_sealing_key: key };
    // No project_context injection: this must exercise PC-03's real factory.
    runtime = await startOrganizationAuthorityApiRuntime(config, { oidc_provider: provider });
    const transcriptRead = await fetch(`http://127.0.0.1:${runtime.address.port}/v1/person/meeting-transcripts/read`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: 1,
        scope: { kind: 'global' },
        citation: {
          kind: 'approved_meeting_transcript', approval_id: 'apr_fixture',
          source_id: `source:${'a'.repeat(64)}`, revision_id: 'meeting-revision-1', source_sha256: `sha256:${'b'.repeat(64)}`,
        },
      }),
    });
    // No transcript is ever shared (ADR-0046), so its read has no route at all.
    expect(transcriptRead.status).toBe(404);
    const askWithoutModel = await fetch(`http://127.0.0.1:${runtime.address.port}/v3/person/ask`, {
      method: 'POST', headers: { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 3, question: 'What changed?' }),
    });
    expect(askWithoutModel.status).toBe(503);
    // The retired one-shot Ask has no route at all (ADR-0022).
    const retired = await fetch(`http://127.0.0.1:${runtime.address.port}/v2/person/ask`, {
      method: 'POST', headers: { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 2, question: 'What changed?' }),
    });
    expect(retired.status).toBe(404);
    const home = join(root, 'person'); mkdirSync(home, { mode: 0o700 });
    new PersonSessionStore(home).install('https://authority.example', initialized.authority_id, session);
    const cli = async (argv: string[]) => {
      let stdout = ''; let stderr = '';
      const code = await runPersonClientCli(argv, { home_directory: home,
        fetch: (input, init) => {
          const url = new URL(String(input));
          expect(url.origin).toBe('https://authority.example');
          return fetch(`http://127.0.0.1:${runtime!.address.port}${url.pathname}${url.search}`, init);
        }, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
      });
      return { code, stdout, stderr };
    };
    const created = await cli(['projects', 'create', '--request-id', randomUUID(), '--name', 'Synthetic Alpha']);
    expect(created.stderr).toBe(''); expect(created.code).toBe(0);
    const project = JSON.parse(created.stdout).project_id as string;
    const file = join(root, 'original.txt'); writeFileSync(file, 'PC06 original meridian.\n', { mode: 0o600 });
    const requestId = randomUUID();
    const submitted = await cli(['updates', 'submit-v3', '--request-id', requestId, '--title', 'Synthetic original', '--file', file,
      '--audience', 'project', '--audience-project-id', project, '--association-project-ids-json', JSON.stringify([project])]);
    expect(submitted.stderr).toBe(''); expect(submitted.code).toBe(0);
    const receipt = JSON.parse(submitted.stdout);
    await runtime.close();
    runtime = await startOrganizationAuthorityApiRuntime({ ...config, port: await port() }, { oidc_provider: provider });
    const read = await cli(['open', '--ref', `note:${receipt.context_id}`]);
    expect(read.stderr).toBe(''); expect(read.code).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({ ok: true, result: { text: 'PC06 original meridian.\n',
      item: { visibility: 'project', projects: [{ project_id: project, name: 'Synthetic Alpha' }] } } });
    const status = await cli(['updates', 'status-v3', '--request-id', requestId]);
    expect(status.code).toBe(0); expect(JSON.parse(status.stdout)).toMatchObject({ context_id: receipt.context_id, metadata: 'pending' });
    const logout = await cli(['logout']); expect(logout.code).toBe(0);
    const denied = await fetch(`http://127.0.0.1:${runtime.address.port}/v1/person/projects/${project}`, { headers: { authorization: `Bearer ${session.access_token}` } });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: { code: 'unauthorized', message: 'request failed' } });
  } finally {
    await runtime?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
