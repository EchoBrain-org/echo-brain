import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { AdminBearerAuthenticator } from '../adapters/security/admin-bearer-authenticator.js';
import { DevelopmentFileOrganizationAuthoritySigner } from '../adapters/security/development-file-authority-signer.js';
import {
  RandomAuthorityIdentifierGenerator,
  SystemAuthorityClock,
} from '../adapters/runtime/system-runtime-ports.js';
import { SqliteOrganizationAuthorityRepository } from '../adapters/persistence/sqlite/sqlite-authority-repository.js';
import { OrganizationAuthorityApplication } from '../application/organization-authority.js';
import { createOrganizationAuthorityHttpServer } from '../presentation/http-server.js';
import { InMemoryAdminConsoleSessionStore } from '../presentation/admin-console/sessions.js';
import { AuthenticatedProxyClientIdentityResolver } from '../presentation/trusted-proxy-client-identity.js';
import { acquireAuthorityRuntimeLock } from '../adapters/runtime/singleton-runtime-lock.js';
import { authorityRuntimeFingerprint } from '../adapters/runtime/runtime-fingerprint.js';
import { createAuthorityRuntimeStatus } from '../adapters/runtime/runtime-status-proof.js';
import {
  assertIndependentAuthorityTokens,
  assertAuthorityServeStateBoundary,
  assertPersistentAuthorityDatabasePath,
  type AuthorityServeConfig,
} from './config.js';

export interface RunningOrganizationAuthority {
  address: AddressInfo;
  close(): Promise<void>;
}

const GRACEFUL_SHUTDOWN_DEADLINE_MS = 10_000;
const ADMIN_CONSOLE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAXIMUM_ADMIN_CONSOLE_SESSIONS = 256;

type OrganizationAuthorityHttpServer = ReturnType<
  typeof createOrganizationAuthorityHttpServer
>;

async function closeAuthorityServer(
  server: OrganizationAuthorityHttpServer,
): Promise<void> {
  if (!server.listening) return;
  const closeEvent = once(server, 'close');
  const deadline = setTimeout(() => {
    server.closeAllConnections();
  }, GRACEFUL_SHUTDOWN_DEADLINE_MS);
  deadline.unref?.();
  try {
    server.close();
    await closeEvent;
  } finally {
    clearTimeout(deadline);
  }
}

function abandonUncertainServer(
  server: OrganizationAuthorityHttpServer,
  failures: unknown[],
): void {
  try {
    server.closeAllConnections();
  } catch (error) {
    failures.push(error);
  }
  try {
    server.unref();
  } catch (error) {
    failures.push(error);
  }
}

function throwCleanupFailures(failures: unknown[], message: string): never {
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
}

export async function startOrganizationAuthority(
  config: AuthorityServeConfig,
): Promise<RunningOrganizationAuthority> {
  assertPersistentAuthorityDatabasePath(config.database_path);
  assertAuthorityServeStateBoundary(config);
  assertIndependentAuthorityTokens(
    config.admin_token,
    config.trusted_proxy_token,
  );
  const adminAuthenticator = new AdminBearerAuthenticator(config.admin_token);
  const clientIdentityResolver = new AuthenticatedProxyClientIdentityResolver(
    config.trusted_proxy_token,
  );
  const runtimeFingerprint = authorityRuntimeFingerprint(config);
  const runtimeLock = await acquireAuthorityRuntimeLock(
    config.state_directory,
    runtimeFingerprint,
  );
  let repository: SqliteOrganizationAuthorityRepository | undefined;
  let application: OrganizationAuthorityApplication | undefined;
  let server: OrganizationAuthorityHttpServer | undefined;
  try {
    const signer = DevelopmentFileOrganizationAuthoritySigner.openExisting({
      directory: config.key_directory,
      authority_id: config.authority_id,
      organization_id: config.organization_id,
    });
    repository = new SqliteOrganizationAuthorityRepository(
      config.database_path,
      { fileMustExist: true, allowInitialization: false },
    );
    application = await OrganizationAuthorityApplication.create({
      repository,
      signer,
      clock: new SystemAuthorityClock(),
      identifiers: new RandomAuthorityIdentifierGenerator(),
      independently_trusted_authority_pin: config.authority_pin_sha256,
      organization_display_name: config.organization_display_name,
      active_lease_ttl_ms: config.active_lease_ttl_ms,
      access_request_maximum_age_ms: config.access_request_maximum_age_ms,
    });
    repository = undefined;
    if (authorityRuntimeFingerprint(config) !== runtimeFingerprint) {
      throw new Error(
        'organization authority files changed while composing the runtime',
      );
    }
    server = createOrganizationAuthorityHttpServer({
      application,
      adminAuthenticator,
      clientIdentityResolver,
      adminConsole: {
        sessions: new InMemoryAdminConsoleSessionStore({
          session_ttl_ms: ADMIN_CONSOLE_SESSION_TTL_MS,
          maximum_sessions: MAXIMUM_ADMIN_CONSOLE_SESSIONS,
        }),
      },
      runtimeStatus: {
        respond: (nonce) =>
          createAuthorityRuntimeStatus({
            secret: runtimeLock.challenge_secret,
            authority_id: config.authority_id,
            organization_id: config.organization_id,
            runtime_fingerprint_sha256: runtimeFingerprint,
            nonce,
          }),
      },
    });
    server.listen(config.port, config.host);
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('organization authority did not bind a TCP address');
    }
    const runningApplication = application;
    const runningServer = server;
    let closePromise: Promise<void> | undefined;
    return {
      address,
      async close(): Promise<void> {
        closePromise ??= (async (): Promise<void> => {
          const failures: unknown[] = [];
          let serverCleanupFailed = false;
          try {
            await closeAuthorityServer(runningServer);
          } catch (error) {
            serverCleanupFailed = true;
            failures.push(error);
          }
          try {
            runningApplication.close();
          } catch (error) {
            failures.push(error);
          }
          // Keep ownership until both the listener and SQLite application are
          // confirmed closed. On uncertain cleanup, unref live resources so a
          // terminal process may exit, but retain kernel exclusion until the
          // operating system actually releases this process's handles.
          if (failures.length > 0) {
            if (serverCleanupFailed) {
              abandonUncertainServer(runningServer, failures);
            }
            try {
              await runtimeLock.abandon();
            } catch (error) {
              failures.push(error);
            }
            throwCleanupFailures(
              failures,
              'organization authority shutdown failed',
            );
          }
          await runtimeLock.release();
        })();
        await closePromise;
      },
    };
  } catch (error) {
    const failures: unknown[] = [error];
    let cleanupFailed = false;
    let serverCleanupFailed = false;
    if (server !== undefined) {
      try {
        await closeAuthorityServer(server);
      } catch (cleanupError) {
        cleanupFailed = true;
        serverCleanupFailed = true;
        failures.push(cleanupError);
      }
    }
    try {
      if (application !== undefined) application.close();
      else repository?.close();
    } catch (cleanupError) {
      cleanupFailed = true;
      failures.push(cleanupError);
    }
    if (serverCleanupFailed && server !== undefined) {
      abandonUncertainServer(server, failures);
    }
    try {
      if (cleanupFailed) await runtimeLock.abandon();
      else await runtimeLock.release();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    throwCleanupFailures(
      failures,
      'organization authority startup and ownership cleanup failed',
    );
  }
}
