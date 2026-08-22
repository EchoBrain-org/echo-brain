import { Buffer } from 'node:buffer';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_API_ADMIN_MEMBER_EXCLUSION_BREAK_GLASS_PATH,
  ORGANIZATION_API_PERSON_MEMBER_EXCLUSION_LIST_PATH,
} from '@echo-brain/organization-api';
import { describe, expect, it, vi } from 'vitest';
import {
  PersonMemberExclusionReadService,
} from '../src/application/person-member-exclusion-reads.js';
import {
  PersonReadUnauthorizedError,
  type PersonAccessAuthorization,
  type PersonReadAuthorizationPort,
} from '../src/application/person-identity-sessions.js';
import type {
  AuthorityWriteTransaction,
  MemberExclusionReadAuditEntry,
  OrganizationAuthorityRepository,
  StoredAuthorityMembership,
  StoredMemberExclusionSelector,
} from '../src/application/ports/authority-repository.js';
import { ReadableSearchAuthorizationFence } from '../src/application/readable-search-authorization-fence.js';

const AUTHORITY_ID = 'oau_00000000-0000-4000-8000-000000000001';
const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = 'prn_00000000-0000-4000-8000-000000000001';
const MEMBERSHIP_ID = 'mem_00000000-0000-4000-8000-000000000001';
const NOW = '2026-08-18T00:00:00.000Z';
const digest = (character: string): Sha256Digest =>
  `sha256:${character.repeat(64)}`;

const admission: PersonAccessAuthorization = {
  organization_id: ORGANIZATION_ID,
  principal_id: PRINCIPAL_ID,
  membership_id: MEMBERSHIP_ID,
  membership_type: 'employee',
  identity_binding_id: 'oib_00000000-0000-4000-8000-000000000001',
  session_family_id: 'psf_00000000-0000-4000-8000-000000000001',
  access_credential_sha256: digest('a'),
  access_expires_at: '2026-08-18T12:00:00.000Z',
  hard_reauthentication_at: '2026-08-25T00:00:00.000Z',
  person_state_sha256: digest('b'),
  session_state_sha256: digest('c'),
  checked_at: NOW,
};

const ownerMembership: StoredAuthorityMembership = {
  organization_id: ORGANIZATION_ID,
  principal_id: PRINCIPAL_ID,
  membership_id: MEMBERSHIP_ID,
  display_name: 'Member',
  membership_type: 'employee',
  status: 'active',
  provisioned_at: NOW,
  revoked_at: null,
  revocation_reason: null,
  admin_command_id: null,
  admin_command_sha256: null,
};

const exclusions: readonly StoredMemberExclusionSelector[] = [
  {
    scope: 'source',
    source_adapter_id: 'sentinel-adapter',
    source_instance_id: 'sentinel-instance',
  },
  {
    scope: 'meeting',
    source_adapter_id: 'sentinel-adapter',
    source_instance_id: 'sentinel-instance',
    external_id: 'sentinel-meeting',
  },
];

const personRequest = {
  schema_version: 2,
  kind: 'echo-organization-person-member-exclusion-list-request',
  request_id: 'mex_00000000-0000-4000-8000-000000000001',
  authority_id: AUTHORITY_ID,
  organization_id: ORGANIZATION_ID,
  subject_principal_id: PRINCIPAL_ID,
  http_method: 'POST',
  http_path: ORGANIZATION_API_PERSON_MEMBER_EXCLUSION_LIST_PATH,
  source_adapter_id: 'sentinel-adapter',
  source_instance_id: 'sentinel-instance',
} as const;

const adminRequest = {
  schema_version: 2,
  kind: 'echo-organization-admin-member-exclusion-break-glass-read-request',
  request_id: 'mex_00000000-0000-4000-8000-000000000002',
  authority_id: AUTHORITY_ID,
  organization_id: ORGANIZATION_ID,
  target_principal_id: PRINCIPAL_ID,
  target_membership_id: MEMBERSHIP_ID,
  http_method: 'POST',
  http_path: ORGANIZATION_API_ADMIN_MEMBER_EXCLUSION_BREAK_GLASS_PATH,
  source_adapter_id: 'sentinel-adapter',
  source_instance_id: 'sentinel-instance',
} as const;

function handoff(
  response: Awaited<ReturnType<PersonMemberExclusionReadService['listOwn']>>,
): string {
  let body: string | undefined;
  response.handoff((value) => {
    body = value;
  });
  if (body === undefined) throw new Error('response was not handed off');
  return body;
}

function harness(input: {
  readonly start?: 'allow' | 'inactive' | 'mismatch';
  readonly final?: 'allow' | 'inactive';
  readonly selected?: readonly (
    | readonly StoredMemberExclusionSelector[]
    | undefined
  )[];
  readonly audit_failure?: boolean;
  readonly membership?: StoredAuthorityMembership | null;
} = {}) {
  const audits: MemberExclusionReadAuditEntry[] = [];
  const selected = [...(input.selected ?? [exclusions, exclusions])];
  const list = vi.fn(() => selected.shift());
  const append = vi.fn((entry: MemberExclusionReadAuditEntry) => {
    if (input.audit_failure) throw new Error('audit unavailable');
    audits.push(entry);
  });
  const transaction = {
    membership: vi.fn(() =>
      input.membership === null
        ? undefined
        : input.membership ?? ownerMembership,
    ),
    memberExclusionsForOwnerSource: list,
    appendMemberExclusionReadAudit: append,
  } as unknown as AuthorityWriteTransaction;
  const repository = {
    read<T>(operation: (value: AuthorityWriteTransaction) => T): T {
      return operation(transaction);
    },
    writeAtLinearization<T>(
      _observe: () => string,
      operation: (value: AuthorityWriteTransaction, observedAt: string) => T,
    ): T {
      return operation(transaction, NOW);
    },
  } as unknown as OrganizationAuthorityRepository;
  const authorization: PersonReadAuthorizationPort = {
    admitSelfRead(request) {
      if (input.start === 'inactive') {
        request.commitStartDeny(
          {
            decision: 'deny',
            reason_code: 'person_or_session_inactive',
            authorization: null,
            checked_at: NOW,
          },
          transaction,
        );
        throw new PersonReadUnauthorizedError();
      }
      if (input.start === 'mismatch') {
        request.commitStartDeny(
          {
            decision: 'deny',
            reason_code: 'caller_subject_mismatch',
            authorization: admission,
            checked_at: NOW,
          },
          transaction,
        );
        throw new PersonReadUnauthorizedError();
      }
      return admission;
    },
    finalizeSelfRead(request) {
      if (input.final === 'inactive') {
        request.commit(
          {
            decision: 'deny',
            reason_code: 'person_or_session_inactive',
            checked_at: NOW,
          },
          transaction,
        );
        throw new PersonReadUnauthorizedError();
      }
      return request.commit(
        { decision: 'allow', authorization: admission },
        transaction,
      );
    },
  };
  const fence = new ReadableSearchAuthorizationFence();
  return {
    audits,
    append,
    list,
    fence,
    service: new PersonMemberExclusionReadService({
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      authorization,
      repository,
      authorization_fence: fence,
      fence_timeout_ms: 1000,
      now: () => NOW,
    }),
  };
}

describe('Person member exclusion reads', () => {
  it('does both exact-owner lookups, audits exact bytes, and holds the fence through handoff', async () => {
    const subject = harness();
    const response = await subject.service.listOwn(personRequest, 'access');
    expect(subject.list).toHaveBeenCalledTimes(2);
    expect(subject.audits).toMatchObject([
      {
        actor_kind: 'person',
        decision: 'allow',
        reason_code: 'active_person_session',
        result_count: 2,
      },
    ]);
    let writerEntered = false;
    const writer = subject.fence.withWrite(() => {
      writerEntered = true;
    });
    await Promise.resolve();
    expect(writerEntered).toBe(false);
    const body = handoff(response);
    await writer;
    expect(writerEntered).toBe(true);
    expect(Buffer.from(body)).toEqual(subject.audits[0]?.response_bytes);
    expect(body).toContain('sentinel-meeting');
  });

  it('audits start and final denials without releasing selected bytes', async () => {
    for (const state of [
      { start: 'inactive' as const, reason: 'person_or_session_inactive' },
      { start: 'mismatch' as const, reason: 'caller_subject_mismatch' },
      { final: 'inactive' as const, reason: 'person_or_session_inactive' },
      {
        final: 'inactive' as const,
        selected: [undefined],
        reason: 'person_or_session_inactive',
      },
    ]) {
      const subject = harness(state);
      const response = await subject.service.listOwn(personRequest, 'access');
      expect(response.status_code).toBe(401);
      expect(handoff(response)).not.toContain('sentinel-meeting');
      expect(subject.audits).toMatchObject([
        { decision: 'deny', reason_code: state.reason, result_count: 0 },
      ]);
    }
  });

  it('denies a source-owner mismatch after the final Person lookup', async () => {
    const subject = harness({ selected: [undefined] });
    const response = await subject.service.listOwn(personRequest, 'access');
    expect(response.status_code).toBe(401);
    expect(subject.audits).toMatchObject([
      { decision: 'deny', reason_code: 'operation_not_permitted' },
    ]);
  });

  it('releases no stale bytes when exclusions change before final commitment', async () => {
    const subject = harness({ selected: [exclusions, []] });
    await expect(
      subject.service.listOwn(personRequest, 'access'),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(subject.audits).toEqual([]);
  });

  it('fails closed before returning a prepared Person or admin response when audit append fails', async () => {
    const person = harness({ audit_failure: true });
    await expect(
      person.service.listOwn(personRequest, 'access'),
    ).rejects.toThrow('audit unavailable');

    const admin = harness({
      audit_failure: true,
      selected: [exclusions],
    });
    await expect(
      admin.service.breakGlass(adminRequest, digest('d')),
    ).rejects.toThrow('audit unavailable');
    expect(person.append).toHaveBeenCalledOnce();
    expect(admin.append).toHaveBeenCalledOnce();
  });

  it('makes the exact admin target an explicit audited break-glass read', async () => {
    const subject = harness({ selected: [exclusions] });
    const response = await subject.service.breakGlass(adminRequest, digest('d'));
    expect(response.status_code).toBe(200);
    expect(subject.audits).toMatchObject([
      {
        actor_kind: 'admin_break_glass',
        actor_binding_sha256: digest('d'),
        decision: 'allow',
        reason_code: 'break_glass_authorized',
        result_count: 2,
      },
    ]);
    expect(handoff(response)).toContain('sentinel-meeting');
  });

  it('audits an unavailable break-glass target before its fixed 404', async () => {
    const subject = harness({ membership: null, selected: [] });
    subject.list.mockReturnValue(undefined);
    const response = await subject.service.breakGlass(adminRequest, digest('d'));
    expect(response.status_code).toBe(404);
    expect(handoff(response)).not.toContain('sentinel');
    expect(subject.audits).toMatchObject([
      {
        actor_kind: 'admin_break_glass',
        decision: 'deny',
        reason_code: 'break_glass_target_unavailable',
        result_count: 0,
      },
    ]);
  });
});
