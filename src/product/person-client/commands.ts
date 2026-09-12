import type { PersonToolCommandV1 } from '@echo-brain/organization-api';
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { EmployeeMutationError, PersonClient } from "./client.js";
import { PersonAuthorityClientError } from "./authority-client.js";
import { PersonClientSessionUnavailableError } from "./session-store.js";
import { startPersonLoopbackHandoff } from "./browser-login-handoff.js";
import {
  readPersonOnboardingInvitation,
} from "./onboarding-invitation.js";
import { readPackagedPersonClientBuildIdentity } from "./package-identity.js";

const MAXIMUM_INPUT_BYTES = 64 * 1024;

interface Output {
  write(value: string): unknown;
}

export interface PersonClientCliDependencies {
  readonly tool_commands?: readonly PersonToolCommandV1[];
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
  name: { type: "string" },
  email: { type: "string" },
  out: { type: "string" },
  limit: { type: "string" },
  "open-browser": { type: "boolean" },
  "record-sha256": { type: "string" },
} as const;

type Option = string;

const RULES: Readonly<
  Record<string, { accepts?: readonly Option[]; requires?: readonly Option[] }>
> = {
  login: {
    accepts: ["invitation", "authority-url", "open-browser"],
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
  records: { accepts: ["limit", "query", "record-sha256"] },
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
  "tools": {},
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
  tools       Read organization tools and your current link status.

Run \`echo-brain person <command> --help\` for command options.
`,
  start: `usage: echo-brain person start --invitation <path>

Installs the invited identity, opens Google sign-in, verifies one permission-aware read, and reports ready.
`,
  login: `usage: echo-brain person login (--invitation <path> | --authority-url <url>) [--open-browser]

Provide exactly one identity option. --open-browser opens the handoff automatically; otherwise the URL is printed for manual opening.
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
  records: `usage: echo-brain person records [--limit <1-100>] [--query <text>] [--record-sha256 <sha256:64hex>]

Lists recent records, searches the current index, or retrieves one exact readable cited record. --limit can refine --query; --record-sha256 cannot be combined with either.
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
function personClientCliHelp(argv: readonly string[], commands: readonly PersonToolCommandV1[]): string | undefined {
  const tool = commands.find(command => command.name === argv[0]);
  if (tool && argv.length === 2 && argv[1] === '--help') {
    return `usage: echo-brain person ${tool.name}${Object.keys(tool.options).map(option => ' --' + option + ' <value>').join('')}\n\n${tool.description}\n`;
  }
  if (argv.length === 1 && argv[0] === "--help") return HELP.person + commands.map(command => `  ${command.name}  ${command.description}\n`).join('');
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

export interface BrowserOpenerOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawn_sync?: typeof spawnSync;
}

/** Opens a browser only when the host supplies the platform's standard opener. */
export function openAuthorizationUrl(
  url: string,
  options: BrowserOpenerOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const command = platform === "darwin"
    ? "/usr/bin/open"
    : platform === "linux"
      ? "/usr/bin/xdg-open"
      : undefined;
  if (command === undefined) return false;
  try {
    const opened = (options.spawn_sync ?? spawnSync)(command, [url], {
      stdio: "ignore",
      timeout: 10_000,
      shell: false,
    });
    return opened.error === undefined && opened.status === 0;
  } catch {
    return false;
  }
}

/**
 * The Authority may use an OIDC login_hint to improve the directly opened
 * browser flow. It is private invitation metadata, so never repeat it in the
 * machine-readable receipt used for a manual-browser fallback.
 */
function manualAuthorizationUrl(authorizationUrl: string): string {
  const manual = new URL(authorizationUrl);
  manual.searchParams.delete("login_hint");
  return manual.toString();
}

async function completePersonLogin(input: {
  readonly client: PersonClient;
  readonly authority_url: string;
  readonly login_grant?: string;
  readonly invitation_expires_at?: string;
  /**
   * The address the invitation names, when it carries one. It is sent as an
   * OIDC `login_hint` to the directly opened browser, but is never written to
   * the terminal's machine-readable output.
   */
  readonly expected_email?: string;
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
    let recoveredExistingInvitation = false;
    try {
      begun = await input.client.beginLogin(
        input.authority_url,
        input.login_grant,
        { url: handoff.url, token: handoff.token },
        input.expected_email,
      );
    } catch (error) {
      // A prior bootstrap may have completed even when its browser never
      // reached this short-lived receiver. Try the now-bound identity once;
      // an invitation is consumed only by a definitive bootstrap outcome.
      if (
        input.login_grant !== undefined &&
        error instanceof PersonAuthorityClientError &&
        error.code === "unauthorized" &&
        error.status === 401
      ) {
        try {
          begun = await input.client.beginLogin(
            input.authority_url,
            undefined,
            { url: handoff.url, token: handoff.token },
          );
        } catch (recoveryError) {
          if (
            recoveryError instanceof PersonAuthorityClientError &&
            recoveryError.code === "unauthorized" &&
            recoveryError.status === 401
          ) {
            throw new Error(
              "This ECHO invitation could not start and no existing ECHO identity was found. It may be in progress, expired, invalid, or already used. Ask the ECHO owner to reissue it if needed.",
            );
          }
          throw recoveryError;
        }
        recoveredExistingInvitation = true;
      } else {
        throw error;
      }
    }
    const browserOpened =
      input.open_browser === undefined
        ? undefined
        : await input.open_browser(begun.authorization_url);
    const expectedAccountNotice =
      input.expected_email === undefined || recoveredExistingInvitation
        ? ""
        : "Sign in with the account named in the private invitation. ";
    const browserWasOpened = browserOpened === true;
    print(input.stdout, {
      ok: true,
      phase: "open-browser",
      ...(browserWasOpened
        ? {}
        : { authorization_url: manualAuthorizationUrl(begun.authorization_url) }),
      expires_at: begun.expires_at,
      timing: `Browser sign-in lasts up to 10 minutes; complete it before ${begun.expires_at}. ` +
        (input.invitation_expires_at === undefined ? "" :
          `The separate invitation expires at ${input.invitation_expires_at} (15 minutes after issue). `) +
        "Keep this command running and use a browser on this machine that can reach its loopback address (127.0.0.1). " +
        "Opening this URL on another computer will not return sign-in here. If time runs out, rerun the command; ask your owner to reissue an expired invitation. Already-bound people can use person login --authority-url <url>.",
      ...(browserOpened === undefined ? {} : { browser_opened: browserOpened }),
      instruction: recoveredExistingInvitation
        ? browserWasOpened
          ? "An existing ECHO identity was found. Continue sign-in in the opened browser."
          : "An existing ECHO identity was found. Open authorization_url to continue sign-in."
        : browserWasOpened
          ? `${expectedAccountNotice}Complete sign-in in the opened browser.`
          : `${expectedAccountNotice}Open authorization_url to complete sign-in in your browser.`,
    });
    const handoffResult = await handoff.wait();
    if (handoffResult.kind === "error") {
      if (handoffResult.code === "identity_not_bound") {
        throw new Error(
          input.login_grant === undefined
            ? "No existing ECHO identity was found. Ask the ECHO owner for an invitation."
            : input.expected_email === undefined
              ? "The selected Google account has no active ECHO identity. Select the invited Google account, or ask the ECHO owner to reissue the invitation."
              : "Sign-in could not be completed with the account named in the private invitation. Ask the ECHO owner to reissue the invitation, then run this command again and choose that account in the Google account chooser.",
        );
      }
      if (handoffResult.code === "retryable") {
        throw new Error(
          "Person browser sign-in can be retried. The invitation remains usable: rerun the same command before it expires and choose the account named in the private invitation.",
        );
      }
      throw new Error("Person browser sign-in could not be completed");
    }
    print(input.stdout, {
      ok: true,
      phase: "installed",
      ...(await input.client.installSession(
        input.authority_url,
        handoffResult.session,
      )),
    });
  } finally {
    await handoff.close();
  }
}

function requireSignedOut(client: PersonClient): void {
  try {
    client.sessionSummary();
  } catch (error) {
    if (error instanceof PersonClientSessionUnavailableError) return;
    throw error;
  }
  throw new Error(
    "This Mac is already signed in to ECHO. Use the installed client for this person, or run `echo-brain person logout` before onboarding a different person.",
  );
}

export async function runPersonClientCli(
  argv: readonly string[],
  dependencies: PersonClientCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const toolCommands = dependencies.tool_commands ?? [];
  const registered = new Map<string, PersonToolCommandV1>();
  for (const command of toolCommands) {
    if (registered.has(command.name) || Object.hasOwn(RULES, command.name) || !/^[a-z][a-z0-9-]*$/.test(command.name) ||
        command.requires?.some(name => !Object.hasOwn(command.options, name))) {
      throw new Error('Person tool command registration is invalid or duplicated');
    }
    registered.set(command.name, command);
  }
  const help = personClientCliHelp(argv, toolCommands);
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
  const toolCommand = registered.get(action);
  const rule = RULES[action] ?? (toolCommand === undefined ? undefined : { accepts: Object.keys(toolCommand.options), requires: toolCommand.requires });
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
      options: { ...OPTIONS, ...toolCommand?.options },
    }).values as Record<Option, string | boolean | undefined>;
    const accepted = new Set(rule.accepts ?? []);
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined && value !== false && !accepted.has(name as Option)) {
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
    if (action === "records") {
      if (
        values["record-sha256"] !== undefined &&
        (values.limit !== undefined || values.query !== undefined)
      ) {
        throw new Error("--record-sha256 cannot be combined with --query or --limit");
      }
      if (
        typeof values["record-sha256"] === "string" &&
        !/^sha256:[a-f0-9]{64}$/.test(values["record-sha256"])
      ) {
        throw new Error("--record-sha256 must be sha256 followed by 64 lowercase hex characters");
      }
    }
  } catch (error) {
    const employeeMutation =
      action === "employee-invite" ||
      action === "employee-reissue" ||
      action === "employee-revoke";
    print(stderr, {
      ok: false,
      error: (error as Error).message,
      ...(employeeMutation
        ? {
            action,
            code: "outcome_unknown",
            mutation_outcome: "not_submitted",
          }
        : {}),
    });
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
    if (toolCommand !== undefined) {
      await toolCommand.run({ host: client, values, print: (value) => print(stdout, value),
        read_input: async () => await readInput(), read_interactive_line: async () => await readInteractiveLine(),
        open_browser: dependencies.open_authorization_url ?? openAuthorizationUrl });
      return 0;
    }
    switch (action) {
      case "login": {
        requireSignedOut(client);
        const invitation =
          typeof values.invitation === "string"
            ? readPersonOnboardingInvitation(values.invitation)
            : undefined;
        const authorityUrl = invitation?.authority_url ?? requiredText(values, "authority-url");
        await completePersonLogin({
          client,
          authority_url: authorityUrl,
          login_grant: invitation?.login_grant,
          invitation_expires_at: invitation?.expires_at,
          expected_email: invitation?.expected_email,
          stdout,
          ...(dependencies.random_bytes === undefined
            ? {}
            : { random_bytes: dependencies.random_bytes }),
          ...(values["open-browser"] === true
            ? {
                open_browser: async (url: string) => {
                  const opened = await (
                    dependencies.open_authorization_url ?? openAuthorizationUrl
                  )(url);
                  if (!opened) throw new Error("Person browser could not be opened. Set a default browser, or rerun without --open-browser and open authorization_url on this same machine; its browser must reach 127.0.0.1.");
                  return true;
                },
              }
            : {}),
        });
        break;
      }
      case "start": {
        const invitation = readPersonOnboardingInvitation(
          requiredText(values, "invitation"),
        );
        requireSignedOut(client);
        await completePersonLogin({
          client,
          authority_url: invitation.authority_url,
          login_grant: invitation.login_grant,
          invitation_expires_at: invitation.expires_at,
          expected_email: invitation.expected_email,
          stdout,
          ...(dependencies.random_bytes === undefined
            ? {}
            : { random_bytes: dependencies.random_bytes }),
          open_browser:
            dependencies.open_authorization_url ?? openAuthorizationUrl,
        });
        const session = client.sessionSummary();
        try {
          await client.records(1);
        } catch (error) {
          // `completePersonLogin` has persisted a session, but `start` is not
          // complete until the Authority proves that session can read. Roll
          // back only the session installed by this attempt so the same
          // one-use invitation can recover through existing-identity login.
          // `logout` always removes the local credential; a failed remote
          // revocation must not hide the original readiness failure.
          try {
            await client.logout();
          } catch {
            // Preserve the readiness error reported to the person.
          }
          throw error;
        }
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
            display_name: session.display_name,
            membership_id: session.membership_id,
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
            display_name: null,
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
        const recordSha256 = values["record-sha256"];
        try {
          print(stdout, {
            ok: true,
            result: await client.records(
              optionalRecordLimit(values, query === undefined ? 100 : 10),
              typeof query === "string" ? query : undefined,
              typeof recordSha256 === "string"
                ? (recordSha256 as `sha256:${string}`)
                : undefined,
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
          result: await client.meetingIngestionExclusions(
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
        await client.changeMeetingIngestionExclusion(
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
      case "tools":
        print(stdout, { ok: true, result: await client.tools() });
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
      ...(error instanceof EmployeeMutationError
        ? { code: error.code, mutation_outcome: error.mutation_outcome }
        : {}),
    });
    return 1;
  }
}
