import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
} from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_MEMBER_POLICY_ID,
  RESTRICTED_REVIEWER_POLICY_ID,
  type ReadableSearchStoppedBuildInput,
  type RetrievalPermissionFact,
  ReadableSearchValidationError,
} from './contracts.js';
import {
  assertReadableSearchDigest,
  assertReadableSearchIdentifier,
  assertReadableSearchRecordHead,
  assertSafePositiveInteger,
} from './validation.js';

const PREIMAGE_KEYS = Object.freeze([
  'schema_version',
  'kind',
  'organization_id',
  'input_contract_version',
  'record_head',
  'rows',
]);
const RECORD_HEAD_KEYS = Object.freeze(['position', 'record_hash']);
const ROW_KEYS = Object.freeze([
  'classification',
  'log_position',
  'record_hash',
  'envelope_sha256',
  'items',
]);
const FACT_KEYS = Object.freeze([
  'atom_id',
  'organization_id',
  'envelope_sha256',
  'log_position',
  'record_hash',
  'atom_order',
  'signal_id_sha256',
  'item_kind',
  'policy_id',
  'policy_contract_sha256',
  'approval_actor_principal_id',
  'approval_actor_membership_id',
  'reviewer_principal_id',
  'reviewer_membership_id',
  'release_draft_sha256',
  'approval_presentation_sha256',
  'semantic_intent_sha256',
  'message_presentation_sha256',
  'authorization_audit_event_id',
  'authorization_audit_entry_sha256',
  'evaluated_at',
  'authorization_proof_sha256',
  'content_binding_sha256',
  'provenance_binding_sha256',
]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReadableSearchValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedKeys);
  const actual = Object.keys(value);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    throw new ReadableSearchValidationError(`${label} has an unexpected shape`);
  }
}

function compareFacts(
  left: RetrievalPermissionFact,
  right: RetrievalPermissionFact,
): number {
  return (
    left.log_position - right.log_position ||
    left.atom_order - right.atom_order ||
    Buffer.compare(Buffer.from(left.atom_id), Buffer.from(right.atom_id))
  );
}

export function validateReadableSearchRetrievalPermissionFact(
  value: unknown,
  label: string,
): RetrievalPermissionFact {
  const fact = object(value, label);
  exactKeys(fact, FACT_KEYS, label);
  return value as RetrievalPermissionFact;
}

/** Independent consumer-side recomputation of the closed Layer 1 binding. */
export function readableSearchContentBindingSha256(
  input: {
    readonly fact: RetrievalPermissionFact;
    readonly text_sha256: `sha256:${string}`;
  },
): `sha256:${string}` {
  const { fact } = input;
  return canonicalSha256({
    schema_version: 1,
    kind: 'organization-record-item-content-binding-v1',
    organization_id: fact.organization_id,
    envelope_sha256: fact.envelope_sha256,
    log_position: fact.log_position,
    record_hash: fact.record_hash,
    atom_id: fact.atom_id,
    atom_order: fact.atom_order,
    signal_id_sha256: fact.signal_id_sha256,
    item_kind: fact.item_kind,
    text_sha256: input.text_sha256,
  });
}

/** Independent consumer-side recomputation of the closed Layer 1 binding. */
export function readableSearchProvenanceBindingSha256(
  fact: RetrievalPermissionFact,
): `sha256:${string}` {
  if (fact.policy_id === RESTRICTED_REVIEWER_POLICY_ID) {
    if (
      fact.reviewer_principal_id === null ||
      fact.reviewer_membership_id === null ||
      fact.approval_actor_principal_id !== fact.reviewer_principal_id ||
      fact.approval_actor_membership_id !== fact.reviewer_membership_id
    ) {
      throw new ReadableSearchValidationError(
        'reviewer admitted atom has an invalid approval actor binding',
      );
    }
    return canonicalSha256({
      schema_version: 1,
      kind: 'organization-record-policy-provenance-binding-v1',
      organization_id: fact.organization_id,
      envelope_sha256: fact.envelope_sha256,
      log_position: fact.log_position,
      record_hash: fact.record_hash,
      policy_id: RESTRICTED_REVIEWER_POLICY_ID,
      policy_contract_sha256: fact.policy_contract_sha256,
      reviewer_principal_id: fact.reviewer_principal_id,
      reviewer_membership_id: fact.reviewer_membership_id,
      release_draft_sha256: fact.release_draft_sha256,
      approval_presentation_sha256: fact.approval_presentation_sha256,
      semantic_intent_sha256: fact.semantic_intent_sha256,
      message_presentation_sha256: fact.message_presentation_sha256,
      authorization_audit_event_id: fact.authorization_audit_event_id,
      authorization_audit_entry_sha256:
        fact.authorization_audit_entry_sha256,
      authorization_proof_sha256: fact.authorization_proof_sha256,
      evaluated_at: fact.evaluated_at,
    });
  }
  if (
    fact.reviewer_principal_id !== null ||
    fact.reviewer_membership_id !== null
  ) {
    throw new ReadableSearchValidationError(
      'organization-member admitted atom has reviewer identity fields',
    );
  }
  return canonicalSha256({
    schema_version: 1,
    kind: 'organization-record-policy-provenance-binding-v1',
    organization_id: fact.organization_id,
    envelope_sha256: fact.envelope_sha256,
    log_position: fact.log_position,
    record_hash: fact.record_hash,
    policy_id: ORGANIZATION_MEMBER_POLICY_ID,
    policy_contract_sha256: fact.policy_contract_sha256,
    approving_principal_id: fact.approval_actor_principal_id,
    approving_membership_id: fact.approval_actor_membership_id,
    release_draft_sha256: fact.release_draft_sha256,
    approval_presentation_sha256: fact.approval_presentation_sha256,
    semantic_intent_sha256: fact.semantic_intent_sha256,
    message_presentation_sha256: fact.message_presentation_sha256,
    authorization_audit_event_id: fact.authorization_audit_event_id,
    authorization_audit_entry_sha256:
      fact.authorization_audit_entry_sha256,
    authorization_proof_sha256: fact.authorization_proof_sha256,
    evaluated_at: fact.evaluated_at,
  });
}

/**
 * Closes the stopped builder's Layer 1 boundary before it creates staging
 * state. The root is derived only from the supplied dense preimage, and that
 * preimage must contain exactly the same permission facts as the atoms.
 */
export function assertReadableSearchUpstreamInputBinding(
  input: ReadableSearchStoppedBuildInput,
): `sha256:${string}` {
  const seenAtomIds = new Set<string>();
  const atomFacts = input.atoms.map((atom, index) => {
    const fact = validateReadableSearchRetrievalPermissionFact(
      atom.fact,
      `admitted atom ${index} fact`,
    );
    if (seenAtomIds.has(fact.atom_id)) {
      throw new ReadableSearchValidationError(
        'duplicate atom identity across retrieval segments',
      );
    }
    seenAtomIds.add(fact.atom_id);
    if (sha256Digest(atom.text) !== atom.text_sha256) {
      throw new ReadableSearchValidationError(
        'admitted atom text does not bind text_sha256',
      );
    }
    if (
      readableSearchContentBindingSha256({
        fact,
        text_sha256: atom.text_sha256,
      }) !== fact.content_binding_sha256
    ) {
      throw new ReadableSearchValidationError(
        'admitted atom text does not bind its Layer 1 content fact',
      );
    }
    if (
      readableSearchProvenanceBindingSha256(fact) !==
      fact.provenance_binding_sha256
    ) {
      throw new ReadableSearchValidationError(
        'admitted atom does not bind its Layer 1 provenance fact',
      );
    }
    return fact;
  }).sort(compareFacts);
  const preimage = object(
    input.upstream_input_preimage,
    'readable-search upstream input preimage',
  );
  exactKeys(preimage, PREIMAGE_KEYS, 'readable-search upstream input preimage');
  if (
    preimage.schema_version !== 1 ||
    preimage.kind !== 'readable-search-upstream-input-root-v1' ||
    preimage.input_contract_version !== 1
  ) {
    throw new ReadableSearchValidationError(
      'readable-search upstream input preimage identity is unsupported',
    );
  }

  const organizationId = assertReadableSearchIdentifier(
    preimage.organization_id,
    'upstream input organization_id',
  );
  if (organizationId !== input.organization_id) {
    throw new ReadableSearchValidationError(
      'upstream input organization disagrees with build input',
    );
  }

  const preimageHeadValue = object(preimage.record_head, 'upstream input record_head');
  exactKeys(preimageHeadValue, RECORD_HEAD_KEYS, 'upstream input record_head');
  const preimageHead = assertReadableSearchRecordHead(
    preimageHeadValue as unknown as ReadableSearchStoppedBuildInput['record_head'],
    'upstream input record_head',
  );
  const inputHead = assertReadableSearchRecordHead(input.record_head, 'record_head');
  if (
    preimageHead.position !== inputHead.position ||
    preimageHead.record_hash !== inputHead.record_hash
  ) {
    throw new ReadableSearchValidationError(
      'upstream input record_head disagrees with build input',
    );
  }

  if (!Array.isArray(preimage.rows)) {
    throw new ReadableSearchValidationError('upstream input rows must be an array');
  }
  if (preimage.rows.length !== preimageHead.position) {
    throw new ReadableSearchValidationError(
      'upstream input rows must densely cover the record head',
    );
  }

  const committedFacts: RetrievalPermissionFact[] = [];
  for (const [rowIndex, rowValue] of preimage.rows.entries()) {
    const label = `upstream input row ${rowIndex + 1}`;
    const row = object(rowValue, label);
    exactKeys(row, ROW_KEYS, label);
    const position = assertSafePositiveInteger(row.log_position, `${label} log_position`);
    if (position !== rowIndex + 1) {
      throw new ReadableSearchValidationError(
        'upstream input rows must densely cover the record head',
      );
    }
    const recordHash = assertReadableSearchDigest(row.record_hash, `${label} record_hash`);
    const envelopeSha256 = assertReadableSearchDigest(
      row.envelope_sha256,
      `${label} envelope_sha256`,
    );
    if (!Array.isArray(row.items)) {
      throw new ReadableSearchValidationError(`${label} items must be an array`);
    }

    let expectedPolicy:
      | typeof ORGANIZATION_MEMBER_POLICY_ID
      | typeof RESTRICTED_REVIEWER_POLICY_ID
      | null;
    let expectedPolicyContract: `sha256:${string}` | null;
    if (row.classification === 'legacy-schema-v1-excluded') {
      expectedPolicy = null;
      expectedPolicyContract = null;
    } else if (row.classification === 'restricted-reviewer-v2-admitted') {
      expectedPolicy = RESTRICTED_REVIEWER_POLICY_ID;
      expectedPolicyContract = input.restricted_reviewer_policy_contract_sha256;
    } else if (row.classification === 'organization-member-readable-v3-admitted') {
      expectedPolicy = ORGANIZATION_MEMBER_POLICY_ID;
      expectedPolicyContract = input.organization_member_policy_contract_sha256;
    } else {
      throw new ReadableSearchValidationError(`${label} classification is unsupported`);
    }
    if (expectedPolicy === null && row.items.length !== 0) {
      throw new ReadableSearchValidationError(`${label} excludes retrieval facts`);
    }

    for (const [itemIndex, itemValue] of row.items.entries()) {
      const itemLabel = `${label} item ${itemIndex}`;
      const item = object(itemValue, itemLabel);
      exactKeys(item, FACT_KEYS, itemLabel);
      if (
        item.organization_id !== organizationId ||
        item.log_position !== position ||
        item.atom_order !== itemIndex ||
        item.record_hash !== recordHash ||
        item.envelope_sha256 !== envelopeSha256 ||
        item.policy_id !== expectedPolicy ||
        item.policy_contract_sha256 !== expectedPolicyContract
      ) {
        throw new ReadableSearchValidationError(
          `${itemLabel} does not bind its dense Layer 1 row`,
        );
      }
      committedFacts.push(itemValue as RetrievalPermissionFact);
    }
  }
  if (
    preimageHead.position > 0 &&
    preimageHead.record_hash !==
      (preimage.rows.at(-1) as Record<string, unknown>).record_hash
  ) {
    throw new ReadableSearchValidationError(
      'upstream input record_head does not bind the final dense row',
    );
  }

  if (canonicalJson(committedFacts) !== canonicalJson(atomFacts)) {
    throw new ReadableSearchValidationError(
      'admitted atom facts do not match upstream_input_root preimage',
    );
  }
  return canonicalSha256(input.upstream_input_preimage);
}
