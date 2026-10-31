import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PersonSourceEvidenceCitationV1,
  PersonSourceEvidenceReadRequestV1,
  PersonSourceEvidenceV1,
} from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonSourceEvidenceHttpApplicationV1 } from '../src/presentation/person-source-evidence-http-application.js';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import { authorityHttpServerOptions } from './fixtures/authority-http-server.js';

const project_id = 'prj_00000000-0000-4000-8000-000000000001';
function sha256(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function sourceId(character: string): `source:${string}` {
  return `source:${character.repeat(64)}`;
}

const source = {
  kind: 'source_revision' as const,
  source_id: sourceId('c'),
  revision_id: sha256('d'),
  source_sha256: sha256('e'),
  representation_sha256: sha256('f'),
  anchor_sha256: sha256('0'),
} satisfies PersonSourceEvidenceCitationV1;
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

async function start(application: PersonSourceEvidenceHttpApplicationV1): Promise<string> {
  const server = createOrganizationAuthorityHttpServer(authorityHttpServerOptions({ person_source_evidence: application }));
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

describe('cited original HTTP transport', () => {
  it('serializes source evidence separately from its public citation fields', async () => {
    const calls: unknown[] = [];
    const origin = await start({ readSource(input) { calls.push(input); return evidence; } });
    const body: PersonSourceEvidenceReadRequestV1 = {
      schema_version: 1,
      scope: { kind: 'project', project_id },
      citation: source,
    };
    // The path keeps its V2 name: installed clients open cited originals here.
    const response = await request(origin, '/v2/person/ask/source', body);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await response.json() as PersonSourceEvidenceV1;
    expect(result).toEqual(evidence);
    expect(calls).toEqual([{ access_token: 'fixture-token', request: body }]);
  });

  it('serves no transcript read: its retired path (ADR-0046) is no route', async () => {
    const origin = await start({ readSource() { throw new Error('not reached'); } });
    await failure(await request(origin, '/v1/person/meeting-transcripts/read', {
      schema_version: 1, scope: { kind: 'global' },
      citation: { kind: 'approved_meeting_transcript', approval_id: 'apr_fixture', source_id: sourceId('9'), revision_id: 'meeting-revision-1', source_sha256: sha256('8') },
    }), 404, 'not_found');
  });

  it('rejects invalid source fields and caller-controlled scope extensions before dispatch', async () => {
    let calls = 0;
    const origin = await start({ readSource() { calls += 1; return evidence; } });
    for (const body of [
      { schema_version: 1, scope: { kind: 'project', project_id }, citation: { ...source, anchor_sha256: `sha256:${'A'.repeat(64)}` } },
      { schema_version: 1, scope: { kind: 'global' }, citation: { ...source, label: 'caller controlled' } },
      { schema_version: 1, scope: { kind: 'global', extra: true }, citation: source },
    ]) {
      await failure(await request(origin, '/v2/person/ask/source', body), 400, 'invalid_request');
    }
    expect(calls).toBe(0);
  });

  it('maps rejected coordinates without diagnostics', async () => {
    const origin = await start({
      readSource(input) {
        if (input.access_token !== 'fixture-token') throw new AuthorityOperationError('unauthorized', 'private token diagnostic');
        if (input.request.citation.anchor_sha256 !== source.anchor_sha256) {
          throw new AuthorityOperationError('unauthorized', 'private coordinate diagnostic');
        }
        return evidence;
      },
    });
    await failure(await request(origin, '/v2/person/ask/source', { schema_version: 1, scope: { kind: 'project', project_id }, citation: source }, 'Bearer expired'), 401, 'unauthorized');
    await failure(await request(origin, '/v2/person/ask/source', { schema_version: 1, scope: { kind: 'project', project_id }, citation: { ...source, anchor_sha256: `sha256:${'1'.repeat(64)}` } }), 401, 'unauthorized');
  });
});
