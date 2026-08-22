import { canonicalJson, canonicalSha256 } from "../canonical/canonical-json.js";
import {
  validatePersonSlackApprovalBindingContractV2,
  validateOrganizationToolConnectionContractV2,
  validateOrganizationToolConnectionStateV2,
  validateExternalHumanIdentityLinkContractV2,
} from "../application/person-slack-approval-contracts-v2.js";
import type {
  ExternalHumanIdentityLinkContractV2,
  OrganizationToolConnectionContractV2,
  OrganizationToolConnectionStateV2,
} from "../application/person-slack-approval-contracts-v2.js";
import type { FrozenApprovalContractV2 } from "../application/person-slack-approval-activation-v2.js";
import type {
  PersonSlackApprovalActivationCoordinatorV2,
  PersonSlackApprovalActivationFenceV2,
  PersonSlackApprovalActivationResultV2,
  PersonSlackApprovalActivationTransactionV2,
} from "../application/person-slack-approval-activation-v2.js";
import type Database from "better-sqlite3";

/**
 * The Authority owns this fence. It deliberately supplies no cross-database
 * lock: the coordinator only holds this independently stable Administrator /
 * membership view while it commits one control-plane SQLite transaction.
 */
export interface StableAuthorityAdministratorFenceV2 {
  withStableAdministratorFence<T>(
    credential: unknown,
    commit: (
      fence: Omit<PersonSlackApprovalActivationFenceV2, "transaction">,
    ) => T,
  ): Promise<T>;
}

export interface SqlitePersonSlackApprovalActivationCoordinatorV2Input {
  readonly database: Database.Database;
  readonly authority_fence: StableAuthorityAdministratorFenceV2;
  readonly now: () => string;
}

function parseCanonical(json: string): unknown {
  const parsed = JSON.parse(json) as unknown;
  if (canonicalJson(parsed) !== json)
    throw new Error("stored activation body is not canonical");
  return parsed;
}

function frozen<T>(
  json: string,
  sha256: string,
  validate: (value: unknown) => T,
): FrozenApprovalContractV2<T> {
  const body = parseCanonical(json);
  if (canonicalSha256(body) !== sha256)
    throw new Error("stored activation digest is invalid");
  return Object.freeze({
    body: validate(body),
    sha256: sha256 as `sha256:${string}`,
  });
}

class SqliteActivationTransaction implements PersonSlackApprovalActivationTransactionV2 {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => string,
  ) {}

  activationByCommandId(
    commandId: string,
  ): PersonSlackApprovalActivationResultV2 | undefined {
    const row = this.database
      .prepare(
        `SELECT command_semantic_sha256, result_json
         FROM organization_approval_activation_commands AS command
         JOIN organization_approval_activation_resources AS resource
           ON resource.resource_sha256 = command.resource_sha256
        WHERE command.command_id = ?`,
      )
      .get(commandId) as
      { command_semantic_sha256: string; result_json: string } | undefined;
    if (!row) return undefined;
    const result = parseCanonical(row.result_json) as Record<string, unknown>;
    return Object.freeze({
      ...result,
      command_id: commandId,
      command_semantic_sha256: row.command_semantic_sha256,
    }) as PersonSlackApprovalActivationResultV2;
  }

  activationByResourceSha256(
    resourceSha256: string,
  ): PersonSlackApprovalActivationResultV2 | undefined {
    const row = this.database
      .prepare(
        `SELECT result_json FROM organization_approval_activation_resources
        WHERE resource_sha256 = ?`,
      )
      .get(resourceSha256) as { result_json: string } | undefined;
    return row
      ? (parseCanonical(
          row.result_json,
        ) as PersonSlackApprovalActivationResultV2)
      : undefined;
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
    return row
      ? frozen(
          row.contract_json,
          row.contract_sha256,
          validateOrganizationToolConnectionContractV2,
        )
      : undefined;
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
    return row
      ? frozen(
          row.state_json,
          row.state_sha256,
          validateOrganizationToolConnectionStateV2,
        )
      : undefined;
  }

  externalHumanLinkById(
    linkId: string,
  ): FrozenApprovalContractV2<ExternalHumanIdentityLinkContractV2> | undefined {
    const row = this.database
      .prepare(
        `SELECT contract.contract_json, contract.contract_sha256
         FROM organization_external_human_link_current AS current
         JOIN organization_external_human_link_contracts AS contract
           ON contract.external_identity_link_id = current.external_identity_link_id
          AND contract.contract_sha256 = current.contract_sha256
        WHERE current.external_identity_link_id = ?
          AND current.current_status = 'active'`,
      )
      .get(linkId) as
      { contract_json: string; contract_sha256: string } | undefined;
    return row
      ? frozen(
          row.contract_json,
          row.contract_sha256,
          validateExternalHumanIdentityLinkContractV2,
        )
      : undefined;
  }

  externalHumanLinkIsCurrent(input: {
    readonly external_identity_link_id: string;
    readonly link_contract_sha256: string;
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
    const hasExistingEligibleBinding = rows.some((row) => {
      try {
        const body = validatePersonSlackApprovalBindingContractV2(
          parseCanonical(row.contract_json),
        );
        return (
          canonicalSha256(body) === row.contract_sha256 &&
          body.approval_adapter_id === input.approval_adapter_id &&
          body.approval_adapter_instance_id ===
            input.approval_adapter_instance_id &&
          body.approval_adapter_version === input.approval_adapter_version &&
          body.approval_channel_id === input.approval_channel_id &&
          body.approve_reaction === input.approve_reaction &&
          body.reject_reaction === input.reject_reaction
        );
      } catch {
        return false;
      }
    });
    if (hasExistingEligibleBinding) return true;

    // A reset-first server does not have a legacy approval binding to use as a
    // bootstrap marker. Its stopped-state Slack connect command instead froze
    // the one allowed reaction surface in the connection's public
    // configuration digest. Accept only that exact, independently rehashed
    // configuration; arbitrary active connections remain ineligible.
    const connection = this.database
      .prepare(
        `SELECT contract_json, contract_sha256
         FROM organization_tool_connection_contracts
         WHERE connection_id = ?`,
      )
      .get(input.connection_id) as
      { contract_json: string; contract_sha256: string } | undefined;
    if (connection === undefined) return false;
    try {
      const body = validateOrganizationToolConnectionContractV2(
        parseCanonical(connection.contract_json),
      );
      if (canonicalSha256(body) !== connection.contract_sha256) return false;
      const expectedConfiguration = canonicalSha256({
        approval_adapter_id: input.approval_adapter_id,
        approval_channel_id: input.approval_channel_id,
        approve_reaction: input.approve_reaction,
        kind: "echo-clean-slack-connection-public-configuration-v1",
        reject_reaction: input.reject_reaction,
      });
      return (
        body.tool_kind === "slack" &&
        body.public_connection_configuration_sha256 === expectedConfiguration
      );
    } catch {
      return false;
    }
  }

  saveActivation(result: PersonSlackApprovalActivationResultV2): void {
    const createdAt = this.now();
    const resource = result.activation_resource_sha256;
    const resourceAlreadyExists =
      this.database
        .prepare(
          `SELECT 1 FROM organization_approval_activation_resources WHERE resource_sha256 = ?`,
        )
        .get(resource) !== undefined;
    if (!resourceAlreadyExists) {
      const resourceResult = canonicalJson(result);
      const resourceResultSha256 = canonicalSha256(result);
      const binding = result.approval_binding;
      const bindingJson = canonicalJson(binding.body);
      this.database
        .prepare(
          `INSERT INTO organization_approval_binding_contracts
       (approval_binding_id, contract_json, contract_sha256, connection_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          binding.body.approval_binding_id,
          bindingJson,
          binding.sha256,
          binding.body.connection_id,
          createdAt,
        );
      this.database
        .prepare(
          `INSERT INTO organization_approval_binding_current
       (approval_binding_id, contract_sha256, current_status, updated_at)
       VALUES (?, ?, 'active', ?)`,
        )
        .run(binding.body.approval_binding_id, binding.sha256, createdAt);
      for (const capability of result.action_capabilities) {
        this.database
          .prepare(
            `INSERT INTO organization_approval_action_capability_contracts
         (action_capability_id, contract_json, contract_sha256, approval_binding_id,
          external_identity_link_id, policy_id, action, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            capability.body.action_capability_id,
            canonicalJson(capability.body),
            capability.sha256,
            capability.body.approval_binding_id,
            capability.body.external_identity_link_id,
            capability.body.policy_id,
            capability.body.action,
            createdAt,
          );
        this.database
          .prepare(
            `INSERT INTO organization_approval_action_capability_current
         (action_capability_id, contract_sha256, current_status, updated_at)
         VALUES (?, ?, 'active', ?)`,
          )
          .run(
            capability.body.action_capability_id,
            capability.sha256,
            createdAt,
          );
      }
      this.database
        .prepare(
          `INSERT INTO organization_approval_activation_resources
         (resource_sha256, approval_binding_id, result_json, result_sha256, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          resource,
          binding.body.approval_binding_id,
          resourceResult,
          resourceResultSha256,
          createdAt,
        );
    }
    this.database
      .prepare(
        `INSERT INTO organization_approval_activation_commands
       (command_id, command_semantic_sha256, resource_sha256, created_at)
       VALUES (?, ?, ?, ?)`,
      )
      .run(
        result.command_id,
        result.command_semantic_sha256,
        resource,
        createdAt,
      );
  }
}

/** Private persistence coordinator for the isolated new-lineage path. */
export class SqlitePersonSlackApprovalActivationCoordinatorV2 implements PersonSlackApprovalActivationCoordinatorV2 {
  constructor(
    private readonly input: SqlitePersonSlackApprovalActivationCoordinatorV2Input,
  ) {}

  async withStableAdministratorActivation<T>(
    credential: unknown,
    commit: (fence: PersonSlackApprovalActivationFenceV2) => T,
  ): Promise<T> {
    return this.input.authority_fence.withStableAdministratorFence(
      credential,
      (authority) => {
        this.input.database.exec("BEGIN IMMEDIATE");
        try {
          const result = commit({
            ...authority,
            transaction: new SqliteActivationTransaction(
              this.input.database,
              this.input.now,
            ),
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
