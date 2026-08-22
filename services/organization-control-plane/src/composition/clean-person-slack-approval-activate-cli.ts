import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
} from "../application/person-slack-approval-contracts-v2.js";
import { activatePersonSlackApprovalV2 } from "../application/person-slack-approval-activation-v2.js";
import { canonicalJson, canonicalSha256 } from "../canonical/canonical-json.js";
import { openOrganizationControlDatabase } from "../persistence/open-unmigrated-database.js";
import { CleanStoppedStateAuthorityAdministratorFenceV1 } from "../persistence/clean-stopped-state-authority-administrator-fence-v1.js";
import {
  selectCurrentFounderSlackApprovalTargetV1,
  type SelectedCleanPersonSlackApprovalTargetV1,
} from "../persistence/clean-person-slack-approval-target-v1.js";
import { SqlitePersonSlackApprovalActivationCoordinatorV2 } from "../persistence/sqlite-person-slack-approval-activation-v2.js";
import {
  verifyCleanControlPlaneStateV1,
  type VerifiedCleanControlPlaneStateV1,
} from "../persistence/verified-clean-control-plane-state-v1.js";

const APPROVAL_ADAPTER_INSTANCE_ID = "clean_slack_reactions_v1";
const APPROVAL_ADAPTER_VERSION = "1.0.0";
const APPROVE_REACTION = "white_check_mark";
const REJECT_REACTION = "x";

export interface CleanPersonSlackApprovalActivateCliIo {
  readonly stdout: (value: string) => void;
}

export interface CleanPersonSlackApprovalActivateCliDependencies {
  readonly verify_state: (
    stateDirectory: string,
  ) => VerifiedCleanControlPlaneStateV1;
  readonly now: () => string;
  readonly next_id: (kind: "approval_binding" | "action_capability") => string;
}

const PROCESS_IO: CleanPersonSlackApprovalActivateCliIo = {
  stdout: (value) => process.stdout.write(value),
};

const DEFAULT_DEPENDENCIES: CleanPersonSlackApprovalActivateCliDependencies = {
  verify_state: verifyCleanControlPlaneStateV1,
  now: () => new Date().toISOString(),
  next_id: (kind) =>
    `${kind === "approval_binding" ? "bnd" : "cap"}_${randomUUID()}`,
};

const USAGE =
  "usage: echo-organization-control-plane-activate-person-slack-approval " +
  "--state-dir <absolute-path> --connection-id <clean-slack-connection-id> " +
  "--approval-channel-id <slack-channel-id>";

interface ParsedFlags {
  readonly state_directory: string;
  readonly connection_id: string;
  readonly approval_channel_id: string;
}

function parseFlags(arguments_: readonly string[]): ParsedFlags {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      (flag !== "--state-dir" &&
        flag !== "--connection-id" &&
        flag !== "--approval-channel-id") ||
      value === undefined ||
      value.length === 0 ||
      values.has(flag)
    ) {
      throw new Error(USAGE);
    }
    values.set(flag, value);
  }
  const stateDirectory = values.get("--state-dir");
  const connectionId = values.get("--connection-id");
  const approvalChannelId = values.get("--approval-channel-id");
  if (
    stateDirectory === undefined ||
    connectionId === undefined ||
    approvalChannelId === undefined
  ) {
    throw new Error(USAGE);
  }
  return Object.freeze({
    state_directory: stateDirectory,
    connection_id: connectionId,
    approval_channel_id: approvalChannelId,
  });
}

function deterministicCommandId(input: {
  readonly state: VerifiedCleanControlPlaneStateV1;
  readonly target: SelectedCleanPersonSlackApprovalTargetV1;
  readonly approval_channel_id: string;
}): string {
  return `act_${canonicalSha256({
    approval_adapter_instance_id: APPROVAL_ADAPTER_INSTANCE_ID,
    approval_adapter_version: APPROVAL_ADAPTER_VERSION,
    approval_channel_id: input.approval_channel_id,
    authority_id: input.state.authority_id,
    connection_id: input.target.connection_id,
    external_identity_link_id: input.target.external_identity_link_id,
    kind: "echo-clean-person-slack-approval-activation-command-id-v1",
    organization_id: input.state.organization_id,
    state_lineage_id: input.state.state_lineage_id,
  }).slice("sha256:".length)}`;
}

function publicResult(
  result: Awaited<ReturnType<typeof activatePersonSlackApprovalV2>>,
) {
  return Object.freeze({
    action_capability_ids: result.action_capabilities.map(
      ({ body }) => body.action_capability_id,
    ),
    approval_binding_id: result.approval_binding.body.approval_binding_id,
    approval_channel_id: result.approval_binding.body.approval_channel_id,
    command_id: result.command_id,
    external_identity_link_id:
      result.action_capabilities[0]?.body.external_identity_link_id,
    organization_id: result.activated_by.organization_id,
    provider_connection_id: result.approval_binding.body.connection_id,
    state_lineage_id: result.activated_by.state_lineage_id,
  });
}

/**
 * Offline founder activation of the one clean Slack reaction approval surface.
 * It makes no provider call and accepts no administrator bearer or legacy IDs.
 */
export async function runCleanPersonSlackApprovalActivateCli(
  arguments_: readonly string[],
  io: CleanPersonSlackApprovalActivateCliIo = PROCESS_IO,
  dependencies: CleanPersonSlackApprovalActivateCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const flags = parseFlags(arguments_);
  const state = dependencies.verify_state(flags.state_directory);
  const authorityFence = new CleanStoppedStateAuthorityAdministratorFenceV1({
    authority_database_path: join(state.state_directory, "authority.sqlite"),
    authority_id: state.authority_id,
    organization_id: state.organization_id,
    state_lineage_id: state.state_lineage_id,
  });
  const database = openOrganizationControlDatabase(
    state.integrations_database_path,
    { fileMustExist: true },
  );
  try {
    // Establish the exact current owner before we choose the current link. The
    // activation coordinator rechecks both inside its stable fence and SQLite
    // transaction, so a changed link or membership fails closed.
    let owner:
      | { readonly principal_id: string; readonly membership_id: string }
      | undefined;
    await authorityFence.withStableAdministratorFence(
      Object.freeze({ kind: "clean-stopped-state-founder-v1" }),
      (fence) => {
        const administrator = fence.administrator as {
          readonly principal_id: string;
          readonly membership_id: string;
        };
        owner = Object.freeze({
          principal_id: administrator.principal_id,
          membership_id: administrator.membership_id,
        });
      },
    );
    if (owner === undefined)
      throw new Error("clean founder owner is unavailable");
    const target = selectCurrentFounderSlackApprovalTargetV1(
      database,
      state,
      flags,
      owner,
    );
    const result = await activatePersonSlackApprovalV2({
      credential: Object.freeze({ kind: "clean-stopped-state-founder-v1" }),
      command: {
        command_id: deterministicCommandId({
          state,
          target,
          approval_channel_id: flags.approval_channel_id,
        }),
        target_external_identity_link_id: target.external_identity_link_id,
        provider_connection_id: target.connection_id,
        approval_adapter_instance_id: APPROVAL_ADAPTER_INSTANCE_ID,
        approval_adapter_version: APPROVAL_ADAPTER_VERSION,
        approval_channel_id: flags.approval_channel_id,
        approve_reaction: APPROVE_REACTION,
        reject_reaction: REJECT_REACTION,
        policy_capabilities: [
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
      },
      coordinator: new SqlitePersonSlackApprovalActivationCoordinatorV2({
        database,
        authority_fence: authorityFence,
        now: dependencies.now,
      }),
      codec: { sha256: canonicalSha256 },
      ids: { next: dependencies.next_id },
    });
    io.stdout(`${canonicalJson(publicResult(result))}\n`);
    return 0;
  } finally {
    database.close();
  }
}
