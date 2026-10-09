import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PersonSourceEvidenceCitationV1,
  PersonSourceEvidenceReadRequestV1,
  PersonSourceEvidenceV1,
  PersonMeetingTranscriptReadRequestV1,
  PersonMeetingTranscriptV1,
} from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonMeetingTranscriptHttpApplicationV1, PersonSourceEvidenceHttpApplicationV1 } from '../src/presentation/person-source-evidence-http-application.js';
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
const transcriptCitation = {
  kind: 'approved_meeting_transcript' as const,
  approval_id: 'apr_fixture', source_id: sourceId('9'), revision_id: 'meeting-revision-1', source_sha256: sha256('8'),
};
const transcript: PersonMeetingTranscriptV1 = {
  schema_version: 1, kind: 'echo-person-meeting-transcript-v1', scope: { kind: 'global' },
  citation: transcriptCitation, text: 'Approved transcript page.', next_offset: null,
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

function options(application: PersonSourceEvidenceHttpApplicationV1 | undefined, transcriptApplication?: PersonMeetingTranscriptHttpApplicationV1): OrganizationAuthorityHttpServerOptions {
  return {
    descriptor: {} as never,
    sessions: {} as never,
    oidc_provider: {} as never,
    expected_issuer: 'https://issuer.example',
    ...(application === undefined ? {} : { person_source_evidence: application }),
    ...(transcriptApplication === undefined ? {} : { person_meeting_transcript: transcriptApplication }),
  };
}

async function start(application: PersonSourceEvidenceHttpApplicationV1 | undefined, transcriptApplication?: PersonMeetingTranscriptHttpApplicationV1): Promise<string> {
  const server = createOrganizationAuthorityHttpServer(options(application, transcriptApplication));
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

describe('cited original and transcript HTTP transport', () => {
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

  it('validates and dispatches the explicit transcript endpoint separately from source reads', async () => {
    const calls: unknown[] = [];
    const transcriptApp = { readTranscript(input: { readonly access_token: string; readonly request: PersonMeetingTranscriptReadRequestV1 }) { calls.push(input); return transcript; } } satisfies PersonMeetingTranscriptHttpApplicationV1;
    const origin = await start({ readSource() { throw new Error('not reached'); } }, transcriptApp);
    const body: PersonMeetingTranscriptReadRequestV1 = {
      schema_version: 1, scope: { kind: 'global' }, citation: transcriptCitation,
    };
    const response = await request(origin, '/v1/person/meeting-transcripts/read', body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(transcript);
    expect(calls).toEqual([{ access_token: 'fixture-token', request: body }]);
    await failure(await request(origin, '/v1/person/meeting-transcripts/read', { ...body, unknown: true }), 400, 'invalid_request');
  });

  it('answers source reads as unavailable when they are not composed, and keeps transcripts', async () => {
    const origin = await start(undefined, { readTranscript: () => transcript });
    const response = await request(origin, '/v1/person/meeting-transcripts/read', {
      schema_version: 1, scope: { kind: 'global' }, citation: transcriptCitation,
    });
    expect(response.status).toBe(200);
    await failure(await request(origin, '/v2/person/ask/source', { schema_version: 1, scope: { kind: 'global' }, citation: source }), 503, 'unavailable');
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
