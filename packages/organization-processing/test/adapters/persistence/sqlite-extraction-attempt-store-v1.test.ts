import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openExtractionAttemptStoreV1,
  SqliteExtractionAttemptStoreV1,
} from '../../../src/adapters/persistence/sqlite-extraction-attempt-store-v1.js';
import type { ExtractionAttemptKeyV1 } from '../../../src/admitted-meeting-processing/extraction-attempt-store-v1.js';

const binding = {
  authority_id: 'aut_test-authority',
  organization_id: 'org_test-organization',
  state_lineage_id: 'lin_test-lineage',
};
const key: ExtractionAttemptKeyV1 = {
  admission_sha256: `sha256:${'a'.repeat(64)}`,
  review_lineage_id: `rli_${'b'.repeat(64)}`,
  review_input_sha256: `sha256:${'c'.repeat(64)}`,
};
const directories: string[] = [];
const stores: SqliteExtractionAttemptStoreV1[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'echo-extraction-attempt-'));
  directories.push(directory);
  const path = join(directory, 'extraction-attempts-v1.sqlite');
  const open = (identity = binding) => {
    const store = openExtractionAttemptStoreV1(path, identity);
    stores.push(store);
    return store;
  };
  return { path, open };
}
function claim(store: SqliteExtractionAttemptStoreV1, input = key) {
  const result = store.reserve(input);
  if (result.status !== 'reserved') throw new Error('expected one new extraction claim');
  return result;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('durable extraction attempt budget', () => {
  it('commits the claim before provider work and blocks another process or restart after interruption', () => {
    const { open } = fixture();
    const first = open();
    expect(claim(first).attempt).toBe(1);
    const second = open();
    expect(second.reserve(key)).toMatchObject({ status: 'blocked', attempt: 1, outcome: 'pending' });
    first.close();
    second.close();
    expect(open().reserve(key)).toMatchObject({ status: 'blocked', attempt: 1, outcome: 'pending' });
  });

  it.each(['permanently_rejected', 'rate_limited', 'invalid_output'] as const)(
    'retains %s across restart without automatic retries', (failure_code) => {
      const { open } = fixture();
      const store = open();
      const reserved = claim(store);
      store.complete({ key, ...reserved, outcome: 'failed', failure_code });
      store.close();
      const reopened = open();
      for (let cycle = 0; cycle < 5; cycle += 1) {
        expect(reopened.reserve(key)).toMatchObject({ status: 'blocked', attempt: 1, outcome: 'failed', failure_code });
      }
    },
  );

  it('retains success if the caller crashes before candidate persistence', () => {
    const { open } = fixture();
    const store = open();
    store.complete({ key, ...claim(store), outcome: 'succeeded' });
    store.close();
    expect(open().reserve(key)).toMatchObject({ status: 'blocked', attempt: 1, outcome: 'succeeded' });
  });

  it('grants exactly one retry credit by compare-and-swap and retains previous attempts', () => {
    const { open } = fixture();
    const store = open();
    const first = claim(store);
    store.complete({ key, ...first, outcome: 'failed', failure_code: 'permanently_rejected' });
    expect(store.authorizeRetry({ key, expected_attempt: 2, expected_outcome: 'failed' })).toBe('conflict');
    expect(store.authorizeRetry({ key, expected_attempt: 1, expected_outcome: 'pending', recover_pending: true })).toBe('conflict');
    expect(store.authorizeRetry({ key, expected_attempt: 1, expected_outcome: 'failed' })).toBe('authorized');
    expect(store.authorizeRetry({ key, expected_attempt: 1, expected_outcome: 'failed' })).toBe('conflict');
    store.close();
    const reopened = open();
    const retry = claim(reopened);
    expect(retry.attempt).toBe(2);
    expect(retry.claim_id).not.toBe(first.claim_id);
    expect(reopened.reserve(key)).toMatchObject({ status: 'blocked', attempt: 2, outcome: 'pending' });
    expect(reopened.authorizeRetry({ key, expected_attempt: 1, expected_outcome: 'failed' })).toBe('conflict');
    expect(reopened.history(key)).toMatchObject([
      { attempt: 1, outcome: 'failed', failure_code: 'permanently_rejected' },
      { attempt: 2, outcome: 'pending', failure_code: null },
    ]);
  });

  it('requires explicit interrupted-work recovery and fences a late completion from the old process', () => {
    const { open } = fixture();
    const store = open();
    const interrupted = claim(store);
    expect(store.authorizeRetry({ key, expected_attempt: 1, expected_outcome: 'pending' })).toBe('conflict');
    expect(store.authorizeRetry({ key, expected_attempt: 1, expected_outcome: 'pending', recover_pending: true })).toBe('authorized');
    expect(() => store.complete({ key, ...interrupted, outcome: 'succeeded' })).toThrow();
    expect(claim(store).attempt).toBe(2);
    expect(() => store.complete({ key, ...interrupted, outcome: 'succeeded' })).toThrow();
    expect(store.history(key)[0]?.outcome).toBe('pending');
  });

  it('isolates changed review input, source lineage, and admission without resetting old budgets', () => {
    const store = fixture().open();
    claim(store);
    for (const changed of [
      { ...key, review_input_sha256: `sha256:${'d'.repeat(64)}` },
      { ...key, review_lineage_id: `rli_${'d'.repeat(64)}` },
      { ...key, admission_sha256: `sha256:${'d'.repeat(64)}` },
    ]) expect(claim(store, changed).attempt).toBe(1);
    expect(store.reserve(key).status).toBe('blocked');
  });

  it('rejects a stale or forged completion and cannot overwrite a terminal outcome', () => {
    const store = fixture().open();
    const reserved = claim(store);
    expect(() => store.complete({ key, ...reserved, claim_id: '00000000-0000-4000-8000-000000000001', outcome: 'succeeded' })).toThrow();
    store.complete({ key, ...reserved, outcome: 'failed', failure_code: 'unknown' });
    expect(() => store.complete({ key, ...reserved, outcome: 'succeeded' })).toThrow();
    expect(store.reserve(key)).toMatchObject({ outcome: 'failed', failure_code: 'unknown' });
  });

  it('rejects a different Authority binding without modifying the existing database', () => {
    const { path, open } = fixture();
    const store = open();
    claim(store);
    store.close();
    const before = readFileSync(path);
    for (const identity of [
      { ...binding, authority_id: 'aut_other' },
      { ...binding, organization_id: 'org_other' },
      { ...binding, state_lineage_id: 'lin_other' },
    ]) expect(() => open(identity)).toThrow();
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses another schema and an uninitialized nonempty database without applying migrations', () => {
    const { path, open } = fixture();
    const other = new Database(path);
    other.exec('CREATE TABLE existing_state (value TEXT)');
    other.close();
    const before = readFileSync(path);
    expect(() => open()).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });

  it('rejects changed schema stamps or a missing retry history table instead of reinitializing', () => {
    const { path, open } = fixture();
    const store = open();
    claim(store);
    store.close();
    const raw = new Database(path);
    raw.pragma('user_version = 2');
    raw.close();
    expect(() => open()).toThrow();
    const incomplete = new Database(path);
    incomplete.pragma('user_version = 1');
    incomplete.exec('DROP TABLE extraction_retry_permissions_v1');
    incomplete.close();
    expect(() => open()).toThrow();
  });

  it('refuses reservation inside an outer transaction that could roll back after provider I/O', () => {
    const database = new Database(':memory:');
    const store = new SqliteExtractionAttemptStoreV1(database, binding);
    stores.push(store);
    database.transaction(() => {
      expect(() => store.reserve(key)).toThrow();
    }).immediate();
    expect(store.history(key)).toEqual([]);
    expect(claim(store).attempt).toBe(1);
  });

  it('lists bounded current holds and shows a single retry credit without exposing claim tokens', () => {
    const { open } = fixture();
    const store = open();
    const first = claim(store);
    store.complete({ key, ...first, outcome: 'failed', failure_code: 'invalid_output' });
    expect(store.listLatest(1)).toMatchObject([{ ...key, attempt: 1, outcome: 'failed', retry_authorized: false }]);
    expect(JSON.stringify(store.listLatest())).not.toContain(first.claim_id);
    expect(store.authorizeRetry({ key, expected_attempt: 1, expected_outcome: 'failed' })).toBe('authorized');
    expect(store.listLatest()[0]?.retry_authorized).toBe(true);
    const otherHandle = open();
    expect(claim(otherHandle).attempt).toBe(2);
    expect(store.listLatest()).toMatchObject([{ ...key, attempt: 2, retry_authorized: false }]);
    expect(() => store.listLatest(1001)).toThrow();
  });

  it('rejects malformed keys and unbounded failure text before any state mutation', () => {
    const store = fixture().open();
    expect(() => store.reserve({ ...key, review_input_sha256: 'provider secret' })).toThrow();
    const reserved = claim(store);
    expect(() => store.complete({ key, ...reserved, outcome: 'failed', failure_code: 'raw provider body' as never })).toThrow();
    expect(store.reserve(key)).toMatchObject({ outcome: 'pending', failure_code: null });
  });
});
