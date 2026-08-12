import { describe, expect, it } from 'vitest';
import { sha256Digest } from '@echo-brain/federation-protocol';
import {
  createReadableSearchAnalyzerContract,
  createReadableSearchAnalyzerDescriptor,
  createReadableSearchRetrievalContract,
  readableSearchAnalyzerContractSha256,
  readableSearchRetrievalContractSha256,
  readableSearchSourceBytesSha256,
} from '../src/index.js';

const digest = (value: string): `sha256:${string}` =>
  /^[0-9a-f]$/u.test(value)
    ? `sha256:${value.padEnd(64, '0')}`
    : sha256Digest(value);

describe('readable-search retrieval contracts', () => {
  it('pins analyzer source bytes and exact analyzer/retrieval contract digests', () => {
    expect(readableSearchSourceBytesSha256(new TextEncoder().encode('released analyzer bytes')))
      .toBe(sha256Digest('released analyzer bytes'));
    const analyzer = createReadableSearchAnalyzerContract({ analyzer_source_sha256: digest('a') });
    expect(analyzer.order).toEqual(['score-desc', 'log-position-desc', 'atom-order-asc', 'atom-id-asc']);
    expect(readableSearchAnalyzerContractSha256({ analyzer_source_sha256: digest('a') }))
      .toBe('sha256:1bf844cacc58dda5ff1be144dc6819c98e5a714b98f6316e4ea54fecd4f1649f');
    const descriptor = createReadableSearchAnalyzerDescriptor({
      analyzer_source_sha256: digest('a'), node_version: '22.22.1', unicode_version: '16.0', icu_version: '76.1',
    });
    const contract = createReadableSearchRetrievalContract({
      analyzer_contract_sha256: descriptor.analyzer_contract_sha256,
      organization_member_policy_contract_sha256: digest('c'),
      restricted_reviewer_policy_contract_sha256: digest('d'),
    });
    expect(contract.policies).toEqual([
      { policy_id: 'organization-member-readable-v1', policy_contract_sha256: digest('c'), witness: 'You may read this item because it was explicitly approved for current active owner or employee members, including members admitted after approval, and your membership is active.' },
      { policy_id: 'restricted-reviewer-v1', policy_contract_sha256: digest('d'), witness: 'You may read this item because it records you as the approving reviewer and that exact reviewer membership is currently active.' },
    ]);
    expect(readableSearchRetrievalContractSha256({
      analyzer_contract_sha256: digest('b'), organization_member_policy_contract_sha256: digest('c'), restricted_reviewer_policy_contract_sha256: digest('d'),
    })).toBe('sha256:b8896074616aa2ac0eb5245343add081e82ae6f694985b174478b78c4a6127e9');
  });
});
