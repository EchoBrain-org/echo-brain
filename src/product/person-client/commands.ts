import { validatePersonDocumentAssociateV1, validatePersonDocumentDissociateV1 } from '@echo-brain/organization-api';
import { DocumentFileError } from './document-file.js';
import { validateProjectContextAudienceV1, validatePersonDocumentSearchV1 } from '@echo-brain/organization-api';
import { readUpdateFile } from './update-file.js';
import { validatePersonUpdateSubmitV2, validatePersonUpdateRequestId, validatePersonUploadAudienceV2, validateProjectIdV1, validateProjectCreateV1, validateProjectMemberAddV1, validateProjectMemberSetV1, validateProjectMemberRemoveV1, validateProjectContextAssociateV1, validateProjectContextDissociateV1 } from '@echo-brain/organization-api';
import { PersonQueryInputError, validatePersonQueryText } from "@echo-brain/organization-api";
import { validatePersonSourceEvidenceReadRequestV1 } from '@echo-brain/organization-api';
import type { PersonToolCommandV1 } from '@echo-brain/organization-api';
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { EmployeeMutationError, PersonClient } from "./client.js";
import { PersonAuthorityClientError, PersonContextMutationError } from "./authority-client.js";
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
  "document-id": { type: "string" },
  audience: { type: "string" },
  "expected-membership-id": { type: "string" },
  "expected-authority": { type: "string" },
  "request-id": { type: "string" },
  "context-id": { type: "string" },
  visibility: { type: "string" },
  "project-id": { type: "string" },
  project: { type: "string" },
  "source-id": { type: "string" },
  "revision-id": { type: "string" },
  "source-sha256": { type: "string" },
  "representation-sha256": { type: "string" },
  "anchor-sha256": { type: "string" },
  "audience-project-id": { type: "string" },
  "membership-id": { type: "string" },
  role: { type: "string" },
  cursor: { type: "string" },
  title: { type: "string" },
  file: { type: "string" },
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
  "documents-upload": { accepts: ["file", "audience", "audience-project-id", "project-id", "title", "request-id", "expected-membership-id", "expected-authority"], requires: ["file", "audience", "title", "request-id"] },
  "documents-associate": { accepts: ["request-id", "document-id", "project-id", "expected-membership-id", "expected-authority"], requires: ["request-id", "document-id", "project-id"] },
  "documents-dissociate": { accepts: ["request-id", "document-id", "project-id", "expected-membership-id", "expected-authority"], requires: ["request-id", "document-id", "project-id"] },
  "documents-pending": { accepts: [], requires: [] },
  "documents-retry": { accepts: ["request-id", "expected-membership-id", "expected-authority"], requires: ["request-id"] },
  "documents-abandon": { accepts: ["request-id", "expected-membership-id", "expected-authority"], requires: ["request-id"] },
  "documents-status": { accepts: ["request-id"], requires: ["request-id"] },
  "documents-read": { accepts: ["document-id", "cursor", "project-id"], requires: ["document-id"] },
  "documents-search": { accepts: ["project-id", "query", "limit", "cursor"] },
  "documents-download": { accepts: ["document-id", "out", "project-id"], requires: ["document-id", "out"] },
  "projects-list": { accepts: ["limit", "cursor"] },
  "projects-create": { accepts: ["request-id", "name"], requires: ["request-id", "name"] },
  "projects-read": { accepts: ["project-id"], requires: ["project-id"] },
  "projects-members": { accepts: ["project-id", "limit", "cursor"], requires: ["project-id"] },
  "projects-directory": { accepts: ["project-id", "query", "limit", "cursor"], requires: ["project-id"] },
  "projects-member-add": { accepts: ["request-id", "project-id", "membership-id"], requires: ["request-id", "project-id", "membership-id"] },
  "projects-member-set": { accepts: ["request-id", "project-id", "membership-id", "role"], requires: ["request-id", "project-id", "membership-id", "role"] },
  "projects-member-remove": { accepts: ["request-id", "project-id", "membership-id"], requires: ["request-id", "project-id", "membership-id"] },
  "projects-associate": { accepts: ["request-id", "project-id", "context-id"], requires: ["request-id", "project-id", "context-id"] },
  "projects-dissociate": { accepts: ["request-id", "project-id", "context-id"], requires: ["request-id", "project-id", "context-id"] },
  "projects-feed": { accepts: ["project-id", "limit", "cursor"], requires: ["project-id"] },
  "projects-search": { accepts: ["project-id", "query", "limit", "cursor"], requires: ["project-id", "query"] },
  "projects-read-context": { accepts: ["project-id", "context-id"], requires: ["project-id", "context-id"] },
  "updates-submit": { accepts: ["request-id", "title", "file", "visibility", "audience-project-id", "project-id"], requires: ["request-id", "title", "file"] },
  "updates-status": { accepts: ["request-id"], requires: ["request-id"] },
  "updates-search": { accepts: ["query", "limit"], requires: ["query"] },
  "updates-read": { accepts: ["context-id"], requires: ["context-id"] },
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
    accepts: ["question", "project"],
    requires: ["question"],
  },
  "ask-source": {
    accepts: ["source-id", "revision-id", "source-sha256", "representation-sha256", "anchor-sha256", "document-id", "project"],
    requires: ["source-id", "revision-id", "source-sha256", "representation-sha256", "anchor-sha256"],
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
  status      Show client build identity and sign-in state.
  logout      Remove the local session.
  ask         Ask a question over records you may read.
  records     List records or search the current generation.
  projects    Create projects, manage members, and browse permitted context.
  updates     Upload, search, and read original context with your chosen visibility.
  documents   Upload documents, read extracted text, and download exact originals.
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

Shows installed_version, client_build source_sha/source_kind, sign-in state, membership type, and Authority origin.
Client provenance does not identify the Authority build serving requests. Status is local and makes no network request.
`,
  tools: `usage: echo-brain person tools\n\nShows organization tools and your current link status. Provider command help remains available through each command.\n`,
  logout: `usage: echo-brain person logout

Removes the local session. A revoked session is also removed locally.
`,
  ask: `usage: echo-brain person ask --question <text> [--project <project-id>]

Ask one question using at most 240 Unicode code points, 1–32 distinct normalized terms and at most 64 UTF-8 bytes per term. Use NFC text on one line without edge whitespace. Without --project, ECHO retrieves across context you may read. With --project, it retrieves only context proven associated with that current project. Answers include typed citations.
`,
  "ask-source": `usage: echo-brain person ask-source --source-id <source-id> --revision-id <revision-id> --source-sha256 <sha256:64hex> --representation-sha256 <sha256:64hex> --anchor-sha256 <sha256:64hex> [--document-id <document-id>] [--project <project-id>]

Reads one bounded immutable source-evidence packet cited by Ask. Use the exact citation fields. The server rechecks your current access and project association before returning it; this never downloads an original file.
`,
  records: `usage: echo-brain person records [--limit <1-100>] [--query <text>] [--record-sha256 <sha256:64hex>]

Search --limit is 1–10; list --limit is 1–100. Queries use the same text bounds as Ask. Lists recent records, searches the current index, or retrieves one exact readable cited record. --limit can refine --query; --record-sha256 cannot be combined with either.
`,
  documents: `usage: echo-brain person documents <upload|status|pending|retry|abandon|read|search|download|associate|dissociate> [options]

Supports UTF-8 text/Markdown, PDF and Word .docx originals up to 25 MiB. Saving and text extraction are separate states. Project association does not change audience. Extracted originals can contribute typed evidence to authorized Ask results.
`,
  "documents-upload": `usage: echo-brain person documents upload --file <path> --audience <only-me|team|project> [--audience-project-id <id>] [--project-id <id>] --title <title> --request-id <uuid>

Saves exact original bytes; prints a bounded receipt. PDF and DOCX extraction may finish later or fail while the original stays saved. Legacy .doc is unsupported. If the outcome is unknown, the private exact snapshot is retained for documents retry --request-id with no source pathname required; source file changes are ignored for that retained request. At most ten unresolved snapshots are retained per membership. Use pending to list retained requests and status to reconcile before starting another upload. Explicit abandon removes only local retry bytes; it never cancels or deletes a saved Authority document. Optional paired --expected-membership-id and --expected-authority bind automation to its captured signed-in account.
`,
  "documents-associate": `usage: echo-brain person documents associate --document-id <id> --project-id <id> --request-id <uuid>

Links your saved document to a project without changing its audience. An Only me document remains private. Keep the exact request ID and coordinates for retry after an unknown outcome. Optional paired --expected-membership-id and --expected-authority bind the operation to its captured account.
`,
  "documents-dissociate": `usage: echo-brain person documents dissociate --document-id <id> --project-id <id> --request-id <uuid>

Removes the project association without deleting the original or changing its audience. The uploader or a project lead may remove an association they can read. Retry unknown outcomes using the same request ID and coordinates.
`,
  "documents-pending": `usage: echo-brain person documents pending

Lists this account's retained upload requests without reading source files or contacting the Authority.
`,
  "documents-retry": `usage: echo-brain person documents retry --request-id <uuid>

Resends the exact retained original and metadata, even after restart or source-file deletion. Check status first. Optional paired --expected-membership-id and --expected-authority bind the operation to its captured account.
`,
  "documents-abandon": `usage: echo-brain person documents abandon --request-id <uuid>

Explicitly removes only this account's local retry snapshot. This does not cancel or delete an Authority upload. Keep the request ID and check status or search before starting a new upload to avoid a duplicate. Optional paired --expected-membership-id and --expected-authority bind local cleanup to its captured account.
`,
  "documents-status": `usage: echo-brain person documents status --request-id <uuid>

Reads the saved document metadata and current extraction state.
`,
  "documents-read": `usage: echo-brain person documents read --document-id <id> [--cursor <opaque>] [--project-id <id>]

Returns metadata and one bounded page of extracted text with original hash and page/paragraph anchors. Follow text.next_cursor for more.
`,
  "documents-search": `usage: echo-brain person documents search [--project-id <id>] [--query <text>] [--limit <1-20>] [--cursor <opaque>]

Omit --query to list currently accessible documents. Search queries are at most 200 UTF-8 bytes. Project scope requires association as well as current access.
`,
  "documents-download": `usage: echo-brain person documents download --document-id <id> --out <new-file> [--project-id <id>]

Streams the exact saved original to a new file, verifies its length and SHA-256, and publishes it atomically. Prints only the file path and byte/hash proof.
`,
  projects: `usage: echo-brain person projects <list|create|read|members|directory|member-add|member-set|member-remove|associate|dissociate|feed|search|read-context> [options]

Projects organize original context. Association does not change its audience. Only projects list is the capability probe; a canonical 404 there means Not live yet. Use person ask --project for a strict project-scoped answer.
`,
  "projects-list": `usage: echo-brain person projects list [--limit <1-10>] [--cursor <opaque-base64url>]

Lists your current projects. This is the sole capability probe; an individual project's not_found response is not a capability result.
`,
  "projects-create": `usage: echo-brain person projects create --request-id <uuid> --name <name>

Creates a project with you as its initial lead. Retain the request ID for exact replay after an unknown outcome.
`,
  "projects-read": `usage: echo-brain person projects read --project-id <project-id>

Read one currently accessible project.
`,
  "projects-members": `usage: echo-brain person projects members --project-id <project-id> [--limit <1-10>] [--cursor <opaque-base64url>]

Lists the project's current members and leads.
`,
  "projects-directory": `usage: echo-brain person projects directory --project-id <project-id> [--query <text>] [--limit <1-10>] [--cursor <opaque-base64url>]

Leads can browse active organization members by name, or narrow the directory with a display-name search.
`,
  "projects-member-add": `usage: echo-brain person projects member-add --request-id <uuid> --project-id <project-id> --membership-id <membership-id>

Leads add a member without changing an existing member's role. Retain the exact request for replay.
`,
  "projects-member-set": `usage: echo-brain person projects member-set --request-id <uuid> --project-id <project-id> --membership-id <membership-id> --role <member|lead>

Leads add members or change their project role. Retain the exact request for replay; the last lead cannot voluntarily leave or be demoted.
`,
  "projects-member-remove": `usage: echo-brain person projects member-remove --request-id <uuid> --project-id <project-id> --membership-id <membership-id>

Leads remove a project membership. Retain the exact request for replay.
`,
  "projects-associate": `usage: echo-brain person projects associate --request-id <uuid> --project-id <project-id> --context-id <context-id>

Associate one readable original with a project. Association does not change its audience; a private original stays private. Explicitly dissociate before moving it.
`,
  "projects-dissociate": `usage: echo-brain person projects dissociate --request-id <uuid> --project-id <project-id> --context-id <context-id>

Remove the association without changing the original or its audience. Refresh the project feed; old upload receipts retain their initial association.
`,
  "projects-feed": `usage: echo-brain person projects feed --project-id <project-id> [--limit <1-10>] [--cursor <opaque-base64url>]

Browse currently permitted originals in this project. Each page checks access again; pages do not form a stable snapshot.
`,
  "projects-search": `usage: echo-brain person projects search --project-id <project-id> --query <text> [--limit <1-10>] [--cursor <opaque-base64url>]

Search permitted originals within this project. An empty query is invalid; use feed to browse.
`,
  "projects-read-context": `usage: echo-brain person projects read-context --project-id <project-id> --context-id <context-id>

Read the original under current project and audience access checks.
`,
  updates: `usage: echo-brain person updates <submit|status|search|read> [options]

Uploads preserve the original text. Only me is the default; Team explicitly shares it with current organization members. No Slack approval or decision extraction is required.
`,
  "updates-submit": `usage: echo-brain person updates submit --request-id <uuid> --title <title> --file <utf8-text-file> [--visibility <only-me|team|project>] [--audience-project-id <project-id>] [--project-id <project-id>]

Saves this UTF-8 file (at most 8 KiB) unchanged in your organization. Only me is the default; Team makes it readable to current organization members immediately. It is searchable without waiting for optional metadata. Project sharing requires --audience-project-id; Only me and Team forbid it. The independent --project-id associates the original with a project without changing its audience. Keep the request ID and immutable file, title, audience, and both project coordinates: after an unknown outcome, check V2 status with the same ID before an exact replay. No V1 fallback is performed.
`,
  "updates-status": `usage: echo-brain person updates status --request-id <uuid>

Shows your saved V2 receipt, selected audience, initial association, and optional search-metadata progress. The initial association does not report later association changes. Metadata failure does not prevent reading or searching the original.
`,
  "updates-search": `usage: echo-brain person updates search --query <text> [--limit <1-10>]

Find original uploads you may read. Optional search hints help matching; excerpts come from the original text.
`,
  "updates-read": `usage: echo-brain person updates read --context-id <id>

Open the original uploaded text under its current access checks.
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
  if (argv.length === 3 && (argv[0] === 'updates' || argv[0] === 'projects' || argv[0] === 'documents') && argv[2] === '--help') return HELP[`${argv[0]}-${argv[1]}`];
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

function printDocument(output: Output, result: unknown): void {
  const text = `${JSON.stringify({ ok: true, result })}\n`;
  if (Buffer.byteLength(text) > 32 * 1024) throw new PersonAuthorityClientError('invalid_response', null, 'Document response exceeded its CLI output bound.');
  output.write(text);
}

function isContextAction(action: string): boolean {
  return action.startsWith('projects-') || action.startsWith('updates-') || action.startsWith('documents-');
}

function contextCliFailure(action: string, error: unknown, values: Record<Option, string | boolean | undefined>) {
  const mutation = ['projects-create', 'projects-member-add', 'projects-member-set', 'projects-member-remove', 'projects-associate', 'projects-dissociate', 'updates-submit', 'documents-upload', 'documents-retry', 'documents-associate', 'documents-dissociate'].includes(action);
  let requestId: string | undefined;
  try { requestId = validatePersonUpdateRequestId(values['request-id']); } catch { /* Never echo invalid caller input. */ }
  return {
    ok: false,
    action,
    error: error instanceof DocumentFileError ? error.message : error instanceof PersonAuthorityClientError ? error.message
      : error instanceof PersonClientSessionUnavailableError ? 'Sign in before requesting project context.'
      : 'Project context request is invalid. Check the command help and input bounds.',
    code: error instanceof DocumentFileError ? error.code : error instanceof PersonAuthorityClientError ? error.code
      : error instanceof PersonClientSessionUnavailableError ? 'sign_in_required' : 'invalid_request',
    ...(error instanceof PersonAuthorityClientError ? { status: error.status } : {}),
    ...(mutation ? {
      mutation_outcome: error instanceof PersonContextMutationError ? error.mutation_outcome : 'not_submitted',
      ...(requestId === undefined ? {} : { request_id: requestId }),
    } : {}),
  };
}

function contextPaging(values: Record<Option, string | boolean | undefined>) {
  if (values.limit !== undefined && (typeof values.limit !== 'string' || !/^(?:[1-9]|10)$/.test(values.limit))) {
    throw new Error('Invalid project context limit');
  }
  return {
    ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
    ...(values.cursor === undefined ? {} : { cursor: requiredText(values, 'cursor') }),
  };
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
    throw new PersonQueryInputError("invalid_limit", `--limit must be an integer from 1 to ${maximum}`);
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
    if (registered.has(command.name) || (command.name === 'updates' || command.name === 'projects' || command.name === 'documents') || Object.hasOwn(RULES, command.name) || !/^[a-z][a-z0-9-]*$/.test(command.name) ||
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
  const documentAction = argv[0] === 'documents' ? `documents-${argv[1] ?? ''}` : undefined;
  const updateAction = argv[0] === 'updates' && ['submit', 'status', 'search', 'read'].includes(argv[1] ?? '') ? `updates-${argv[1]}` : undefined;
  const projectAction = argv[0] === 'projects' ? `projects-${argv[1] ?? ''}` : undefined;
  const action = documentAction ?? projectAction ?? updateAction ?? employeeAction ?? (argv[0] ?? "");
  const toolCommand = registered.get(action);
  const rule = RULES[action] ?? (toolCommand === undefined ? undefined : { accepts: Object.keys(toolCommand.options), requires: toolCommand.requires });
  if (rule === undefined) {
    print(stderr, { ok: false, error: usage() });
    return 2;
  }

  let values: Record<Option, string | boolean | undefined> = {};
  try {
    const args = [...argv.slice(employeeAction === undefined && updateAction === undefined && projectAction === undefined && documentAction === undefined ? 1 : 2)];
    // Accept a negative integer as a limit value so the existing bounds explain
    // it. Other dash-prefixed values retain parseArgs' strict option behavior.
    if (action === "records") {
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--limit" && /^-[0-9]+$/.test(args[i + 1] ?? "")) {
          args.splice(i, 2, `--limit=${args[i + 1]}`);
        } else if (args[i] === "--query" || args[i] === "--record-sha256") { i += 1; }
      }
    }
    const parsed = parseArgs({
      args,
      strict: true,
      tokens: true,
      allowPositionals: false,
      options: { ...OPTIONS, ...toolCommand?.options },
    });
    values = parsed.values as Record<Option, string | boolean | undefined>;
    if (isContextAction(action)) {
      const seen = new Set<string>();
      for (const token of parsed.tokens) {
        if (token.kind !== 'option') continue;
        if (seen.has(token.name)) {
          delete values[token.name];
          throw new Error('Duplicate project context option');
        }
        seen.add(token.name);
      }
    }
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
    if (isContextAction(action)) {
      print(stderr, contextCliFailure(action, error, values));
      return 2;
    }
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
      case 'documents-upload': {
        const requestId = validatePersonUpdateRequestId(requiredText(values, 'request-id'));
        const audienceKind = requiredText(values, 'audience');
        if (!['only-me', 'team', 'project'].includes(audienceKind)) throw new Error('Invalid document audience');
        const audience = validateProjectContextAudienceV1({ kind: audienceKind === 'only-me' ? 'only_me' : audienceKind,
          ...(values['audience-project-id'] === undefined ? {} : { project_id: requiredText(values, 'audience-project-id') }) });
        printDocument(stdout, await client.uploadDocument({ file: requiredText(values, 'file'), request_id: requestId,
          title: requiredText(values, 'title'), audience, project_id: values['project-id'] === undefined ? null : validateProjectIdV1(values['project-id']),
          ...(values['expected-membership-id'] === undefined ? {} : { expected_membership_id: requiredText(values, 'expected-membership-id') }),
          ...(values['expected-authority'] === undefined ? {} : { expected_authority: requiredText(values, 'expected-authority') }) }));
        break;
      }
      case 'documents-associate':
      case 'documents-dissociate': {
        const validate = action === 'documents-associate' ? validatePersonDocumentAssociateV1 : validatePersonDocumentDissociateV1;
        const request = validate({ schema_version: 1, kind: action === 'documents-associate' ? 'echo-person-document-associate-v1' : 'echo-person-document-dissociate-v1',
          request_id: requiredText(values, 'request-id'), document_id: requiredText(values, 'document-id'), project_id: requiredText(values, 'project-id') });
        printDocument(stdout, await client.changeDocumentAssociation(request, {
          ...(values['expected-membership-id'] === undefined ? {} : { expected_membership_id: requiredText(values, 'expected-membership-id') }),
          ...(values['expected-authority'] === undefined ? {} : { expected_authority: requiredText(values, 'expected-authority') }),
        }));
        break;
      }
      case 'documents-pending':
        printDocument(stdout, client.pendingDocuments());
        break;
      case 'documents-retry':
      case 'documents-abandon': {
        const expected = {
          ...(values['expected-membership-id'] === undefined ? {} : { expected_membership_id: requiredText(values, 'expected-membership-id') }),
          ...(values['expected-authority'] === undefined ? {} : { expected_authority: requiredText(values, 'expected-authority') }),
        };
        const requestId = requiredText(values, 'request-id');
        printDocument(stdout, action === 'documents-retry' ? await client.retryDocument(requestId, expected) : client.abandonDocument(requestId, expected));
        break;
      }
      case 'documents-status':
        printDocument(stdout, await client.documentStatus(requiredText(values, 'request-id')));
        break;
      case 'documents-read':
        printDocument(stdout, await client.readDocument(requiredText(values, 'document-id'), values.cursor === undefined ? undefined : requiredText(values, 'cursor'), values['project-id'] === undefined ? undefined : requiredText(values, 'project-id')));
        break;
      case 'documents-search':
        printDocument(stdout, await client.searchDocuments(validatePersonDocumentSearchV1({ schema_version: 1, kind: 'echo-person-document-search-v1',
          project_id: values['project-id'] === undefined ? null : validateProjectIdV1(values['project-id']), query: values.query === undefined ? '' : requiredText(values, 'query'),
          limit: optionalRecordLimit(values, 20) ?? 10, cursor: values.cursor === undefined ? null : requiredText(values, 'cursor') })));
        break;
      case 'documents-download':
        printDocument(stdout, await client.downloadDocument(requiredText(values, 'document-id'), requiredText(values, 'out'), values['project-id'] === undefined ? undefined : requiredText(values, 'project-id')));
        break;
      case 'projects-list':
        print(stdout, await client.projects(contextPaging(values)));
        break;
      case 'projects-create':
        print(stdout, await client.createProject(validateProjectCreateV1({ schema_version: 1, kind: 'echo-project-create-v1',
          request_id: requiredText(values, 'request-id'), name: requiredText(values, 'name') })));
        break;
      case 'projects-read':
        print(stdout, await client.readProject(requiredText(values, 'project-id')));
        break;
      case 'projects-members':
        print(stdout, await client.projectMembers({ project_id: validateProjectIdV1(values['project-id']), ...contextPaging(values) }));
        break;
      case 'projects-directory':
        print(stdout, await client.projectDirectory({ project_id: validateProjectIdV1(values['project-id']), ...(values.query === undefined ? {} : { query: requiredText(values, 'query') }), ...contextPaging(values) }));
        break;
      case 'projects-member-add':
        print(stdout, await client.addProjectMember(validateProjectMemberAddV1({ schema_version: 1, kind: 'echo-project-member-add-v1',
          request_id: requiredText(values, 'request-id'), project_id: requiredText(values, 'project-id'), membership_id: requiredText(values, 'membership-id') })));
        break;
      case 'projects-member-set':
        print(stdout, await client.setProjectMember(validateProjectMemberSetV1({ schema_version: 1, kind: 'echo-project-member-set-v1',
          request_id: requiredText(values, 'request-id'), project_id: requiredText(values, 'project-id'),
          membership_id: requiredText(values, 'membership-id'), role: requiredText(values, 'role') })));
        break;
      case 'projects-member-remove':
        print(stdout, await client.removeProjectMember(validateProjectMemberRemoveV1({ schema_version: 1, kind: 'echo-project-member-remove-v1',
          request_id: requiredText(values, 'request-id'), project_id: requiredText(values, 'project-id'), membership_id: requiredText(values, 'membership-id') })));
        break;
      case 'projects-associate':
        print(stdout, await client.associateProjectContext(validateProjectContextAssociateV1({ schema_version: 1, kind: 'echo-project-context-associate-v1',
          request_id: requiredText(values, 'request-id'), project_id: requiredText(values, 'project-id'), context_id: requiredText(values, 'context-id') })));
        break;
      case 'projects-dissociate':
        print(stdout, await client.dissociateProjectContext(validateProjectContextDissociateV1({ schema_version: 1, kind: 'echo-project-context-dissociate-v1',
          request_id: requiredText(values, 'request-id'), project_id: requiredText(values, 'project-id'), context_id: requiredText(values, 'context-id') })));
        break;
      case 'projects-feed':
        print(stdout, await client.projectFeed({ project_id: validateProjectIdV1(values['project-id']), ...contextPaging(values) }));
        break;
      case 'projects-search':
        print(stdout, await client.searchProjectContext({ project_id: validateProjectIdV1(values['project-id']), query: requiredText(values, 'query'), ...contextPaging(values) }));
        break;
      case 'projects-read-context':
        print(stdout, await client.readProjectContext({ project_id: validateProjectIdV1(values['project-id']), context_id: requiredText(values, 'context-id') }));
        break;
      case 'updates-submit': {
        const requestId = validatePersonUpdateRequestId(requiredText(values, 'request-id'));
        const visibility = values.visibility ?? 'only-me';
        if (!['only-me', 'team', 'project'].includes(String(visibility))) throw new Error('Invalid visibility');
        const audience = validatePersonUploadAudienceV2({ kind: visibility === 'only-me' ? 'only_me' : visibility,
          ...(values['audience-project-id'] === undefined ? {} : { project_id: values['audience-project-id'] }) });
        const project_id = values['project-id'] === undefined ? null : validateProjectIdV1(values['project-id']);
        const request = validatePersonUpdateSubmitV2({ schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: requestId,
          title: requiredText(values, 'title'), text: readUpdateFile(requiredText(values, 'file')), project_id, audience });
        print(stdout, await client.submitUpdateV2(request));
        break;
      }
      case 'updates-search':
        print(stdout, await client.searchUploadsV2({ query: requiredText(values, 'query'), ...contextPaging(values) }));
        break;
      case 'updates-read':
        print(stdout, await client.readUploadV2(requiredText(values, 'context-id')));
        break;
      case 'updates-status':
        print(stdout, await client.updateStatusV2(requiredText(values, 'request-id')));
        break;
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
            client_build: { source_sha: identity.source_sha, source_kind: identity.source_kind },
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
            client_build: { source_sha: identity.source_sha, source_kind: identity.source_kind },
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
        validatePersonQueryText(values.question);
        print(stdout, {
          ok: true,
          result: await client.ask(
            requiredText(values, "question"),
            values.project === undefined ? undefined : validateProjectIdV1(requiredText(values, "project")),
          ),
        });
        break;
      case "ask-source": {
        const project_id = values.project === undefined
          ? undefined
          : validateProjectIdV1(requiredText(values, "project"));
        print(stdout, {
          ok: true,
          result: await client.askSourceEvidence(validatePersonSourceEvidenceReadRequestV1({
            schema_version: 1,
            scope: project_id === undefined ? { kind: "global" } : { kind: "project", project_id },
            citation: {
              kind: "source_revision",
              source_id: requiredText(values, "source-id"),
              revision_id: requiredText(values, "revision-id"),
              source_sha256: requiredText(values, "source-sha256"),
              representation_sha256: requiredText(values, "representation-sha256"),
              anchor_sha256: requiredText(values, "anchor-sha256"),
              ...(values["document-id"] === undefined ? {} : { document_id: requiredText(values, "document-id") }),
            },
          })),
        });
        break;
      }
      case "records": {
        const query = values.query;
        const recordSha256 = values["record-sha256"];
        if (query !== undefined) validatePersonQueryText(query);
        print(stdout, {
          ok: true,
          result: await client.records(
            optionalRecordLimit(values, query === undefined ? 100 : 10),
            typeof query === "string" ? query : undefined,
            typeof recordSha256 === "string" ? recordSha256 as `sha256:${string}` : undefined,
          ),
        });
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
    if (isContextAction(action)) {
      print(stderr, contextCliFailure(action, error, values));
      return 1;
    }
    print(stderr, {
      ok: false,
      action,
      error: action === "ask" && error instanceof PersonAuthorityClientError &&
        error.code === "invalid_output" && error.status === 502
        ? "Answer generation returned an invalid response."
        : error instanceof PersonAuthorityClientError || error instanceof PersonQueryInputError ||
        error instanceof PersonClientSessionUnavailableError || (action !== "ask" && action !== "records")
        ? (error as Error).message : "Person request could not be completed",
      ...(error instanceof PersonAuthorityClientError ? { code: error.code, status: error.status } : {}),
      ...(error instanceof PersonQueryInputError ? { code: error.code } : {}),
      ...(error instanceof EmployeeMutationError
        ? { code: error.code, mutation_outcome: error.mutation_outcome }
        : {}),
    });
    return 1;
  }
}
