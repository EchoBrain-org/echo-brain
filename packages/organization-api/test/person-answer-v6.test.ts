import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import { validatePersonAnswerCitationV6, validatePersonAnswerResponseV8 } from '../src/index.js';

const page = { kind: 'page' as const, tool_id: 'knowledge', external_scope_id: 'site-123', page_id: 'page-456', section_id: 's2', version: '42', permalink: 'https://knowledge.example.test/wiki/pages/viewpage.action?pageId=456', text_sha256: canonicalSha256('Launch is Tuesday.') };
const cited = { citation: page, kind: 'page' as const, label: 'Launch plan', visibility: 'only_me' as const };
const response = () => ({ schema_version: 8 as const, kind: 'echo-clean-person-answer-v8' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const, citations: [cited], parts: [{ question: 'When is launch?', status: 'answered' as const, statements: [{ text: 'The page says launch is Tuesday.', citation_indexes: [0], private: true }] }] });

describe('Live page citations', () => {
  it('cite a page section in an answer and on an impact card', () => {
    expect(validatePersonAnswerResponseV8(response()).citations).toEqual([cited]);
    expect(validatePersonAnswerCitationV6(cited)).toEqual(cited);
  });

  it('rejects mismatched kinds, open references and duplicate stable page coordinates', () => {
    expect(() => validatePersonAnswerResponseV8({ ...response(), citations: [{ ...cited, kind: 'note' }] })).toThrow();
    expect(() => validatePersonAnswerResponseV8({ ...response(), citations: [{ ...cited, ref: `meeting:${canonicalSha256('x')}` }] })).toThrow();
    expect(() => validatePersonAnswerResponseV8({ ...response(), citations: [cited, { ...cited, citation: { ...page, text_sha256: canonicalSha256('changed') } }] })).toThrow('duplicate citations');
  });
});
