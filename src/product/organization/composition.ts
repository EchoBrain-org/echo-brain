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

export const DEFAULT_LOCAL_ORGANIZATION_LEASE_TTL_MS = 5 * 60 * 1000;

export interface CreateLocalOrganizationRuntimeOptions {
  databasePath: string;
  authorityBaseUrl: string;
  installationSigner: InstallationSigner;
  maximumActiveLeaseTtlMs?: number;
  allowedClockSkewMs?: number;
  clock?: LocalOrganizationClock;
  requestIds?: LocalOrganizationRequestIds;
  allowInsecureLoopback?: boolean;
  authorityCaPem?: string;
  fetch?: typeof fetch;
}

export interface LocalOrganizationRuntime {
  coordinator: LocalOrganizationCoordinator;
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
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.requestIds === undefined
        ? {}
        : { requestIds: options.requestIds }),
    });
    return Object.freeze({
      coordinator,
      authorityClient,
      state,
      close: () => state.close(),
    });
  } catch (error) {
    state.close();
    throw error;
  }
}
