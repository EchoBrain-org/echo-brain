import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { PersonClient } from "./client.js";
import { readPersonOnboardingInvitation } from "./onboarding-invitation.js";

const MAXIMUM_INPUT_BYTES = 64 * 1024;

interface Output {
  write(value: string): unknown;
}

export interface PersonClientCliDependencies {
  readonly stdout?: Output;
  readonly stderr?: Output;
  readonly home_directory?: string;
  readonly fetch?: typeof fetch;
  readonly allow_insecure_loopback?: boolean;
  readonly now?: () => string;
  readonly random_bytes?: (size: number) => Uint8Array;
  readonly random_uuid?: () => string;
  readonly read_input?: () => string | Promise<string>;
}

const OPTIONS = {
  "authority-url": { type: "string" },
  invitation: { type: "string" },
  bootstrap: { type: "boolean" },
  query: { type: "string" },
  "source-adapter-id": { type: "string" },
  "source-instance-id": { type: "string" },
  "meeting-external-id": { type: "string" },
  "challenge-attempt": { type: "string" },
  "challenge-message-ts": { type: "string" },
  limit: { type: "string" },
} as const;

type Option = keyof typeof OPTIONS;

const RULES: Readonly<
  Record<string, { accepts?: readonly Option[]; requires?: readonly Option[] }>
> = {
  "login-begin": {
    accepts: ["authority-url", "bootstrap", "invitation"],
  },
  login: {
    accepts: ["invitation"],
    requires: ["invitation"],
  },
  "session-install": {
    accepts: ["authority-url"],
    requires: ["authority-url"],
  },
  "session-refresh": {},
  logout: {},
  records: { accepts: ["limit", "query"] },
  exclusions: {
    accepts: ["source-adapter-id", "source-instance-id"],
    requires: ["source-adapter-id", "source-instance-id"],
  },
  exclude: {
    accepts: ["source-adapter-id", "source-instance-id", "meeting-external-id"],
    requires: ["source-adapter-id", "source-instance-id"],
  },
  include: {
    accepts: ["source-adapter-id", "source-instance-id", "meeting-external-id"],
    requires: ["source-adapter-id", "source-instance-id"],
  },
  "slack-link-begin": {},
  "slack-link": {},
  "slack-link-complete": {
    accepts: ["challenge-attempt", "challenge-message-ts"],
    requires: ["challenge-attempt", "challenge-message-ts"],
  },
};

function usage(): string {
  return `usage: echo-brain person <${Object.keys(RULES).join("|")}>`;
}

function print(output: Output, value: unknown): void {
  output.write(`${JSON.stringify(value)}\n`);
}

async function readBoundedStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAXIMUM_INPUT_BYTES) {
      throw new Error("Person client input exceeds 64 KiB");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

async function readBoundedStdinLine(): Promise<string> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const value = await prompt.question("");
    if (Buffer.byteLength(value, "utf8") > MAXIMUM_INPUT_BYTES) {
      throw new Error("Person client input exceeds 64 KiB");
    }
    return value;
  } finally {
    prompt.close();
  }
}

function requiredText(
  values: Record<Option, string | boolean | undefined>,
  option: Option,
): string {
  const value = values[option];
  if (typeof value !== "string") throw new Error(`missing --${option}`);
  return value;
}

function optionalRecordLimit(
  values: Record<Option, string | boolean | undefined>,
  maximum = 100,
): number | undefined {
  const value = values.limit;
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,2}$/.test(value) ||
    Number(value) > maximum
  ) {
    throw new Error(`--limit must be an integer from 1 to ${maximum}`);
  }
  return Number(value);
}

export async function runPersonClientCli(
  argv: readonly string[],
  dependencies: PersonClientCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const action = argv[0] ?? "";
  const rule = RULES[action];
  if (rule === undefined) {
    print(stderr, { ok: false, error: usage() });
    return 2;
  }

  let values: Record<Option, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: [...argv.slice(1)],
      strict: true,
      allowPositionals: false,
      options: OPTIONS,
    }).values as Record<Option, string | boolean | undefined>;
    const accepted = new Set(rule.accepts ?? []);
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined && !accepted.has(name as Option)) {
        throw new Error(
          `--${name} is not valid with \`echo-brain person ${action}\``,
        );
      }
    }
    for (const required of rule.requires ?? []) {
      if (values[required] === undefined) {
        throw new Error(
          `\`echo-brain person ${action}\` requires --${required}`,
        );
      }
    }
    if (
      action === "login-begin" &&
      values.invitation === undefined &&
      values["authority-url"] === undefined
    ) {
      throw new Error(
        "`echo-brain person login-begin` requires --authority-url or --invitation",
      );
    }
    if (
      action === "login-begin" &&
      values.invitation !== undefined &&
      (values["authority-url"] !== undefined || values.bootstrap !== undefined)
    ) {
      throw new Error(
        "`echo-brain person login-begin --invitation` cannot combine authority or bootstrap flags",
      );
    }
  } catch (error) {
    print(stderr, { ok: false, error: (error as Error).message });
    return 2;
  }

  const client = new PersonClient({
    home_directory: dependencies.home_directory ?? homedir(),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    allow_insecure_loopback: dependencies.allow_insecure_loopback === true,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.random_bytes === undefined
      ? {}
      : { random_bytes: dependencies.random_bytes }),
    ...(dependencies.random_uuid === undefined
      ? {}
      : { random_uuid: dependencies.random_uuid }),
  });
  const readInput = dependencies.read_input ?? readBoundedStdin;
  const readInteractiveLine = dependencies.read_input ?? readBoundedStdinLine;

  try {
    switch (action) {
      case "login-begin": {
        const invitationPath = values.invitation;
        if (typeof invitationPath === "string") {
          const invitation = readPersonOnboardingInvitation(invitationPath);
          print(stdout, {
            ok: true,
            ...(await client.beginLogin(
              invitation.authority_url,
              invitation.login_grant,
            )),
          });
          break;
        }
        const authorityUrl = requiredText(values, "authority-url");
        const loginGrant =
          values.bootstrap === true ? (await readInput()).trim() : undefined;
        print(stdout, {
          ok: true,
          ...(await client.beginLogin(authorityUrl, loginGrant)),
        });
        break;
      }
      case "login": {
        const invitation = readPersonOnboardingInvitation(
          requiredText(values, "invitation"),
        );
        const begun = await client.beginLogin(
          invitation.authority_url,
          invitation.login_grant,
        );
        // This is intentionally a two-part, one-process handoff: the founder
        // opens the URL, then pastes the callback JSON once on this command's
        // stdin. No grant or callback token is rendered by us.
        print(stdout, {
          ok: true,
          phase: "open-browser",
          authorization_url: begun.authorization_url,
          expires_at: begun.expires_at,
          instruction:
            "Open authorization_url, then paste the entire callback JSON response here and press Enter.",
        });
        print(stdout, {
          ok: true,
          phase: "installed",
          ...(await client.installSession(
            invitation.authority_url,
            JSON.parse(await readInteractiveLine()) as unknown,
          )),
        });
        break;
      }
      case "session-install":
        print(stdout, {
          ok: true,
          ...(await client.installSession(
            requiredText(values, "authority-url"),
            JSON.parse(await readInput()) as unknown,
          )),
        });
        break;
      case "session-refresh":
        print(stdout, { ok: true, ...(await client.refresh()) });
        break;
      case "logout":
        await client.logout();
        print(stdout, { ok: true });
        break;
      case "records": {
        const query = values.query;
        print(stdout, {
          ok: true,
          result: await client.records(
            optionalRecordLimit(values, query === undefined ? 100 : 10),
            typeof query === "string" ? query : undefined,
          ),
        });
        break;
      }
      case "exclusions":
        print(stdout, {
          ok: true,
          result: await client.exclusions(
            requiredText(values, "source-adapter-id"),
            requiredText(values, "source-instance-id"),
          ),
        });
        break;
      case "exclude":
      case "include": {
        const sourceAdapterId = requiredText(values, "source-adapter-id");
        const sourceInstanceId = requiredText(values, "source-instance-id");
        const externalId = values["meeting-external-id"];
        await client.changeExclusion(
          action === "exclude",
          typeof externalId === "string"
            ? {
                scope: "meeting",
                source_adapter_id: sourceAdapterId,
                source_instance_id: sourceInstanceId,
                external_id: externalId,
              }
            : {
                scope: "source",
                source_adapter_id: sourceAdapterId,
                source_instance_id: sourceInstanceId,
              },
        );
        print(stdout, { ok: true, excluded: action === "exclude" });
        break;
      }
      case "slack-link-begin":
        print(stdout, { ok: true, ...(await client.beginSlackLink()) });
        break;
      case "slack-link": {
        const begun = await client.beginSlackLink();
        // Retain the code and opaque challenge handles in memory. The founder
        // copies the code into Slack, then confirms with one empty line.
        print(stdout, {
          ok: true,
          phase: "reply-in-slack",
          challenge_code: begun.challenge_code,
          expires_at: begun.expires_at,
          instruction:
            "Reply with challenge_code in the Slack thread, then press Enter here to confirm.",
        });
        const acknowledgement = await readInteractiveLine();
        if (acknowledgement.trim().length !== 0) {
          throw new Error(
            "Person Slack link confirmation must be an empty Enter acknowledgement",
          );
        }
        print(stdout, {
          ok: true,
          phase: "linked",
          result: await client.completeSlackLink({
            challenge_attempt_id: begun.challenge_attempt_id,
            challenge_message_ts: begun.challenge_message_ts,
            challenge_code: begun.challenge_code,
          }),
        });
        break;
      }
      case "slack-link-complete":
        print(stdout, {
          ok: true,
          result: await client.completeSlackLink({
            challenge_attempt_id: requiredText(values, "challenge-attempt"),
            challenge_message_ts: requiredText(values, "challenge-message-ts"),
            challenge_code: (await readInput()).trim(),
          }),
        });
        break;
    }
    return 0;
  } catch (error) {
    print(stderr, {
      ok: false,
      action,
      error: (error as Error).message,
    });
    return 1;
  }
}
