import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "../src/canonical/canonical-json.js";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
  buildExternalHumanIdentityLinkContractV2,
  buildOrganizationToolConnectionContractV2,
  buildOrganizationToolConnectionStateV2,
  type ApprovalContractSha256,
  type ExternalHumanIdentityLinkContractV2,
  type OrganizationToolConnectionContractV2,
  type OrganizationToolConnectionStateV2,
} from "../src/application/person-slack-approval-contracts-v2.js";
import {
  PersonSlackApprovalActivationConflictError,
  PersonSlackApprovalActivationDeniedError,
  activatePersonSlackApprovalV2,
  type CurrentAuthorityMembershipV2,
  type FrozenApprovalContractV2,
  type PersonSlackApprovalActivationCommandV2,
  type PersonSlackApprovalActivationCoordinatorV2,
  type PersonSlackApprovalActivationFenceV2,
  type PersonSlackApprovalActivationResultV2,
  type PersonSlackApprovalActivationTransactionV2,
} from "../src/application/person-slack-approval-activation-v2.js";

const ADMIN_CREDENTIAL = Object.freeze({ kind: "test-admin-credential" });
const PERSON_SESSION = Object.freeze({
  kind: "person-session",
  principal_id: "principal_owner",
});
const COORDINATES = Object.freeze({
  authority_id: "authority_01",
  organization_id: "organization_01",
  state_lineage_id: "lineage_02",
});
const ADMINISTRATOR = Object.freeze({
  actor_kind: "authority-administrator-credential" as const,
  ...COORDINATES,
  principal_id: "principal_owner",
  membership_id: "membership_owner",
  membership_type: "owner" as const,
});
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

function sha(label: string): ApprovalContractSha256 {
  return canonicalSha256({ label });
}

function freeze<T>(body: T): FrozenApprovalContractV2<T> {
  return Object.freeze({ body, sha256: canonicalSha256(body) });
}

function command(
  patch: Partial<PersonSlackApprovalActivationCommandV2> = {},
): PersonSlackApprovalActivationCommandV2 {
  return {
    command_id: "activate_01",
    target_external_identity_link_id: "link_employee",
    provider_connection_id: "connection_01",
    approval_adapter_instance_id: "approvals_primary",
    approval_adapter_version: "1.0.0",
    approval_channel_id: "C_APPROVAL",
    approve_reaction: "white_check_mark",
    reject_reaction: "x",
    policy_capabilities: [MEMBER_POLICY, REVIEWER_POLICY],
    ...patch,
  };
}

function connection(): OrganizationToolConnectionContractV2 {
  return buildOrganizationToolConnectionContractV2({
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
    public_connection_configuration_sha256: sha("connection-config"),
  });
}

function connectionState(
  contract: FrozenApprovalContractV2<OrganizationToolConnectionContractV2>,
): OrganizationToolConnectionStateV2 {
  return buildOrganizationToolConnectionStateV2({
    connection_id: contract.body.connection_id,
    connection_contract_sha256: contract.sha256,
    connection_status: "active",
    credential_reference_sha256: sha("credential-reference"),
    observed_granted_scopes: SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
    verification_event_id: "connection-verification_01",
    verification_evidence_sha256: sha("connection-evidence"),
    verification_revision: 1,
    verified_at: "2026-08-20T12:00:00.000Z",
  });
}

function link(
  patch: Partial<ExternalHumanIdentityLinkContractV2> = {},
): ExternalHumanIdentityLinkContractV2 {
  return buildExternalHumanIdentityLinkContractV2({
    ...COORDINATES,
    external_identity_link_id: "link_employee",
    provider_issuer: "https://slack.com",
    provider_tenant_kind: "workspace",
    provider_tenant_id: "T01",
    provider_enterprise_id: null,
    provider_subject_id: "U_EMPLOYEE",
    principal_id: "principal_employee",
    membership_id: "membership_employee",
    membership_type: "employee",
    verification_event_id: "link-verification_01",
    verification_evidence_sha256: sha("link-evidence"),
    verified_at: "2026-08-20T12:01:00.000Z",
    ...patch,
  });
}

class FakeCoordinator implements PersonSlackApprovalActivationCoordinatorV2 {
  readonly activations = new Map<
    string,
    PersonSlackApprovalActivationResultV2
  >();
  readonly memberships = new Map<string, CurrentAuthorityMembershipV2>();
  connection = freeze(connection());
  connectionState = freeze(connectionState(this.connection));
  link = freeze(link());
  linkCurrent = true;
  surfaceEligible = true;
  readonly eligibleChannels = new Set(["C_APPROVAL"]);
  transactionCount = 0;
  saveCount = 0;
  failSave = false;
  private tail: Promise<void> = Promise.resolve();

  constructor() {
    this.memberships.set(ADMINISTRATOR.membership_id, {
      principal_id: ADMINISTRATOR.principal_id,
      membership_id: ADMINISTRATOR.membership_id,
      membership_type: ADMINISTRATOR.membership_type,
    });
    this.memberships.set(this.link.body.membership_id, {
      principal_id: this.link.body.principal_id,
      membership_id: this.link.body.membership_id,
      membership_type: this.link.body.membership_type,
    });
  }

  async withStableAdministratorActivation<T>(
    credential: unknown,
    commit: (fence: PersonSlackApprovalActivationFenceV2) => T,
  ): Promise<T> {
    if (credential !== ADMIN_CREDENTIAL) {
      throw new PersonSlackApprovalActivationDeniedError();
    }
    const before = this.tail;
    let unlock = (): void => undefined;
    this.tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await before;
    const staged = new Map(this.activations);
    this.transactionCount += 1;
    const transaction: PersonSlackApprovalActivationTransactionV2 = {
      activationByCommandId: (commandId) => staged.get(commandId),
      activationByResourceSha256: (resourceSha256) =>
        [...staged.values()].find(
          (result) => result.activation_resource_sha256 === resourceSha256,
        ),
      connectionById: (connectionId) =>
        connectionId === this.connection.body.connection_id
          ? this.connection
          : undefined,
      connectionStateById: (connectionId) =>
        connectionId === this.connectionState.body.connection_id
          ? this.connectionState
          : undefined,
      externalHumanLinkById: (linkId) =>
        linkId === this.link.body.external_identity_link_id
          ? this.link
          : undefined,
      externalHumanLinkIsCurrent: (input) =>
        this.linkCurrent &&
        input.external_identity_link_id ===
          this.link.body.external_identity_link_id &&
        input.link_contract_sha256 === this.link.sha256,
      approvalSurfaceIsEligible: (input) =>
        this.surfaceEligible &&
        input.connection_id === "connection_01" &&
        input.approval_adapter_id === "slack-reactions" &&
        input.approval_adapter_instance_id === "approvals_primary" &&
        input.approval_adapter_version === "1.0.0" &&
        this.eligibleChannels.has(input.approval_channel_id) &&
        input.approve_reaction === "white_check_mark" &&
        input.reject_reaction === "x",
      saveActivation: (result) => {
        staged.set(result.command_id, result);
        if (this.failSave) throw new Error("fixture write failure");
        this.saveCount += 1;
      },
    };
    try {
      const result = commit({
        administrator: ADMINISTRATOR,
        currentMembership: ({ principal_id, membership_id }) => {
          const current = this.memberships.get(membership_id);
          return current?.principal_id === principal_id ? current : undefined;
        },
        transaction,
      });
      this.activations.clear();
      for (const [key, value] of staged) this.activations.set(key, value);
      return result;
    } finally {
      unlock();
    }
  }
}

function harness(store = new FakeCoordinator()) {
  let nextId = 0;
  const run = (
    request: unknown = command(),
    credential: unknown = ADMIN_CREDENTIAL,
  ) =>
    activatePersonSlackApprovalV2({
      credential,
      command: request,
      coordinator: store,
      codec: { sha256: canonicalSha256 },
      ids: {
        next: (kind) => `${kind}_${String(++nextId).padStart(2, "0")}`,
      },
    });
  return { store, run, idCount: () => nextId };
}

describe("private Person Slack approval activation v2", () => {
  it("atomically creates one installation-free binding and four exact capabilities", async () => {
    const { store, run } = harness();
    const result = await run();

    expect(result.approval_binding.body).toMatchObject({
      ...COORDINATES,
      connection_id: "connection_01",
      approval_adapter_id: "slack-reactions",
      approval_adapter_instance_id: "approvals_primary",
      approval_channel_id: "C_APPROVAL",
      supported_policy_actions: [MEMBER_POLICY, REVIEWER_POLICY],
    });
    expect(
      result.action_capabilities.map(({ body }) => [
        body.policy_id,
        body.action,
      ]),
    ).toEqual([
      [ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, "approve"],
      [ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, "reject"],
      [RESTRICTED_REVIEWER_PERSON_POLICY_ID, "approve"],
      [RESTRICTED_REVIEWER_PERSON_POLICY_ID, "reject"],
    ]);
    for (const capability of result.action_capabilities) {
      expect(capability.sha256).toBe(canonicalSha256(capability.body));
      expect(capability.body).toMatchObject({
        external_identity_link_id: "link_employee",
        principal_id: "principal_employee",
        membership_id: "membership_employee",
        approval_binding_contract_sha256: result.approval_binding.sha256,
      });
    }
    expect(result.approval_binding.sha256).toBe(
      canonicalSha256(result.approval_binding.body),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /"(installation_id|enrollment_id|lease_id|delivery_binding_id|source_activation_id|read_scope|record_envelope)":/,
    );
    expect(store.saveCount).toBe(1);
  });

  it("replays the exact command and conflicts every changed semantic field", async () => {
    const { run, store, idCount } = harness();
    const first = await run();
    await expect(run()).resolves.toBe(first);
    expect(store.saveCount).toBe(1);
    expect(idCount()).toBe(5);

    const mutations: Partial<PersonSlackApprovalActivationCommandV2>[] = [
      { target_external_identity_link_id: "link_other" },
      { provider_connection_id: "connection_other" },
      { approval_adapter_instance_id: "approvals_other" },
      { approval_adapter_version: "2.0.0" },
      { approval_channel_id: "C_OTHER" },
      { approve_reaction: "heavy_check_mark" },
      { reject_reaction: "no_entry" },
    ];
    for (const mutation of mutations) {
      await expect(run(command(mutation))).rejects.toBeInstanceOf(
        PersonSlackApprovalActivationConflictError,
      );
    }
    expect(store.saveCount).toBe(1);
  });

  it("denies Person sessions and obsolete caller-selected authority fields before a transaction", async () => {
    const { run, store } = harness();
    await expect(run(command(), PERSON_SESSION)).rejects.toBeInstanceOf(
      PersonSlackApprovalActivationDeniedError,
    );
    await expect(
      run({ ...command(), installation_id: "installation_legacy" }),
    ).rejects.toBeInstanceOf(PersonSlackApprovalActivationDeniedError);
    await expect(
      run({ ...command(), authority_id: COORDINATES.authority_id }),
    ).rejects.toBeInstanceOf(PersonSlackApprovalActivationDeniedError);
    expect(store.transactionCount).toBe(0);
    expect(store.saveCount).toBe(0);
  });

  it("allows an exact current owner tenure as the separately linked target", async () => {
    const fixture = harness();
    fixture.store.link = freeze(
      link({
        external_identity_link_id: "link_owner",
        provider_subject_id: "U_OWNER",
        principal_id: ADMINISTRATOR.principal_id,
        membership_id: ADMINISTRATOR.membership_id,
        membership_type: "owner",
      }),
    );
    const result = await fixture.run(
      command({ target_external_identity_link_id: "link_owner" }),
    );
    expect(result.action_capabilities[0]!.body.membership_type).toBe("owner");
  });

  it("fails closed on stale, cross-tenant, ineligible, or corrupt current edges", async () => {
    const cases: Array<(store: FakeCoordinator) => void> = [
      (store) => {
        store.connectionState = freeze(
          buildOrganizationToolConnectionStateV2({
            ...store.connectionState.body,
            connection_status: "revoked",
          }),
        );
      },
      (store) => {
        store.link = freeze(link({ provider_tenant_id: "T_OTHER" }));
      },
      (store) => {
        store.memberships.delete("membership_employee");
      },
      (store) => {
        store.linkCurrent = false;
      },
      (store) => {
        store.connectionState = freeze(
          buildOrganizationToolConnectionStateV2({
            ...store.connectionState.body,
            observed_granted_scopes: [],
          }),
        );
      },
      (store) => {
        store.surfaceEligible = false;
      },
      (store) => {
        store.connection = {
          ...store.connection,
          sha256: sha("wrong-connection-digest"),
        };
      },
      (store) => {
        store.link = {
          body: {
            ...store.link.body,
            legacy_installation_id: "legacy",
          } as never,
          sha256: store.link.sha256,
        };
      },
    ];
    for (const arrange of cases) {
      const fixture = harness();
      arrange(fixture.store);
      await expect(fixture.run()).rejects.toBeInstanceOf(
        PersonSlackApprovalActivationDeniedError,
      );
      expect(fixture.store.activations.size).toBe(0);
      expect(fixture.store.saveCount).toBe(0);
    }
  });

  it("rolls back a failed atomic save", async () => {
    const fixture = harness();
    fixture.store.failSave = true;
    await expect(fixture.run()).rejects.toThrow("fixture write failure");
    expect(fixture.store.activations.size).toBe(0);
  });

  it("independently rehashes and rejoins every stored replay capability", async () => {
    const fixture = harness();
    const first = await fixture.run();
    const [head, ...tail] = first.action_capabilities;
    const changedBody = {
      ...head!.body,
      external_identity_link_id: "link_substituted",
    };
    fixture.store.activations.set(first.command_id, {
      ...first,
      action_capabilities: [
        freeze(changedBody),
        ...tail,
      ] as typeof first.action_capabilities,
    });
    await expect(fixture.run()).rejects.toBeInstanceOf(
      PersonSlackApprovalActivationDeniedError,
    );
    expect(fixture.store.saveCount).toBe(1);

    const tenantFixture = harness();
    await tenantFixture.run();
    tenantFixture.store.link = freeze(link({ provider_tenant_id: "T_OTHER" }));
    await expect(tenantFixture.run()).rejects.toBeInstanceOf(
      PersonSlackApprovalActivationDeniedError,
    );
  });

  it("reuses one exact resource across command IDs and versions changed resources", async () => {
    const fixture = harness();
    const [first, replayedResource] = await Promise.all([
      fixture.run(),
      fixture.run(command({ command_id: "activate_02" })),
    ]);
    expect(replayedResource.approval_binding).toBe(first.approval_binding);
    expect(replayedResource.action_capabilities).toBe(
      first.action_capabilities,
    );
    expect(fixture.idCount()).toBe(5);

    fixture.store.eligibleChannels.add("C_OTHER");
    const changed = await fixture.run(
      command({ command_id: "activate_03", approval_channel_id: "C_OTHER" }),
    );
    expect(changed.approval_binding.body.approval_binding_id).not.toBe(
      first.approval_binding.body.approval_binding_id,
    );
    expect(fixture.idCount()).toBe(10);
  });

  it("serializes equal and divergent concurrent commands to one committed activation", async () => {
    const equal = harness();
    const equalResults = await Promise.all([equal.run(), equal.run()]);
    expect(equalResults[1]).toBe(equalResults[0]);
    expect(equal.store.saveCount).toBe(1);

    const divergent = harness();
    const outcomes = await Promise.allSettled([
      divergent.run(),
      divergent.run(command({ approval_channel_id: "C_OTHER" })),
    ]);
    expect(
      outcomes.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(divergent.store.saveCount).toBe(1);
  });

});
