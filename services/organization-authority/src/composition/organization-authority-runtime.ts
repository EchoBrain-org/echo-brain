import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openOrganizationControlDatabase } from "@echo-brain/organization-control-plane/organization-control-database-v1";
import {
  type RecordPolicyFactProjectorRegistryV1,
  OrganizationRecordAppenderV4,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/organization-record-api-v1";
import { readPrivateAuthorityPersonSessionPkceKey } from "../adapters/security/private-file-credentials.js";
import { FileOrganizationAuthoritySigner } from "../adapters/security/file-organization-authority-signer.js";
import { openAuthorityDatabase } from "../adapters/persistence/sqlite/open-authority-database.js";
import type { PersonSessionOidcConfiguration } from "../application/ports/person-session-dependencies.js";
import { AdmittedMeetingProcessingCycleV1 } from "../processing/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import {
  readAdmittedMeetingProcessingCommitmentsV1,
} from "../processing/admitted-meeting-processing/admitted-meeting-processing-commitments.js";
import { SqliteAuthorityMeetingProcessingStateV1 } from "../processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.js";
import type {
  ApprovalWorkflowProcessingV1,
  ApprovalWorkflowBundleV1,
} from "./approval-workflow-bundle-v1.js";
import type {
  AnswerCompositionGenerationBindingV1,
  AnswerCompositionGenerationBundleV1,
} from "./answer-composition-generation-bundle-v1.js";
import type { DecisionProcessorBundleV1 } from "./decision-processor-bundle-v1.js";
import type { MeetingSourceBundleV1 } from "./meeting-source-bundle-v1.js";
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
import { verifyAuthorityStateLineage } from "./verify-authority-state-lineage.js";
import type { AnswerCompositionFailureEventV1 } from "./person-answer-route.js";
import type { MeetingProcessingWorkerPhaseRunnerV1 } from "../processing/admitted-meeting-processing/meeting-processing-worker-lifecycle.js";
import type {
  StagingSyntheticMeetingCanaryInputV1,
  StagingSyntheticMeetingCanaryResultV1,
} from "../processing/admitted-meeting-processing/staging-synthetic-meeting-canary-v1.js";

export interface OrganizationAuthorityRuntimeConfig {
  readonly state_directory: string;
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly authority_url: string;
  readonly oidc: PersonSessionOidcConfiguration;
  readonly client_authentication: OrganizationAuthorityApiRuntimeConfig["client_authentication"];
  readonly pkce_key_file: string;
  /** Explicit provider/source bundle. This generic root does not select one. */
  readonly meeting_source_bundle: MeetingSourceBundleV1;
  /** Explicit decision-processor bundle. This generic root does not select one. */
  readonly decision_processor_bundle: DecisionProcessorBundleV1;
  /** Explicit approval/delivery bundle. This generic root does not select one. */
  readonly approval_workflow_bundle: ApprovalWorkflowBundleV1;
  /** Explicit answer-composition bundle. This generic root does not select one. */
  readonly answer_composition_generation_bundle: AnswerCompositionGenerationBundleV1;
  /** Exact durable record-resolution protocols admitted into append and retrieval. */
  readonly record_policy_fact_projectors: RecordPolicyFactProjectorRegistryV1;
  readonly worker_interval_ms?: number;
  /** Observational only: a failed cycle is retried by the serialized worker. */
  readonly on_worker_error?: (error: Error) => void;
  /** Observational only: bounded, content-free worker lifecycle events. */
  readonly on_worker_telemetry?: (
    event: import("../processing/admitted-meeting-processing/meeting-processing-worker-lifecycle.js").MeetingProcessingWorkerTelemetryEventV1,
  ) => void;
  /** Observational only: redacted answer-composition model-stage failures. */
  readonly on_answer_composition_failure?: (
    event: AnswerCompositionFailureEventV1,
  ) => void;
  /** Provider-selected staging runner; the neutral runtime only supplies admitted state. */
  readonly run_staging_synthetic_private_dm_canary?: (
    input: {
      readonly authority_url: string;
      readonly canary: StagingSyntheticMeetingCanaryInputV1;
      readonly state: SqliteAuthorityMeetingProcessingStateV1;
      readonly processor: DecisionProcessorAdapter;
      readonly stager: Awaited<ReturnType<ApprovalWorkflowBundleV1["load"]>>["stager"];
      readonly signal: AbortSignal;
    },
  ) => Promise<StagingSyntheticPrivateDmCanaryResultV1>;
}

export type StagingSyntheticPrivateDmCanaryResultV1 =
  StagingSyntheticMeetingCanaryResultV1;

export interface OpenedOrganizationAuthorityRuntime
  extends RunningOrganizationAuthorityServiceLifecycle {
  readonly processing: "idle_until_finalize" | "active";
  /**
   * A staging-guarded rehearsal hook. It exists only after source admission and
   * uses the same admitted processor and private approval stager as deployed
   * intake; it never touches the provider cursor.
   */
  readonly run_staging_synthetic_private_dm_canary?: (
    canary: StagingSyntheticMeetingCanaryInputV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<StagingSyntheticPrivateDmCanaryResultV1>;
}

type MeetingSourceAdapter = ConstructorParameters<
  typeof AdmittedMeetingProcessingCycleV1
>[0]["source"];
type DecisionProcessorAdapter = ConstructorParameters<
  typeof AdmittedMeetingProcessingCycleV1
>[0]["processor"];

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
 * callers leave this absent and retain the concrete provider adapters.
 */
export interface OrganizationAuthorityRuntimeDependencies {
  /** Passed straight to the Authority API runtime, for example a local OIDC fake. */
  readonly api?: OrganizationAuthorityApiRuntimeDependencies;
  /**
   * Replaces the active post-finalize worker only. It is ignored before source
   * admission, so stopped-state startup remains provider-free by default.
   */
  readonly active_processing?: OrganizationAuthorityProcessingCycleV1;
  /** Optional provider-free substitutes for the concrete active adapters. */
  readonly processing_adapter_overrides?: {
    readonly source?: MeetingSourceAdapter;
    readonly processor?: DecisionProcessorAdapter;
  };
}

class IdleOrganizationAuthorityProcessing
  implements OrganizationAuthorityProcessingCycleV1 {
  async recoverV4Appends(): Promise<void> {}
  async pollAndStageAdmittedMeetings(): Promise<void> {}
  async observeAndFinalizePendingApprovals(): Promise<void> {}
  async appendFinalizedApprovalsToV4(): Promise<void> {}
  async reconcileReadableSearchGeneration(): Promise<void> {}
}

interface ReadableSearchReconcilerV1 {
  reconcile(signal: AbortSignal): Promise<unknown>;
}

class OrganizationAuthorityProcessingCoordinator
  implements OrganizationAuthorityProcessingCycleV1 {
  readonly hasFineGrainedSourceLifecycle = true;
  constructor(
    private readonly source: AdmittedMeetingProcessingCycleV1,
    private readonly approvals: ApprovalWorkflowProcessingV1,
    private readonly readableSearch: ReadableSearchReconcilerV1,
  ) {}

  setWorkerLifecycle(lifecycle: MeetingProcessingWorkerPhaseRunnerV1): void {
    this.source.setWorkerLifecycle(lifecycle);
  }

  recoverV4Appends(signal: AbortSignal): Promise<void> {
    return this.approvals.recoverV4Appends(signal);
  }

  async pollAndStageAdmittedMeetings(signal: AbortSignal): Promise<void> {
    await this.source.runOnce(signal);
  }

  observeAndFinalizePendingApprovals(signal: AbortSignal): Promise<void> {
    return this.approvals.observeAndFinalizePendingApprovals(signal);
  }

  appendFinalizedApprovalsToV4(signal: AbortSignal): Promise<void> {
    return this.approvals.appendFinalizedApprovalsToV4(signal);
  }

  async reconcileReadableSearchGeneration(signal: AbortSignal): Promise<void> {
    await this.readableSearch.reconcile(signal);
  }
}

/**
 * Provider-neutral Organization Authority runtime composition. Before source
 * admission, it exposes API routes and does no background work. An explicit source bundle supplies
 * the admitted source only after finalization; all remaining construction is
 * shared by every meeting provider.
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
  const authority = openAuthorityDatabase(
    join(config.state_directory, "authority.sqlite"),
    { fileMustExist: true },
  );
  const sourceIsAdmitted =
    authority
      .prepare(
        `SELECT 1
           FROM authority_live_source_admission_v2
          WHERE singleton = 1`,
      )
      .get() !== undefined;
  if (!sourceIsAdmitted) {
    authority.close();
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api, worker_interval_ms: config.worker_interval_ms },
      {
        processing: new IdleOrganizationAuthorityProcessing(),
        api: dependencies.api,
        on_worker_error: config.on_worker_error,
        on_worker_telemetry: config.on_worker_telemetry,
      },
    );
    return { ...runtime, processing: "idle_until_finalize" };
  }
  if (dependencies.active_processing !== undefined) {
    authority.close();
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api, worker_interval_ms: config.worker_interval_ms },
      {
        processing: dependencies.active_processing,
        api: dependencies.api,
        on_worker_error: config.on_worker_error,
        on_worker_telemetry: config.on_worker_telemetry,
      },
    );
    return { ...runtime, processing: "active" };
  }
  const control = openOrganizationControlDatabase(
    join(config.state_directory, "integrations.sqlite"),
    { fileMustExist: true },
  );
  const record = openOrganizationRecordDatabase(
    join(config.state_directory, "record-log.sqlite"),
    { fileMustExist: true },
  );
  try {
    const sourceState = new SqliteAuthorityMeetingProcessingStateV1(
      authority,
      config.meeting_source_bundle.source_cursor_policy,
      config.decision_processor_bundle.processor_adapter_id,
    );
    const commitments = readAdmittedMeetingProcessingCommitmentsV1(authority);
    config.meeting_source_bundle.assert_admission_commitments(commitments);
    config.decision_processor_bundle.assert_admission_commitments(commitments);
    const admission = await sourceState.readAdmission();
    const source =
      dependencies.processing_adapter_overrides?.source ??
      config.meeting_source_bundle.create_source(admission);
    const processor =
      dependencies.processing_adapter_overrides?.processor ??
      config.decision_processor_bundle.create_processor(admission);
    if (
      source.identity.adapter_id !== admission.source.adapter_id ||
      source.identity.instance_id !== admission.source.instance_id ||
      source.identity.version !== admission.source.version ||
      processor.identity.adapter_id !== admission.processor.adapter_id ||
      processor.identity.instance_id !== admission.processor.instance_id ||
      processor.identity.version !== admission.processor.version
    ) {
      throw new Error(
        "processing adapters differ from their admitted configurations",
      );
    }
    const coordinates = Object.freeze({
      authority_id: lineage.root.authority_id,
      organization_id: lineage.root.organization_id,
      state_lineage_id: lineage.root.state_lineage_id,
    });
    const signer = FileOrganizationAuthoritySigner.openExisting({
      directory: join(config.state_directory, "keys"),
      authority_id: lineage.root.authority_id,
      organization_id: lineage.root.organization_id,
    });
    const approvalContext = {
      state: sourceState,
      authority_database: authority,
      control_plane_database: control,
      record_append: new OrganizationRecordAppenderV4(
        record,
        {
          ...coordinates,
        },
        config.record_policy_fact_projectors,
      ),
      signer,
      coordinates,
      next_envelope_id: () => `env_${randomUUID()}`,
    };
    await config.approval_workflow_bundle.assert_existing_presentations_owned(
      approvalContext,
    );
    const approvals = await config.approval_workflow_bundle.load(approvalContext);
    const sourceCycle = new AdmittedMeetingProcessingCycleV1({
      source,
      processor,
      state: sourceState,
      stager: approvals.stager,
      source_cursor_policy: config.meeting_source_bundle.source_cursor_policy,
    });
    // Bind once: answer composition and rebuild-time projection must use the
    // same non-secret adapter/model selection for this running Authority.
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
      related_atom_projector: relatedAtomProjector,
    });
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api, worker_interval_ms: config.worker_interval_ms },
      {
        processing: new OrganizationAuthorityProcessingCoordinator(
          sourceCycle,
          approvals.processing,
          readableSearch,
        ),
        api: {
          ...dependencies.api,
          answer_composition_generation: answerGeneration,
          readable_search_retrieval_contract_sha256:
            readableSearchContract.retrieval_contract_sha256,
          ...(dependencies.api?.answer_failure !== undefined
            ? { answer_failure: dependencies.api.answer_failure }
            : config.on_answer_composition_failure === undefined
              ? {}
              : { answer_failure: config.on_answer_composition_failure }),
          ...(dependencies.api?.private_approval_interaction_ingress !==
          undefined
            ? {}
            : approvals.interaction_ingress === undefined
              ? {}
              : {
                  private_approval_interaction_ingress:
                    approvals.interaction_ingress,
                }),
        },
        on_worker_error: config.on_worker_error,
        on_worker_telemetry: config.on_worker_telemetry,
      },
    );
    return {
      address: runtime.address,
      processing: "active",
      runExclusive: (operation) => runtime.runExclusive(operation),
      ...(config.run_staging_synthetic_private_dm_canary === undefined
        ? {}
        : {
            run_staging_synthetic_private_dm_canary: (canary, options) =>
              runtime.runExclusive((signal) =>
                config.run_staging_synthetic_private_dm_canary!({
                  authority_url: config.authority_url,
                  canary,
                  state: sourceState,
                  processor,
                  stager: approvals.stager,
                  signal:
                    options?.signal === undefined
                      ? signal
                      : AbortSignal.any([signal, options.signal]),
                }),
              ),
          }),
      close: async () => {
        await runtime.close();
        record.close();
        control.close();
        authority.close();
      },
    };
  } catch (error) {
    record.close();
    control.close();
    authority.close();
    throw error;
  }
}
