import { describe, expect, it } from 'vitest';
import { ASK_STEP_PROMPT, createStepSchema } from '../../src/answer-composition/agentic-ask-v1-model-protocol.js';
import { createAgenticAskV3 } from '../../src/answer-composition/agentic-ask-v1.js';
import type { StructuredGenerationInput } from '../../src/answer-composition/structured-generation-v1.js';
import { generation, result } from './fixtures/agentic-scenarios.js';

type Schema = Readonly<Record<string, any>>;
const argsFor = (schema: Schema, tool: string): Schema => schema.properties.actions.items.anyOf
  .find((variant: Schema) => variant.properties.tool.enum[0] === tool).properties.args.properties;

describe('Ask tool argument contracts', () => {
  it('advertises calendar days and canonical filters', () => {
    const schema = createStepSchema(['meetings', 'handbook'], ['E2'], true, true, true) as Schema;
    for (const tool of ['search', 'list']) {
      const args = argsFor(schema, tool);
      for (const field of ['since', 'until']) {
        expect(args[field].format).toBe('date');
        const pattern = new RegExp(args[field].pattern);
        expect(pattern.test('2024-07-19')).toBe(true);
        for (const invalid of ['2024-07-19Z', '2024-07-19T23:59:59-07:00', '7d', '2024-7-19']) {
          expect(pattern.test(invalid), invalid).toBe(false);
        }
        expect(args[field].description).toContain('Inclusive');
      }
      expect(args.source.enum).toEqual(['meetings', 'handbook']);
      // Research tool contract v1: every date field a source may declare; its capabilities say which it takes.
      expect(args.date_field.enum).toEqual(['occurred', 'created', 'updated', 'due', 'received', 'approved', 'sent', 'reassigned', 'checked']);
    }
    expect(schema.properties.parts.items.properties.question.minLength).toBe(1);
    expect(argsFor(schema, 'search').date_field.description).toContain('requires source');
    expect(argsFor(schema, 'list').status.enum).toEqual(['open', 'done', 'active', 'archived']);
    expect(argsFor(schema, 'list').kind).not.toHaveProperty('enum');
    // Opening any discovered id is still an available action; schema tightening does not prescribe a route.
    expect(argsFor(schema, 'open').id.enum).toEqual(['E2']);
  });

  it('sends the clarified schema on the actual Ask planner call', async () => {
    const calls: StructuredGenerationInput[] = [];
    const parts = (status: string) => [{ question: 'Who owns the archive cleanup?', notes: '',
      needs: [{ need: 'archive cleanup owner', kind: 'content', status, evidence: [] }] }];
    const replies = [
      { parts: parts('open'), actions: [{ tool: 'search', args: { query: 'archive cleanup' } }, { tool: 'search', args: { query: 'archive owner' } }] },
      { parts: parts('not_found'), actions: [{ tool: 'finish', args: {} }] },
      { lists: [], sentences: [], not_found: ['archive cleanup owner'] },
    ];
    const ask = createAgenticAskV3({ generation, audit: { append: () => undefined },
      desk: { scope: { kind: 'global' }, live_sources: [], search: async () => result([]),
        list: async () => result([]), open: async () => result([]),
        revalidate: async () => ({ checked_at: '2024-07-20T12:00:00.000Z' }) },
      model: { generate: async input => { calls.push(input); return replies.shift()!; } },
    });
    expect((await ask.answer({ question: 'Who owns the archive cleanup?' })).outcome).toBe('not_found');
    expect(calls[0]!.system_prompt).toBe(ASK_STEP_PROMPT);
    expect(argsFor(calls[0]!.schema, 'search').since.format).toBe('date');
    expect(argsFor(calls[0]!.schema, 'list').status.enum).toEqual(['open', 'done', 'active', 'archived']);
  });

  it('explains adaptive recovery while retaining context reads', () => {
    expect(ASK_STEP_PROMPT).toContain('empty or irrelevant');
    expect(ASK_STEP_PROMPT).toContain('not the parent meeting title');
    expect(ASK_STEP_PROMPT).toContain('Full text from search or a neighbouring passage can still be opened');
    expect(ASK_STEP_PROMPT).toContain('prior notice or truncated read');
    expect(ASK_STEP_PROMPT).toContain('One retry is available after an availability notice');
    expect(ASK_STEP_PROMPT).toContain('same day for both');
    expect(ASK_STEP_PROMPT).toContain('its text must support that fact');
    expect(ASK_STEP_PROMPT).toContain('A complete list can establish which items exist');
    expect(ASK_STEP_PROMPT).toContain('no fixed search/list/open order');
  });
});
