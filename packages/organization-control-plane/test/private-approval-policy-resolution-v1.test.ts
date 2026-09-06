import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type ApprovalContractSha256,
} from "../src/application/record-visibility-policy-contracts-v1.js";
import {
  PRIVATE_APPROVAL_AUTHORIZATION_ALLOW_KIND,
  PRIVATE_APPROVAL_PENDING_KIND,
  PRIVATE_APPROVAL_PRESENTATION_DEFAULT_POLICY_ID,
  PRIVATE_APPROVAL_RESOLUTION_KIND,
  resolvePrivateApprovalPolicyV1,
  type PendingPrivateApprovalV1,
  type PrivateApprovalAuthorizationAllowV1,
  type PrivateApprovalResolutionCommandV1,
} from "../src/application/private-approval-policy-resolution-v1.js";

const ASSIGNEE = {
  principal_id: "prn_11111111-1111-4111-8111-111111111111",
  membership_id: "mem_22222222-2222-4222-8222-222222222222",
} as const;
const OTHER_ASSIGNEE = {
  principal_id: "prn_33333333-3333-4333-8333-333333333333",
  membership_id: "mem_44444444-4444-4444-8444-444444444444",
} as const;
const SLACK_LINK = {
  provider: "slack" as const,
  external_identity_link_id: "clm_55555555-5555-4555-8555-555555555555",
  external_identity_link_contract_sha256: digest("f"),
  provider_subject_id: "U01234567",
};

function digest(letter: string): ApprovalContractSha256 {
  return `sha256:${letter.repeat(64)}` as ApprovalContractSha256;
}

function pending(
  overrides: Partial<PendingPrivateApprovalV1> = {},
): PendingPrivateApprovalV1 {
  return {
    schema_version: 1,
    kind: PRIVATE_APPROVAL_PENDING_KIND,
    approval_id: "apr_66666666-6666-4666-8666-666666666666",
    organization_id: "org_77777777-7777-4777-8777-777777777777",
    candidate_sha256: digest("a"),
    frozen_card_sha256: digest("b"),
    approved_snapshot_sha256: digest("c"),
    assigned_owner: ASSIGNEE,
    assigned_owner_slack_identity_link: SLACK_LINK,
    ...overrides,
  };
}

function command(
  overrides: Partial<PrivateApprovalResolutionCommandV1> = {},
): PrivateApprovalResolutionCommandV1 {
  return {
    schema_version: 1,
    command_id: "cmd_88888888-8888-4888-8888-888888888888",
    approval_id: pending().approval_id,
    action: "approve",
    selected_policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    comment: null,
    ...overrides,
  };
}

function authorization(
  source = pending(),
  overrides: Partial<PrivateApprovalAuthorizationAllowV1> = {},
): PrivateApprovalAuthorizationAllowV1 {
  return {
    schema_version: 1,
    kind: PRIVATE_APPROVAL_AUTHORIZATION_ALLOW_KIND,
    approval_id: source.approval_id,
    organization_id: source.organization_id,
    candidate_sha256: source.candidate_sha256,
    frozen_card_sha256: source.frozen_card_sha256,
    approved_snapshot_sha256: source.approved_snapshot_sha256,
    authorized_assignee: source.assigned_owner,
    current_slack_identity_link: source.assigned_owner_slack_identity_link,
    authorization_proof_sha256: digest("e"),
    ...overrides,
  };
}

function input(overrides: Partial<PrivateApprovalResolutionCommandV1> = {}) {
  const current = pending();
  return {
    pending: current,
    command: command(overrides),
    authorization_allow: authorization(current),
  };
}

describe("resolvePrivateApprovalPolicyV1", () => {
  it("binds private policy and final approver from server authorization", () => {
    const result = resolvePrivateApprovalPolicyV1(input());

    expect(result).toMatchObject({
      schema_version: 1,
      kind: PRIVATE_APPROVAL_RESOLUTION_KIND,
      final_approver: ASSIGNEE,
      current_slack_identity_link: SLACK_LINK,
      authorization_proof_sha256: digest("e"),
      comment: null,
      canonical_record_policy: {
        policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
        restricted_reader: ASSIGNEE,
      },
    });
    expect(Object.keys(command())).not.toContain("actor");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.current_slack_identity_link)).toBe(true);
  });

  it("rejects an actor assertion smuggled into the raw command", () => {
    expect(() =>
      resolvePrivateApprovalPolicyV1({
        ...input(),
        command: {
          ...command(),
          actor: ASSIGNEE,
        } as unknown as PrivateApprovalResolutionCommandV1,
      }),
    ).toThrow("approval command has an unexpected shape");
  });

  it("preserves a canonical multiline human comment", () => {
    const approved = resolvePrivateApprovalPolicyV1(
      input({ comment: "Reviewed the source evidence.\n\tReady to publish." }),
    );
    expect(approved.comment).toBe(
      "Reviewed the source evidence.\n\tReady to publish.",
    );

    const rejected = resolvePrivateApprovalPolicyV1(
      input({
        action: "reject",
        selected_policy_id: null,
        comment: "Please correct the meeting date.",
      }),
    );
    expect(rejected.comment).toBe("Please correct the meeting date.");
  });

  it("fails closed for non-canonical or unsafe human comments", () => {
    const invalidComments: readonly unknown[] = [
      "",
      " \t\n ",
      " leading",
      "trailing ",
      "line one\r\nline two",
      "nul\u0000byte",
      "c0\u0001control",
      "delete\u007fcontrol",
      "a".repeat(1001),
      42,
    ];
    for (const value of invalidComments) {
      expect(() =>
        resolvePrivateApprovalPolicyV1(
          input({ comment: value as PrivateApprovalResolutionCommandV1["comment"] }),
        ),
      ).toThrow("approval command comment");
    }
    expect(
      resolvePrivateApprovalPolicyV1(input({ comment: "a".repeat(1000) })).comment,
    ).toHaveLength(1000);
  });

  it("binds team policy only when explicitly selected", () => {
    const result = resolvePrivateApprovalPolicyV1(
      input({ selected_policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID }),
    );
    expect(result.canonical_record_policy).toMatchObject({
      policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      restricted_reader: null,
    });
  });

  it("never silently uses the presentation default and emits no policy on reject", () => {
    expect(PRIVATE_APPROVAL_PRESENTATION_DEFAULT_POLICY_ID).toBe(
      RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    );
    expect(() =>
      resolvePrivateApprovalPolicyV1(input({ selected_policy_id: null })),
    ).toThrow("approve requires an explicit selected_policy_id");
    expect(
      resolvePrivateApprovalPolicyV1(
        input({ action: "reject", selected_policy_id: null }),
      ).canonical_record_policy,
    ).toBeNull();
  });

  it("fails closed for an unsupported policy", () => {
    expect(() =>
      resolvePrivateApprovalPolicyV1(
        input({ selected_policy_id: "not-a-policy" as never }),
      ),
    ).toThrow("selected_policy_id is unsupported");
  });

  it("fails closed when authorization mismatches any pending commitment", () => {
    const current = pending();
    for (const allow of [
      authorization(current, { approval_id: "apr_other" }),
      authorization(current, { organization_id: "org_other" }),
      authorization(current, { candidate_sha256: digest("0") }),
      authorization(current, { frozen_card_sha256: digest("1") }),
      authorization(current, { approved_snapshot_sha256: digest("2") }),
      authorization(current, { authorized_assignee: OTHER_ASSIGNEE }),
      authorization(current, {
        current_slack_identity_link: {
          ...SLACK_LINK,
          external_identity_link_id: "clm_other",
        },
      }),
      authorization(current, {
        current_slack_identity_link: {
          ...SLACK_LINK,
          external_identity_link_contract_sha256: digest("3"),
        },
      }),
    ]) {
      expect(() =>
        resolvePrivateApprovalPolicyV1({
          pending: current,
          command: command(),
          authorization_allow: allow,
        }),
      ).toThrow("authorization allow does not match the pending owner");
    }
  });

  it("requires a contracted clm identity link and canonical Slack human subject", () => {
    const current = pending();
    expect(() =>
      resolvePrivateApprovalPolicyV1({
        pending: current,
        command: command(),
        authorization_allow: authorization(current, {
          current_slack_identity_link: {
            ...SLACK_LINK,
            external_identity_link_id: "idl_not_contract_backed",
          },
        }),
      }),
    ).toThrow("external_identity_link_id must be a canonical clm identifier");
    expect(() =>
      resolvePrivateApprovalPolicyV1({
        pending: current,
        command: command(),
        authorization_allow: authorization(current, {
          current_slack_identity_link: {
            ...SLACK_LINK,
            provider_subject_id: "person_not_slack",
          },
        }),
      }),
    ).toThrow("provider_subject_id must be a canonical Slack U or W subject");
  });

  it("returns an exact durable replay before consulting a later owner", () => {
    const firstInput = input();
    const first = resolvePrivateApprovalPolicyV1(firstInput);
    const changed = pending({ assigned_owner: OTHER_ASSIGNEE });
    expect(changed.assigned_owner).toEqual(OTHER_ASSIGNEE);
    expect(
      resolvePrivateApprovalPolicyV1({
        command: firstInput.command,
        prior_resolution: first,
      }),
    ).toEqual(first);
  });

  it("rejects semantic command-id reuse and tampered durable results", () => {
    const firstInput = input();
    const first = resolvePrivateApprovalPolicyV1(firstInput);
    expect(() =>
      resolvePrivateApprovalPolicyV1({
        command: command({
          selected_policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
        }),
        prior_resolution: first,
      }),
    ).toThrow("command_id conflicts with prior resolution");
    expect(() =>
      resolvePrivateApprovalPolicyV1({
        command: command({ comment: "Changed rationale." }),
        prior_resolution: first,
      }),
    ).toThrow("command_id conflicts with prior resolution");
    expect(() =>
      resolvePrivateApprovalPolicyV1({
        command: firstInput.command,
        prior_resolution: {
          ...first,
          canonical_record_policy: {
            ...first.canonical_record_policy!,
            policy_contract_sha256: digest("f"),
          },
        },
      }),
    ).toThrow("canonical_record_policy is invalid");
  });

  it("rejects a prior reject with a readable policy", () => {
    const approved = resolvePrivateApprovalPolicyV1(input());
    expect(() =>
      resolvePrivateApprovalPolicyV1({
        command: command({ action: "reject", selected_policy_id: null }),
        prior_resolution: {
          ...approved,
          action: "reject",
        },
      }),
    ).toThrow("prior rejection resolution must not bind a policy");
  });
});
