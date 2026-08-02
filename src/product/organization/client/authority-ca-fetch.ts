import { request as httpsRequest } from 'node:https';

const MAX_CA_FETCH_RESPONSE_BYTES = 64 * 1024;

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
          method: init.method,
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
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) {
                for (const item of value) headers.append(name, item);
              } else if (value !== undefined) {
                headers.set(name, value);
              }
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode ?? 500,
                statusText: response.statusMessage,
                headers,
              }),
            );
          });
        },
      );
      request.once('error', reject);
      if (body === undefined || body === null) request.end();
      else request.end(body);
    });
  };
}
