import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import { PERSON_ANSWER_PATH_V5, validatePersonAnswerResponseV4, validatePersonAnswerResponseV5, validatePersonAnswerResponseV6 } from '../src/index.js';

const page = { kind: 'page' as const, tool_id: 'knowledge', external_scope_id: 'site-123', page_id: 'page-456', section_id: 's2', version: '42', permalink: 'https://knowledge.example.test/wiki/pages/viewpage.action?pageId=456', text_sha256: canonicalSha256('Launch is Tuesday.') };
const cited = { citation: page, kind: 'page' as const, label: 'Launch plan', visibility: 'only_me' as const };
const response = () => ({ schema_version: 6 as const, kind: 'echo-clean-person-answer-v6' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const, citations: [cited], parts: [{ question: 'When is launch?', status: 'answered' as const, statements: [{ text: 'The page says launch is Tuesday.', citation_indexes: [0], private: true }] }] });

describe('Live-page answer V6', () => {
  it('adds an explicit route while retaining V5 strictness', () => {
    expect(PERSON_ANSWER_PATH_V5).toBe('/v5/person/ask');
    expect(validatePersonAnswerResponseV6(response()).citations).toEqual([cited]);
    expect(() => validatePersonAnswerResponseV5({ ...response(), schema_version: 5, kind: 'echo-clean-person-answer-v5' })).toThrow();
    expect(() => validatePersonAnswerResponseV4({ ...response(), schema_version: 4, kind: 'echo-clean-person-answer-v4' })).toThrow();
  });

  it('rejects mismatched kinds, open references and duplicate stable page coordinates', () => {
    expect(() => validatePersonAnswerResponseV6({ ...response(), citations: [{ ...cited, kind: 'note' }] })).toThrow();
    expect(() => validatePersonAnswerResponseV6({ ...response(), citations: [{ ...cited, ref: `meeting:${canonicalSha256('x')}` }] })).toThrow();
    expect(() => validatePersonAnswerResponseV6({ ...response(), citations: [cited, { ...cited, citation: { ...page, text_sha256: canonicalSha256('changed') } }] })).toThrow('duplicate citations');
  });
});
