import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Digest } from '@echo-brain/federation-protocol';
import {
  createReadableSearchGenerationManifest,
  createReadableSearchSegmentManifest,
  organizationMemberSegmentIdentity,
  readableSearchContentRoot,
  readableSearchFactsRoot,
  readableSearchGenerationManifestSha256,
  readableSearchGenerationPlaneRoot,
  readableSearchLexicalRoot,
  readableSearchSegmentManifestSha256,
  validateReadableSearchSegmentManifest,
  validateReadableSearchGenerationManifest,
} from '../src/index.js';

const digest = (value: string): `sha256:${string}` =>
  `sha256:${value.padEnd(64, '0').slice(0, 64)}`;

describe('retrieval roots and manifests', () => {
  it('builds roots independent of input enumeration order', () => {
    const identity = organizationMemberSegmentIdentity({ organization_id: 'org_test', policy_contract_sha256: digest('1') });
    const facts = [
      {
        atom_id: digest('a'), organization_id: 'org_test', envelope_sha256: digest('b'), log_position: 2,
        record_hash: digest('c'), atom_order: 0, signal_id_sha256: digest('d'), item_kind: 'decision' as const,
        policy_id: 'organization-member-readable-v1' as const, policy_contract_sha256: digest('1'),
        approval_actor_principal_id: 'prn_actor', approval_actor_membership_id: 'mem_actor',
        reviewer_principal_id: null, reviewer_membership_id: null, release_draft_sha256: digest('e'),
        approval_presentation_sha256: digest('f'), semantic_intent_sha256: digest('0'),
        message_presentation_sha256: digest('3'), authorization_audit_event_id: 'aud_test',
        authorization_audit_entry_sha256: digest('4'), evaluated_at: '2026-01-01T00:00:00.000Z',
        authorization_proof_sha256: digest('5'), content_binding_sha256: digest('6'), provenance_binding_sha256: digest('7'),
      },
    ];
    const factsRoot = readableSearchFactsRoot(identity.segment_id, facts);
    const contentRoot = readableSearchContentRoot(identity.segment_id, [{
      atom_id: digest('a'), log_position: 2, record_hash: digest('c'), atom_order: 0, item_kind: 'decision',
      text: 'text', text_sha256: sha256Digest('text'), content_binding_sha256: digest('6'), provenance_binding_sha256: digest('7'),
    }]);
    const lexicalRoot = readableSearchLexicalRoot({
      segment_id: identity.segment_id,
      documents: [{ atom_id: digest('a'), log_position: 2, atom_order: 0, content_binding_sha256: digest('6') }],
      postings: [{ term: 'text', atom_id: digest('a'), term_frequency: 1 }],
    });
    const manifest = createReadableSearchSegmentManifest({
      ...identity, analyzer_contract_sha256: digest('8'), facts_root: factsRoot,
      content_root: contentRoot, lexical_root: lexicalRoot, fact_count: 1, content_count: 1,
      document_count: 1, posting_count: 1,
    });
    expect(validateReadableSearchSegmentManifest(JSON.parse(canonicalJson(manifest)))).toEqual(manifest);
    expect(readableSearchSegmentManifestSha256(manifest)).toMatch(/^sha256:/);
    const segment = {
      segment_id: identity.segment_id, segment_manifest_sha256: readableSearchSegmentManifestSha256(manifest),
      facts_root: factsRoot, content_root: contentRoot, lexical_root: lexicalRoot,
    };
    const generation = createReadableSearchGenerationManifest({
      organization_id: 'org_test', retrieval_contract_sha256: digest('9'), source_revision: 'source-1',
      builder_artifact_sha256: digest('a1'), input_contract_version: 1,
      policies: [
        { policy_id: 'organization-member-readable-v1', policy_contract_sha256: digest('1') },
        { policy_id: 'restricted-reviewer-v1', policy_contract_sha256: digest('2') },
      ],
      record_head: { position: 2, record_hash: digest('c') }, input_cursor: { position: 2, record_hash: digest('c') },
      upstream_input_root: digest('b1'),
      roots: {
        facts_root: readableSearchGenerationPlaneRoot({ plane: 'facts', segments: [segment] }),
        content_root: readableSearchGenerationPlaneRoot({ plane: 'content', segments: [segment] }),
        lexical_root: readableSearchGenerationPlaneRoot({ plane: 'lexical', segments: [segment] }),
      },
      segments: [segment],
      analyzer: { analyzer_id: 'echo-unicode-alnum-frequency-v1', analyzer_contract_sha256: digest('8'), analyzer_source_sha256: digest('c1'), node_version: '22.22.1', unicode_version: '16.0', icu_version: '76.1' },
      index: { format_version: 1, sqlite_version: '3.50.4' },
    });
    expect(readableSearchGenerationManifestSha256(generation)).toMatch(/^sha256:/);
    expect(generation.generation_id).toMatch(/^sha256:/);
    expect(validateReadableSearchGenerationManifest(JSON.parse(canonicalJson(generation)))).toEqual(generation);
    expect(() => validateReadableSearchGenerationManifest({ ...generation, generation_id: digest('tampered') }))
      .toThrow('generation_id');
  });
});
