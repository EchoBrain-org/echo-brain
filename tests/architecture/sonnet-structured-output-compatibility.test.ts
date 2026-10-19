import { describe, expect, it } from 'vitest';
import { answerSchema, createStepSchema, parseStep } from '../../packages/organization-authority-kernel/src/answer-composition/agentic-ask-v1-model-protocol.js';
import { createOpenRouterStructuredGenerationAdapter } from '../../providers/openrouter/src/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js';

// Claude's documented grammar rejects these bounds. Local protocol parsing
// still owns them after the wire schema moves them into descriptions.
const unsupported = new Set(['minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'maxItems', 'uniqueItems']);
function unsupportedBounds(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(unsupported.has(key) || (key === 'minItems' && typeof child === 'number' && child > 1) ? [key] : []),
    ...unsupportedBounds(child),
  ]);
}

async function wireRequest(schema: Readonly<Record<string, unknown>>, model = 'anthropic/claude-sonnet-5.5', max_output_tokens = 1_500) {
  let body: Record<string, unknown> = {};
  const adapter = createOpenRouterStructuredGenerationAdapter({
    credential_ref: 'fixture', credential_resolver: () => 'offline-fixture',
    fetch_impl: async (_url, options) => {
      body = JSON.parse(options!.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }), { status: 200 });
    },
  });
  await adapter.generate({ model, schema, max_output_tokens, system_prompt: 'fixture', user_prompt: 'fixture', timeout_ms: 1_000 });
  return body;
}
const sentSchema = (body: Record<string, unknown>) => (body.response_format as { json_schema: { schema: Record<string, unknown> } }).json_schema.schema;

describe('Sonnet receives supported schemas for the real Ask protocol', () => {
  it.each([
    ['research', createStepSchema(['meetings', 'pages'], ['E1', 'E2'], true, true, true)],
    ['answer', answerSchema],
  ])('%s keeps the closed protocol without unsupported wire bounds', async (_role, schema) => {
    const before = JSON.stringify(schema);
    const body = await wireRequest(schema);
    expect(unsupportedBounds(sentSchema(body))).toEqual([]);
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
    expect(sentSchema(body)).toMatchObject({ type: 'object', additionalProperties: false, required: schema.required });
    expect(JSON.stringify(sentSchema(body))).toContain('maxItems'); // Bounds survive as descriptions.
    expect(JSON.stringify(schema)).toBe(before);
    expect(sentSchema(await wireRequest(schema, 'deepseek/deepseek-v3.2'))).toEqual(schema);
  });

  it('retains Ask date formats, canonical filters and registered sources on the Claude wire', async () => {
    const schema = sentSchema(await wireRequest(createStepSchema(['meetings', 'handbook'], ['E2'], true, true, true)));
    type Variant = { properties: { tool: { enum: string[] }; args: { properties: Record<string, Record<string, unknown>> } } };
    const variants = (schema.properties as { actions: { items: { anyOf: Variant[] } } }).actions.items.anyOf;
    const args = (tool: string) => variants.find(value => value.properties.tool.enum[0] === tool)!.properties.args.properties;
    for (const tool of ['search', 'list']) {
      expect(args(tool).since).toMatchObject({ format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
      expect(args(tool).until).toMatchObject({ format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
      expect(args(tool).source!.enum).toEqual(['meetings', 'handbook']);
      expect(args(tool).date_field!.enum).toEqual(['occurred', 'created', 'updated', 'due', 'received']);
    }
    expect(args('list').status!.enum).toEqual(['open', 'done']);
    expect(args('open').id!.enum).toEqual(['E2']);
  });

  it('keeps property names and literal values that resemble schema keywords', async () => {
    const schema = { type: 'object', additionalProperties: false, required: ['maxLength'], properties: {
      maxLength: { type: 'string', minLength: 1, maxLength: 8, description: 'A label', enum: ['minItems'] },
      children: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'integer', minimum: 1, maximum: 5 } },
    } };
    const output = sentSchema(await wireRequest(schema));
    expect(output).toMatchObject({ required: ['maxLength'], properties: {
      maxLength: { type: 'string', enum: ['minItems'], description: expect.stringContaining('A label') },
      children: { type: 'array', items: { type: 'integer', description: expect.stringContaining('minimum') } },
    } });
    const properties = output.properties as Record<string, Record<string, unknown>>;
    expect(properties.maxLength).not.toHaveProperty('maxLength');
    expect(properties.maxLength?.description).toContain('maxLength');
    expect(properties.children).not.toHaveProperty('minItems');
  });

  it.each([1, 256, 1_500, 4_096])('leaves reasoning headroom even for a %i-token background or Ask call', async allowance => {
    const body = await wireRequest(answerSchema, 'anthropic/claude-sonnet-5.5', allowance);
    expect(body.max_tokens).toBe(allowance + 4_096);
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(body).not.toHaveProperty('temperature');
  });

  it('keeps local action bounds and the caller output ceiling enforced', async () => {
    expect(parseStep({ parts: [{ question: 'fixture', needs: [], notes: '' }], actions: Array.from({ length: 5 }, () => ({ tool: 'search', args: { query: 'fixture' } })) }).actions).toHaveLength(4);
    await expect(wireRequest(answerSchema, 'anthropic/claude-sonnet-5.5', 4_097)).rejects.toThrow('output limit');
  });
});
