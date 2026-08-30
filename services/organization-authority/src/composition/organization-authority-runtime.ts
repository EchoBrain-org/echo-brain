import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openOrganizationControlDatabase } from "@echo-brain/organization-control-plane/clean-runtime-v1";
import {
  type RecordPolicyFactProjectorRegistryV1,
  OrganizationRecordAppenderV4,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/new-lineage-v1";
import { readPrivateAuthorityPersonSessionPkceKey } from "../adapters/security/private-file-credentials.js";
import { FileOrganizationAuthoritySigner } from "../adapters/security/file-organization-authority-signer.js";
import { openAuthorityDatabase } from "../adapters/persistence/sqlite/open-unmigrated-database.js";
import type { PersonSessionOidcConfiguration } from "../application/ports/person-session-runtime.js";
import { AdmittedMeetingProcessingCycleV1 } from "../processing/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import type { AdmittedMeetingProcessingAdmissionV1 } from "../processing/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import type { AdmittedMeetingSourceBoundaryV1 } from "../processing/admitted-meeting-processing/admitted-meeting-source-boundary-v1.js";
import {
  readAdmittedMeetingSourceRuntimeCommitmentsV1,
  type AdmittedMeetingSourceRuntimeCommitmentsV1,
} from "../processing/clean-v1/live-source-runtime-commitments.js";
import { SqliteAuthorityMeetingProcessingStateV1 } from "../processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.js";
import type {
  ApprovalWorkflowProcessingV1,
  ApprovalWorkflowRuntimeBundleV1,
} from "./approval-runtime-bundle-v1.js";
import type { AnswerCompositionRuntimeBundleV1 } from "./answer-composition-runtime.js";
import type { DecisionProcessorRuntimeBundleV1 } from "./decision-processor-runtime-bundle-v1.js";
import {
  startOrganizationAuthorityServiceLifecycle,
  type OrganizationAuthorityProcessingCycleV1,
  type RunningOrganizationAuthorityServiceLifecycle,
} from "./organization-authority-service-lifecycle.js";
import { createReadableSearchGenerationReconcilerV1 } from "./readable-search-runtime.js";
import type { OrganizationAuthorityApiRuntimeConfig } from "./organization-authority-api-runtime.js";
import type { OrganizationAuthorityApiRuntimeDependencies } from "./organization-authority-api-runtime.js";
import { verifyCleanStateLineage } from "./verify-clean-state-lineage.js";
import type { AnswerCompositionFailureEventV1 } from "./person-answer-route.js";
import type { CleanLiveWorkerPhaseRunnerV1 } from "../processing/clean-v1/clean-live-worker-lifecycle.js";
import {
  runStagingSyntheticPrivateDmCanaryV1,
  type StagingSyntheticPrivateDmCanaryResultV1,
} from "./staging-synthetic-private-dm-canary-v1.js";
import type { StagingSyntheticMeetingCanaryInputV1 } from "../processing/clean-v1/staging-synthetic-meeting-canary-v1.js";

export interface OrganizationAuthorityRuntimeConfig {
  readonly state_directory: string;
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly authority_url: string;
  readonly oidc: PersonSessionOidcConfiguration;
  readonly client_authentication: OrganizationAuthorityApiRuntimeConfig["client_authentication"];
  readonly pkce_key_file: string;
  /** Explicit provider/source bundle. This generic root does not select one. */
  readonly source_runtime: MeetingSourceRuntimeBundleV1;
  /** Explicit decision-processor bundle. This generic root does not select one. */
  readonly processor_runtime: DecisionProcessorRuntimeBundleV1;
  /** Explicit approval/delivery bundle. This generic root does not select one. */
  readonly approval_runtime: ApprovalWorkflowRuntimeBundleV1;
  /** Explicit answer-composition bundle. This generic root does not select one. */
  readonly answer_composition_runtime: AnswerCompositionRuntimeBundleV1;
  /** Exact durable record-resolution protocols admitted into append and retrieval. */
  readonly record_policy_fact_projectors: RecordPolicyFactProjectorRegistryV1;
  readonly worker_interval_ms?: number;
  /** Observational only: a failed cycle is retried by the serialized worker. */
  readonly on_worker_error?: (error: Error) => void;
  /** Observational only: bounded, content-free worker lifecycle events. */
  readonly on_worker_telemetry?: (
    event: import("../processing/clean-v1/clean-live-worker-lifecycle.js").CleanLiveWorkerTelemetryEventV1,
  ) => void;
  /** Observational only: redacted Layer 4 model-stage failures. */
  readonly on_answer_composition_failure?: (
    event: AnswerCompositionFailureEventV1,
  ) => void;
}

export interface OpenedOrganizationAuthorityRuntime
  extends RunningOrganizationAuthorityServiceLifecycle {
  readonly processing: "idle_until_finalize" | "active";
  /**
   * A staging-guarded rehearsal hook. It exists only after live admission and
   * uses the same admitted processor and private approval stager as production
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
/**
 * All provider-specific live-source facts are constructed outside this
 * runtime. The stable core only knows the admitted source contract.
 */
export interface MeetingSourceRuntimeBundleV1 {
  /** Creates the one source adapter for the admitted source identity. */
  create_source(admission: AdmittedMeetingProcessingAdmissionV1): MeetingSourceAdapter;
  /**
   * Proves this provider's current local source configuration still matches
   * its immutable admission before the provider credential is read.
   */
  assert_runtime_commitments(
    commitments: AdmittedMeetingSourceRuntimeCommitmentsV1,
  ): void;
  /** Owns provider cursor and metadata validation. */
  readonly source_boundary: AdmittedMeetingSourceBoundaryV1;
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
  readonly live_adapters?: {
    readonly source?: MeetingSourceAdapter;
    readonly processor?: DecisionProcessorAdapter;
  };
}

class IdleOrganizationAuthorityProcessing
  implements OrganizationAuthorityProcessingCycleV1 {
  async recoverV4Appends(): Promise<void> {}
  async pollAndStageLiveOnlySource(): Promise<void> {}
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

  setWorkerLifecycle(lifecycle: CleanLiveWorkerPhaseRunnerV1): void {
    this.source.setWorkerLifecycle(lifecycle);
  }

  recoverV4Appends(signal: AbortSignal): Promise<void> {
    return this.approvals.recoverV4Appends(signal);
  }

  async pollAndStageLiveOnlySource(signal: AbortSignal): Promise<void> {
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
  const lineage = verifyCleanStateLineage(config.state_directory);
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
      config.source_runtime.source_boundary,
      config.processor_runtime.processor_adapter_id,
    );
    const commitments = readAdmittedMeetingSourceRuntimeCommitmentsV1(authority);
    config.source_runtime.assert_runtime_commitments(commitments);
    config.processor_runtime.assert_runtime_commitments(commitments);
    const admission = await sourceState.readAdmission();
    const source =
      dependencies.live_adapters?.source ??
      config.source_runtime.create_source(admission);
    const processor =
      dependencies.live_adapters?.processor ??
      config.processor_runtime.create_processor(admission);
    if (
      source.identity.adapter_id !== admission.source.adapter_id ||
      source.identity.instance_id !== admission.source.instance_id ||
      source.identity.version !== admission.source.version ||
      processor.identity.adapter_id !== admission.processor.adapter_id ||
      processor.identity.instance_id !== admission.processor.instance_id ||
      processor.identity.version !== admission.processor.version
    ) {
      throw new Error(
        "clean live adapters differ from their admitted configurations",
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
    await config.approval_runtime.assert_existing_presentations_owned(
      approvalContext,
    );
    const approvals = await config.approval_runtime.open(approvalContext);
    const sourceCycle = new AdmittedMeetingProcessingCycleV1({
      source,
      processor,
      state: sourceState,
      stager: approvals.stager,
      source_boundary: config.source_runtime.source_boundary,
    });
    const readableSearch = createReadableSearchGenerationReconcilerV1({
      state_directory: config.state_directory,
      root: lineage.root,
      authority,
      record,
      signer,
      policy_projectors: config.record_policy_fact_projectors,
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
          answer_composition_runtime:
            dependencies.api?.answer_composition_runtime ??
            config.answer_composition_runtime.open(),
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
      run_staging_synthetic_private_dm_canary: (canary, options) =>
        runtime.runExclusive((signal) =>
          runStagingSyntheticPrivateDmCanaryV1({
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
