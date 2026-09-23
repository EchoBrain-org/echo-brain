import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PersonAnswerRequestV2,
  PersonAnswerResponseV3,
  PersonAnswerCitationV3,
  PersonSourceEvidenceCitationV1,
  PersonSourceEvidenceReadRequestV1,
  PersonSourceEvidenceV1,
} from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonAnswerV2HttpApplication } from '../src/presentation/person-answer-v2-http-application.js';
import {
  createOrganizationAuthorityHttpServer,
  type OrganizationAuthorityHttpServerOptions,
} from '../src/presentation/organization-authority-http-server.js';

const project_id = 'prj_00000000-0000-4000-8000-000000000001';
function sha256(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function sourceId(character: string): `source:${string}` {
  return `source:${character.repeat(64)}`;
}

const approved = {
  kind: 'approved_record' as const,
  atom_id: sha256('a'),
  record_sha256: sha256('b'),
  policy_id: 'organization-member-readable-person-v2' as const,
} satisfies PersonAnswerCitationV3;
const source = {
  kind: 'source_revision' as const,
  source_id: sourceId('c'),
  revision_id: sha256('d'),
  source_sha256: sha256('e'),
  representation_sha256: sha256('f'),
  anchor_sha256: sha256('0'),
} satisfies PersonSourceEvidenceCitationV1;
const answer: PersonAnswerResponseV3 = {
  schema_version: 3,
  kind: 'echo-clean-person-answer-v3',
  answer: 'The approved decision is ready.\n\n- Review the MRD',
  scope: { kind: 'global' },
  citations: [approved],
};
const evidence: PersonSourceEvidenceV1 = {
  schema_version: 1,
  kind: 'echo-person-source-evidence-v1',
  scope: { kind: 'project', project_id },
  citation: { ...source, label: 'MRD' },
  text: 'MRD\n\nExact bounded source packet.',
};

const servers: ReturnType<typeof createOrganizationAuthorityHttpServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
});

function options(application: PersonAnswerV2HttpApplication): OrganizationAuthorityHttpServerOptions {
  return {
    descriptor: {} as never,
    sessions: {} as never,
    oidc_provider: {} as never,
    expected_issuer: 'https://issuer.example',
    person_answer_v2: application,
  };
}

async function start(application: PersonAnswerV2HttpApplication): Promise<string> {
  const server = createOrganizationAuthorityHttpServer(options(application));
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing address');
  return `http://127.0.0.1:${address.port}`;
}

function request(origin: string, path: string, body: unknown, authorization = 'Bearer fixture-token'): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function failure(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return expect(response.json()).resolves.toEqual({ error: { code, message: 'request failed' } });
}

describe('global/project Ask HTTP transport', () => {
  it('serializes global approved-record answers and preserves answer newlines', async () => {
    const calls: unknown[] = [];
    const origin = await start({
      ask(input) { calls.push(input); return Promise.resolve(answer); },
      readSource() { throw new Error('not reached'); },
    });
    const response = await request(origin, '/v2/person/ask', { schema_version: 2, question: 'What is ready?' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(JSON.stringify(answer));
    expect(calls).toEqual([{ access_token: 'fixture-token', request: { schema_version: 2, question: 'What is ready?' } }]);
  });

  it('serializes source evidence separately from its public citation fields', async () => {
    const calls: unknown[] = [];
    const origin = await start({
      ask() { throw new Error('not reached'); },
      readSource(input) { calls.push(input); return evidence; },
    });
    const body: PersonSourceEvidenceReadRequestV1 = {
      schema_version: 1,
      scope: { kind: 'project', project_id },
      citation: source,
    };
    const response = await request(origin, '/v2/person/ask/source', body);
    expect(response.status).toBe(200);
    const result = await response.json() as PersonSourceEvidenceV1;
    expect(result).toEqual(evidence);
    expect(result.citation).not.toHaveProperty('text');
    expect(result.text).toBe('MRD\n\nExact bounded source packet.');
    expect(calls).toEqual([{ access_token: 'fixture-token', request: body }]);
  });

  it('rejects invalid source fields and caller-controlled scope extensions before dispatch', async () => {
    let calls = 0;
    const origin = await start({
      ask() { calls += 1; return Promise.resolve(answer); },
      readSource() { calls += 1; return evidence; },
    });
    for (const body of [
      { schema_version: 2, question: 'What is ready?', scope: { kind: 'global' } },
      { schema_version: 2, question: 'What is ready?', project_id: 'not-a-project' },
      { schema_version: 1, scope: { kind: 'project', project_id }, citation: { ...source, anchor_sha256: `sha256:${'A'.repeat(64)}` } },
      { schema_version: 1, scope: { kind: 'global' }, citation: { ...source, label: 'caller controlled' } },
    ]) {
      const path = (body as { schema_version: number }).schema_version === 2 ? '/v2/person/ask' : '/v2/person/ask/source';
      await failure(await request(origin, path, body), 400, 'invalid_request');
    }
    expect(calls).toBe(0);
  });

  it('maps authentication and rejected scope/coordinates without diagnostics', async () => {
    const origin = await start({
      ask(input: { readonly access_token: string; readonly request: PersonAnswerRequestV2 }) {
        if (input.access_token !== 'fixture-token') throw new AuthorityOperationError('unauthorized', 'private token diagnostic');
        if (input.request.project_id !== project_id) throw new AuthorityOperationError('unauthorized', 'private scope diagnostic');
        return Promise.resolve({ ...answer, scope: { kind: 'project' as const, project_id } });
      },
      readSource(input) {
        if (input.request.citation.anchor_sha256 !== source.anchor_sha256) {
          throw new AuthorityOperationError('unauthorized', 'private coordinate diagnostic');
        }
        return evidence;
      },
    });
    await failure(await request(origin, '/v2/person/ask', { schema_version: 2, question: 'What is ready?', project_id }, 'Bearer expired'), 401, 'unauthorized');
    await failure(await request(origin, '/v2/person/ask/source', { schema_version: 1, scope: { kind: 'project', project_id }, citation: { ...source, anchor_sha256: `sha256:${'1'.repeat(64)}` } }), 401, 'unauthorized');
  });
});
