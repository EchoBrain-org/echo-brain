import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess } from '../assess.mjs';
const result = (text, outcome = 'answered') => ({ case: 'projects', research: { stop: { completed: true } }, renderer_outcome: outcome, renderer_fallbacks: 0, rendered: { parts: [{ statements: [{ text }] }] } });
test('the requester may be addressed as you instead of repeating their name', () => {
  assert.equal(assess(result('You lead Atlas; Tobias Lund leads Beacon.')).passed, true);
});
test('a partial final answer does not pass even when expected names are present', () => {
  const checked = assess(result('Mara Quinn leads Atlas; Tobias Lund leads Beacon.', 'partial'));
  assert.equal(checked.expected_facts_present, true); assert.equal(checked.passed, false);
});
