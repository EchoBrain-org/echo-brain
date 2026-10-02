import { asEnumerableRecord, assertDigest, assertExactKeys, assertPatternString, fail } from './validation.js';

/** A live ticket citation. Admission to Ask requires a later answer/evidence schema; V4 is unchanged. */
export interface PersonTicketCitationV1 {
  readonly kind: 'ticket';
  readonly tool_id: string;
  readonly external_scope_id: string;
  readonly ticket_id: string;
  readonly permalink: string;
  /** Digest of the exact bounded text released, not a provider revision identifier. */
  readonly text_sha256: `sha256:${string}`;
}

export function validatePersonTicketCitationV1(value: unknown): PersonTicketCitationV1 {
  const r = asEnumerableRecord(value, 'Ticket citation');
  assertExactKeys(r, ['kind', 'tool_id', 'external_scope_id', 'ticket_id', 'permalink', 'text_sha256'], 'Ticket citation');
  if (r.kind !== 'ticket') fail('Ticket citation kind is invalid');
  assertPatternString(r.tool_id, 'tool_id', 64, /^[a-z][a-z0-9-]*$/);
  for (const field of ['external_scope_id', 'ticket_id'] as const) {
    assertPatternString(r[field], field, 256, /^[^\p{Cc}\p{Zl}\p{Zp}]+$/u);
    if (r[field] !== r[field].normalize('NFC')) fail(`Ticket citation ${field} is not normalized`);
  }
  // This validates a display link, never a fetch target. The provider must
  // additionally validate its tenant host and ticket coordinates.
  assertPatternString(r.permalink, 'permalink', 2048, /^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]{1,5})?\/[^\s\\\p{Cc}]*$/u);
  const Url = (globalThis as unknown as { URL?: new (input: string) => { protocol: string; hostname: string; username: string; password: string; search: string; hash: string } }).URL;
  if (Url === undefined) fail('Ticket citation URL parser is unavailable');
  try {
    const url = new Url(r.permalink);
    if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') fail('Ticket citation permalink is invalid');
  } catch { fail('Ticket citation permalink is invalid'); }
  assertDigest(r.text_sha256, 'text_sha256');
  return Object.freeze({ kind: 'ticket', tool_id: r.tool_id, external_scope_id: r.external_scope_id as string, ticket_id: r.ticket_id as string, permalink: r.permalink, text_sha256: r.text_sha256 as `sha256:${string}` });
}
