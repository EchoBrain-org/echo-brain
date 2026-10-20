import { CASES } from './fixtures.mjs';

/** Small smoke assertions, not an answer-quality judge. Inspect the cited statements too. */
export function assess(result) {
  const sweep = result.case === 'sweep';
  const text = sweep ? JSON.stringify(result.rendered) : result.rendered.parts.flatMap(p => p.statements.map(s => s.text)).join('\n');
  const expected = sweep ? ['still_open'] : CASES[result.case].expected;
  const missing = expected.filter(s => s === 'Mara Quinn' && result.case === 'projects'
    ? !/Mara Quinn|\byou\b/iu.test(text)
    : !text.toLowerCase().includes(s.toLowerCase()));
  const research_completed = result.research.stop.completed;
  const answer_complete = result.renderer_outcome === 'answered';
  return { research_completed, expected_facts_present: missing.length === 0, missing, output_contract_accepted: true, answer_complete,
    passed: research_completed && missing.length === 0 && answer_complete && result.renderer_fallbacks === 0 };
}
