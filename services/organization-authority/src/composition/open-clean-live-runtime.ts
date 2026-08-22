import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  canonicalJson,
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  CleanSlackReactionObserverV1,
  FileOrganizationSecretStore,
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  SqliteCleanSlackApprovalTokenReaderV1,
  SqlitePersonSlackApprovalFinalizationCoordinatorV2,
  openOrganizationControlDatabase,
  validatePersonSlackApprovalBindingContractV2,
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
} from "../adapters/security/private-file-credentials.js";
import { DevelopmentFileOrganizationAuthoritySigner } from "../adapters/security/development-file-authority-signer.js";
import { openAuthorityDatabase } from "../adapters/persistence/sqlite/open-unmigrated-database.js";
import type { PersonSessionOidcConfiguration } from "../application/ports/person-session-runtime.js";
import {
  createLlmDecisionProcessor,
  llmProcessingVersion,
} from "../processing/adapters/decision-processors/llm/llm-decision-processor.js";
import { createGranolaMeetingSourceAdapter } from "../processing/adapters/meeting-sources/granola/index.js";
import { compileDecisionBrief } from "../processing/core/processing/brief.js";
import type { AdapterConfig } from "../processing/core/contracts/adapter.js";
import type { DecisionBrief } from "../processing/core/contracts/delivery.js";
import {
  CleanSlackApprovalStagerV1,
  SlackWebApiCleanApprovalCardPosterV1,
  type CleanSlackApprovalCardFactoryV1,
  type CleanSlackApprovalCardPosterV1,
} from "../processing/clean-v1/clean-slack-approval-stager.js";
import { CleanLiveOnlySourceCycleV1 } from "../processing/clean-v1/live-only-source-cycle.js";
import { SqliteCleanLiveOnlySourceStateV1 } from "../processing/clean-v1/sqlite-live-only-source-state.js";
import {
  CleanD2ToD3ProcessingCoordinatorV1,
  SqliteCleanD2ToD3AuthorityStateV1,
} from "../processing/clean-v1-d2-d3/clean-d2-d3-processing-coordinator.js";
import { createCleanV4RecordWriterV1 } from "../processing/clean-v1-record/clean-v4-record-writer.js";
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
import {
  createCleanReadableSearchGenerationReconcilerV1,
} from "./clean-readable-search-runtime.js";
import type { CleanPersonRuntimeConfig } from "./clean-person-runtime.js";
import type { CleanPersonRuntimeDependencies } from "./clean-person-runtime.js";
import type { PersonSlackApprovalObserverV2 } from "@echo-brain/organization-control-plane/clean-runtime-v1";
import { verifyCleanStateLineage } from "./verify-clean-state-lineage.js";

export interface OpenCleanLiveRuntimeConfig {
  readonly state_directory: string;
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly authority_url: string;
  readonly oidc: PersonSessionOidcConfiguration;
  readonly client_authentication: CleanPersonRuntimeConfig["client_authentication"];
  readonly pkce_key_file: string;
  readonly slack_approval_channel_id: string;
  readonly granola_credential_file: string;
  readonly granola_owner_email_file: string;
  readonly llm_credential_file: string;
  readonly worker_interval_ms?: number;
  /** Observational only: a failed cycle is retried by the serialized worker. */
  readonly on_worker_error?: (error: Error) => void;
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
    readonly approval_card_poster?: CleanSlackApprovalCardPosterV1;
    readonly approval_observer?: PersonSlackApprovalObserverV2;
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

function currentSlackApproval(
  database: Database.Database,
  channelId: string,
): {
  readonly connection_id: string;
  readonly connection_contract_sha256: Sha256Digest;
  readonly connection_state_sha256: Sha256Digest;
  readonly approval_binding_id: string;
  readonly approval_binding_contract_sha256: Sha256Digest;
  readonly approval_channel_id: string;
} {
  const connection = database
    .prepare(
      `SELECT current_state.connection_id, current_state.connection_contract_sha256,
              current_state.state_sha256
         FROM organization_tool_connection_current_state AS current_state
        WHERE current_state.current_status = 'active'`,
    )
    .get() as
    | {
        connection_id: string;
        connection_contract_sha256: Sha256Digest;
        state_sha256: Sha256Digest;
      }
    | undefined;
  if (connection === undefined)
    throw new Error("clean live runtime has no active Slack connection");
  const binding = database
    .prepare(
      `SELECT contract.approval_binding_id, contract.contract_json, contract.contract_sha256
         FROM organization_approval_binding_contracts AS contract
         JOIN organization_approval_binding_current AS current
           ON current.approval_binding_id = contract.approval_binding_id
          AND current.contract_sha256 = contract.contract_sha256
        WHERE current.current_status = 'active' AND contract.connection_id = ?`,
    )
    .get(connection.connection_id) as
    | {
        approval_binding_id: string;
        contract_json: string;
        contract_sha256: Sha256Digest;
      }
    | undefined;
  if (
    binding === undefined ||
    canonicalJson(JSON.parse(binding.contract_json) as never) !==
      binding.contract_json
  ) {
    throw new Error(
      "clean live runtime has no canonical active Slack approval binding",
    );
  }
  const contract = validatePersonSlackApprovalBindingContractV2(
    JSON.parse(binding.contract_json) as unknown,
  );
  if (
    canonicalSha256(contract) !== binding.contract_sha256 ||
    contract.approval_binding_id !== binding.approval_binding_id ||
    contract.connection_id !== connection.connection_id ||
    contract.approval_adapter_id !== "slack-reactions" ||
    contract.approval_channel_id !== channelId
  ) {
    throw new Error(
      "clean live runtime Slack approval binding differs from the founder manifest",
    );
  }
  return Object.freeze({
    connection_id: connection.connection_id,
    connection_contract_sha256: connection.connection_contract_sha256,
    connection_state_sha256: connection.state_sha256,
    approval_binding_id: binding.approval_binding_id,
    approval_binding_contract_sha256: binding.contract_sha256,
    approval_channel_id: contract.approval_channel_id,
  });
}

const CLEAN_SLACK_APPROVAL_CARD_TEXT_LIMIT_V1 = 3_500;
const CLEAN_SLACK_APPROVAL_CARD_TRUNCATION_V1 =
  "\n\n[Card truncated for Slack. The full approved snapshot remains frozen.]";

/**
 * Keeps a founder's approval decision legible without introducing a second
 * presentation model. The complete brief is still the frozen approved
 * snapshot; this is the bounded Slack rendering of those same signals.
 */
export function renderCleanSlackApprovalCardTextV1(
  brief: DecisionBrief,
): string {
  const lines = [
    `Review ${brief.meeting.title ?? "meeting decisions"}`,
    `${brief.decisions.length} decisions, ${brief.actions.length} actions, ${brief.rationales.length} rationales`,
  ];
  const sections: ReadonlyArray<
    readonly [string, readonly { text: string }[]]
  > = [
    ["Decisions", brief.decisions],
    ["Actions", brief.actions],
    ["Rationales", brief.rationales],
  ];
  for (const [heading, signals] of sections) {
    if (signals.length === 0) continue;
    lines.push(
      "",
      `${heading}:`,
      ...signals.map((signal) => `• ${signal.text}`),
    );
  }
  lines.push("", "React with :white_check_mark: to approve or :x: to reject.");
  const rendered = lines.join("\n");
  if (rendered.length <= CLEAN_SLACK_APPROVAL_CARD_TEXT_LIMIT_V1) {
    return rendered;
  }
  return (
    rendered.slice(
      0,
      CLEAN_SLACK_APPROVAL_CARD_TEXT_LIMIT_V1 -
        CLEAN_SLACK_APPROVAL_CARD_TRUNCATION_V1.length,
    ) + CLEAN_SLACK_APPROVAL_CARD_TRUNCATION_V1
  );
}

class CleanSlackCardFactoryV1 implements CleanSlackApprovalCardFactoryV1 {
  constructor(
    private readonly coordinates: {
      readonly authority_id: string;
      readonly organization_id: string;
      readonly state_lineage_id: string;
    },
    private readonly slack: ReturnType<typeof currentSlackApproval>,
  ) {}

  build(input: Parameters<CleanSlackApprovalCardFactoryV1["build"]>[0]) {
    const brief = compileDecisionBrief(
      `brf_${input.candidate.candidate_semantic_sha256.slice("sha256:".length)}`,
      input.meeting,
      input.decisions,
    );
    const payload = {
      brief,
      source: {
        adapter_id: input.admission.source.adapter_id,
        instance_id: input.admission.source.instance_id,
        external_id: input.meeting.provenance.external_id,
      },
      alternatives: [],
      links: null,
      reviewed_at: input.decisions.generated_at,
      surface: "slack",
    };
    const approvedSnapshot = Object.freeze({
      schema_version: 2 as const,
      kind: "echo-approved-decision-snapshot-v2" as const,
      approval_id: input.candidate.approval_id,
      staged_content_sha256: canonicalSha256({
        meeting: input.meeting,
        decisions: input.decisions,
      }),
      final_content_sha256: canonicalSha256(payload),
      payload_contract_id: "organization-record-approval-payload-v1" as const,
      approved_payload: payload,
    });
    const text = renderCleanSlackApprovalCardTextV1(brief);
    return Object.freeze({
      text,
      frozen_card_sha256: canonicalSha256({
        schema_version: 1,
        kind: "echo-clean-slack-approval-card-v1",
        approval_id: input.candidate.approval_id,
        text,
        approved_snapshot_sha256: canonicalSha256(approvedSnapshot),
      }),
      approved_snapshot: approvedSnapshot,
    });
  }

  pendingApproval(
    input: Parameters<CleanSlackApprovalCardFactoryV1["pendingApproval"]>[0],
  ) {
    const { stage, outbox } = input;
    if (
      outbox.provider_message_ts === null ||
      outbox.frozen_card_sha256 === null ||
      outbox.approved_snapshot_sha256 === null
    ) {
      throw new Error("clean live Slack card is not durably posted");
    }
    return Object.freeze({
      authority_id: this.coordinates.authority_id,
      organization_id: this.coordinates.organization_id,
      state_lineage_id: this.coordinates.state_lineage_id,
      approval_id: stage.candidate.approval_id,
      status: "pending" as const,
      connection_id: this.slack.connection_id,
      connection_contract_sha256: this.slack.connection_contract_sha256,
      approval_binding_id: this.slack.approval_binding_id,
      approval_binding_contract_sha256:
        this.slack.approval_binding_contract_sha256,
      approval_channel_id: this.slack.approval_channel_id,
      provider_message_ts: outbox.provider_message_ts,
      policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      policy_contract_sha256:
        ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
      policy_consequence_sha256:
        ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
      frozen_card_sha256: outbox.frozen_card_sha256 as Sha256Digest,
      approved_snapshot_sha256: outbox.approved_snapshot_sha256 as Sha256Digest,
    });
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

class CombinedCleanLiveProcessing implements CleanLiveProcessingCycleV1 {
  constructor(
    private readonly source: CleanLiveOnlySourceCycleV1,
    private readonly d2d3: CleanD2ToD3ProcessingCoordinatorV1,
    private readonly readableSearch: CleanReadableSearchReconcilerV1,
  ) {}

  recoverV4Appends(signal: AbortSignal): Promise<void> {
    return this.d2d3.recoverV4Appends(signal);
  }

  async pollAndStageLiveOnlySource(signal: AbortSignal): Promise<void> {
    await this.source.runOnce(signal);
  }

  observeAndFinalizePendingApprovals(signal: AbortSignal): Promise<void> {
    return this.d2d3.observeAndFinalizePendingApprovals(signal);
  }

  appendFinalizedApprovalsToV4(signal: AbortSignal): Promise<void> {
    return this.d2d3.appendFinalizedApprovalsToV4(signal);
  }

  async reconcileReadableSearchGeneration(signal: AbortSignal): Promise<void> {
    await this.readableSearch.reconcile(signal);
  }
}

function authorityMembershipFence(database: Database.Database) {
  return {
    async withStablePersonSlackApprovalFence<T>(
      commit: (fence: {
        currentMembership(input: {
          readonly principal_id: string;
          readonly membership_id: string;
        }):
          | {
              readonly principal_id: string;
              readonly membership_id: string;
              readonly membership_type: "owner" | "employee";
            }
          | undefined;
      }) => T,
    ): Promise<T> {
      return database.transaction(() =>
        commit({
          currentMembership: (input) => {
            const membership = database
              .prepare(
                `SELECT principal_id, membership_id, membership_type
                   FROM authority_memberships
                  WHERE principal_id = ? AND membership_id = ? AND status = 'active'`,
              )
              .get(input.principal_id, input.membership_id) as
              | {
                  principal_id: string;
                  membership_id: string;
                  membership_type: "owner" | "employee";
                }
              | undefined;
            return membership;
          },
        }),
      )();
    },
  };
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
 * clean Slack, D2, and V4 components. Constructors read private files but do
 * not call any provider.
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
    const source = dependencies.live_adapters?.source ?? (() => {
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
    const processor = dependencies.live_adapters?.processor ?? (() => {
      const llmCredential = readPrivateAuthorityCredential(llmReference);
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
    const slack = currentSlackApproval(
      control,
      config.slack_approval_channel_id,
    );
    const needsTokenReader =
      dependencies.live_adapters?.approval_card_poster === undefined ||
      dependencies.live_adapters?.approval_observer === undefined;
    const tokenReader = needsTokenReader
      ? new SqliteCleanSlackApprovalTokenReaderV1(
          control,
          new FileOrganizationSecretStore(join(config.state_directory, "secrets")),
        )
      : undefined;
    const approvalCardPoster =
      dependencies.live_adapters?.approval_card_poster ??
      new SlackWebApiCleanApprovalCardPosterV1(
        tokenReader!.readApprovalToken({
          connection_id: slack.connection_id,
          connection_state_sha256: slack.connection_state_sha256,
        }),
        config.slack_approval_channel_id,
      );
    const stager = new CleanSlackApprovalStagerV1(
      sourceState,
      control,
      new CleanSlackCardFactoryV1(
        {
          authority_id: lineage.root.authority_id,
          organization_id: lineage.root.organization_id,
          state_lineage_id: lineage.root.state_lineage_id,
        },
        slack,
      ),
      approvalCardPoster,
    );
    const sourceCycle = new CleanLiveOnlySourceCycleV1({
      source,
      processor,
      state: sourceState,
      stager,
    });
    const signer = DevelopmentFileOrganizationAuthoritySigner.openExisting({
      directory: join(config.state_directory, "keys"),
      authority_id: lineage.root.authority_id,
      organization_id: lineage.root.organization_id,
    });
    const recordWriter = await createCleanV4RecordWriterV1({
      append: new OrganizationRecordV4AppendApplication(record, {
        authority_id: lineage.root.authority_id,
        organization_id: lineage.root.organization_id,
        state_lineage_id: lineage.root.state_lineage_id,
      }),
      signer,
      state_lineage_id: lineage.root.state_lineage_id,
      next_envelope_id: () => `env_${randomUUID()}`,
    });
    const d2d3 = new CleanD2ToD3ProcessingCoordinatorV1({
      authority: new SqliteCleanD2ToD3AuthorityStateV1(sourceState),
      finalization: {
        coordinator: new SqlitePersonSlackApprovalFinalizationCoordinatorV2({
          database: control,
          authority_fence: authorityMembershipFence(authority),
        }),
        observer:
          dependencies.live_adapters?.approval_observer ??
          new CleanSlackReactionObserverV1({
            token_reader: tokenReader!,
            now: () => new Date().toISOString(),
          }),
        codec: { sha256: canonicalSha256 },
        ids: {
          next: (kind) =>
            `${kind === "audit_event" ? "aud" : "cor"}_${randomUUID()}`,
        },
        now: () => new Date().toISOString(),
      },
      record_writer: recordWriter,
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
          d2d3,
          readableSearch,
        ),
        person: dependencies.person,
        on_worker_error: config.on_worker_error,
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
