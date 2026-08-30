import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  openOrganizationControlDatabase,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import {
  type ApprovedRecordPolicyProjectorRegistryV1,
  OrganizationRecordV4AppendApplication,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/new-lineage-v1";
import {
  readPrivateAuthorityPersonSessionPkceKey,
} from "../adapters/security/private-file-credentials.js";
import { DevelopmentFileOrganizationAuthoritySigner } from "../adapters/security/development-file-authority-signer.js";
import { openAuthorityDatabase } from "../adapters/persistence/sqlite/open-unmigrated-database.js";
import type { PersonSessionOidcConfiguration } from "../application/ports/person-session-runtime.js";
import { CleanLiveOnlySourceCycleV1 } from "../processing/clean-v1/live-only-source-cycle.js";
import type { CleanLiveSourceAdmissionV1 } from "../processing/clean-v1/live-only-source-cycle.js";
import type { CleanLiveSourceBoundaryV1 } from "../processing/clean-v1/live-source-boundary.js";
import {
  readCleanLiveSourceRuntimeCommitmentsV1,
  type CleanLiveSourceRuntimeCommitmentsV1,
} from "../processing/clean-v1/live-source-runtime-commitments.js";
import { SqliteCleanLiveOnlySourceStateV1 } from "../processing/clean-v1/sqlite-live-only-source-state.js";
import type {
  CleanApprovalProcessingV1,
  CleanApprovalRuntimeBundleV1,
} from "./approval-runtime-bundle-v1.js";
import type { CleanLayer4RuntimeBundleV1 } from "./clean-layer4-runtime.js";
import type { CleanLiveProcessorRuntimeBundleV1 } from "./clean-live-processor-runtime.js";
import {
  startCleanLiveRuntime,
  type CleanLiveProcessingCycleV1,
  type RunningCleanLiveRuntime,
} from "./clean-live-runtime.js";
import { createCleanReadableSearchGenerationReconcilerV1 } from "./clean-readable-search-runtime.js";
import type { CleanPersonRuntimeConfig } from "./clean-person-runtime.js";
import type { CleanPersonRuntimeDependencies } from "./clean-person-runtime.js";
import { verifyCleanStateLineage } from "./verify-clean-state-lineage.js";
import type { CleanLayer4FailureEventV1 } from "./clean-person-answer-route.js";
import type { CleanLiveWorkerPhaseRunnerV1 } from "../processing/clean-v1/clean-live-worker-lifecycle.js";
import {
  stageStagingSyntheticPrivateDmCanaryV1,
  type StageStagingSyntheticPrivateDmCanaryV1Result,
} from "./staging-synthetic-private-dm-canary-v1.js";
import type { StagingSyntheticMeetingCanaryInputV1 } from "../processing/clean-v1/staging-synthetic-meeting-canary-v1.js";

export interface OpenCleanLiveRuntimeConfig {
  readonly state_directory: string;
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly authority_url: string;
  readonly oidc: PersonSessionOidcConfiguration;
  readonly client_authentication: CleanPersonRuntimeConfig["client_authentication"];
  readonly pkce_key_file: string;
  /** Explicit provider/source bundle. This generic root does not select one. */
  readonly source_runtime: CleanLiveSourceRuntimeBundleV1;
  /** Explicit decision-processor bundle. This generic root does not select one. */
  readonly processor_runtime: CleanLiveProcessorRuntimeBundleV1;
  /** Explicit approval/delivery bundle. This generic root does not select one. */
  readonly approval_runtime: CleanApprovalRuntimeBundleV1;
  /** Explicit answer-generation bundle. This generic root does not select one. */
  readonly layer4_runtime: CleanLayer4RuntimeBundleV1;
  /** Exact durable approval protocols admitted into append and Layer 1. */
  readonly approved_record_policy_projectors: ApprovedRecordPolicyProjectorRegistryV1;
  readonly worker_interval_ms?: number;
  /** Observational only: a failed cycle is retried by the serialized worker. */
  readonly on_worker_error?: (error: Error) => void;
  /** Observational only: bounded, content-free worker lifecycle events. */
  readonly on_worker_telemetry?: (
    event: import("../processing/clean-v1/clean-live-worker-lifecycle.js").CleanLiveWorkerTelemetryEventV1,
  ) => void;
  /** Observational only: redacted Layer 4 model-stage failures. */
  readonly on_layer4_failure?: (event: CleanLayer4FailureEventV1) => void;
}

export interface OpenedCleanLiveRuntime extends RunningCleanLiveRuntime {
  readonly processing: "idle_until_finalize" | "active";
  /**
   * A staging-guarded rehearsal hook. It exists only after live admission and
   * uses the same admitted processor and private approval stager as production
   * intake; it never touches the provider cursor.
   */
  readonly stage_staging_synthetic_private_dm_canary?: (
    canary: StagingSyntheticMeetingCanaryInputV1,
  ) => Promise<StageStagingSyntheticPrivateDmCanaryV1Result>;
}

type CleanLiveSourceAdapter = ConstructorParameters<
  typeof CleanLiveOnlySourceCycleV1
>[0]["source"];
type CleanLiveProcessorAdapter = ConstructorParameters<
  typeof CleanLiveOnlySourceCycleV1
>[0]["processor"];
/**
 * All provider-specific live-source facts are constructed outside this
 * runtime. The stable core only knows the admitted source contract.
 */
export interface CleanLiveSourceRuntimeBundleV1 {
  /** Creates the one source adapter for the admitted source identity. */
  create_source(admission: CleanLiveSourceAdmissionV1): CleanLiveSourceAdapter;
  /**
   * Proves this provider's current local source configuration still matches
   * its immutable admission before the provider credential is read.
   */
  assert_runtime_commitments(
    commitments: CleanLiveSourceRuntimeCommitmentsV1,
  ): void;
  /** Owns provider cursor and metadata validation. */
  readonly source_boundary: CleanLiveSourceBoundaryV1;
}

/**
 * Narrow composition seams for deterministic local rehearsals. Production
 * callers leave this absent and retain the concrete provider adapters.
 */
export interface OpenCleanLiveRuntimeDependencies {
  /** Passed straight to the Person runtime, for example a local OIDC fake. */
  readonly person?: CleanPersonRuntimeDependencies;
  /**
   * Replaces the active post-finalize worker only. It is ignored before source
   * admission, so stopped-state startup remains provider-free by default.
   */
  readonly active_processing?: CleanLiveProcessingCycleV1;
  /** Optional provider-free substitutes for the concrete active adapters. */
  readonly live_adapters?: {
    readonly source?: CleanLiveSourceAdapter;
    readonly processor?: CleanLiveProcessorAdapter;
  };
}

class IdleCleanLiveProcessing implements CleanLiveProcessingCycleV1 {
  async recoverV4Appends(): Promise<void> {}
  async pollAndStageLiveOnlySource(): Promise<void> {}
  async observeAndFinalizePendingApprovals(): Promise<void> {}
  async appendFinalizedApprovalsToV4(): Promise<void> {}
  async reconcileReadableSearchGeneration(): Promise<void> {}
}

interface CleanReadableSearchReconcilerV1 {
  reconcile(signal: AbortSignal): Promise<unknown>;
}

class CombinedCleanLiveProcessing implements CleanLiveProcessingCycleV1 {
  readonly hasFineGrainedSourceLifecycle = true;
  constructor(
    private readonly source: CleanLiveOnlySourceCycleV1,
    private readonly approvals: CleanApprovalProcessingV1,
    private readonly readableSearch: CleanReadableSearchReconcilerV1,
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
 * The provider-neutral server composition. Before stopped-state finalize, it
 * exposes Person routes and does no work. An explicit source bundle supplies
 * the admitted source only after finalization; all remaining construction is
 * shared by every meeting provider.
 */
export async function openCleanLiveRuntime(
  config: OpenCleanLiveRuntimeConfig,
  dependencies: OpenCleanLiveRuntimeDependencies = {},
): Promise<OpenedCleanLiveRuntime> {
  const lineage = verifyCleanStateLineage(config.state_directory);
  const person: CleanPersonRuntimeConfig = {
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
    const runtime = await startCleanLiveRuntime(
      { person, worker_interval_ms: config.worker_interval_ms },
      {
        processing: new IdleCleanLiveProcessing(),
        person: dependencies.person,
        on_worker_error: config.on_worker_error,
        on_worker_telemetry: config.on_worker_telemetry,
      },
    );
    return { ...runtime, processing: "idle_until_finalize" };
  }
  if (dependencies.active_processing !== undefined) {
    authority.close();
    const runtime = await startCleanLiveRuntime(
      { person, worker_interval_ms: config.worker_interval_ms },
      {
        processing: dependencies.active_processing,
        person: dependencies.person,
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
    const sourceState = new SqliteCleanLiveOnlySourceStateV1(
      authority,
      config.source_runtime.source_boundary,
      config.processor_runtime.processor_adapter_id,
    );
    const commitments = readCleanLiveSourceRuntimeCommitmentsV1(authority);
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
    const signer = DevelopmentFileOrganizationAuthoritySigner.openExisting({
      directory: join(config.state_directory, "keys"),
      authority_id: lineage.root.authority_id,
      organization_id: lineage.root.organization_id,
    });
    const approvalContext = {
      state: sourceState,
      authority_database: authority,
      control_plane_database: control,
      record_append: new OrganizationRecordV4AppendApplication(record, {
        ...coordinates,
      }, config.approved_record_policy_projectors),
      signer,
      coordinates,
      next_envelope_id: () => `env_${randomUUID()}`,
    };
    await config.approval_runtime.assert_existing_presentations_owned(
      approvalContext,
    );
    const approvals = await config.approval_runtime.open(approvalContext);
    const sourceCycle = new CleanLiveOnlySourceCycleV1({
      source,
      processor,
      state: sourceState,
      stager: approvals.stager,
      source_boundary: config.source_runtime.source_boundary,
    });
    const readableSearch = createCleanReadableSearchGenerationReconcilerV1({
      state_directory: config.state_directory,
      root: lineage.root,
      authority,
      record,
      signer,
      policy_projectors: config.approved_record_policy_projectors,
    });
    const runtime = await startCleanLiveRuntime(
      { person, worker_interval_ms: config.worker_interval_ms },
      {
        processing: new CombinedCleanLiveProcessing(
          sourceCycle,
          approvals.processing,
          readableSearch,
        ),
        person: {
          ...dependencies.person,
          layer4_runtime:
            dependencies.person?.layer4_runtime ?? config.layer4_runtime.open(),
          ...(dependencies.person?.answer_failure !== undefined
            ? { answer_failure: dependencies.person.answer_failure }
            : config.on_layer4_failure === undefined
              ? {}
              : { answer_failure: config.on_layer4_failure }),
          ...(dependencies.person?.private_approval_interaction_ingress !==
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
      stage_staging_synthetic_private_dm_canary: (canary) =>
        runtime.runExclusive((signal) =>
          stageStagingSyntheticPrivateDmCanaryV1({
            authority_url: config.authority_url,
            canary,
            state: sourceState,
            processor,
            stager: approvals.stager,
            signal,
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
