import { describe, expect, it } from 'vitest';
import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { createAgenticAskV3 } from '../../src/answer-composition/agentic-ask-v1.js';
import type { EvidenceDeskItemV2, EvidenceDeskPortV2 } from '../../src/shared/evidence-desk-v2.js';
import { AuthorityOperationError } from '../../src/domain/errors.js';

const body = 'The gate decision is pending. A recorded Go decision is required.';
const item: EvidenceDeskItemV2 = {
  id: 'synthetic-page', kind: 'page', label: 'Gate guide', text: body, visibility: 'only_me',
  occurred_at: '2026-10-05',
  receipt_sha256: canonicalSha256('receipt'),
  citation: { kind: 'page', tool_id: 'confluence', external_scope_id: 'synthetic', page_id: '1', section_id: 's1', version: '3', permalink: 'https://example.test/wiki/1', text_sha256: sha256Digest(body) },
};
const question = 'Can the pilot proceed?';
const step = (tool: string, args: Record<string, string>, found = false) => ({
  parts: [{ question, needs: [{ need: 'gate decision', status: found ? 'found' : 'open', evidence: found ? ['E1'] : [] }], notes: 'Speculative planner assertion, not evidence.' }],
  actions: [{ tool, args }],
});

async function run(options: { truncated?: boolean; notice?: string; idle?: boolean; inventory?: boolean; refusedOpen?: boolean } = {}) {
  let searches = 0;
  const result = () => ({ items: searches++ === 0 ? [item] : [], truncated: options.truncated ?? false, receipt_digests: [], ...(options.notice === undefined ? {} : { notice: options.notice }) });
  const desk: EvidenceDeskPortV2 = {
    scope: { kind: 'global' }, live_sources: [{ source: 'page', tool_id: 'confluence' }],
    search: async () => result(), list: async () => ({ ...result(), next_cursor: 'unread-page' }),
    open: async () => { throw new AuthorityOperationError('not_found', 'private refusal details'); }, revalidate: async () => ({ checked_at: '2026-10-06T00:00:00.000Z' }),
  };
  const replies = options.idle
    ? [step('search', { query: 'pilot' }), step('search', { query: 'gate results' }), step('search', { query: 'pilot tests' })]
    : [options.inventory ? step('list', { source: 'pages' }) : step('search', { source: 'pages', query: 'pilot' }), step('finish', {}, true)];
  if (options.refusedOpen) replies.splice(1, 0, step('open', { id: 'E1' }));
  let writer: Record<string, unknown> = {};
  const audit: unknown[] = [];
  const answer = await createAgenticAskV3({ desk,
    model: { generate: async input => {
      if (replies.length > 0) return replies.shift();
      writer = JSON.parse(input.user_prompt) as Record<string, unknown>;
      return { sentences: [{ text: 'The gate decision is pending.', evidence: ['E1'] }], not_found: [] };
    } },
    audit: { append: entry => { audit.push(entry); } },
    generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 30000 },
  }).answer({ question });
  return { writer, answer, audit };
}

describe('synthesis receives observed research coverage', () => {
  it('preserves a failed read as unavailable rather than an empty search', async () => {
    const { writer } = await run({ refusedOpen: true });
    expect(writer.research).toMatchObject({ reads: [{ tool: 'search', unavailable: false }, { tool: 'open', unavailable: true }] });
    expect(JSON.stringify(writer)).not.toContain('private refusal details');
  });
  it('carries citation provenance and page version into the writer', async () => {
    const { writer } = await run();
    expect(writer.evidence).toEqual([expect.objectContaining({ provenance: { kind: 'page', version: '3' } })]);
  });
  it('does not silently interpret an untyped source date as an event date', async () => {
    const { writer } = await run();
    expect(writer.evidence).toEqual([expect.objectContaining({ date: '2026-10-05', date_kind: 'unspecified' })]);
  });
  it('preserves truncation and availability notices without promoting planner notes', async () => {
    const { writer, audit } = await run({ truncated: true, notice: 'Some page sections could not be represented.' });
    expect(writer.research).toMatchObject({ stop_reason: 'finished', notices: ['Some page sections could not be represented.'], reads: [
      { tool: 'search', source: 'pages', returned_items: 1, truncated: true, notice: true },
    ] });
    expect(JSON.stringify(writer)).not.toContain('Speculative planner assertion');
    expect(JSON.stringify(audit)).not.toContain(body);
    expect(JSON.stringify(audit)).not.toContain('Some page sections');
  });

  it('reports a no-progress stop instead of implying exhaustive research', async () => {
    const { writer, answer } = await run({ idle: true });
    expect(writer.research).toMatchObject({ completed: false, stop_reason: 'no_progress', reads: [
      { returned_items: 1 }, { returned_items: 0 }, { returned_items: 0 },
    ] });
    // A supported requested fact remains answerable despite bounded research.
    expect(answer.outcome).toBe('answered');
    expect(answer.notice).toBe('Research stopped before it finished, so relevant context may be missing.');
  });

  it('keeps an unread inventory visible even when the requested fact was found', async () => {
    const { writer } = await run({ inventory: true });
    expect(writer.research).toMatchObject({ completed: true, inventories: [
      { source: 'pages', shown_count: 1, more: true, available: true },
    ], omitted_evidence_items: 0 });
  });
});
