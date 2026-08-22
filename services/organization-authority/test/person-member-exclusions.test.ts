import { ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH } from '@echo-brain/organization-api';
import { describe, expect, it, vi } from 'vitest';
import { PersonMemberExclusionService } from '../src/application/person-member-exclusions.js';
import type {
  PersonAccessAuthorization,
  PersonAuthenticatedWritePort,
} from '../src/application/person-identity-sessions.js';
import type { AuthorityWriteTransaction } from '../src/application/ports/authority-repository.js';
import { ReadableSearchAuthorizationFence } from '../src/application/readable-search-authorization-fence.js';
import { AuthorityOperationError } from '../src/domain/errors.js';

const AUTHORITY_ID = 'oau_00000000-0000-4000-8000-000000000001';
const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = 'prn_00000000-0000-4000-8000-000000000001';
const MEMBERSHIP_ID = 'mem_00000000-0000-4000-8000-000000000001';

const AUTHORIZATION: PersonAccessAuthorization = {
  organization_id: ORGANIZATION_ID,
  principal_id: PRINCIPAL_ID,
  membership_id: MEMBERSHIP_ID,
  membership_type: 'employee',
  identity_binding_id: 'oib_00000000-0000-4000-8000-000000000001',
  session_family_id: 'psf_00000000-0000-4000-8000-000000000001',
  access_credential_sha256: `sha256:${'a'.repeat(64)}`,
  access_expires_at: '2026-08-18T12:00:00.000Z',
  hard_reauthentication_at: '2026-08-25T00:00:00.000Z',
  person_state_sha256: `sha256:${'b'.repeat(64)}`,
  session_state_sha256: `sha256:${'c'.repeat(64)}`,
  checked_at: '2026-08-18T00:00:00.000Z',
};

function request() {
  return {
    schema_version: 2,
    kind: 'echo-organization-person-member-exclusion-change-request',
    request_id: 'mex_00000000-0000-4000-8000-000000000001',
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    subject_principal_id: PRINCIPAL_ID,
    http_method: 'POST',
    http_path: ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH,
    excluded: true,
    selector: {
      scope: 'meeting',
      source_adapter_id: 'granola',
      source_instance_id: 'member-source',
      external_id: 'meeting-external-id',
    },
  } as const;
}

function service(
  setMemberExclusionForOwner = vi.fn(() => true),
  authorize: 'allow' | 'deny' = 'allow',
) {
  const fence = new ReadableSearchAuthorizationFence();
  const accessTokens: string[] = [];
  const authentication: PersonAuthenticatedWritePort = {
    withAuthenticatedWrite: (input) => {
      accessTokens.push(input.access_token);
      if (authorize === 'deny') {
        throw new AuthorityOperationError(
          'unauthorized',
          'person authentication failed',
        );
      }
      return input.commit(
        AUTHORIZATION,
        { setMemberExclusionForOwner } as unknown as AuthorityWriteTransaction,
      );
    },
  };
  return {
    fence,
    accessTokens,
    setMemberExclusionForOwner,
    application: new PersonMemberExclusionService({
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      authentication,
      authorization_fence: fence,
    }),
  };
}

describe('PersonMemberExclusionService', () => {
  it('derives the exact owner tuple from the Person token and applies desired state', async () => {
    const context = service();
    await expect(
      context.application.change(request(), 'person-access-token'),
    ).resolves.toBeUndefined();
    expect(context.accessTokens).toEqual(['person-access-token']);
    expect(context.setMemberExclusionForOwner).toHaveBeenCalledWith(
      {
        organization_id: ORGANIZATION_ID,
        principal_id: PRINCIPAL_ID,
        membership_id: MEMBERSHIP_ID,
        membership_type: 'employee',
        source_adapter_id: 'granola',
        source_instance_id: 'member-source',
      },
      request().selector,
      true,
    );
  });

  it('collapses subject and source-owner mismatches to opaque authorization failure', async () => {
    const wrongSubject = service();
    await expect(
      wrongSubject.application.change(
        {
          ...request(),
          subject_principal_id:
            'prn_00000000-0000-4000-8000-000000000002',
        },
        'person-access-token',
      ),
    ).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(wrongSubject.setMemberExclusionForOwner).not.toHaveBeenCalled();

    const wrongSource = service(vi.fn(() => false));
    await expect(
      wrongSource.application.change(request(), 'person-access-token'),
    ).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('re-authenticates every mutation and never reaches storage for an inactive session', async () => {
    const context = service(vi.fn(() => true), 'deny');
    await expect(
      context.application.change(request(), ''),
    ).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(context.accessTokens).toEqual(['']);
    expect(context.setMemberExclusionForOwner).not.toHaveBeenCalled();
  });

  it('enters the authenticated transaction only after acquiring the shared write fence', async () => {
    const context = service();
    const reader = await context.fence.acquireRead();
    const mutation = context.application.change(request(), 'person-access-token');
    await Promise.resolve();
    expect(context.accessTokens).toEqual([]);
    reader.release();
    await mutation;
    expect(context.accessTokens).toEqual(['person-access-token']);
  });
});
