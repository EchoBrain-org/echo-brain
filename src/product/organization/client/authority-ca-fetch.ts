import { request as httpsRequest } from 'node:https';

const MAX_CA_FETCH_RESPONSE_BYTES = 64 * 1024;

function responseMustNotHaveBody(
  requestMethod: string | undefined,
  status: number,
): boolean {
  return (
    requestMethod?.toUpperCase() === 'HEAD' ||
    status === 204 ||
    status === 205 ||
    status === 304
  );
}

/**
 * Narrow fetch implementation for the organization client. It trusts the
 * supplied organization CA in addition to Node's normal roots while retaining
 * hostname verification and TLS certificate validation.
 */
export function createOrganizationAuthorityCaFetch(
  authorityCaPem: string,
): typeof fetch {
  return async (input, init = {}) => {
    const url =
      input instanceof URL
        ? input
        : typeof input === 'string'
          ? new URL(input)
          : new URL(input.url);
    const method =
      init.method ?? (input instanceof Request ? input.method : undefined);
    if (url.protocol !== 'https:') {
      throw new Error('organization authority CA transport requires HTTPS');
    }
    const body = init.body;
    if (
      body !== undefined &&
      body !== null &&
      typeof body !== 'string' &&
      !(body instanceof Uint8Array)
    ) {
      throw new Error('organization authority request body is unsupported');
    }
    return await new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          method,
          headers: Object.fromEntries(new Headers(init.headers).entries()),
          ca: authorityCaPem,
          rejectUnauthorized: true,
          signal: init.signal ?? undefined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > MAX_CA_FETCH_RESPONSE_BYTES) {
              response.destroy(
                new Error('organization authority response exceeds limit'),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.once('error', reject);
          response.once('end', () => {
            try {
              const headers = new Headers();
              for (const [name, value] of Object.entries(response.headers)) {
                if (Array.isArray(value)) {
                  for (const item of value) headers.append(name, item);
                } else if (value !== undefined) {
                  headers.set(name, value);
                }
              }
              const status = response.statusCode ?? 500;
              const responseBody = Buffer.concat(chunks);
              const mustNotHaveBody = responseMustNotHaveBody(method, status);
              if (mustNotHaveBody && responseBody.byteLength !== 0) {
                throw new Error(
                  'organization authority returned a body for a bodyless response',
                );
              }
              const fetchedResponse = new Response(
                mustNotHaveBody ? null : responseBody,
                {
                  status,
                  statusText: response.statusMessage,
                  headers,
                },
              );
              Object.defineProperty(fetchedResponse, 'url', {
                configurable: true,
                enumerable: true,
                value: url.href,
              });
              resolve(fetchedResponse);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.once('error', reject);
      if (body === undefined || body === null) request.end();
      else request.end(body);
    });
  };
}
