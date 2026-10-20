import { asEnumerableRecord, assertCitationPermalink, assertDigest, assertExactKeys, assertPatternString, assertToolId, fail } from './validation.js';

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
  assertToolId(record.tool_id);
  for (const field of ['external_scope_id', 'page_id', 'section_id', 'version'] as const) {
    assertPatternString(record[field], field, 256, /^[^\p{Cc}\p{Zl}\p{Zp}]+$/u);
    if (record[field] !== record[field].normalize('NFC')) fail(`Page citation ${field} is not normalized`);
  }
  // The provider validates its canonical page URL before construction; some providers' stable page link carries a query.
  assertCitationPermalink(record.permalink, 'Page citation', { query: true });
  assertDigest(record.text_sha256, 'text_sha256');
  return Object.freeze({ kind: 'page', tool_id: record.tool_id, external_scope_id: record.external_scope_id as string, page_id: record.page_id as string, section_id: record.section_id as string, version: record.version as string, permalink: record.permalink, text_sha256: record.text_sha256 as `sha256:${string}` });
}
