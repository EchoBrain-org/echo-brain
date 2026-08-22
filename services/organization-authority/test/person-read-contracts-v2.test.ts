import {
  canonicalJson,
  canonicalSha256,
} from '@echo-brain/federation-protocol';
import { validateOrganizationPersonReadableSearchRequest } from '@echo-brain/organization-api';
import { describe, expect, it } from 'vitest';
import {
  PERSON_CALLER_BINDING_KIND,
  PERSON_REQUEST_COMMITMENT_KIND,
  PersonReadContractV2Error,
  buildPersonCallerBindingV2,
  buildPersonRequestCommitmentV2,
  personCallerBindingSha256V2,
  personRequestCommitmentSha256V2,
  validatePersonCallerBindingV2,
  validatePersonRequestCommitmentV2,
} from '../src/application/person-read-contracts-v2.js';

const IDS = {
  authority: 'oau_00000000-0000-4000-8000-000000000001',
  organization: 'org_00000000-0000-4000-8000-000000000002',
  principal: 'prn_00000000-0000-4000-8000-000000000003',
  membership: 'mem_00000000-0000-4000-8000-000000000004',
  identityBinding: 'oib_00000000-0000-4000-8000-000000000005',
  sessionFamily: 'psf_00000000-0000-4000-8000-000000000006',
} as const;

const DIGESTS = {
  access:
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  person:
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  session:
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
} as const;

const REQUEST_CASES = [
  {
    operation: 'reviewer_recent_decisions' as const,
    input: {},
    canonical:
      '{"input":{},"kind":"echo-person-request-commitment-v2","operation":"reviewer_recent_decisions","schema_version":2}',
    digest:
      'sha256:e10ddeaa46a5df6e3ec9161e89ef3c16ef44c42bd79bb85bdb055bc15c41050e',
  },
  {
    operation: 'readable_search' as const,
    input: { query: 'Launch pricing' },
    canonical:
      '{"input":{"query":"Launch pricing"},"kind":"echo-person-request-commitment-v2","operation":"readable_search","schema_version":2}',
    digest:
      'sha256:f84ffba3a728ae3855e6f345e08efc58d26035cc3eeafa2cc53755f4ac719057',
  },
  {
    operation: 'list_member_exclusions' as const,
    input: {
      source_adapter_id: 'granola',
      source_instance_id: 'workspace-1',
    },
    canonical:
      '{"input":{"source_adapter_id":"granola","source_instance_id":"workspace-1"},"kind":"echo-person-request-commitment-v2","operation":"list_member_exclusions","schema_version":2}',
    digest:
      'sha256:1d0dfd2a10a460c3f934dfaf738c47cc3a9d5e475141768b210f9ffe596fce61',
  },
  {
    operation: 'change_member_exclusion' as const,
    input: {
      excluded: true,
      selector: {
        scope: 'meeting',
        source_adapter_id: 'granola',
        source_instance_id: 'workspace-1',
        external_id: ' meeting/ 01 ',
      },
    },
    canonical:
      '{"input":{"excluded":true,"selector":{"external_id":" meeting/ 01 ","scope":"meeting","source_adapter_id":"granola","source_instance_id":"workspace-1"}},"kind":"echo-person-request-commitment-v2","operation":"change_member_exclusion","schema_version":2}',
    digest:
      'sha256:dc84b774c2348a6fa3edee59695bcba75476dc69dffd68a158c6d37ba0320f59',
  },
] as const;

function callerInput() {
  return {
    boundary: {
      authority_id: IDS.authority,
      organization_id: IDS.organization,
      state_lineage_id: 'state-lineage-1',
    },
    current_caller: {
      organization_id: IDS.organization,
      principal_id: IDS.principal,
      membership_id: IDS.membership,
      membership_type: 'employee' as const,
      identity_binding_id: IDS.identityBinding,
      session_family_id: IDS.sessionFamily,
      access_credential_sha256: DIGESTS.access,
      person_state_sha256: DIGESTS.person,
      session_state_sha256: DIGESTS.session,
    },
  };
}

describe('private D6-1 Person request and caller commitments', () => {
  it('freezes exact canonical bodies and golden digests for all four operations', () => {
    for (const fixture of REQUEST_CASES) {
      const body = buildPersonRequestCommitmentV2({
        operation: fixture.operation,
        input: fixture.input,
      });
      expect(Object.keys(body)).toEqual([
        'schema_version',
        'kind',
        'operation',
        'input',
      ]);
      expect(Object.isFrozen(body)).toBe(true);
      expect(Object.isFrozen(body.input)).toBe(true);
      expect(canonicalJson(body)).toBe(fixture.canonical);
      expect(personRequestCommitmentSha256V2(body)).toBe(fixture.digest);
      expect(validatePersonRequestCommitmentV2(body)).toEqual(body);
    }
  });

  it('keeps source and meeting selectors closed and preserves opaque external ID bytes', () => {
    const source = buildPersonRequestCommitmentV2({
      operation: 'change_member_exclusion',
      input: {
        excluded: false,
        selector: {
          scope: 'source',
          source_adapter_id: 'granola',
          source_instance_id: 'workspace-1',
        },
      },
    });
    expect(source.input).toEqual({
      excluded: false,
      selector: {
        scope: 'source',
        source_adapter_id: 'granola',
        source_instance_id: 'workspace-1',
      },
    });
    if (source.operation !== 'change_member_exclusion') {
      throw new Error('unexpected request variant');
    }
    expect(Object.isFrozen(source.input.selector)).toBe(true);

    expect(() =>
      buildPersonRequestCommitmentV2({
        operation: 'change_member_exclusion',
        input: {
          excluded: true,
          selector: {
            scope: 'source',
            source_adapter_id: 'granola',
            source_instance_id: 'workspace-1',
            external_id: 'must-not-exist',
          },
        },
      }),
    ).toThrow('unexpected shape');
    expect(() =>
      buildPersonRequestCommitmentV2({
        operation: 'change_member_exclusion',
        input: {
          excluded: true,
          selector: {
            scope: 'meeting',
            source_adapter_id: 'granola',
            source_instance_id: 'workspace-1',
          },
        },
      }),
    ).toThrow('unexpected shape');
    expect(() =>
      buildPersonRequestCommitmentV2({
        operation: 'change_member_exclusion',
        input: {
          excluded: true,
          selector: {
            scope: 'meeting',
            source_adapter_id: 'granola',
            source_instance_id: 'workspace-1',
            external_id: 'bad\0id',
          },
        },
      }),
    ).toThrow('non-NUL opaque identifier');
  });

  it('rejects non-I-JSON strings before returning a request or caller body', () => {
    expect(() =>
      buildPersonRequestCommitmentV2({
        operation: 'list_member_exclusions',
        input: {
          source_adapter_id: 'granola\ud800',
          source_instance_id: 'workspace-1',
        },
      }),
    ).toThrow('Unicode scalar values');

    expect(() =>
      validatePersonRequestCommitmentV2({
        schema_version: 2,
        kind: PERSON_REQUEST_COMMITMENT_KIND,
        operation: 'change_member_exclusion',
        input: {
          excluded: true,
          selector: {
            scope: 'meeting',
            source_adapter_id: 'granola',
            source_instance_id: 'workspace-1',
            external_id: 'meeting-\udfff',
          },
        },
      }),
    ).toThrow('Unicode scalar values');

    const builtCallerInput = callerInput();
    builtCallerInput.boundary.state_lineage_id = 'lineage-\ud800';
    expect(() => buildPersonCallerBindingV2(builtCallerInput)).toThrow(
      'Unicode scalar values',
    );

    expect(() =>
      validatePersonCallerBindingV2({
        ...buildPersonCallerBindingV2(callerInput()),
        state_lineage_id: 'lineage-\udfff',
      }),
    ).toThrow('Unicode scalar values');
  });

  it('matches the retained main readable-search query grammar', () => {
    const corpus = [
      'Launch pricing',
      'café １２3',
      '',
      ' leading',
      'trailing ',
      'line\nbreak',
      'e\u0301',
      'x'.repeat(241),
      '---',
      Array.from({ length: 17 }, (_value, index) => 'term' + index).join(' '),
      'a' + '界'.repeat(22),
      '\ud800',
    ];
    for (const query of corpus) {
      let currentAccepted = true;
      try {
        validateOrganizationPersonReadableSearchRequest({
          subject_principal_id: IDS.principal,
          query,
        });
      } catch {
        currentAccepted = false;
      }
      let candidateAccepted = true;
      try {
        buildPersonRequestCommitmentV2({
          operation: 'readable_search',
          input: { query },
        });
      } catch {
        candidateAccepted = false;
      }
      expect(candidateAccepted, query).toBe(currentAccepted);
    }
  });

  it('rejects transport ceremony, caller identity, and cross-operation inputs', () => {
    for (const [operation, input] of [
      ['reviewer_recent_decisions', { subject_principal_id: IDS.principal }],
      ['readable_search', { query: 'pricing', request_id: 'osq_not-semantic' }],
      [
        'list_member_exclusions',
        {
          source_adapter_id: 'granola',
          source_instance_id: 'workspace-1',
          authority_id: IDS.authority,
        },
      ],
      [
        'change_member_exclusion',
        {
          excluded: true,
          selector: {
            scope: 'source',
            source_adapter_id: 'granola',
            source_instance_id: 'workspace-1',
          },
          http_path: '/v2/member-exclusions',
        },
      ],
      ['readable_search', { source_adapter_id: 'granola' }],
    ] as const) {
      expect(() =>
        buildPersonRequestCommitmentV2({ operation, input }),
      ).toThrow();
    }
    expect(() =>
      validatePersonRequestCommitmentV2({
        schema_version: 2,
        kind: PERSON_REQUEST_COMMITMENT_KIND,
        operation: 'unknown',
        input: {},
      }),
    ).toThrow('operation is unsupported');
  });

  it('rejects hostile request objects without invoking accessors', () => {
    let getterCalls = 0;
    const accessorInput = {} as Record<string, unknown>;
    Object.defineProperty(accessorInput, 'query', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'pricing';
      },
    });
    expect(() =>
      buildPersonRequestCommitmentV2({
        operation: 'readable_search',
        input: accessorInput,
      }),
    ).toThrow('enumerable data property');
    expect(getterCalls).toBe(0);

    const hidden = { query: 'pricing' };
    Object.defineProperty(hidden, 'subject_principal_id', {
      value: IDS.principal,
      enumerable: false,
    });
    expect(() =>
      buildPersonRequestCommitmentV2({
        operation: 'readable_search',
        input: hidden,
      }),
    ).toThrow('enumerable data property');

    const symbol = { query: 'pricing', [Symbol('credential')]: 'secret' };
    expect(() =>
      buildPersonRequestCommitmentV2({
        operation: 'readable_search',
        input: symbol,
      }),
    ).toThrow('symbol keys');

    let wrapperGetterCalls = 0;
    const accessorWrapper = {
      input: { query: 'pricing' },
    } as Record<string, unknown>;
    Object.defineProperty(accessorWrapper, 'operation', {
      enumerable: true,
      get() {
        wrapperGetterCalls += 1;
        return 'readable_search';
      },
    });
    expect(() =>
      buildPersonRequestCommitmentV2(
        accessorWrapper as unknown as Parameters<
          typeof buildPersonRequestCommitmentV2
        >[0],
      ),
    ).toThrow('enumerable data property');
    expect(wrapperGetterCalls).toBe(0);

    const customPrototypeWrapper = Object.assign(Object.create({}), {
      operation: 'readable_search',
      input: { query: 'pricing' },
    });
    expect(() =>
      buildPersonRequestCommitmentV2(customPrototypeWrapper),
    ).toThrow('plain object');

    expect(() =>
      buildPersonRequestCommitmentV2({
        operation: 'readable_search',
        input: { query: 'pricing' },
        route: '/v2/readable-search',
      } as unknown as Parameters<typeof buildPersonRequestCommitmentV2>[0]),
    ).toThrow('unexpected shape');
  });

  it('freezes the exact bearer-derived caller body and golden digest', () => {
    const body = buildPersonCallerBindingV2(callerInput());
    expect(Object.keys(body)).toEqual([
      'schema_version',
      'kind',
      'authority_id',
      'organization_id',
      'state_lineage_id',
      'principal_id',
      'membership_id',
      'membership_type',
      'identity_binding_id',
      'session_family_id',
      'access_credential_sha256',
      'person_state_sha256',
      'session_state_sha256',
    ]);
    expect(Object.isFrozen(body)).toBe(true);
    expect(canonicalJson(body)).toBe(
      '{"access_credential_sha256":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","authority_id":"oau_00000000-0000-4000-8000-000000000001","identity_binding_id":"oib_00000000-0000-4000-8000-000000000005","kind":"echo-person-caller-binding-v2","membership_id":"mem_00000000-0000-4000-8000-000000000004","membership_type":"employee","organization_id":"org_00000000-0000-4000-8000-000000000002","person_state_sha256":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","principal_id":"prn_00000000-0000-4000-8000-000000000003","schema_version":2,"session_family_id":"psf_00000000-0000-4000-8000-000000000006","session_state_sha256":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","state_lineage_id":"state-lineage-1"}',
    );
    expect(personCallerBindingSha256V2(body)).toBe(
      'sha256:ea49ff8f33add0e94269443c34f58daa6dafdceceff9fb0fe728e1bc7b767a08',
    );
    expect(validatePersonCallerBindingV2(body)).toEqual(body);
  });

  it('makes every caller coordinate an independent digest dimension', () => {
    const original = buildPersonCallerBindingV2(callerInput());
    const mutations = [
      { authority_id: 'oau_00000000-0000-4000-8000-000000000011' },
      { organization_id: 'org_00000000-0000-4000-8000-000000000012' },
      { state_lineage_id: 'state-lineage-2' },
      { principal_id: 'prn_00000000-0000-4000-8000-000000000013' },
      { membership_id: 'mem_00000000-0000-4000-8000-000000000014' },
      { membership_type: 'owner' as const },
      { identity_binding_id: 'oib_00000000-0000-4000-8000-000000000015' },
      { session_family_id: 'psf_00000000-0000-4000-8000-000000000016' },
      {
        access_credential_sha256:
          'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      },
      {
        person_state_sha256:
          'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      },
      {
        session_state_sha256:
          'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      },
    ];
    const digests = mutations.map((mutation) =>
      personCallerBindingSha256V2({ ...original, ...mutation }),
    );
    expect(new Set(digests).size).toBe(mutations.length);
    expect(digests).not.toContain(personCallerBindingSha256V2(original));
  });

  it('rejects foreign organizations and caller-supplied identity or route fields', () => {
    const original = callerInput();
    const foreign = {
      ...original,
      current_caller: {
        ...original.current_caller,
        organization_id: 'org_00000000-0000-4000-8000-000000000099',
      },
    };
    expect(() => buildPersonCallerBindingV2(foreign)).toThrow(
      'belongs to another organization',
    );

    for (const extra of [
      ['subject_principal_id', IDS.principal],
      ['operation', 'readable_search'],
      ['request_sha256', DIGESTS.access],
      ['http_path', '/v2/readable-search'],
      ['provider_user_id', 'U123'],
    ] as const) {
      const input = callerInput() as unknown as {
        current_caller: Record<string, unknown>;
      };
      input.current_caller[extra[0]] = extra[1];
      expect(() =>
        buildPersonCallerBindingV2(
          input as unknown as ReturnType<typeof callerInput>,
        ),
      ).toThrow('unexpected shape');
    }
  });

  it('rejects invalid caller fields and hostile current-caller objects', () => {
    for (const mutation of [
      { principal_id: IDS.membership },
      { membership_type: 'administrator' },
      { identity_binding_id: IDS.principal },
      { access_credential_sha256: 'sha256:ABC' },
    ]) {
      const input = callerInput() as unknown as {
        current_caller: Record<string, unknown>;
      };
      Object.assign(input.current_caller, mutation);
      expect(() =>
        buildPersonCallerBindingV2(
          input as unknown as ReturnType<typeof callerInput>,
        ),
      ).toThrow(PersonReadContractV2Error);
    }

    let getterCalls = 0;
    const hostile = callerInput() as unknown as {
      current_caller: Record<string, unknown>;
    };
    Object.defineProperty(hostile.current_caller, 'principal_id', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return IDS.principal;
      },
    });
    expect(() =>
      buildPersonCallerBindingV2(
        hostile as unknown as ReturnType<typeof callerInput>,
      ),
    ).toThrow('enumerable data property');
    expect(getterCalls).toBe(0);
  });

  it('domain-separates D6 bodies from transitional wire and caller commitments', () => {
    const semantic = buildPersonRequestCommitmentV2({
      operation: 'readable_search',
      input: { query: 'pricing' },
    });
    const transitionalWire = {
      subject_principal_id: IDS.principal,
      query: 'pricing',
    };
    expect(canonicalSha256(transitionalWire)).not.toBe(
      personRequestCommitmentSha256V2(semantic),
    );
    expect(() => validatePersonRequestCommitmentV2(transitionalWire)).toThrow(
      'unexpected shape',
    );

    const caller = buildPersonCallerBindingV2(callerInput());
    const transitionalCaller = {
      ...caller,
      kind: 'echo-authority-person-read-caller-binding-v2',
      subject_principal_id: IDS.principal,
      operation: 'readable_search',
      request_sha256: personRequestCommitmentSha256V2(semantic),
    };
    expect(canonicalSha256(transitionalCaller)).not.toBe(
      personCallerBindingSha256V2(caller),
    );
    expect(() => validatePersonCallerBindingV2(transitionalCaller)).toThrow(
      'unexpected shape',
    );
    expect(caller.kind).toBe(PERSON_CALLER_BINDING_KIND);
  });
});
