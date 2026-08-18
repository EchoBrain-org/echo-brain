import { describe, expect, it } from 'vitest';
import type { OrganizationInstallationAccessDecisionV1 } from '@echo-brain/organization-protocol';
import {
  OrganizationRuntimeAccessController,
  type OrganizationRuntimeAccessSession,
} from '../../../src/processing/authorization/runtime-access-controller.js';

function active(validUntil: string): OrganizationInstallationAccessDecisionV1 {
  return {
    permitted: true,
    state: {
      status: 'active',
      valid_until: validUntil,
    },
  } as OrganizationInstallationAccessDecisionV1;
}

function revoked(): OrganizationInstallationAccessDecisionV1 {
  return {
    permitted: false,
    state: {
      status: 'revoked',
      revocation_reason: 'membership_revoked',
    },
  } as OrganizationInstallationAccessDecisionV1;
}

function runtime(options: {
  current(): OrganizationInstallationAccessDecisionV1;
  refresh(): Promise<OrganizationInstallationAccessDecisionV1>;
  closed(): void;
}): OrganizationRuntimeAccessSession {
  return {
    coordinator: {
      currentAccess: options.current,
      refreshAccess: options.refresh,
    },
    close: options.closed,
  };
}

describe('organization runtime access controller', () => {
  it('uses an unexpired signed lease without unnecessary authority contact', async () => {
    let refreshes = 0;
    let closes = 0;
    const controller = new OrganizationRuntimeAccessController({
      now: () => '2026-07-28T20:00:00.000Z',
      openRuntime: () =>
        runtime({
          current: () => active('2026-07-28T20:05:00.000Z'),
          refresh: async () => {
            refreshes += 1;
            return active('2026-07-28T20:05:00.000Z');
          },
          closed: () => {
            closes += 1;
          },
        }),
    });

    await controller.assertAuthorized();
    expect(refreshes).toBe(0);
    expect(closes).toBe(1);
  });

  it('fails closed when refresh records a revocation', async () => {
    const controller = new OrganizationRuntimeAccessController({
      now: () => '2026-07-28T20:00:00.000Z',
      openRuntime: () =>
        runtime({
          current: () => {
            throw new Error('active lease expired');
          },
          refresh: async () => revoked(),
          closed: () => undefined,
        }),
    });

    await expect(controller.assertAuthorized()).rejects.toThrow(
      'membership revoked',
    );
  });

  it('uses only the remaining signed lease during a transient outage', async () => {
    let now = '2026-07-28T20:00:00.000Z';
    const controller = new OrganizationRuntimeAccessController({
      now: () => now,
      renewalLeadMs: 60_000,
      openRuntime: () =>
        runtime({
          current: () => {
            const decision = active('2026-07-28T20:00:30.000Z');
            if (Date.parse(now) >= Date.parse(decision.state.valid_until!)) {
              throw new Error('active lease expired');
            }
            return decision;
          },
          refresh: async () => {
            throw new Error('authority unavailable');
          },
          closed: () => undefined,
        }),
    });

    await expect(controller.assertAuthorized()).resolves.toBeUndefined();
    now = '2026-07-28T20:00:31.000Z';
    await expect(controller.assertAuthorized()).rejects.toThrow(
      'authority unavailable',
    );
  });
});
