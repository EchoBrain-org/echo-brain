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

async function run(options: { truncated?: boolean; notice?: string; idle?: boolean; inventory?: boolean; refusedOpen?: boolean; evidence?: EvidenceDeskItemV2; time_zone?: string } = {}) {
  let searches = 0;
  const result = () => ({ items: searches++ === 0 ? [options.evidence ?? item] : [], truncated: options.truncated ?? false, receipt_digests: [], ...(options.notice === undefined ? {} : { notice: options.notice }) });
  const desk: EvidenceDeskPortV2 = {
    scope: { kind: 'global' }, live_sources: [{ source_id: 'page', kind: 'page', selector: 'pages', description: 'Live knowledge pages: discover pages, then open selected pages and continuation handles for their current text.', metadata_only_list: true, tool_id: 'confluence' }],
    search: async () => result(), list: async () => ({ ...result(), next_cursor: 'unread-page' }),
    open: async () => { throw new AuthorityOperationError('not_found', 'private refusal details'); }, revalidate: async () => ({ checked_at: '2026-10-06T00:00:00.000Z' }),
  };
  const replies = options.idle
    ? [step('search', { query: 'pilot' }), step('search', { query: 'gate results' }), step('search', { query: 'pilot tests' })]
    : [options.inventory ? step('list', { source: 'pages' }) : step('search', { source: 'pages', query: 'pilot' }), step('finish', {}, true)];
  if (options.refusedOpen) replies.splice(1, 0, step('open', { id: 'E1' }));
  let writer: Record<string, unknown> = {};
  const prompts: Record<string, unknown>[] = [];
  const audit: unknown[] = [];
  const answer = await createAgenticAskV3({ desk,
    model: { generate: async input => {
      prompts.push(JSON.parse(input.user_prompt) as Record<string, unknown>);
      if (replies.length > 0) return replies.shift();
      writer = JSON.parse(input.user_prompt) as Record<string, unknown>;
      return { sentences: [{ text: 'The gate decision is pending.', evidence: ['E1'] }], not_found: [] };
    } },
    audit: { append: entry => { audit.push(entry); } },
    generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 30000 },
    ...(options.time_zone === undefined ? {} : { time_context: { now: '2026-10-18T23:28:09.000Z', time_zone: options.time_zone } }),
  }).answer({ question });
  return { writer, answer, audit, prompts };
}

describe('synthesis receives observed research coverage', () => {
  it('automatically gives research and synthesis client-local times from the real legacy date shape', async () => {
    const stamp = '2026-10-17T00:20:00.000Z';
    const evidence = { ...item, occurred_at: '2026-10-17', date_kind: 'occurred' as const, dates: { occurred: stamp } };
    const { prompts, writer } = await run({ evidence, time_zone: 'America/Los_Angeles' });
    const local = { date: '2026-10-16', dates: { occurred: '2026-10-16T17:20:00.000-07:00' } };
    expect(prompts[1]).toMatchObject({ seen: [expect.objectContaining(local)] });
    expect(writer.evidence).toEqual([expect.objectContaining(local)]);
    expect(evidence.dates.occurred).toBe(stamp);
  });
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

  it('keeps an unread list visible even when the requested fact was found', async () => {
    const { writer } = await run({ inventory: true });
    // The writer sees the list by id with its rows and filter (ADR-0041); research no longer reports a bare count.
    expect(writer.research).toMatchObject({ completed: true, omitted_evidence_items: 0 });
    expect(writer.research).not.toHaveProperty('inventories');
    expect(writer.lists).toEqual([expect.objectContaining({ id: 'L1', source: 'pages', complete: false, count: 1, stated: false, members: [expect.objectContaining({ id: 'E1', title: 'Gate guide' })] })]);
    expect(JSON.stringify(writer.lists)).not.toContain(body);
  });
});
