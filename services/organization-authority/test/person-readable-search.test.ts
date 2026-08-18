import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import type { OrganizationPersonReadableSearchRequestV2 } from '@echo-brain/organization-api';
import { PersonReadUnauthorizedError } from '../src/application/person-identity-sessions.js';
import {
  canonicalPersonReadRequestSha256,
  personReadAuthenticatedEvidence,
} from '../src/application/person-read-caller-binding.js';
import {
  PersonReadableSearchService,
} from '../src/application/person-readable-search.js';
import type { PersonReadAuthorizationPort } from '../src/application/person-identity-sessions.js';
import type {
  PersonReadDecisionAuditEntry,
} from '../src/application/ports/authority-repository.js';
import {
  canonicalReadableSearchAllowResponse,
  type ReadableSearchCandidate,
  type ReadableSearchRetrievalPort,
  type ReadableSearchScope,
} from '../src/application/readable-search.js';
import { ReadableSearchAuthorizationFence } from '../src/application/readable-search-authorization-fence.js';
import { readableSearchScopeBindingSha256 } from '../src/composition/readable-search.js';

const digest = (character: string): Sha256Digest => `sha256:${character.repeat(64)}`;
const request: OrganizationPersonReadableSearchRequestV2 = {
  schema_version: 2,
  kind: 'echo-organization-person-readable-search-request',
  request_id: 'osq_00000000-0000-4000-8000-000000000001',
  authority_id: 'oau_00000000-0000-4000-8000-000000000001',
  organization_id: 'org_00000000-0000-4000-8000-000000000001',
  subject_principal_id: 'prn_00000000-0000-4000-8000-000000000001',
  http_method: 'POST',
  http_path: '/v2/readable-search',
  query: 'decision',
};
const admission = {
  organization_id: request.organization_id,
  principal_id: request.subject_principal_id,
  membership_id: 'mem_00000000-0000-4000-8000-000000000001',
  membership_type: 'employee' as const,
  identity_binding_id: 'idb_00000000-0000-4000-8000-000000000001',
  session_family_id: 'psf_00000000-0000-4000-8000-000000000001',
  access_credential_sha256: digest('a'),
  access_expires_at: '2026-08-18T12:00:00.000Z',
  hard_reauthentication_at: '2026-08-25T00:00:00.000Z',
  person_state_sha256: digest('b'),
  session_state_sha256: digest('c'),
  checked_at: '2026-08-18T00:00:00.000Z',
};
const candidate: ReadableSearchCandidate = {
  atom_id: digest('d'), record_hash: digest('e'), policy_id: 'organization-member-readable-v1',
};

function scope(stillMatches = () => true): ReadableSearchScope {
  return {
    binding: {
      generation_id: digest('1'), manifest_sha256: digest('2'),
      record_head_position: 1, record_head_hash: digest('3'),
      retrieval_contract_sha256: digest('4'),
      policy_contracts: [
        { policy_id: 'organization-member-readable-v1', policy_contract_sha256: digest('5') },
        { policy_id: 'restricted-reviewer-v1', policy_contract_sha256: digest('6') },
      ],
    },
    scope_binding_sha256: digest('7'), reviewer_tuple: null,
    selected_policy_paths_still_match: stillMatches,
  };
}

function handoff(response: Awaited<ReturnType<PersonReadableSearchService['search']>>): Buffer {
  let value: string | undefined;
  response.handoff((body) => { value = body; });
  if (value === undefined) throw new Error('response did not hand off');
  return Buffer.from(value, 'utf8');
}

function harness(config: {
  readonly start?: 'allow' | 'deny' | 'mismatch';
  readonly final?: 'allow' | 'deny';
  readonly still_matches?: () => boolean;
  readonly fence_timeout_ms?: number;
} = {}) {
  const audits: PersonReadDecisionAuditEntry[] = [];
  const calls = { opened: 0, searched: 0, fetched: 0, closed: 0 };
  const opened: unknown[] = [];
  const transaction = {
    appendPersonReadDecisionAudit(entry: PersonReadDecisionAuditEntry) {
      audits.push(entry);
      return {};
    },
  };
  const authorization: PersonReadAuthorizationPort = {
    admitSelfRead(input) {
      if (config.start === 'deny') {
        input.commitStartDeny({
          decision: 'deny',
          reason_code: 'person_or_session_inactive',
          authorization: null,
          checked_at: admission.checked_at,
        }, transaction as never);
        throw new PersonReadUnauthorizedError();
      }
      if (config.start === 'mismatch') {
        input.commitStartDeny({
          decision: 'deny',
          reason_code: 'caller_subject_mismatch',
          authorization: admission,
          checked_at: admission.checked_at,
        }, transaction as never);
        throw new PersonReadUnauthorizedError();
      }
      return admission;
    },
    finalizeSelfRead(input) {
      if (config.final === 'deny') {
        input.commit({
          decision: 'deny', reason_code: 'person_or_session_inactive', checked_at: admission.checked_at,
        }, transaction as never);
        throw new PersonReadUnauthorizedError();
      }
      return input.commit({ decision: 'allow', authorization: admission }, transaction as never);
    },
  };
  const retrieval: ReadableSearchRetrievalPort = {
    openScope(value) { calls.opened += 1; opened.push(value); return scope(config.still_matches); },
    search() { calls.searched += 1; return [candidate]; },
    fetch() {
      calls.fetched += 1;
      return [{ ...candidate, kind: 'decision' as const, text: 'A complete approved decision.' }];
    },
    finalStateStillMatches(value, _transaction, selected) {
      return value.selected_policy_paths_still_match(selected);
    },
    close() { calls.closed += 1; },
  };
  const fence = new ReadableSearchAuthorizationFence();
  const service = new PersonReadableSearchService({
    authority_id: request.authority_id, organization_id: request.organization_id,
    authorization, retrieval, fence,
    fence_timeout_ms: config.fence_timeout_ms ?? 1000,
    contract: {
      retrieval_contract_sha256: digest('4'),
      policy_contracts: [
        { policy_id: 'organization-member-readable-v1', policy_contract_sha256: digest('5') },
        { policy_id: 'restricted-reviewer-v1', policy_contract_sha256: digest('6') },
      ],
    },
  });
  return { service, audits, calls, opened, fence };
}

function stageOneCallerBinding(): Sha256Digest {
  return personReadAuthenticatedEvidence(admission, {
    authority_id: request.authority_id,
    organization_id: request.organization_id,
    subject_principal_id: request.subject_principal_id,
    operation: 'readable_search',
    request_sha256: canonicalPersonReadRequestSha256(request),
  }).caller_binding_sha256;
}

describe('Person readable search', () => {
  it('freezes the V2 scope receipt while preserving the V1 receipt preimage', () => {
    const binding = scope().binding;
    const admittedSegments = [
      { policy_id: 'organization-member-readable-v1', segment_manifest_sha256: digest('8') },
    ];
    const personAdmission = {
      kind: 'person-v2' as const,
      request_sha256: digest('9'),
      principal_id: admission.principal_id,
      membership_id: admission.membership_id,
      membership_type: admission.membership_type,
      person_state_sha256: admission.person_state_sha256,
      caller_binding_sha256: digest('a'),
    };
    expect(readableSearchScopeBindingSha256({
      admission: personAdmission, binding, admitted_segments: admittedSegments,
    })).toBe(canonicalSha256({
      schema_version: 2,
      kind: 'readable-search-scope-binding-v2',
      request_sha256: digest('9'),
      caller_binding_sha256: digest('a'),
      retrieval_contract_sha256: binding.retrieval_contract_sha256,
      policy_contracts: binding.policy_contracts,
      generation: { generation_id: binding.generation_id, manifest_sha256: binding.manifest_sha256 },
      record_head: { position: binding.record_head_position, record_hash: binding.record_head_hash },
      admitted_segments: admittedSegments,
    }));
    const v1Admission = {
      kind: 'installation-v1' as const,
      request_sha256: digest('9'),
      principal_id: admission.principal_id,
      membership_id: admission.membership_id,
      membership_type: admission.membership_type,
      enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
      installation_id: 'ins_00000000-0000-4000-8000-000000000001',
      person_state_sha256: admission.person_state_sha256,
    };
    expect(readableSearchScopeBindingSha256({
      admission: v1Admission, binding, admitted_segments: admittedSegments,
    })).toBe(canonicalSha256({
      schema_version: 1,
      kind: 'readable-search-scope-binding-v1',
      request_sha256: digest('9'),
      requester: {
        principal_id: admission.principal_id, membership_id: admission.membership_id,
        membership_type: admission.membership_type, enrollment_id: v1Admission.enrollment_id,
        installation_id: v1Admission.installation_id,
      },
      person_state_sha256: admission.person_state_sha256,
      operation: 'search-readable',
      retrieval_contract_sha256: binding.retrieval_contract_sha256,
      policy_contracts: binding.policy_contracts,
      generation: { generation_id: binding.generation_id, manifest_sha256: binding.manifest_sha256 },
      record_head: { position: binding.record_head_position, record_hash: binding.record_head_hash },
      admitted_segments: admittedSegments,
    }));
  });

  it('reuses the V1 response bytes and hands the source off exactly once', async () => {
    const subject = harness();
    const response = await subject.service.search(request, 'access-token');
    expect(handoff(response)).toEqual(canonicalReadableSearchAllowResponse([
      { ...candidate, kind: 'decision', text: 'A complete approved decision.' },
    ]).response_bytes);
    expect(subject.audits).toMatchObject([{ decision: 'allow', reason_code: 'active_person_session' }]);
    expect(subject.audits[0]?.authenticated?.caller_binding_sha256).toBe(digest('7'));
    expect(subject.calls).toEqual({ opened: 1, searched: 1, fetched: 1, closed: 1 });
    expect(subject.opened[0]).toMatchObject({ kind: 'person-v2' });
    expect(subject.opened[0]).not.toHaveProperty('enrollment_id');
    expect(subject.opened[0]).not.toHaveProperty('installation_id');
  });

  it('audits a bad session before opening any retrieval source', async () => {
    const subject = harness({ start: 'deny' });
    const response = await subject.service.search(request, 'bad-token');
    expect(response.status_code).toBe(401);
    expect(subject.calls).toEqual({ opened: 0, searched: 0, fetched: 0, closed: 0 });
    expect(subject.audits).toMatchObject([{ decision: 'deny', reason_code: 'person_or_session_inactive' }]);
  });

  it('audits a caller-subject mismatch before opening any retrieval source', async () => {
    const subject = harness({ start: 'mismatch' });
    const response = await subject.service.search(request, 'access-token');
    expect(response.status_code).toBe(401);
    expect(subject.calls).toEqual({ opened: 0, searched: 0, fetched: 0, closed: 0 });
    expect(subject.audits).toMatchObject([{ decision: 'deny', reason_code: 'caller_subject_mismatch' }]);
    expect(subject.audits[0]?.authenticated?.caller_binding_sha256).toBe(
      stageOneCallerBinding(),
    );
  });

  it('releases the source without content when the session is revoked mid-read', async () => {
    const subject = harness({ final: 'deny' });
    const response = await subject.service.search(request, 'access-token');
    expect(response.status_code).toBe(401);
    expect(subject.calls).toEqual({ opened: 1, searched: 1, fetched: 1, closed: 1 });
    expect(subject.audits).toMatchObject([{ decision: 'deny', reason_code: 'person_or_session_inactive' }]);
    expect(subject.audits[0]?.authenticated?.caller_binding_sha256).toBe(digest('7'));
  });

  it('maps a final fence timeout to unavailable and closes the opened scope', async () => {
    const subject = harness({ fence_timeout_ms: 5 });
    const writer = await subject.fence.acquireWrite();
    try {
      await expect(subject.service.search(request, 'access-token')).rejects.toMatchObject({
        code: 'unavailable',
      });
    } finally {
      writer.release();
    }
    expect(subject.calls).toEqual({ opened: 1, searched: 1, fetched: 1, closed: 1 });
    expect(subject.audits).toEqual([]);
  });

  it('treats retrieval drift as unavailable and releases without a false auth audit', async () => {
    const subject = harness({ still_matches: () => false });
    await expect(subject.service.search(request, 'access-token')).rejects.toMatchObject({ code: 'unavailable' });
    expect(subject.calls).toEqual({ opened: 1, searched: 1, fetched: 1, closed: 1 });
    expect(subject.audits).toEqual([]);
  });
});
