import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  FileOrganizationSecretStore,
  CleanSlackWebIdentityProviderV1,
  type CleanSlackIdentityProviderV1,
} from "@echo-brain/organization-control-plane/clean-slack-identity-v1";
import { openOrganizationControlDatabase } from "@echo-brain/organization-control-plane/new-lineage-genesis-v1";
import {
  CleanPersonRecordReaderV1,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/new-lineage-v1";
import type { AddressInfo } from "node:net";
import { validateOrganizationAuthorityOrigin } from "@echo-brain/organization-api";
import { SqliteCleanPersonSessionRepository } from "../adapters/persistence/sqlite/clean-person-session-repository.js";
import { SqliteCleanPersonRecordReadAuditV1 } from "../adapters/persistence/sqlite/clean-person-record-read-audit-v1.js";
import { openAuthorityDatabase } from "../adapters/persistence/sqlite/open-unmigrated-database.js";
import { NodePersonSessionCrypto } from "../adapters/security/node-person-session-crypto.js";
import { OpenIdClientPersonSessionProvider } from "../adapters/oidc/openid-client-person-session-provider.js";
import { PersonIdentitySessionApplication } from "../application/person-identity-sessions.js";
import type { PersonSessionOidcConfiguration } from "../application/ports/person-session-runtime.js";
import { SystemAuthorityClock } from "../adapters/runtime/system-runtime-ports.js";
import { createCleanPersonHttpServer } from "../presentation/clean-person-http-server.js";
import { ReadableSearchAuthorizationFence } from "../application/readable-search-authorization-fence.js";
import type { PersonSessionOidcAuthorizationProvider } from "./lazy-person-session-oidc-provider.js";
import { LazyPersonSessionOidcProvider } from "./lazy-person-session-oidc-provider.js";
import { createCleanPersonSlackIdentityLinkServiceV1 } from "./clean-person-slack-identity-link.js";
import { createCleanPersonRecordReadRouteV1 } from "./clean-person-record-read-route.js";
import { createCleanPersonRecordSearchRouteV1 } from "./clean-person-record-search-route.js";
import { CleanPersonEmployeeLifecycleApplication } from "../application/clean-person-employee-lifecycle.js";
import { createCleanPersonEmployeeHttpApplication } from "../presentation/clean-person-employee-http-application.js";
import { cleanReadableSearchRuntimeContractV1 } from "./clean-readable-search-runtime.js";
import { verifyCleanStateLineage } from "./verify-clean-state-lineage.js";

export interface CleanPersonRuntimeConfig {
  readonly state_directory: string;
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  /** Public Authority origin used to bind the registered OIDC callback. */
  readonly authority_url: string;
  readonly oidc: PersonSessionOidcConfiguration;
  readonly client_authentication:
    | { readonly method: "none" }
    | {
        readonly method: "client_secret_basic" | "client_secret_post";
        readonly client_secret: string;
      };
  readonly pkce_sealing_key: Uint8Array;
  /**
   * Omit until the stopped-state clean Slack connect has completed. Person
   * login remains runnable without an installed Slack connection.
   */
  readonly slack_link?: {
    readonly approval_channel_id: string;
  };
}

export interface CleanPersonRuntimeDependencies {
  readonly oidc_provider?: PersonSessionOidcAuthorizationProvider;
  readonly slack_provider?: CleanSlackIdentityProviderV1;
}

export interface RunningCleanPersonRuntime {
  readonly address: AddressInfo;
  close(): Promise<void>;
}

export function verifyCleanPersonLineage(stateDirectory: string) {
  return verifyCleanStateLineage(stateDirectory);
}

/**
 * Starts only the clean founder Person flow. It verifies every role read-only
 * before opening Authority writeable and never imports legacy serve/migrations.
 */
export async function startCleanPersonRuntime(
  config: CleanPersonRuntimeConfig,
  dependencies: CleanPersonRuntimeDependencies = {},
): Promise<RunningCleanPersonRuntime> {
  if (
    !Number.isSafeInteger(config.port) ||
    config.port < 1 ||
    config.port > 65_535
  ) {
    throw new Error("clean Person runtime port is invalid");
  }
  validateOrganizationAuthorityOrigin(config.authority_url);
  if (
    config.oidc.redirect_uri !==
    `${config.authority_url}/v2/session/oidc/callback`
  ) {
    throw new Error(
      "clean Person OIDC redirect URI must match the public Authority callback",
    );
  }
  const lineage = verifyCleanPersonLineage(config.state_directory);
  // Do not contact an OIDC provider merely to bind the clean local runtime.
  // Discovery is deferred until the founder begins an OIDC login.
  const provider =
    dependencies.oidc_provider ??
    new LazyPersonSessionOidcProvider(() =>
      OpenIdClientPersonSessionProvider.discover({
        configuration: config.oidc,
        client_authentication: config.client_authentication,
      }),
    );
  const database = openAuthorityDatabase(
    join(config.state_directory, "authority.sqlite"),
    { fileMustExist: true },
  );
  let controlDatabase:
    ReturnType<typeof openOrganizationControlDatabase> | undefined;
  let recordDatabase:
    ReturnType<typeof openOrganizationRecordDatabase> | undefined;
  try {
    recordDatabase = openOrganizationRecordDatabase(
      join(config.state_directory, "record-log.sqlite"),
      { fileMustExist: true },
    );
    controlDatabase =
      config.slack_link === undefined
        ? undefined
        : openOrganizationControlDatabase(
            join(config.state_directory, "integrations.sqlite"),
            { fileMustExist: true },
          );
    const repository = new SqliteCleanPersonSessionRepository(database);
    const metadata = repository.read((transaction) => transaction.metadata());
    if (
      metadata.authority_id !== lineage.root.authority_id ||
      metadata.organization_id !== lineage.root.organization_id
    ) {
      throw new Error(
        "clean Person runtime Authority metadata differs from verified lineage",
      );
    }
    const crypto = new NodePersonSessionCrypto(config.pkce_sealing_key);
    const sessions = new PersonIdentitySessionApplication(
      repository,
      config.oidc,
      {
        clock: new SystemAuthorityClock(),
        random: crypto,
        hash: crypto,
        pkce_sealer: crypto,
        oidc_provider: provider,
      },
    );
    sessions.expireOidcLoginAttempts({ limit: 1000 });
    const personSlackIdentityLink =
      config.slack_link === undefined || controlDatabase === undefined
        ? undefined
        : createCleanPersonSlackIdentityLinkServiceV1({
            database: controlDatabase,
            authority_id: metadata.authority_id,
            organization_id: metadata.organization_id,
            state_lineage_id: lineage.root.state_lineage_id,
            approval_channel_id: config.slack_link.approval_channel_id,
            authentication: {
              authenticateAccess: (input) => sessions.authenticateAccess(input),
            },
            membership_type: (input) => {
              const membership = repository.read((transaction) =>
                transaction.membership(input.membership_id),
              );
              if (
                membership === undefined ||
                membership.principal_id !== input.principal_id ||
                membership.status !== "active"
              ) {
                throw new Error("active Person membership is unavailable");
              }
              return membership.membership_type;
            },
            slack:
              dependencies.slack_provider ??
              new CleanSlackWebIdentityProviderV1(),
            slack_token_access: {
              readActiveSlackBotToken: ({ state }) => {
                const secrets = new FileOrganizationSecretStore(
                  join(config.state_directory, "secrets"),
                );
                const matches = secrets
                  .listReferences()
                  .filter(
                    (reference) =>
                      canonicalSha256(reference) ===
                      state.credential_reference_sha256,
                  );
                if (matches.length !== 1)
                  throw new Error(
                    "active clean Slack credential is unavailable",
                  );
                return secrets.read(matches[0]!);
              },
            },
            authorization_fence: new ReadableSearchAuthorizationFence(),
          });
    const server = createCleanPersonHttpServer({
      descriptor: metadata.descriptor,
      sessions,
      oidc_provider: provider,
      expected_issuer: config.oidc.issuer,
      person_record_read: createCleanPersonRecordReadRouteV1({
        authority_id: metadata.authority_id,
        organization_id: metadata.organization_id,
        state_lineage_id: lineage.root.state_lineage_id,
        sessions,
        records: new CleanPersonRecordReaderV1(recordDatabase),
        audit: new SqliteCleanPersonRecordReadAuditV1(database),
      }),
      person_record_search: createCleanPersonRecordSearchRouteV1({
        state_directory: config.state_directory,
        authority_id: metadata.authority_id,
        organization_id: metadata.organization_id,
        state_lineage_id: lineage.root.state_lineage_id,
        retrieval_contract_sha256:
          cleanReadableSearchRuntimeContractV1().retrieval_contract_sha256,
        sessions,
        authority: database,
        record: recordDatabase,
        audit: new SqliteCleanPersonRecordReadAuditV1(database),
      }),
      person_employees: createCleanPersonEmployeeHttpApplication(
        new CleanPersonEmployeeLifecycleApplication(sessions, {
          next(prefix) {
            return `${prefix}_${randomUUID()}`;
          },
        }),
      ),
      ...(personSlackIdentityLink === undefined
        ? {}
        : { person_slack_identity_link: personSlackIdentityLink }),
    });
    server.listen(config.port, config.host);
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("clean Person runtime did not bind TCP");
    return {
      address,
      close: async () => {
        if (server.listening) {
          const closed = once(server, "close");
          server.close();
          await closed;
        }
        controlDatabase?.close();
        recordDatabase?.close();
        database.close();
      },
    };
  } catch (error) {
    controlDatabase?.close();
    recordDatabase?.close();
    database.close();
    throw error;
  }
}
