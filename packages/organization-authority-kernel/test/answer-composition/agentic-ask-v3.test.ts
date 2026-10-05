import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonAnswerResponseV6 } from '@echo-brain/organization-api';
import { describe, expect, it, vi } from 'vitest';
import { createAgenticAskV3 } from '../../src/answer-composition/agentic-ask-v1.js';
import type { StructuredGenerationInput } from '../../src/answer-composition/structured-generation-v1.js';
import type { EvidenceDeskItemV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from '../../src/shared/evidence-desk-v2.js';
import { captureCoreRuntimeContentV1, observeCoreRuntimeV1 } from '../../src/shared/core-runtime-observation-v1.js';

const checked = { checked_at: '2026-10-05T00:00:00.000Z' };
const text = 'The approved launch plan says EVT begins Tuesday.';
const citation = (body: string) => ({ kind: 'page' as const, tool_id: 'knowledge', external_scope_id: 'site-one', page_id: 'page-one', section_id: 's1', version: '17', permalink: 'https://knowledge.example.test/wiki/pages/viewpage.action?pageId=1', text_sha256: sha256Digest(body) });
const inventory: EvidenceDeskItemV2 = Object.freeze({ id: 'opaque-page-section', kind: 'page', label: 'Launch plan, section 1', visibility: 'only_me', receipt_sha256: canonicalSha256('page-inventory'), citation: citation('') });
const opened: EvidenceDeskItemV2 = Object.freeze({ ...inventory, text, receipt_sha256: canonicalSha256('page-open'), citation: citation(text) });

describe('Agentic Ask V3 live pages', () => {
  it('suppresses runtime content capture after page-only inventory or text enters a prompt', async () => {
    const desk: EvidenceDeskPortV2 = {
      scope: { kind: 'global' }, ticket_available: false,
      live_sources: [{ source: 'page', selector: 'pages', metadata_only_list: true, tool_id: 'knowledge' }],
      search: vi.fn(async () => ({ items: [inventory], truncated: false, receipt_digests: [inventory.receipt_sha256] })),
      list: vi.fn(async () => ({ items: [inventory], truncated: false, receipt_digests: [inventory.receipt_sha256] })),
      open: vi.fn(async () => ({ items: [opened], truncated: false, receipt_digests: [opened.receipt_sha256] })),
      revalidate: vi.fn(async () => checked),
    };
    const replies = [
      { parts: [{ question: 'When does EVT start?', notes: '', needs: [{ need: 'EVT date', status: 'open', evidence: [] }] }], actions: [{ tool: 'list', args: { source: 'pages' } }] },
      { parts: [{ question: 'When does EVT start?', notes: '', needs: [{ need: 'EVT date', status: 'open', evidence: [] }] }], actions: [{ tool: 'open', args: { id: 'E1' } }] },
      { parts: [{ question: 'When does EVT start?', notes: '', needs: [{ need: 'EVT date', status: 'found', evidence: ['E1'] }] }], actions: [{ tool: 'finish', args: {} }] },
      { sentences: [{ text: 'EVT begins Tuesday.', evidence: ['E1'] }], not_found: [] },
    ];
    const capture = vi.fn();
    const generate = vi.fn(async (input: StructuredGenerationInput) => {
      captureCoreRuntimeContentV1('model_request', input.user_prompt);
      return replies.shift()!;
    });
    const ask = createAgenticAskV3({ desk, model: { generate }, audit: { append: () => undefined }, generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 30_000 } });
    await observeCoreRuntimeV1('ask_request', () => ask.answer({ question: 'When does EVT start?' }), { observer: () => undefined, content_observer: capture });
    expect(generate).toHaveBeenCalledTimes(4);
    // Only the initial question-only planner call may reach content capture.
    expect(capture).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(capture.mock.calls)).not.toContain(inventory.label);
    expect(JSON.stringify(capture.mock.calls)).not.toContain(text);
  });

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


it('plans two registered page providers without a provider-specific selector or routing branch', async () => {
  const descriptors = [
    { source_id: 'knowledge-a', selector: 'handbook', kind: 'page' as const, description: 'Company handbook pages.', metadata_only_list: true },
    { source_id: 'knowledge-b', selector: 'runbooks', kind: 'page' as const, description: 'Operational runbook pages.', metadata_only_list: true },
  ];
  const items = descriptors.map((descriptor, index): EvidenceDeskItemV2 => ({ ...inventory, id: descriptor.source_id, source_id: descriptor.source_id, label: descriptor.description,
    citation: { ...citation(''), tool_id: descriptor.source_id, page_id: `page-${index}` },
  }));
  const result = (item: EvidenceDeskItemV2) => ({ items: [item], truncated: false, receipt_digests: [item.receipt_sha256] });
  const desk: EvidenceDeskPortV2 = {
    scope: { kind: 'global' }, live_sources: descriptors,
    list: vi.fn(async input => { expect(input.source).toBe('knowledge-a'); return result(items[0]!); }),
    search: vi.fn(async input => { expect(input.source).toBe('knowledge-b'); expect(input.kinds).toEqual(['page']); return result(items[1]!); }),
    open: vi.fn(async input => { const item = items.find(value => value.id === input.item)!; if (item.citation.kind !== 'page') throw new Error('Expected a page fixture'); return result({ ...item, text, citation: { ...item.citation, text_sha256: sha256Digest(text) } }); }),
    revalidate: vi.fn(async () => checked),
  };
  const part = (status: 'open' | 'found') => [{ question: 'Compare the two plans.', notes: '', needs: [{ need: 'Both plans', status, evidence: status === 'found' ? ['E1', 'E2'] : [] }] }];
  const replies = [
    { parts: part('open'), actions: [{ tool: 'list', args: { source: 'handbook' } }, { tool: 'search', args: { source: 'runbooks', query: 'launch plan' } }] },
    { parts: part('open'), actions: [{ tool: 'open', args: { id: 'E1' } }, { tool: 'open', args: { id: 'E2' } }] },
    { parts: part('found'), actions: [{ tool: 'finish', args: {} }] },
    { sentences: [{ text: 'Both plans say EVT begins Tuesday.', evidence: ['E1', 'E2'] }], not_found: [] },
  ];
  const prompts: StructuredGenerationInput[] = [];
  const answer = await createAgenticAskV3({ desk, model: { generate: async input => { prompts.push(input); return replies.shift()!; } }, audit: { append: () => undefined }, generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 30_000 } }).answer({ question: 'Compare the two plans.' });
  expect(answer).toMatchObject({ schema_version: 6, outcome: 'answered' });
  expect(answer.citations.map(value => value.citation.kind === 'page' ? value.citation.tool_id : undefined)).toEqual(['knowledge-a', 'knowledge-b']);
  expect(JSON.parse(prompts[0]!.user_prompt).source_catalog.map((value: { source: string }) => value.source)).toEqual(['meetings', 'documents', 'handbook', 'runbooks']);
  expect(desk.list).toHaveBeenCalledOnce(); expect(desk.search).toHaveBeenCalledOnce(); expect(desk.open).toHaveBeenCalledTimes(2);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const pageSources = [
  { source_id: 'knowledge-a', selector: 'handbook', kind: 'page' as const, description: 'Company handbook pages.' },
  { source_id: 'knowledge-b', selector: 'runbooks', kind: 'page' as const, description: 'Operational runbook pages.' },
];
function releasedPage(source: string, id: string): EvidenceDeskItemV2 {
  const body = `Private ${source} evidence.\n${id} establishes the EVT date.`;
  return { ...inventory, id, source_id: source, text: body,
    citation: { ...citation(body), tool_id: source, page_id: id } };
}
const pageResult = (item: EvidenceDeskItemV2): EvidenceDeskResultV2 => ({ items: [item], truncated: false, receipt_digests: [item.receipt_sha256] });
const comparisonParts = (evidence: readonly string[] = []) => [{ question: 'Compare the plans.', notes: '', needs: [{ need: 'Both plans', status: evidence.length === 0 ? 'open' : 'found', evidence }] }];
const fixtureGeneration = { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 30_000 };

it('concurrently reads same-kind registered sources and admits exact passages without capturing live content', async () => {
  const first = deferred<EvidenceDeskResultV2>(); const second = deferred<EvidenceDeskResultV2>();
  const firstItem = releasedPage('knowledge-a', 'page-a'); const secondItem = releasedPage('knowledge-b', 'page-b');
  const desk: EvidenceDeskPortV2 = {
    scope: { kind: 'global' }, live_sources: pageSources,
    search: vi.fn(input => { expect(input.kinds).toEqual(['page']); return input.source === 'knowledge-a' ? first.promise : second.promise; }),
    list: vi.fn(), open: vi.fn(), revalidate: vi.fn(async () => checked),
  };
  const replies = [
    { parts: comparisonParts(), actions: [{ tool: 'search', args: { source: 'handbook', query: 'EVT' } }, { tool: 'search', args: { source: 'runbooks', query: 'EVT' } }] },
    { parts: comparisonParts(['E1', 'E2']), actions: [{ tool: 'finish', args: {} }] },
    { sentences: [{ text: 'Both plans establish the EVT date.', evidence: ['E1', 'E2'] }], not_found: [] },
  ];
  const prompts: StructuredGenerationInput[] = []; const capture = vi.fn();
  const ask = createAgenticAskV3({ desk, audit: { append: () => undefined }, generation: fixtureGeneration,
    model: { generate: async input => { prompts.push(input); captureCoreRuntimeContentV1('model_request', input.user_prompt); return replies.shift()!; } } });
  const pending = observeCoreRuntimeV1('ask_request', () => ask.answer({ question: 'Compare the plans.' }), { observer: () => undefined, content_observer: capture });
  await vi.waitFor(() => expect(desk.search).toHaveBeenCalledTimes(2));
  expect(vi.mocked(desk.search).mock.calls.map(([input]) => input.source)).toEqual(['knowledge-a', 'knowledge-b']);
  second.resolve(pageResult(secondItem)); first.resolve(pageResult(firstItem));
  const response = await pending;
  expect(validatePersonAnswerResponseV6(response)).toMatchObject({ outcome: 'answered', citations: [{ citation: firstItem.citation }, { citation: secondItem.citation }] });
  const research = JSON.parse(prompts[1]!.user_prompt);
  expect(research.seen).toEqual([
    expect.objectContaining({ id: 'E1', source: 'handbook', text: firstItem.text, full: true }),
    expect.objectContaining({ id: 'E2', source: 'runbooks', text: secondItem.text, full: true }),
  ]);
  expect(research.last_results.every((result: { results: Record<string, unknown>[] }) => result.results.every(item => !('text' in item) && !('preview' in item)))).toBe(true);
  expect(desk.open).not.toHaveBeenCalled();
  expect(capture).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(capture.mock.calls)).not.toContain('Private knowledge-');
});

it('serializes equivalent registered-source cursors while another source lists concurrently on one request day', async () => {
  const first = deferred<EvidenceDeskResultV2>(); const other = deferred<EvidenceDeskResultV2>();
  const desk: EvidenceDeskPortV2 = {
    scope: { kind: 'global' }, live_sources: pageSources,
    search: vi.fn(), open: vi.fn(), revalidate: vi.fn(async () => checked),
    list: vi.fn(input => {
      expect(input.since).toBe('2026-09-28');
      if (input.source === 'knowledge-b') return other.promise;
      return input.cursor === undefined ? first.promise : Promise.resolve(pageResult(releasedPage('knowledge-a', 'page-a2')));
    }),
  };
  const replies = [
    { parts: comparisonParts(), actions: [
      { tool: 'list', args: { source: 'handbook', since: '7d' } },
      { tool: 'list', args: { source: 'knowledge-a', since: '2026-09-28' } },
      { tool: 'list', args: { source: 'runbooks', since: '7d' } },
    ] },
    { parts: comparisonParts(['E1', 'E2', 'E3']), actions: [{ tool: 'finish', args: {} }] },
    { sentences: [{ text: 'The plans establish the EVT date.', evidence: ['E1', 'E2', 'E3'] }], not_found: [] },
  ];
  const today = vi.fn().mockReturnValueOnce('2026-10-05').mockReturnValue('2026-10-06');
  const pending = createAgenticAskV3({ desk, today, audit: { append: () => undefined }, generation: fixtureGeneration,
    model: { generate: async () => replies.shift()! } }).answer({ question: 'Compare the plans.' });
  await vi.waitFor(() => expect(desk.list).toHaveBeenCalledTimes(2));
  expect(vi.mocked(desk.list).mock.calls.map(([input]) => input.source)).toEqual(['knowledge-a', 'knowledge-b']);
  other.resolve(pageResult(releasedPage('knowledge-b', 'page-b')));
  first.resolve({ ...pageResult(releasedPage('knowledge-a', 'page-a1')), next_cursor: 'next-a' });
  const response = await pending;
  expect(response).toMatchObject({ schema_version: 6, outcome: 'answered' });
  expect(response.citations.map(value => value.citation.kind === 'page' ? value.citation.page_id : undefined)).toEqual(['page-a1', 'page-a2', 'page-b']);
  expect(desk.list).toHaveBeenNthCalledWith(3, expect.objectContaining({ source: 'knowledge-a', cursor: 'next-a', since: '2026-09-28' }));
  expect(today).toHaveBeenCalledOnce();
});
