import {
  canonicalSha256,
  sha256Digest,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import { derivedAtomIdentity } from '../src/application/atom-identity.js';
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  PersonPolicyFactProjectionV2Error,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  projectPersonPolicyFactsV2,
  type PersonHumanActActionV2,
  type PersonHumanActResolutionRefV1View,
  type PersonPolicyFactItemKindV2,
  type PersonPolicyIdV2,
  type ProjectPersonPolicyFactsV2Input,
  type ReprovedPersonPolicyD2WitnessV2,
  type StructurallyVerifiedPersonPolicyRecordV4View,
} from '../src/application/person-policy-facts-v2.js';

const AUTHORITY_ID = 'oau_authority_one';
const ORGANIZATION_ID = 'org_organization_one';
const STATE_LINEAGE_ID = 'lineage-one';
const APPROVAL_ID = 'approval-one';
const PRINCIPAL_ID = 'prn_reviewer_one';
const MEMBERSHIP_ID = 'mem_reviewer_one';
const AUDIT_EVENT_ID = 'aud_provider_human_one';
const AUDIT_SEQUENCE = 7;

const digest = (seed: string): Sha256Digest => canonicalSha256(seed);

interface FixtureOptions {
  readonly policy_id?: PersonPolicyIdV2;
  readonly action?: PersonHumanActActionV2;
  readonly decisions?: readonly string[];
  readonly actions?: readonly string[];
  readonly rationales?: readonly string[];
}

function signal(
  id: string,
  kind: PersonPolicyFactItemKindV2,
): { readonly id: string; readonly kind: PersonPolicyFactItemKindV2 } {
  return { id, kind };
}

function reference(
  policyId: PersonPolicyIdV2,
  action: PersonHumanActActionV2,
): PersonHumanActResolutionRefV1View {
  return {
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    state_lineage_id: STATE_LINEAGE_ID,
    approval_id: APPROVAL_ID,
    action,
    policy_id: policyId,
    policy_contract_sha256: digest(`policy-contract:${policyId}`),
    audit_event_id: AUDIT_EVENT_ID,
    audit_sequence: AUDIT_SEQUENCE,
    audit_entry_sha256: digest('audit-entry'),
    provider_action_kind: 'echo-provider-human-action-v2',
    provider_action_schema_version: 2,
    provider_action_sha256: digest('provider-action'),
    authorization_proof_sha256: digest('authorization-allow'),
  };
}

function witness(
  ref: PersonHumanActResolutionRefV1View,
): ReprovedPersonPolicyD2WitnessV2 {
  return {
    authorization_allow: {
      authority_id: ref.authority_id,
      organization_id: ref.organization_id,
      state_lineage_id: ref.state_lineage_id,
      approval_id: ref.approval_id,
      action: ref.action,
      policy_id: ref.policy_id,
      policy_contract_sha256: ref.policy_contract_sha256,
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      provider_action_sha256: ref.provider_action_sha256,
      decision: 'allow',
    },
    authorization_proof_sha256: ref.authorization_proof_sha256,
    provider_action_kind: ref.provider_action_kind,
    provider_action_schema_version: ref.provider_action_schema_version,
    audit_entry: {
      authority_id: ref.authority_id,
      organization_id: ref.organization_id,
      state_lineage_id: ref.state_lineage_id,
      audit_event_id: ref.audit_event_id,
      audit_sequence: ref.audit_sequence,
      actor_class: 'provider_human',
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      action: ref.action,
      subject_kind: 'approval',
      subject_id: ref.approval_id,
      detail_digest: ref.authorization_proof_sha256,
      provider_action_sha256: ref.provider_action_sha256,
    },
    audit_entry_sha256: ref.audit_entry_sha256,
  };
}

function approvedEvent(options: FixtureOptions): {
  readonly kind: 'approved';
  readonly approved_snapshot: {
    readonly approved_payload: {
      readonly brief: {
        readonly decisions: readonly {
          readonly id: string;
          readonly kind: 'decision';
        }[];
        readonly actions: readonly {
          readonly id: string;
          readonly kind: 'action';
        }[];
        readonly rationales: readonly {
          readonly id: string;
          readonly kind: 'rationale';
        }[];
      };
    };
  };
} {
  return {
    kind: 'approved',
    approved_snapshot: {
      approved_payload: {
        brief: {
          decisions: (options.decisions ?? ['decision-one']).map((id) =>
            signal(id, 'decision'),
          ) as readonly { readonly id: string; readonly kind: 'decision' }[],
          actions: (options.actions ?? ['action-one']).map((id) =>
            signal(id, 'action'),
          ) as readonly { readonly id: string; readonly kind: 'action' }[],
          rationales: (options.rationales ?? ['rationale-one']).map((id) =>
            signal(id, 'rationale'),
          ) as readonly { readonly id: string; readonly kind: 'rationale' }[],
        },
      },
    },
  };
}

function fixture(
  options: FixtureOptions = {},
): ProjectPersonPolicyFactsV2Input {
  const policyId =
    options.policy_id ?? ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID;
  const act = options.action ?? 'approve';
  const ref = reference(policyId, act);
  const envelope: StructurallyVerifiedPersonPolicyRecordV4View = {
    record_sha256: digest('record'),
    body: {
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      state_lineage_id: STATE_LINEAGE_ID,
      human_act_resolution_ref: ref,
      event: act === 'approve' ? approvedEvent(options) : { kind: 'rejected' },
    },
  };
  return {
    envelope,
    record_position: 11,
    witness: witness(ref),
  };
}

function mutableRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function clonedFixture(
  options: FixtureOptions = {},
): ProjectPersonPolicyFactsV2Input {
  return structuredClone(fixture(options));
}

function nested(input: ProjectPersonPolicyFactsV2Input): {
  readonly body: Record<string, unknown>;
  readonly ref: Record<string, unknown>;
  readonly witness: Record<string, unknown>;
  readonly allow: Record<string, unknown>;
  readonly audit: Record<string, unknown>;
} {
  const envelope = mutableRecord(input.envelope);
  const body = mutableRecord(envelope.body);
  const ref = mutableRecord(body.human_act_resolution_ref);
  const witnessRecord = mutableRecord(input.witness);
  return {
    body,
    ref,
    witness: witnessRecord,
    allow: mutableRecord(witnessRecord.authorization_allow),
    audit: mutableRecord(witnessRecord.audit_entry),
  };
}

const COMMON_FACT_KEYS = [
  'authority_id',
  'organization_id',
  'state_lineage_id',
  'approval_id',
  'action',
  'policy_id',
  'policy_contract_sha256',
  'record_position',
  'record_sha256',
  'atom_order',
  'signal_id_sha256',
  'atom_id',
  'item_kind',
  'audit_event_id',
  'audit_sequence',
  'audit_entry_sha256',
  'provider_action_sha256',
  'authorization_proof_sha256',
] as const;

describe('private Person-v2 policy fact projector', () => {
  it('flattens decision, action, and rationale arrays in canonical order', () => {
    const input = fixture({
      decisions: ['decision-one', 'decision-two'],
      actions: ['action-one'],
      rationales: ['rationale-one', 'rationale-two'],
    });
    const projected = projectPersonPolicyFactsV2(input);

    expect(projected.policy_fact_outcome).toEqual({
      kind: 'appended',
      policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    });
    expect(projected.facts.map((fact) => fact.atom_order)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(projected.facts.map((fact) => fact.item_kind)).toEqual([
      'decision',
      'decision',
      'action',
      'rationale',
      'rationale',
    ]);
    expect(projected.facts.map((fact) => fact.signal_id_sha256)).toEqual(
      [
        'decision-one',
        'decision-two',
        'action-one',
        'rationale-one',
        'rationale-two',
      ].map(sha256Digest),
    );
    expect(projected.facts.map((fact) => fact.atom_id)).toEqual(
      [
        'decision-one',
        'decision-two',
        'action-one',
        'rationale-one',
        'rationale-two',
      ].map((id) => derivedAtomIdentity(input.envelope.record_sha256, id)),
    );
    expect(
      new Set(projected.facts.map((fact) => fact.signal_id_sha256)).size,
    ).toBe(projected.facts.length);
    expect(new Set(projected.facts.map((fact) => fact.atom_id)).size).toBe(
      projected.facts.length,
    );
    expect(projected.facts.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(projected.facts)).toBe(true);
    expect(Object.isFrozen(projected.policy_fact_outcome)).toBe(true);
    expect(Object.isFrozen(projected)).toBe(true);
  });

  it('keeps the inherited raw signal and atom identities byte-exact', () => {
    const rawSignalId = '  signal\u0001identity  ';
    const input = fixture({
      decisions: [rawSignalId],
      actions: [],
      rationales: [],
    });
    const [fact] = projectPersonPolicyFactsV2(input).facts;

    expect(fact?.signal_id_sha256).toBe(sha256Digest(rawSignalId));
    expect(fact?.signal_id_sha256).not.toBe(sha256Digest(rawSignalId.trim()));
    expect(fact?.atom_id).toBe(
      canonicalSha256({
        kind: 'echo-organization-record-atom',
        record_hash: input.envelope.record_sha256,
        signal_id: rawSignalId,
      }),
    );
  });

  it('emits exact text-free member rows with no reviewer selector', () => {
    const input = fixture({ actions: [], rationales: [] });
    const [fact] = projectPersonPolicyFactsV2(input).facts;
    expect(fact).toBeDefined();
    expect(Object.keys(fact ?? {})).toEqual(COMMON_FACT_KEYS);
    expect(fact).toEqual({
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      state_lineage_id: STATE_LINEAGE_ID,
      approval_id: APPROVAL_ID,
      action: 'approve',
      policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      policy_contract_sha256: input.witness.authorization_allow.policy_contract_sha256,
      record_position: 11,
      record_sha256: input.envelope.record_sha256,
      atom_order: 0,
      signal_id_sha256: sha256Digest('decision-one'),
      atom_id: derivedAtomIdentity(
        input.envelope.record_sha256,
        'decision-one',
      ),
      item_kind: 'decision',
      audit_event_id: AUDIT_EVENT_ID,
      audit_sequence: AUDIT_SEQUENCE,
      audit_entry_sha256: input.witness.audit_entry_sha256,
      provider_action_sha256:
        input.witness.authorization_allow.provider_action_sha256,
      authorization_proof_sha256:
        input.witness.authorization_proof_sha256,
    });
    expect(fact).not.toHaveProperty('reviewer_principal_id');
    expect(fact).not.toHaveProperty('reviewer_membership_id');
    expect(fact).not.toHaveProperty('principal_id');
    expect(fact).not.toHaveProperty('membership_id');
    expect(fact).not.toHaveProperty('text');
    expect(fact).not.toHaveProperty('source_provenance');
    expect(fact).not.toHaveProperty('schema_version');
    expect(fact).not.toHaveProperty('kind');
    expect(JSON.stringify(fact)).not.toContain(PRINCIPAL_ID);
    expect(JSON.stringify(fact)).not.toContain(MEMBERSHIP_ID);
  });

  it('adds only the frozen D2 allow actor tuple for reviewer facts', () => {
    const input = fixture({
      policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      actions: [],
      rationales: [],
    });
    const projected = projectPersonPolicyFactsV2(input);
    const [fact] = projected.facts;

    expect(projected.policy_fact_outcome).toEqual({
      kind: 'appended',
      policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    });
    expect(Object.keys(fact ?? {})).toEqual([
      ...COMMON_FACT_KEYS,
      'reviewer_principal_id',
      'reviewer_membership_id',
    ]);
    expect(fact).toMatchObject({
      reviewer_principal_id: PRINCIPAL_ID,
      reviewer_membership_id: MEMBERSHIP_ID,
    });
  });

  it('reports an appended policy outcome for a zero-item approval', () => {
    const projected = projectPersonPolicyFactsV2(
      fixture({ decisions: [], actions: [], rationales: [] }),
    );
    expect(projected).toEqual({
      facts: [],
      policy_fact_outcome: {
        kind: 'appended',
        policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      },
    });
  });

  it('projects rejection to none without reading reason or candidate content', () => {
    const input = clonedFixture({ action: 'reject' });
    const body = nested(input).body;
    let forbiddenReads = 0;
    body.event = new Proxy(
      { kind: 'rejected' },
      {
        get(target, key, receiver) {
          if (key === 'reason' || key === 'candidate' || key === 'content') {
            forbiddenReads += 1;
            throw new Error('rejection content was accessed');
          }
          return Reflect.get(target, key, receiver);
        },
      },
    );

    expect(projectPersonPolicyFactsV2(input)).toEqual({
      facts: [],
      policy_fact_outcome: { kind: 'none' },
    });
    expect(forbiddenReads).toBe(0);
  });

  it('rejects action/event crossovers before emitting a fact', () => {
    const approvedAsReject = clonedFixture();
    const approvedParts = nested(approvedAsReject);
    approvedParts.ref.action = 'reject';
    approvedParts.allow.action = 'reject';
    approvedParts.audit.action = 'reject';
    expect(() => projectPersonPolicyFactsV2(approvedAsReject)).toThrow(
      PersonPolicyFactProjectionV2Error,
    );

    const rejectedAsApprove = clonedFixture({ action: 'reject' });
    const rejectedParts = nested(rejectedAsApprove);
    rejectedParts.ref.action = 'approve';
    rejectedParts.allow.action = 'approve';
    rejectedParts.audit.action = 'approve';
    expect(() => projectPersonPolicyFactsV2(rejectedAsApprove)).toThrow(
      PersonPolicyFactProjectionV2Error,
    );
  });

  it('joins every resolution identity to the D2 allow and audit witness', () => {
    const cases: readonly [
      string,
      (parts: ReturnType<typeof nested>) => void,
      RegExp,
    ][] = [
      [
        'reference authority',
        ({ ref }) => {
          ref.authority_id = 'oau_elsewhere';
        },
        /resolution authority_id does not match/,
      ],
      [
        'allow organization',
        ({ allow }) => {
          allow.organization_id = 'org_elsewhere';
        },
        /D2 allow organization_id does not match/,
      ],
      [
        'audit lineage',
        ({ audit }) => {
          audit.state_lineage_id = 'lineage-elsewhere';
        },
        /D2 audit state_lineage_id does not match/,
      ],
      [
        'approval',
        ({ allow }) => {
          allow.approval_id = 'approval-elsewhere';
        },
        /D2 allow approval_id does not match/,
      ],
      [
        'action',
        ({ audit }) => {
          audit.action = 'reject';
        },
        /D2 audit action does not match/,
      ],
      [
        'policy',
        ({ allow }) => {
          allow.policy_id = RESTRICTED_REVIEWER_PERSON_POLICY_ID;
        },
        /D2 allow policy_id does not match/,
      ],
      [
        'policy contract',
        ({ allow }) => {
          allow.policy_contract_sha256 = digest('other-policy-contract');
        },
        /D2 allow policy_contract_sha256 does not match/,
      ],
      [
        'audit event',
        ({ audit }) => {
          audit.audit_event_id = 'aud_elsewhere';
        },
        /D2 audit event ID does not match/,
      ],
      [
        'audit sequence',
        ({ audit }) => {
          audit.audit_sequence = AUDIT_SEQUENCE + 1;
        },
        /D2 audit sequence does not match/,
      ],
      [
        'audit digest',
        ({ witness: witnessRecord }) => {
          witnessRecord.audit_entry_sha256 = digest('other-audit-entry');
        },
        /D2 audit entry digest does not match/,
      ],
      [
        'provider action digest in allow',
        ({ allow }) => {
          allow.provider_action_sha256 = digest('other-provider-action');
        },
        /D2 allow provider action digest does not match/,
      ],
      [
        'provider action digest in audit',
        ({ audit }) => {
          audit.provider_action_sha256 = digest('other-provider-action');
        },
        /D2 audit provider action digest does not match/,
      ],
      [
        'authorization proof',
        ({ witness: witnessRecord }) => {
          witnessRecord.authorization_proof_sha256 = digest('other-allow');
        },
        /D2 authorization proof digest does not match/,
      ],
      [
        'audit authorization detail',
        ({ audit }) => {
          audit.detail_digest = digest('other-allow');
        },
        /D2 audit authorization detail digest does not match/,
      ],
      [
        'audit principal',
        ({ audit }) => {
          audit.principal_id = 'prn_elsewhere';
        },
        /D2 audit actor principal does not match/,
      ],
      [
        'audit membership',
        ({ audit }) => {
          audit.membership_id = 'mem_elsewhere';
        },
        /D2 audit actor membership does not match/,
      ],
      [
        'audit subject',
        ({ audit }) => {
          audit.subject_id = 'approval-elsewhere';
        },
        /D2 audit approval subject does not match/,
      ],
    ];

    for (const [label, mutate, expected] of cases) {
      const input = clonedFixture();
      mutate(nested(input));
      expect(
        () => projectPersonPolicyFactsV2(input),
        label,
      ).toThrow(expected);
    }
  });

  it('pins provider action kind/version and the closed allow/audit literals', () => {
    const cases: readonly [
      string,
      (parts: ReturnType<typeof nested>) => void,
      RegExp,
    ][] = [
      [
        'provider kind',
        ({ witness: witnessRecord }) => {
          witnessRecord.provider_action_kind = 'legacy-provider-action';
        },
        /provider_action_kind is unsupported/,
      ],
      [
        'provider version',
        ({ witness: witnessRecord }) => {
          witnessRecord.provider_action_schema_version = 1;
        },
        /provider_action_schema_version is unsupported/,
      ],
      [
        'deny is not an allow body',
        ({ allow }) => {
          allow.decision = 'deny';
        },
        /authorization decision is unsupported/,
      ],
      [
        'wrong actor class',
        ({ audit }) => {
          audit.actor_class = 'installation';
        },
        /audit actor_class is unsupported/,
      ],
      [
        'wrong audit subject kind',
        ({ audit }) => {
          audit.subject_kind = 'record';
        },
        /audit subject_kind is unsupported/,
      ],
    ];
    for (const [label, mutate, expected] of cases) {
      const input = clonedFixture();
      mutate(nested(input));
      expect(
        () => projectPersonPolicyFactsV2(input),
        label,
      ).toThrow(expected);
    }
  });

  it('denies duplicate raw signal identities within and across arrays', () => {
    for (const input of [
      fixture({ decisions: ['same', 'same'], actions: [], rationales: [] }),
      fixture({ decisions: ['same'], actions: ['same'], rationales: [] }),
      fixture({ decisions: ['same'], actions: [], rationales: ['same'] }),
    ]) {
      expect(() => projectPersonPolicyFactsV2(input)).toThrow(
        /signal ids must be unique across the record/,
      );
    }
  });

  it('requires a separate positive record position and canonical record hash', () => {
    for (const position of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const input = clonedFixture();
      mutableRecord(input).record_position = position;
      expect(
        () => projectPersonPolicyFactsV2(input),
        String(position),
      ).toThrow(/record_position must be a positive safe integer/);
    }

    const malformedHash = clonedFixture();
    mutableRecord(malformedHash.envelope).record_sha256 =
      `sha256:${'A'.repeat(64)}`;
    expect(() => projectPersonPolicyFactsV2(malformedHash)).toThrow(
      /record_sha256 must be a canonical sha256 digest/,
    );

    const positionInsideBody = clonedFixture();
    nested(positionInsideBody).body.record_position = 11;
    expect(() => projectPersonPolicyFactsV2(positionInsideBody)).toThrow(
      /record v4 body view has an unexpected shape/,
    );
  });

  it('rejects unknown policy IDs and malformed signal collections', () => {
    const unknownPolicy = clonedFixture();
    nested(unknownPolicy).ref.policy_id = 'legacy-policy-v1';
    expect(() => projectPersonPolicyFactsV2(unknownPolicy)).toThrow(
      /resolution policy_id is unsupported/,
    );

    const wrongSignalKind = clonedFixture();
    const body = nested(wrongSignalKind).body;
    const event = mutableRecord(body.event);
    const snapshot = mutableRecord(event.approved_snapshot);
    const payload = mutableRecord(snapshot.approved_payload);
    const brief = mutableRecord(payload.brief);
    const decisions = brief.decisions as unknown[];
    mutableRecord(decisions[0]).kind = 'action';
    expect(() => projectPersonPolicyFactsV2(wrongSignalKind)).toThrow(
      /approved decisions\[0\]\.kind is unsupported/,
    );

    const sparseSignals = clonedFixture();
    const sparseBody = nested(sparseSignals).body;
    const sparseEvent = mutableRecord(sparseBody.event);
    const sparseSnapshot = mutableRecord(sparseEvent.approved_snapshot);
    const sparsePayload = mutableRecord(sparseSnapshot.approved_payload);
    const sparseBrief = mutableRecord(sparsePayload.brief);
    sparseBrief.decisions = new Array(1);
    expect(() => projectPersonPolicyFactsV2(sparseSignals)).toThrow(
      /approved decisions must be a dense plain array/,
    );
  });

  it('fails closed on extra, accessor, symbol, and custom-prototype input', () => {
    const extraInput = clonedFixture();
    mutableRecord(extraInput).schema_version = 1;
    expect(() => projectPersonPolicyFactsV2(extraInput)).toThrow(
      /projection input has an unexpected shape/,
    );

    const extraWitness = clonedFixture();
    mutableRecord(extraWitness.witness).kind = 'invented-witness-kind';
    expect(() => projectPersonPolicyFactsV2(extraWitness)).toThrow(
      /D2 reproof witness has an unexpected shape/,
    );

    const accessorInput = clonedFixture();
    let getterCalls = 0;
    Object.defineProperty(accessorInput, 'envelope', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return fixture().envelope;
      },
    });
    expect(() => projectPersonPolicyFactsV2(accessorInput)).toThrow(
      /only enumerable data properties/,
    );
    expect(getterCalls).toBe(0);

    const symbolInput = clonedFixture();
    Object.defineProperty(symbolInput.witness, Symbol('hidden'), {
      enumerable: true,
      value: true,
    });
    expect(() => projectPersonPolicyFactsV2(symbolInput)).toThrow(
      /must be a plain object/,
    );

    const customPrototype = clonedFixture();
    Object.setPrototypeOf(customPrototype.witness, { inherited: true });
    expect(() => projectPersonPolicyFactsV2(customPrototype)).toThrow(
      /must be a plain object/,
    );
  });
});
