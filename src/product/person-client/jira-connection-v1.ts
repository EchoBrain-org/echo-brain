/** These commands name an attempt or opaque locator, never an ECHO person or tenant. */
export interface PersonJiraConnectV1 {
  readonly schema_version: 1;
  readonly attempt: string;
  readonly connect_link: string;
}
export interface PersonJiraConnectionStateV1 {
  readonly schema_version: 1;
  readonly connected: boolean;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw new Error('Jira connection response is invalid');
  const fields = value as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || !('value' in descriptor)) throw new Error('Jira connection response is invalid');
  }
  if (fields.schema_version !== 1) throw new Error('Jira connection version is invalid');
  return fields;
}

export function validatePersonJiraCompletionV1(value: unknown): { readonly schema_version: 1; readonly attempt: string; readonly connection?: string } {
  const hasConnection = typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, 'connection');
  const fields = record(value, ['schema_version', 'attempt', ...(hasConnection ? ['connection'] : [])]);
  if (typeof fields.attempt !== 'string' || !/^[a-z0-9-]{36}$/.test(fields.attempt) ||
      (hasConnection && (typeof fields.connection !== 'string' || fields.connection.length === 0 || fields.connection.length > 512 ||
      /[\p{Cc}\p{Cf}]/u.test(fields.connection)))) throw new Error('Jira connection coordinates are invalid');
  return Object.freeze({ schema_version: 1, attempt: fields.attempt, ...(hasConnection ? { connection: fields.connection as string } : {}) });
}

export function validatePersonJiraConnectV1(value: unknown): PersonJiraConnectV1 {
  const fields = record(value, ['schema_version', 'attempt', 'connect_link']);
  if (typeof fields.attempt !== 'string' || !/^[a-z0-9-]{36}$/.test(fields.attempt) ||
      typeof fields.connect_link !== 'string' || fields.connect_link.length > 4096 || /[\s\\\p{Cc}]/u.test(fields.connect_link)) throw new Error('Jira connect response is invalid');
  const link = new URL(fields.connect_link);
  if (link.protocol !== 'https:' || link.username !== '' || link.password !== '' || link.hash !== '') throw new Error('Jira connect link is invalid');
  // This short-lived consent link is returned for this invocation only. It is
  // never placed in the session store, diagnostics, or a persistent history.
  return Object.freeze({ schema_version: 1, attempt: fields.attempt, connect_link: fields.connect_link });
}

export function validatePersonJiraStateV1(value: unknown, connected: boolean): PersonJiraConnectionStateV1 {
  const fields = record(value, ['schema_version', 'connected']);
  if (fields.connected !== connected) throw new Error('Jira connection state is invalid');
  return Object.freeze({ schema_version: 1, connected });
}
