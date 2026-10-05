import {
  validatePersonToolAttemptStatusV1, validatePersonToolAttemptV1, validatePersonToolCommandV1,
  validatePersonToolConnectV1, validatePersonToolStateV1,
} from '@echo-brain/organization-api';
import type { ProviderHttpApplicationV1, ProviderHttpRequestV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

type Command = { readonly access_token: string; readonly signal?: AbortSignal };
export interface PersonConnectionHttpPortV1 {
  connect(input: Command): Promise<unknown>;
  status(input: Command & { readonly attempt: string }): Promise<unknown>;
  cancel(input: Command & { readonly attempt: string }): Promise<unknown>;
  disconnect(input: Command): Promise<unknown>;
}

export function personConnectionTokenV1(request: ProviderHttpRequestV1): string {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ') || header.length === 7) {
    throw new AuthorityOperationError('unauthorized', 'person authentication failed');
  }
  return header.slice(7);
}
export function personConnectionJsonV1(request: ProviderHttpRequestV1, displayName: string): unknown {
  if (request.content_type === undefined || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.content_type)) {
    throw new AuthorityOperationError('invalid_request', `${displayName} connection request is invalid`);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.raw_body)) as unknown; }
  catch { throw new AuthorityOperationError('invalid_request', `${displayName} connection request is invalid`); }
}
export function personConnectionCommandV1(request: ProviderHttpRequestV1, displayName: string): void {
  try { validatePersonToolCommandV1(personConnectionJsonV1(request, displayName), displayName); }
  catch { throw new AuthorityOperationError('invalid_request', `${displayName} connection request is invalid`); }
}

/** Four fixed connection verbs; project and source routes remain owned by their provider. */
export function createPersonConnectionHttpApplicationV1(
  connection: PersonConnectionHttpPortV1,
  provider: Readonly<{ id: string; display_name: string }>,
): ProviderHttpApplicationV1 {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider.id)) throw new Error('Person connection tool id is invalid');
  const { id, display_name: displayName } = provider;
  return Object.freeze({
    routes: Object.freeze(['connect', 'status', 'cancel', 'disconnect'].map(verb => Object.freeze({
      route_id: `${id}-${verb}`, method: 'POST' as const, path: `/v1/person/tools/${id}/${verb}`,
    }))),
    async accept(request: ProviderHttpRequestV1) {
      const access_token = personConnectionTokenV1(request);
      const input = { access_token, ...(request.signal === undefined ? {} : { signal: request.signal }) };
      switch (request.route_id) {
        case `${id}-connect`: {
          personConnectionCommandV1(request, displayName);
          return Object.freeze({ status: 201 as const, body: validatePersonToolConnectV1(await connection.connect(input), displayName) });
        }
        case `${id}-status`:
        case `${id}-cancel`: {
          let attempt: string;
          try { attempt = validatePersonToolAttemptV1(personConnectionJsonV1(request, displayName), displayName).attempt; }
          catch { throw new AuthorityOperationError('invalid_request', `${displayName} connection request is invalid`); }
          const result = validatePersonToolAttemptStatusV1(await (request.route_id === `${id}-status`
            ? connection.status({ ...input, attempt }) : connection.cancel({ ...input, attempt })), displayName);
          if (result.attempt !== attempt) throw new AuthorityOperationError('invalid_output', `${displayName} connection response is invalid`);
          return Object.freeze({ status: 200 as const, body: result });
        }
        case `${id}-disconnect`: {
          personConnectionCommandV1(request, displayName);
          return Object.freeze({ status: 200 as const, body: validatePersonToolStateV1(await connection.disconnect(input), false, displayName) });
        }
        default: throw new AuthorityOperationError('not_found', `${displayName} connection route is unavailable`);
      }
    },
  });
}
