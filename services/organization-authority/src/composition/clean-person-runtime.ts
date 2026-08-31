import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  CleanPersonRecordReaderV1,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/new-lineage-v1";
import type { AddressInfo } from "node:net";
import { validateOrganizationAuthorityOrigin } from "@echo-brain/organization-api";
import { SqliteCleanPersonSessionRepository } from "../adapters/persistence/sqlite/clean-person-session-repository.js";
import { SqliteCleanPersonRecordReadAuditV1 } from "../adapters/persistence/sqlite/clean-person-record-read-audit-v1.js";
import { SqliteCleanPersonAnswerCompositionAuditV1 } from "../adapters/persistence/sqlite/clean-person-answer-composition-audit-v1.js";
import { openAuthorityDatabase } from "../adapters/persistence/sqlite/open-unmigrated-database.js";
import { NodePersonSessionCrypto } from "../adapters/security/node-person-session-crypto.js";
import { OpenIdClientPersonSessionProvider } from "../adapters/oidc/openid-client-person-session-provider.js";
import { PersonIdentitySessionApplication } from "../application/person-identity-sessions.js";
import type { PersonSessionOidcConfiguration } from "../application/ports/person-session-runtime.js";
import { SystemAuthorityClock } from "../adapters/runtime/system-runtime-ports.js";
import { createCleanPersonHttpServer } from "../presentation/clean-person-http-server.js";
import type { PersonSessionOidcAuthorizationProvider } from "./lazy-person-session-oidc-provider.js";
import { LazyPersonSessionOidcProvider } from "./lazy-person-session-oidc-provider.js";
import { createCleanPersonRecordReadRouteV1 } from "./clean-person-record-read-route.js";
import { createCleanPersonRecordSearchRouteV1 } from "./clean-person-record-search-route.js";
import { CleanPersonEmployeeLifecycleApplication } from "../application/clean-person-employee-lifecycle.js";
import { createCleanPersonEmployeeHttpApplication } from "../presentation/clean-person-employee-http-application.js";
import { cleanReadableSearchRuntimeContractV1 } from "./clean-readable-search-runtime.js";
import { verifyCleanStateLineage } from "./verify-clean-state-lineage.js";
import {
  createCleanPersonAnswerRouteV1,
  type CleanLayer4FailureEventV1,
} from "./clean-person-answer-route.js";
import type { CleanLayer4RuntimeV1 } from "./clean-layer4-runtime.js";
import type { PrivateApprovalInteractionHttpApplicationV1 } from "../presentation/private-approval-interaction-http-application-v1.js";
import type {
  CleanPersonExternalIdentityRuntimeBundleV1,
  OpenedCleanPersonExternalIdentityRuntimeV1,
} from "./clean-person-external-identity-runtime.js";

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
}

export interface CleanPersonRuntimeDependencies {
  readonly oidc_provider?: PersonSessionOidcAuthorizationProvider;
  /** Optional external identity provider, omitted until it is configured. */
  readonly external_identity_runtime?: CleanPersonExternalIdentityRuntimeBundleV1;
  /** Present only in the active live runtime; omitted during founder setup. */
  readonly layer4_runtime?: CleanLayer4RuntimeV1;
  /** Metadata-only Layer 4 failure observer for the live server log. */
  readonly answer_failure?: (event: CleanLayer4FailureEventV1) => void;
  /** Present only when the signed private-approval surface is active. */
  readonly private_approval_interaction_ingress?:
    PrivateApprovalInteractionHttpApplicationV1;
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
  let recordDatabase:
    ReturnType<typeof openOrganizationRecordDatabase> | undefined;
  let externalIdentity:
    | OpenedCleanPersonExternalIdentityRuntimeV1
    | undefined;
  try {
    recordDatabase = openOrganizationRecordDatabase(
      join(config.state_directory, "record-log.sqlite"),
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
    externalIdentity = dependencies.external_identity_runtime?.open({
      state_directory: config.state_directory,
      authority_id: metadata.authority_id,
      organization_id: metadata.organization_id,
      state_lineage_id: lineage.root.state_lineage_id,
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
    });
    const readAudit = new SqliteCleanPersonRecordReadAuditV1(database);
    const recordSearch = createCleanPersonRecordSearchRouteV1({
      state_directory: config.state_directory,
      authority_id: metadata.authority_id,
      organization_id: metadata.organization_id,
      state_lineage_id: lineage.root.state_lineage_id,
      retrieval_contract_sha256:
        cleanReadableSearchRuntimeContractV1().retrieval_contract_sha256,
      sessions,
      authority: database,
      record: recordDatabase,
      audit: readAudit,
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
        audit: readAudit,
      }),
      person_record_search: recordSearch,
      ...(dependencies.layer4_runtime === undefined
        ? {}
        : {
            person_answer: createCleanPersonAnswerRouteV1({
              authority_id: metadata.authority_id,
              organization_id: metadata.organization_id,
              state_lineage_id: lineage.root.state_lineage_id,
              search: recordSearch,
              model: dependencies.layer4_runtime.structured_output,
              generation: dependencies.layer4_runtime.generation,
              audit: new SqliteCleanPersonAnswerCompositionAuditV1(database),
              ...(dependencies.answer_failure === undefined
                ? {}
                : { on_failure: dependencies.answer_failure }),
            }),
          }),
      person_employees: createCleanPersonEmployeeHttpApplication(
        new CleanPersonEmployeeLifecycleApplication(sessions, {
          next(prefix) {
            return `${prefix}_${randomUUID()}`;
          },
        }),
      ),
      ...(externalIdentity === undefined
        ? {}
        : { person_external_identity_link: externalIdentity.application }),
      ...(dependencies.private_approval_interaction_ingress === undefined
        ? {}
        : {
            private_approval_interaction_ingress:
              dependencies.private_approval_interaction_ingress,
          }),
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
        externalIdentity?.close();
        recordDatabase?.close();
        database.close();
      },
    };
  } catch (error) {
    externalIdentity?.close();
    recordDatabase?.close();
    database.close();
    throw error;
  }
}
