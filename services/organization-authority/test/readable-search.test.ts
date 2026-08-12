import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganizationReadableSearchRequest,
} from '@echo-brain/organization-api';
import {
  normalizeP256LowS,
  p256KeyId,
} from '@echo-brain/federation-protocol';
import type { ReadableSearchQueryAuditEntry } from '../src/application/ports/authority-repository.js';
import {
  ReadableSearchAuthorizationFence,
} from '../src/application/readable-search-authorization-fence.js';
import {
  ReadableSearchError,
  ReadableSearchService,
} from '../src/application/readable-search.js';
import type {
  ReadableSearchAuthorityStatePort,
  ReadableSearchCandidate,
  ReadableSearchCurrentPerson,
  ReadableSearchFetchedItem,
  ReadableSearchRetrievalPort,
  ReadableSearchScope,
} from '../src/application/readable-search.js';
import type { Sha256Digest } from '@echo-brain/federation-protocol';

const digest = (character: string): Sha256Digest =>
  `sha256:${character.repeat(64)}`;

const CHECKED_AT = '2026-08-12T00:01:00.000Z';
let REQUEST: Awaited<ReturnType<typeof createOrganizationReadableSearchRequest>>;
let REQUEST_B: Awaited<ReturnType<typeof createOrganizationReadableSearchRequest>>;

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function handoff(response: { handoff(send: (body: string) => void): void }): Buffer {
  let body: string | undefined;
  response.handoff((text) => {
    body = text;
  });
  if (body === undefined) throw new Error('readable-search response did not hand off bytes');
  return Buffer.from(body, 'utf8');
}

beforeAll(async () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicKey)) throw new Error('test public key export failed');
  const installationSigningKey = {
    key_id: p256KeyId(publicKey),
    algorithm: 'ecdsa-p256-sha256-der-low-s' as const,
    public_key_spki_der_base64: publicKey.toString('base64'),
  };
  REQUEST = await createOrganizationReadableSearchRequest(
    {
      request_id: 'osq_00000000-0000-4000-8000-000000000001',
      authority_id: 'oau_00000000-0000-4000-8000-000000000001',
      authority_key_id: digest('c'),
      organization_id: 'org_00000000-0000-4000-8000-000000000001',
      enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
      installation_id: 'ins_00000000-0000-4000-8000-000000000001',
      installation_signing_key: installationSigningKey,
      query: 'decision',
      requested_at: '2026-08-12T00:00:00.000Z',
    },
    async (bytes) =>
      normalizeP256LowS(
        signMessage('sha256', bytes, {
          key: pair.privateKey,
          dsaEncoding: 'der',
        }),
      ),
  );
  REQUEST_B = await createOrganizationReadableSearchRequest(
    {
      request_id: 'osq_00000000-0000-4000-8000-000000000002',
      authority_id: 'oau_00000000-0000-4000-8000-000000000001',
      authority_key_id: digest('c'),
      organization_id: 'org_00000000-0000-4000-8000-000000000001',
      enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
      installation_id: 'ins_00000000-0000-4000-8000-000000000001',
      installation_signing_key: installationSigningKey,
      query: 'decision',
      requested_at: '2026-08-12T00:00:00.000Z',
    },
    async (bytes) =>
      normalizeP256LowS(
        signMessage('sha256', bytes, {
          key: pair.privateKey,
          dsaEncoding: 'der',
        }),
      ),
  );
});

function person(
  overrides: Partial<ReadableSearchCurrentPerson> = {},
): ReadableSearchCurrentPerson {
  const decision = overrides.decision ?? 'eligible';
  const governedReason =
    overrides.governed_reason ??
    (decision === 'eligible'
      ? 'active_member_with_scoped_policy_paths'
      : decision === 'expired'
        ? 'installation_access_expired'
        : 'inactive_or_unbound_organization_membership');
  return {
    decision,
    governed_reason: governedReason,
    principal_id: 'prn_00000000-0000-4000-8000-000000000001',
    membership_id: 'mem_00000000-0000-4000-8000-000000000001',
    membership_type: 'employee',
    enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
    installation_id: 'ins_00000000-0000-4000-8000-000000000001',
    authorization_state_sha256: digest('0'),
    person_state_sha256: digest('a'),
    ...overrides,
  };
}

function scope(
  overrides: Partial<ReadableSearchScope> = {},
): ReadableSearchScope {
  return {
    binding: {
      generation_id: digest('1'),
      manifest_sha256: digest('2'),
      record_head_position: 2,
      record_head_hash: digest('3'),
      retrieval_contract_sha256: digest('4'),
      policy_contracts: [
        {
          policy_id: 'organization-member-readable-v1',
          policy_contract_sha256: digest('5'),
        },
        {
          policy_id: 'restricted-reviewer-v1',
          policy_contract_sha256: digest('6'),
        },
      ],
    },
    scope_binding_sha256: digest('7'),
    reviewer_tuple: null,
    selected_policy_paths_still_match: () => true,
    ...overrides,
  };
}

function candidate(
  policy_id: ReadableSearchCandidate['policy_id'] = 'organization-member-readable-v1',
): ReadableSearchCandidate {
  return { atom_id: digest('8'), record_hash: digest('9'), policy_id };
}

function item(input: ReadableSearchCandidate): ReadableSearchFetchedItem {
  return { ...input, kind: 'decision', text: 'A complete approved decision.' };
}

interface Harness {
  readonly fence: ReadableSearchAuthorizationFence;
  readonly audits: ReadableSearchQueryAuditEntry[];
  readonly retrievalCalls: { opened: number; searched: number; fetched: number; closed: number };
  initial: ReadableSearchCurrentPerson;
  final: ReadableSearchCurrentPerson;
  scopeStillAdmitted: boolean;
  selectedPathsStillMatch: boolean;
  auditFailure: Error | null;
  readonly service: ReadableSearchService;
}

function harness(input: {
  readonly candidates?: readonly ReadableSearchCandidate[];
  readonly fetched?: readonly ReadableSearchFetchedItem[];
  readonly scope?: ReadableSearchScope;
  readonly initial?: ReadableSearchCurrentPerson;
  readonly final?: ReadableSearchCurrentPerson;
} = {}): Harness {
  const fence = new ReadableSearchAuthorizationFence();
  const audits: ReadableSearchQueryAuditEntry[] = [];
  const retrievalCalls = { opened: 0, searched: 0, fetched: 0, closed: 0 };
  const state = {
    initial: input.initial ?? person(),
    final: input.final ?? input.initial ?? person(),
    scopeStillAdmitted: true,
    selectedPathsStillMatch: true,
    auditFailure: null as Error | null,
  };
  const retrieval: ReadableSearchRetrievalPort = {
    openScope: () => {
      retrievalCalls.opened += 1;
      return input.scope ?? scope({
        selected_policy_paths_still_match: () => state.selectedPathsStillMatch,
      });
    },
    search: () => {
      retrievalCalls.searched += 1;
      return input.candidates ?? [];
    },
    fetch: () => {
      retrievalCalls.fetched += 1;
      return input.fetched ?? [];
    },
    close: () => {
      retrievalCalls.closed += 1;
    },
  };
  const authority: ReadableSearchAuthorityStatePort = {
    authenticate: (request) => ({
      request,
      request_sha256: digest('b'),
    }),
    currentPerson: () => state.initial,
    writeAtLinearization: (_authenticated, selectedScope, selected, operation) =>
      operation({
        person: state.final,
        checked_at: CHECKED_AT,
        scope_still_admitted:
          state.scopeStillAdmitted &&
          (selectedScope === null ||
            selectedScope.selected_policy_paths_still_match(selected)),
        appendQueryAudit: (entry) => {
          if (state.auditFailure !== null) throw state.auditFailure;
          audits.push(entry);
        },
      }),
  };
  const service = new ReadableSearchService({
    authority,
    retrieval,
    fence,
    contract: {
      retrieval_contract_sha256: digest('4'),
      policy_contracts: [
        {
          policy_id: 'organization-member-readable-v1',
          policy_contract_sha256: digest('5'),
        },
        {
          policy_id: 'restricted-reviewer-v1',
          policy_contract_sha256: digest('6'),
        },
      ],
    },
  });
  return {
    fence,
    audits,
    retrievalCalls,
    get initial() {
      return state.initial;
    },
    set initial(value) {
      state.initial = value;
    },
    get final() {
      return state.final;
    },
    set final(value) {
      state.final = value;
    },
    get scopeStillAdmitted() {
      return state.scopeStillAdmitted;
    },
    set scopeStillAdmitted(value) {
      state.scopeStillAdmitted = value;
    },
    get selectedPathsStillMatch() {
      return state.selectedPathsStillMatch;
    },
    set selectedPathsStillMatch(value) {
      state.selectedPathsStillMatch = value;
    },
    get auditFailure() {
      return state.auditFailure;
    },
    set auditFailure(value) {
      state.auditFailure = value;
    },
    service,
  };
}

describe('readable-search Authority orchestration', () => {
  it('seals audited bytes until one-shot transport handoff', async () => {
    const found = candidate();
    const subject = harness({ candidates: [found], fetched: [item(found)] });
    const response = await subject.service.search(REQUEST);

    expect(Object.hasOwn(response, 'body')).toBe(false);
    let handedOff: string | undefined;
    response.handoff((body) => {
      handedOff = body;
      try {
        (body as unknown as { 0: string })[0] = '[';
      } catch {}
    });
    expect(handedOff).toMatch(/^\{\"contract_id\"/);
    expect(Buffer.from(subject.audits[0]!.response_bytes)).toEqual(
      Buffer.from(handedOff!, 'utf8'),
    );
    expect(() => response.handoff(() => {})).toThrow(/handed off more than once/);
  });

  it('releases the scope and fence when the transport callback throws', async () => {
    const found = candidate();
    const subject = harness({ candidates: [found], fetched: [item(found)] });
    const response = await subject.service.search(REQUEST);

    expect(() =>
      response.handoff(() => {
        throw new Error('simulated partial transport failure');
      }),
    ).toThrow('simulated partial transport failure');
    expect(subject.retrievalCalls.closed).toBe(1);
    const writer = await subject.fence.acquireWrite();
    writer.release();
    expect(() => response.handoff(() => {})).toThrow(/handed off more than once/);
  });

  it('serves an organization-member item through a scoped retrieval port and audits exact bytes', async () => {
    const found = candidate();
    const subject = harness({ candidates: [found], fetched: [item(found)] });

    const response = await subject.service.search(REQUEST);

    expect(response.status_code).toBe(200);
    const body = handoff(response);
    expect(body).toEqual(
      Buffer.from(
        '{"contract_id":"permission-aware-readable-search-v1","items":[{"kind":"decision","policy_id":"organization-member-readable-v1","text":"A complete approved decision.","witness":"You may read this item because it was explicitly approved for current active owner or employee members, including members admitted after approval, and your membership is active."}],"schema_version":1}',
        'utf8',
      ),
    );
    expect(subject.retrievalCalls).toEqual({ opened: 1, searched: 1, fetched: 1, closed: 1 });
    expect(subject.audits).toHaveLength(1);
    expect(subject.audits[0]!.response_bytes).toEqual(body);
  });

  it('admits reviewer content only for the exact current principal and membership tuple', async () => {
    const found = candidate('restricted-reviewer-v1');
    const exact = harness({
      candidates: [found],
      fetched: [item(found)],
      scope: scope({
        reviewer_tuple: {
          principal_id: person().principal_id,
          membership_id: person().membership_id,
        },
      }),
    });
    const exactResponse = await exact.service.search(REQUEST);
    expect(exactResponse.status_code).toBe(200);
    handoff(exactResponse);

    const mismatched = harness({
      candidates: [found],
      fetched: [item(found)],
      scope: scope({
        reviewer_tuple: {
          principal_id: person().principal_id,
          membership_id: 'mem_00000000-0000-4000-8000-000000000002',
        },
      }),
    });
    await expect(mismatched.service.search(REQUEST)).rejects.toMatchObject({ code: 'unavailable' });
    expect(mismatched.retrievalCalls.fetched).toBe(0);
    expect(mismatched.audits).toHaveLength(0);
  });

  it('allows later and replacement active memberships to read organization-member content', async () => {
    const found = candidate();
    for (const membership of [
      'mem_00000000-0000-4000-8000-000000000002',
      'mem_00000000-0000-4000-8000-000000000003',
    ]) {
      const current = person({ membership_id: membership, person_state_sha256: digest(membership.endsWith('2') ? 'c' : 'd') });
      const subject = harness({
        initial: current,
        final: current,
        candidates: [found],
        fetched: [item(found)],
      });
      const response = await subject.service.search(REQUEST);
      expect(response.status_code).toBe(200);
      handoff(response);
    }
  });

  it('allows a progressing authorization clock when the closed state is unchanged and audits the final snapshot', async () => {
    const found = candidate();
    const initial = person({ person_state_sha256: digest('a') });
    const final = person({ person_state_sha256: digest('b') });
    const subject = harness({
      initial,
      final,
      candidates: [found],
      fetched: [item(found)],
    });

    const response = await subject.service.search(REQUEST);

    expect(response.status_code).toBe(200);
    handoff(response);
    expect(subject.audits).toHaveLength(1);
    expect(subject.audits[0]!.detail).toMatchObject({
      person_state_sha256: final.person_state_sha256,
      evaluated_at: CHECKED_AT,
    });
  });

  it('returns audited empty 200 without any content result', async () => {
    const subject = harness();
    const response = await subject.service.search(REQUEST);
    expect(response.status_code).toBe(200);
    expect(handoff(response).toString('utf8')).toBe(
      '{"contract_id":"permission-aware-readable-search-v1","items":[],"schema_version":1}',
    );
    expect(subject.retrievalCalls).toEqual({ opened: 1, searched: 1, fetched: 1, closed: 1 });
    expect(subject.audits).toHaveLength(1);
  });

  it('denies before opening any retrieval scope or content handle', async () => {
    const expired = person({ decision: 'expired' });
    const subject = harness({ initial: expired, final: expired });
    const response = await subject.service.search(REQUEST);
    expect(response.status_code).toBe(401);
    expect(subject.retrievalCalls).toEqual({ opened: 0, searched: 0, fetched: 0, closed: 0 });
    expect(subject.audits).toHaveLength(1);
    expect(subject.audits[0]!.decision).toBe('deny');
    handoff(response);
  });

  it('converts a final inactive race to an audited denial and never returns prepared content', async () => {
    const found = candidate();
    const subject = harness({
      candidates: [found],
      fetched: [item(found)],
      final: person({ decision: 'not_found', person_state_sha256: digest('e') }),
    });
    const response = await subject.service.search(REQUEST);
    expect(response.status_code).toBe(404);
    expect(handoff(response).toString('utf8')).not.toContain('complete approved');
    expect(subject.audits).toHaveLength(1);
    expect(subject.audits[0]!.decision).toBe('deny');
  });

  it('fails unavailable without an audit when the final head or generation admission changes', async () => {
    const found = candidate();
    const subject = harness({ candidates: [found], fetched: [item(found)] });
    subject.scopeStillAdmitted = false;
    await expect(subject.service.search(REQUEST)).rejects.toMatchObject({
      code: 'unavailable',
    } satisfies Partial<ReadableSearchError>);
    expect(subject.audits).toHaveLength(0);
  });

  it('fails unavailable with no allow audit when a selected fact or policy path changes before commit', async () => {
    const found = candidate();
    const subject = harness({ candidates: [found], fetched: [item(found)] });
    subject.selectedPathsStillMatch = false;
    await expect(subject.service.search(REQUEST)).rejects.toMatchObject({
      code: 'unavailable',
    } satisfies Partial<ReadableSearchError>);
    expect(subject.audits).toHaveLength(0);
    expect(subject.retrievalCalls.closed).toBe(1);
  });

  it('fails unavailable and returns no bytes when audit append fails', async () => {
    const found = candidate();
    const subject = harness({ candidates: [found], fetched: [item(found)] });
    subject.auditFailure = new Error('audit offline');
    await expect(subject.service.search(REQUEST)).rejects.toMatchObject({
      code: 'unavailable',
    } satisfies Partial<ReadableSearchError>);
    expect(subject.audits).toHaveLength(0);
  });

  it('waits behind a queued fence writer before final audit commitment', async () => {
    const found = candidate();
    const subject = harness({ candidates: [found], fetched: [item(found)] });
    const writer = await subject.fence.acquireWrite();
    const pending = subject.service.search(REQUEST);
    await Promise.resolve();
    await Promise.resolve();
    expect(subject.audits).toHaveLength(0);
    writer.release();
    const response = await pending;
    expect(response.status_code).toBe(200);
    handoff(response);
    expect(subject.audits).toHaveLength(1);
  });

  it('keeps each concurrent final audit bound to its own authenticated request', async () => {
    const fence = new ReadableSearchAuthorizationFence();
    const aOpened = deferred<void>();
    const continueA = deferred<void>();
    const auditRequestIds: string[] = [];
    const found = candidate();
    const retrieval: ReadableSearchRetrievalPort = {
      openScope: async ({ authenticated }) => {
        if (authenticated.request.request_id === REQUEST.request_id) {
          aOpened.resolve();
          await continueA.promise;
        }
        return scope();
      },
      search: () => [found],
      fetch: () => [item(found)],
      close: () => undefined,
    };
    const authority: ReadableSearchAuthorityStatePort = {
      authenticate: (request) => ({
        request,
        request_sha256:
          request.request_id === REQUEST.request_id ? digest('a') : digest('b'),
      }),
      currentPerson: () => person(),
      writeAtLinearization: (authenticated, selectedScope, selected, operation) =>
        operation({
          person: person(),
          checked_at: CHECKED_AT,
          scope_still_admitted:
            selectedScope === null ||
            selectedScope.selected_policy_paths_still_match(selected),
          appendQueryAudit: () => {
            auditRequestIds.push(authenticated.request.request_id);
          },
        }),
    };
    const service = new ReadableSearchService({
      authority,
      retrieval,
      fence,
      contract: {
        retrieval_contract_sha256: digest('4'),
        policy_contracts: [
          {
            policy_id: 'organization-member-readable-v1',
            policy_contract_sha256: digest('5'),
          },
          {
            policy_id: 'restricted-reviewer-v1',
            policy_contract_sha256: digest('6'),
          },
        ],
      },
    });

    const pendingA = service.search(REQUEST);
    await aOpened.promise;
    const responseB = await service.search(REQUEST_B);
    handoff(responseB);
    continueA.resolve();
    const responseA = await pendingA;
    handoff(responseA);

    expect(auditRequestIds).toEqual([REQUEST_B.request_id, REQUEST.request_id]);
  });
});
