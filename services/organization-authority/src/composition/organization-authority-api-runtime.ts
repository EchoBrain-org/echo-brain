import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { validateOrganizationAuthorityOrigin, validateProjectIdV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createPersonDocumentApplicationV1 } from '../application/document-v1.js';
import { SqlitePersonDocumentRepositoryV1 } from '../adapters/persistence/sqlite/document-v1.js';
import { SqlitePersonTextSourceInboxV1 } from '../adapters/persistence/sqlite/person-text-source-v1.js';
import { createPersonDocumentUploadStagingV1 } from '../adapters/files/document-upload-staging-v1.js';
import { startPersonDocumentProcessingV1 } from './person-document-processing-v1.js';
import { createPersonResearchEvalV1 } from './person-research-eval-v1.js';
import { createPersonTriggerRunsV1 } from './person-trigger-runs-v1.js';
import { createPersonDiagnosticsV1, type PersonDiagnosticsV1 } from './person-diagnostics-v1.js';
import { SqliteTriggerRunsV1 } from '../adapters/persistence/sqlite/trigger-runs-v1.js';
import { createAgenticResearchV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { STAGING_AUTHORITY_ORIGIN_V1 } from "@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1";
import { createProjectContextApplicationV1 } from '../application/project-context-application-v1.js';
import { SqliteProjectContextRepositoryV1 } from '../adapters/persistence/sqlite/project-context-v1.js';
import { createRecordProjectAuthorizationV1 } from './person-record-project-scope-v1.js';
import { createPersonToolsHttpApplicationV3, createPersonToolsHttpApplicationV4 } from '../presentation/person-tools-http-application.js';
import type { CoreRuntimeObservationScopeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  PersonRecordReaderV1,
  ApprovedMeetingTranscriptGrantReaderV1,
  openOrganizationRecordDatabase,
  type RecordApproverProjectorV1,
} from "@echo-brain/organization-record/organization-record-api-v1";
import { expandReadableSearchRelatedAtomsV1 } from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
} from "@echo-brain/organization-control-plane/record-visibility-policy-contracts-v1";
import type { AddressInfo } from "node:net";
import { SqlitePersonSessionRepository } from "../adapters/persistence/sqlite/sqlite-person-session-repository.js";
import { SqlitePersonRecordReadAuditV1 } from "../adapters/persistence/sqlite/person-record-read-audit-v1.js";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";
import { NodePersonSessionCrypto } from "../adapters/security/node-person-session-crypto.js";
import { OpenIdClientPersonSessionProvider } from "../adapters/oidc/openid-client-person-session-provider.js";
import { PersonIdentitySessionApplication } from "../application/person-identity-sessions.js";
import type { PersonSessionOidcConfiguration } from "@echo-brain/organization-authority-kernel/application/ports/person-session-dependencies";
import { SystemAuthorityClock } from "../adapters/system/system-authority-clock.js";
import { createOrganizationAuthorityHttpServer } from "../presentation/organization-authority-http-server.js";
import { LazyPersonSessionOidcProvider, type PersonSessionOidcAuthorizationProvider } from "./lazy-person-session-oidc-provider.js";
import { createPersonRecordReadRouteV1 } from "./person-record-read-route.js";
import { createPersonRecordSearchRouteV1, personMeetingReleaseOptionsV1 } from "./person-record-search-route.js";
import { PersonEmployeeLifecycleApplication } from "../application/person-employee-lifecycle.js";
import { createPersonEmployeeHttpApplication } from "../presentation/person-employee-http-application.js";
import { readableSearchGenerationContractV1 } from "./readable-search-generation-composition.js";
import { verifyAuthorityStateLineage } from "@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage";
import { createPersonMeetingTranscriptReadRouteV1, createPersonSourceEvidenceRouteV1 } from "./person-source-evidence-route.js";
import { createPersonAnswerV3Route } from "./person-answer-v3-route.js";
import { bindPersonLiveEvidenceDeskV1, createPersonLiveAnswerRouteV1 } from './person-live-answer-route-v1.js';
import type { PersonLiveConnectorDefinitionV1, OpenedPersonLiveConnectorV1, PersonLiveConnectorSourceV1 } from '../application/ports/person-context-live-runtime-v1.js';
import { personLiveConnectorDefinitionsV1 } from './person-live-connector-registry-v1.js';
import { SqlitePersonAgenticAskAuditV1 } from "../adapters/persistence/sqlite/person-agentic-ask-audit-v1.js";
import { SqlitePersonOriginalContextRetrievalV1 } from "../adapters/persistence/sqlite/person-original-context-retrieval-v1.js";
import { SqlitePersonOriginalItemsV1 } from "../adapters/persistence/sqlite/person-original-items-v1.js";
import { SqlitePersonListDirectoryV1 } from "../adapters/persistence/sqlite/person-list-directory-v1.js";
import { createPersonListRouteV1 } from "./person-list-v1-route.js";
import type { AnswerCompositionGenerationBindingV1 } from "@echo-brain/organization-authority-kernel/composition/answer-composition-generation-bundle-v1";
import type { ProviderHttpApplicationV1 } from "@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1";
import type {
  PersonExternalIdentityRuntimeBundleV1,
  OpenedPersonExternalIdentityRuntimeV1,
} from "@echo-brain/organization-authority-kernel/composition/person-external-identity-runtime";

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

export interface PersonHttpRuntimeResourcesV1 {
  readonly on_processing_queued?: () => void;
  readonly database: import('better-sqlite3').Database;
  readonly record: import('better-sqlite3').Database;
  readonly coordinates: { readonly authority_id: string; readonly organization_id: string; readonly state_lineage_id: string };
}
export interface PersonHttpRuntimeV1 {
  readonly applications: readonly ProviderHttpApplicationV1[];
  readonly processing?: import('./organization-authority-service-lifecycle.js').OrganizationAuthorityProcessingCycleV1;
  tools?(token: string): Promise<readonly import('@echo-brain/organization-api').OrganizationPersonToolV4[]>;
  close(): void;
}
export interface OrganizationAuthorityApiRuntimeDependencies {
  /** Selected HTTP capabilities independent of ticket retrieval or Ask. The selecting root owns their lifecycle. */
  readonly person_http_runtime_factory?: (authentication: Pick<PersonIdentitySessionApplication, 'authenticateAccess'>, resources: PersonHttpRuntimeResourcesV1) => PersonHttpRuntimeV1;
  /** Selected capabilities; adding a provider does not add a runtime or Ask slot. */
  readonly live_connectors?: readonly PersonLiveConnectorDefinitionV1[];
  /** Server-only agentic Ask experiment: open the whole readable scope first when it is small. */
  readonly agentic_ask_v1_small_scope_shortcut?: boolean;
  /**
   * Staging-only research evaluation endpoint (research loop evaluation v1).
   * Composed only for the staging Authority origin and only with the answer model.
   */
  readonly research_eval_v1?: true;
  /** Historical record protocol projection, independent of live ingress. */
  readonly record_approver?: RecordApproverProjectorV1;
  /**
   * The record codecs the Authority appends with. Ask's evidence desk reads
   * approved records through them; without them only human-act records parse.
   */
  readonly record_input_codecs?: import("@echo-brain/organization-protocol").RecordInputCodecRegistryV4;
  readonly core_runtime_observation?: CoreRuntimeObservationScopeV1;
  readonly oidc_provider?: PersonSessionOidcAuthorizationProvider;
  /** Optional external identity provider, omitted until it is configured. */
  readonly external_identity_runtime_bundle?: PersonExternalIdentityRuntimeBundleV1;
  /** Present only after source admission; omitted during organization setup. */
  readonly answer_composition_generation?: AnswerCompositionGenerationBindingV1;
  /** Bound by the active rebuild runtime so serving accepts the same model profile. */
  readonly readable_search_retrieval_contract_sha256?: import("@echo-brain/federation-protocol").Sha256Digest;
  /** Present only when the signed private-approval surface is active. */
  readonly private_approval_interaction_ingress?:
    ProviderHttpApplicationV1;
}

/** Recover personal writes before search startup, then attach the API's authenticated sessions. */
export function preparePersonHttpRuntimeV1(factory: OrganizationAuthorityApiRuntimeDependencies['person_http_runtime_factory'], resources: PersonHttpRuntimeResourcesV1) {
  if (factory === undefined) return undefined;
  let sessions: Pick<PersonIdentitySessionApplication, 'authenticateAccess'> | undefined;
  const runtime = factory({ authenticateAccess(input) {
    if (sessions === undefined) throw new AuthorityOperationError('unavailable', 'Person API is starting');
    return sessions.authenticateAccess(input);
  } }, resources);
  let closed = false;
  const close = () => { if (!closed) { closed = true; runtime.close(); } };
  return { processing: runtime.processing, close,
    attach(authentication: Pick<PersonIdentitySessionApplication, 'authenticateAccess'>, current: PersonHttpRuntimeResourcesV1): PersonHttpRuntimeV1 {
      if (closed || sessions !== undefined || canonicalSha256(current.coordinates) !== canonicalSha256(resources.coordinates)) throw new Error('Personal runtime cannot be rebound');
      sessions = authentication; return { ...runtime, close };
    },
  };
}

export interface RunningOrganizationAuthorityApiRuntime {
  readonly processing?: PersonHttpRuntimeV1['processing'];
  readonly address: AddressInfo;
  /** Stops ingress immediately while lifecycle-owned work retains its handles. */
  stopAcceptingRequests?(): void;
  close(): Promise<void>;
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
      "Person OIDC redirect URI must match the public Authority callback",
    );
  }
  const connectorDefinitions = personLiveConnectorDefinitionsV1(dependencies);
  const lineage = verifyAuthorityStateLineage(config.state_directory);
  // Do not contact an OIDC provider merely to bind the local API runtime.
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
  let documentWorker: ReturnType<typeof startPersonDocumentProcessingV1> | undefined;
  let diagnostics: PersonDiagnosticsV1 | undefined;
  let recordDatabase:
    ReturnType<typeof openOrganizationRecordDatabase> | undefined;
  let externalIdentity:
    | OpenedPersonExternalIdentityRuntimeV1
    | undefined;
  const liveConnectors: { readonly definition: PersonLiveConnectorDefinitionV1; readonly runtime: OpenedPersonLiveConnectorV1 }[] = [];
  let personHttp: ReturnType<NonNullable<OrganizationAuthorityApiRuntimeDependencies['person_http_runtime_factory']>> | undefined;
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
    const projectRepository = new SqliteProjectContextRepositoryV1(database);
    const memberships = { membership: (id: string) => repository.read((transaction) => transaction.membership(id)) };
    const authorizeLiveProject = (access_token: string, project_id: string) => {
      const person = sessions.authenticateAccess({ access_token });
      const id = validateProjectIdV1(project_id);
      return projectRepository.withReadTransaction(transaction => {
        const snapshot = transaction.captureAuthorization(person, { operation: 'project_read_v2', project_id: id });
        const grant = snapshot.grants.find(value => value.project_id === id);
        if (grant === undefined) throw new AuthorityOperationError('unauthorized', 'Project access is unavailable');
        return Object.freeze({ role: grant.role, authorization_sha256: canonicalSha256(grant) });
      });
    };
    for (const definition of connectorDefinitions) {
      liveConnectors.push({ definition, runtime: definition.open(sessions, authorizeLiveProject) });
    }
    const liveSources: readonly PersonLiveConnectorSourceV1[] = liveConnectors.map(({ definition, runtime }) => ({
      descriptor: definition.descriptor, scopes: definition.scopes, minimum_response_version: definition.minimum_response_version,
      application: runtime.application,
    }));
    personHttp = dependencies.person_http_runtime_factory?.(sessions, { database, record: recordDatabase,
      coordinates: { authority_id: metadata.authority_id, organization_id: metadata.organization_id, state_lineage_id: lineage.root.state_lineage_id } });
    externalIdentity = dependencies.external_identity_runtime_bundle?.open({
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
    const transcriptGrants = new ApprovedMeetingTranscriptGrantReaderV1(recordDatabase);
    const captureProjects = createRecordProjectAuthorizationV1(projectRepository);
    const originals = new SqlitePersonOriginalContextRetrievalV1(
      database,
      sessions,
      metadata.organization_id,
      {
        authority_id: metadata.authority_id,
        state_lineage_id: lineage.root.state_lineage_id,
        grants: transcriptGrants,
        is_expected_policy_contract: grant => (
          (grant.policy_id === "organization-member-readable-person-v2" && grant.policy_contract_sha256 === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256) ||
          (grant.policy_id === "restricted-reviewer-person-v2" && grant.policy_contract_sha256 === RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256) ||
          (grant.policy_id === "project-members-readable-person-v1" && grant.policy_contract_sha256 === PROJECT_MEMBERS_READABLE_PERSON_POLICY_CONTRACT_SHA256)
        ),
      },
    );
    const recordSearch = createPersonRecordSearchRouteV1({
      ...(dependencies.record_input_codecs === undefined ? {} : { record_input_codecs: dependencies.record_input_codecs }),
      state_directory: config.state_directory,
      authority_id: metadata.authority_id,
      organization_id: metadata.organization_id,
      state_lineage_id: lineage.root.state_lineage_id,
      retrieval_contract_sha256:
        dependencies.readable_search_retrieval_contract_sha256 ??
        readableSearchGenerationContractV1().retrieval_contract_sha256,
      sessions,
      authority: database,
      record: recordDatabase,
      audit: readAudit,
      capture_projects: captureProjects,
      expand_related_atoms: expandReadableSearchRelatedAtomsV1,
      // Mine needs the approver; the person list names it and offers a shared transcript.
      ...personMeetingReleaseOptionsV1({
        record_approver: dependencies.record_approver,
        memberships,
        originals,
      }),
    });
    const documents = new SqlitePersonDocumentRepositoryV1(database);
    const originalItems = new SqlitePersonOriginalItemsV1(database, sessions, metadata.organization_id);
    const personTools = async (token: string) => [
      ...await (personHttp?.tools?.(token) ?? []),
      ...await (externalIdentity?.tools(token) ?? Promise.resolve([])),
      ...(await Promise.all(liveConnectors.map(({ runtime }) => runtime.tools?.(token) ?? []))).flat(),
    ];
    documentWorker = startPersonDocumentProcessingV1(documents,new SqlitePersonTextSourceInboxV1(database),{
      on_failure: event => console.error(JSON.stringify(event)),
    });
    diagnostics = dependencies.answer_composition_generation === undefined ? undefined : createPersonDiagnosticsV1({ sessions });
    const answerOptions = dependencies.answer_composition_generation === undefined ? undefined : {
      authority_id: metadata.authority_id, organization_id: metadata.organization_id, state_lineage_id: lineage.root.state_lineage_id,
      sessions, originals, records: recordSearch,
      memberships,
      model: dependencies.answer_composition_generation.structured_output,
      generation: dependencies.answer_composition_generation.generation,
      audit: new SqlitePersonAgenticAskAuditV1(database),
      ...(diagnostics === undefined ? {} : { diagnostics }),
      ...(dependencies.agentic_ask_v1_small_scope_shortcut === true ? { small_scope_shortcut: true } : {}),
    };
    const researchEval = dependencies.research_eval_v1 === true && config.authority_url === STAGING_AUTHORITY_ORIGIN_V1 && answerOptions !== undefined
      ? createPersonResearchEvalV1({ ...answerOptions, live_sources: liveSources })
      : undefined;
    const triggerRuns = answerOptions === undefined ? Object.freeze({
      async list(input: { readonly access_token: string }) { sessions.authenticateAccess({ access_token: input.access_token }); throw new AuthorityOperationError('unavailable', 'an answer model is not configured'); },
      async start(input: { readonly access_token: string }) { sessions.authenticateAccess({ access_token: input.access_token }); throw new AuthorityOperationError('unavailable', 'an answer model is not configured'); },
      async retry(input: { readonly access_token: string }) { sessions.authenticateAccess({ access_token: input.access_token }); throw new AuthorityOperationError('unavailable', 'an answer model is not configured'); },
      async view(input: { readonly access_token: string }) { sessions.authenticateAccess({ access_token: input.access_token }); throw new AuthorityOperationError('unavailable', 'an answer model is not configured'); },
      close() {},
    }) : createPersonTriggerRunsV1({
      runs: new SqliteTriggerRunsV1(database), sessions, records: recordSearch, bindDesk: bindPersonLiveEvidenceDeskV1, audit: answerOptions.audit, bind_options: answerOptions, live_sources: liveSources,
      research: ({ desk, context }) => createAgenticResearchV1({ desk, model: answerOptions.model, generation: answerOptions.generation, audit: answerOptions.audit.forRequest(context),
        ...(answerOptions.small_scope_shortcut === true ? { small_scope_shortcut: true } : {}) }),
    });
    let closing = false;
    const server = createOrganizationAuthorityHttpServer({
      is_closing: () => closing,
      descriptor: metadata.descriptor,
      sessions,
      oidc_provider: provider,
      expected_issuer: config.oidc.issuer,
      ...(dependencies.core_runtime_observation === undefined ? {} : { core_runtime_observation: dependencies.core_runtime_observation }),
      person_record_read: createPersonRecordReadRouteV1({
        authority_id: metadata.authority_id,
        organization_id: metadata.organization_id,
        state_lineage_id: lineage.root.state_lineage_id,
        sessions,
        records: new PersonRecordReaderV1(recordDatabase),
        capture_projects: captureProjects,
        record_approver: dependencies.record_approver,
        memberships,
        audit: readAudit,
      }),
      person_record_search: recordSearch,
      person_tool_connections: [
        ...liveConnectors.flatMap(({ runtime }) => runtime.connection_http === undefined ? [] : [runtime.connection_http]),
        ...(personHttp?.applications ?? []),
      ],
      person_meeting_transcript: createPersonMeetingTranscriptReadRouteV1({ originals }),
      person_source_evidence: createPersonSourceEvidenceRouteV1({ originals }),
      // Outside the answer-model gate: listing and opening never call a model.
      person_list: createPersonListRouteV1({
        organization_id: metadata.organization_id,
        sessions,
        tools: personTools,
        directory: new SqlitePersonListDirectoryV1(database),
        originals: originalItems,
        meetings: recordSearch,
        transcripts: originals,
      }),
      // Agentic Ask is the only Ask (ADR-0022); it needs the bound answer model.
      ...(answerOptions === undefined ? {} : {
        person_answer_v3: createPersonAnswerV3Route(answerOptions),
        // A response version is available with the model even when no external
        // source is configured. The request catalog still contains local context.
        person_answer_v4: createPersonLiveAnswerRouteV1({ ...answerOptions, live_sources: liveSources }, 5),
        person_answer_v5: createPersonLiveAnswerRouteV1({ ...answerOptions, live_sources: liveSources }, 6),
      }),
      ...(researchEval === undefined ? {} : { person_research_eval: researchEval }),
      ...(diagnostics === undefined ? {} : { person_diagnostics: diagnostics }),
      person_trigger_runs: triggerRuns,
      person_documents: createPersonDocumentApplicationV1({
        authenticate: accessToken => sessions.authenticateAccess({ access_token: accessToken }),
        repository: documents,
        on_original_saved: () => documentWorker?.wake(),
      }),
      document_upload_staging: createPersonDocumentUploadStagingV1(),
      project_context: createProjectContextApplicationV1({
        authenticate: accessToken => sessions.authenticateAccess({ access_token: accessToken }),
        repository: projectRepository,
      }),
      person_employees: createPersonEmployeeHttpApplication(
        new PersonEmployeeLifecycleApplication(sessions, {
          next(prefix) {
            return `${prefix}_${randomUUID()}`;
          },
        }),
      ),
      person_tools: createPersonToolsHttpApplicationV3({
        authenticate: (access_token) => sessions.authenticateAccess({ access_token }),
        tools: personTools,
      }),
      person_tools_v4: createPersonToolsHttpApplicationV4({
        authenticate: (access_token) => sessions.authenticateAccess({ access_token }),
        tools: personTools,
      }),
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
    let serverClosed: Promise<unknown> | undefined;
    const stopAcceptingRequests = (): void => {
      closing = true;
      if (serverClosed !== undefined || !server.listening) return;
      serverClosed = once(server, "close");
      server.close();
    };
    return {
      address,
      ...(personHttp?.processing === undefined ? {} : { processing: personHttp.processing }),
      stopAcceptingRequests,
      close: async () => {
        stopAcceptingRequests();
        researchEval?.close();
        triggerRuns?.close();
        diagnostics?.close();
        await Promise.all([serverClosed, documentWorker?.close()]);
        for (const { runtime } of [...liveConnectors].reverse()) runtime.close();
        personHttp?.close();
        externalIdentity?.close();
        recordDatabase?.close();
        database.close();
      },
    };
  } catch (error) {
    diagnostics?.close();
    await documentWorker?.close();
    for (const { runtime } of [...liveConnectors].reverse()) runtime.close();
    personHttp?.close();
    externalIdentity?.close();
    recordDatabase?.close();
    database.close();
    throw error;
  }
}
