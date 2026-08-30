import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  CleanPersonRecordReaderV1,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/new-lineage-v1";
import type { AddressInfo } from "node:net";
import { validateOrganizationAuthorityOrigin } from "@echo-brain/organization-api";
import { SqlitePersonSessionRepository } from "../adapters/persistence/sqlite/sqlite-person-session-repository.js";
import { SqlitePersonAnswerCompositionAuditV1 } from "../adapters/persistence/sqlite/person-answer-composition-audit-v1.js";
import { SqlitePersonRecordReadAuditV1 } from "../adapters/persistence/sqlite/person-record-read-audit-v1.js";
import { openAuthorityDatabase } from "../adapters/persistence/sqlite/open-unmigrated-database.js";
import { NodePersonSessionCrypto } from "../adapters/security/node-person-session-crypto.js";
import { OpenIdClientPersonSessionProvider } from "../adapters/oidc/openid-client-person-session-provider.js";
import { PersonIdentitySessionApplication } from "../application/person-identity-sessions.js";
import type { PersonSessionOidcConfiguration } from "../application/ports/person-session-runtime.js";
import { SystemAuthorityClock } from "../adapters/runtime/system-runtime-ports.js";
import { createOrganizationAuthorityHttpServer } from "../presentation/organization-authority-http-server.js";
import type { PersonSessionOidcAuthorizationProvider } from "./lazy-person-session-oidc-provider.js";
import { LazyPersonSessionOidcProvider } from "./lazy-person-session-oidc-provider.js";
import { createPersonRecordReadRouteV1 } from "./person-record-read-route.js";
import { createPersonRecordSearchRouteV1 } from "./person-record-search-route.js";
import { PersonEmployeeLifecycleApplication } from "../application/person-employee-lifecycle.js";
import { createPersonEmployeeHttpApplication } from "../presentation/person-employee-http-application.js";
import { readableSearchRuntimeContractV1 } from "./readable-search-runtime.js";
import { verifyCleanStateLineage } from "./verify-clean-state-lineage.js";
import {
  createPersonAnswerRouteV1,
  type AnswerCompositionFailureEventV1,
} from "./person-answer-route.js";
import type { AnswerCompositionRuntimeV1 } from "./answer-composition-runtime.js";
import type { PrivateApprovalInteractionHttpApplicationV1 } from "../presentation/private-approval-interaction-http-application-v1.js";
import type {
  PersonExternalIdentityRuntimeBundleV1,
  OpenedPersonExternalIdentityRuntimeV1,
} from "./person-external-identity-runtime.js";

export interface OrganizationAuthorityApiRuntimeConfig {
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

export interface OrganizationAuthorityApiRuntimeDependencies {
  readonly oidc_provider?: PersonSessionOidcAuthorizationProvider;
  /** Optional external identity provider, omitted until it is configured. */
  readonly external_identity_runtime?: PersonExternalIdentityRuntimeBundleV1;
  /** Present only after source admission; omitted during organization setup. */
  readonly answer_composition_runtime?: AnswerCompositionRuntimeV1;
  /** Metadata-only Layer 4 failure observer for the live server log. */
  readonly answer_failure?: (event: AnswerCompositionFailureEventV1) => void;
  /** Present only when the signed private-approval surface is active. */
  readonly private_approval_interaction_ingress?:
    PrivateApprovalInteractionHttpApplicationV1;
}

export interface RunningOrganizationAuthorityApiRuntime {
  readonly address: AddressInfo;
  close(): Promise<void>;
}

export function verifyOrganizationAuthorityApiLineage(stateDirectory: string) {
  return verifyCleanStateLineage(stateDirectory);
}

/**
 * Opens the Organization Authority HTTP API and its request-serving database
 * handles. It verifies lineage before opening Authority writeable and never
 * imports installation, migration, or background-worker lifecycle behavior.
 */
export async function startOrganizationAuthorityApiRuntime(
  config: OrganizationAuthorityApiRuntimeConfig,
  dependencies: OrganizationAuthorityApiRuntimeDependencies = {},
): Promise<RunningOrganizationAuthorityApiRuntime> {
  if (
    !Number.isSafeInteger(config.port) ||
    config.port < 1 ||
    config.port > 65_535
  ) {
    throw new Error("Organization Authority API port is invalid");
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
  const lineage = verifyOrganizationAuthorityApiLineage(config.state_directory);
  // Do not contact an OIDC provider merely to bind the clean local runtime.
  // Discovery is deferred until the initial owner begins an OIDC login.
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
    | OpenedPersonExternalIdentityRuntimeV1
    | undefined;
  try {
    recordDatabase = openOrganizationRecordDatabase(
      join(config.state_directory, "record-log.sqlite"),
      { fileMustExist: true },
    );
    const repository = new SqlitePersonSessionRepository(database);
    const metadata = repository.read((transaction) => transaction.metadata());
    if (
      metadata.authority_id !== lineage.root.authority_id ||
      metadata.organization_id !== lineage.root.organization_id
    ) {
      throw new Error(
        "Organization Authority API metadata differs from verified lineage",
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
    const readAudit = new SqlitePersonRecordReadAuditV1(database);
    const recordSearch = createPersonRecordSearchRouteV1({
      state_directory: config.state_directory,
      authority_id: metadata.authority_id,
      organization_id: metadata.organization_id,
      state_lineage_id: lineage.root.state_lineage_id,
      retrieval_contract_sha256:
        readableSearchRuntimeContractV1().retrieval_contract_sha256,
      sessions,
      authority: database,
      record: recordDatabase,
      audit: readAudit,
    });
    const server = createOrganizationAuthorityHttpServer({
      descriptor: metadata.descriptor,
      sessions,
      oidc_provider: provider,
      expected_issuer: config.oidc.issuer,
      person_record_read: createPersonRecordReadRouteV1({
        authority_id: metadata.authority_id,
        organization_id: metadata.organization_id,
        state_lineage_id: lineage.root.state_lineage_id,
        sessions,
        records: new CleanPersonRecordReaderV1(recordDatabase),
        audit: readAudit,
      }),
      person_record_search: recordSearch,
      ...(dependencies.answer_composition_runtime === undefined
        ? {}
        : {
            person_answer: createPersonAnswerRouteV1({
              authority_id: metadata.authority_id,
              organization_id: metadata.organization_id,
              state_lineage_id: lineage.root.state_lineage_id,
              search: recordSearch,
              model: dependencies.answer_composition_runtime.structured_output,
              generation: dependencies.answer_composition_runtime.generation,
              audit: new SqlitePersonAnswerCompositionAuditV1(database),
              ...(dependencies.answer_failure === undefined
                ? {}
                : { on_failure: dependencies.answer_failure }),
            }),
          }),
      person_employees: createPersonEmployeeHttpApplication(
        new PersonEmployeeLifecycleApplication(sessions, {
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
      throw new Error("Organization Authority API did not bind TCP");
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
