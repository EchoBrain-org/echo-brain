import { describe, expect, it } from 'vitest';
import { marked, snippet } from '../../src/renderer/format.js';

describe('a match shows why it matched', () => {
  it('marks the query\'s words in a title, and finds them in the text when the title has none', () => {
    expect(marked('Pricing decision', ['pricing'])).toEqual([{ text: 'Pricing', hit: true }, { text: ' decision', hit: false }]);
    expect(marked('No words', [])).toEqual([{ text: 'No words', hit: false }]);
    expect(snippet('Apollo moves to usage-based pricing tiers from October and then on to the rest of the plan', ['pricing']))
      .toBe('…moves to usage-based pricing tiers from October…');
    expect(snippet('Short pricing note', ['pricing'])).toBe('Short pricing note');
    expect(snippet('Nothing here', ['pricing'])).toBeNull();
  });
});
