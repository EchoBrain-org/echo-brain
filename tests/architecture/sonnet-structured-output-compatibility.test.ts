import { describe, expect, it } from 'vitest';
import { answerBlocksFollowUpsSchema, answerBlocksSchema, answerBlocksSinceFollowUpsSchema, answerBlocksSinceSchema, createStepSchema, parseStep } from '../../packages/organization-authority-kernel/src/answer-composition/agentic-ask-v1-model-protocol.js';
import { followUpResolutionSchema, threadPlacementSchema } from '../../packages/organization-authority-kernel/src/answer-composition/agentic-follow-up-resolver-v1.js';
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
    // The writer's blocks (answer layout v2, ADR-0051).
    ['answer', answerBlocksSchema],
    // Ask again's writer (ADR-0047).
    ['answer asked again', answerBlocksSinceSchema],
    // The writer of an answer that may draft follow-ups (ADR-0053), asked once or again.
    ['answer with follow-ups', answerBlocksFollowUpsSchema],
    ['answer asked again with follow-ups', answerBlocksSinceFollowUpsSchema],
  ])('%s is too large for Claude\'s strict grammar, so it is sent whole as the StructuredOutput tool', async (_role, schema) => {
    // Sent strict, Claude refuses each of these with HTTP 400 "The compiled grammar is too large" (staging V17, 2026-11-19).
    const body = await wireRequest(schema);
    expect(body).not.toHaveProperty('response_format');
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'StructuredOutput', description: expect.any(String), parameters: schema } }]);
  });

  it.each([
    ['research', createStepSchema(['meetings', 'pages'], ['E1', 'E2'], true, true, true)],
    // The follow-up resolver (ADR-0047).
    ['follow-up resolution', followUpResolutionSchema],
    // The thread resolver (ADR-0056), which runs in its place when an Ask carries threads or older turns.
    ['thread resolution', threadPlacementSchema],
  ])('%s keeps the closed protocol without unsupported wire bounds', async (_role, schema) => {
    const before = JSON.stringify(schema);
    const body = await wireRequest(schema);
    expect(unsupportedBounds(sentSchema(body))).toEqual([]);
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
    expect(sentSchema(body)).toMatchObject({ type: 'object', additionalProperties: false, required: schema.required });
    // Any bound the schema still states survives as a description.
    if (/"(maxItems|maxLength|maximum)"/u.test(before)) expect(JSON.stringify(sentSchema(body))).toContain('Constraints');
    expect(JSON.stringify(schema)).toBe(before);
  });

  // The kernel's tests own the Ask date format and pattern; this checks the
  // Claude wire keeps them, which no other test covers.
  it('keeps Ask date formats and patterns on the Claude wire', async () => {
    type Variant = { properties: { tool: { enum: string[] }; args: { properties: Record<string, Record<string, unknown>> } } };
    const args = (schema: Readonly<Record<string, unknown>>, tool: string) => (schema.properties as { actions: { items: { anyOf: Variant[] } } })
      .actions.items.anyOf.find(value => value.properties.tool.enum[0] === tool)!.properties.args.properties;
    const step = createStepSchema(['meetings', 'handbook'], ['E2'], true, true, true);
    const wire = sentSchema(await wireRequest(step));
    for (const tool of ['search', 'list']) {
      for (const field of ['since', 'until']) {
        const { format, pattern } = args(step, tool)[field]!;
        expect(args(wire, tool)[field]).toMatchObject({ format, pattern });
      }
    }
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

  // The provider test covers 1,500 tokens, medium reasoning, and no temperature.
  // The caller's allowance is the model's whole output, reasoning included: the adapter adds nothing to it.
  it.each([1, 256, 4_096])('sends a %i-token allowance as the whole max_tokens', async allowance => {
    const body = await wireRequest(answerBlocksSchema, 'anthropic/claude-sonnet-5.5', allowance);
    expect(body.max_tokens).toBe(allowance);
  });

  it('keeps every action a step asks for, and sends the model\'s own maximum output whole', async () => {
    expect(parseStep({ parts: [{ question: 'fixture', needs: [], notes: '' }], actions: Array.from({ length: 12 }, () => ({ tool: 'search', args: { query: 'fixture' } })) }).actions).toHaveLength(12);
    // The generation profile states the model's own maximum (128,000 for Sonnet 5.5); the adapter has no ceiling of its own.
    expect((await wireRequest(answerBlocksSchema, 'anthropic/claude-sonnet-5.5', 128_000)).max_tokens).toBe(128_000);
  });
});
