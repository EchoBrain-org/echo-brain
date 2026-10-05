import { asEnumerableRecord, assertDigest, assertExactKeys, assertPatternString, fail } from './validation.js';

/** A bounded section of a page read live under the asker's own provider grant. */
export interface PersonPageCitationV1 {
  readonly kind: 'page';
  readonly tool_id: string;
  readonly external_scope_id: string;
  /** Provider-stable page identity, never a title or URL. */
  readonly page_id: string;
  /** Provider-stable bounded section identity; inventories use `inventory`. */
  readonly section_id: string;
  /** Current provider version that produced this section. */
  readonly version: string;
  /** Display link only. The provider validates its own tenant and coordinates. */
  readonly permalink: string;
  readonly text_sha256: `sha256:${string}`;
}

export function validatePersonPageCitationV1(value: unknown): PersonPageCitationV1 {
  const record = asEnumerableRecord(value, 'Page citation');
  assertExactKeys(record, ['kind', 'tool_id', 'external_scope_id', 'page_id', 'section_id', 'version', 'permalink', 'text_sha256'], 'Page citation');
  if (record.kind !== 'page') fail('Page citation kind is invalid');
  assertPatternString(record.tool_id, 'tool_id', 64, /^[a-z][a-z0-9-]*$/);
  for (const field of ['external_scope_id', 'page_id', 'section_id', 'version'] as const) {
    assertPatternString(record[field], field, 256, /^[^\p{Cc}\p{Zl}\p{Zp}]+$/u);
    if (record[field] !== record[field].normalize('NFC')) fail(`Page citation ${field} is not normalized`);
  }
  assertPatternString(record.permalink, 'permalink', 2048, /^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]{1,5})?\/[^\s\\\p{Cc}]*$/u);
  const Url = (globalThis as unknown as { URL?: new (input: string) => { protocol: string; hostname: string; username: string; password: string; search: string; hash: string } }).URL;
  if (Url === undefined) fail('Page citation URL parser is unavailable');
  try {
    const url = new Url(record.permalink);
    // The provider validates its canonical page URL before construction. The
    // generic contract permits a bounded query because some providers use a
    // stable page-id query; it never accepts credentials or a fragment.
    if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '' || url.hash !== '') fail('Page citation permalink is invalid');
  } catch { fail('Page citation permalink is invalid'); }
  assertDigest(record.text_sha256, 'text_sha256');
  return Object.freeze({ kind: 'page', tool_id: record.tool_id, external_scope_id: record.external_scope_id as string, page_id: record.page_id as string, section_id: record.section_id as string, version: record.version as string, permalink: record.permalink, text_sha256: record.text_sha256 as `sha256:${string}` });
}
