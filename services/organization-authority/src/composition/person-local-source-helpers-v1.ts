import { PROJECT_PAGE_MAX_ITEMS } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { EvidenceDeskRevalidationModeV1 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v1';
import { PERSON_QUERY_FUNCTION_WORDS_V1 } from '../adapters/persistence/sqlite/person-original-context-retrieval-v1.js';

/**
 * What ECHO's own Ask sources share: follow-ups (ADR-0040) and the asker's projects, people and tools (research tool
 * contract v1) refuse alike, size pages alike, match whole words and page with request-owned cursors.
 */

export function evidenceInvalidV1(message: string): never { throw new AuthorityOperationError('invalid_request', message); }
export function evidenceNotFoundV1(): never { throw new AuthorityOperationError('not_found', 'Evidence item is not available in this request'); }

/** A call's page: at most `maximum` items, and a limit outside 1 to 50 is refused. */
export function evidencePageSizeV1(limit: number | undefined, maximum: number): number {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) evidenceInvalidV1('Evidence limit is invalid');
  return Math.min(limit ?? maximum, maximum);
}

/** A search's words: whole Unicode terms, lower case, without function words unless written as an acronym. */
export function evidenceTermsV1(text: string): readonly string[] {
  const terms = new Set<string>();
  for (const run of text.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []) {
    const term = run.toLowerCase();
    if (!PERSON_QUERY_FUNCTION_WORDS_V1.has(term) || /^[A-Z]{2,}$/u.test(run)) terms.add(term);
  }
  return [...terms];
}

/** Every whole word of ECHO-held text, lower case: what a search's terms match. */
export function evidenceWordsV1(values: readonly (string | null | undefined)[]): ReadonlySet<string> {
  return new Set(values.flatMap(value => (value ?? '').normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []));
}

/** Every page of one of the project application's lists, at its largest page size. */
export function everyProjectPageV1<T>(read: (paging: { readonly limit: number; readonly cursor?: string }) => { readonly items: readonly T[]; readonly next_cursor: string | null }, signal?: AbortSignal): T[] {
  const all: T[] = [];
  for (let cursor: string | undefined; ;) {
    signal?.throwIfAborted();
    const page = read({ limit: PROJECT_PAGE_MAX_ITEMS, ...(cursor === undefined ? {} : { cursor }) });
    all.push(...page.items);
    if (page.next_cursor === null) return all;
    cursor = page.next_cursor;
  }
}

/** Newest first, then by id: the order a source that knows when its items were created lists them in. */
export function newestFirstV1<T extends { readonly created_at: string }>(idOf: (value: T) => string): (left: T, right: T) => number {
  return (left, right) => {
    if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1;
    const [one, other] = [idOf(left), idOf(right)];
    return one < other ? -1 : one > other ? 1 : 0;
  };
}

/** What one source released in a request, and what it released since its last successful check (ADR-0038). */
export function createReleaseLedgerV1<T>() {
  const released = new Map<string, T>();
  const unchecked = new Set<string>();
  return Object.freeze({
    /** A release of `id`; `merge` keeps what its earlier releases carried. */
    record(id: string, merge: (previous: T | undefined) => T): void { released.set(id, merge(released.get(id))); unchecked.add(id); },
    get(id: string): T | undefined { return released.get(id); },
    /** What a check rereads: what was released since the last successful check (`incremental`), or all of it; `checked` once it passes. */
    due(mode: EvidenceDeskRevalidationModeV1 | undefined): { readonly ids: readonly string[]; readonly checked: () => void } {
      const ids = [...(mode === 'incremental' ? unchecked : released.keys())];
      return Object.freeze({ ids, checked: () => { for (const id of ids) unchecked.delete(id); } });
    },
  });
}

/** One request's list cursors: each continues only the selection it was issued for, after the row its page ended on. */
export function createEvidenceCursorsV1<T>() {
  const saved = new Map<string, { readonly selection: string; readonly after: T }>();
  let sequence = 0;
  return Object.freeze({
    after(cursor: string, selection: string): T {
      const value = saved.get(cursor);
      if (value === undefined || value.selection !== selection) evidenceInvalidV1('Evidence list cursor is invalid');
      return value.after;
    },
    next(prefix: string, selection: string, after: T): string {
      const cursor = `${prefix}_${++sequence}`;
      saved.set(cursor, Object.freeze({ selection, after }));
      return cursor;
    },
  });
}
