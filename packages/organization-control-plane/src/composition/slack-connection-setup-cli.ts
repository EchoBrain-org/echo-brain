import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SlackWebIdentityProviderV1 } from "../adapters/slack/slack-web-identity-provider-v1.js";
import { canonicalJson } from "../canonical/canonical-json.js";
import { openOrganizationControlDatabase } from "../persistence/open-organization-control-database.js";
import {
  connectSlackConnectionV1,
  type ConnectedSlackConnectionV1,
  type SlackConnectionVerifierV1,
} from "../persistence/sqlite-slack-connection-coordinator-v1.js";
import {
  verifyOrganizationControlStateV1,
  type VerifiedOrganizationControlStateV1,
} from "../persistence/verified-organization-control-state-v1.js";
import { FileOrganizationSecretStore } from "../security/file-secret-store.js";
import { SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES } from "../application/slack-integration-contracts.js";

export interface SlackConnectionSetupCliIo {
  readonly stdout: (value: string) => void;
  readonly read_stdin: () => Promise<string>;
}

export interface SlackConnectionSetupCliDependencies {
  readonly verify_state: (
    stateDirectory: string,
  ) => VerifiedOrganizationControlStateV1;
  readonly create_verifier: () => SlackConnectionVerifierV1;
  readonly now: () => string;
}

const PROCESS_IO: SlackConnectionSetupCliIo = {
  stdout: (value) => process.stdout.write(value),
  read_stdin: async () => {
    process.stdin.setEncoding("utf8");
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    return input;
  },
};

const DEFAULT_DEPENDENCIES: SlackConnectionSetupCliDependencies = {
  verify_state: verifyOrganizationControlStateV1,
  create_verifier: () => new SlackWebIdentityProviderV1(),
  now: () => new Date().toISOString(),
};

const USAGE =
  "usage: echo-organization-control-plane-connect-slack " +
  "--state-dir <absolute-path> --approval-channel-id <slack-channel-id> " +
  "[--connection-id <public-connection-id>] < bot-token";

interface ParsedFlags {
  readonly state_directory: string;
  readonly approval_channel_id: string;
  readonly connection_id: string;
}

function parseFlags(arguments_: readonly string[]): ParsedFlags {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      (flag !== "--state-dir" &&
        flag !== "--approval-channel-id" &&
        flag !== "--connection-id") ||
      value === undefined ||
      value.length === 0 ||
      values.has(flag)
    ) {
      throw new Error(USAGE);
    }
    values.set(flag, value);
  }
  const stateDirectory = values.get("--state-dir");
  const approvalChannelId = values.get("--approval-channel-id");
  if (stateDirectory === undefined || approvalChannelId === undefined) {
    throw new Error(USAGE);
  }
  return Object.freeze({
    state_directory: stateDirectory,
    approval_channel_id: approvalChannelId,
    connection_id: values.get("--connection-id") ?? `con_${randomUUID()}`,
  });
}

/** Reads exactly one non-empty, newline-terminated-or-EOF token without echoing it. */
function oneStdinToken(input: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 16 * 1024
  ) {
    throw new Error(
      "Slack bot token stdin must contain exactly one bounded token",
    );
  }
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (
    lines.length !== 1 ||
    lines[0] === undefined ||
    lines[0].length === 0 ||
    lines[0].trim() !== lines[0]
  ) {
    throw new Error("Slack bot token stdin must contain exactly one token");
  }
  return lines[0];
}

function publicResult(
  result: ConnectedSlackConnectionV1,
  approvalChannelId: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    approval_channel_id: approvalChannelId,
    idempotent: result.idempotent,
    provider_app_id: result.connection.provider_app_id,
    provider_bot_id: result.connection.provider_bot_id,
    provider_bot_user_id: result.connection.provider_bot_user_id,
    provider_enterprise_id: result.connection.provider_enterprise_id,
    provider_tenant_id: result.connection.provider_tenant_id,
    required_scopes: SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
    ...result.channel_verification,
    verified_at: result.state.verified_at,
  });
}

/**
 * Offline Slack connection setup: verify the organization lineage, then
 * connect one Slack bot. It does not start a server or touch legacy runtime state.
 */
export async function runSlackConnectionSetupCli(
  arguments_: readonly string[],
  io: SlackConnectionSetupCliIo = PROCESS_IO,
  dependencies: SlackConnectionSetupCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const flags = parseFlags(arguments_);
  const state = dependencies.verify_state(flags.state_directory);
  const slackBotToken = oneStdinToken(await io.read_stdin());
  const database = openOrganizationControlDatabase(
    state.integrations_database_path,
    { fileMustExist: true },
  );
  try {
    const result = await connectSlackConnectionV1({
      authority_id: state.authority_id,
      organization_id: state.organization_id,
      state_lineage_id: state.state_lineage_id,
      connection_id: flags.connection_id,
      approval_channel_id: flags.approval_channel_id,
      slack_bot_token: slackBotToken,
      database,
      secrets: new FileOrganizationSecretStore(
        join(state.state_directory, "secrets"),
      ),
      verifier: dependencies.create_verifier(),
      now: dependencies.now,
    });
    io.stdout(
      `${canonicalJson(publicResult(result, flags.approval_channel_id))}\n`,
    );
    return 0;
  } finally {
    database.close();
  }
}
