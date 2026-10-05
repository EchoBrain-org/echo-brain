import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonAnswerResponseV6 } from '@echo-brain/organization-api';
import { describe, expect, it, vi } from 'vitest';
import { createAgenticAskV3 } from '../../src/answer-composition/agentic-ask-v1.js';
import type { EvidenceDeskItemV2, EvidenceDeskPortV2 } from '../../src/shared/evidence-desk-v2.js';

const checked = { checked_at: '2026-10-05T00:00:00.000Z' };
const text = 'The approved launch plan says EVT begins Tuesday.';
const citation = (body: string) => ({ kind: 'page' as const, tool_id: 'knowledge', external_scope_id: 'site-one', page_id: 'page-one', section_id: 's1', version: '17', permalink: 'https://knowledge.example.test/wiki/pages/viewpage.action?pageId=1', text_sha256: sha256Digest(body) });
const inventory: EvidenceDeskItemV2 = Object.freeze({ id: 'opaque-page-section', kind: 'page', label: 'Launch plan, section 1', visibility: 'only_me', receipt_sha256: canonicalSha256('page-inventory'), citation: citation('') });
const opened: EvidenceDeskItemV2 = Object.freeze({ ...inventory, text, receipt_sha256: canonicalSha256('page-open'), citation: citation(text) });

describe('Agentic Ask V3 live pages', () => {
  it('discovers metadata then opens a request-owned page section and emits only V6', async () => {
    const desk: EvidenceDeskPortV2 = {
      scope: { kind: 'global' }, ticket_available: false,
      live_sources: [{ source: 'page', selector: 'pages', description: 'Live knowledge pages.', metadata_only_list: true, tool_id: 'knowledge' }],
      search: vi.fn(async () => ({ items: [inventory], truncated: false, receipt_digests: [inventory.receipt_sha256] })),
      list: vi.fn(async () => ({ items: [inventory], truncated: false, receipt_digests: [inventory.receipt_sha256] })),
      open: vi.fn(async input => { expect(input.item).toBe(inventory.id); return { items: [opened], truncated: false, receipt_digests: [opened.receipt_sha256] }; }),
      revalidate: vi.fn(async () => checked),
    };
    const replies = [
      { parts: [{ question: 'When does EVT start?', notes: '', needs: [{ need: 'EVT date', status: 'open', evidence: [] }] }], actions: [{ tool: 'search', args: { source: 'pages', query: 'EVT start' } }] },
      { parts: [{ question: 'When does EVT start?', notes: '', needs: [{ need: 'EVT date', status: 'open', evidence: [] }] }], actions: [{ tool: 'open', args: { id: 'E1' } }] },
      { parts: [{ question: 'When does EVT start?', notes: '', needs: [{ need: 'EVT date', status: 'found', evidence: ['E1'] }] }], actions: [{ tool: 'finish', args: {} }] },
      { sentences: [{ text: 'EVT begins Tuesday.', evidence: ['E1'] }], not_found: [] },
    ];
    const prompts: string[] = [];
    const answer = await createAgenticAskV3({ desk, model: { generate: async input => { prompts.push(input.user_prompt); return replies.shift()!; } }, audit: { append: () => undefined }, generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 30_000 } }).answer({ question: 'When does EVT start?' });
    expect(validatePersonAnswerResponseV6(answer)).toMatchObject({ schema_version: 6, outcome: 'answered', citations: [{ citation: opened.citation, kind: 'page' }] });
    expect(desk.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'EVT start', kinds: ['page'] }));
    expect(desk.open).toHaveBeenCalledTimes(1);
    expect(JSON.parse(prompts[0]!).source_catalog).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'pages', tool_id: 'knowledge', metadata_only_list: true })]));
  });

  it('keeps generic metadata returned beside an open so a bounded reader can continue', async () => {
    const continuationCitation = (section: string, body: string) => ({ kind: 'page' as const, tool_id: 'knowledge', external_scope_id: 'site-one', page_id: 'long-plan', section_id: section, version: '17', permalink: 'https://knowledge.example.test/wiki/pages/viewpage.action?pageId=2', text_sha256: sha256Digest(body) });
    const start: EvidenceDeskItemV2 = Object.freeze({ id: 'start', kind: 'page', label: 'Long launch plan', visibility: 'team', receipt_sha256: canonicalSha256('start'), citation: continuationCitation('inventory', '') });
    const first: EvidenceDeskItemV2 = Object.freeze({ id: 'body-1', kind: 'page', label: 'Long launch plan', text: 'The opening section establishes the program.', visibility: 'team', receipt_sha256: canonicalSha256('body-1'), citation: continuationCitation('s1', 'The opening section establishes the program.') });
    const next: EvidenceDeskItemV2 = Object.freeze({ id: 'continue-1', kind: 'page', label: 'Continue Long launch plan', visibility: 'team', receipt_sha256: canonicalSha256('continue-1'), citation: continuationCitation('continue:1', '') });
    const secondText = 'The later section says EVT begins Tuesday.';
    const second: EvidenceDeskItemV2 = Object.freeze({ id: 'body-2', kind: 'page', label: 'Long launch plan', text: secondText, visibility: 'team', receipt_sha256: canonicalSha256('body-2'), citation: continuationCitation('s2', secondText) });
    const desk: EvidenceDeskPortV2 = {
      scope: { kind: 'global' }, ticket_available: false,
      live_sources: [{ source: 'page', selector: 'pages', description: 'Live knowledge pages.', metadata_only_list: true, tool_id: 'knowledge' }],
      search: vi.fn(async () => ({ items: [start], truncated: false, receipt_digests: [start.receipt_sha256] })),
      list: vi.fn(async () => ({ items: [start], truncated: false, receipt_digests: [start.receipt_sha256] })),
      open: vi.fn(async input => input.item === start.id
        ? ({ items: [first, next], truncated: false, receipt_digests: [first.receipt_sha256, next.receipt_sha256] })
        : input.item === next.id
          ? ({ items: [second], truncated: false, receipt_digests: [second.receipt_sha256] })
          : (() => { throw new Error('unexpected request-owned handle'); })()),
      revalidate: vi.fn(async () => checked),
    };
    const replies = [
      { parts: [{ question: 'When does EVT start?', notes: '', needs: [{ need: 'EVT date', status: 'open', evidence: [] }] }], actions: [{ tool: 'list', args: { source: 'pages' } }] },
      { parts: [{ question: 'When does EVT start?', notes: '', needs: [{ need: 'EVT date', status: 'open', evidence: [] }] }], actions: [{ tool: 'open', args: { id: 'E1' } }] },
      { parts: [{ question: 'When does EVT start?', notes: '', needs: [{ need: 'EVT date', status: 'open', evidence: [] }] }], actions: [{ tool: 'open', args: { id: 'E3' } }] },
      { parts: [{ question: 'When does EVT start?', notes: '', needs: [{ need: 'EVT date', status: 'found', evidence: ['E4'] }] }], actions: [{ tool: 'finish', args: {} }] },
      { sentences: [{ text: 'EVT begins Tuesday.', evidence: ['E4'] }], not_found: [] },
    ];
    const prompts: string[] = [];
    const answer = await createAgenticAskV3({ desk, model: { generate: async input => { prompts.push(input.user_prompt); return replies.shift()!; } }, audit: { append: () => undefined }, generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 30_000 } }).answer({ question: 'When does EVT start?' });
    expect(answer).toMatchObject({ outcome: 'answered', citations: [{ citation: second.citation }] });
    expect(desk.list).toHaveBeenCalledWith(expect.objectContaining({ source: 'page' }));
    expect(desk.open).toHaveBeenNthCalledWith(1, expect.objectContaining({ item: start.id }));
    expect(desk.open).toHaveBeenNthCalledWith(2, expect.objectContaining({ item: next.id }));
    const afterFirstOpen = JSON.parse(prompts[2]!);
    expect(afterFirstOpen.last_results.at(-1)).toMatchObject({ tool: 'open', opened: ['E2'], results: [expect.objectContaining({ id: 'E3', title: next.label })] });
  });
});
