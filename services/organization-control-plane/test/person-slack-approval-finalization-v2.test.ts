import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "../src/canonical/canonical-json.js";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
  buildExternalHumanIdentityLinkContractV2,
  buildOrganizationToolConnectionContractV2,
  buildOrganizationToolConnectionStateV2,
  buildPersonSlackApprovalActionCapabilityV2,
  buildPersonSlackApprovalBindingContractV2,
  buildProviderHumanActionDurableResult,
  type ApprovalContractSha256,
  type PersonApprovalAction,
  type PersonApprovalPolicyId,
  type ProviderHumanActionDurableResult,
} from "../src/application/person-slack-approval-contracts-v2.js";
import {
  PersonSlackApprovalFinalizationConflictError,
  PersonSlackApprovalFinalizationDeniedError,
  finalizePersonSlackApprovalV2,
  type PersonSlackApprovalFinalizationCoordinatorV2,
  type PersonSlackApprovalFinalizationFenceV2,
  type PersonSlackApprovalFinalizationResultV2,
  type PersonSlackApprovalFinalizationTransactionV2,
  type PersonSlackApprovalProviderExpectationV2,
  type PersonSlackApprovalProviderResultV2,
  type ReprovedFrozenPersonSlackApprovalV2,
  type StoredProviderHumanActionV2,
} from "../src/application/person-slack-approval-finalization-v2.js";
import type {
  CurrentAuthorityMembershipV2,
  FrozenApprovalContractV2,
} from "../src/application/person-slack-approval-activation-v2.js";

const COORDINATES = Object.freeze({
  authority_id: "authority_01",
  organization_id: "organization_01",
  state_lineage_id: "lineage_02",
});
const OBSERVED_AT = "2026-08-20T12:02:00.000Z";
const COMMITTED_AT = "2026-08-20T12:03:00.000Z";

function digest(label: string): ApprovalContractSha256 {
  return canonicalSha256({ label });
}

function frozen<T>(body: T): FrozenApprovalContractV2<T> {
  return Object.freeze({ body, sha256: canonicalSha256(body) });
}

function policyValues(policyId: PersonApprovalPolicyId) {
  return policyId === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID
    ? {
        policy_id: policyId,
        policy_contract_sha256:
          ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
        policy_consequence_sha256:
          ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
      }
    : {
        policy_id: policyId,
        policy_contract_sha256:
          RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
        policy_consequence_sha256:
          RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
      };
}

class FakeCoordinator implements PersonSlackApprovalFinalizationCoordinatorV2 {
  readonly durable = new Map<string, StoredProviderHumanActionV2>();
  readonly auditChain = new Map<
    string,
    {
      readonly authority_id: string;
      readonly organization_id: string;
      readonly state_lineage_id: string;
      readonly audit_event_id: string;
      readonly audit_sequence: number;
      readonly audit_entry_sha256: ApprovalContractSha256;
      readonly predecessor_entry_sha256: ApprovalContractSha256 | null;
    }
  >();
  readonly memberships = new Map<string, CurrentAuthorityMembershipV2>();
  readonly capabilities = new Map<string, FrozenApprovalContractV2<ReturnType<typeof buildPersonSlackApprovalActionCapabilityV2>>>();
  connection;
  connectionState;
  readonly binding;
  readonly link;
  approval: ReprovedFrozenPersonSlackApprovalV2;
  approvalCurrent = true;
  bindingCurrent = true;
  surfaceEligible = true;
  linkCurrent = true;
  capabilitiesCurrent = true;
  failSave = false;
  saveCount = 0;
  fenceCount = 0;
  inFence = false;
  head: { audit_sequence: number; audit_entry_sha256: ApprovalContractSha256 } | null = null;
  private tail: Promise<void> = Promise.resolve();

  seedVerifiedAuditHead(
    auditSequence: number,
    auditEntrySha256: ApprovalContractSha256,
  ): void {
    const auditEventId = `seed_audit_${auditSequence}`;
    this.head = {
      audit_sequence: auditSequence,
      audit_entry_sha256: auditEntrySha256,
    };
    this.auditChain.set(auditEventId, {
      ...COORDINATES,
      audit_event_id: auditEventId,
      audit_sequence: auditSequence,
      audit_entry_sha256: auditEntrySha256,
      predecessor_entry_sha256: digest(`seed-predecessor-${auditSequence}`),
    });
  }

  constructor(
    policyId: PersonApprovalPolicyId,
    membershipType: "employee" | "owner" = "employee",
  ) {
    const connection = buildOrganizationToolConnectionContractV2({
      ...COORDINATES,
      connection_id: "connection_01",
      provider_issuer: "https://slack.com",
      provider_tenant_kind: "workspace",
      provider_tenant_id: "T01",
      provider_enterprise_id: null,
      tool_kind: "slack",
      provider_app_id: "A01",
      provider_bot_id: "B01",
      provider_bot_user_id: "U_BOT",
      required_provider_scopes: SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
      public_connection_configuration_sha256: digest("connection-config"),
    });
    this.connection = frozen(connection);
    this.connectionState = frozen(
      buildOrganizationToolConnectionStateV2({
        connection_id: connection.connection_id,
        connection_contract_sha256: this.connection.sha256,
        connection_status: "active",
        credential_reference_sha256: digest("credential-reference"),
        observed_granted_scopes: SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
        verification_event_id: "connection-verification_01",
        verification_evidence_sha256: digest("connection-evidence"),
        verification_revision: 1,
        verified_at: "2026-08-20T12:00:00.000Z",
      }),
    );
    const link = buildExternalHumanIdentityLinkContractV2({
      ...COORDINATES,
      external_identity_link_id: "link_01",
      provider_issuer: "https://slack.com",
      provider_tenant_kind: "workspace",
      provider_tenant_id: "T01",
      provider_enterprise_id: null,
      provider_subject_id: "U_HUMAN",
      principal_id: "principal_01",
      membership_id: "membership_01",
      membership_type: membershipType,
      verification_event_id: "link-verification_01",
      verification_evidence_sha256: digest("link-evidence"),
      verified_at: "2026-08-20T12:01:00.000Z",
    });
    this.link = frozen(link);
    this.memberships.set(link.membership_id, {
      principal_id: link.principal_id,
      membership_id: link.membership_id,
      membership_type: link.membership_type,
    });
    const binding = buildPersonSlackApprovalBindingContractV2({
      ...COORDINATES,
      approval_binding_id: "binding_01",
      connection_id: connection.connection_id,
      connection_contract_sha256: this.connection.sha256,
      approval_adapter_kind: "approval-surface",
      approval_adapter_id: "slack-reactions",
      approval_adapter_instance_id: "approvals_primary",
      approval_adapter_version: "1.0.0",
      approval_channel_id: "C_APPROVAL",
      approve_reaction: "white_check_mark",
      reject_reaction: "x",
      supported_policy_actions: [
        {
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
          policy_contract_sha256:
            ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
          actions: ["approve", "reject"],
        },
        {
          policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
          policy_contract_sha256:
            RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
          actions: ["approve", "reject"],
        },
      ],
    });
    this.binding = frozen(binding);
    for (const candidatePolicy of [
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    ] as const) {
      for (const action of ["approve", "reject"] as const) {
        const values = policyValues(candidatePolicy);
        const capability = buildPersonSlackApprovalActionCapabilityV2({
          ...COORDINATES,
          action_capability_id: `cap_${candidatePolicy}_${action}`,
          approval_binding_id: binding.approval_binding_id,
          approval_binding_contract_sha256: this.binding.sha256,
          external_identity_link_id: link.external_identity_link_id,
          principal_id: link.principal_id,
          membership_id: link.membership_id,
          membership_type: link.membership_type,
          policy_id: values.policy_id,
          policy_contract_sha256: values.policy_contract_sha256,
          action,
        });
        this.capabilities.set(`${candidatePolicy}:${action}`, frozen(capability));
      }
    }
    const values = policyValues(policyId);
    this.approval = Object.freeze({
      ...COORDINATES,
      approval_id: "approval_01",
      status: "pending",
      connection_id: connection.connection_id,
      connection_contract_sha256: this.connection.sha256,
      approval_binding_id: binding.approval_binding_id,
      approval_binding_contract_sha256: this.binding.sha256,
      approval_channel_id: binding.approval_channel_id,
      provider_message_ts: "1724112000.000100",
      ...values,
      frozen_card_sha256: digest("frozen-card"),
      approved_snapshot_sha256: digest("approved-snapshot"),
    });
  }

  async withStableProviderHumanAction<T>(
    commit: (fence: PersonSlackApprovalFinalizationFenceV2) => T,
  ): Promise<T> {
    const before = this.tail;
    let unlock = (): void => undefined;
    this.tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await before;
    const staged = new Map(this.durable);
    const stagedAuditChain = new Map(this.auditChain);
    let stagedHead = this.head;
    let saved = false;
    this.fenceCount += 1;
    this.inFence = true;
    const transaction: PersonSlackApprovalFinalizationTransactionV2 = {
      durableActionByApprovalId: (approvalId) => staged.get(approvalId),
      connectionById: (connectionId) =>
        connectionId === "connection_01" ? this.connection : undefined,
      connectionStateById: (connectionId) =>
        connectionId === this.connectionState.body.connection_id
          ? this.connectionState
          : undefined,
      approvalBindingById: (bindingId) =>
        bindingId === this.binding.body.approval_binding_id
          ? this.binding
          : undefined,
      approvalBindingIsCurrent: ({ approval_binding_id, approval_binding_contract_sha256 }) =>
        this.bindingCurrent &&
        approval_binding_id === this.binding.body.approval_binding_id &&
        approval_binding_contract_sha256 === this.binding.sha256,
      approvalSurfaceIsEligible: (input) =>
        this.surfaceEligible &&
        input.connection_id === "connection_01" &&
        input.approval_adapter_id === "slack-reactions" &&
        input.approval_adapter_instance_id ===
          this.binding.body.approval_adapter_instance_id &&
        input.approval_adapter_version ===
          this.binding.body.approval_adapter_version &&
        input.approval_channel_id === this.binding.body.approval_channel_id &&
        input.approve_reaction === this.binding.body.approve_reaction &&
        input.reject_reaction === this.binding.body.reject_reaction,
      externalHumanLinkByProviderActor: (actor) =>
        actor.provider_tenant_id === this.link.body.provider_tenant_id &&
        actor.provider_enterprise_id === this.link.body.provider_enterprise_id &&
        actor.provider_subject_id === this.link.body.provider_subject_id
          ? this.link
          : undefined,
      externalHumanLinkIsCurrent: ({ external_identity_link_id, link_contract_sha256 }) =>
        this.linkCurrent &&
        external_identity_link_id === this.link.body.external_identity_link_id &&
        link_contract_sha256 === this.link.sha256,
      actionCapability: ({ policy_id, action }) =>
        this.capabilities.get(`${policy_id}:${action}`),
      actionCapabilityIsCurrent: ({ action_capability_id, action_capability_contract_sha256 }) => {
        const capability = [...this.capabilities.values()].find(
          ({ body }) => body.action_capability_id === action_capability_id,
        );
        return this.capabilitiesCurrent && capability?.sha256 === action_capability_contract_sha256;
      },
      auditHead: () => stagedHead,
      auditHeadIsVerified: (input) =>
        input === null
          ? stagedHead === null && stagedAuditChain.size === 0
          : stagedHead?.audit_sequence === input.audit_sequence &&
            stagedHead.audit_entry_sha256 === input.audit_entry_sha256 &&
            [...stagedAuditChain.values()].some(
              (entry) =>
                entry.audit_sequence === input.audit_sequence &&
                entry.audit_entry_sha256 === input.audit_entry_sha256,
            ),
      auditEntryIsInVerifiedChain: (input) => {
        const entry = stagedAuditChain.get(input.audit_event_id);
        return entry !== undefined && canonicalSha256(entry) === canonicalSha256(input);
      },
      saveHumanAction: (value) => {
        staged.set(value.result.approval_id, value);
        const audit = value.contracts.audit_entry;
        stagedAuditChain.set(audit.audit_event_id, {
          authority_id: audit.authority_id,
          organization_id: audit.organization_id,
          state_lineage_id: audit.state_lineage_id,
          audit_event_id: audit.audit_event_id,
          audit_sequence: audit.audit_sequence,
          audit_entry_sha256: value.contracts.audit_entry_sha256,
          predecessor_entry_sha256: audit.predecessor_entry_sha256,
        });
        stagedHead = {
          audit_sequence: value.contracts.audit_entry.audit_sequence,
          audit_entry_sha256: value.contracts.audit_entry_sha256,
        };
        saved = true;
        if (this.failSave) throw new Error("fixture save failure");
      },
    };
    try {
      const result = commit({
        reprovedFrozenApprovalById: (approvalId) =>
          approvalId === this.approval.approval_id ? this.approval : undefined,
        approvalIsCurrent: (approvalId) =>
          this.approvalCurrent && approvalId === this.approval.approval_id,
        currentMembership: ({ principal_id, membership_id }) => {
          const membership = this.memberships.get(membership_id);
          return membership?.principal_id === principal_id ? membership : undefined;
        },
        transaction,
      });
      this.durable.clear();
      for (const [key, value] of staged) this.durable.set(key, value);
      this.auditChain.clear();
      for (const [key, value] of stagedAuditChain) {
        this.auditChain.set(key, value);
      }
      this.head = stagedHead;
      if (saved) this.saveCount += 1;
      return result;
    } finally {
      this.inFence = false;
      unlock();
    }
  }
}

class FakeProvider {
  calls = 0;
  actions: PersonApprovalAction[] = ["approve"];
  outcome: PersonSlackApprovalProviderResultV2["kind"] = "observed";
  resultOverride: unknown | undefined;
  afterObserve: (() => void) | undefined;
  expectations: PersonSlackApprovalProviderExpectationV2[] = [];

  constructor(private readonly store: FakeCoordinator) {}

  async observeApprovalReaction(
    expectation: PersonSlackApprovalProviderExpectationV2,
    expectationSha256: ApprovalContractSha256,
  ): Promise<PersonSlackApprovalProviderResultV2> {
    expect(this.store.inFence).toBe(false);
    this.calls += 1;
    this.expectations.push(expectation);
    this.afterObserve?.();
    if (this.resultOverride !== undefined) {
      return this.resultOverride as PersonSlackApprovalProviderResultV2;
    }
    if (this.outcome !== "observed") {
      return { kind: "not_resolved", reason: "conflicting_reactions" };
    }
    const action = this.actions.shift() ?? "approve";
    return {
      kind: "observed",
      expectation_sha256: expectationSha256,
      provider_actor_subject: "U_HUMAN",
      observed_reaction:
        action === "approve"
          ? expectation.approve_reaction
          : expectation.reject_reaction,
      observed_action: action,
      provider_response_evidence_sha256: digest(`provider-${action}`),
      observed_at: OBSERVED_AT,
    };
  }
}

function harness(
  policyId: PersonApprovalPolicyId = ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  membershipType: "employee" | "owner" = "employee",
) {
  const store = new FakeCoordinator(policyId, membershipType);
  const provider = new FakeProvider(store);
  let nextId = 0;
  const run = (
    command: unknown = { approval_id: "approval_01" },
    signal?: AbortSignal,
  ) =>
    finalizePersonSlackApprovalV2({
      command,
      coordinator: store,
      provider,
      codec: { sha256: canonicalSha256 },
      ids: { next: (kind) => `${kind}_${++nextId}` },
      now: () => COMMITTED_AT,
      signal,
    });
  return { store, provider, run, idCount: () => nextId };
}

function resolved(
  result: PersonSlackApprovalFinalizationResultV2,
): ProviderHumanActionDurableResult {
  expect(result.kind).toBe("resolved");
  return (result as Extract<PersonSlackApprovalFinalizationResultV2, { kind: "resolved" }>).value;
}

describe("private Person Slack approval finalization v2", () => {
  it("commits both policy families, both actions, and owner or employee tenure", async () => {
    for (const policyId of [
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    ] as const) {
      for (const action of ["approve", "reject"] as const) {
        const fixture = harness(policyId, action === "approve" ? "employee" : "owner");
        fixture.provider.actions = [action];
        const value = resolved(await fixture.run());
        const stored = fixture.store.durable.get("approval_01")!;
        expect(value).toMatchObject({ approval_id: "approval_01", policy_id: policyId, action });
        expect(stored.contracts).toMatchObject({
          provider_action: { action, membership_type: action === "approve" ? "employee" : "owner" },
          audit_entry: { actor_class: "provider_human", action, audit_sequence: 1 },
        });
        expect(fixture.provider.calls).toBe(1);
        expect(fixture.store.saveCount).toBe(1);
      }
    }
  });

  it("admits only an approval ID and keeps provider calls outside the fence", async () => {
    const fixture = harness();
    await expect(fixture.run({ approval_id: "approval_01", action: "approve" })).rejects.toBeInstanceOf(
      PersonSlackApprovalFinalizationDeniedError,
    );
    await expect(fixture.run({})).rejects.toBeInstanceOf(
      PersonSlackApprovalFinalizationDeniedError,
    );
    expect(fixture.provider.calls).toBe(0);
    const value = resolved(await fixture.run());
    expect(value.approval_id).toBe("approval_01");
    expect(fixture.provider.expectations[0]).toMatchObject({
      provider_app_id: "A01",
      provider_bot_id: "B01",
      provider_bot_user_id: "U_BOT",
      approval_channel_id: "C_APPROVAL",
      frozen_card_sha256: fixture.store.approval.frozen_card_sha256,
    });
  });

  it("denies exotic command records without invoking accessors", async () => {
    const customPrototype = { approval_id: "approval_01" };
    Object.setPrototypeOf(customPrototype, { unexpected: true });
    const symbolKeyed: Record<PropertyKey, unknown> = { approval_id: "approval_01" };
    symbolKeyed[Symbol("unexpected")] = true;
    const nonEnumerable = { approval_id: "approval_01" };
    Object.defineProperty(nonEnumerable, "unexpected", {
      enumerable: false,
      value: true,
    });
    let getterCalls = 0;
    let setterCalls = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "approval_id", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "approval_01";
      },
      set: () => {
        setterCalls += 1;
      },
    });

    for (const command of [customPrototype, symbolKeyed, nonEnumerable, accessor]) {
      const fixture = harness();
      await expect(fixture.run(command)).rejects.toBeInstanceOf(
        PersonSlackApprovalFinalizationDeniedError,
      );
      expect(fixture.provider.calls).toBe(0);
      expect(fixture.store.saveCount).toBe(0);
    }
    expect(getterCalls).toBe(0);
    expect(setterCalls).toBe(0);
  });

  it("denies exotic provider result records without invoking accessors", async () => {
    const observed = {
      kind: "observed",
      expectation_sha256: digest("expectation"),
      provider_actor_subject: "U_HUMAN",
      observed_reaction: "white_check_mark",
      observed_action: "approve",
      provider_response_evidence_sha256: digest("provider-approve"),
      observed_at: OBSERVED_AT,
    };
    const customPrototype = { ...observed };
    Object.setPrototypeOf(customPrototype, { unexpected: true });
    const symbolKeyed: Record<PropertyKey, unknown> = { ...observed };
    symbolKeyed[Symbol("unexpected")] = true;
    let getterCalls = 0;
    const accessor = { ...observed };
    Object.defineProperty(accessor, "kind", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "observed";
      },
    });

    for (const result of [customPrototype, symbolKeyed, accessor]) {
      const fixture = harness();
      fixture.provider.resultOverride = result;
      await expect(fixture.run()).rejects.toBeInstanceOf(
        PersonSlackApprovalFinalizationDeniedError,
      );
      expect(fixture.provider.calls).toBe(1);
      expect(fixture.store.saveCount).toBe(0);
    }
    expect(getterCalls).toBe(0);
  });

  it("makes no provider call for known revoked or mismatched pre-call state", async () => {
    const cases: Array<(fixture: ReturnType<typeof harness>) => void> = [
      ({ store }) => {
        store.bindingCurrent = false;
      },
      ({ store }) => {
        store.surfaceEligible = false;
      },
      ({ store }) => {
        store.connectionState = frozen(
          buildOrganizationToolConnectionStateV2({
            ...store.connectionState.body,
            connection_status: "revoked",
          }),
        );
      },
      ({ store }) => {
        store.connectionState = frozen(
          buildOrganizationToolConnectionStateV2({
            ...store.connectionState.body,
            observed_granted_scopes: [],
          }),
        );
      },
      ({ store }) => {
        store.approval = { ...store.approval, approval_channel_id: "C_OTHER" };
      },
      ({ store }) => {
        store.approval = {
          ...store.approval,
          policy_consequence_sha256: digest("wrong-consequence"),
        };
      },
    ];
    for (const arrange of cases) {
      const fixture = harness();
      arrange(fixture);
      await expect(fixture.run()).rejects.toBeInstanceOf(
        PersonSlackApprovalFinalizationDeniedError,
      );
      expect(fixture.provider.calls).toBe(0);
      expect(fixture.store.saveCount).toBe(0);
    }
  });

  it("writes nothing for absent or conflicting provider evidence", async () => {
    const fixture = harness();
    fixture.provider.outcome = "not_resolved";
    await expect(fixture.run()).resolves.toEqual({
      kind: "not_resolved",
      reason: "conflicting_reactions",
    });
    expect(fixture.store.saveCount).toBe(0);
    expect(fixture.store.durable.size).toBe(0);
  });

  it("does not observe or persist a superseded pending approval", async () => {
    const fixture = harness();
    fixture.store.approvalCurrent = false;

    await expect(fixture.run()).resolves.toEqual({
      kind: "not_resolved",
      reason: "superseded",
    });
    expect(fixture.provider.calls).toBe(0);
    expect(fixture.store.saveCount).toBe(0);
    expect(fixture.store.durable.size).toBe(0);
  });

  it("discards an in-flight result when any current identity edge changes", async () => {
    const cases: Array<(store: FakeCoordinator) => void> = [
      (store) => {
        store.linkCurrent = false;
      },
      (store) => {
        store.memberships.clear();
      },
      (store) => {
        store.capabilitiesCurrent = false;
      },
      (store) => {
        store.bindingCurrent = false;
      },
      (store) => {
        store.surfaceEligible = false;
      },
      (store) => {
        store.approval = { ...store.approval, frozen_card_sha256: digest("changed-card") };
      },
    ];
    for (const mutate of cases) {
      const fixture = harness();
      fixture.provider.afterObserve = () => mutate(fixture.store);
      await expect(fixture.run()).rejects.toBeInstanceOf(
        PersonSlackApprovalFinalizationDeniedError,
      );
      expect(fixture.provider.calls).toBe(1);
      expect(fixture.store.saveCount).toBe(0);
    }
  });

  it("does not persist an observed reaction when its approval is superseded in flight", async () => {
    const fixture = harness();
    fixture.provider.afterObserve = () => {
      fixture.store.approvalCurrent = false;
    };

    await expect(fixture.run()).resolves.toEqual({
      kind: "not_resolved",
      reason: "superseded",
    });
    expect(fixture.provider.calls).toBe(1);
    expect(fixture.store.saveCount).toBe(0);
    expect(fixture.store.durable.size).toBe(0);
  });

  it("replays byte-identical history after every current edge is revoked", async () => {
    const fixture = harness();
    const first = resolved(await fixture.run());
    fixture.store.bindingCurrent = false;
    fixture.store.approvalCurrent = false;
    fixture.store.linkCurrent = false;
    fixture.store.capabilitiesCurrent = false;
    fixture.store.memberships.clear();
    fixture.store.connectionState = frozen(
      buildOrganizationToolConnectionStateV2({
        ...fixture.store.connectionState.body,
        connection_status: "revoked",
      }),
    );
    const replay = resolved(await fixture.run());
    expect(replay).toEqual(first);
    expect(fixture.provider.calls).toBe(1);
    expect(fixture.store.saveCount).toBe(1);
  });

  it("commits one audit under concurrency and conflicts changed provider semantics", async () => {
    const exact = harness();
    exact.provider.actions = ["approve", "approve"];
    const exactResults = await Promise.all([exact.run(), exact.run()]);
    expect(resolved(exactResults[1]!)).toEqual(resolved(exactResults[0]!));
    expect(exact.store.saveCount).toBe(1);

    const conflict = harness();
    conflict.provider.actions = ["approve", "reject"];
    const outcomes = await Promise.allSettled([conflict.run(), conflict.run()]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      PersonSlackApprovalFinalizationConflictError,
    );
    expect(conflict.store.saveCount).toBe(1);
  });

  it("conflicts a concurrent winner built from a different frozen expectation", async () => {
    const winner = harness();
    winner.store.approval = {
      ...winner.store.approval,
      frozen_card_sha256: digest("winner-card"),
    };
    await winner.run();
    const winnerStored = winner.store.durable.get("approval_01")!;

    const fixture = harness();
    fixture.provider.afterObserve = () => {
      fixture.store.durable.set("approval_01", winnerStored);
      for (const [key, value] of winner.store.auditChain) {
        fixture.store.auditChain.set(key, value);
      }
    };
    await expect(fixture.run()).rejects.toBeInstanceOf(
      PersonSlackApprovalFinalizationConflictError,
    );
    expect(fixture.provider.calls).toBe(1);
    expect(fixture.store.saveCount).toBe(0);
  });

  it("honors cancellation after provider observation and before commit", async () => {
    const fixture = harness();
    const controller = new AbortController();
    fixture.provider.afterObserve = () => controller.abort();
    await expect(
      fixture.run({ approval_id: "approval_01" }, controller.signal),
    ).rejects.toThrow();
    expect(fixture.provider.calls).toBe(1);
    expect(fixture.store.saveCount).toBe(0);
    expect(fixture.store.durable.size).toBe(0);
  });

  it("chains the audit head and rolls back an atomic save failure", async () => {
    const chained = harness();
    chained.store.seedVerifiedAuditHead(7, digest("audit-head-7"));
    await chained.run();
    expect(chained.store.durable.get("approval_01")!.contracts.audit_entry).toMatchObject({
      audit_sequence: 8,
      predecessor_entry_sha256: digest("audit-head-7"),
    });

    const failing = harness();
    failing.store.failSave = true;
    await expect(failing.run()).rejects.toThrow("fixture save failure");
    expect(failing.store.durable.size).toBe(0);
    expect(failing.store.head).toBeNull();
  });

  it("refuses to append behind an unverified audit head", async () => {
    const fixture = harness();
    fixture.store.head = {
      audit_sequence: 7,
      audit_entry_sha256: digest("unverified-audit-head"),
    };
    await expect(fixture.run()).rejects.toBeInstanceOf(
      PersonSlackApprovalFinalizationDeniedError,
    );
    expect(fixture.provider.calls).toBe(1);
    expect(fixture.store.saveCount).toBe(0);
  });

  it("refuses a second genesis when the verified chain is nonempty", async () => {
    const fixture = harness();
    fixture.store.seedVerifiedAuditHead(1, digest("existing-genesis"));
    fixture.store.head = null;
    await expect(fixture.run()).rejects.toBeInstanceOf(
      PersonSlackApprovalFinalizationDeniedError,
    );
    expect(fixture.provider.calls).toBe(1);
    expect(fixture.store.saveCount).toBe(0);
  });

  it("rejects an accessor-backed audit head without invoking it", async () => {
    const fixture = harness();
    let getterCalls = 0;
    const head: Record<string, unknown> = {};
    for (const [key, value] of [
      ["audit_sequence", 7],
      ["audit_entry_sha256", digest("accessor-audit-head")],
    ] as const) {
      Object.defineProperty(head, key, {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return value;
        },
      });
    }
    fixture.store.head = head as unknown as NonNullable<
      typeof fixture.store.head
    >;
    await expect(fixture.run()).rejects.toBeInstanceOf(
      PersonSlackApprovalFinalizationDeniedError,
    );
    expect(getterCalls).toBe(0);
    expect(fixture.provider.calls).toBe(1);
    expect(fixture.store.saveCount).toBe(0);
  });

  it("denies corrupt historical proof without falling through to Slack", async () => {
    const fixture = harness();
    await fixture.run();
    const stored = fixture.store.durable.get("approval_01")!;
    fixture.store.durable.set("approval_01", {
      ...stored,
      contracts: {
        ...stored.contracts,
        provider_action_sha256: digest("corrupt-provider-action"),
      },
    });
    await expect(fixture.run()).rejects.toBeInstanceOf(
      PersonSlackApprovalFinalizationDeniedError,
    );
    expect(fixture.provider.calls).toBe(1);
  });

  it("binds recovery to the requested approval and the verified audit chain", async () => {
    const wrongKey = harness();
    await wrongKey.run();
    const original = wrongKey.store.durable.get("approval_01")!;
    wrongKey.store.durable.delete("approval_01");
    wrongKey.store.durable.set("approval_other", original);
    await expect(
      wrongKey.run({ approval_id: "approval_other" }),
    ).rejects.toBeInstanceOf(PersonSlackApprovalFinalizationDeniedError);
    expect(wrongKey.provider.calls).toBe(1);

    const rewrittenChain = harness();
    await rewrittenChain.run();
    const stored = rewrittenChain.store.durable.get("approval_01")!;
    const auditEntry = {
      ...stored.contracts.audit_entry,
      audit_sequence: 2,
      predecessor_entry_sha256: digest("rewritten-predecessor"),
    };
    const contracts = {
      ...stored.contracts,
      audit_entry: auditEntry,
      audit_entry_sha256: canonicalSha256(auditEntry),
    };
    rewrittenChain.store.durable.set("approval_01", {
      ...stored,
      contracts,
      result: buildProviderHumanActionDurableResult(contracts),
    });
    await expect(rewrittenChain.run()).rejects.toBeInstanceOf(
      PersonSlackApprovalFinalizationDeniedError,
    );
    expect(rewrittenChain.provider.calls).toBe(1);
  });

  it("binds the exact historical human-link body into the provider action", async () => {
    for (const mutation of [
      { verification_event_id: "link-verification_rewritten" },
      { verification_evidence_sha256: digest("rewritten-link-evidence") },
      { verified_at: "2026-08-20T12:01:30.000Z" },
    ]) {
      const fixture = harness();
      await fixture.run();
      const stored = fixture.store.durable.get("approval_01")!;
      const changedLink = buildExternalHumanIdentityLinkContractV2({
        ...stored.contracts.external_human_link,
        ...mutation,
      });
      fixture.store.durable.set("approval_01", {
        ...stored,
        contracts: {
          ...stored.contracts,
          external_human_link: changedLink,
          external_identity_link_contract_sha256:
            canonicalSha256(changedLink),
        },
      });
      await expect(fixture.run()).rejects.toBeInstanceOf(
        PersonSlackApprovalFinalizationDeniedError,
      );
      expect(fixture.provider.calls).toBe(1);
    }
  });

  it("rejects extra members in the stored contract set", async () => {
    const fixture = harness();
    await fixture.run();
    const stored = fixture.store.durable.get("approval_01")!;
    fixture.store.durable.set("approval_01", {
      ...stored,
      contracts: {
        ...stored.contracts,
        unexpected_contract: true,
      } as unknown as StoredProviderHumanActionV2["contracts"],
    });
    await expect(fixture.run()).rejects.toBeInstanceOf(
      PersonSlackApprovalFinalizationDeniedError,
    );
    expect(fixture.provider.calls).toBe(1);
  });

  it("denies exotic stored wrappers without invoking accessors or Slack", async () => {
    const fixture = harness();
    await fixture.run();
    const stored = fixture.store.durable.get("approval_01")!;
    const customPrototype = { ...stored };
    Object.setPrototypeOf(customPrototype, { unexpected: true });
    const symbolKeyed: Record<PropertyKey, unknown> = { ...stored };
    symbolKeyed[Symbol("unexpected")] = true;
    let getterCalls = 0;
    const accessor: Record<string, unknown> = {
      semantic_action: stored.semantic_action,
      semantic_action_sha256: stored.semantic_action_sha256,
      result: stored.result,
    };
    Object.defineProperty(accessor, "contracts", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return stored.contracts;
      },
    });

    for (const wrapper of [customPrototype, symbolKeyed, accessor]) {
      fixture.store.durable.set(
        "approval_01",
        wrapper as unknown as StoredProviderHumanActionV2,
      );
      await expect(fixture.run()).rejects.toBeInstanceOf(
        PersonSlackApprovalFinalizationDeniedError,
      );
    }
    expect(getterCalls).toBe(0);
    expect(fixture.provider.calls).toBe(1);
    expect(fixture.store.saveCount).toBe(1);
  });

  it("rejects an accessor-backed frozen contract without invoking it", async () => {
    const fixture = harness();
    const original = fixture.store.connection;
    let getterCalls = 0;
    const wrapper: Record<string, unknown> = { sha256: original.sha256 };
    Object.defineProperty(wrapper, "body", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return original.body;
      },
    });
    fixture.store.connection = wrapper as unknown as typeof original;
    await expect(fixture.run()).rejects.toBeInstanceOf(
      PersonSlackApprovalFinalizationDeniedError,
    );
    expect(getterCalls).toBe(0);
    expect(fixture.provider.calls).toBe(0);
    expect(fixture.store.saveCount).toBe(0);
  });

  it("grants no delivery, read, source, model, or D3 authority", () => {
    const forbidden = JSON.stringify(harness().store.approval);
    expect(forbidden).not.toMatch(
      /"(delivery_binding_id|read_scope|source_activation_id|model_id|human_act_resolution_ref)":/,
    );
  });
});
