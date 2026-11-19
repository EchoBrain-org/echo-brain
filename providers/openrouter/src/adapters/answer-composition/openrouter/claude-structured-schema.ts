import type { StructuredGenerationJsonSchema } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';

const DESCRIPTION_BOUNDS = new Set([
  'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'maxItems', 'uniqueItems',
]);
const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);
const SCHEMA_ARRAYS = new Set(['anyOf', 'allOf', 'oneOf', 'prefixItems']);
const SCHEMA_VALUES = new Set(['items', 'additionalProperties', 'not', 'contains', 'propertyNames', 'if', 'then', 'else']);

/**
 * Claude's grammar supports the closed shapes, but not these size/range
 * bounds. Follow its documented SDK transformation: retain the bounds in
 * descriptions and leave local protocol validation/normalization unchanged.
 * Visit schema positions only, never property names or literal enum/defaults.
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 */
export function claudeStructuredSchema(schema: StructuredGenerationJsonSchema): StructuredGenerationJsonSchema {
  const visit = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const result: Record<string, unknown> = {};
    const bounds: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (DESCRIPTION_BOUNDS.has(key) || (key === 'minItems' && typeof child === 'number' && child > 1)) {
        bounds[key] = child;
      } else if (SCHEMA_MAPS.has(key) && child !== null && typeof child === 'object' && !Array.isArray(child)) {
        result[key] = Object.fromEntries(Object.entries(child).map(([name, entry]) => [name, visit(entry)]));
      } else if (SCHEMA_ARRAYS.has(key) && Array.isArray(child)) {
        result[key] = child.map(visit);
      } else {
        result[key] = SCHEMA_VALUES.has(key) ? visit(child) : child;
      }
    }
    if (result.type === 'object' && result.additionalProperties === undefined) result.additionalProperties = false;
    if (Object.keys(bounds).length > 0) {
      const description = typeof result.description === 'string' ? `${result.description}\n` : '';
      result.description = `${description}Constraints: ${JSON.stringify(bounds)}`;
    }
    return result;
  };
  return visit(schema) as StructuredGenerationJsonSchema;
}

/**
 * Claude compiles a strict schema into a grammar and refuses one that grows too large (HTTP 400, "The compiled
 * grammar is too large"). Measured on 2026-11-19 through OpenRouter on Sonnet 5.5 and 4.6 over 24 variants of Ask's
 * answer schema: what counts is the number of schema positions (every object, array, scalar and anyOf), not bytes,
 * descriptions, enum values, optional fields or $ref sharing. 69 positions were accepted and 70 refused. Ask's
 * step schema has 43 and its answer schemas 78 to 89, so this limit sits between them with room on both sides.
 */
const CLAUDE_GRAMMAR_MAX_SCHEMA_POSITIONS = 60;

/** Whether Claude can hold `schema` as a strict grammar. A schema it cannot hold is sent as a tool instead. */
export function claudeGrammarHolds(schema: StructuredGenerationJsonSchema): boolean {
  const positions = (value: unknown): number => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return 0;
    let count = 1;
    for (const [key, child] of Object.entries(value)) {
      if (SCHEMA_MAPS.has(key) && child !== null && typeof child === 'object' && !Array.isArray(child)) {
        for (const entry of Object.values(child)) count += positions(entry);
      } else if (SCHEMA_ARRAYS.has(key) && Array.isArray(child)) {
        for (const entry of child) count += positions(entry);
      } else if (SCHEMA_VALUES.has(key)) count += positions(child);
    }
    return count;
  };
  return positions(schema) <= CLAUDE_GRAMMAR_MAX_SCHEMA_POSITIONS;
}
