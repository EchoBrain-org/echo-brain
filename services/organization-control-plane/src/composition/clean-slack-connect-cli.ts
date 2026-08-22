import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CleanSlackWebIdentityProviderV1 } from "../adapters/slack/clean-slack-web-identity-provider-v1.js";
import { canonicalJson } from "../canonical/canonical-json.js";
import { openOrganizationControlDatabase } from "../persistence/open-unmigrated-database.js";
import {
  connectCleanSlackV1,
  type CleanSlackConnectionVerifierV1,
  type ConnectedCleanSlackV1,
} from "../persistence/sqlite-clean-slack-connection-v1.js";
import {
  verifyCleanControlPlaneStateV1,
  type VerifiedCleanControlPlaneStateV1,
} from "../persistence/verified-clean-control-plane-state-v1.js";
import { FileOrganizationSecretStore } from "../security/file-secret-store.js";

export interface CleanSlackConnectCliIo {
  readonly stdout: (value: string) => void;
  readonly read_stdin: () => Promise<string>;
}

export interface CleanSlackConnectCliDependencies {
  readonly verify_state: (
    stateDirectory: string,
  ) => VerifiedCleanControlPlaneStateV1;
  readonly create_verifier: () => CleanSlackConnectionVerifierV1;
  readonly now: () => string;
}

const PROCESS_IO: CleanSlackConnectCliIo = {
  stdout: (value) => process.stdout.write(value),
  read_stdin: async () => {
    process.stdin.setEncoding("utf8");
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    return input;
  },
};

const DEFAULT_DEPENDENCIES: CleanSlackConnectCliDependencies = {
  verify_state: verifyCleanControlPlaneStateV1,
  create_verifier: () => new CleanSlackWebIdentityProviderV1(),
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
  result: ConnectedCleanSlackV1,
  approvalChannelId: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    approval_channel_id: approvalChannelId,
    connection_id: result.connection.connection_id,
    credential_reference_sha256: result.state.credential_reference_sha256,
    idempotent: result.idempotent,
    organization_id: result.connection.organization_id,
    provider_app_id: result.connection.provider_app_id,
    provider_bot_id: result.connection.provider_bot_id,
    provider_bot_user_id: result.connection.provider_bot_user_id,
    provider_enterprise_id: result.connection.provider_enterprise_id,
    provider_tenant_id: result.connection.provider_tenant_id,
    state_lineage_id: result.connection.state_lineage_id,
    verified_at: result.state.verified_at,
  });
}

/**
 * Offline founder command: verify clean lineage, then connect one Slack bot.
 * It does not start a server or touch legacy runtime state.
 */
export async function runCleanSlackConnectCli(
  arguments_: readonly string[],
  io: CleanSlackConnectCliIo = PROCESS_IO,
  dependencies: CleanSlackConnectCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const flags = parseFlags(arguments_);
  const state = dependencies.verify_state(flags.state_directory);
  const slackBotToken = oneStdinToken(await io.read_stdin());
  const database = openOrganizationControlDatabase(
    state.integrations_database_path,
    { fileMustExist: true },
  );
  try {
    const result = await connectCleanSlackV1({
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
