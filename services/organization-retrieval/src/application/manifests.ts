import { canonicalJson, canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import {
  READABLE_SEARCH_ANALYZER_ID,
  READABLE_SEARCH_CONTRACT_ID,
  type ReadableSearchGenerationManifest,
  type ReadableSearchSegmentManifest,
  ReadableSearchValidationError,
} from './contracts.js';
import {
  assertReadableSearchDigest,
  assertReadableSearchIdentifier,
  assertReadableSearchRecordHead,
  assertReadableSearchSegmentIdentity,
  assertSafeNonNegativeInteger,
} from './validation.js';
import {
  organizationMemberSegmentIdentity,
  reviewerSegmentIdentity,
} from './segment-identity.js';

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    throw new ReadableSearchValidationError(`${label} has an unexpected shape`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReadableSearchValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function readableSearchSegmentManifestSha256(
  manifest: ReadableSearchSegmentManifest,
): `sha256:${string}` {
  const validated = validateReadableSearchSegmentManifest(manifest);
  return sha256Digest(canonicalJson(validated));
}

export function createReadableSearchSegmentManifest(
  input: Omit<ReadableSearchSegmentManifest, 'schema_version' | 'kind' | 'analyzer_id'>,
): ReadableSearchSegmentManifest {
  const identity = assertReadableSearchSegmentIdentity(input);
  const expectedIdentity =
    identity.segment_kind === 'organization-member'
      ? organizationMemberSegmentIdentity({
          organization_id: identity.organization_id,
          policy_contract_sha256: identity.policy_contract_sha256,
        })
      : reviewerSegmentIdentity({
          organization_id: identity.organization_id,
          policy_contract_sha256: identity.policy_contract_sha256,
          reviewer_principal_id: identity.reviewer_principal_id!,
          reviewer_membership_id: identity.reviewer_membership_id!,
        });
  if (identity.segment_id !== expectedIdentity.segment_id) {
    throw new ReadableSearchValidationError('segment_id does not match its closed identity preimage');
  }
  const counts = [
    ['fact_count', input.fact_count],
    ['content_count', input.content_count],
    ['document_count', input.document_count],
    ['posting_count', input.posting_count],
  ] as const;
  for (const [label, count] of counts) assertSafeNonNegativeInteger(count, label);
  return Object.freeze({
    schema_version: 1,
    kind: 'readable-search-segment-manifest-v1',
    ...identity,
    analyzer_id: READABLE_SEARCH_ANALYZER_ID,
    analyzer_contract_sha256: assertReadableSearchDigest(
      input.analyzer_contract_sha256,
      'analyzer_contract_sha256',
    ),
    facts_root: assertReadableSearchDigest(input.facts_root, 'facts_root'),
    content_root: assertReadableSearchDigest(input.content_root, 'content_root'),
    lexical_root: assertReadableSearchDigest(input.lexical_root, 'lexical_root'),
    fact_count: input.fact_count,
    content_count: input.content_count,
    document_count: input.document_count,
    posting_count: input.posting_count,
  });
}

export function validateReadableSearchSegmentManifest(
  value: unknown,
): ReadableSearchSegmentManifest {
  const record = object(value, 'segment manifest');
  exactKeys(record, [
    'schema_version', 'kind', 'organization_id', 'segment_id', 'segment_kind', 'policy_id',
    'policy_contract_sha256', 'reviewer_principal_id', 'reviewer_membership_id', 'analyzer_id',
    'analyzer_contract_sha256', 'facts_root', 'content_root', 'lexical_root', 'fact_count',
    'content_count', 'document_count', 'posting_count',
  ], 'segment manifest');
  if (record.schema_version !== 1 || record.kind !== 'readable-search-segment-manifest-v1') {
    throw new ReadableSearchValidationError('segment manifest identity is unsupported');
  }
  if (record.analyzer_id !== READABLE_SEARCH_ANALYZER_ID) {
    throw new ReadableSearchValidationError('segment manifest analyzer is unsupported');
  }
  const generated = createReadableSearchSegmentManifest({
    organization_id: record.organization_id as string,
    segment_id: record.segment_id as `sha256:${string}`,
    segment_kind: record.segment_kind as 'organization-member' | 'reviewer',
    policy_id: record.policy_id as ReadableSearchSegmentManifest['policy_id'],
    policy_contract_sha256: record.policy_contract_sha256 as `sha256:${string}`,
    reviewer_principal_id: record.reviewer_principal_id as string | null,
    reviewer_membership_id: record.reviewer_membership_id as string | null,
    analyzer_contract_sha256: record.analyzer_contract_sha256 as `sha256:${string}`,
    facts_root: record.facts_root as `sha256:${string}`,
    content_root: record.content_root as `sha256:${string}`,
    lexical_root: record.lexical_root as `sha256:${string}`,
    fact_count: record.fact_count as number,
    content_count: record.content_count as number,
    document_count: record.document_count as number,
    posting_count: record.posting_count as number,
  });
  if (canonicalJson(record) !== canonicalJson(generated)) {
    throw new ReadableSearchValidationError(
      'segment manifest does not equal its exact canonical validated object',
    );
  }
  return generated;
}

function readableSearchGenerationIdentity(
  manifest: Omit<
    ReadableSearchGenerationManifest,
    'generation_id' | 'kind' | 'schema_version'
  >,
): `sha256:${string}` {
  return canonicalSha256({
    schema_version: 1,
    kind: 'readable-search-generation-identity-v1',
    organization_id: manifest.organization_id,
    retrieval_contract_id: manifest.retrieval_contract_id,
    retrieval_contract_sha256: manifest.retrieval_contract_sha256,
    source_revision: manifest.source_revision,
    builder_artifact_sha256: manifest.builder_artifact_sha256,
    input_contract_version: manifest.input_contract_version,
    policies: manifest.policies,
    record_head: manifest.record_head,
    input_cursor: manifest.input_cursor,
    upstream_input_root: manifest.upstream_input_root,
    roots: manifest.roots,
    segments: manifest.segments,
    analyzer: manifest.analyzer,
    index: manifest.index,
  });
}

export function createReadableSearchGenerationManifest(
  input: Omit<
    ReadableSearchGenerationManifest,
    'schema_version' | 'kind' | 'generation_id' | 'retrieval_contract_id'
  >,
): ReadableSearchGenerationManifest {
  const recordHead = assertReadableSearchRecordHead(input.record_head, 'record_head');
  const cursor = assertReadableSearchRecordHead(input.input_cursor, 'input_cursor');
  if (recordHead.position !== cursor.position || recordHead.record_hash !== cursor.record_hash) {
    throw new ReadableSearchValidationError('generation record head and input cursor disagree');
  }
  const policies = [...input.policies].map((policy) => Object.freeze({
    policy_id: policy.policy_id,
    policy_contract_sha256: assertReadableSearchDigest(policy.policy_contract_sha256, 'policy contract'),
  }));
  if (policies.length !== 2 || policies[0]?.policy_id !== 'organization-member-readable-v1' || policies[1]?.policy_id !== 'restricted-reviewer-v1') {
    throw new ReadableSearchValidationError('generation policies must be the exact ordered V1 pair');
  }
  const segments = [...input.segments].sort((left, right) =>
    Buffer.compare(Buffer.from(left.segment_id), Buffer.from(right.segment_id)),
  );
  if (segments.some((segment, index) => index > 0 && segment.segment_id === segments[index - 1]!.segment_id)) {
    throw new ReadableSearchValidationError('generation segments are duplicated');
  }
  const withoutIdentity = {
    schema_version: 1 as const,
    organization_id: assertReadableSearchIdentifier(input.organization_id, 'generation organization_id'),
    retrieval_contract_id: READABLE_SEARCH_CONTRACT_ID,
    retrieval_contract_sha256: assertReadableSearchDigest(input.retrieval_contract_sha256, 'retrieval_contract_sha256'),
    source_revision: assertReadableSearchIdentifier(input.source_revision, 'source_revision'),
    builder_artifact_sha256: assertReadableSearchDigest(input.builder_artifact_sha256, 'builder_artifact_sha256'),
    input_contract_version: 1 as const,
    policies: Object.freeze(policies),
    record_head: recordHead,
    input_cursor: cursor,
    upstream_input_root: assertReadableSearchDigest(input.upstream_input_root, 'upstream_input_root'),
    roots: Object.freeze({
      facts_root: assertReadableSearchDigest(input.roots.facts_root, 'generation facts_root'),
      content_root: assertReadableSearchDigest(input.roots.content_root, 'generation content_root'),
      lexical_root: assertReadableSearchDigest(input.roots.lexical_root, 'generation lexical_root'),
    }),
    segments: Object.freeze(segments.map((segment) => Object.freeze({
      segment_id: assertReadableSearchDigest(segment.segment_id, 'generation segment_id'),
      segment_manifest_sha256: assertReadableSearchDigest(segment.segment_manifest_sha256, 'segment_manifest_sha256'),
      facts_root: assertReadableSearchDigest(segment.facts_root, 'segment facts_root'),
      content_root: assertReadableSearchDigest(segment.content_root, 'segment content_root'),
      lexical_root: assertReadableSearchDigest(segment.lexical_root, 'segment lexical_root'),
    }))),
    analyzer: Object.freeze({
      analyzer_id: READABLE_SEARCH_ANALYZER_ID,
      analyzer_contract_sha256: assertReadableSearchDigest(input.analyzer.analyzer_contract_sha256, 'analyzer_contract_sha256'),
      analyzer_source_sha256: assertReadableSearchDigest(input.analyzer.analyzer_source_sha256, 'analyzer_source_sha256'),
      node_version: assertReadableSearchIdentifier(input.analyzer.node_version, 'node_version'),
      unicode_version: assertReadableSearchIdentifier(input.analyzer.unicode_version, 'unicode_version'),
      icu_version: assertReadableSearchIdentifier(input.analyzer.icu_version, 'icu_version'),
    }),
    index: Object.freeze({
      format_version: 1 as const,
      sqlite_version: assertReadableSearchIdentifier(input.index.sqlite_version, 'sqlite_version'),
    }),
  };
  const generationId = readableSearchGenerationIdentity(withoutIdentity);
  return Object.freeze({
    kind: 'readable-search-generation-manifest-v1',
    generation_id: generationId,
    ...withoutIdentity,
  });
}

export function readableSearchGenerationManifestSha256(
  manifest: ReadableSearchGenerationManifest,
): `sha256:${string}` {
  const validated = validateReadableSearchGenerationManifest(manifest);
  return sha256Digest(canonicalJson(validated));
}

export function validateReadableSearchGenerationManifest(
  value: unknown,
): ReadableSearchGenerationManifest {
  const record = object(value, 'generation manifest');
  exactKeys(record, [
    'schema_version', 'kind', 'organization_id', 'generation_id', 'retrieval_contract_id',
    'retrieval_contract_sha256', 'source_revision', 'builder_artifact_sha256',
    'input_contract_version', 'policies', 'record_head', 'input_cursor', 'upstream_input_root',
    'roots', 'segments', 'analyzer', 'index',
  ], 'generation manifest');
  if (
    record.schema_version !== 1 ||
    record.kind !== 'readable-search-generation-manifest-v1' ||
    record.retrieval_contract_id !== READABLE_SEARCH_CONTRACT_ID ||
    record.input_contract_version !== 1 ||
    !Array.isArray(record.policies) ||
    !Array.isArray(record.segments)
  ) {
    throw new ReadableSearchValidationError('generation manifest identity is unsupported');
  }

  const policies = record.policies.map((value, index) => {
    const policy = object(value, `generation policy ${index}`);
    exactKeys(
      policy,
      ['policy_id', 'policy_contract_sha256'],
      `generation policy ${index}`,
    );
    return policy;
  });
  if (
    policies.length !== 2 ||
    policies[0]?.policy_id !== 'organization-member-readable-v1' ||
    policies[1]?.policy_id !== 'restricted-reviewer-v1'
  ) {
    throw new ReadableSearchValidationError(
      'generation policies must be the exact ordered V1 pair',
    );
  }

  const recordHead = object(record.record_head, 'generation record head');
  exactKeys(
    recordHead,
    ['position', 'record_hash'],
    'generation record head',
  );
  const inputCursor = object(record.input_cursor, 'generation input cursor');
  exactKeys(
    inputCursor,
    ['position', 'record_hash'],
    'generation input cursor',
  );

  const analyzer = object(record.analyzer, 'generation analyzer');
  exactKeys(analyzer, [
    'analyzer_id',
    'analyzer_contract_sha256',
    'analyzer_source_sha256',
    'node_version',
    'unicode_version',
    'icu_version',
  ], 'generation analyzer');
  if (analyzer.analyzer_id !== READABLE_SEARCH_ANALYZER_ID) {
    throw new ReadableSearchValidationError(
      'generation analyzer identity is unsupported',
    );
  }

  const index = object(record.index, 'generation index');
  exactKeys(index, ['format_version', 'sqlite_version'], 'generation index');
  if (index.format_version !== 1) {
    throw new ReadableSearchValidationError(
      'generation index identity is unsupported',
    );
  }

  const roots = object(record.roots, 'generation roots');
  exactKeys(
    roots,
    ['facts_root', 'content_root', 'lexical_root'],
    'generation roots',
  );

  const segments = record.segments.map((value, index) => {
    const segment = object(value, `generation segment ${index}`);
    exactKeys(segment, [
      'segment_id',
      'segment_manifest_sha256',
      'facts_root',
      'content_root',
      'lexical_root',
    ], `generation segment ${index}`);
    return segment;
  });
  const segmentIds = segments.map((segment) =>
    assertReadableSearchDigest(segment.segment_id, 'generation segment_id')
  );
  if (
    segmentIds.some((segmentId, index) =>
      index > 0 &&
      Buffer.compare(Buffer.from(segmentIds[index - 1]!), Buffer.from(segmentId)) >= 0
    )
  ) {
    throw new ReadableSearchValidationError(
      'generation segments must be ordered by segment_id without duplicates',
    );
  }

  const generated = createReadableSearchGenerationManifest({
    organization_id: record.organization_id as string,
    retrieval_contract_sha256: record.retrieval_contract_sha256 as `sha256:${string}`,
    source_revision: record.source_revision as string,
    builder_artifact_sha256: record.builder_artifact_sha256 as `sha256:${string}`,
    input_contract_version: 1,
    policies: policies as unknown as ReadableSearchGenerationManifest['policies'],
    record_head: recordHead as unknown as ReadableSearchGenerationManifest['record_head'],
    input_cursor: inputCursor as unknown as ReadableSearchGenerationManifest['input_cursor'],
    upstream_input_root: record.upstream_input_root as `sha256:${string}`,
    roots: roots as unknown as ReadableSearchGenerationManifest['roots'],
    segments: segments as unknown as ReadableSearchGenerationManifest['segments'],
    analyzer: analyzer as unknown as ReadableSearchGenerationManifest['analyzer'],
    index: index as unknown as ReadableSearchGenerationManifest['index'],
  });
  if (record.generation_id !== generated.generation_id) {
    throw new ReadableSearchValidationError('generation_id does not match its closed identity preimage');
  }
  if (canonicalJson(record) !== canonicalJson(generated)) {
    throw new ReadableSearchValidationError(
      'generation manifest does not equal its exact canonical validated object',
    );
  }
  return generated;
}
