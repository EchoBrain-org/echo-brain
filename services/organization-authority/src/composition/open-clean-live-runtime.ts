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
import type Database from "better-sqlite3";
import {
  readPrivateAuthorityCredential,
  readPrivateAuthorityGranolaOrganizationCredential,
  readPrivateAuthorityGranolaOwnerEmail,
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
import { createGranolaMeetingSourceAdapter } from "../processing/adapters/meeting-sources/granola/index.js";
import type { AdapterConfig } from "../processing/core/contracts/adapter.js";
import { CleanLiveOnlySourceCycleV1 } from "../processing/clean-v1/live-only-source-cycle.js";
import { SqliteCleanLiveOnlySourceStateV1 } from "../processing/clean-v1/sqlite-live-only-source-state.js";
import { selectGranolaPersonContentPolicyV1 } from "../processing/clean-v1/granola-person-content-policy.js";
import { PrivateSlackApprovalCardPosterV1 } from "../processing/clean-v1/private-slack-approval-card-poster-v1.js";
import { createPrivateSlackBlockV4RecordWriterV1 } from "../processing/clean-v1-record/private-slack-block-v4-record-writer-v1.js";
import {
  CLEAN_LLM_PROCESSOR_MAX_OUTPUT_TOKENS_V1,
  CLEAN_LLM_PROCESSOR_MODEL_V1,
  CLEAN_LLM_PROCESSOR_PROVIDER_V1,
  CLEAN_LLM_PROCESSOR_TIMEOUT_MS_V1,
} from "./clean-granola-source-admission.js";
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
  readonly granola_credential_file: string;
  readonly granola_owner_email_file: string;
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

function fixedGranolaConfig(
  instanceId: string,
  ownerEmail: string,
  credentialReference: string,
): AdapterConfig {
  return {
    adapter_id: "granola",
    instance_id: instanceId,
    credential_ref: credentialReference,
    settings: { page_size: 1, owner_email: ownerEmail },
  };
}

function fixedOpenRouterConfig(
  instanceId: string,
  credentialReference: string,
): AdapterConfig {
  return {
    adapter_id: "llm",
    instance_id: instanceId,
    credential_ref: credentialReference,
    settings: {
      provider: CLEAN_LLM_PROCESSOR_PROVIDER_V1,
      model: CLEAN_LLM_PROCESSOR_MODEL_V1,
      max_output_tokens: CLEAN_LLM_PROCESSOR_MAX_OUTPUT_TOKENS_V1,
      request_timeout_ms: CLEAN_LLM_PROCESSOR_TIMEOUT_MS_V1,
    },
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

function sourceIsAdmitted(database: Database.Database): boolean {
  return (
    database
      .prepare(
        "SELECT 1 FROM authority_clean_granola_source_admission_v1 WHERE singleton = 1",
      )
      .get() !== undefined
  );
}

/**
 * The concrete server composition. Before stopped-state finalize, it exposes
 * the Person routes and does no work. After a restart from the exact same
 * manifest-driven command, it constructs only Granola, fixed OpenRouter,
 * the private owner-DM Slack lane, and V4 components. Constructors read
 * private files but do not call any provider.
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
  if (!sourceIsAdmitted(authority)) {
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
    const sourceState = new SqliteCleanLiveOnlySourceStateV1(authority);
    const admission = await sourceState.readAdmission();
    const granolaReference = `file:${config.granola_credential_file}`;
    const llmReference = `file:${config.llm_credential_file}`;
    const llmCredential =
      dependencies.live_adapters?.processor === undefined ||
      dependencies.person?.answer_model === undefined
        ? readPrivateAuthorityCredential(llmReference)
        : undefined;
    const source =
      dependencies.live_adapters?.source ??
      (() => {
        const ownerEmail = readPrivateAuthorityGranolaOwnerEmail(
          `file:${config.granola_owner_email_file}`,
        );
        const granolaCredential =
          readPrivateAuthorityGranolaOrganizationCredential(granolaReference);
        const granolaConfig = fixedGranolaConfig(
          admission.source.instance_id,
          ownerEmail,
          granolaReference,
        );
        const created = createGranolaMeetingSourceAdapter(granolaConfig, {
          credentialResolver: (reference) =>
            reference === granolaReference ? granolaCredential : undefined,
        });
        assertAdapter("Granola", created, granolaConfig);
        return created;
      })();
    const processor =
      dependencies.live_adapters?.processor ??
      (() => {
        const processorConfig = fixedOpenRouterConfig(
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
      source.identity.version !== admission.source.version ||
      processor.identity.version !== admission.processor.version ||
      (dependencies.live_adapters?.processor === undefined &&
        llmProcessingVersion(
          fixedOpenRouterConfig(admission.processor.instance_id, llmReference),
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
    });
    const sourceCycle = new CleanLiveOnlySourceCycleV1({
      source,
      processor,
      state: sourceState,
      stager,
      review_policy: (meeting) =>
        selectGranolaPersonContentPolicyV1(meeting.extensions),
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
