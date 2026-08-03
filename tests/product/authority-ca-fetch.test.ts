import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrganizationInternalLiveUpdateReceipt } from '@echo-brain/organization-api';

const mockedHttps = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('node:https', () => ({ request: mockedHttps.request }));

import { createOrganizationAuthorityCaFetch } from '../../src/product/organization/client/authority-ca-fetch.js';
import { HttpOrganizationAuthorityClient } from '../../src/product/organization/client/http-organization-authority-client.js';
import {
  NOW,
  ORGANIZATION_IDS,
  protocolInstallationKey,
  TestAuthority,
  TestInstallationSigner,
} from '../support/local-organization-fixtures.js';

interface ObservedRequest {
  body: string | Uint8Array | undefined;
  options: RequestOptions | undefined;
  url: URL | undefined;
}

function queueHttpsResponse(input: {
  status: number;
  statusMessage?: string;
  headers?: IncomingMessage['headers'];
  chunks?: readonly Uint8Array[];
}): ObservedRequest {
  const observed: ObservedRequest = {
    body: undefined,
    options: undefined,
    url: undefined,
  };
  mockedHttps.request.mockImplementationOnce(
    (
      url: URL,
      options: RequestOptions,
      onResponse: (response: IncomingMessage) => void,
    ) => {
      observed.url = url;
      observed.options = options;
      const request = Object.assign(new EventEmitter(), {
        end: vi.fn((body?: string | Uint8Array) => {
          observed.body = body;
          const response = Object.assign(new EventEmitter(), {
            destroy: vi.fn(),
            headers: input.headers ?? {},
            statusCode: input.status,
            statusMessage: input.statusMessage ?? '',
          }) as unknown as IncomingMessage;
          onResponse(response);
          for (const chunk of input.chunks ?? []) {
            response.emit('data', Buffer.from(chunk));
          }
          response.emit('end');
        }),
      }) as unknown as ClientRequest;
      return request;
    },
  );
  return observed;
}

beforeEach(() => {
  mockedHttps.request.mockReset();
});

describe('organization authority CA fetch', () => {
  it('accepts the live receipt POST 204 without constructing a forbidden body', async () => {
    const authority = new TestAuthority();
    const signer = new TestInstallationSigner();
    const signingKey = protocolInstallationKey(signer);
    const receipt = await createOrganizationInternalLiveUpdateReceipt(
      {
        transaction_id: 'upd_00000000-0000-4000-8000-000000000001',
        authority_id: ORGANIZATION_IDS.authority,
        authority_key_id: authority.descriptor.signing_key.key_id,
        organization_id: ORGANIZATION_IDS.organization,
        enrollment_id: ORGANIZATION_IDS.enrollment,
        installation_id: ORGANIZATION_IDS.installation,
        directive_sequence: 3,
        release_version: '0.1.0-internal.4',
        manifest_sha256: 'a'.repeat(64),
        artifact_sha256: 'b'.repeat(64),
        source_sha: 'c'.repeat(40),
        outcome: 'healthy',
        doctor: { ok: true, passed: 11, total: 11 },
        failure: null,
        finished_at: NOW,
        installation_signing_key: signingKey,
      },
      (bytes) =>
        signer.sign(
          ORGANIZATION_IDS.installation,
          bytes,
          signingKey.key_id,
        ),
    );
    const observed = queueHttpsResponse({
      status: 204,
      statusMessage: 'No Content',
      headers: { 'content-length': '0', 'x-authority': 'echo' },
    });
    const client = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      authorityCaPem: 'test organization CA',
    });

    await expect(
      client.recordInternalLiveUpdateReceipt(receipt),
    ).resolves.toBeUndefined();
    expect(observed.url?.href).toBe(
      'https://authority.example/v1/internal-live/receipts',
    );
    expect(observed.options?.method).toBe('POST');
    expect(observed.options?.ca).toBe('test organization CA');
    expect(JSON.parse(String(observed.body))).toEqual(receipt);
  });

  it.each([204, 205, 304])(
    'returns a null body for HTTP %i while preserving response metadata',
    async (status) => {
      queueHttpsResponse({
        status,
        statusMessage: 'No Body',
        headers: { 'x-authority': 'echo' },
      });
      const fetchImpl = createOrganizationAuthorityCaFetch('test CA');

      const response = await fetchImpl('https://authority.example/status');

      expect(response.status).toBe(status);
      expect(response.statusText).toBe('No Body');
      expect(response.headers.get('x-authority')).toBe('echo');
      expect(response.url).toBe('https://authority.example/status');
      expect(response.body).toBeNull();
    },
  );

  it('rejects a non-empty body on a bodyless response through the fetch promise', async () => {
    queueHttpsResponse({
      status: 204,
      chunks: [Buffer.from('unexpected', 'utf8')],
    });
    const fetchImpl = createOrganizationAuthorityCaFetch('test CA');

    await expect(
      fetchImpl('https://authority.example/status'),
    ).rejects.toThrow(
      'organization authority returned a body for a bodyless response',
    );
  });

  it('returns a null body for HEAD and retains bodies for ordinary responses', async () => {
    const headObserved = queueHttpsResponse({ status: 200 });
    const fetchImpl = createOrganizationAuthorityCaFetch('test CA');

    const headResponse = await fetchImpl(
      new Request('https://authority.example/status', { method: 'HEAD' }),
    );

    expect(headObserved.options?.method).toBe('HEAD');
    expect(headResponse.body).toBeNull();

    queueHttpsResponse({
      status: 200,
      chunks: [Buffer.from('healthy', 'utf8')],
    });
    const getResponse = await fetchImpl('https://authority.example/status');
    expect(await getResponse.text()).toBe('healthy');
  });
});
