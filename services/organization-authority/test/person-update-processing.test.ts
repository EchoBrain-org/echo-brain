import { captureCoreRuntimeContentV1, observeCoreRuntimeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { StructuredGenerationPort } from '@echo-brain/organization-authority-kernel/answer-composition/retrieval-grounded-answer-composition';
import { database, databases, ADMITTED_AT } from '../../../packages/organization-processing/test/admitted-meeting-processing/fixtures/sqlite-meeting-state.js';
import { SqlitePersonUpdateInboxV1 } from '../src/adapters/persistence/sqlite/person-update-inbox-v1.js';
import { PersonUpdateProcessingV1 } from '../src/composition/person-update-processing-v1.js';

const actor = { organization_id: 'org_test', principal_id: 'prn_test', membership_id: 'mem_test', membership_type: 'owner' as const };
const request = (text = 'Client prefers a phone call before lunch.') => ({ schema_version: 1 as const, kind: 'echo-person-update-submit-v1' as const, request_id: randomUUID(), title: 'Work context', text });
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });
function fixture() {
  const db = database(); let now = ADMITTED_AT;
  const inbox = new SqlitePersonUpdateInboxV1(db, () => now);
  const generate = vi.fn<StructuredGenerationPort['generate']>(async () => ({ search_hints: 'customer contact preference telephone' }));
  const generation = { structured_output: { generate }, generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 1000 } };
  const worker = () => new PersonUpdateProcessingV1(inbox, generation);
  return { db, inbox, generate, worker, later: () => { now = new Date(Date.parse(now) + 301_000).toISOString(); } };
}

describe('optional Person upload search enrichment', () => {
  it.each([
    'Meeting notes: Acme prefers a morning call. No decision was made.',
    'Work artifact: export const contactWindow = "morning";',
    'Memo: client prefers telephone over email.',
    'Reminder: ask the client about their preferred contact time.',
  ])('preserves original context with no required decision/action shape: %s', async text => {
    const f = fixture(); const submission = request(text); const receipt = f.inbox.submit(actor, submission);
    expect(f.inbox.content(actor, receipt.context_id).text).toBe(text);
    expect(f.inbox.search(actor, { query: 'client' }).results).toHaveLength(text.includes('client') ? 1 : 0);
    await f.worker().runOnce(new AbortController().signal);
    expect(f.inbox.content(actor, receipt.context_id).text).toBe(text);
    expect(f.inbox.search(actor, { query: 'telephone' }).results[0]?.context_id).toBe(receipt.context_id);
    expect(f.inbox.status(actor, submission.request_id)).toMatchObject({ status: 'stored', metadata: 'ready' });
    expect(f.db.prepare('SELECT count(*) AS n FROM authority_live_source_candidates_v2').get()).toEqual({ n: 0 });
    expect(f.generate.mock.calls[0]![0].user_prompt).toBe(JSON.stringify({ title: submission.title, text }));
    expect(f.generate.mock.calls[0]![0].system_prompt).toContain('Do not extract or approve decisions/actions');
  });
  it('accepts an empty enrichment and keeps the original searchable', async () => {
    const f = fixture(); const submission = request(); f.inbox.submit(actor, submission);
    f.generate.mockResolvedValue({ search_hints: '' });
    await f.worker().runOnce(new AbortController().signal);
    expect(f.inbox.search(actor, { query: 'client' }).results).toHaveLength(1);
    expect(f.inbox.status(actor, submission.request_id).metadata).toBe('ready');
  });
  it('reclaims interrupted work, caches completed hints, and emits no source/model content telemetry', async () => {
    const f = fixture(); const submission = request(); f.inbox.submit(actor, submission); f.inbox.claim();
    const content: unknown[] = [];
    f.generate.mockImplementationOnce(async input => { captureCoreRuntimeContentV1('model_response', input.user_prompt); return { search_hints: 'telephone' }; });
    await observeCoreRuntimeV1('worker_execution', () => f.worker().runOnce(new AbortController().signal), { content_observer: event => { content.push(event); } });
    await f.worker().runOnce(new AbortController().signal);
    expect(f.generate).toHaveBeenCalledTimes(1); expect(content).toEqual([]);
    expect(f.inbox.status(actor, submission.request_id).metadata).toBe('ready');
  });
  it('backs off after model failures while other work and all originals stay available', async () => {
    const f = fixture(); const first = request(); const second = request();
    const receipt = f.inbox.submit(actor, first);
    f.generate.mockRejectedValueOnce(new Error('private provider details'));
    await f.worker().runOnce(new AbortController().signal);
    f.inbox.submit(actor, second); await f.worker().runOnce(new AbortController().signal);
    expect(f.inbox.status(actor, first.request_id).metadata).toBe('pending');
    expect(f.inbox.status(actor, second.request_id).metadata).toBe('ready');
    expect(f.inbox.content(actor, receipt.context_id).text).toBe(first.text);
    f.generate.mockRejectedValue(new Error('private provider details'));
    for (let n = 0; n < 4; n++) { f.later(); await f.worker().runOnce(new AbortController().signal); }
    expect(f.inbox.status(actor, first.request_id)).toMatchObject({ status: 'stored', metadata: 'unavailable' });
    expect(JSON.stringify(f.inbox.status(actor, first.request_id))).not.toContain('private provider details');
    expect(f.inbox.search(actor, { query: 'client' }).results).toHaveLength(2);
  });
  it('refuses metadata that tries to set access or replace the source', async () => {
    const f = fixture(); const submission = request(); const receipt = f.inbox.submit(actor, submission);
    f.generate.mockResolvedValue({ search_hints: 'customer', visibility: 'team', text: 'rewritten source' });
    await f.worker().runOnce(new AbortController().signal);
    expect(f.inbox.content(actor, receipt.context_id)).toMatchObject({ text: submission.text, visibility: 'only_me' });
    expect(f.inbox.read(actor, submission.request_id)?.search_hints).toBe('');
  });
  it('rechecks membership after generation and does not grant a revoked uploader authority', async () => {
    const f = fixture(); const submission = request(); f.inbox.submit(actor, submission);
    f.generate.mockImplementationOnce(async () => {
      f.db.prepare(`UPDATE authority_memberships SET status = 'revoked', revoked_at = ?, revocation_reason = 'test' WHERE membership_id = ?`).run(ADMITTED_AT, actor.membership_id);
      return { search_hints: 'telephone' };
    });
    await f.worker().runOnce(new AbortController().signal);
    expect(f.inbox.read(actor, submission.request_id)).toMatchObject({ state: 'unavailable', search_hints: '' });
    expect(() => f.inbox.search(actor, { query: 'client' })).toThrow(expect.objectContaining({ code: 'unauthorized' }));
  });
  it('preserves cancellation and surfaces corrupt original context as an integrity failure', async () => {
    const f = fixture(); const submission = request(); const receipt = f.inbox.submit(actor, submission);
    const aborted = new AbortController();
    f.generate.mockImplementationOnce(async () => { aborted.abort(new Error('shutdown')); return { search_hints: '' }; });
    await expect(f.worker().runOnce(aborted.signal)).rejects.toThrow('shutdown');
    expect(f.inbox.content(actor, receipt.context_id).text).toBe(submission.text);
    await f.worker().runOnce(new AbortController().signal); expect(f.inbox.status(actor, submission.request_id).metadata).toBe('ready');
    const bad = request(); f.inbox.submit(actor, bad); f.db.exec('DROP TRIGGER authority_person_updates_v1_immutable');
    f.db.prepare('UPDATE authority_person_updates_v1 SET text = ? WHERE request_id = ?').run('corrupt', bad.request_id);
    await expect(f.worker().runOnce(new AbortController().signal)).rejects.toThrow('integrity');
    expect(() => f.inbox.search(actor, { query: 'corrupt' })).toThrow('integrity');
  });
});
