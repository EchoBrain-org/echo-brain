import { asEnumerableRecord, assertCitationPermalink, assertDigest, assertExactKeys, assertPatternString, assertToolId, fail } from './validation.js';

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
  assertToolId(r.tool_id);
  for (const field of ['external_scope_id', 'ticket_id'] as const) {
    assertPatternString(r[field], field, 256, /^[^\p{Cc}\p{Zl}\p{Zp}]+$/u);
    if (r[field] !== r[field].normalize('NFC')) fail(`Ticket citation ${field} is not normalized`);
  }
  assertCitationPermalink(r.permalink, 'Ticket citation');
  assertDigest(r.text_sha256, 'text_sha256');
  return Object.freeze({ kind: 'ticket', tool_id: r.tool_id, external_scope_id: r.external_scope_id as string, ticket_id: r.ticket_id as string, permalink: r.permalink, text_sha256: r.text_sha256 as `sha256:${string}` });
}
