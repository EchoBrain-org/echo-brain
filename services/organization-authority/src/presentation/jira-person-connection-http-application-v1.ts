import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonTicketLiveApplicationV1 } from '../application/ports/person-ticket-live-runtime-v1.js';

export const PERSON_JIRA_CONNECT_PATH_V1 = '/v1/person/jira/connect';
export const PERSON_JIRA_COMPLETE_PATH_V1 = '/v1/person/jira/complete';
export const PERSON_JIRA_DISCONNECT_PATH_V1 = '/v1/person/jira/disconnect';

export type JiraPersonConnectionHttpApplicationV1 = Pick<PersonTicketLiveApplicationV1, 'connect' | 'complete' | 'disconnect'>;

function body(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || (value as Record<string, unknown>).schema_version !== 1) {
    throw new AuthorityOperationError('invalid_request', 'Jira connection request is invalid');
  }
  return value as Record<string, unknown>;
}
export function validateJiraPersonConnectionCommandV1(value: unknown): { readonly schema_version: 1 } {
  body(value, ['schema_version']); return Object.freeze({ schema_version: 1 });
}
export function validateJiraPersonConnectionCompletionV1(value: unknown): { readonly schema_version: 1; readonly attempt: string; readonly connection?: string } {
  const data = body(value, ['schema_version', 'attempt', 'connection']);
  if (typeof data.attempt !== 'string' || !/^[a-z0-9-]{36}$/.test(data.attempt) || (data.connection !== undefined && (typeof data.connection !== 'string' || data.connection.length === 0 || data.connection.length > 512 || /[\p{Cc}\p{Cf}]/u.test(data.connection)))) {
    throw new AuthorityOperationError('invalid_request', 'Jira connection request is invalid');
  }
  return Object.freeze({ schema_version: 1, attempt: data.attempt, ...(data.connection === undefined ? {} : { connection: data.connection as string }) });
}
