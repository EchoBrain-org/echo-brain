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
import { createReadableSearchGenerationReconcilerV1 } from "./readable-search-generation-composition.js";
import type { ReadableSearchGenerationReconciliationV1 } from "./readable-search-generation-reconciler.js";
import {
  READABLE_SEARCH_ADMISSION_BUDGET_V1,
  readableSearchActiveGenerationUsageV1,
  readableSearchExceededLimitV1,
  type ReadableSearchAdmissionLimitV1,
} from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import type { OrganizationAuthorityApiRuntimeConfig, OrganizationAuthorityApiRuntimeDependencies } from "./organization-authority-api-runtime.js";
import { verifyAuthorityStateLineage } from "@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage";
import { createModelCallLimiterV1, limitStructuredGenerationPortV1, limitResearchDriverV1, RESEARCH_SESSION_LIMITS_V1, type ModelCallLimiterV1, type ModelCallPriorityV1 } from "./model-call-limiter-v1.js";

/**
 * Content-free search capacity notices: `near` after publishing a generation at
 * 75% or more of any admission limit, `over` when a rebuild is refused.
 */
export type ReadableSearchCapacityEventV1 =
  | { readonly status: "near"; readonly atoms: number; readonly segments: number; readonly postings: number }
  | { readonly status: "over"; readonly limit: ReadableSearchAdmissionLimitV1 };

const SEARCH_CAPACITY_WARNING_SHARE = 0.75;

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
  /** Staging-only research evaluation endpoint; ignored for any other Authority origin. */
  readonly staging_research_eval_v1?: true;
  readonly staging_claude_research_v1?: true;
  /** Explicit answer-composition bundle. This generic root does not select one. */
  readonly answer_composition_generation_bundle: AnswerCompositionGenerationBundleV1;
  /** The one model-call limiter, shared with extraction by the root that selects the provider; one is made when absent. */
  readonly model_call_limiter?: ModelCallLimiterV1;
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
  /** Observational only: the search index is close to, or past, its admission ceiling. */
  readonly on_search_capacity?: (event: ReadableSearchCapacityEventV1) => void;
  /**
   * Staging-selected release canary over the owner's synthetic personal source.
   * The runtime only runs it one at a time outside the writer gate.
   */
  readonly run_staging_synthetic_canary?: (release_id: string, signal: AbortSignal) => Promise<StagingSyntheticCanaryOutcomeV1>;
}

export interface OpenedOrganizationAuthorityRuntime
  extends RunningOrganizationAuthorityServiceLifecycle {
  /** Active once a personal meeting runtime is composed; meetings only enter through personal sources. */
  readonly processing: "idle_until_finalize" | "active";
  /**
   * A staging-guarded rehearsal hook. It runs one at a time outside the writer
   * gate, appends no records so search keeps running, and stages the release's
   * canary meeting through the owner's synthetic personal source.
   */
  readonly run_staging_synthetic_canary?: (
    release_id: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<StagingSyntheticCanaryOutcomeV1>;
}

function stagingSyntheticCanaryHook(
  config: Pick<OrganizationAuthorityRuntimeConfig, "run_staging_synthetic_canary">,
  runtime: Pick<RunningOrganizationAuthorityServiceLifecycle, "runUngated">,
): Pick<OpenedOrganizationAuthorityRuntime, "run_staging_synthetic_canary"> {
  const run = config.run_staging_synthetic_canary;
  return run === undefined ? {} : {
    run_staging_synthetic_canary: (release_id, options) => runtime.runUngated((signal) =>
      run(release_id, options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]))),
  };
}

/**
 * Narrow composition seams for deterministic local rehearsals. Production
 * callers leave this absent.
 */
interface OrganizationAuthorityRuntimeDependencies {
  /** Passed straight to the Authority API runtime, for example a local OIDC fake. */
  readonly api?: Partial<OrganizationAuthorityApiRuntimeDependencies>;
}

interface ReadableSearchReconcilerV1 {
  reconcile(signal: AbortSignal): Promise<ReadableSearchGenerationReconciliationV1>;
}

/**
 * The Authority's own worker phases: personal updates and search maintenance.
 * Meeting intake and approvals belong to the personal meeting runtime, which
 * the lifecycle runs beside this as its additional processing.
 */
class OrganizationAuthorityProcessingCoordinator
  implements OrganizationAuthorityProcessingCycleV1 {
  constructor(
    private readonly readableSearch: ReadableSearchReconcilerV1,
    private readonly updates: PersonUpdateProcessingBindingV1,
    private readonly onSearchCapacity?: (event: ReadableSearchCapacityEventV1) => void,
  ) {}

  pollAndStageAdmittedMeetings(signal: AbortSignal): Promise<void> {
    return this.updates.runOnce(signal);
  }

  async reconcileReadableSearchGeneration(signal: AbortSignal): Promise<{ readonly status: ReadableSearchGenerationReconciliationV1["status"] }> {
    let status: ReadableSearchGenerationReconciliationV1["status"];
    try {
      ({ status } = await this.readableSearch.reconcile(signal));
    } catch (error) {
      const limit = readableSearchExceededLimitV1(error);
      if (limit !== undefined) this.reportCapacity({ status: "over", limit });
      throw error;
    }
    signal.throwIfAborted();
    const usage = status === "published" ? readableSearchActiveGenerationUsageV1() : undefined;
    const budget = READABLE_SEARCH_ADMISSION_BUDGET_V1;
    if (usage !== undefined && (
      usage.atoms >= budget.maximum_atoms * SEARCH_CAPACITY_WARNING_SHARE ||
      usage.segments >= budget.maximum_segments * SEARCH_CAPACITY_WARNING_SHARE ||
      usage.postings >= budget.maximum_postings * SEARCH_CAPACITY_WARNING_SHARE
    )) this.reportCapacity({ status: "near", ...usage });
    return { status };
  }

  private reportCapacity(event: ReadableSearchCapacityEventV1): void {
    try { this.onSearchCapacity?.(event); } catch { /* observational only */ }
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
  const baseApiDependencies: Partial<OrganizationAuthorityApiRuntimeDependencies> = {
    ...dependencies.api,
    record_input_codecs: config.record_input_codecs,
    // The API runtime composes it only for the staging Authority origin.
    ...(config.staging_research_eval_v1 === true ? { research_eval_v1: true as const } : {}),
    ...(config.core_runtime_observation === undefined ? {} : { core_runtime_observation: config.core_runtime_observation }),

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
    const limiter = config.model_call_limiter ?? createModelCallLimiterV1();
    const researchSessions = createModelCallLimiterV1(RESEARCH_SESSION_LIMITS_V1);
    const { personal_research: personalResearch, ...sharedGeneration } = answerGeneration;
    const limited = (priority: ModelCallPriorityV1): AnswerCompositionGenerationBindingV1 => Object.freeze({ ...sharedGeneration,
      structured_output: limitStructuredGenerationPortV1(answerGeneration.structured_output, (signal, op) => limiter.run(priority, signal, op)),
      ...(personalResearch === undefined || priority !== 'interactive' ? {} : { personal_research: {
        ...personalResearch,
        ...(personalResearch.structured_output === undefined ? {} : { structured_output: limitStructuredGenerationPortV1(personalResearch.structured_output,
          (signal, op) => limiter.run(priority, signal, op), (signal, op) => researchSessions.run(priority, signal, op)) }),
        driver: limitResearchDriverV1(personalResearch.driver,
          (signal, op) => limiter.run(priority, signal, op), (signal, op) => researchSessions.run(priority, signal, op)),
      } }),
      ...(answerGeneration.research_driver === undefined ? {} : { research_driver: limitResearchDriverV1(answerGeneration.research_driver,
        (signal, op) => limiter.run(priority, signal, op), (signal, op) => researchSessions.run(priority, signal, op)) }),
    });
    // Ask is interactive; notes and trigger research wait behind it.
    const backgroundGeneration = limited("background");
    const readableSearch = createReadableSearchGenerationReconcilerV1({
      state_directory: config.state_directory,
      root: lineage.root,
      authority,
      record,
      signer,
      policy_projectors: config.record_policy_fact_projectors,
      record_input_codecs: config.record_input_codecs,
    });
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api, worker_interval_ms: config.worker_interval_ms },
      {
        additional_processing: preparedPerson?.processing,
        processing: new OrganizationAuthorityProcessingCoordinator(
          readableSearch,
          createPersonUpdateProcessingV1(
            backgroundGeneration,
            new SqlitePersonUpdateEnrichmentWorkV2(
              authority,
              new SqliteProjectUploadEnrichmentAuthorizationV1(authority),
            ),
          ),
          config.on_search_capacity,
        ),
        api: {
          ...baseApiDependencies,
          ...(preparedPerson === undefined ? {} : { person_http_runtime_factory: preparedPerson.attach }),
          answer_composition_generation: limited("interactive"),
          answer_composition_background: backgroundGeneration.structured_output,
          ...(backgroundGeneration.research_driver === undefined ? {} : { research_background_driver: backgroundGeneration.research_driver }),
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
