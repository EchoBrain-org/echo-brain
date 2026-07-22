import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@echo-brain/federation-protocol';
import type { OrganizationEnrollmentRequestV1 } from '@echo-brain/organization-protocol';
import type { OrganizationAuthorityClient } from '../../src/product/organization/client/authority-client.js';
import { LocalOrganizationCoordinator } from '../../src/product/organization/enrollment/local-organization-coordinator.js';
import { SqliteOrganizationStateStore } from '../../src/product/organization/state/sqlite-organization-state-store.js';
import {
  ACCESS_REQUEST_ID,
  descriptorClient,
  enrollmentInput,
  MAX_TTL_MS,
  mutableClock,
  TestAuthority,
  TestInstallationSigner,
  type MutableClock,
} from '../support/local-organization-fixtures.js';

function coordinator(
  state: SqliteOrganizationStateStore,
  authorityClient: OrganizationAuthorityClient,
  installationSigner: TestInstallationSigner,
  clock: MutableClock,
): LocalOrganizationCoordinator {
  return new LocalOrganizationCoordinator({
    state,
    authorityClient,
    installationSigner,
    maximumActiveLeaseTtlMs: MAX_TTL_MS,
    clock,
    requestIds: {
      nextAccessLeaseRequestId: () => ACCESS_REQUEST_ID,
    },
  });
}

describe('local organization restart', () => {
  it('retries the exact retained request after response loss without resigning it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-local-org-restart-'));
    const databasePath = join(root, 'echo-brain.sqlite');
    const authority = new TestAuthority();
    const installationSigner = new TestInstallationSigner();
    let state: SqliteOrganizationStateStore | null =
      new SqliteOrganizationStateStore(databasePath);

    try {
      let firstRequest: OrganizationEnrollmentRequestV1 | null = null;
      const firstClient = descriptorClient(authority, {
        completeEnrollment: async ({ enrollmentRequest }) => {
          firstRequest = structuredClone(enrollmentRequest);
          await authority.complete(enrollmentRequest);
          throw new Error('simulated response loss');
        },
      });

      await expect(
        coordinator(
          state,
          firstClient,
          installationSigner,
          mutableClock(),
        ).enroll(enrollmentInput(authority)),
      ).rejects.toThrow(/simulated response loss/);
      expect(state.readEnrollment()?.receipt).toBeNull();
      expect(installationSigner.signCalls).toBe(1);

      state.close();
      state = new SqliteOrganizationStateStore(databasePath);
      let retriedRequest: OrganizationEnrollmentRequestV1 | null = null;
      const retryClient = descriptorClient(authority, {
        completeEnrollment: async ({ enrollmentRequest }) => {
          retriedRequest = structuredClone(enrollmentRequest);
          return authority.complete(enrollmentRequest);
        },
      });

      const decision = await coordinator(
        state,
        retryClient,
        installationSigner,
        mutableClock(),
      ).enroll(enrollmentInput(authority));

      expect(decision.permitted).toBe(true);
      expect(canonicalJson(retriedRequest)).toBe(canonicalJson(firstRequest));
      expect(installationSigner.signCalls).toBe(1);
    } finally {
      state?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
