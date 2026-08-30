import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  buildProviderHumanActionDurableResult,
  buildProviderHumanIntegrationAuditEntryV2,
  buildProviderHumanSemanticActionInputV1,
  buildProviderHumanAuthorizationAllowV2,
  buildSlackProviderApprovalMessageV2,
  buildSlackProviderHumanActionV2,
  buildSlackProviderObservationV2,
  validateExternalHumanIdentityLinkContractV2,
  validateOrganizationToolConnectionContractV2,
  validateOrganizationToolConnectionStateV2,
  validatePersonSlackReactionApprovalActionCapabilityV2,
  validatePersonSlackReactionApprovalBindingContractV2,
  validateProviderHumanActionDurableResult,
  validateProviderHumanAuthorizationAllowV2,
  validateProviderHumanIntegrationAuditEntryV2,
  validateProviderHumanSemanticActionInputV1,
  validateSlackProviderApprovalMessageV2,
  validateSlackProviderHumanActionV2,
  validateSlackProviderObservationV2,
  type ApprovalContractSha256,
  type ExternalHumanIdentityLinkContractV2,
  type OrganizationToolConnectionContractV2,
  type OrganizationToolConnectionStateV2,
  type PersonApprovalAction,
  type PersonApprovalPolicyId,
  type PersonSlackReactionApprovalActionCapabilityV2,
  type PersonSlackReactionApprovalBindingContractV2,
  type ProviderHumanActionContractSetV2,
  type ProviderHumanActionDurableResult,
  type ProviderHumanSemanticActionInputV1,
} from "./person-slack-reaction-approval-contracts-v2.js";
import type {
  CurrentAuthorityMembershipV2,
  FrozenApprovalContractV2,
} from "./person-slack-reaction-approval-activation-v2.js";

const PROVIDER_EXPECTATION_KIND =
  "echo-person-slack-provider-expectation-v2" as const;

export interface RevalidatedFrozenPersonSlackReactionApprovalV2 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly status: "pending";
  readonly connection_id: string;
  readonly connection_contract_sha256: ApprovalContractSha256;
  readonly approval_binding_id: string;
  readonly approval_binding_contract_sha256: ApprovalContractSha256;
  readonly approval_channel_id: string;
  readonly provider_message_ts: string;
  readonly policy_id: PersonApprovalPolicyId;
  readonly policy_contract_sha256: ApprovalContractSha256;
  readonly policy_consequence_sha256: ApprovalContractSha256;
  readonly frozen_card_sha256: ApprovalContractSha256;
  readonly approved_snapshot_sha256: ApprovalContractSha256;
}

export interface PersonSlackReactionApprovalProviderExpectationV2 {
  readonly schema_version: 2;
  readonly kind: typeof PROVIDER_EXPECTATION_KIND;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly connection_id: string;
  readonly connection_contract_sha256: ApprovalContractSha256;
  readonly connection_state_sha256: ApprovalContractSha256;
  readonly provider_issuer: "https://slack.com";
  readonly provider_tenant_kind: "workspace";
  readonly provider_tenant_id: string;
  readonly provider_enterprise_id: string | null;
  readonly tool_kind: "slack";
  readonly provider_app_id: string;
  readonly provider_bot_id: string;
  readonly provider_bot_user_id: string;
  readonly approval_binding_id: string;
  readonly approval_binding_contract_sha256: ApprovalContractSha256;
  readonly approval_adapter_kind: "approval-surface";
  readonly approval_adapter_id: string;
  readonly approval_adapter_instance_id: string;
  readonly approval_adapter_version: string;
  readonly approval_channel_id: string;
  readonly provider_message_ts: string;
  readonly approve_reaction: string;
  readonly reject_reaction: string;
  readonly policy_id: PersonApprovalPolicyId;
  readonly policy_contract_sha256: ApprovalContractSha256;
  readonly policy_consequence_sha256: ApprovalContractSha256;
  readonly frozen_card_sha256: ApprovalContractSha256;
  readonly approved_snapshot_sha256: ApprovalContractSha256;
}

export type PersonSlackReactionApprovalProviderResultV2 =
  | {
      readonly kind: "not_resolved";
      readonly reason:
        | "absent"
        | "conflicting_reactions"
        | "incomplete_roster"
        | "provider_mismatch";
    }
  | {
      readonly kind: "observed";
      readonly expectation_sha256: ApprovalContractSha256;
      readonly provider_actor_subject: string;
      readonly observed_reaction: string;
      readonly observed_action: PersonApprovalAction;
      readonly provider_response_evidence_sha256: ApprovalContractSha256;
      readonly observed_at: string;
    };

export type PersonSlackReactionApprovalFinalizationResultV2 =
  | { readonly kind: "not_resolved"; readonly reason: string }
  | { readonly kind: "resolved"; readonly value: ProviderHumanActionDurableResult };

export interface StoredProviderHumanActionV2 {
  readonly contracts: ProviderHumanActionContractSetV2;
  readonly semantic_action: ProviderHumanSemanticActionInputV1;
  readonly semantic_action_sha256: ApprovalContractSha256;
  readonly result: ProviderHumanActionDurableResult;
}

export interface PersonSlackReactionApprovalFinalizationTransactionV2 {
  durableActionByApprovalId(
    approvalId: string,
  ): StoredProviderHumanActionV2 | undefined;
  connectionById(
    connectionId: string,
  ): FrozenApprovalContractV2<OrganizationToolConnectionContractV2> | undefined;
  connectionStateById(
    connectionId: string,
  ): FrozenApprovalContractV2<OrganizationToolConnectionStateV2> | undefined;
  approvalBindingById(
    bindingId: string,
  ): FrozenApprovalContractV2<PersonSlackReactionApprovalBindingContractV2> | undefined;
  approvalBindingIsCurrent(input: {
    readonly approval_binding_id: string;
    readonly approval_binding_contract_sha256: ApprovalContractSha256;
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
  externalHumanLinkByProviderActor(input: {
    readonly provider_issuer: "https://slack.com";
    readonly provider_tenant_kind: "workspace";
    readonly provider_tenant_id: string;
    readonly provider_enterprise_id: string | null;
    readonly provider_subject_id: string;
  }): FrozenApprovalContractV2<ExternalHumanIdentityLinkContractV2> | undefined;
  externalHumanLinkIsCurrent(input: {
    readonly external_identity_link_id: string;
    readonly link_contract_sha256: ApprovalContractSha256;
  }): boolean;
  actionCapability(input: {
    readonly approval_binding_id: string;
    readonly external_identity_link_id: string;
    readonly policy_id: PersonApprovalPolicyId;
    readonly action: PersonApprovalAction;
  }): FrozenApprovalContractV2<PersonSlackReactionApprovalActionCapabilityV2> | undefined;
  actionCapabilityIsCurrent(input: {
    readonly action_capability_id: string;
    readonly action_capability_contract_sha256: ApprovalContractSha256;
  }): boolean;
  auditHead():
    | { readonly audit_sequence: number; readonly audit_entry_sha256: ApprovalContractSha256 }
    | null;
  auditHeadIsVerified(
    input:
      | {
          readonly audit_sequence: number;
          readonly audit_entry_sha256: ApprovalContractSha256;
        }
      | null,
  ): boolean;
  auditEntryIsInVerifiedChain(input: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
    readonly audit_event_id: string;
    readonly audit_sequence: number;
    readonly audit_entry_sha256: ApprovalContractSha256;
    readonly predecessor_entry_sha256: ApprovalContractSha256 | null;
  }): boolean;
  saveHumanAction(value: StoredProviderHumanActionV2): void;
}

export interface PersonSlackReactionApprovalFinalizationFenceV2 {
  revalidatedFrozenApprovalById(
    approvalId: string,
  ): RevalidatedFrozenPersonSlackReactionApprovalV2 | undefined;
  /**
   * Authority-owned lineage fence. A pending approval is actionable only
   * while it remains the current review round for its source lineage.
   */
  approvalIsCurrent(approvalId: string): boolean;
  currentMembership(input: {
    readonly principal_id: string;
    readonly membership_id: string;
  }): CurrentAuthorityMembershipV2 | undefined;
  readonly transaction: PersonSlackReactionApprovalFinalizationTransactionV2;
}

export interface PersonSlackReactionApprovalFinalizationCoordinatorV2 {
  /**
   * Candidate cross-role fence. Phase 3 must supply the concrete Authority and
   * control-plane locking order; this private slice proves only orchestration.
   */
  withStableProviderHumanAction<T>(
    commit: (fence: PersonSlackReactionApprovalFinalizationFenceV2) => T,
  ): Promise<T>;
}

export interface PersonSlackReactionApprovalObserverV2 {
  /**
   * Independently re-observes the frozen Slack object and human roster. It
   * must not trust a prior approval-surface observation or return ECHO IDs.
   */
  observeApprovalReaction(
    expectation: PersonSlackReactionApprovalProviderExpectationV2,
    expectationSha256: ApprovalContractSha256,
    signal?: AbortSignal,
  ): Promise<PersonSlackReactionApprovalProviderResultV2>;
}

export interface PersonSlackReactionApprovalFinalizationCodecV2 {
  sha256(value: unknown): ApprovalContractSha256;
}

export interface PersonSlackReactionApprovalFinalizationIdFactoryV2 {
  next(kind: "audit_event" | "correlation"): string;
}

export class PersonSlackReactionApprovalFinalizationDeniedError extends Error {}
export class PersonSlackReactionApprovalFinalizationConflictError extends Error {}

const FROZEN_APPROVAL_KEYS = [
  "authority_id",
  "organization_id",
  "state_lineage_id",
  "approval_id",
  "status",
  "connection_id",
  "connection_contract_sha256",
  "approval_binding_id",
  "approval_binding_contract_sha256",
  "approval_channel_id",
  "provider_message_ts",
  "policy_id",
  "policy_contract_sha256",
  "policy_consequence_sha256",
  "frozen_card_sha256",
  "approved_snapshot_sha256",
] as const;

function denied(): never {
  throw new PersonSlackReactionApprovalFinalizationDeniedError();
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return denied();
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) return denied();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) return denied();
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
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
  ) return denied();
  return value;
}

function sha256(value: unknown): ApprovalContractSha256 {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) return denied();
  return value as ApprovalContractSha256;
}

function sameCoordinates(
  value: { readonly authority_id: string; readonly organization_id: string; readonly state_lineage_id: string },
  expected: RevalidatedFrozenPersonSlackReactionApprovalV2,
): boolean {
  return value.authority_id === expected.authority_id &&
    value.organization_id === expected.organization_id &&
    value.state_lineage_id === expected.state_lineage_id;
}

function revalidate<T>(
  stored: FrozenApprovalContractV2<T> | undefined,
  codec: PersonSlackReactionApprovalFinalizationCodecV2,
  validate: (value: unknown) => T,
): FrozenApprovalContractV2<T> {
  if (stored === undefined) return denied();
  try {
    exact(stored, ["body", "sha256"]);
    const body = validate(stored.body);
    const digest = sha256(stored.sha256);
    if (digest !== codec.sha256(body)) return denied();
    return Object.freeze({ body, sha256: digest });
  } catch (error) {
    if (error instanceof PersonSlackReactionApprovalFinalizationDeniedError) throw error;
    return denied();
  }
}

function frozenApproval(value: unknown): RevalidatedFrozenPersonSlackReactionApprovalV2 {
  const row = exact(value, FROZEN_APPROVAL_KEYS);
  if (row.status !== "pending") return denied();
  for (const field of [
    "authority_id", "organization_id", "state_lineage_id", "approval_id",
    "connection_id", "approval_binding_id", "approval_channel_id", "provider_message_ts",
  ] as const) text(row[field]);
  for (const field of [
    "connection_contract_sha256", "approval_binding_contract_sha256",
    "policy_contract_sha256", "policy_consequence_sha256", "frozen_card_sha256",
    "approved_snapshot_sha256",
  ] as const) sha256(row[field]);
  if (
    row.policy_id !== "organization-member-readable-person-v2" &&
    row.policy_id !== "restricted-reviewer-person-v2"
  ) return denied();
  const exactPolicy =
    row.policy_id === "organization-member-readable-person-v2"
      ? [
          ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
          ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
        ]
      : [
          RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
          RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
        ];
  if (
    row.policy_contract_sha256 !== exactPolicy[0] ||
    row.policy_consequence_sha256 !== exactPolicy[1]
  ) return denied();
  return Object.freeze(row) as unknown as RevalidatedFrozenPersonSlackReactionApprovalV2;
}

interface PreparedAction {
  readonly approval: RevalidatedFrozenPersonSlackReactionApprovalV2;
  readonly approval_sha256: ApprovalContractSha256;
  readonly connection: FrozenApprovalContractV2<OrganizationToolConnectionContractV2>;
  readonly connection_state: FrozenApprovalContractV2<OrganizationToolConnectionStateV2>;
  readonly binding: FrozenApprovalContractV2<PersonSlackReactionApprovalBindingContractV2>;
  readonly expectation: PersonSlackReactionApprovalProviderExpectationV2;
  readonly expectation_sha256: ApprovalContractSha256;
}

function prepare(
  fence: PersonSlackReactionApprovalFinalizationFenceV2,
  approvalId: string,
  codec: PersonSlackReactionApprovalFinalizationCodecV2,
): PreparedAction {
  const approval = frozenApproval(fence.revalidatedFrozenApprovalById(approvalId));
  const connectionStored = revalidate(
    fence.transaction.connectionById(approval.connection_id),
    codec,
    validateOrganizationToolConnectionContractV2,
  );
  const connection = connectionStored.body;
  const stateStored = revalidate(
    fence.transaction.connectionStateById(approval.connection_id),
    codec,
    validateOrganizationToolConnectionStateV2,
  );
  const state = stateStored.body;
  const bindingStored = revalidate(
    fence.transaction.approvalBindingById(approval.approval_binding_id),
    codec,
    validatePersonSlackReactionApprovalBindingContractV2,
  );
  const binding = bindingStored.body;
  if (
    approval.approval_id !== approvalId ||
    !sameCoordinates(connection, approval) ||
    !sameCoordinates(binding, approval) ||
    approval.connection_contract_sha256 !== connectionStored.sha256 ||
    approval.approval_binding_contract_sha256 !== bindingStored.sha256 ||
    connection.connection_id !== approval.connection_id ||
    state.connection_id !== connection.connection_id ||
    state.connection_contract_sha256 !== connectionStored.sha256 ||
    state.connection_status !== "active" ||
    !connection.required_provider_scopes.every((scope) =>
      state.observed_granted_scopes.includes(scope),
    ) ||
    binding.connection_id !== connection.connection_id ||
    binding.connection_contract_sha256 !== connectionStored.sha256 ||
    binding.approval_binding_id !== approval.approval_binding_id ||
    binding.approval_adapter_id !== "slack-reactions" ||
    binding.approval_channel_id !== approval.approval_channel_id ||
    !fence.transaction.approvalSurfaceIsEligible({
      connection_id: connection.connection_id,
      approval_adapter_id: "slack-reactions",
      approval_adapter_instance_id: binding.approval_adapter_instance_id,
      approval_adapter_version: binding.approval_adapter_version,
      approval_channel_id: binding.approval_channel_id,
      approve_reaction: binding.approve_reaction,
      reject_reaction: binding.reject_reaction,
    }) ||
    !fence.transaction.approvalBindingIsCurrent({
      approval_binding_id: binding.approval_binding_id,
      approval_binding_contract_sha256: bindingStored.sha256,
    }) ||
    !binding.supported_policy_actions.some(
      (policy) => policy.policy_id === approval.policy_id &&
        policy.policy_contract_sha256 === approval.policy_contract_sha256,
    )
  ) return denied();
  const expectation = Object.freeze({
    schema_version: 2 as const,
    kind: PROVIDER_EXPECTATION_KIND,
    authority_id: approval.authority_id,
    organization_id: approval.organization_id,
    state_lineage_id: approval.state_lineage_id,
    approval_id: approval.approval_id,
    connection_id: connection.connection_id,
    connection_contract_sha256: connectionStored.sha256,
    connection_state_sha256: stateStored.sha256,
    provider_issuer: connection.provider_issuer,
    provider_tenant_kind: connection.provider_tenant_kind,
    provider_tenant_id: connection.provider_tenant_id,
    provider_enterprise_id: connection.provider_enterprise_id,
    tool_kind: connection.tool_kind,
    provider_app_id: connection.provider_app_id,
    provider_bot_id: connection.provider_bot_id,
    provider_bot_user_id: connection.provider_bot_user_id,
    approval_binding_id: binding.approval_binding_id,
    approval_binding_contract_sha256: bindingStored.sha256,
    approval_adapter_kind: binding.approval_adapter_kind,
    approval_adapter_id: binding.approval_adapter_id,
    approval_adapter_instance_id: binding.approval_adapter_instance_id,
    approval_adapter_version: binding.approval_adapter_version,
    approval_channel_id: approval.approval_channel_id,
    provider_message_ts: approval.provider_message_ts,
    approve_reaction: binding.approve_reaction,
    reject_reaction: binding.reject_reaction,
    policy_id: approval.policy_id,
    policy_contract_sha256: approval.policy_contract_sha256,
    policy_consequence_sha256: approval.policy_consequence_sha256,
    frozen_card_sha256: approval.frozen_card_sha256,
    approved_snapshot_sha256: approval.approved_snapshot_sha256,
  });
  return {
    approval,
    approval_sha256: codec.sha256(approval),
    connection: connectionStored,
    connection_state: stateStored,
    binding: bindingStored,
    expectation,
    expectation_sha256: codec.sha256(expectation),
  };
}

function revalidateStoredUnchecked(
  stored: StoredProviderHumanActionV2,
  codec: PersonSlackReactionApprovalFinalizationCodecV2,
): { readonly result: ProviderHumanActionDurableResult; readonly set: ProviderHumanActionContractSetV2 } {
  exact(stored, ["contracts", "semantic_action", "semantic_action_sha256", "result"]);
  const set = stored.contracts;
  exact(set, [
    "connection",
    "connection_contract_sha256",
    "connection_state",
    "connection_state_sha256",
    "external_human_link",
    "external_identity_link_contract_sha256",
    "approval_binding",
    "approval_binding_contract_sha256",
    "action_capability",
    "action_capability_contract_sha256",
    "provider_observation",
    "provider_observation_sha256",
    "provider_message",
    "provider_message_sha256",
    "provider_action",
    "provider_action_sha256",
    "authorization_allow",
    "authorization_proof_sha256",
    "audit_entry",
    "audit_entry_sha256",
  ]);
  const validators: readonly [unknown, ApprovalContractSha256, (value: unknown) => unknown][] = [
    [set.connection, set.connection_contract_sha256, validateOrganizationToolConnectionContractV2],
    [set.connection_state, set.connection_state_sha256, validateOrganizationToolConnectionStateV2],
    [
      set.external_human_link,
      set.external_identity_link_contract_sha256,
      validateExternalHumanIdentityLinkContractV2,
    ],
    [set.approval_binding, set.approval_binding_contract_sha256, validatePersonSlackReactionApprovalBindingContractV2],
    [set.action_capability, set.action_capability_contract_sha256, validatePersonSlackReactionApprovalActionCapabilityV2],
    [set.provider_observation, set.provider_observation_sha256, validateSlackProviderObservationV2],
    [set.provider_message, set.provider_message_sha256, validateSlackProviderApprovalMessageV2],
    [set.provider_action, set.provider_action_sha256, validateSlackProviderHumanActionV2],
    [set.authorization_allow, set.authorization_proof_sha256, validateProviderHumanAuthorizationAllowV2],
    [set.audit_entry, set.audit_entry_sha256, validateProviderHumanIntegrationAuditEntryV2],
  ];
  for (const [body, expected, validate] of validators) {
    const validated = validate(body);
    if (codec.sha256(validated) !== sha256(expected)) return denied();
  }
  const semantic = buildProviderHumanSemanticActionInputV1(set);
  const storedSemantic = validateProviderHumanSemanticActionInputV1(stored.semantic_action);
  if (
    codec.sha256(semantic) !== sha256(stored.semantic_action_sha256) ||
    codec.sha256(storedSemantic) !== stored.semantic_action_sha256
  ) return denied();
  const derived = buildProviderHumanActionDurableResult(set);
  const storedResult = validateProviderHumanActionDurableResult(stored.result);
  if (codec.sha256(derived) !== codec.sha256(storedResult)) return denied();
  return { result: derived, set };
}

function revalidateStored(
  stored: StoredProviderHumanActionV2,
  codec: PersonSlackReactionApprovalFinalizationCodecV2,
): { readonly result: ProviderHumanActionDurableResult; readonly set: ProviderHumanActionContractSetV2 } {
  try {
    return revalidateStoredUnchecked(stored, codec);
  } catch (error) {
    if (error instanceof PersonSlackReactionApprovalFinalizationDeniedError) throw error;
    return denied();
  }
}

function exactMembership(
  actual: CurrentAuthorityMembershipV2 | undefined,
  expected: ExternalHumanIdentityLinkContractV2,
): void {
  if (
    actual === undefined || actual.principal_id !== expected.principal_id ||
    actual.membership_id !== expected.membership_id ||
    actual.membership_type !== expected.membership_type
  ) denied();
}

function samePrepared(current: PreparedAction, prior: PreparedAction): void {
  if (
    current.approval_sha256 !== prior.approval_sha256 ||
    current.connection.sha256 !== prior.connection.sha256 ||
    current.connection_state.sha256 !== prior.connection_state.sha256 ||
    current.binding.sha256 !== prior.binding.sha256 ||
    current.expectation_sha256 !== prior.expectation_sha256
  ) denied();
}

function expectationFromStored(
  set: ProviderHumanActionContractSetV2,
): PersonSlackReactionApprovalProviderExpectationV2 {
  const connection = set.connection;
  const binding = set.approval_binding;
  const message = set.provider_message;
  const action = set.provider_action;
  return Object.freeze({
    schema_version: 2,
    kind: PROVIDER_EXPECTATION_KIND,
    authority_id: action.authority_id,
    organization_id: action.organization_id,
    state_lineage_id: action.state_lineage_id,
    approval_id: action.approval_id,
    connection_id: connection.connection_id,
    connection_contract_sha256: set.connection_contract_sha256,
    connection_state_sha256: set.connection_state_sha256,
    provider_issuer: connection.provider_issuer,
    provider_tenant_kind: connection.provider_tenant_kind,
    provider_tenant_id: connection.provider_tenant_id,
    provider_enterprise_id: connection.provider_enterprise_id,
    tool_kind: connection.tool_kind,
    provider_app_id: connection.provider_app_id,
    provider_bot_id: connection.provider_bot_id,
    provider_bot_user_id: connection.provider_bot_user_id,
    approval_binding_id: binding.approval_binding_id,
    approval_binding_contract_sha256:
      set.approval_binding_contract_sha256,
    approval_adapter_kind: binding.approval_adapter_kind,
    approval_adapter_id: binding.approval_adapter_id,
    approval_adapter_instance_id: binding.approval_adapter_instance_id,
    approval_adapter_version: binding.approval_adapter_version,
    approval_channel_id: message.approval_channel_id,
    provider_message_ts: message.provider_message_ts,
    approve_reaction: message.approve_reaction,
    reject_reaction: message.reject_reaction,
    policy_id: action.policy_id,
    policy_contract_sha256: action.policy_contract_sha256,
    policy_consequence_sha256: action.policy_consequence_sha256,
    frozen_card_sha256: action.frozen_card_sha256,
    approved_snapshot_sha256: action.approved_snapshot_sha256,
  });
}

function recoverStoredForApproval(
  stored: StoredProviderHumanActionV2,
  approvalId: string,
  transaction: PersonSlackReactionApprovalFinalizationTransactionV2,
  codec: PersonSlackReactionApprovalFinalizationCodecV2,
): { readonly result: ProviderHumanActionDurableResult; readonly set: ProviderHumanActionContractSetV2 } {
  const recovered = revalidateStored(stored, codec);
  const semantic = buildProviderHumanSemanticActionInputV1(recovered.set);
  const audit = recovered.set.audit_entry;
  if (
    recovered.result.approval_id !== approvalId ||
    semantic.approval_id !== approvalId ||
    audit.subject_id !== approvalId ||
    !transaction.auditEntryIsInVerifiedChain({
      authority_id: audit.authority_id,
      organization_id: audit.organization_id,
      state_lineage_id: audit.state_lineage_id,
      audit_event_id: audit.audit_event_id,
      audit_sequence: audit.audit_sequence,
      audit_entry_sha256: recovered.set.audit_entry_sha256,
      predecessor_entry_sha256: audit.predecessor_entry_sha256,
    })
  ) {
    return denied();
  }
  return recovered;
}

function verifiedAuditHead(
  value:
    | {
        readonly audit_sequence: number;
        readonly audit_entry_sha256: ApprovalContractSha256;
      }
    | null,
  transaction: PersonSlackReactionApprovalFinalizationTransactionV2,
):
  | {
      readonly audit_sequence: number;
      readonly audit_entry_sha256: ApprovalContractSha256;
    }
  | null {
  if (value === null) {
    if (!transaction.auditHeadIsVerified(null)) return denied();
    return null;
  }
  const record = exact(value, ["audit_sequence", "audit_entry_sha256"]);
  if (
    typeof record.audit_sequence !== "number" ||
    !Number.isSafeInteger(record.audit_sequence) ||
    record.audit_sequence < 1
  ) {
    return denied();
  }
  const head = Object.freeze({
    audit_sequence: record.audit_sequence,
    audit_entry_sha256: sha256(record.audit_entry_sha256),
  });
  if (!transaction.auditHeadIsVerified(head)) return denied();
  return head;
}

function validateObservation(
  value: PersonSlackReactionApprovalProviderResultV2,
  prepared: PreparedAction,
): Exclude<PersonSlackReactionApprovalProviderResultV2, { kind: "not_resolved" }> {
  const observed = exact(value, [
    "kind", "expectation_sha256", "provider_actor_subject", "observed_reaction",
    "observed_action", "provider_response_evidence_sha256", "observed_at",
  ]);
  if (observed.kind !== "observed") return denied();
  if (
    observed.expectation_sha256 !== prepared.expectation_sha256 ||
    (observed.observed_action !== "approve" && observed.observed_action !== "reject") ||
    observed.observed_reaction !==
      (observed.observed_action === "approve"
        ? prepared.expectation.approve_reaction
        : prepared.expectation.reject_reaction)
  ) denied();
  text(observed.provider_actor_subject);
  text(observed.observed_reaction);
  sha256(observed.provider_response_evidence_sha256);
  text(observed.observed_at);
  return Object.freeze({ ...observed }) as Exclude<
    PersonSlackReactionApprovalProviderResultV2,
    { kind: "not_resolved" }
  >;
}

function buildStoredAction(input: {
  readonly prepared: PreparedAction;
  readonly observed: Exclude<PersonSlackReactionApprovalProviderResultV2, { kind: "not_resolved" }>;
  readonly link: FrozenApprovalContractV2<ExternalHumanIdentityLinkContractV2>;
  readonly capability: FrozenApprovalContractV2<PersonSlackReactionApprovalActionCapabilityV2>;
  readonly audit_event_id: string;
  readonly correlation_id: string;
  readonly audit_sequence: number;
  readonly predecessor_entry_sha256: ApprovalContractSha256 | null;
  readonly committed_at: string;
  readonly codec: PersonSlackReactionApprovalFinalizationCodecV2;
}): StoredProviderHumanActionV2 {
  const { expectation: expected } = input.prepared;
  const observation = buildSlackProviderObservationV2({
    authority_id: expected.authority_id,
    organization_id: expected.organization_id,
    state_lineage_id: expected.state_lineage_id,
    provider_issuer: expected.provider_issuer,
    provider_tenant_kind: expected.provider_tenant_kind,
    provider_tenant_id: expected.provider_tenant_id,
    provider_enterprise_id: expected.provider_enterprise_id,
    tool_kind: expected.tool_kind,
    connection_id: expected.connection_id,
    connection_contract_sha256: expected.connection_contract_sha256,
    connection_state_sha256: expected.connection_state_sha256,
    approval_adapter_kind: expected.approval_adapter_kind,
    approval_adapter_id: expected.approval_adapter_id,
    approval_adapter_instance_id: expected.approval_adapter_instance_id,
    approval_adapter_version: expected.approval_adapter_version,
    provider_object_kind: "slack_message_reaction",
    approval_channel_id: expected.approval_channel_id,
    provider_message_ts: expected.provider_message_ts,
    provider_actor_subject: input.observed.provider_actor_subject,
    observed_reaction: input.observed.observed_reaction,
    observed_action: input.observed.observed_action,
    provider_response_evidence_sha256: input.observed.provider_response_evidence_sha256,
    observed_at: input.observed.observed_at,
  });
  const observationSha256 = input.codec.sha256(observation);
  const message = buildSlackProviderApprovalMessageV2({
    authority_id: expected.authority_id,
    organization_id: expected.organization_id,
    state_lineage_id: expected.state_lineage_id,
    audit_event_id: input.audit_event_id,
    provider_issuer: expected.provider_issuer,
    provider_tenant_kind: expected.provider_tenant_kind,
    provider_tenant_id: expected.provider_tenant_id,
    provider_enterprise_id: expected.provider_enterprise_id,
    tool_kind: expected.tool_kind,
    connection_id: expected.connection_id,
    connection_contract_sha256: expected.connection_contract_sha256,
    connection_state_sha256: expected.connection_state_sha256,
    provider_app_id: expected.provider_app_id,
    provider_bot_id: expected.provider_bot_id,
    provider_bot_user_id: expected.provider_bot_user_id,
    approval_binding_id: expected.approval_binding_id,
    approval_binding_contract_sha256: expected.approval_binding_contract_sha256,
    approval_adapter_kind: expected.approval_adapter_kind,
    approval_adapter_id: expected.approval_adapter_id,
    approval_adapter_instance_id: expected.approval_adapter_instance_id,
    approval_adapter_version: expected.approval_adapter_version,
    approval_channel_id: expected.approval_channel_id,
    provider_message_ts: expected.provider_message_ts,
    provider_actor_subject: input.observed.provider_actor_subject,
    observed_reaction: input.observed.observed_reaction,
    approval_id: expected.approval_id,
    policy_id: expected.policy_id,
    policy_contract_sha256: expected.policy_contract_sha256,
    frozen_card_sha256: expected.frozen_card_sha256,
    approved_snapshot_sha256: expected.approved_snapshot_sha256,
    policy_consequence_sha256: expected.policy_consequence_sha256,
    approve_reaction: expected.approve_reaction,
    reject_reaction: expected.reject_reaction,
    observed_at: input.observed.observed_at,
    provider_observation_sha256: observationSha256,
  });
  const messageSha256 = input.codec.sha256(message);
  const action = buildSlackProviderHumanActionV2({
    authority_id: expected.authority_id,
    organization_id: expected.organization_id,
    state_lineage_id: expected.state_lineage_id,
    provider_issuer: expected.provider_issuer,
    provider_tenant_kind: expected.provider_tenant_kind,
    provider_tenant_id: expected.provider_tenant_id,
    provider_enterprise_id: expected.provider_enterprise_id,
    tool_kind: expected.tool_kind,
    connection_id: expected.connection_id,
    connection_contract_sha256: expected.connection_contract_sha256,
    connection_state_sha256: expected.connection_state_sha256,
    approval_binding_id: expected.approval_binding_id,
    approval_binding_contract_sha256: expected.approval_binding_contract_sha256,
    approval_adapter_kind: expected.approval_adapter_kind,
    approval_adapter_id: expected.approval_adapter_id,
    approval_adapter_instance_id: expected.approval_adapter_instance_id,
    approval_adapter_version: expected.approval_adapter_version,
    external_identity_link_id: input.link.body.external_identity_link_id,
    external_identity_link_contract_sha256: input.link.sha256,
    principal_id: input.link.body.principal_id,
    membership_id: input.link.body.membership_id,
    membership_type: input.link.body.membership_type,
    action_capability_id: input.capability.body.action_capability_id,
    action_capability_contract_sha256: input.capability.sha256,
    provider_object_kind: "slack_message_reaction",
    approval_channel_id: expected.approval_channel_id,
    provider_message_ts: expected.provider_message_ts,
    provider_actor_subject: input.observed.provider_actor_subject,
    action: input.observed.observed_action,
    approval_id: expected.approval_id,
    policy_id: expected.policy_id,
    policy_contract_sha256: expected.policy_contract_sha256,
    policy_consequence_sha256: expected.policy_consequence_sha256,
    frozen_card_sha256: expected.frozen_card_sha256,
    approved_snapshot_sha256: expected.approved_snapshot_sha256,
    provider_message_sha256: messageSha256,
    provider_observation_sha256: observationSha256,
    observed_at: input.observed.observed_at,
  });
  const actionSha256 = input.codec.sha256(action);
  const authorization = buildProviderHumanAuthorizationAllowV2({
    authority_id: expected.authority_id,
    organization_id: expected.organization_id,
    state_lineage_id: expected.state_lineage_id,
    approval_id: expected.approval_id,
    action: input.observed.observed_action,
    policy_id: expected.policy_id,
    policy_contract_sha256: expected.policy_contract_sha256,
    principal_id: input.link.body.principal_id,
    membership_id: input.link.body.membership_id,
    membership_type: input.link.body.membership_type,
    action_capability_id: input.capability.body.action_capability_id,
    action_capability_contract_sha256: input.capability.sha256,
    provider_observation_sha256: observationSha256,
    provider_message_sha256: messageSha256,
    provider_action_sha256: actionSha256,
    frozen_card_sha256: expected.frozen_card_sha256,
    decision: "allow",
    evaluated_at: input.committed_at,
  });
  const authorizationSha256 = input.codec.sha256(authorization);
  const audit = buildProviderHumanIntegrationAuditEntryV2({
    authority_id: expected.authority_id,
    organization_id: expected.organization_id,
    state_lineage_id: expected.state_lineage_id,
    audit_event_id: input.audit_event_id,
    audit_sequence: input.audit_sequence,
    actor_class: "provider_human",
    external_identity_link_id: input.link.body.external_identity_link_id,
    connection_id: expected.connection_id,
    approval_binding_id: expected.approval_binding_id,
    action_capability_id: input.capability.body.action_capability_id,
    principal_id: input.link.body.principal_id,
    membership_id: input.link.body.membership_id,
    action: input.observed.observed_action,
    subject_kind: "approval",
    subject_id: expected.approval_id,
    event_digest: observationSha256,
    detail_digest: authorizationSha256,
    provider_message_sha256: messageSha256,
    provider_action_sha256: actionSha256,
    correlation_id: input.correlation_id,
    occurred_at: input.committed_at,
    predecessor_entry_sha256: input.predecessor_entry_sha256,
  });
  const set: ProviderHumanActionContractSetV2 = {
    connection: input.prepared.connection.body,
    connection_contract_sha256: input.prepared.connection.sha256,
    connection_state: input.prepared.connection_state.body,
    connection_state_sha256: input.prepared.connection_state.sha256,
    external_human_link: input.link.body,
    external_identity_link_contract_sha256: input.link.sha256,
    approval_binding: input.prepared.binding.body,
    approval_binding_contract_sha256: input.prepared.binding.sha256,
    action_capability: input.capability.body,
    action_capability_contract_sha256: input.capability.sha256,
    provider_observation: observation,
    provider_observation_sha256: observationSha256,
    provider_message: message,
    provider_message_sha256: messageSha256,
    provider_action: action,
    provider_action_sha256: actionSha256,
    authorization_allow: authorization,
    authorization_proof_sha256: authorizationSha256,
    audit_entry: audit,
    audit_entry_sha256: input.codec.sha256(audit),
  };
  const semanticAction = buildProviderHumanSemanticActionInputV1(set);
  return {
    contracts: set,
    semantic_action: semanticAction,
    semantic_action_sha256: input.codec.sha256(semanticAction),
    result: buildProviderHumanActionDurableResult(set),
  };
}

export async function finalizePersonSlackReactionApprovalV2(input: {
  readonly command: unknown;
  readonly coordinator: PersonSlackReactionApprovalFinalizationCoordinatorV2;
  readonly provider: PersonSlackReactionApprovalObserverV2;
  readonly codec: PersonSlackReactionApprovalFinalizationCodecV2;
  readonly ids: PersonSlackReactionApprovalFinalizationIdFactoryV2;
  readonly now: () => string;
  readonly signal?: AbortSignal;
}): Promise<PersonSlackReactionApprovalFinalizationResultV2> {
  const command = exact(input.command, ["approval_id"]);
  const approvalId = text(command.approval_id);
  const first = await input.coordinator.withStableProviderHumanAction((fence) => {
    const prior = fence.transaction.durableActionByApprovalId(approvalId);
    if (prior !== undefined) {
      return {
        kind: "recovered" as const,
        ...recoverStoredForApproval(
          prior,
          approvalId,
          fence.transaction,
          input.codec,
        ),
      };
    }
    if (!fence.approvalIsCurrent(approvalId)) {
      return { kind: "not_resolved" as const, reason: "superseded" as const };
    }
    return { kind: "prepared" as const, value: prepare(fence, approvalId, input.codec) };
  });
  if (first.kind === "recovered") return { kind: "resolved", value: first.result };
  if (first.kind === "not_resolved") return first;
  const providerResult = await input.provider.observeApprovalReaction(
    first.value.expectation,
    first.value.expectation_sha256,
    input.signal,
  );
  input.signal?.throwIfAborted();
  const providerKind =
    providerResult !== null && typeof providerResult === "object"
      ? Object.getOwnPropertyDescriptor(providerResult, "kind")?.value
      : undefined;
  if (providerKind === "not_resolved") {
    const notResolved = exact(providerResult, ["kind", "reason"]);
    const reason = notResolved.reason;
    if (
      reason !== "absent" &&
      reason !== "conflicting_reactions" &&
      reason !== "incomplete_roster" &&
      reason !== "provider_mismatch"
    ) denied();
    return { kind: "not_resolved", reason };
  }
  const observed = validateObservation(providerResult, first.value);
  return input.coordinator.withStableProviderHumanAction((fence) => {
    const winner = fence.transaction.durableActionByApprovalId(approvalId);
    if (winner !== undefined) {
      const recovered = recoverStoredForApproval(
        winner,
        approvalId,
        fence.transaction,
        input.codec,
      );
      const prior = recovered.set.provider_observation;
      if (
        input.codec.sha256(expectationFromStored(recovered.set)) !==
          first.value.expectation_sha256 ||
        prior.provider_actor_subject !== observed.provider_actor_subject ||
        prior.observed_reaction !== observed.observed_reaction ||
        prior.observed_action !== observed.observed_action ||
        prior.provider_response_evidence_sha256 !== observed.provider_response_evidence_sha256 ||
        prior.observed_at !== observed.observed_at
      ) throw new PersonSlackReactionApprovalFinalizationConflictError();
      return { kind: "resolved", value: recovered.result } as const;
    }
    if (!fence.approvalIsCurrent(approvalId)) {
      return { kind: "not_resolved", reason: "superseded" } as const;
    }
    const current = prepare(fence, approvalId, input.codec);
    samePrepared(current, first.value);
    const linkStored = revalidate(
      fence.transaction.externalHumanLinkByProviderActor({
        provider_issuer: current.expectation.provider_issuer,
        provider_tenant_kind: current.expectation.provider_tenant_kind,
        provider_tenant_id: current.expectation.provider_tenant_id,
        provider_enterprise_id: current.expectation.provider_enterprise_id,
        provider_subject_id: observed.provider_actor_subject,
      }),
      input.codec,
      validateExternalHumanIdentityLinkContractV2,
    );
    const link = linkStored.body;
    if (
      !sameCoordinates(link, current.approval) ||
      link.provider_tenant_id !== current.expectation.provider_tenant_id ||
      link.provider_enterprise_id !== current.expectation.provider_enterprise_id ||
      link.provider_subject_id !== observed.provider_actor_subject ||
      !fence.transaction.externalHumanLinkIsCurrent({
        external_identity_link_id: link.external_identity_link_id,
        link_contract_sha256: linkStored.sha256,
      })
    ) denied();
    exactMembership(
      fence.currentMembership({ principal_id: link.principal_id, membership_id: link.membership_id }),
      link,
    );
    const capabilityStored = revalidate(
      fence.transaction.actionCapability({
        approval_binding_id: current.expectation.approval_binding_id,
        external_identity_link_id: link.external_identity_link_id,
        policy_id: current.expectation.policy_id,
        action: observed.observed_action,
      }),
      input.codec,
      validatePersonSlackReactionApprovalActionCapabilityV2,
    );
    const capability = capabilityStored.body;
    if (
      !sameCoordinates(capability, current.approval) ||
      capability.approval_binding_id !== current.expectation.approval_binding_id ||
      capability.approval_binding_contract_sha256 !== current.binding.sha256 ||
      capability.external_identity_link_id !== link.external_identity_link_id ||
      capability.principal_id !== link.principal_id || capability.membership_id !== link.membership_id ||
      capability.membership_type !== link.membership_type ||
      capability.policy_id !== current.expectation.policy_id ||
      capability.policy_contract_sha256 !== current.expectation.policy_contract_sha256 ||
      capability.action !== observed.observed_action ||
      !fence.transaction.actionCapabilityIsCurrent({
        action_capability_id: capability.action_capability_id,
        action_capability_contract_sha256: capabilityStored.sha256,
      })
    ) denied();
    const head = verifiedAuditHead(
      fence.transaction.auditHead(),
      fence.transaction,
    );
    const stored = buildStoredAction({
      prepared: current,
      observed,
      link: linkStored,
      capability: capabilityStored,
      audit_event_id: input.ids.next("audit_event"),
      correlation_id: input.ids.next("correlation"),
      audit_sequence: head === null ? 1 : head.audit_sequence + 1,
      predecessor_entry_sha256: head?.audit_entry_sha256 ?? null,
      committed_at: input.now(),
      codec: input.codec,
    });
    revalidateStored(stored, input.codec);
    input.signal?.throwIfAborted();
    fence.transaction.saveHumanAction(stored);
    return { kind: "resolved", value: stored.result } as const;
  });
}
