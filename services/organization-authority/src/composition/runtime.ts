import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { canonicalJson } from '@echo-brain/federation-protocol';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import {
  createReadableSearchAnalyzerDescriptor,
  readableSearchRetrievalContractSha256,
  readableSearchSourceBytesSha256,
} from '@echo-brain/organization-retrieval';
import { organizationMemberReadablePolicyContractSha256 } from '@echo-brain/organization-protocol';
import {
  FileOrganizationSecretStore,
  inspectOpenOrganizationControlDatabase,
  openOrganizationControlDatabase,
  OrganizationIntegrationsRepository,
  SlackWebIntegrationProvider,
} from '@echo-brain/organization-control-plane';
import { AdminBearerAuthenticator } from '../adapters/security/admin-bearer-authenticator.js';
import { DevelopmentFileOrganizationAuthoritySigner } from '../adapters/security/development-file-authority-signer.js';
import { NodePersonSessionCrypto } from '../adapters/security/node-person-session-crypto.js';
import { OpenIdClientPersonSessionProvider } from '../adapters/oidc/openid-client-person-session-provider.js';
import {
  RandomAuthorityIdentifierGenerator,
  SystemAuthorityClock,
} from '../adapters/runtime/system-runtime-ports.js';
import { SqliteOrganizationAuthorityRepository } from '../adapters/persistence/sqlite/sqlite-authority-repository.js';
import { SqlitePersonMemberExclusionMutationPort } from '../adapters/persistence/sqlite/sqlite-person-member-exclusion-mutation-port.js';
import { readOrganizationMemberRecordingActivation } from '../adapters/persistence/sqlite/organization-recording-policy-activation.js';
import { OrganizationAuthorityApplication } from '../application/organization-authority.js';
import { PersonIdentitySessionApplication } from '../application/person-identity-sessions.js';
import { PersonReadableSearchService } from '../application/person-readable-search.js';
import { PersonMemberExclusionService } from '../application/person-member-exclusions.js';
import { PersonMemberExclusionReadService } from '../application/person-member-exclusion-reads.js';
import { createPersonReadRecentDecisionsApplication } from '../application/person-read-recent-decisions.js';
import { AuthorityOperationError } from '../domain/errors.js';
import { reviewerPolicyContractSha256 } from '../application/reviewer-policy-contract.js';
import { ReadableSearchAuthorizationFence } from '../application/readable-search-authorization-fence.js';
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
import {
  assertAuthorityRuntimeStateBinding,
  readableSearchReleaseDescriptor,
} from './operator-state.js';
import {
  composeOrganizationRecentDecisions,
  loadOrganizationRecentDecisionsProjectedRecords,
  organizationRecentDecisionsPilotActivation,
} from './recent-decisions.js';
import {
  composeReviewerRecentDecisions,
  loadReviewerRecentDecisionsSource,
} from './reviewer-recent-decisions.js';
import {
  fenceAuthorizationRelevantAuthorityMutations,
  fenceAuthorizationRelevantPersonSessionMutations,
} from './readable-search-authorization-writes.js';
import {
  createReadableSearchRetrievalPort,
  createReadableSearchRuntimeAdapter,
} from './readable-search.js';
import {
  LazyPersonSessionOidcProvider,
  type PersonSessionOidcAuthorizationProvider,
} from './lazy-person-session-oidc-provider.js';
import { PersonSlackIdentityLinkService } from './person-slack-identity-link.js';
import {
  openAuthorityMeetingProcessingRuntime,
  type AuthorityMeetingProcessingRuntime,
} from './meeting-processing-runtime.js';

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
  /** The singleton shared fence for in-process authorization-relevant writers. */
  readonly authorizationFence: ReadableSearchAuthorizationFence;
}

const RECORD_DERIVE_FATAL_EXIT_CODE = 1;

const GRACEFUL_SHUTDOWN_DEADLINE_MS = 30_000;
/** Bounds only the final shared-fence wait; SQLite keeps its own 5s busy bound. */
const READABLE_SEARCH_FENCE_TIMEOUT_MS = 5_000;
const ADMIN_CONSOLE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAXIMUM_ADMIN_CONSOLE_SESSIONS = 256;
const PERSON_SESSION_OIDC_EXPIRY_BATCH_LIMIT = 1000;

export interface OrganizationAuthorityRuntimeDependencies {
  discoverPersonSessionOidcProvider?: (
    options: Parameters<typeof OpenIdClientPersonSessionProvider.discover>[0],
  ) => Promise<PersonSessionOidcAuthorizationProvider>;
  openMeetingProcessingRuntime?: typeof openAuthorityMeetingProcessingRuntime;
}

function assertOrganizationMemberRecordingRuntimeBinding(
  config: AuthorityServeConfig,
): void {
  const stored = readOrganizationMemberRecordingActivation(
    config.database_path,
  );
  const expected = config.organization_member_recording_activation_v1;
  if (stored === null) {
    if (expected !== undefined) {
      throw new Error(
        'organization-member recording activation disappeared before runtime composition',
      );
    }
    return;
  }
  if (expected === undefined) {
    throw new Error(
      'organization-member recording activation changed before runtime composition',
    );
  }
  const actual = {
    schema_version: 1,
    kind: 'organization-member-recording-activation-binding-v1',
    command_sha256: stored.command_sha256,
    activation_sha256: stored.activation_sha256,
    initialized_runtime_config_sha256:
      stored.command.initialized_runtime_config_sha256,
    initialization_manifest_sha256:
      stored.command.initialization_manifest_sha256,
    activated_at: stored.activated_at,
    audit_sequence: stored.audit_sequence,
  } as const;
  if (
    canonicalJson(actual) !== canonicalJson(expected) ||
    canonicalJson(stored.command.target_policy) !==
      canonicalJson(config.organization_recording_policy_v1)
  ) {
    throw new Error(
      'organization-member recording activation differs from effective runtime policy',
    );
  }
}

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
  dependencies: OrganizationAuthorityRuntimeDependencies = {},
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
  const authorizationFence = new ReadableSearchAuthorizationFence();
  let records: OrganizationRecordRuntime | undefined;
  let meetingProcessing: AuthorityMeetingProcessingRuntime | null | undefined;
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
      const runningMeetingProcessing = meetingProcessing;
      const runningRecords = records;
      const runningApplication = application;
      const runningIntegrationsDatabase = integrationsDatabase;
      const failures: unknown[] = [];
      if (runningServer !== undefined) {
        try {
          await closeAuthorityServer(runningServer);
        } catch (error) {
          failures.push(error);
          if (runningMeetingProcessing !== undefined && runningMeetingProcessing !== null) {
            try {
              await runningMeetingProcessing.close();
            } catch (processingError) {
              failures.push(processingError);
            }
          }
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
      // Stop polling before either database it depends on is drained or closed.
      let ownershipUncertain = false;
      if (runningMeetingProcessing !== undefined && runningMeetingProcessing !== null) {
        try {
          await runningMeetingProcessing.close();
        } catch (error) {
          failures.push(error);
          ownershipUncertain = true;
        }
      }
      // Records first, and awaited: its close drains derive, verifies the
      // chain, and only then releases both handles. Draining can still need
      // the authority (an unmaterialized receipt) and the integration audit, so
      // closing either of those first would race a stop that is supposed to
      // leave a backup-safe state behind.
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
    // Repository opening applies migrations while the singleton runtime lock
    // is held. Re-read the activation only after that point so a stopped
    // activation that won the startup race is detected rather than served
    // under the caller's stale policy snapshot.
    assertOrganizationMemberRecordingRuntimeBinding(config);
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
    const personSessionConfig = config.person_session_runtime_v1;
    const personOidcProvider =
      personSessionConfig === undefined
        ? undefined
        : new LazyPersonSessionOidcProvider(() =>
            (dependencies.discoverPersonSessionOidcProvider ??
              OpenIdClientPersonSessionProvider.discover)({
              configuration: personSessionConfig.oidc_configuration,
              client_authentication:
                personSessionConfig.client_authentication,
            }),
          );
    let personIdentitySessions: PersonIdentitySessionApplication | undefined;
    if (personSessionConfig !== undefined && personOidcProvider !== undefined) {
      const crypto = new NodePersonSessionCrypto(
        personSessionConfig.pkce_sealing_key,
      );
      personIdentitySessions = new PersonIdentitySessionApplication(
        repository,
        personSessionConfig.oidc_configuration,
        {
          clock: new SystemAuthorityClock(),
          random: crypto,
          hash: crypto,
          pkce_sealer: crypto,
          oidc_provider: personOidcProvider,
          diagnostics: {
            oidcLoginDenied(reason) {
              process.stderr.write(
                `authority_person_session_oidc_denied reason=${reason}\n`,
              );
            },
          },
        },
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
    personIdentitySessions?.expireOidcLoginAttempts({
      limit: PERSON_SESSION_OIDC_EXPIRY_BATCH_LIMIT,
    });
    const authorityRepository = repository;
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
      ...(config.organization_recording_policy_v1 === undefined
        ? {}
        : {
            organization_recording_policy_v1:
              config.organization_recording_policy_v1,
          }),
      authorization_fence: authorizationFence,
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
    const recordRuntime = records;
    const slackIntegrationProvider = new SlackWebIntegrationProvider();
    const integrations = new ComposedOrganizationIntegrationsApplication({
      authority: application,
      repository: integrationsRepository,
      secrets: integrationSecrets,
      slack: slackIntegrationProvider,
      permissionPilotHealth: recordRuntime.permissionPilotHealth,
      organizationRecordingPolicy: config.organization_recording_policy_v1,
      authorizationFence,
    });
    const memberPolicy = organizationMemberReadablePolicyContractSha256();
    const reviewerPolicy = reviewerPolicyContractSha256();
    const analyzer = createReadableSearchAnalyzerDescriptor({
      analyzer_source_sha256: readableSearchSourceBytesSha256(
        readableSearchReleaseDescriptor(),
      ),
      node_version: process.versions.node,
      unicode_version: process.versions.unicode ?? 'unknown',
      icu_version: process.versions.icu ?? 'unknown',
    });
    const readableSearchOptions = {
      authority: application,
      records: recordRuntime,
      generation_directories: {
        directoryFor: (generationId: Sha256Digest) =>
          join(config.state_directory, 'record-retrieval', 'generations', generationId),
      },
      retrieval_state_directory: config.state_directory,
      analyzer,
      contract: {
        retrieval_contract_sha256: readableSearchRetrievalContractSha256({
          analyzer_contract_sha256: analyzer.analyzer_contract_sha256,
          organization_member_policy_contract_sha256: memberPolicy,
          restricted_reviewer_policy_contract_sha256: reviewerPolicy,
        }),
        policy_contracts: [
          {
            policy_id: 'organization-member-readable-v1',
            policy_contract_sha256: memberPolicy,
          },
          {
            policy_id: 'restricted-reviewer-v1',
            policy_contract_sha256: reviewerPolicy,
          },
        ],
      },
      fence: authorizationFence,
      fence_timeout_ms: READABLE_SEARCH_FENCE_TIMEOUT_MS,
    } as const;
    const readableSearchRetrieval = createReadableSearchRetrievalPort(
      readableSearchOptions,
    );
    const readableSearch = createReadableSearchRuntimeAdapter(
      readableSearchOptions,
      readableSearchRetrieval,
    );
    const personAuthorization =
      personIdentitySessions?.createPersonReadAuthorizationPort();
    const personRecentDecisions =
      personAuthorization !== undefined
        ? createPersonReadRecentDecisionsApplication({
            descriptor: application.descriptor(),
            authorization: personAuthorization,
            ...(recordRuntime.permissionPilotHealth.kind === 'ready'
              ? {
                  recent_decisions: {
                    activation: organizationRecentDecisionsPilotActivation(
                      recordRuntime.permissionPilotHealth.activation,
                    ),
                    source: {
                      load: () =>
                        loadOrganizationRecentDecisionsProjectedRecords(
                          recordRuntime,
                        ),
                    },
                  },
                }
              : {}),
            reviewer_recent_decisions: {
              load: (input) =>
                loadReviewerRecentDecisionsSource(
                  recordRuntime,
                  integrationsRepository,
                  input,
                ),
            },
          })
        : undefined;
    const personReadableSearch =
      personAuthorization === undefined
        ? undefined
        : new PersonReadableSearchService({
            authority_id: config.authority_id,
            organization_id: config.organization_id,
            authorization: personAuthorization,
            retrieval: readableSearchRetrieval,
            fence: authorizationFence,
            contract: readableSearchOptions.contract,
            fence_timeout_ms: READABLE_SEARCH_FENCE_TIMEOUT_MS,
          });
    const personMemberExclusions =
      personIdentitySessions === undefined
        ? undefined
        : new PersonMemberExclusionService({
            authority_id: config.authority_id,
            organization_id: config.organization_id,
            authentication: personIdentitySessions,
            mutations: new SqlitePersonMemberExclusionMutationPort(
              config.database_path,
            ),
            authorization_fence: authorizationFence,
          });
    const personMemberExclusionReads =
      personAuthorization === undefined
        ? undefined
        : new PersonMemberExclusionReadService({
            authority_id: config.authority_id,
            organization_id: config.organization_id,
            authorization: personAuthorization,
            repository: authorityRepository,
            authorization_fence: authorizationFence,
            fence_timeout_ms: READABLE_SEARCH_FENCE_TIMEOUT_MS,
            now: () => new Date().toISOString(),
          });
    const personSlackIdentityLink =
      personIdentitySessions === undefined
        ? undefined
        : new PersonSlackIdentityLinkService({
            authority_id: config.authority_id,
            organization_id: config.organization_id,
            authentication: personIdentitySessions,
            repository: integrationsRepository,
            secrets: integrationSecrets,
            slack: slackIntegrationProvider,
            authorization_fence: authorizationFence,
          });
    const personSessions =
      personIdentitySessions === undefined ||
      personOidcProvider === undefined ||
      personSessionConfig === undefined
        ? undefined
        : fenceAuthorizationRelevantPersonSessionMutations(Object.freeze({
            expected_issuer: personSessionConfig.oidc_configuration.issuer,
            issueBootstrapLoginGrant: (input: {
              target_membership_id: string;
              expected_email: string;
            }) =>
              personIdentitySessions.issueBootstrapLoginGrant({
                ...input,
                expected_issuer:
                  personSessionConfig.oidc_configuration.issuer,
              }),
            beginOidcLogin: async (input: Parameters<
              PersonIdentitySessionApplication['beginOidcLogin']
            >[0]) => {
              personIdentitySessions.expireOidcLoginAttempts({
                limit: PERSON_SESSION_OIDC_EXPIRY_BATCH_LIMIT,
              });
              let provider: PersonSessionOidcAuthorizationProvider;
              try {
                provider = await personOidcProvider.acquire();
              } catch {
                throw new AuthorityOperationError(
                  'unavailable',
                  'Person identity provider is temporarily unavailable',
                );
              }
              const begun = personIdentitySessions.beginOidcLogin(input);
              return {
                authorization_url: provider.buildAuthorizationUrl(begun),
                expires_at: begun.expires_at,
              };
            },
            completeOidcLogin: (input: Parameters<
              PersonIdentitySessionApplication['completeOidcLogin']
            >[0]) => personIdentitySessions.completeOidcLogin(input),
            refresh: (input: Parameters<
              PersonIdentitySessionApplication['refresh']
            >[0]) => personIdentitySessions.refresh(input),
            revoke: (input: Parameters<
              PersonIdentitySessionApplication['revoke']
            >[0]) => personIdentitySessions.revoke(input),
          }), authorizationFence);
    if (authorityRuntimeFingerprint(config) !== runtimeFingerprint) {
      throw new Error(
        'organization authority files changed while composing the runtime',
      );
    }
    assertOrganizationMemberRecordingRuntimeBinding(config);
    server = createOrganizationAuthorityHttpServer({
      application: fenceAuthorizationRelevantAuthorityMutations(
        application,
        authorizationFence,
      ),
      integrations,
      records: recordRuntime,
      recentDecisions: composeOrganizationRecentDecisions(
        application,
        recordRuntime,
      ),
      reviewerRecentDecisions: composeReviewerRecentDecisions(
        application,
        recordRuntime,
        integrationsRepository,
      ),
      readableSearch,
      ...(personSessions === undefined ? {} : { personSessions }),
      ...(personRecentDecisions === undefined
        ? {}
        : { personRecentDecisions }),
      ...(personReadableSearch === undefined
        ? {}
        : { personReadableSearch }),
      ...(personMemberExclusions === undefined
        ? {}
        : { personMemberExclusions }),
      ...(personMemberExclusionReads === undefined
        ? {}
        : { personMemberExclusionReads }),
      ...(personSlackIdentityLink === undefined
        ? {}
        : { personSlackIdentityLink }),
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
    meetingProcessing = await (
      dependencies.openMeetingProcessingRuntime ??
      openAuthorityMeetingProcessingRuntime
    )({
      config,
      authority: application,
      authorityRepository,
      authorizationFence,
      integrations,
      integrationsRepository,
      integrationSecrets,
      records: recordRuntime,
    });
    return {
      address,
      fatalFailure,
      authorizationFence,
      close: shutdown,
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
    if (serverCleanupFailed && server !== undefined) {
      if (meetingProcessing !== undefined && meetingProcessing !== null) {
        try {
          await meetingProcessing.close();
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
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
    // Same order as the ordinary stop: halt polling, then drain records while
    // everything record derive might read is still open.
    try {
      if (meetingProcessing !== undefined && meetingProcessing !== null) {
        await meetingProcessing.close();
      }
    } catch (cleanupError) {
      cleanupFailed = true;
      failures.push(cleanupError);
    }
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
