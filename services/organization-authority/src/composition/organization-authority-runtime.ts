import { preparePersonHttpRuntimeV1 } from './organization-authority-api-runtime.js';
import { createPersonUpdateProcessingV1, type PersonUpdateProcessingBindingV1 } from './person-update-processing-v1.js';
import { SqlitePersonUpdateEnrichmentWorkV2 } from '../adapters/persistence/sqlite/person-update-enrichment-work-v2.js';
import { SqliteProjectUploadEnrichmentAuthorizationV1 } from '../adapters/persistence/sqlite/project-upload-enrichment-v1.js';
import type { RecordInputCodecRegistryV4 } from "@echo-brain/organization-protocol";
import type { CoreRuntimeObservationScopeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { join } from "node:path";
import {
  type RecordPolicyFactProjectorRegistryV1,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/organization-record-api-v1";
import { readPrivateAuthorityPersonSessionPkceKey } from "@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials";
import { FileOrganizationAuthoritySigner } from "../adapters/security/file-organization-authority-signer.js";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";
import type { PersonSessionOidcConfiguration } from "@echo-brain/organization-authority-kernel/application/ports/person-session-dependencies";
import type {
  AnswerCompositionGenerationBindingV1,
  AnswerCompositionGenerationBundleV1,
} from "@echo-brain/organization-authority-kernel/composition/answer-composition-generation-bundle-v1";
import {
  startOrganizationAuthorityServiceLifecycle,
  type OrganizationAuthorityProcessingCycleV1,
  type RunningOrganizationAuthorityServiceLifecycle,
} from "./organization-authority-service-lifecycle.js";
import {
  createReadableSearchGenerationReconcilerV1,
  readableSearchGenerationContractV1,
  type ReadableSearchRelatedAtomProjectorBindingV1,
} from "./readable-search-generation-composition.js";
import type { OrganizationAuthorityApiRuntimeConfig } from "./organization-authority-api-runtime.js";
import type { OrganizationAuthorityApiRuntimeDependencies } from "./organization-authority-api-runtime.js";
import { verifyAuthorityStateLineage } from "@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage";
import { STAGING_AUTHORITY_ORIGIN_V1 } from "@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1";

/** The staging release canary's outcome; the deploy receipt reads `approval_outcome = kind` and `approval_id`. */
export interface StagingSyntheticCanaryOutcomeV1 {
  readonly kind: "staged" | "not_actionable" | "not_staged";
  readonly approval_id: string | null;
}

export interface OrganizationAuthorityRuntimeConfig {
  readonly core_runtime_observation?: CoreRuntimeObservationScopeV1;
  readonly state_directory: string;
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly authority_url: string;
  readonly oidc: PersonSessionOidcConfiguration;
  readonly client_authentication: OrganizationAuthorityApiRuntimeConfig["client_authentication"];
  readonly pkce_key_file: string;
  /** Server-only agentic Ask experiment, off unless the serving profile opts in. */
  readonly agentic_ask_v1_small_scope_shortcut?: boolean;
  /** Staging-only research evaluation endpoint; ignored for any other Authority origin. */
  readonly staging_research_eval_v1?: true;
  /** Explicit answer-composition bundle. This generic root does not select one. */
  readonly answer_composition_generation_bundle: AnswerCompositionGenerationBundleV1;
  /** Exact durable record-resolution protocols admitted into append and retrieval. */
  readonly record_input_codecs: RecordInputCodecRegistryV4;
  readonly record_policy_fact_projectors: RecordPolicyFactProjectorRegistryV1;
  readonly worker_interval_ms?: number;
  /** Observational only: a failed cycle is retried by the serialized worker. */
  readonly on_worker_error?: (error: Error) => void;
  /** Observational only: bounded, content-free worker lifecycle events. */
  readonly on_worker_telemetry?: (
    event: import("@echo-brain/organization-processing/admitted-meeting-processing/meeting-processing-worker-lifecycle").MeetingProcessingWorkerTelemetryEventV1,
  ) => void;
  /** Staging-only Ask telemetry; omitted from every production runtime. */
  readonly ask_journey_telemetry?:
    OrganizationAuthorityApiRuntimeDependencies["ask_journey_telemetry"];
  /**
   * Staging-selected release canary over the owner's synthetic personal source.
   * The runtime only serializes it with the worker.
   */
  readonly run_staging_synthetic_canary?: (release_id: string, signal: AbortSignal) => Promise<StagingSyntheticCanaryOutcomeV1>;
}

export interface OpenedOrganizationAuthorityRuntime
  extends RunningOrganizationAuthorityServiceLifecycle {
  /** Active once a personal meeting runtime is composed; meetings only enter through personal sources. */
  readonly processing: "idle_until_finalize" | "active";
  /**
   * A staging-guarded rehearsal hook. It runs exclusively with the worker and
   * stages the release's canary meeting through the owner's synthetic personal source.
   */
  readonly run_staging_synthetic_canary?: (
    release_id: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<StagingSyntheticCanaryOutcomeV1>;
}

function stagingSyntheticCanaryHook(
  config: Pick<OrganizationAuthorityRuntimeConfig, "run_staging_synthetic_canary">,
  runtime: Pick<RunningOrganizationAuthorityServiceLifecycle, "runExclusive">,
): Pick<OpenedOrganizationAuthorityRuntime, "run_staging_synthetic_canary"> {
  const run = config.run_staging_synthetic_canary;
  return run === undefined ? {} : {
    run_staging_synthetic_canary: (release_id, options) => runtime.runExclusive((signal) =>
      run(release_id, options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]))),
  };
}

function relatedAtomProjectorBinding(
  generation: AnswerCompositionGenerationBindingV1,
): ReadableSearchRelatedAtomProjectorBindingV1 {
  return Object.freeze({
    structured_output: generation.structured_output,
    profile: Object.freeze({
      generation_adapter_id: generation.generation.generation_adapter_id,
      model: generation.generation.planner_model,
      timeout_ms: generation.generation.timeout_ms,
    }),
  });
}
/**
 * Narrow composition seams for deterministic local rehearsals. Production
 * callers leave this absent.
 */
export interface OrganizationAuthorityRuntimeDependencies {
  /** Passed straight to the Authority API runtime, for example a local OIDC fake. */
  readonly api?: OrganizationAuthorityApiRuntimeDependencies;
}

interface ReadableSearchReconcilerV1 {
  reconcile(signal: AbortSignal): Promise<unknown>;
}

/**
 * The Authority's own worker phases: personal updates and search maintenance.
 * Meeting intake and approvals belong to the personal meeting runtime, which
 * the lifecycle runs beside this as its additional processing.
 */
class OrganizationAuthorityProcessingCoordinator
  implements OrganizationAuthorityProcessingCycleV1 {
  readonly hasFineGrainedSourceLifecycle = true;
  constructor(
    private readonly readableSearch: ReadableSearchReconcilerV1,
    private readonly updates: PersonUpdateProcessingBindingV1,
  ) {}

  recoverV4Appends(): Promise<void> {
    return Promise.resolve();
  }

  pollAndStageAdmittedMeetings(signal: AbortSignal): Promise<void> {
    return this.updates.runOnce(signal);
  }

  observeAndFinalizePendingApprovals(): Promise<void> {
    return Promise.resolve();
  }

  appendFinalizedApprovalsToV4(): Promise<void> {
    return Promise.resolve();
  }

  async reconcileReadableSearchGeneration(signal: AbortSignal): ReturnType<OrganizationAuthorityProcessingCycleV1["reconcileReadableSearchGeneration"]> {
    const result = await this.readableSearch.reconcile(signal);
    signal.throwIfAborted();
    if (
      typeof result === "object" &&
      result !== null &&
      "status" in result &&
      (result.status === "current" ||
        result.status === "published" ||
        result.status === "superseded")
    ) {
      return { status: result.status };
    }
    throw new TypeError("unrecognized readable-search reconciliation result");
  }
}

/**
 * Provider-neutral Organization Authority runtime composition. API routes,
 * Ask, personal updates and search maintenance are always available. Meetings
 * enter only through personal sources, whose runtime a caller composes through
 * the Person HTTP runtime factory; without one, meeting processing stays idle.
 */
export async function openOrganizationAuthorityRuntime(
  config: OrganizationAuthorityRuntimeConfig,
  dependencies: OrganizationAuthorityRuntimeDependencies = {},
): Promise<OpenedOrganizationAuthorityRuntime> {
  const lineage = verifyAuthorityStateLineage(config.state_directory);
  const api: OrganizationAuthorityApiRuntimeConfig = {
    state_directory: config.state_directory,
    host: config.host,
    port: config.port,
    authority_url: config.authority_url,
    oidc: config.oidc,
    client_authentication: config.client_authentication,
    pkce_sealing_key: readPrivateAuthorityPersonSessionPkceKey(
      `file:${config.pkce_key_file}`,
    ),
  };
  const baseApiDependencies: OrganizationAuthorityApiRuntimeDependencies = {
    ...dependencies.api,
    record_input_codecs: config.record_input_codecs,
    ...(config.staging_research_eval_v1 === true && config.authority_url === STAGING_AUTHORITY_ORIGIN_V1
      ? { research_eval_v1: true as const }
      : {}),
    ...(config.agentic_ask_v1_small_scope_shortcut === true
      ? { agentic_ask_v1_small_scope_shortcut: true }
      : {}),
    ...(config.core_runtime_observation === undefined ? {} : { core_runtime_observation: config.core_runtime_observation }),
    ...(dependencies.api?.ask_journey_telemetry !== undefined ||
    config.ask_journey_telemetry === undefined
      ? {}
      : { ask_journey_telemetry: config.ask_journey_telemetry }),
  };
  const authority = openAuthorityDatabase(
    join(config.state_directory, "authority.sqlite"),
    { fileMustExist: true },
  );
  const record = openOrganizationRecordDatabase(
    join(config.state_directory, "record-log.sqlite"),
    { fileMustExist: true },
  );
  let preparedPerson: ReturnType<typeof preparePersonHttpRuntimeV1>;
  let personalPublication: (() => void) | undefined;
  try {
    preparedPerson = preparePersonHttpRuntimeV1(baseApiDependencies.person_http_runtime_factory, {
      database: authority, record, coordinates: { authority_id: lineage.root.authority_id, organization_id: lineage.root.organization_id, state_lineage_id: lineage.root.state_lineage_id },
      on_processing_queued: () => personalPublication?.(),
    });
    const signer = FileOrganizationAuthoritySigner.openExisting({
      directory: join(config.state_directory, "keys"),
      authority_id: lineage.root.authority_id,
      organization_id: lineage.root.organization_id,
    });
    const answerGeneration =
      dependencies.api?.answer_composition_generation ??
      config.answer_composition_generation_bundle.load();
    const relatedAtomProjector = relatedAtomProjectorBinding(answerGeneration);
    const readableSearchContract = readableSearchGenerationContractV1({
      related_atom_projector: relatedAtomProjector.profile,
    });
    const readableSearch = createReadableSearchGenerationReconcilerV1({
      state_directory: config.state_directory,
      root: lineage.root,
      authority,
      record,
      signer,
      policy_projectors: config.record_policy_fact_projectors,
      record_input_codecs: config.record_input_codecs,
      related_atom_projector: relatedAtomProjector,
    });
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api, worker_interval_ms: config.worker_interval_ms },
      {
        additional_processing: preparedPerson?.processing,
        processing: new OrganizationAuthorityProcessingCoordinator(
          readableSearch,
          createPersonUpdateProcessingV1(
            answerGeneration,
            new SqlitePersonUpdateEnrichmentWorkV2(
              authority,
              new SqliteProjectUploadEnrichmentAuthorizationV1(authority),
            ),
          ),
        ),
        api: {
          ...baseApiDependencies,
          ...(preparedPerson === undefined ? {} : { person_http_runtime_factory: preparedPerson.attach }),
          answer_composition_generation: answerGeneration,
          readable_search_retrieval_contract_sha256:
            readableSearchContract.retrieval_contract_sha256,
        },
        on_worker_error: config.on_worker_error,
        on_worker_telemetry: config.on_worker_telemetry,
        ...(config.core_runtime_observation === undefined ? {} : { core_runtime_observation: config.core_runtime_observation }),
      },
    );
    personalPublication = () => runtime.requestApprovalPublication();
    return {
      ...runtime,
      ...stagingSyntheticCanaryHook(config, runtime),
      processing: preparedPerson?.processing === undefined ? "idle_until_finalize" : "active",
      close: async () => {
        try { await runtime.close(); }
        finally { preparedPerson?.close(); record.close(); authority.close(); }
      },
    };
  } catch (error) {
    preparedPerson?.close();
    record.close();
    authority.close();
    throw error;
  }
}
