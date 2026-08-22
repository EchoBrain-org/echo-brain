import { canonicalJson } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  buildPersonCallerBindingV2,
  buildPersonRequestCommitmentV2,
} from '../src/application/person-read-contracts-v2.js';
import {
  PERSON_SCOPE_BINDING_KIND,
  buildPersonScopeBindingV2,
  personScopeBindingSha256V2,
  validatePersonScopeBindingV2,
} from '../src/application/person-read-scope-contracts-v2.js';

const IDS = {
  authority: 'oau_00000000-0000-4000-8000-000000000001',
  organization: 'org_00000000-0000-4000-8000-000000000002',
  principal: 'prn_00000000-0000-4000-8000-000000000003',
  membership: 'mem_00000000-0000-4000-8000-000000000004',
  identityBinding: 'oib_00000000-0000-4000-8000-000000000005',
  sessionFamily: 'psf_00000000-0000-4000-8000-000000000006',
} as const;

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function caller(membershipType: 'employee' | 'owner' = 'employee') {
  return buildPersonCallerBindingV2({
    boundary: {
      authority_id: IDS.authority,
      organization_id: IDS.organization,
      state_lineage_id: 'state-lineage-1',
    },
    current_caller: {
      organization_id: IDS.organization,
      principal_id: IDS.principal,
      membership_id: IDS.membership,
      membership_type: membershipType,
      identity_binding_id: IDS.identityBinding,
      session_family_id: IDS.sessionFamily,
      access_credential_sha256: digest('a'),
      person_state_sha256: digest('b'),
      session_state_sha256: digest('c'),
    },
  });
}

function reviewerRequest() {
  return buildPersonRequestCommitmentV2({
    operation: 'reviewer_recent_decisions',
    input: {},
  });
}

function readableRequest(query = 'Launch pricing') {
  return buildPersonRequestCommitmentV2({
    operation: 'readable_search',
    input: { query },
  });
}

function listRequest() {
  return buildPersonRequestCommitmentV2({
    operation: 'list_member_exclusions',
    input: {
      source_adapter_id: 'granola',
      source_instance_id: 'workspace-1',
    },
  });
}

function changeRequest(excluded = true) {
  return buildPersonRequestCommitmentV2({
    operation: 'change_member_exclusion',
    input: {
      excluded,
      selector: {
        scope: 'meeting',
        source_adapter_id: 'granola',
        source_instance_id: 'workspace-1',
        external_id: 'meeting/01',
      },
    },
  });
}

const MEMBER_POLICY = {
  policy_id: 'organization-member-readable-person-v2',
  policy_schema_version: 2,
  policy_contract_sha256:
    'sha256:7a874f8b8c0bea7fd58066f93e4f4a26f6f6c05bbbdfe45bf2141f0b2f3ff5e3',
} as const;
const REVIEWER_POLICY = {
  policy_id: 'restricted-reviewer-person-v2',
  policy_schema_version: 2,
  policy_contract_sha256:
    'sha256:c0b1676ad1bd2f27d9d781605420beac2e6fd3cd18ffa69f0d18ea62fe48f043',
} as const;
const MEMBER_SEGMENT = {
  policy_id: 'organization-member-readable-person-v2',
  segment_id: digest('6'),
  segment_manifest_sha256: digest('7'),
} as const;
const REVIEWER_SEGMENT = {
  policy_id: 'restricted-reviewer-person-v2',
  segment_id: digest('8'),
  segment_manifest_sha256: digest('9'),
} as const;

function readableScope(
  admittedSegments: readonly unknown[] = [MEMBER_SEGMENT, REVIEWER_SEGMENT],
) {
  return {
    scope_kind: 'readable_search',
    retrieval_contract_sha256: digest('2'),
    generation: {
      generation_id: digest('3'),
      manifest_sha256: digest('4'),
    },
    record_head: { position: 5, record_hash: digest('5') },
    admitted_segments: admittedSegments,
  } as const;
}

function authorityScope() {
  return {
    scope_kind: 'authority_state',
    source_activation_binding_sha256: digest('d'),
    owned_resource_sha256: digest('e'),
    exclusion_state_sha256: digest('f'),
  } as const;
}

describe('private D6-2A Person scope commitments', () => {
  it('freezes the reviewer-log singleton policy and record head without generation state', () => {
    const request = reviewerRequest();
    const currentCaller = caller();
    const built = buildPersonScopeBindingV2({
      request,
      caller: currentCaller,
      scope: {
        scope_kind: 'reviewer_log',
        record_head: { position: 7, record_hash: digest('1') },
      },
    });

    expect(Object.keys(built.body)).toEqual([
      'schema_version',
      'kind',
      'scope_kind',
      'caller_binding_sha256',
      'operation',
      'request_sha256',
      'policy_contracts',
      'record_head',
    ]);
    expect(built.body).toMatchObject({
      schema_version: 2,
      kind: PERSON_SCOPE_BINDING_KIND,
      scope_kind: 'reviewer_log',
      operation: 'reviewer_recent_decisions',
      policy_contracts: [REVIEWER_POLICY],
      record_head: { position: 7, record_hash: digest('1') },
    });
    expect(built.body).not.toHaveProperty('generation');
    expect(built.body).not.toHaveProperty('retrieval_contract_sha256');
    expect(built.body).not.toHaveProperty('admitted_segments');
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.body)).toBe(true);
    if (built.body.scope_kind !== 'reviewer_log') {
      throw new Error('unexpected scope variant');
    }
    expect(Object.isFrozen(built.body.policy_contracts)).toBe(true);
    expect(Object.isFrozen(built.body.policy_contracts[0])).toBe(true);
    expect(Object.isFrozen(built.body.record_head)).toBe(true);
    expect(Object.keys(built.body.policy_contracts[0]!)).toEqual([
      'policy_id',
      'policy_schema_version',
      'policy_contract_sha256',
    ]);
    expect(Object.keys(built.body.record_head)).toEqual([
      'position',
      'record_hash',
    ]);
    expect(built.scope_binding_sha256).toBe(
      'sha256:076a1ee30a693cbf226c3ef9fd3acff13ca5c97f8b3a2022adbdab6127a10a14',
    );
    expect(
      personScopeBindingSha256V2(built.body, {
        request,
        caller: currentCaller,
      }),
    ).toBe(built.scope_binding_sha256);
    expect(
      validatePersonScopeBindingV2(built.body, {
        request,
        caller: currentCaller,
      }),
    ).toEqual(built.body);
  });

  it('freezes readable-search policy order, generation, head, and member-first segments', () => {
    const request = readableRequest();
    const currentCaller = caller();
    const built = buildPersonScopeBindingV2({
      request,
      caller: currentCaller,
      scope: readableScope() as Parameters<
        typeof buildPersonScopeBindingV2
      >[0]['scope'],
    });

    expect(Object.keys(built.body)).toEqual([
      'schema_version',
      'kind',
      'scope_kind',
      'caller_binding_sha256',
      'operation',
      'request_sha256',
      'policy_contracts',
      'retrieval_contract_sha256',
      'generation',
      'record_head',
      'admitted_segments',
    ]);
    expect(built.body).toMatchObject({
      schema_version: 2,
      kind: PERSON_SCOPE_BINDING_KIND,
      scope_kind: 'readable_search',
      operation: 'readable_search',
      policy_contracts: [MEMBER_POLICY, REVIEWER_POLICY],
      retrieval_contract_sha256: digest('2'),
      generation: {
        generation_id: digest('3'),
        manifest_sha256: digest('4'),
      },
      record_head: { position: 5, record_hash: digest('5') },
      admitted_segments: [MEMBER_SEGMENT, REVIEWER_SEGMENT],
    });
    if (built.body.scope_kind !== 'readable_search') {
      throw new Error('unexpected scope variant');
    }
    expect(Object.keys(built.body.admitted_segments[0]!)).toEqual([
      'policy_id',
      'segment_id',
      'segment_manifest_sha256',
    ]);
    expect(Object.isFrozen(built.body.policy_contracts)).toBe(true);
    expect(Object.isFrozen(built.body.generation)).toBe(true);
    expect(Object.isFrozen(built.body.record_head)).toBe(true);
    expect(Object.isFrozen(built.body.admitted_segments)).toBe(true);
    expect(Object.isFrozen(built.body.admitted_segments[0])).toBe(true);
    expect(
      built.body.policy_contracts.map((policy) => Object.keys(policy)),
    ).toEqual([
      ['policy_id', 'policy_schema_version', 'policy_contract_sha256'],
      ['policy_id', 'policy_schema_version', 'policy_contract_sha256'],
    ]);
    expect(Object.keys(built.body.generation)).toEqual([
      'generation_id',
      'manifest_sha256',
    ]);
    expect(Object.keys(built.body.record_head)).toEqual([
      'position',
      'record_hash',
    ]);
    expect(canonicalJson(built.body)).toContain('"segment_id"');
    expect(canonicalJson(built.body)).not.toContain('Launch pricing');
    expect(built.scope_binding_sha256).toBe(
      'sha256:15b15e1d9ae43bb6f54fdfb8ea0840e862bcf4d9ff1cfc592cdd91a0f77431f6',
    );

    const changedSegment = buildPersonScopeBindingV2({
      request,
      caller: currentCaller,
      scope: readableScope([
        { ...MEMBER_SEGMENT, segment_id: digest('a') },
        REVIEWER_SEGMENT,
      ]) as Parameters<typeof buildPersonScopeBindingV2>[0]['scope'],
    });
    expect(changedSegment.scope_binding_sha256).not.toBe(
      built.scope_binding_sha256,
    );
    expect(() =>
      validatePersonScopeBindingV2(
        {
          ...built.body,
          policy_contracts: [REVIEWER_POLICY, MEMBER_POLICY],
        },
        { request, caller: currentCaller },
      ),
    ).toThrow('policy_id must be organization-member-readable-person-v2');
  });

  it('allows the required member segment alone and rejects every other segment shape or order', () => {
    const request = readableRequest();
    const currentCaller = caller();
    const build = (segments: readonly unknown[]) =>
      buildPersonScopeBindingV2({
        request,
        caller: currentCaller,
        scope: readableScope(segments) as Parameters<
          typeof buildPersonScopeBindingV2
        >[0]['scope'],
      });

    const memberOnly = build([MEMBER_SEGMENT]);
    if (memberOnly.body.scope_kind !== 'readable_search') {
      throw new Error('unexpected scope variant');
    }
    expect(memberOnly.body.admitted_segments).toEqual([MEMBER_SEGMENT]);
    expect(memberOnly.scope_binding_sha256).toBe(
      'sha256:9bf09bb8d37977e03417b73fa79f498e10ef8b15f8850e77a4942a8ac1194112',
    );

    expect(() => build([])).toThrow('member segment and optional reviewer');
    expect(() => build([REVIEWER_SEGMENT, MEMBER_SEGMENT])).toThrow(
      'policy_id must be organization-member-readable-person-v2',
    );
    expect(() =>
      build([MEMBER_SEGMENT, REVIEWER_SEGMENT, REVIEWER_SEGMENT]),
    ).toThrow('member segment and optional reviewer');
    expect(() =>
      build([
        MEMBER_SEGMENT,
        { ...REVIEWER_SEGMENT, segment_id: MEMBER_SEGMENT.segment_id },
      ]),
    ).toThrow('must not repeat a segment_id');
    expect(() =>
      build([
        {
          policy_id: MEMBER_SEGMENT.policy_id,
          segment_manifest_sha256: MEMBER_SEGMENT.segment_manifest_sha256,
        },
      ]),
    ).toThrow('unexpected shape');
  });

  it('maps both Authority-state operations to exactly three structural digests', () => {
    const currentCaller = caller();
    const cases = [
      {
        request: listRequest(),
        operation: 'list_member_exclusions',
        golden:
          'sha256:f56de49a1dc5c6b5409ee3c7b14d064defd21f30802ef08fc37dcbdb4ea594ea',
      },
      {
        request: changeRequest(),
        operation: 'change_member_exclusion',
        golden:
          'sha256:1b66bfb9ae695c228a83fe5d55ac8202ddd405069eac88a6c75f3d991e809ca1',
      },
    ] as const;

    for (const fixture of cases) {
      const built = buildPersonScopeBindingV2({
        request: fixture.request,
        caller: currentCaller,
        scope: authorityScope(),
      });
      expect(Object.keys(built.body)).toEqual([
        'schema_version',
        'kind',
        'scope_kind',
        'caller_binding_sha256',
        'operation',
        'request_sha256',
        'source_activation_binding_sha256',
        'owned_resource_sha256',
        'exclusion_state_sha256',
      ]);
      expect(built.body).toMatchObject({
        scope_kind: 'authority_state',
        operation: fixture.operation,
        source_activation_binding_sha256: digest('d'),
        owned_resource_sha256: digest('e'),
        exclusion_state_sha256: digest('f'),
      });
      expect(built.body).not.toHaveProperty('command_sha256');
      expect(built.body).not.toHaveProperty('source_adapter_id');
      expect(built.body).not.toHaveProperty('custodian_principal_id');
      expect(built.scope_binding_sha256).toBe(fixture.golden);
    }
  });

  it('rejects cross-operation scope variants', () => {
    const currentCaller = caller();
    expect(() =>
      buildPersonScopeBindingV2({
        request: readableRequest(),
        caller: currentCaller,
        scope: {
          scope_kind: 'reviewer_log',
          record_head: { position: 0, record_hash: null },
        },
      }),
    ).toThrow('reviewer_log requires reviewer_recent_decisions');
    expect(() =>
      buildPersonScopeBindingV2({
        request: reviewerRequest(),
        caller: currentCaller,
        scope: readableScope() as Parameters<
          typeof buildPersonScopeBindingV2
        >[0]['scope'],
      }),
    ).toThrow('readable_search requires readable_search');
    expect(() =>
      buildPersonScopeBindingV2({
        request: reviewerRequest(),
        caller: currentCaller,
        scope: authorityScope(),
      }),
    ).toThrow('authority_state requires a member-exclusion operation');
  });

  it('recomputes both D6-1 joins and makes either preimage change the scope digest', () => {
    const request = readableRequest();
    const currentCaller = caller();
    const built = buildPersonScopeBindingV2({
      request,
      caller: currentCaller,
      scope: readableScope() as Parameters<
        typeof buildPersonScopeBindingV2
      >[0]['scope'],
    });
    const changedRequest = readableRequest('Different terms');
    const changedCaller = caller('owner');

    expect(() =>
      validatePersonScopeBindingV2(built.body, {
        request: changedRequest,
        caller: currentCaller,
      }),
    ).toThrow('request_sha256 must be');
    expect(() =>
      validatePersonScopeBindingV2(built.body, {
        request,
        caller: changedCaller,
      }),
    ).toThrow('caller_binding_sha256 must be');

    const requestChangedScope = buildPersonScopeBindingV2({
      request: changedRequest,
      caller: currentCaller,
      scope: readableScope() as Parameters<
        typeof buildPersonScopeBindingV2
      >[0]['scope'],
    });
    const callerChangedScope = buildPersonScopeBindingV2({
      request,
      caller: changedCaller,
      scope: readableScope() as Parameters<
        typeof buildPersonScopeBindingV2
      >[0]['scope'],
    });
    expect(
      new Set([
        built.scope_binding_sha256,
        requestChangedScope.scope_binding_sha256,
        callerChangedScope.scope_binding_sha256,
      ]).size,
    ).toBe(3);
  });

  it('rejects cross-variant, response, content, route, and caller fields', () => {
    const request = reviewerRequest();
    const currentCaller = caller();
    const built = buildPersonScopeBindingV2({
      request,
      caller: currentCaller,
      scope: {
        scope_kind: 'reviewer_log',
        record_head: { position: 0, record_hash: null },
      },
    });

    for (const extra of [
      [
        'generation',
        { generation_id: digest('1'), manifest_sha256: digest('2') },
      ],
      ['query', 'secret terms'],
      ['returned_atom_ids', []],
      ['http_path', '/v2/reviewer-decisions'],
      ['principal_id', IDS.principal],
    ] as const) {
      expect(() =>
        validatePersonScopeBindingV2(
          { ...built.body, [extra[0]]: extra[1] },
          { request, caller: currentCaller },
        ),
      ).toThrow('unexpected shape');
    }

    expect(() =>
      buildPersonScopeBindingV2({
        request,
        caller: currentCaller,
        scope: {
          scope_kind: 'reviewer_log',
          record_head: { position: 0, record_hash: null },
          response_sha256: digest('3'),
        },
      } as unknown as Parameters<typeof buildPersonScopeBindingV2>[0]),
    ).toThrow('unexpected shape');
    expect(() =>
      buildPersonScopeBindingV2({
        request,
        caller: currentCaller,
        scope: {
          scope_kind: 'reviewer_log',
          record_head: { position: 0, record_hash: null },
          request_sha256: digest('4'),
        },
      } as unknown as Parameters<typeof buildPersonScopeBindingV2>[0]),
    ).toThrow('unexpected shape');
  });

  it('enforces exact record-head, fixed-policy, and lowercase-digest structure', () => {
    const request = reviewerRequest();
    const currentCaller = caller();
    const buildHead = (recordHead: unknown) =>
      buildPersonScopeBindingV2({
        request,
        caller: currentCaller,
        scope: {
          scope_kind: 'reviewer_log',
          record_head: recordHead,
        },
      } as unknown as Parameters<typeof buildPersonScopeBindingV2>[0]);

    expect(buildHead({ position: -0, record_hash: null }).body).toMatchObject({
      record_head: { position: 0, record_hash: null },
    });
    expect(() => buildHead({ position: 0, record_hash: digest('1') })).toThrow(
      'must be null at the zero head',
    );
    expect(() => buildHead({ position: 1, record_hash: null })).toThrow(
      'lowercase SHA-256 digest',
    );
    expect(() =>
      buildHead({
        position: Number.MAX_SAFE_INTEGER + 1,
        record_hash: digest('1'),
      }),
    ).toThrow('non-negative safe integer');
    expect(() => buildHead({ position: 1, record_hash: 'sha256:ABC' })).toThrow(
      'lowercase SHA-256 digest',
    );

    const valid = buildHead({ position: 1, record_hash: digest('1') });
    if (valid.body.scope_kind !== 'reviewer_log') {
      throw new Error('unexpected scope variant');
    }
    expect(() =>
      validatePersonScopeBindingV2(
        {
          ...valid.body,
          policy_contracts: [
            {
              ...REVIEWER_POLICY,
              policy_contract_sha256: digest('0'),
            },
          ],
        },
        { request, caller: currentCaller },
      ),
    ).toThrow('policy_contract_sha256 must be');
  });

  it('rejects hostile objects and arrays without invoking accessors', () => {
    const request = reviewerRequest();
    const currentCaller = caller();
    let getterCalls = 0;
    const hostileScope = { scope_kind: 'reviewer_log' } as Record<
      string,
      unknown
    >;
    Object.defineProperty(hostileScope, 'record_head', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { position: 0, record_hash: null };
      },
    });
    expect(() =>
      buildPersonScopeBindingV2({
        request,
        caller: currentCaller,
        scope: hostileScope,
      } as unknown as Parameters<typeof buildPersonScopeBindingV2>[0]),
    ).toThrow('enumerable data property');
    expect(getterCalls).toBe(0);

    const valid = buildPersonScopeBindingV2({
      request,
      caller: currentCaller,
      scope: {
        scope_kind: 'reviewer_log',
        record_head: { position: 0, record_hash: null },
      },
    });
    let discriminatorCalls = 0;
    const hostileBody = { ...valid.body } as Record<string, unknown>;
    Object.defineProperty(hostileBody, 'scope_kind', {
      enumerable: true,
      get() {
        discriminatorCalls += 1;
        return 'reviewer_log';
      },
    });
    expect(() =>
      validatePersonScopeBindingV2(hostileBody, {
        request,
        caller: currentCaller,
      }),
    ).toThrow('enumerable data property');
    expect(discriminatorCalls).toBe(0);

    if (valid.body.scope_kind !== 'reviewer_log') {
      throw new Error('unexpected scope variant');
    }
    const sparsePolicies = Array(1);
    expect(() =>
      validatePersonScopeBindingV2(
        { ...valid.body, policy_contracts: sparsePolicies },
        { request, caller: currentCaller },
      ),
    ).toThrow('dense plain array');
    const symbolPolicies = [REVIEWER_POLICY];
    Object.defineProperty(symbolPolicies, Symbol('hidden'), {
      value: 'secret',
    });
    expect(() =>
      validatePersonScopeBindingV2(
        { ...valid.body, policy_contracts: symbolPolicies },
        { request, caller: currentCaller },
      ),
    ).toThrow('symbol keys');
  });

  it('accepts well-formed opaque references only as structural commitments', () => {
    const request = listRequest();
    const currentCaller = caller();
    const built = buildPersonScopeBindingV2({
      request,
      caller: currentCaller,
      scope: authorityScope(),
    });

    expect(
      validatePersonScopeBindingV2(built.body, {
        request,
        caller: currentCaller,
      }),
    ).toEqual(built.body);
    expect(built.scope_binding_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(built.body).not.toHaveProperty('release');
    expect(built.body).not.toHaveProperty('audit');
    expect(built.body).not.toHaveProperty('preimages');
  });
});
