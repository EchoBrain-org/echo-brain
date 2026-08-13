import type { InstallationSigner } from '../machine/security/installation-signer.js';
import type { OrganizationAuthorityClient } from './client/authority-client.js';
import { HttpOrganizationAuthorityClient } from './client/http-organization-authority-client.js';
import {
  LocalOrganizationCoordinator,
  DEFAULT_LOCAL_ORGANIZATION_REQUESTED_LEASE_TTL_MS,
  MAX_LOCAL_ORGANIZATION_ACTIVE_LEASE_TTL_MS,
  type LocalOrganizationClock,
  type LocalOrganizationRequestIds,
} from './enrollment/local-organization-coordinator.js';
import type { OrganizationStateStore } from './state/organization-state-store.js';
import { SqliteOrganizationStateStore } from './state/sqlite-organization-state-store.js';
import { OrganizationRecentDecisionsReader } from './recent-decisions-reader.js';
import { OrganizationReviewerRecentDecisionsReader } from './reviewer-recent-decisions-reader.js';
import { OrganizationReadableSearchReader } from './readable-search-reader.js';
import { OrganizationSlackIdentityLinkCoordinator } from './slack-identity-link-coordinator.js';

export {
  DEFAULT_LOCAL_ORGANIZATION_REQUESTED_LEASE_TTL_MS,
  MAX_LOCAL_ORGANIZATION_ACTIVE_LEASE_TTL_MS,
} from './enrollment/local-organization-coordinator.js';

/** @deprecated The legacy V1 product lease default. */
export const DEFAULT_LOCAL_ORGANIZATION_LEASE_TTL_MS = 5 * 60 * 1000;

export interface CreateLocalOrganizationRuntimeOptions {
  databasePath: string;
  authorityBaseUrl: string;
  installationSigner: InstallationSigner;
  maximumActiveLeaseTtlMs?: number;
  requestedActiveLeaseTtlMs?: number;
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
  reviewerRecentDecisionsRequestIds?: {
    nextRequestId(): string;
  };
  readableSearchRequestIds?: {
    nextRequestId(): string;
  };
  allowInsecureLoopback?: boolean;
  authorityCaPem?: string;
  fetch?: typeof fetch;
}

export interface LocalOrganizationRuntime {
  coordinator: LocalOrganizationCoordinator;
  recentDecisions: OrganizationRecentDecisionsReader;
  reviewerRecentDecisions: OrganizationReviewerRecentDecisionsReader;
  readableSearch: OrganizationReadableSearchReader;
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
        MAX_LOCAL_ORGANIZATION_ACTIVE_LEASE_TTL_MS,
      requestedActiveLeaseTtlMs:
        options.requestedActiveLeaseTtlMs ??
        options.maximumActiveLeaseTtlMs ??
        DEFAULT_LOCAL_ORGANIZATION_REQUESTED_LEASE_TTL_MS,
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
    const reviewerRecentDecisions = new OrganizationReviewerRecentDecisionsReader({
      state,
      authorityClient,
      installationSigner: options.installationSigner,
      now: () => options.clock.now(),
      ...(options.reviewerRecentDecisionsRequestIds === undefined
        ? {}
        : {
            nextRequestId:
              options.reviewerRecentDecisionsRequestIds.nextRequestId,
          }),
    });
    const readableSearch = new OrganizationReadableSearchReader({
      state,
      authorityClient,
      installationSigner: options.installationSigner,
      now: () => options.clock.now(),
      ...(options.readableSearchRequestIds === undefined
        ? {}
        : {
            nextRequestId: options.readableSearchRequestIds.nextRequestId,
          }),
    });
    return Object.freeze({
      coordinator,
      recentDecisions,
      reviewerRecentDecisions,
      readableSearch,
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
