import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  createOrganizationAuthorityHttpServer,
} from '../src/presentation/http-server.js';
import type { OrganizationAuthorityHttpApplication } from '../src/presentation/organization-authority-http-application.js';
import type { OrganizationIntegrationsHttpApplication } from '../src/presentation/organization-integrations-http-application.js';
import { closeAuthorityServer } from '../src/composition/runtime.js';

function unexpectedCall(): never {
  throw new Error('unexpected application call');
}

function authorityApplication(): OrganizationAuthorityHttpApplication {
  return {
    descriptor: unexpectedCall,
    adminOverview: unexpectedCall,
    listMemberships: unexpectedCall,
    listInstallations: unexpectedCall,
    listEnrollmentGrants: unexpectedCall,
    listAudit: unexpectedCall,
    internalLiveRolloutStatus: unexpectedCall,
    approveInternalLiveRelease: unexpectedCall,
    fetchInternalLiveDirective: unexpectedCall,
    recordInternalLiveUpdateReceipt: unexpectedCall,
    provisionMembership: unexpectedCall,
    issueEnrollmentGrant: unexpectedCall,
    completeEnrollment: unexpectedCall,
    issueAccessLease: unexpectedCall,
    checkPermissionSubject: unexpectedCall,
    checkReviewerPermissionSubject: unexpectedCall,
    revokeMembership: unexpectedCall,
    revokeInstallation: unexpectedCall,
    recoverInstallationAccess: unexpectedCall,
  };
}

describe('organization Authority runtime shutdown', () => {
  it('fails at the deadline when an in-flight handler ignores shutdown', async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finishHandler: (() => void) | undefined;
    const handlerFinished = new Promise<void>((resolve) => {
      finishHandler = resolve;
    });
    const integrations: OrganizationIntegrationsHttpApplication = {
      overview: unexpectedCall,
      onboardSlackOrganizationTool: async () => {
        markStarted?.();
        await handlerFinished;
        throw new Error('test handler released after forced shutdown');
      },
      activateSlackApproval: unexpectedCall,
      beginSlackIdentityLink: unexpectedCall,
      completeSlackIdentityLink: unexpectedCall,
      checkPermission: unexpectedCall,
      checkReviewerPermission: unexpectedCall,
    };
    const server = createOrganizationAuthorityHttpServer({
      application: authorityApplication(),
      integrations,
      adminAuthenticator: { authenticate: () => true },
      clientIdentityResolver: { resolve: () => 'cid_test' },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const request = fetch(
      `http://127.0.0.1:${address.port}/v1/admin/integrations/slack`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer test',
          'content-type': 'application/json',
        },
        body: '{}',
      },
    ).catch(() => undefined);
    await started;
    const closed = once(server, 'close');

    await expect(closeAuthorityServer(server, 10)).rejects.toThrow(
      'organization authority graceful shutdown deadline exceeded',
    );

    finishHandler?.();
    await request;
    await closed;
  });
});
