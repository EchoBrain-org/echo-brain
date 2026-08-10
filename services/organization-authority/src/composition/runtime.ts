import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  FileOrganizationSecretStore,
  inspectOpenOrganizationControlDatabase,
  openOrganizationControlDatabase,
  OrganizationIntegrationsRepository,
  SlackWebIntegrationProvider,
} from '@echo-brain/organization-control-plane';
import { AdminBearerAuthenticator } from '../adapters/security/admin-bearer-authenticator.js';
import { DevelopmentFileOrganizationAuthoritySigner } from '../adapters/security/development-file-authority-signer.js';
import {
  RandomAuthorityIdentifierGenerator,
  SystemAuthorityClock,
} from '../adapters/runtime/system-runtime-ports.js';
import { SqliteOrganizationAuthorityRepository } from '../adapters/persistence/sqlite/sqlite-authority-repository.js';
import { OrganizationAuthorityApplication } from '../application/organization-authority.js';
import {
  beginOrganizationAuthorityHttpServerShutdown,
  createOrganizationAuthorityHttpServer,
  drainOrganizationAuthorityHttpServer,
} from '../presentation/http-server.js';
import { InMemoryAdminConsoleSessionStore } from '../presentation/admin-console/sessions.js';
import { AuthenticatedProxyClientIdentityResolver } from '../presentation/trusted-proxy-client-identity.js';
import { acquireAuthorityRuntimeLock } from '../adapters/runtime/singleton-runtime-lock.js';
import { authorityRuntimeFingerprint } from '../adapters/runtime/runtime-fingerprint.js';
import { createAuthorityRuntimeStatus } from '../adapters/runtime/runtime-status-proof.js';
import {
  ComposedOrganizationIntegrationsApplication,
  reconcileOrganizationIntegrationSecrets,
} from './organization-integrations.js';
import {
  openOrganizationRecordRuntime,
  type OrganizationRecordRuntime,
} from './organization-record.js';
import {
  assertIndependentAuthorityTokens,
  assertAuthorityServeStateBoundary,
  assertPersistentAuthorityDatabasePath,
  type AuthorityServeConfig,
} from './config.js';
import { assertAuthorityRuntimeStateBinding } from './operator-state.js';
import { composeOrganizationRecentDecisions } from './recent-decisions.js';

export interface RunningOrganizationAuthority {
  address: AddressInfo;
  close(): Promise<void>;
  /**
   * Resolves when a post-start organization-record derive failure has taken the
   * process down: the listener is closed, ingest refuses, and the exit code is
   * set. Present so an embedding host (a test, a supervisor shim) can await the
   * same event a standalone process observes as a non-zero exit.
   */
  readonly fatalFailure: Promise<Error>;
}

const RECORD_DERIVE_FATAL_EXIT_CODE = 1;

const GRACEFUL_SHUTDOWN_DEADLINE_MS = 30_000;
const ADMIN_CONSOLE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAXIMUM_ADMIN_CONSOLE_SESSIONS = 256;

type OrganizationAuthorityHttpServer = ReturnType<
  typeof createOrganizationAuthorityHttpServer
>;

export async function closeAuthorityServer(
  server: OrganizationAuthorityHttpServer,
  gracefulShutdownDeadlineMs = GRACEFUL_SHUTDOWN_DEADLINE_MS,
): Promise<void> {
  beginOrganizationAuthorityHttpServerShutdown(server);
  const drained = drainOrganizationAuthorityHttpServer(server);
  if (!server.listening) {
    await drained;
    return;
  }
  const closeEvent = once(server, 'close');
  let deadline: NodeJS.Timeout | undefined;
  const forcedCloseFailure = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => {
      const deadlineFailure = new Error(
        'organization authority graceful shutdown deadline exceeded',
      );
      try {
        server.closeAllConnections();
      } catch (error) {
        reject(
          new AggregateError(
            [deadlineFailure, error],
            'organization authority forced listener shutdown failed',
          ),
        );
        return;
      }
      reject(deadlineFailure);
    }, gracefulShutdownDeadlineMs);
  });
  deadline?.unref();
  try {
    server.close();
    await Promise.race([
      Promise.all([closeEvent, drained]).then(() => undefined),
      forcedCloseFailure,
    ]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

function abandonUncertainServer(
  server: OrganizationAuthorityHttpServer,
  failures: unknown[],
): void {
  try {
    beginOrganizationAuthorityHttpServerShutdown(server);
  } catch (error) {
    failures.push(error);
  }
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
  let integrationsDatabase:
    | ReturnType<typeof openOrganizationControlDatabase>
    | undefined;
  let application: OrganizationAuthorityApplication | undefined;
  let records: OrganizationRecordRuntime | undefined;
  let server: OrganizationAuthorityHttpServer | undefined;
  let signalFatalFailure: (failure: Error) => void = () => undefined;
  // Resolve-only: a promise that never rejects cannot become an unhandled
  // rejection on the ordinary path where nobody awaits it.
  const fatalFailure = new Promise<Error>((resolve) => {
    signalFatalFailure = resolve;
  });
  let shutdownPromise: Promise<void> | undefined;
  /**
   * The one stop, shared by the operator's `close()` and by a post-start derive
   * halt. It is memoized because those two race: a second teardown would close
   * a SQLite handle twice and settle singleton ownership twice.
   */
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async (): Promise<void> => {
      const runningServer = server;
      const runningRecords = records;
      const runningApplication = application;
      const runningIntegrationsDatabase = integrationsDatabase;
      const failures: unknown[] = [];
      if (runningServer !== undefined) {
        try {
          await closeAuthorityServer(runningServer);
        } catch (error) {
          failures.push(error);
          abandonUncertainServer(runningServer, failures);
          try {
            await runtimeLock.abandon();
          } catch (abandonError) {
            failures.push(abandonError);
          }
          // A failed listener drain means a handler may still hold either
          // database. Leave both handles open and retain kernel exclusion
          // until this process exits instead of creating a use-after-close
          // race inside the Authority.
          throwCleanupFailures(
            failures,
            'organization authority shutdown failed',
          );
        }
      }
      // Records first, and awaited: its close drains derive, verifies the
      // chain, and only then releases both handles. Draining can still need
      // the authority (an unmaterialized receipt) and the integration audit, so
      // closing either of those first would race a stop that is supposed to
      // leave a backup-safe state behind.
      let ownershipUncertain = false;
      if (runningRecords !== undefined) {
        try {
          await runningRecords.close();
        } catch (error) {
          failures.push(error);
          // A stop that reports only the derive halt it already signalled has
          // still closed both record handles: the stop fails, because that
          // stopped state is not backup-safe, but nothing is left uncertain.
          // Retaining ownership here would strand the state directory in the
          // one case the halt exists to escape — the supervisor's replacement.
          if (error !== runningRecords.fatalFailure) ownershipUncertain = true;
        }
      }
      try {
        runningApplication?.close();
      } catch (error) {
        failures.push(error);
        ownershipUncertain = true;
      }
      try {
        runningIntegrationsDatabase?.close();
      } catch (error) {
        failures.push(error);
        ownershipUncertain = true;
      }
      // Keep ownership until the listener and both SQLite handles are
      // confirmed closed. On uncertain cleanup, unref live resources so a
      // terminal process may exit, but retain kernel exclusion until the
      // operating system actually releases this process's handles.
      if (failures.length > 0) {
        try {
          if (ownershipUncertain) await runtimeLock.abandon();
          else await runtimeLock.release();
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
    return shutdownPromise;
  };
  try {
    assertAuthorityRuntimeStateBinding(config);
    const signer = DevelopmentFileOrganizationAuthoritySigner.openExisting({
      directory: config.key_directory,
      authority_id: config.authority_id,
      organization_id: config.organization_id,
    });
    repository = new SqliteOrganizationAuthorityRepository(
      config.database_path,
      { fileMustExist: true, allowInitialization: false },
    );
    integrationsDatabase = openOrganizationControlDatabase(
      config.integrations_database_path,
      { fileMustExist: true },
    );
    const integrationsIdentity = inspectOpenOrganizationControlDatabase(
      integrationsDatabase,
    );
    if (
      integrationsIdentity.organization_id !== config.organization_id ||
      integrationsIdentity.authority_id !== config.authority_id ||
      integrationsIdentity.authority_descriptor_sha256 !==
        config.authority_pin_sha256
    ) {
      throw new Error(
        'organization integrations database identity differs from config',
      );
    }
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
    const integrationsRepository = new OrganizationIntegrationsRepository(
      integrationsDatabase,
      {
        organization_id: config.organization_id,
        authority_id: config.authority_id,
      },
    );
    const integrationSecrets = new FileOrganizationSecretStore(
      join(config.state_directory, 'credentials', 'integrations'),
    );
    reconcileOrganizationIntegrationSecrets(
      integrationsRepository,
      integrationSecrets,
    );
    // Opens both record databases, verifies the append chain, and runs the
    // startup derive catch-up. A halted initial derivation throws here, which
    // is what makes it process-fatal: the supervisor restart re-runs the same
    // catch-up instead of leaving a healthy-looking but stale process.
    records = await openOrganizationRecordRuntime({
      authority: application,
      evidence: integrationsRepository,
      organization_id: config.organization_id,
      authority_id: config.authority_id,
      record_log_database_path: config.record_log_database_path,
      record_derived_database_path: config.record_derived_database_path,
      // A halt after start gets the same treatment as one during it. The
      // record runtime already refuses further ingest; the process concerns
      // are here, because a listener still answering and a zero exit code are
      // exactly what would let a supervisor believe this host is healthy.
      onFatal: (failure) => {
        process.exitCode = RECORD_DERIVE_FATAL_EXIT_CODE;
        // The whole host stops, not just the listener. Closing the listener
        // alone left both databases open and the ownership guard listening, so
        // the process never exited and the state directory stayed taken — the
        // supervisor restart this halt exists to trigger could never start.
        void shutdown().then(
          () => signalFatalFailure(failure),
          (error: unknown) => {
            // `records.close()` reports the already-signalled halt after it has
            // closed both handles. That is the fatal event, not a second
            // lifecycle failure; the operator-facing fatal line reports it.
            // Any different failure means teardown itself was uncertain and
            // needs its own line.
            if (error !== failure) {
              process.stderr.write(
                `organization authority shutdown after derive failure did not complete cleanly: ${
                  error instanceof Error ? error.message : String(error)
                }\n`,
              );
            }
            signalFatalFailure(failure);
          },
        );
      },
    });
    const integrations = new ComposedOrganizationIntegrationsApplication({
      authority: application,
      repository: integrationsRepository,
      secrets: integrationSecrets,
      slack: new SlackWebIntegrationProvider(),
      permissionPilotHealth: records.permissionPilotHealth,
    });
    if (authorityRuntimeFingerprint(config) !== runtimeFingerprint) {
      throw new Error(
        'organization authority files changed while composing the runtime',
      );
    }
    server = createOrganizationAuthorityHttpServer({
      application,
      integrations,
      records,
      recentDecisions: composeOrganizationRecentDecisions(
        application,
        records,
      ),
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
    return { address, fatalFailure, close: shutdown };
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
    if (serverCleanupFailed && server !== undefined) {
      abandonUncertainServer(server, failures);
      try {
        await runtimeLock.abandon();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      // The listener may still have a handler executing against either
      // database. Do not close those handles or release singleton ownership.
      throwCleanupFailures(
        failures,
        'organization authority startup and ownership cleanup failed',
      );
    }
    // Same order as the ordinary stop: records first and awaited, so its drain
    // and chain verification run while everything they might read is still
    // open.
    try {
      if (records !== undefined) await records.close();
    } catch (cleanupError) {
      cleanupFailed = true;
      failures.push(cleanupError);
    }
    try {
      if (application !== undefined) application.close();
      else repository?.close();
    } catch (cleanupError) {
      cleanupFailed = true;
      failures.push(cleanupError);
    }
    try {
      integrationsDatabase?.close();
    } catch (cleanupError) {
      cleanupFailed = true;
      failures.push(cleanupError);
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
