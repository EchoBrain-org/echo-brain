import type { InstallationSigner } from '../machine/security/installation-signer.js';
import { HttpOrganizationAuthorityClient } from './client/http-organization-authority-client.js';
import { LocalOrganizationCoordinator } from './enrollment/local-organization-coordinator.js';
import { SqliteOrganizationStateStore } from './state/sqlite-organization-state-store.js';

export const DEFAULT_LOCAL_ORGANIZATION_LEASE_TTL_MS = 5 * 60 * 1000;

export interface CreateLocalOrganizationRuntimeOptions {
  databasePath: string;
  authorityBaseUrl: string;
  installationSigner: InstallationSigner;
  maximumActiveLeaseTtlMs?: number;
  allowedClockSkewMs?: number;
  allowInsecureLoopback?: boolean;
  fetch?: typeof fetch;
}

export interface LocalOrganizationRuntime {
  coordinator: LocalOrganizationCoordinator;
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
    });
    return Object.freeze({
      coordinator,
      close: () => state.close(),
    });
  } catch (error) {
    state.close();
    throw error;
  }
}
