import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  FileOrganizationSecretStore,
  SqliteCleanSlackApprovalTokenReaderV1,
  SqlitePrivateApprovalPersistenceV1,
  openOrganizationControlDatabase,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import {
  OrganizationRecordV4AppendApplication,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/new-lineage-v1";
import {
  readPrivateAuthorityCredential,
  readPrivateAuthorityPersonSessionPkceKey,
  readPrivateAuthoritySlackSigningSecret,
} from "../adapters/security/private-file-credentials.js";
import { DevelopmentFileOrganizationAuthoritySigner } from "../adapters/security/development-file-authority-signer.js";
import { openAuthorityDatabase } from "../adapters/persistence/sqlite/open-unmigrated-database.js";
import type { PersonSessionOidcConfiguration } from "../application/ports/person-session-runtime.js";
import {
  createLlmDecisionProcessor,
  llmProcessingVersion,
} from "../processing/adapters/decision-processors/llm/llm-decision-processor.js";
import type { AdapterConfig } from "../processing/core/contracts/adapter.js";
import { CleanLiveOnlySourceCycleV1 } from "../processing/clean-v1/live-only-source-cycle.js";
import type { CleanLiveSourceAdmissionV1 } from "../processing/clean-v1/live-only-source-cycle.js";
import type { CleanLiveSourceBoundaryV1 } from "../processing/clean-v1/live-source-boundary.js";
import {
  readCleanLiveSourceRuntimeCommitmentsV1,
  type CleanLiveSourceRuntimeCommitmentsV1,
} from "../processing/clean-v1/live-source-runtime-commitments.js";
import { SqliteCleanLiveOnlySourceStateV1 } from "../processing/clean-v1/sqlite-live-only-source-state.js";
import { PrivateSlackApprovalCardPosterV1 } from "../processing/clean-v1/private-slack-approval-card-poster-v1.js";
import { createPrivateSlackBlockV4RecordWriterV1 } from "../processing/clean-v1-record/private-slack-block-v4-record-writer-v1.js";
import {
  assertCleanLlmProcessorRuntimeCommitmentsV1,
  fixedCleanLlmProcessorConfigV1,
} from "./clean-live-llm-processor-config.js";
import {
  startCleanLiveRuntime,
  type CleanLiveProcessingCycleV1,
  type RunningCleanLiveRuntime,
} from "./clean-live-runtime.js";
import { createCleanReadableSearchGenerationReconcilerV1 } from "./clean-readable-search-runtime.js";
import type { CleanPersonRuntimeConfig } from "./clean-person-runtime.js";
import type { CleanPersonRuntimeDependencies } from "./clean-person-runtime.js";
import { verifyCleanStateLineage } from "./verify-clean-state-lineage.js";
import { createOpenRouterStructuredOutput } from "../answer-composition/openrouter-structured-output.js";
import type { CleanLayer4FailureEventV1 } from "./clean-person-answer-route.js";
import type { CleanLiveWorkerPhaseRunnerV1 } from "../processing/clean-v1/clean-live-worker-lifecycle.js";
import { resolveCurrentPrivateSlackConnectionV1 } from "./resolve-current-private-slack-connection-v1.js";
import { SqlitePrivateApprovalAssignmentStateV1 } from "./sqlite-private-approval-assignment-state-v1.js";
import { SqliteStablePrivateApprovalAuthorityFenceV1 } from "./sqlite-stable-private-approval-authority-fence-v1.js";
import { PrivateOwnerDmApprovalStagerV1 } from "./private-owner-dm-approval-stager-v1.js";
import { PrivateApprovalProcessingCoordinatorV1 } from "./private-approval-processing-coordinator-v1.js";
import { SqlitePrivateApprovalProcessingAuthorityV1 } from "./sqlite-private-approval-processing-authority-v1.js";
import { createPrivateApprovalSlackInteractionsApplicationV1 } from "./private-approval-slack-interactions-application-v1.js";
import type { PrivateApprovalSlackInteractionRejectionStageV1 } from "./private-approval-slack-interaction-v1.js";
import { resolveCanonicalMeetingOwnerPrivateApprovalTargetV1 } from "./resolve-canonical-meeting-owner-private-approval-target-v1.js";

export interface OpenCleanLiveRuntimeConfig {
  readonly state_directory: string;
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly authority_url: string;
  readonly oidc: PersonSessionOidcConfiguration;
  readonly client_authentication: CleanPersonRuntimeConfig["client_authentication"];
  readonly pkce_key_file: string;
  /** Path only. The signing secret is not read until private ingress is wired. */
  readonly slack_signing_secret_file: string;
  /** Exact founder-manifest connection; approval delivery never selects an arbitrary active tool. */
  readonly slack_connection_id: string;
  /** Retained only for the current Person-to-Slack identity-link challenge. */
  readonly slack_approval_channel_id: string;
  /** Explicit provider/source bundle. This generic root does not select one. */
  readonly source_runtime: CleanLiveSourceRuntimeBundleV1;
  readonly llm_credential_file: string;
  readonly worker_interval_ms?: number;
  /** Observational only: a failed cycle is retried by the serialized worker. */
  readonly on_worker_error?: (error: Error) => void;
  /** Observational only: bounded, content-free worker lifecycle events. */
  readonly on_worker_telemetry?: (
    event: import("../processing/clean-v1/clean-live-worker-lifecycle.js").CleanLiveWorkerTelemetryEventV1,
  ) => void;
  /** Observational only: redacted Layer 4 model-stage failures. */
  readonly on_layer4_failure?: (event: CleanLayer4FailureEventV1) => void;
  /** Observational only: parser stage after an HMAC-verified Slack rejection. */
  readonly on_private_approval_slack_rejection?: (event: {
    readonly stage: PrivateApprovalSlackInteractionRejectionStageV1;
  }) => void;
}

export interface OpenedCleanLiveRuntime extends RunningCleanLiveRuntime {
  readonly processing: "idle_until_finalize" | "active";
}

type CleanLiveSourceAdapter = ConstructorParameters<
  typeof CleanLiveOnlySourceCycleV1
>[0]["source"];
type CleanLiveProcessorAdapter = ConstructorParameters<
  typeof CleanLiveOnlySourceCycleV1
>[0]["processor"];
type PrivateApprovalCardPoster = Pick<
  PrivateSlackApprovalCardPosterV1,
  | "openDirectMessage"
  | "postMarker"
  | "reconcileMarker"
  | "publish"
  | "tombstone"
  | "renderTerminal"
>;

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
    /** Full private-DM presentation seam for local rehearsals. */
    readonly private_approval_card_poster?: PrivateApprovalCardPoster;
  };
}

function assertAdapter(
  name: string,
  adapter: {
    validateConfig(config: AdapterConfig): {
      ok: boolean;
      errors: readonly string[];
    };
  },
  config: AdapterConfig,
): void {
  const validation = adapter.validateConfig(config);
  if (!validation.ok) {
    throw new Error(
      `${name} clean runtime configuration is invalid: ${validation.errors.join("; ")}`,
    );
  }
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

class CombinedCleanLiveProcessing<
  TApprovalProcessing extends Pick<
    CleanLiveProcessingCycleV1,
    | "recoverV4Appends"
    | "observeAndFinalizePendingApprovals"
    | "appendFinalizedApprovalsToV4"
  >,
> implements CleanLiveProcessingCycleV1 {
  readonly hasFineGrainedSourceLifecycle = true;
  constructor(
    private readonly source: CleanLiveOnlySourceCycleV1,
    private readonly approvals: TApprovalProcessing,
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
    slack_link: { approval_channel_id: config.slack_approval_channel_id },
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
    );
    const commitments = readCleanLiveSourceRuntimeCommitmentsV1(authority);
    config.source_runtime.assert_runtime_commitments(commitments);
    const llmReference = `file:${config.llm_credential_file}`;
    assertCleanLlmProcessorRuntimeCommitmentsV1({
      configuration_sha256: commitments.processor.configuration_sha256,
      credential_reference_sha256:
        commitments.processor.credential_reference_sha256,
      credential_reference: llmReference,
    });
    const admission = await sourceState.readAdmission();
    const llmCredential =
      dependencies.live_adapters?.processor === undefined ||
      dependencies.person?.answer_model === undefined
        ? readPrivateAuthorityCredential(llmReference)
        : undefined;
    const source =
      dependencies.live_adapters?.source ??
      config.source_runtime.create_source(admission);
    const processor =
      dependencies.live_adapters?.processor ??
      (() => {
        const processorConfig = fixedCleanLlmProcessorConfigV1(
          admission.processor.instance_id,
          llmReference,
        );
        const created = createLlmDecisionProcessor(processorConfig, {
          credentialResolver: (reference) =>
            reference === llmReference ? llmCredential : undefined,
        });
        assertAdapter("OpenRouter", created, processorConfig);
        return created;
      })();
    if (
      source.identity.adapter_id !== admission.source.adapter_id ||
      source.identity.instance_id !== admission.source.instance_id ||
      source.identity.version !== admission.source.version ||
      processor.identity.adapter_id !== admission.processor.adapter_id ||
      processor.identity.instance_id !== admission.processor.instance_id ||
      processor.identity.version !== admission.processor.version ||
      (dependencies.live_adapters?.processor === undefined &&
        llmProcessingVersion(
          fixedCleanLlmProcessorConfigV1(
            admission.processor.instance_id,
            llmReference,
          ),
        ) !== admission.processor.version)
    ) {
      throw new Error(
        "clean live adapters differ from the admitted fixed source configuration",
      );
    }
    const coordinates = Object.freeze({
      authority_id: lineage.root.authority_id,
      organization_id: lineage.root.organization_id,
      state_lineage_id: lineage.root.state_lineage_id,
    });
    const slack = resolveCurrentPrivateSlackConnectionV1(
      control,
      config.slack_connection_id,
      coordinates,
    );
    const tokenReader =
      dependencies.live_adapters?.private_approval_card_poster === undefined
        ? new SqliteCleanSlackApprovalTokenReaderV1(
            control,
            new FileOrganizationSecretStore(
              join(config.state_directory, "secrets"),
            ),
          )
        : undefined;
    const privateApprovalCardPoster =
      dependencies.live_adapters?.private_approval_card_poster ??
      new PrivateSlackApprovalCardPosterV1(
        tokenReader!.readApprovalToken({
          connection_id: slack.connection_id,
          connection_state_sha256: slack.connection_state_sha256,
        }),
      );
    const assignments = new SqlitePrivateApprovalAssignmentStateV1(authority);
    const controlPlane = new SqlitePrivateApprovalPersistenceV1({
      database: control,
      authority_fence: new SqliteStablePrivateApprovalAuthorityFenceV1(
        authority,
      ),
      now: () => new Date().toISOString(),
    });
    const stager = new PrivateOwnerDmApprovalStagerV1({
      authority: sourceState,
      authority_database: authority,
      control_plane_database: control,
      coordinates,
      connection_id: slack.connection_id,
      assignments,
      control_plane: controlPlane,
      poster: privateApprovalCardPoster,
      resolve_target: resolveCanonicalMeetingOwnerPrivateApprovalTargetV1,
    });
    const sourceCycle = new CleanLiveOnlySourceCycleV1({
      source,
      processor,
      state: sourceState,
      stager,
      source_boundary: config.source_runtime.source_boundary,
    });
    const signer = DevelopmentFileOrganizationAuthoritySigner.openExisting({
      directory: join(config.state_directory, "keys"),
      authority_id: lineage.root.authority_id,
      organization_id: lineage.root.organization_id,
    });
    const recordWriter = await createPrivateSlackBlockV4RecordWriterV1({
      append: new OrganizationRecordV4AppendApplication(record, {
        ...coordinates,
      }),
      signer,
      state_lineage_id: lineage.root.state_lineage_id,
      next_envelope_id: () => `env_${randomUUID()}`,
    });
    const approvals = new PrivateApprovalProcessingCoordinatorV1({
      control_plane: controlPlane,
      authority: new SqlitePrivateApprovalProcessingAuthorityV1({
        source: sourceState,
        assignments,
        coordinates,
      }),
      record_writer: recordWriter,
      poster: privateApprovalCardPoster,
    });
    const privateSlackInteractions =
      createPrivateApprovalSlackInteractionsApplicationV1({
        signing_secret: readPrivateAuthoritySlackSigningSecret(
          `file:${config.slack_signing_secret_file}`,
        ),
        persistence: controlPlane,
        on_rejection: config.on_private_approval_slack_rejection,
      });
    const readableSearch = createCleanReadableSearchGenerationReconcilerV1({
      state_directory: config.state_directory,
      root: lineage.root,
      authority,
      record,
      signer,
    });
    const runtime = await startCleanLiveRuntime(
      { person, worker_interval_ms: config.worker_interval_ms },
      {
        processing: new CombinedCleanLiveProcessing(
          sourceCycle,
          approvals,
          readableSearch,
        ),
        person: {
          ...dependencies.person,
          answer_model:
            dependencies.person?.answer_model ??
            createOpenRouterStructuredOutput({
              credential_ref: llmReference,
              credential_resolver: (reference) =>
                reference === llmReference ? llmCredential : undefined,
            }),
          ...(dependencies.person?.answer_failure !== undefined
            ? { answer_failure: dependencies.person.answer_failure }
            : config.on_layer4_failure === undefined
              ? {}
              : { answer_failure: config.on_layer4_failure }),
          private_slack_approval_interactions: privateSlackInteractions,
        },
        on_worker_error: config.on_worker_error,
        on_worker_telemetry: config.on_worker_telemetry,
      },
    );
    return {
      address: runtime.address,
      processing: "active",
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
