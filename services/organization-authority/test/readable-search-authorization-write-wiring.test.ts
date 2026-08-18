import { describe, expect, it } from 'vitest';
import { ReadableSearchAuthorizationFence } from '../src/application/readable-search-authorization-fence.js';
import {
  AUTHORIZATION_RELEVANT_AUTHORITY_MUTATIONS,
  AUTHORIZATION_RELEVANT_PERSON_SESSION_MUTATIONS,
  fenceAuthorizationRelevantAuthorityMutations,
  fenceAuthorizationRelevantPersonSessionMutations,
} from '../src/composition/readable-search-authorization-writes.js';
import type { OrganizationAuthorityApplication } from '../src/application/organization-authority.js';
import type { PersonIdentitySessionHttpApplication } from '../src/presentation/person-identity-session-http-application.js';

async function turns(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('readable-search authorization write wiring', () => {
  it('covers every live Authority current-Person mutation with an owned facade method', () => {
    const fence = new ReadableSearchAuthorizationFence();
    const application = {
      provisionMembership: () => ({ membership_id: 'member' }),
      issueEnrollmentGrant: () => ({ membership_id: 'member' }),
      completeEnrollment: async () => ({ enrollment_receipt: {}, access_state: {} }),
      issueAccessLease: async () => ({}),
      revokeMembership: async () => ({}),
      revokeInstallation: async () => ({}),
      recoverInstallationAccess: async () => ({}),
    } as unknown as OrganizationAuthorityApplication;
    const facade = fenceAuthorizationRelevantAuthorityMutations(
      application,
      fence,
    );

    expect(Object.getOwnPropertyNames(facade)).toEqual(
      expect.arrayContaining([...AUTHORIZATION_RELEVANT_AUTHORITY_MUTATIONS]),
    );
  });

  it('holds a search read through its result, then commits the queued mutation before a later search can enter', async () => {
    const fence = new ReadableSearchAuthorizationFence();
    const events: string[] = [];
    const application = {
      provisionMembership: () => {
        events.push('mutation-committed');
        return { membership_id: 'member' };
      },
    } as unknown as OrganizationAuthorityApplication;
    const facade = fenceAuthorizationRelevantAuthorityMutations(
      application,
      fence,
    );
    const firstSearch = await fence.acquireRead();
    const mutation = facade.provisionMembership({} as never);
    const laterSearch = fence.withRead(() => {
      events.push('later-search-entered');
    });

    await turns();
    expect(events).toEqual([]);
    firstSearch.release();
    await mutation;
    await laterSearch;
    expect(events).toEqual(['mutation-committed', 'later-search-entered']);
  });

  it('fences every Person-session mutation that invalidates active read credentials', async () => {
    const fence = new ReadableSearchAuthorizationFence();
    const events: string[] = [];
    const application = {
      refresh: () => {
        events.push('refresh-committed');
        return {};
      },
      revoke: () => {
        events.push('revoke-committed');
      },
    } as unknown as PersonIdentitySessionHttpApplication;
    const facade = fenceAuthorizationRelevantPersonSessionMutations(
      application,
      fence,
    );
    expect(Object.getOwnPropertyNames(facade)).toEqual(
      expect.arrayContaining([...AUTHORIZATION_RELEVANT_PERSON_SESSION_MUTATIONS]),
    );

    const responseHandoff = await fence.acquireRead();
    const refresh = facade.refresh({ refresh_token: 'opaque-refresh' });
    const laterSearch = fence.withRead(() => {
      events.push('later-search-entered');
    });
    await turns();
    expect(events).toEqual([]);

    responseHandoff.release();
    await refresh;
    await laterSearch;
    expect(events).toEqual(['refresh-committed', 'later-search-entered']);

    await facade.revoke({
      credential_kind: 'access',
      credential: 'opaque-access',
      reason: 'person_logout',
    });
    expect(events).toEqual([
      'refresh-committed',
      'later-search-entered',
      'revoke-committed',
    ]);
  });
});
