import {
  validateExternalHumanIdentityLinkContractV2,
  validateOrganizationToolConnectionContractV2,
  validateOrganizationToolConnectionStateV2,
  validatePersonSlackReactionApprovalActionCapabilityV2,
  validatePersonSlackReactionApprovalBindingContractV2,
  validateProviderHumanIntegrationAuditEntryV2,
  validateProviderHumanSemanticActionInputV1,
  validateProviderHumanActionDurableResult,
  type ApprovalContractSha256,
  type ExternalHumanIdentityLinkContractV2,
  type OrganizationToolConnectionContractV2,
  type OrganizationToolConnectionStateV2,
  type PersonApprovalAction,
  type PersonApprovalPolicyId,
  type PersonSlackReactionApprovalActionCapabilityV2,
  type PersonSlackReactionApprovalBindingContractV2,
} from "../application/person-slack-reaction-approval-contracts-v2.js";
import type { FrozenApprovalContractV2 } from "../application/person-slack-reaction-approval-activation-v2.js";
import type {
  PersonSlackReactionApprovalFinalizationCoordinatorV2,
  PersonSlackReactionApprovalFinalizationFenceV2,
  PersonSlackReactionApprovalFinalizationTransactionV2,
  StoredProviderHumanActionV2,
} from "../application/person-slack-reaction-approval-finalization-v2.js";
import { canonicalJson, canonicalSha256 } from "../canonical/canonical-json.js";
import { validateRevalidatedPersonSlackPendingApprovalV1 } from "./sqlite-person-slack-reaction-approval-pending-v1.js";
import type Database from "better-sqlite3";

export interface StableAuthorityPersonSlackReactionApprovalFenceV2 {
  withStablePersonSlackReactionApprovalFence<T>(
    commit: (
      fence: Omit<
        PersonSlackReactionApprovalFinalizationFenceV2,
        "transaction" | "revalidatedFrozenApprovalById"
      >,
    ) => T,
  ): Promise<T>;
}

export interface SqlitePersonSlackReactionApprovalFinalizationCoordinatorV2Input {
  readonly database: Database.Database;
  readonly authority_fence: StableAuthorityPersonSlackReactionApprovalFenceV2;
}

function parseCanonical(json: string): unknown {
  const parsed = JSON.parse(json) as unknown;
  if (canonicalJson(parsed) !== json) {
    throw new Error("stored Person Slack reaction approval value is not canonical");
  }
  return parsed;
}

function frozen<T>(
  json: string,
  sha256: string,
  validate: (value: unknown) => T,
): FrozenApprovalContractV2<T> {
  const body = validate(parseCanonical(json));
  if (canonicalSha256(body) !== sha256) {
    throw new Error("stored Person Slack reaction approval digest is invalid");
  }
  return Object.freeze({ body, sha256: sha256 as ApprovalContractSha256 });
}

function humanAction(row: Record<string, string>): StoredProviderHumanActionV2 {
  const contracts = Object.freeze({
    connection: parseCanonical(row.connection_contract_json),
    connection_contract_sha256:
      row.connection_contract_sha256 as ApprovalContractSha256,
    connection_state: parseCanonical(row.connection_state_json),
    connection_state_sha256:
      row.connection_state_sha256 as ApprovalContractSha256,
    external_human_link: parseCanonical(row.external_human_link_contract_json),
    external_identity_link_contract_sha256:
      row.external_human_link_contract_sha256 as ApprovalContractSha256,
    approval_binding: parseCanonical(row.approval_binding_contract_json),
    approval_binding_contract_sha256:
      row.approval_binding_contract_sha256 as ApprovalContractSha256,
    action_capability: parseCanonical(row.action_capability_contract_json),
    action_capability_contract_sha256:
      row.action_capability_contract_sha256 as ApprovalContractSha256,
    provider_observation: parseCanonical(row.provider_observation_json),
    provider_observation_sha256:
      row.provider_observation_sha256 as ApprovalContractSha256,
    provider_message: parseCanonical(row.provider_message_json),
    provider_message_sha256:
      row.provider_message_sha256 as ApprovalContractSha256,
    provider_action: parseCanonical(row.provider_action_json),
    provider_action_sha256:
      row.provider_action_sha256 as ApprovalContractSha256,
    authorization_allow: parseCanonical(row.authorization_allow_json),
    authorization_proof_sha256:
      row.authorization_proof_sha256 as ApprovalContractSha256,
    audit_entry: parseCanonical(row.audit_entry_json),
    audit_entry_sha256: row.audit_entry_sha256 as ApprovalContractSha256,
  });
  return Object.freeze({
    contracts: contracts as StoredProviderHumanActionV2["contracts"],
    semantic_action: parseCanonical(
      row.semantic_action_json,
    ) as StoredProviderHumanActionV2["semantic_action"],
    semantic_action_sha256:
      row.semantic_action_sha256 as ApprovalContractSha256,
    result: parseCanonical(
      row.durable_result_json,
    ) as StoredProviderHumanActionV2["result"],
  });
}

class SqliteFinalizationTransaction implements PersonSlackReactionApprovalFinalizationTransactionV2 {
  constructor(private readonly database: Database.Database) {}

  durableActionByApprovalId(
    approvalId: string,
  ): StoredProviderHumanActionV2 | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM organization_provider_human_action_evidence
         WHERE approval_id = ?`,
      )
      .get(approvalId) as Record<string, string> | undefined;
    return row === undefined ? undefined : humanAction(row);
  }

  connectionById(
    connectionId: string,
  ):
    FrozenApprovalContractV2<OrganizationToolConnectionContractV2> | undefined {
    const row = this.database
      .prepare(
        `SELECT contract_json, contract_sha256
         FROM organization_tool_connection_contracts WHERE connection_id = ?`,
      )
      .get(connectionId) as
      { contract_json: string; contract_sha256: string } | undefined;
    return row === undefined
      ? undefined
      : frozen(
          row.contract_json,
          row.contract_sha256,
          validateOrganizationToolConnectionContractV2,
        );
  }

  connectionStateById(
    connectionId: string,
  ): FrozenApprovalContractV2<OrganizationToolConnectionStateV2> | undefined {
    const row = this.database
      .prepare(
        `SELECT state_json, state_sha256
         FROM organization_tool_connection_current_state WHERE connection_id = ?`,
      )
      .get(connectionId) as
      { state_json: string; state_sha256: string } | undefined;
    return row === undefined
      ? undefined
      : frozen(
          row.state_json,
          row.state_sha256,
          validateOrganizationToolConnectionStateV2,
        );
  }

  approvalBindingById(
    bindingId: string,
  ):
    FrozenApprovalContractV2<PersonSlackReactionApprovalBindingContractV2> | undefined {
    const row = this.database
      .prepare(
        `SELECT contract_json, contract_sha256
         FROM organization_approval_binding_contracts WHERE approval_binding_id = ?`,
      )
      .get(bindingId) as
      { contract_json: string; contract_sha256: string } | undefined;
    return row === undefined
      ? undefined
      : frozen(
          row.contract_json,
          row.contract_sha256,
          validatePersonSlackReactionApprovalBindingContractV2,
        );
  }

  approvalBindingIsCurrent(input: {
    readonly approval_binding_id: string;
    readonly approval_binding_contract_sha256: ApprovalContractSha256;
  }): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1 FROM organization_approval_binding_current
           WHERE approval_binding_id = ? AND contract_sha256 = ?
             AND current_status = 'active'`,
        )
        .get(
          input.approval_binding_id,
          input.approval_binding_contract_sha256,
        ) !== undefined
    );
  }

  approvalSurfaceIsEligible(input: {
    readonly connection_id: string;
    readonly approval_adapter_id: "slack-reactions";
    readonly approval_adapter_instance_id: string;
    readonly approval_adapter_version: string;
    readonly approval_channel_id: string;
    readonly approve_reaction: string;
    readonly reject_reaction: string;
  }): boolean {
    const rows = this.database
      .prepare(
        `SELECT contract.contract_json, contract.contract_sha256
         FROM organization_approval_binding_contracts AS contract
         JOIN organization_approval_binding_current AS current
           ON current.approval_binding_id = contract.approval_binding_id
          AND current.contract_sha256 = contract.contract_sha256
         WHERE current.current_status = 'active' AND contract.connection_id = ?`,
      )
      .all(input.connection_id) as Array<{
      contract_json: string;
      contract_sha256: string;
    }>;
    return rows.some((row) => {
      try {
        const binding = frozen(
          row.contract_json,
          row.contract_sha256,
          validatePersonSlackReactionApprovalBindingContractV2,
        ).body;
        return (
          binding.approval_adapter_id === input.approval_adapter_id &&
          binding.approval_adapter_instance_id ===
            input.approval_adapter_instance_id &&
          binding.approval_adapter_version === input.approval_adapter_version &&
          binding.approval_channel_id === input.approval_channel_id &&
          binding.approve_reaction === input.approve_reaction &&
          binding.reject_reaction === input.reject_reaction
        );
      } catch {
        return false;
      }
    });
  }

  externalHumanLinkByProviderActor(input: {
    readonly provider_issuer: "https://slack.com";
    readonly provider_tenant_kind: "workspace";
    readonly provider_tenant_id: string;
    readonly provider_enterprise_id: string | null;
    readonly provider_subject_id: string;
  }):
    FrozenApprovalContractV2<ExternalHumanIdentityLinkContractV2> | undefined {
    const row = this.database
      .prepare(
        `SELECT contract.contract_json, contract.contract_sha256
         FROM organization_external_human_link_current AS current
         JOIN organization_external_human_link_contracts AS contract
           ON contract.external_identity_link_id = current.external_identity_link_id
          AND contract.contract_sha256 = current.contract_sha256
         WHERE current.current_status = 'active'
           AND current.provider_issuer = ?
           AND current.provider_tenant_kind = ?
           AND current.provider_tenant_id = ?
           AND (current.provider_enterprise_id IS ?
                OR current.provider_enterprise_id = ?)
           AND current.provider_subject_id = ?`,
      )
      .get(
        input.provider_issuer,
        input.provider_tenant_kind,
        input.provider_tenant_id,
        input.provider_enterprise_id,
        input.provider_enterprise_id,
        input.provider_subject_id,
      ) as { contract_json: string; contract_sha256: string } | undefined;
    return row === undefined
      ? undefined
      : frozen(
          row.contract_json,
          row.contract_sha256,
          validateExternalHumanIdentityLinkContractV2,
        );
  }

  externalHumanLinkIsCurrent(input: {
    readonly external_identity_link_id: string;
    readonly link_contract_sha256: ApprovalContractSha256;
  }): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1 FROM organization_external_human_link_current
           WHERE external_identity_link_id = ? AND contract_sha256 = ?
             AND current_status = 'active'`,
        )
        .get(input.external_identity_link_id, input.link_contract_sha256) !==
      undefined
    );
  }

  actionCapability(input: {
    readonly approval_binding_id: string;
    readonly external_identity_link_id: string;
    readonly policy_id: PersonApprovalPolicyId;
    readonly action: PersonApprovalAction;
  }):
    | FrozenApprovalContractV2<PersonSlackReactionApprovalActionCapabilityV2>
    | undefined {
    const row = this.database
      .prepare(
        `SELECT contract.contract_json, contract.contract_sha256
         FROM organization_approval_action_capability_contracts AS contract
         JOIN organization_approval_action_capability_current AS current
           ON current.action_capability_id = contract.action_capability_id
          AND current.contract_sha256 = contract.contract_sha256
         WHERE current.current_status = 'active'
           AND contract.approval_binding_id = ?
           AND contract.external_identity_link_id = ?
           AND contract.policy_id = ? AND contract.action = ?`,
      )
      .get(
        input.approval_binding_id,
        input.external_identity_link_id,
        input.policy_id,
        input.action,
      ) as { contract_json: string; contract_sha256: string } | undefined;
    return row === undefined
      ? undefined
      : frozen(
          row.contract_json,
          row.contract_sha256,
          validatePersonSlackReactionApprovalActionCapabilityV2,
        );
  }

  actionCapabilityIsCurrent(input: {
    readonly action_capability_id: string;
    readonly action_capability_contract_sha256: ApprovalContractSha256;
  }): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1 FROM organization_approval_action_capability_current
           WHERE action_capability_id = ? AND contract_sha256 = ?
             AND current_status = 'active'`,
        )
        .get(
          input.action_capability_id,
          input.action_capability_contract_sha256,
        ) !== undefined
    );
  }

  auditHead(): {
    readonly audit_sequence: number;
    readonly audit_entry_sha256: ApprovalContractSha256;
  } | null {
    const row = this.database
      .prepare(
        `SELECT audit_sequence, audit_entry_sha256
         FROM organization_provider_human_action_evidence
         ORDER BY audit_sequence DESC LIMIT 1`,
      )
      .get() as
      { audit_sequence: number; audit_entry_sha256: string } | undefined;
    return row === undefined
      ? null
      : Object.freeze({
          audit_sequence: row.audit_sequence,
          audit_entry_sha256: row.audit_entry_sha256 as ApprovalContractSha256,
        });
  }

  auditHeadIsVerified(
    input: {
      readonly audit_sequence: number;
      readonly audit_entry_sha256: ApprovalContractSha256;
    } | null,
  ): boolean {
    const actual = this.auditHead();
    if (actual === null || input === null) return actual === input;
    if (
      actual.audit_sequence !== input.audit_sequence ||
      actual.audit_entry_sha256 !== input.audit_entry_sha256
    ) {
      return false;
    }
    const row = this.database
      .prepare(
        `SELECT audit_entry_json FROM organization_provider_human_action_evidence
         WHERE audit_sequence = ? AND audit_entry_sha256 = ?`,
      )
      .get(actual.audit_sequence, actual.audit_entry_sha256) as
      { audit_entry_json: string } | undefined;
    if (row === undefined) return false;
    try {
      return (
        canonicalSha256(
          validateProviderHumanIntegrationAuditEntryV2(
            parseCanonical(row.audit_entry_json),
          ),
        ) === actual.audit_entry_sha256
      );
    } catch {
      return false;
    }
  }

  auditEntryIsInVerifiedChain(input: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
    readonly audit_event_id: string;
    readonly audit_sequence: number;
    readonly audit_entry_sha256: ApprovalContractSha256;
    readonly predecessor_entry_sha256: ApprovalContractSha256 | null;
  }): boolean {
    const row = this.database
      .prepare(
        `SELECT audit_entry_json, predecessor_entry_sha256
         FROM organization_provider_human_action_evidence
         WHERE audit_event_id = ? AND audit_sequence = ? AND audit_entry_sha256 = ?`,
      )
      .get(
        input.audit_event_id,
        input.audit_sequence,
        input.audit_entry_sha256,
      ) as
      | { audit_entry_json: string; predecessor_entry_sha256: string | null }
      | undefined;
    if (
      row === undefined ||
      row.predecessor_entry_sha256 !== input.predecessor_entry_sha256
    ) {
      return false;
    }
    try {
      const audit = validateProviderHumanIntegrationAuditEntryV2(
        parseCanonical(row.audit_entry_json),
      );
      return (
        canonicalSha256(audit) === input.audit_entry_sha256 &&
        audit.authority_id === input.authority_id &&
        audit.organization_id === input.organization_id &&
        audit.state_lineage_id === input.state_lineage_id &&
        audit.audit_event_id === input.audit_event_id &&
        audit.audit_sequence === input.audit_sequence &&
        audit.predecessor_entry_sha256 === input.predecessor_entry_sha256
      );
    } catch {
      return false;
    }
  }

  saveHumanAction(value: StoredProviderHumanActionV2): void {
    const set = value.contracts;
    const audit = validateProviderHumanIntegrationAuditEntryV2(set.audit_entry);
    const result = validateProviderHumanActionDurableResult(value.result);
    const semantic = validateProviderHumanSemanticActionInputV1(
      value.semantic_action,
    );
    this.database
      .prepare(
        `INSERT INTO organization_provider_human_action_evidence (
           approval_id,
           connection_contract_json, connection_contract_sha256,
           connection_state_json, connection_state_sha256,
           external_human_link_contract_json, external_human_link_contract_sha256,
           approval_binding_contract_json, approval_binding_contract_sha256,
           action_capability_contract_json, action_capability_contract_sha256,
           provider_observation_json, provider_observation_sha256,
           provider_message_json, provider_message_sha256,
           provider_action_json, provider_action_sha256,
           authorization_allow_json, authorization_proof_sha256,
           semantic_action_json, semantic_action_sha256,
           durable_result_json, durable_result_sha256,
           audit_event_id, audit_sequence, audit_entry_json, audit_entry_sha256,
           predecessor_entry_sha256, committed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.approval_id,
        canonicalJson(set.connection),
        set.connection_contract_sha256,
        canonicalJson(set.connection_state),
        set.connection_state_sha256,
        canonicalJson(set.external_human_link),
        set.external_identity_link_contract_sha256,
        canonicalJson(set.approval_binding),
        set.approval_binding_contract_sha256,
        canonicalJson(set.action_capability),
        set.action_capability_contract_sha256,
        canonicalJson(set.provider_observation),
        set.provider_observation_sha256,
        canonicalJson(set.provider_message),
        set.provider_message_sha256,
        canonicalJson(set.provider_action),
        set.provider_action_sha256,
        canonicalJson(set.authorization_allow),
        set.authorization_proof_sha256,
        canonicalJson(semantic),
        value.semantic_action_sha256,
        canonicalJson(result),
        canonicalSha256(result),
        audit.audit_event_id,
        audit.audit_sequence,
        canonicalJson(audit),
        set.audit_entry_sha256,
        audit.predecessor_entry_sha256,
        audit.occurred_at,
      );
  }
}

/** Clean SQLite coordinator: Authority supplies membership stability only. */
export class SqlitePersonSlackReactionApprovalFinalizationCoordinatorV2 implements PersonSlackReactionApprovalFinalizationCoordinatorV2 {
  constructor(
    private readonly input: SqlitePersonSlackReactionApprovalFinalizationCoordinatorV2Input,
  ) {}

  async withStableProviderHumanAction<T>(
    commit: (fence: PersonSlackReactionApprovalFinalizationFenceV2) => T,
  ): Promise<T> {
    return this.input.authority_fence.withStablePersonSlackReactionApprovalFence(
      (authority) => {
        this.input.database.exec("BEGIN IMMEDIATE");
        try {
          const transaction = new SqliteFinalizationTransaction(
            this.input.database,
          );
          const result = commit({
            ...authority,
            revalidatedFrozenApprovalById: (approvalId) => {
              const row = this.input.database
                .prepare(
                  `SELECT approval_json, approval_sha256
                   FROM organization_person_slack_pending_approvals
                   WHERE approval_id = ?`,
                )
                .get(approvalId) as
                { approval_json: string; approval_sha256: string } | undefined;
              if (row === undefined) return undefined;
              const parsed = parseCanonical(row.approval_json);
              if (canonicalSha256(parsed) !== row.approval_sha256) {
                throw new Error(
                  "stored pending Person Slack reaction approval digest is invalid",
                );
              }
              return validateRevalidatedPersonSlackPendingApprovalV1(parsed);
            },
            transaction,
          });
          this.input.database.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            this.input.database.exec("ROLLBACK");
          } catch {}
          throw error;
        }
      },
    );
  }
}
