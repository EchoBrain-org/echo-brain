import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { PersonClient } from "./client.js";
import { PersonAuthorityClientError } from "./authority-client.js";
import { PersonClientSessionUnavailableError } from "./session-store.js";
import { startPersonLoopbackHandoff } from "./browser-login-handoff.js";
import { readPersonOnboardingInvitation } from "./onboarding-invitation.js";
import { readPackagedPersonClientBuildIdentity } from "./package-identity.js";

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
  readonly open_authorization_url?: (url: string) => boolean | Promise<boolean>;
}

const OPTIONS = {
  "authority-url": { type: "string" },
  invitation: { type: "string" },
  question: { type: "string" },
  query: { type: "string" },
  "source-adapter-id": { type: "string" },
  "source-instance-id": { type: "string" },
  "meeting-external-id": { type: "string" },
  "challenge-attempt": { type: "string" },
  "challenge-message-ts": { type: "string" },
  name: { type: "string" },
  email: { type: "string" },
  out: { type: "string" },
  limit: { type: "string" },
} as const;

type Option = keyof typeof OPTIONS;

const RULES: Readonly<
  Record<string, { accepts?: readonly Option[]; requires?: readonly Option[] }>
> = {
  login: {
    accepts: ["invitation", "authority-url"],
  },
  start: {
    accepts: ["invitation"],
    requires: ["invitation"],
  },
  status: {},
  "session-refresh": {},
  logout: {},
  ask: {
    accepts: ["question"],
    requires: ["question"],
  },
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
  "employee-invite": {
    accepts: ["name", "email", "out"],
    requires: ["name", "email", "out"],
  },
  "employee-reissue": {
    accepts: ["email", "out"],
    requires: ["email", "out"],
  },
  "employee-revoke": {
    accepts: ["email"],
    requires: ["email"],
  },
  "employee-list": {},
};

function usage(): string {
  return "usage: echo-brain person <command> [options]";
}

const HELP: Readonly<Record<string, string>> = {
  person: `${usage()}

Commands:
  start       Complete invitation sign-in and verify that ECHO is ready.
  login       Sign in with an invitation or existing Authority identity.
  status      Show installed version and sign-in state.
  logout      Remove the local session.
  ask         Ask a question over records you may read.
  records     List records or search the current generation.
  employee    List, invite, reissue, or revoke an employee.
  slack-link  Link the signed-in founder to Slack.

Run \`echo-brain person <command> --help\` for command options.
`,
  start: `usage: echo-brain person start --invitation <path>

Installs the invited identity, opens Google sign-in, verifies one permission-aware read, and reports ready.
`,
  login: `usage: echo-brain person login (--invitation <path> | --authority-url <url>)

Provide exactly one option. The browser handoff completes sign-in without pasting callback data.
`,
  status: `usage: echo-brain person status

Shows the installed version, sign-in state, membership type, and Authority origin.
`,
  logout: `usage: echo-brain person logout

Removes the local session. A revoked session is also removed locally.
`,
  ask: `usage: echo-brain person ask --question <text>

Ask one bounded question. ECHO searches only records you may read and returns a cited answer.
`,
  records: `usage: echo-brain person records [--limit <1-100>] [--query <text>]

Without --query, lists recent released records. With --query, searches the current Layer 2 generation.
`,
  employee: `usage: echo-brain person employee <list|invite|reissue|revoke> [options]

Run \`echo-brain person employee <command> --help\` for required options.
`,
  "employee-invite": `usage: echo-brain person employee invite --name <name> --email <email> --out <absolute-path>

All options are required. --out must name a new file in a current-user 0700 directory.
`,
  "employee-reissue": `usage: echo-brain person employee reissue --email <email> --out <absolute-path>

All options are required. --out must name a new file in a current-user 0700 directory.
`,
  "employee-revoke": `usage: echo-brain person employee revoke --email <email>

--email is required. Revocation ends that employee membership immediately.
`,
  "employee-list": `usage: echo-brain person employee list

Shows each employee's name, canonical email, membership state, and invitation state. Owner only.
`,
};

/** Returns supported human CLI help without constructing a client or session. */
function personClientCliHelp(argv: readonly string[]): string | undefined {
  if (argv.length === 1 && argv[0] === "--help") return HELP.person;
  if (argv.length === 2 && argv[1] === "--help") return HELP[argv[0] ?? ""];
  if (
    argv.length === 3 &&
    argv[0] === "employee" &&
    argv[2] === "--help"
  ) {
    const action = ({
      invite: "employee-invite",
      reissue: "employee-reissue",
      revoke: "employee-revoke",
      list: "employee-list",
    } as const)[argv[1] as "invite" | "reissue" | "revoke" | "list"];
    return action === undefined ? undefined : HELP[action];
  }
  return undefined;
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

function openAuthorizationUrl(url: string): boolean {
  if (process.platform !== "darwin") return false;
  const opened = spawnSync("/usr/bin/open", [url], {
    stdio: "ignore",
    timeout: 10_000,
  });
  return opened.status === 0;
}

async function completePersonLogin(input: {
  readonly client: PersonClient;
  readonly authority_url: string;
  readonly login_grant?: string;
  readonly stdout: Output;
  readonly random_bytes?: (size: number) => Uint8Array;
  readonly open_browser?: (url: string) => boolean | Promise<boolean>;
}): Promise<void> {
  const handoff = await startPersonLoopbackHandoff({
    ...(input.random_bytes === undefined
      ? {}
      : { random_bytes: input.random_bytes }),
  });
  try {
    let begun;
    let recoveredConsumedInvitation = false;
    try {
      begun = await input.client.beginLogin(
        input.authority_url,
        input.login_grant,
        { url: handoff.url, token: handoff.token },
      );
    } catch (error) {
      // The Authority can complete an OIDC bootstrap even when a browser
      // never reaches this short-lived local receiver. In that case its
      // one-use invitation is consumed; retry once as the now-bound
      // identity, never by exposing the session in the callback.
      if (
        input.login_grant !== undefined &&
        error instanceof PersonAuthorityClientError &&
        error.code === "unauthorized" &&
        error.status === 401
      ) {
        begun = await input.client.beginLogin(
          input.authority_url,
          undefined,
          { url: handoff.url, token: handoff.token },
        );
        recoveredConsumedInvitation = true;
      } else {
        throw error;
      }
    }
    const browserOpened =
      input.open_browser === undefined
        ? undefined
        : await input.open_browser(begun.authorization_url);
    print(input.stdout, {
      ok: true,
      phase: "open-browser",
      authorization_url: begun.authorization_url,
      expires_at: begun.expires_at,
      ...(browserOpened === undefined ? {} : { browser_opened: browserOpened }),
      instruction: recoveredConsumedInvitation
        ? browserOpened === undefined
          ? "The invitation was already consumed. Open authorization_url to finish sign-in as the existing identity."
          : browserOpened
            ? "The invitation was already consumed. Finish sign-in as the existing identity in the opened browser."
            : "The invitation was already consumed. Open authorization_url to finish sign-in as the existing identity."
        : browserOpened === false
          ? "Open authorization_url to complete sign-in in your browser."
          : browserOpened === true
            ? "Complete sign-in in the opened browser."
            : "Open authorization_url to complete sign-in in your browser.",
    });
    print(input.stdout, {
      ok: true,
      phase: "installed",
      ...(await input.client.installSession(
        input.authority_url,
        await handoff.wait(),
      )),
    });
  } finally {
    await handoff.close();
  }
}

export async function runPersonClientCli(
  argv: readonly string[],
  dependencies: PersonClientCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const help = personClientCliHelp(argv);
  if (help !== undefined) {
    stdout.write(help);
    return 0;
  }
  const employeeAction =
    argv[0] === "employee"
      ? ({
          invite: "employee-invite",
          reissue: "employee-reissue",
          revoke: "employee-revoke",
          list: "employee-list",
        } as const)[
          argv[1] as "invite" | "reissue" | "revoke" | "list"
        ]
      : undefined;
  const action = employeeAction ?? (argv[0] ?? "");
  const rule = RULES[action];
  if (rule === undefined) {
    print(stderr, { ok: false, error: usage() });
    return 2;
  }

  let values: Record<Option, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: [...argv.slice(employeeAction === undefined ? 1 : 2)],
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
      action === "login" &&
      (values.invitation === undefined) === (values["authority-url"] === undefined)
    ) {
      throw new Error(
        "`echo-brain person login` requires exactly one of --invitation or --authority-url",
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
      case "login": {
        const invitation =
          typeof values.invitation === "string"
            ? readPersonOnboardingInvitation(values.invitation)
            : undefined;
        const authorityUrl = invitation?.authority_url ?? requiredText(values, "authority-url");
        await completePersonLogin({
          client,
          authority_url: authorityUrl,
          ...(invitation === undefined
            ? {}
            : { login_grant: invitation.login_grant }),
          stdout,
          ...(dependencies.random_bytes === undefined
            ? {}
            : { random_bytes: dependencies.random_bytes }),
        });
        break;
      }
      case "start": {
        const invitation = readPersonOnboardingInvitation(
          requiredText(values, "invitation"),
        );
        try {
          client.sessionSummary();
          throw new Error(
            "This Mac is already signed in to ECHO. Use the installed client for this person, or run `echo-brain person logout` before onboarding a different person.",
          );
        } catch (error) {
          if (!(error instanceof PersonClientSessionUnavailableError)) {
            throw error;
          }
        }
        await completePersonLogin({
          client,
          authority_url: invitation.authority_url,
          login_grant: invitation.login_grant,
          stdout,
          ...(dependencies.random_bytes === undefined
            ? {}
            : { random_bytes: dependencies.random_bytes }),
          open_browser:
            dependencies.open_authorization_url ?? openAuthorizationUrl,
        });
        const session = client.sessionSummary();
        await client.records(1);
        const identity = readPackagedPersonClientBuildIdentity();
        print(stdout, {
          ok: true,
          phase: "ready",
          installed_version: identity.product_version,
          membership_type: session.membership_type,
          connected_authority: session.authority_origin,
          permission_aware_read: "passed",
        });
        break;
      }
      case "status": {
        const identity = readPackagedPersonClientBuildIdentity();
        try {
          const session = client.sessionSummary();
          print(stdout, {
            schema_version: 1,
            kind: "echo-person-client-status-v1",
            installed_version: identity.product_version,
            signed_in: true,
            membership_type: session.membership_type,
            connected_authority: session.authority_origin,
          });
        } catch (error) {
          if (!(error instanceof PersonClientSessionUnavailableError)) {
            throw error;
          }
          print(stdout, {
            schema_version: 1,
            kind: "echo-person-client-status-v1",
            installed_version: identity.product_version,
            signed_in: false,
            membership_type: null,
            connected_authority: null,
          });
        }
        break;
      }
      case "session-refresh":
        print(stdout, { ok: true, ...(await client.refresh()) });
        break;
      case "logout":
        await client.logout();
        print(stdout, { ok: true });
        break;
      case "ask":
        print(stdout, {
          ok: true,
          result: await client.ask(requiredText(values, "question")),
        });
        break;
      case "records": {
        const query = values.query;
        try {
          print(stdout, {
            ok: true,
            result: await client.records(
              optionalRecordLimit(values, query === undefined ? 100 : 10),
              typeof query === "string" ? query : undefined,
            ),
          });
        } catch (error) {
          if (
            typeof query === "string" &&
            error instanceof PersonAuthorityClientError &&
            error.code === "unavailable"
          ) {
            throw new Error(
              "Search is catching up to the latest records; retry after the next worker cycle.",
            );
          }
          throw error;
        }
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
      case "employee-invite":
        print(stdout, {
          ok: true,
          ...(await client.inviteEmployee({
            name: requiredText(values, "name"),
            email: requiredText(values, "email"),
            output_path: requiredText(values, "out"),
          })),
        });
        break;
      case "employee-list":
        print(stdout, { ok: true, result: await client.employees() });
        break;
      case "employee-reissue":
        print(stdout, {
          ok: true,
          ...(await client.reissueEmployee({
            email: requiredText(values, "email"),
            output_path: requiredText(values, "out"),
          })),
        });
        break;
      case "employee-revoke":
        await client.revokeEmployee(requiredText(values, "email"));
        print(stdout, { ok: true, revoked: true });
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
