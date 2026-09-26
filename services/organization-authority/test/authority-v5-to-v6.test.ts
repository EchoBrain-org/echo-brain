import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyAuthorityBaselineV5, applyAuthorityBaselineV6, authorityBaselineSha256V5, authorityBaselineSha256V6 } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';
import { copyAuthorityV5ToV6 } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/authority-v5-to-v6';
import { SqliteAuthorityMeetingProcessingStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1';
import { database, databases, decisions, meeting, fixtureCursorPolicy, REVIEW_POLICY, nextCursor, ADMITTED_AT, SHA } from '../../../packages/organization-processing/test/admitted-meeting-processing/fixtures/sqlite-meeting-state.js';

const roots: string[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('copies the exact V5 admission/cursor/frozen/ambiguous state without changing its bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'authority-v6-')); roots.push(root);
  const path = join(root, 'v5.sqlite'); const previous = database(path, applyAuthorityBaselineV5);
  const state = new SqliteAuthorityMeetingProcessingStateV1(previous, fixtureCursorPolicy, 'llm', () => ADMITTED_AT);
  const admission = await state.readAdmission();
  const candidate = await state.stageCandidate({ admission, meeting, decisions, review_policy: REVIEW_POLICY });
  state.prepareApprovalPost({ candidate_id: candidate.candidate_id, frozen_card_sha256: SHA, approved_snapshot: { frozen: 'ambiguous legacy card' } });
  await state.advanceCursor({ expected_cursor: admission.source.cursor, next_cursor: nextCursor });
  const snapshots = previous.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
  const rows = new Map(snapshots.map(({ name }) => [name, previous.prepare(`SELECT * FROM ${name}`).all()]));
  previous.close();
  const before = createHash('sha256').update(readFileSync(path)).digest('hex');
  const input = new Database(path, { readonly: true }); const output = new Database(join(root, 'v6.sqlite')); databases.push(input, output);
  copyAuthorityV5ToV6(input, output);
  expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(before);
  for (const [name, snapshot] of rows) expect(output.prepare(`SELECT * FROM ${name}`).all(), name).toEqual(snapshot);
  expect(output.pragma('user_version', { simple: true })).toBe(6);
  expect(output.pragma('foreign_key_check')).toEqual([]);
  const fresh = new Database(':memory:'); databases.push(fresh); applyAuthorityBaselineV6(fresh);
  const objects = (db: Database.Database) => db.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).all();
  expect(objects(output)).toEqual(objects(fresh));
  const recovered = new SqliteAuthorityMeetingProcessingStateV1(output, fixtureCursorPolicy, 'llm', () => ADMITTED_AT);
  expect((await recovered.readAdmission()).source.cursor).toBe(nextCursor);
  expect(await recovered.readFrozenCandidateForSourceRevision(meeting.provenance)).toMatchObject({ candidate_id: candidate.candidate_id, state: 'posting', meeting, decisions });
  expect(() => copyAuthorityV5ToV6(input, output)).toThrow('empty');
});

it('refuses unsupported versions and altered V5 schemas before writing the output', () => {
  const root = mkdtempSync(join(tmpdir(), 'authority-v6-refusal-')); roots.push(root);
  const path = join(root, 'altered.sqlite'); const db = database(path, applyAuthorityBaselineV5); db.exec('CREATE TABLE unreviewed (value TEXT)'); db.close();
  const input = new Database(path, { readonly: true }); const output = new Database(':memory:'); databases.push(input, output);
  expect(() => copyAuthorityV5ToV6(input, output)).toThrow('exact pinned V5');
  expect(output.prepare('SELECT count(*) AS n FROM sqlite_master').get()).toEqual({ n: 0 });
});

it('keeps the pinned V5 hash and pins the new V6 artifact separately', () => {
  expect(authorityBaselineSha256V5()).toBe('sha256:0c11226af116345f5d2eafe6bd833a421e4dcb3ccb5728642ab1134da09bd9ea');
  expect(authorityBaselineSha256V6()).toBe('sha256:f710c722038d56712e7fe35df08db31d50aecb44578fcf12fb51ce2e45f6895d');
});
