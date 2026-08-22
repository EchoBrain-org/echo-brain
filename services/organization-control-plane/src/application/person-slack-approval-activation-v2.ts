import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  buildPersonSlackApprovalActionCapabilityV2,
  buildPersonSlackApprovalBindingContractV2,
  validateExternalHumanIdentityLinkContractV2,
  validateOrganizationToolConnectionContractV2,
  validateOrganizationToolConnectionStateV2,
  validatePersonSlackApprovalActionCapabilityV2,
  validatePersonSlackApprovalBindingContractV2,
  type ApprovalContractSha256,
  type ExternalHumanIdentityLinkContractV2,
  type OrganizationToolConnectionContractV2,
  type OrganizationToolConnectionStateV2,
  type PersonApprovalAction,
  type PersonApprovalPolicyId,
  type PersonMembershipType,
  type PersonSlackApprovalActionCapabilityV2,
  type PersonSlackApprovalBindingContractV2,
} from "./person-slack-approval-contracts-v2.js";

export const PERSON_SLACK_APPROVAL_ACTIVATION_COMMAND_KIND =
  "echo-person-slack-approval-activation-command-v2" as const;
const ACTIVATION_RESOURCE_KIND =
  "echo-person-slack-approval-activation-resource-v2" as const;

const MEMBER_POLICY = Object.freeze({
  policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  policy_contract_sha256:
    ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  actions: Object.freeze(["approve", "reject"] as const),
});
const REVIEWER_POLICY = Object.freeze({
  policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  policy_contract_sha256: RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  actions: Object.freeze(["approve", "reject"] as const),
});
const CAPABILITY_ORDER = Object.freeze([
  [MEMBER_POLICY, "approve"],
  [MEMBER_POLICY, "reject"],
  [REVIEWER_POLICY, "approve"],
  [REVIEWER_POLICY, "reject"],
] as const);

export interface PersonSlackApprovalActivationCommandV2 {
  readonly command_id: string;
  readonly target_external_identity_link_id: string;
  readonly provider_connection_id: string;
  readonly approval_adapter_instance_id: string;
  readonly approval_adapter_version: string;
  readonly approval_channel_id: string;
  readonly approve_reaction: string;
  readonly reject_reaction: string;
  readonly policy_capabilities: readonly [
    typeof MEMBER_POLICY,
    typeof REVIEWER_POLICY,
  ];
}

export interface PersonSlackApprovalAdministratorContextV2 {
  readonly actor_kind: "authority-administrator-credential";
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: "owner";
}

export interface CurrentAuthorityMembershipV2 {
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: PersonMembershipType;
}

export interface FrozenApprovalContractV2<T> {
  readonly body: T;
  readonly sha256: ApprovalContractSha256;
}

export interface PersonSlackApprovalActivationResultV2 {
  readonly command_id: string;
  readonly command_semantic_sha256: ApprovalContractSha256;
  readonly activation_resource_sha256: ApprovalContractSha256;
  readonly activated_by: PersonSlackApprovalAdministratorContextV2;
  readonly approval_binding: FrozenApprovalContractV2<PersonSlackApprovalBindingContractV2>;
  readonly action_capabilities: readonly FrozenApprovalContractV2<PersonSlackApprovalActionCapabilityV2>[];
}

export interface PersonSlackApprovalActivationTransactionV2 {
  activationByCommandId(
    commandId: string,
  ): PersonSlackApprovalActivationResultV2 | undefined;
  activationByResourceSha256(
    resourceSha256: ApprovalContractSha256,
  ): PersonSlackApprovalActivationResultV2 | undefined;
  connectionById(
    connectionId: string,
  ): FrozenApprovalContractV2<OrganizationToolConnectionContractV2> | undefined;
  connectionStateById(
    connectionId: string,
  ): FrozenApprovalContractV2<OrganizationToolConnectionStateV2> | undefined;
  externalHumanLinkById(
    linkId: string,
  ): FrozenApprovalContractV2<ExternalHumanIdentityLinkContractV2> | undefined;
  externalHumanLinkIsCurrent(input: {
    readonly external_identity_link_id: string;
    readonly link_contract_sha256: ApprovalContractSha256;
  }): boolean;
  approvalSurfaceIsEligible(input: {
    readonly connection_id: string;
    readonly approval_adapter_id: "slack-reactions";
    readonly approval_adapter_instance_id: string;
    readonly approval_adapter_version: string;
    readonly approval_channel_id: string;
    readonly approve_reaction: string;
    readonly reject_reaction: string;
  }): boolean;
  saveActivation(result: PersonSlackApprovalActivationResultV2): void;
}

export interface PersonSlackApprovalActivationFenceV2 {
  readonly administrator: unknown;
  currentMembership(input: {
    readonly principal_id: string;
    readonly membership_id: string;
  }): CurrentAuthorityMembershipV2 | undefined;
  readonly transaction: PersonSlackApprovalActivationTransactionV2;
}

export interface PersonSlackApprovalActivationCoordinatorV2 {
  withStableAdministratorActivation<T>(
    credential: unknown,
    commit: (fence: PersonSlackApprovalActivationFenceV2) => T,
  ): Promise<T>;
}

export interface PersonSlackApprovalActivationCodecV2 {
  sha256(value: unknown): ApprovalContractSha256;
}

export interface PersonSlackApprovalActivationIdFactoryV2 {
  next(kind: "approval_binding" | "action_capability"): string;
}

export class PersonSlackApprovalActivationDeniedError extends Error {
  constructor() {
    super("Person Slack approval activation denied");
    this.name = "PersonSlackApprovalActivationDeniedError";
  }
}

export class PersonSlackApprovalActivationConflictError extends Error {
  constructor() {
    super("Person Slack approval activation conflicts with prior command");
    this.name = "PersonSlackApprovalActivationConflictError";
  }
}

const COMMAND_KEYS = [
  "command_id",
  "target_external_identity_link_id",
  "provider_connection_id",
  "approval_adapter_instance_id",
  "approval_adapter_version",
  "approval_channel_id",
  "approve_reaction",
  "reject_reaction",
  "policy_capabilities",
] as const;
const ADMIN_KEYS = [
  "actor_kind",
  "authority_id",
  "organization_id",
  "state_lineage_id",
  "principal_id",
  "membership_id",
  "membership_type",
] as const;

function denied(): never {
  throw new PersonSlackApprovalActivationDeniedError();
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return denied();
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return denied();
  }
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return denied();
    }
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    return denied();
  }
  return record;
}

function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    value.includes("\u0000")
  ) {
    return denied();
  }
  return value;
}

function digest(value: unknown): ApprovalContractSha256 {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    return denied();
  }
  return value as ApprovalContractSha256;
}

function validatePolicies(
  value: unknown,
): PersonSlackApprovalActivationCommandV2["policy_capabilities"] {
  if (!Array.isArray(value) || value.length !== 2) return denied();
  for (const [index, expected] of [MEMBER_POLICY, REVIEWER_POLICY].entries()) {
    const policy = exactRecord(value[index], [
      "policy_id",
      "policy_contract_sha256",
      "actions",
    ]);
    if (
      policy.policy_id !== expected.policy_id ||
      policy.policy_contract_sha256 !== expected.policy_contract_sha256 ||
      !Array.isArray(policy.actions) ||
      policy.actions.length !== 2 ||
      policy.actions[0] !== "approve" ||
      policy.actions[1] !== "reject"
    ) {
      return denied();
    }
  }
  return Object.freeze([MEMBER_POLICY, REVIEWER_POLICY]);
}

export function validatePersonSlackApprovalActivationCommandV2(
  value: unknown,
): PersonSlackApprovalActivationCommandV2 {
  const command = exactRecord(value, COMMAND_KEYS);
  const result = {
    command_id: text(command.command_id),
    target_external_identity_link_id: text(
      command.target_external_identity_link_id,
    ),
    provider_connection_id: text(command.provider_connection_id),
    approval_adapter_instance_id: text(command.approval_adapter_instance_id),
    approval_adapter_version: text(command.approval_adapter_version),
    approval_channel_id: text(command.approval_channel_id),
    approve_reaction: text(command.approve_reaction),
    reject_reaction: text(command.reject_reaction),
    policy_capabilities: validatePolicies(command.policy_capabilities),
  } as const;
  if (result.approve_reaction === result.reject_reaction) return denied();
  return Object.freeze(result);
}

function validateAdministrator(
  value: unknown,
): PersonSlackApprovalAdministratorContextV2 {
  const actor = exactRecord(value, ADMIN_KEYS);
  if (
    actor.actor_kind !== "authority-administrator-credential" ||
    actor.membership_type !== "owner"
  ) {
    return denied();
  }
  return Object.freeze({
    actor_kind: actor.actor_kind,
    authority_id: text(actor.authority_id),
    organization_id: text(actor.organization_id),
    state_lineage_id: text(actor.state_lineage_id),
    principal_id: text(actor.principal_id),
    membership_id: text(actor.membership_id),
    membership_type: actor.membership_type,
  });
}

function sameCoordinates(
  value: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
  },
  expected: PersonSlackApprovalAdministratorContextV2,
): boolean {
  return (
    value.authority_id === expected.authority_id &&
    value.organization_id === expected.organization_id &&
    value.state_lineage_id === expected.state_lineage_id
  );
}

function reprove<T>(
  stored: FrozenApprovalContractV2<T> | undefined,
  codec: PersonSlackApprovalActivationCodecV2,
  validate: (value: unknown) => T,
): T {
  if (stored === undefined) return denied();
  try {
    exactRecord(stored, ["body", "sha256"]);
    const body = validate(stored.body);
    if (digest(stored.sha256) !== codec.sha256(body)) return denied();
    return body;
  } catch (error) {
    if (error instanceof PersonSlackApprovalActivationDeniedError) throw error;
    return denied();
  }
}

function exactMembership(
  actual: CurrentAuthorityMembershipV2 | undefined,
  expected: {
    readonly principal_id: string;
    readonly membership_id: string;
    readonly membership_type: PersonMembershipType;
  },
): void {
  if (
    actual === undefined ||
    actual.principal_id !== expected.principal_id ||
    actual.membership_id !== expected.membership_id ||
    actual.membership_type !== expected.membership_type
  ) {
    denied();
  }
}

function semanticCommand(
  administrator: PersonSlackApprovalAdministratorContextV2,
  command: PersonSlackApprovalActivationCommandV2,
): unknown {
  return Object.freeze({
    schema_version: 2,
    kind: PERSON_SLACK_APPROVAL_ACTIVATION_COMMAND_KIND,
    authority_id: administrator.authority_id,
    organization_id: administrator.organization_id,
    state_lineage_id: administrator.state_lineage_id,
    activated_by: administrator,
    command,
  });
}

function semanticResource(
  administrator: PersonSlackApprovalAdministratorContextV2,
  command: PersonSlackApprovalActivationCommandV2,
): unknown {
  const { command_id: _commandId, ...resource } = command;
  return Object.freeze({
    schema_version: 2,
    kind: ACTIVATION_RESOURCE_KIND,
    authority_id: administrator.authority_id,
    organization_id: administrator.organization_id,
    state_lineage_id: administrator.state_lineage_id,
    approval_adapter_kind: "approval-surface",
    approval_adapter_id: "slack-reactions",
    resource,
  });
}

function reproveArtifacts(
  stored: PersonSlackApprovalActivationResultV2,
  resourceSha256: ApprovalContractSha256,
  command: PersonSlackApprovalActivationCommandV2,
  currentAdministrator: PersonSlackApprovalAdministratorContextV2,
  transaction: PersonSlackApprovalActivationTransactionV2,
  codec: PersonSlackApprovalActivationCodecV2,
): Pick<
  PersonSlackApprovalActivationResultV2,
  "approval_binding" | "action_capabilities"
> {
  exactRecord(stored, [
    "command_id",
    "command_semantic_sha256",
    "activation_resource_sha256",
    "activated_by",
    "approval_binding",
    "action_capabilities",
  ]);
  if (
    digest(stored.activation_resource_sha256) !== resourceSha256 ||
    !Array.isArray(stored.action_capabilities) ||
    stored.action_capabilities.length !== CAPABILITY_ORDER.length
  ) {
    return denied();
  }
  const storedAdministrator = validateAdministrator(stored.activated_by);
  const binding = reprove(
    stored.approval_binding,
    codec,
    validatePersonSlackApprovalBindingContractV2,
  );
  const connectionStored = transaction.connectionById(
    command.provider_connection_id,
  );
  const connection = reprove(
    connectionStored,
    codec,
    validateOrganizationToolConnectionContractV2,
  );
  const link = reprove(
    transaction.externalHumanLinkById(command.target_external_identity_link_id),
    codec,
    validateExternalHumanIdentityLinkContractV2,
  );
  if (
    !sameCoordinates(binding, currentAdministrator) ||
    !sameCoordinates(storedAdministrator, currentAdministrator) ||
    !sameCoordinates(connection, currentAdministrator) ||
    !sameCoordinates(link, currentAdministrator) ||
    binding.connection_id !== command.provider_connection_id ||
    binding.connection_contract_sha256 !== connectionStored?.sha256 ||
    connection.connection_id !== binding.connection_id ||
    connection.provider_tenant_id !== link.provider_tenant_id ||
    connection.provider_enterprise_id !== link.provider_enterprise_id ||
    binding.approval_adapter_instance_id !==
      command.approval_adapter_instance_id ||
    binding.approval_adapter_version !== command.approval_adapter_version ||
    binding.approval_channel_id !== command.approval_channel_id ||
    binding.approve_reaction !== command.approve_reaction ||
    binding.reject_reaction !== command.reject_reaction
  ) {
    return denied();
  }
  for (const [index, [policy, action]] of CAPABILITY_ORDER.entries()) {
    const capability = reprove(
      stored.action_capabilities[index],
      codec,
      validatePersonSlackApprovalActionCapabilityV2,
    );
    if (
      !sameCoordinates(capability, currentAdministrator) ||
      capability.approval_binding_id !== binding.approval_binding_id ||
      capability.approval_binding_contract_sha256 !==
        stored.approval_binding.sha256 ||
      capability.external_identity_link_id !==
        command.target_external_identity_link_id ||
      capability.principal_id !== link.principal_id ||
      capability.membership_id !== link.membership_id ||
      capability.membership_type !== link.membership_type ||
      capability.policy_id !== policy.policy_id ||
      capability.policy_contract_sha256 !== policy.policy_contract_sha256 ||
      capability.action !== action
    ) {
      return denied();
    }
  }
  const stableIds = [
    binding.approval_binding_id,
    ...stored.action_capabilities.map(
      ({ body }) => body.action_capability_id,
    ),
  ];
  if (new Set(stableIds).size !== stableIds.length) return denied();
  return {
    approval_binding: stored.approval_binding,
    action_capabilities: stored.action_capabilities,
  };
}

function reproveResult(
  stored: PersonSlackApprovalActivationResultV2,
  expectedCommandId: string,
  expectedSemanticSha256: ApprovalContractSha256,
  resourceSha256: ApprovalContractSha256,
  command: PersonSlackApprovalActivationCommandV2,
  currentAdministrator: PersonSlackApprovalAdministratorContextV2,
  transaction: PersonSlackApprovalActivationTransactionV2,
  codec: PersonSlackApprovalActivationCodecV2,
): PersonSlackApprovalActivationResultV2 {
  if (
    stored.command_id !== expectedCommandId ||
    digest(stored.command_semantic_sha256) !== expectedSemanticSha256
  ) {
    throw new PersonSlackApprovalActivationConflictError();
  }
  const administrator = validateAdministrator(stored.activated_by);
  if (
    administrator.principal_id !== currentAdministrator.principal_id ||
    administrator.membership_id !== currentAdministrator.membership_id
  ) {
    return denied();
  }
  reproveArtifacts(
    stored,
    resourceSha256,
    command,
    currentAdministrator,
    transaction,
    codec,
  );
  return stored;
}

export async function activatePersonSlackApprovalV2(input: {
  readonly credential: unknown;
  readonly command: unknown;
  readonly coordinator: PersonSlackApprovalActivationCoordinatorV2;
  readonly codec: PersonSlackApprovalActivationCodecV2;
  readonly ids: PersonSlackApprovalActivationIdFactoryV2;
}): Promise<PersonSlackApprovalActivationResultV2> {
  const command = validatePersonSlackApprovalActivationCommandV2(input.command);
  return input.coordinator.withStableAdministratorActivation(
    input.credential,
    (fence) => {
      const administrator = validateAdministrator(fence.administrator);
      exactMembership(
        fence.currentMembership({
          principal_id: administrator.principal_id,
          membership_id: administrator.membership_id,
        }),
        administrator,
      );
      const semanticSha256 = input.codec.sha256(
        semanticCommand(administrator, command),
      );
      digest(semanticSha256);
      const resourceSha256 = input.codec.sha256(
        semanticResource(administrator, command),
      );
      digest(resourceSha256);
      const prior = fence.transaction.activationByCommandId(command.command_id);
      if (prior !== undefined) {
        return reproveResult(
          prior,
          command.command_id,
          semanticSha256,
          resourceSha256,
          command,
          administrator,
          fence.transaction,
          input.codec,
        );
      }

      const connectionStored = fence.transaction.connectionById(
        command.provider_connection_id,
      );
      const connection = reprove(
        connectionStored,
        input.codec,
        validateOrganizationToolConnectionContractV2,
      );
      const connectionState = reprove(
        fence.transaction.connectionStateById(command.provider_connection_id),
        input.codec,
        validateOrganizationToolConnectionStateV2,
      );
      const linkStored = fence.transaction.externalHumanLinkById(
        command.target_external_identity_link_id,
      );
      const link = reprove(
        linkStored,
        input.codec,
        validateExternalHumanIdentityLinkContractV2,
      );
      if (
        !sameCoordinates(connection, administrator) ||
        !sameCoordinates(link, administrator) ||
        connection.connection_id !== command.provider_connection_id ||
        link.external_identity_link_id !==
          command.target_external_identity_link_id ||
        connection.connection_id !== connectionState.connection_id ||
        connectionStored === undefined ||
        connectionState.connection_contract_sha256 !==
          connectionStored.sha256 ||
        connectionState.connection_status !== "active" ||
        !connection.required_provider_scopes.every((scope) =>
          connectionState.observed_granted_scopes.includes(scope),
        ) ||
        linkStored === undefined ||
        !fence.transaction.externalHumanLinkIsCurrent({
          external_identity_link_id: link.external_identity_link_id,
          link_contract_sha256: linkStored.sha256,
        }) ||
        connection.provider_tenant_id !== link.provider_tenant_id ||
        connection.provider_enterprise_id !== link.provider_enterprise_id ||
        !fence.transaction.approvalSurfaceIsEligible({
          connection_id: connection.connection_id,
          approval_adapter_id: "slack-reactions",
          approval_adapter_instance_id: command.approval_adapter_instance_id,
          approval_adapter_version: command.approval_adapter_version,
          approval_channel_id: command.approval_channel_id,
          approve_reaction: command.approve_reaction,
          reject_reaction: command.reject_reaction,
        })
      ) {
        return denied();
      }
      exactMembership(
        fence.currentMembership({
          principal_id: link.principal_id,
          membership_id: link.membership_id,
        }),
        link,
      );

      let frozenBinding: FrozenApprovalContractV2<PersonSlackApprovalBindingContractV2>;
      let capabilities: readonly FrozenApprovalContractV2<PersonSlackApprovalActionCapabilityV2>[];
      const existingResource =
        fence.transaction.activationByResourceSha256(resourceSha256);
      if (existingResource !== undefined) {
        const artifacts = reproveArtifacts(
          existingResource,
          resourceSha256,
          command,
          administrator,
          fence.transaction,
          input.codec,
        );
        frozenBinding = artifacts.approval_binding;
        capabilities = artifacts.action_capabilities;
      } else {
        const binding = buildPersonSlackApprovalBindingContractV2({
          authority_id: administrator.authority_id,
          organization_id: administrator.organization_id,
          state_lineage_id: administrator.state_lineage_id,
          approval_binding_id: input.ids.next("approval_binding"),
          connection_id: connection.connection_id,
          connection_contract_sha256: connectionStored.sha256,
          approval_adapter_kind: "approval-surface",
          approval_adapter_id: "slack-reactions",
          approval_adapter_instance_id: command.approval_adapter_instance_id,
          approval_adapter_version: command.approval_adapter_version,
          approval_channel_id: command.approval_channel_id,
          approve_reaction: command.approve_reaction,
          reject_reaction: command.reject_reaction,
          supported_policy_actions: command.policy_capabilities,
        });
        frozenBinding = Object.freeze({
          body: binding,
          sha256: input.codec.sha256(binding),
        });
        digest(frozenBinding.sha256);
        capabilities = CAPABILITY_ORDER.map(([policy, action]) => {
          const body = buildPersonSlackApprovalActionCapabilityV2({
            authority_id: administrator.authority_id,
            organization_id: administrator.organization_id,
            state_lineage_id: administrator.state_lineage_id,
            action_capability_id: input.ids.next("action_capability"),
            approval_binding_id: binding.approval_binding_id,
            approval_binding_contract_sha256: frozenBinding.sha256,
            external_identity_link_id: link.external_identity_link_id,
            principal_id: link.principal_id,
            membership_id: link.membership_id,
            membership_type: link.membership_type,
            policy_id: policy.policy_id as PersonApprovalPolicyId,
            policy_contract_sha256: policy.policy_contract_sha256,
            action: action as PersonApprovalAction,
          });
          return Object.freeze({ body, sha256: input.codec.sha256(body) });
        });
        capabilities.forEach((capability) => digest(capability.sha256));
      }
      const result = Object.freeze({
        command_id: command.command_id,
        command_semantic_sha256: semanticSha256,
        activation_resource_sha256: resourceSha256,
        activated_by: administrator,
        approval_binding: frozenBinding,
        action_capabilities: Object.freeze(capabilities),
      });
      fence.transaction.saveActivation(result);
      return result;
    },
  );
}
