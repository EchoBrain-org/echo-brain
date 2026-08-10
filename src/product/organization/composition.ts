import type { InstallationSigner } from '../machine/security/installation-signer.js';
import type { OrganizationAuthorityClient } from './client/authority-client.js';
import { HttpOrganizationAuthorityClient } from './client/http-organization-authority-client.js';
import {
  LocalOrganizationCoordinator,
  type LocalOrganizationClock,
  type LocalOrganizationRequestIds,
} from './enrollment/local-organization-coordinator.js';
import type { OrganizationStateStore } from './state/organization-state-store.js';
import { SqliteOrganizationStateStore } from './state/sqlite-organization-state-store.js';
import { OrganizationRecentDecisionsReader } from './recent-decisions-reader.js';
import { OrganizationSlackIdentityLinkCoordinator } from './slack-identity-link-coordinator.js';

export const DEFAULT_LOCAL_ORGANIZATION_LEASE_TTL_MS = 5 * 60 * 1000;

export interface CreateLocalOrganizationRuntimeOptions {
  databasePath: string;
  authorityBaseUrl: string;
  installationSigner: InstallationSigner;
  maximumActiveLeaseTtlMs?: number;
  allowedClockSkewMs?: number;
  clock: LocalOrganizationClock;
  requestIds?: LocalOrganizationRequestIds;
  slackLinkRequestIds?: {
    nextBeginRequestId(): string;
    nextCompleteRequestId(): string;
  };
  recentDecisionsRequestIds?: {
    nextRequestId(): string;
  };
  allowInsecureLoopback?: boolean;
  authorityCaPem?: string;
  fetch?: typeof fetch;
}

export interface LocalOrganizationRuntime {
  coordinator: LocalOrganizationCoordinator;
  recentDecisions: OrganizationRecentDecisionsReader;
  slackIdentityLinks: OrganizationSlackIdentityLinkCoordinator;
  authorityClient: OrganizationAuthorityClient;
  state: OrganizationStateStore;
  close(): void;
}

/** Wires one employee installation to one organization authority. */
export function createLocalOrganizationRuntime(
  options: CreateLocalOrganizationRuntimeOptions,
): LocalOrganizationRuntime {
  const state = new SqliteOrganizationStateStore(options.databasePath);
  try {
    const authorityClient = new HttpOrganizationAuthorityClient({
      baseUrl: options.authorityBaseUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.authorityCaPem === undefined
        ? {}
        : { authorityCaPem: options.authorityCaPem }),
      ...(options.allowInsecureLoopback === undefined
        ? {}
        : { allowInsecureLoopback: options.allowInsecureLoopback }),
    });
    const coordinator = new LocalOrganizationCoordinator({
      state,
      authorityClient,
      installationSigner: options.installationSigner,
      maximumActiveLeaseTtlMs:
        options.maximumActiveLeaseTtlMs ??
        DEFAULT_LOCAL_ORGANIZATION_LEASE_TTL_MS,
      ...(options.allowedClockSkewMs === undefined
        ? {}
        : { allowedClockSkewMs: options.allowedClockSkewMs }),
      clock: options.clock,
      ...(options.requestIds === undefined
        ? {}
        : { requestIds: options.requestIds }),
    });
    const slackIdentityLinks = new OrganizationSlackIdentityLinkCoordinator({
      state,
      authorityClient,
      installationSigner: options.installationSigner,
      now: () => options.clock.now(),
      ...(options.slackLinkRequestIds === undefined
        ? {}
        : {
            nextBeginRequestId:
              options.slackLinkRequestIds.nextBeginRequestId,
            nextCompleteRequestId:
              options.slackLinkRequestIds.nextCompleteRequestId,
          }),
    });
    const recentDecisions = new OrganizationRecentDecisionsReader({
      state,
      authorityClient,
      installationSigner: options.installationSigner,
      now: () => options.clock.now(),
      ...(options.recentDecisionsRequestIds === undefined
        ? {}
        : {
            nextRequestId: options.recentDecisionsRequestIds.nextRequestId,
          }),
    });
    return Object.freeze({
      coordinator,
      recentDecisions,
      slackIdentityLinks,
      authorityClient,
      state,
      close: () => state.close(),
    });
  } catch (error) {
    state.close();
    throw error;
  }
}
