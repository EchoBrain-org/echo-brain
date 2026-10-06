import { validatePersonDocumentAssociateV1, validatePersonDocumentDissociateV1 } from '@echo-brain/organization-api';
import { DocumentFileError } from './document-file.js';
import { validatePersonDocumentSearchV2, parseCanonicalAssociationProjectIdsJsonV1, validatePersonUploadAudienceV3 } from '@echo-brain/organization-api';
import { readUpdateFile } from './update-file.js';
import { validatePersonUpdateSubmitV3, validatePersonUpdateRequestId, validateProjectIdV1, validateProjectCreateV1, validateProjectMemberAddV1, validateProjectMemberSetV1, validateProjectMemberRemoveV1, validateProjectContextAssociateV1, validateProjectContextDissociateV1, validateProjectRenameV1, validateProjectArchiveV1, validateProjectLeaveV1 } from '@echo-brain/organization-api';
import { PersonQueryInputError, validatePersonQueryText } from "@echo-brain/organization-api";
import { validatePersonSourceEvidenceReadRequestV1, validatePersonMeetingTranscriptReadRequestV1 } from '@echo-brain/organization-api';
import { validatePersonListRequestV1, validatePersonOpenRequestV1, type PersonListRequestV1, type PersonOpenRequestV1 } from '@echo-brain/organization-api';
import { PersonToolOutcomeErrorV1, type PersonToolProviderV1, type PersonToolVerbNameV1, type PersonToolVerbV1 } from '@echo-brain/organization-api';
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
  readonly tool_providers?: readonly PersonToolProviderV1[];
  readonly stdout?: Output;
  readonly stderr?: Output;
  readonly home_directory?: string;
  readonly fetch?: typeof fetch;
  readonly allow_insecure_loopback?: boolean;
  readonly now?: () => string;
  readonly random_bytes?: (size: number) => Uint8Array;
  readonly random_uuid?: () => string;
  /** Replaces standard input; a secret read passes its terminal prompt. */
  readonly read_input?: (secret_prompt?: string) => string | Promise<string>;
  readonly open_authorization_url?: (url: string) => boolean | Promise<boolean>;
  /** Waits between a tool step's status reads. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Desktop cancellation aborts the underlying fetch rather than hiding a late reply. */
  readonly abort_signal?: AbortSignal;
}

const OPTIONS = {
  tickets: { type: "boolean" },
  live: { type: "boolean" },
  "document-id": { type: "string" },
  audience: { type: "string" },
  "expected-membership-id": { type: "string" },
  "expected-authority": { type: "string" },
  "request-id": { type: "string" },
  "context-id": { type: "string" },
  "project-id": { type: "string" },
  project: { type: "string" },
  "source-id": { type: "string" },
  "revision-id": { type: "string" },
  "source-sha256": { type: "string" },
  "approval-id": { type: "string" },
  offset: { type: "string" },
  "representation-sha256": { type: "string" },
  "anchor-sha256": { type: "string" },
  "audience-project-id": { type: "string" },
  "association-project-ids-json": { type: "string" },
  "audience-project-ids-json": { type: "string" },
  "membership-id": { type: "string" },
  role: { type: "string" },
  status: { type: "string" },
  cursor: { type: "string" },
  title: { type: "string" },
  file: { type: "string" },
  "authority-url": { type: "string" },
  invitation: { type: "string" },
  question: { type: "string" },
  query: { type: "string" },
  name: { type: "string" },
  email: { type: "string" },
  out: { type: "string" },
  limit: { type: "string" },
  "open-browser": { type: "boolean" },
  "record-sha256": { type: "string" },
  kind: { type: "string" },
  item: { type: "string" },
  neighbours: { type: "string" },
  mine: { type: "boolean" },
  ref: { type: "string" },
} as const;

type Option = string;

const RULES: Readonly<
  Record<string, { accepts?: readonly Option[]; requires?: readonly Option[] }>
> = {
  "documents-upload-v2": { accepts: ["file", "audience", "audience-project-id", "association-project-ids-json", "audience-project-ids-json", "title", "request-id", "expected-membership-id", "expected-authority"], requires: ["file", "title", "request-id"] },
  "documents-associate": { accepts: ["request-id", "document-id", "project-id", "expected-membership-id", "expected-authority"], requires: ["request-id", "document-id", "project-id"] },
  "documents-dissociate": { accepts: ["request-id", "document-id", "project-id", "expected-membership-id", "expected-authority"], requires: ["request-id", "document-id", "project-id"] },
  "documents-pending": { accepts: [], requires: [] },
  "documents-retry": { accepts: ["request-id", "expected-membership-id", "expected-authority"], requires: ["request-id"] },
  "documents-abandon": { accepts: ["request-id", "expected-membership-id", "expected-authority"], requires: ["request-id"] },
  "documents-status-v2": { accepts: ["request-id"], requires: ["request-id"] },
  "documents-search-v2": { accepts: ["project-id", "query", "limit", "cursor"] },
  "documents-download-v2": { accepts: ["document-id", "out", "project-id"], requires: ["document-id", "out"] },
  "projects-list-v2": { accepts: ["limit", "cursor", "status"] },
  "projects-create": { accepts: ["request-id", "name"], requires: ["request-id", "name"] },
  "projects-read-v2": { accepts: ["project-id"], requires: ["project-id"] },
  "projects-rename": { accepts: ["request-id", "project-id", "name"], requires: ["request-id", "project-id", "name"] },
  "projects-archive": { accepts: ["request-id", "project-id"], requires: ["request-id", "project-id"] },
  "projects-unarchive": { accepts: ["request-id", "project-id"], requires: ["request-id", "project-id"] },
  "projects-leave": { accepts: ["request-id", "project-id"], requires: ["request-id", "project-id"] },
  "projects-members": { accepts: ["project-id", "limit", "cursor"], requires: ["project-id"] },
  "projects-directory": { accepts: ["project-id", "query", "limit", "cursor"], requires: ["project-id"] },
  directory: { accepts: ["query", "limit", "cursor"] },
  "projects-member-add": { accepts: ["request-id", "project-id", "membership-id"], requires: ["request-id", "project-id", "membership-id"] },
  "projects-member-set": { accepts: ["request-id", "project-id", "membership-id", "role"], requires: ["request-id", "project-id", "membership-id", "role"] },
  "projects-member-remove": { accepts: ["request-id", "project-id", "membership-id"], requires: ["request-id", "project-id", "membership-id"] },
  "projects-associate": { accepts: ["request-id", "project-id", "context-id"], requires: ["request-id", "project-id", "context-id"] },
  "projects-dissociate": { accepts: ["request-id", "project-id", "context-id"], requires: ["request-id", "project-id", "context-id"] },
  "projects-search-v2": { accepts: ["project-id", "query", "limit", "cursor"], requires: ["project-id", "query"] },
  "updates-submit-v3": { accepts: ["request-id", "title", "file", "audience", "audience-project-id", "association-project-ids-json", "audience-project-ids-json"], requires: ["request-id", "title", "file"] },
  "updates-status-v3": { accepts: ["request-id"], requires: ["request-id"] },
  "updates-search-v3": { accepts: ["query", "limit"], requires: ["query"] },
  "updates-search": { accepts: ["query", "limit"], requires: ["query"] },
  login: {
    accepts: ["invitation", "authority-url", "open-browser"],
  },
  status: {},
  "session-refresh": {},
  logout: {},
  ask: {
    accepts: ["question", "project", "mine", "tickets", "live"],
    requires: ["question"],
  },
  list: { accepts: ["project", "mine", "cursor"] },
  open: { accepts: ["ref", "cursor"], requires: ["ref"] },
  "evidence-search": { accepts: ["query", "project", "kind", "limit"], requires: [] },
  "evidence-open": { accepts: ["item", "project", "neighbours"], requires: ["item"] },
  "ask-source": {
    accepts: ["source-id", "revision-id", "source-sha256", "representation-sha256", "anchor-sha256", "document-id", "project"],
    requires: ["source-id", "revision-id", "source-sha256", "representation-sha256", "anchor-sha256"],
  },
  transcript: {
    accepts: ["approval-id", "source-id", "revision-id", "source-sha256", "project", "offset"],
    requires: ["approval-id", "source-id", "revision-id", "source-sha256"],
  },
  records: { accepts: ["limit", "query", "record-sha256"] },
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

Start here:
  status                                      Who you are on this machine (no network).
  list                                        The newest notes, documents, imported meetings and approved meetings you can read, 25 at a time.
  list --project <project-id> | --mine        Only one of your projects, or only what you added.
  open --ref <ref>                            Read one item from list or from an ask citation.
  ask --question <text> [--project <project-id> | --mine]   Answer with citations.
list shows only what you can read now; next_cursor means more.

Commands:
  login       Sign in with an invitation or existing Authority identity.
  status      Show client build identity and sign-in state.
  logout      Remove the local session.
  list        List the newest notes, documents, imported meetings and approved meetings you can read.
  open        Read one item by its ref from list or an ask citation.
  ask         Ask a question over context you may read.
  evidence    Search or open released Ask evidence.
  transcript  Read an explicitly approved meeting transcript page.
  records     List records or search the current generation.
  directory   Find people in your organization by name.
  projects    Create projects, manage members, and browse permitted context.
  updates     Save and search original notes with your chosen visibility.
  documents   Upload, search, and download exact document originals.
  employee    List, invite, reissue, or revoke an employee.
  tools       List tools, or set up, connect and disconnect one.

Run \`echo-brain person <command> --help\` for command options.
`,
  login: `usage: echo-brain person login (--invitation <path> | --authority-url <url>) [--open-browser]

Provide exactly one identity option. --open-browser opens the handoff automatically; otherwise the URL is printed for manual opening.
`,
  status: `usage: echo-brain person status

Shows installed_version, client_build source_sha/source_kind, sign-in state, membership type, and Authority origin.
Client provenance does not identify the Authority build serving requests. Status is local and makes no network request.
`,
  tools: `usage: echo-brain person tools [<setup|connect|disconnect|status|cancel|project|meetings> --tool <tool> [options]]

Without a verb, lists your organization's tools and your link to each; owners also see each tool's organization setup.
setup (owners only) and connect open the tool's page in your browser and wait. A token is read only from standard input.
Run \`echo-brain person tools <verb> --help\` for each tool's options.
`,
  logout: `usage: echo-brain person logout

Removes the local session. A revoked session is also removed locally.
`,
  ask: `usage: echo-brain person ask --question <text> [--project <project-id> | --mine] [--tickets | --live]

Ask one question using at most 240 Unicode code points, 1–32 distinct normalized terms and at most 64 UTF-8 bytes per term. Use NFC text on one line without edge whitespace. Without a scope flag, ECHO retrieves across context you may read. With --project, only context associated with that project. With --mine, only what you added: your notes, your uploads and meetings you approved; Slack and shared transcripts are not read. Answers include typed citations; each opens with person open --ref when it carries a ref.

--live selects the newest Ask route, using every configured request-local live source, including Jira tickets and Confluence pages. Global scope reads what your connected accounts can access; each project uses its saved provider mappings. Mine excludes live tools. --tickets retains the prior ticket-capable response for compatibility.
`,
  list: `usage: echo-brain person list [--project <project-id> | --mine] [--cursor <next_cursor>]

Lists the newest things you can read now, 25 per page: notes, documents, imported meetings and approved meetings. Each row has a ref for person open, a title, when it was added (added_at), who can see it (only_me, team or project) and the projects you belong to that it is filed under. Rows never carry text.
Without a scope flag the list covers the notes, documents, imported meetings and approved meetings ask can read (not Slack messages or shared transcripts); the first page also shows who you are, your connected tools and your projects.
--project lists one project you belong to. --mine lists only what you added: notes you saved, documents you uploaded and meetings you imported or approved (approved means you were the approver, not an attendee or action owner).
Pass next_cursor as --cursor with the same scope for the next page; null means the end.
notice "meetings_unavailable" means meetings are still being indexed and come on a later page. A first page with no items and that notice is not the end: follow its next_cursor later. A later page that could only wait for meetings fails with unavailable (503): retry the same --cursor later.
`,
  open: `usage: echo-brain person open --ref <ref> [--cursor <next_cursor>]

Reads one item under your current access: a note's full text, a document's extracted text, or a meeting's decisions, actions and rationales. Documents and meetings are paged. A meeting's first page shows transcript_ref when its approver shared the transcript and you may read it; open that ref to page the transcript. Refs come from person list and from ask citations. Anything you cannot read returns not_found. Pass next_cursor as --cursor with the same --ref for the next page.
`,
  evidence: `usage: echo-brain person evidence <search|open> [options]

Search or open released evidence under a fresh signed-in request. Use the citation JSON returned by search with open.
`,
  "evidence-search": `usage: echo-brain person evidence search [--query <text>] [--project <project-id>] [--kind <imported_meeting|decision|action|rationale|note|document_passage>] [--limit <1-50>]

Without --query, lists readable evidence titles and kinds without body text.
`,
  "evidence-open": `usage: echo-brain person evidence open --item <citation-json> [--project <project-id>] [--neighbours <0-2>]

Opens one cited evidence item under a fresh signed-in request. --item is the citation object from evidence search JSON.
`,
  "ask-source": `usage: echo-brain person ask-source --source-id <source-id> --revision-id <revision-id> --source-sha256 <sha256:64hex> --representation-sha256 <sha256:64hex> --anchor-sha256 <sha256:64hex> [--document-id <document-id>] [--project <project-id>]

Reads one bounded immutable source-evidence packet cited by Ask. Use the exact citation fields. The server rechecks your current access and project association before returning it; this never downloads an original file.
`,
  transcript: `usage: echo-brain person transcript --approval-id <id> --source-id <source-id> --revision-id <id> --source-sha256 <sha256:64hex> [--project <project-id>] [--offset <code-point>]

Reads one bounded page from an explicitly approved meeting transcript. The meeting is not searched by Ask and source custody alone never grants this read. Use the approval's exact source coordinates; follow next_offset with --offset when present.
`,
  directory: `usage: echo-brain person directory [--query <text>] [--limit <1-10>] [--cursor <opaque-base64url>]

Lists active people in your organization by name, or narrows the list with a name search. Any signed-in member may use it; no project is needed. Shows names and membership IDs only. Pass next_cursor as --cursor with the same --query and --limit for the next page.
`,
  records: `usage: echo-brain person records [--limit <1-100>] [--query <text>] [--record-sha256 <sha256:64hex>]

Search --limit is 1–10; list --limit is 1–100. Queries use the same text bounds as Ask. Lists recent records, searches the current index, or retrieves one exact readable cited record. --limit can refine --query; --record-sha256 cannot be combined with either.
`,
  documents: `usage: echo-brain person documents <upload-v2|status-v2|pending|retry|abandon|search-v2|download-v2|associate|dissociate> [options]

Supports UTF-8 text/Markdown, PDF and Word .docx originals up to 25 MiB. Saving and text extraction are separate states. Project association does not change audience. Read a document's extracted text with person open --ref document:<document-id>. Extracted originals can contribute typed evidence to authorized Ask results.
`,
  "documents-upload-v2": `usage: echo-brain person documents upload-v2 --file <path> --title <title> --request-id <uuid> [--association-project-ids-json <canonical-project-id-array>] [--audience <only-me|team|project|projects>] [--audience-project-id <id>] [--audience-project-ids-json <canonical-project-id-array>]

Saves one exact original record with an immutable initial association set and independently selected audience. Defaults to Only me and no initial associations. Associations do not change who can read it. Project requires --audience-project-id, while projects requires --audience-project-ids-json. Project ID arrays must be canonical JSON: sorted, unique project IDs, at most 20. If the outcome is unknown, retain and retry the same request through documents retry; later association changes do not alter the saved receipt.
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

Resends the exact retained original and metadata, even after restart or source-file deletion. Check status-v2 first. Optional paired --expected-membership-id and --expected-authority bind the operation to its captured account.
`,
  "documents-abandon": `usage: echo-brain person documents abandon --request-id <uuid>

Explicitly removes only this account's local retry snapshot. This does not cancel or delete an Authority upload. Keep the request ID and check status-v2 or search-v2 before starting a new upload to avoid a duplicate. Optional paired --expected-membership-id and --expected-authority bind local cleanup to its captured account.
`,
  "documents-status-v2": `usage: echo-brain person documents status-v2 --request-id <uuid>

Reads V2 metadata and its immutable initial association set. Current associations are available from search-v2 results.
`,
  "documents-search-v2": `usage: echo-brain person documents search-v2 [--project-id <id>] [--query <text>] [--limit <1-20>] [--cursor <opaque>]

Lists or searches the documents you may read, whichever upload version saved them. Results preserve multi-project audience and current association coordinates.
`,
  "documents-download-v2": `usage: echo-brain person documents download-v2 --document-id <id> --out <new-file> [--project-id <id>]

Streams a document's exact saved original, whichever upload version saved it, to a new file and verifies its length and SHA-256 before publishing it atomically.
`,
  projects: `usage: echo-brain person projects <list-v2|create|read-v2|rename|archive|unarchive|leave|members|directory|member-add|member-set|member-remove|associate|dissociate|search-v2> [options]

Projects organize original context. Association does not change its audience. Browse a project with person list --project <project-id> and read each item with person open --ref. Use person ask --project for a strict project-scoped answer.
`,
  "projects-list-v2": `usage: echo-brain person projects list-v2 [--status <active|archived>] [--limit <1-10>] [--cursor <opaque-base64url>]

Lists active projects by default, or archived projects when selected. V2 includes each project's lifecycle status.
`,
  "projects-create": `usage: echo-brain person projects create --request-id <uuid> --name <name>

Creates a project with you as its initial lead. Retain the request ID for exact replay after an unknown outcome.
`,
  "projects-read-v2": `usage: echo-brain person projects read-v2 --project-id <project-id>

Reads one accessible project with its active or archived lifecycle status.
`,
  "projects-rename": `usage: echo-brain person projects rename --request-id <uuid> --project-id <project-id> --name <name>

Leads rename an active project. Retain the exact request ID for replay.
`,
  "projects-archive": `usage: echo-brain person projects archive --request-id <uuid> --project-id <project-id>

Leads archive a project. Archived projects remain readable and can be unarchived.
`,
  "projects-unarchive": `usage: echo-brain person projects unarchive --request-id <uuid> --project-id <project-id>

Leads return an archived project to the active list.
`,
  "projects-leave": `usage: echo-brain person projects leave --request-id <uuid> --project-id <project-id>

Leaves a project. The last lead must appoint another lead before leaving.
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

Remove the association without changing the original or its audience. Refresh person list --project; old upload receipts retain their initial association.
`,
  "projects-search-v2": `usage: echo-brain person projects search-v2 --project-id <project-id> --query <text> [--limit <1-10>] [--cursor <opaque-base64url>]

Search project originals including V3 multi-project uploads. An empty query is invalid; use person list --project to browse.
`,
  updates: `usage: echo-brain person updates <submit-v3|status-v3|search|search-v3> [options]

Uploads preserve the original text. Only me is the default; Team explicitly shares it with current organization members. No Slack approval or decision extraction is required. Read a note with person open --ref note:<context-id>.
`,
  "updates-submit-v3": `usage: echo-brain person updates submit-v3 --request-id <uuid> --title <title> --file <utf8-text-file> [--association-project-ids-json <canonical-project-id-array>] [--audience <only-me|team|project|projects>] [--audience-project-id <project-id>] [--audience-project-ids-json <canonical-project-id-array>]

Saves one UTF-8 text original (at most 8 KiB) with independent initial association and audience sets. Only me and no association are the defaults. Project requires --audience-project-id; projects requires --audience-project-ids-json. Both project ID arrays are canonical JSON: sorted, unique project IDs, at most 20. An association never widens the audience. Keep the same request ID and immutable fields for exact V3 status/replay after an unknown outcome.
`,
  "updates-status-v3": `usage: echo-brain person updates status-v3 --request-id <uuid>

Shows the saved V3 receipt, selected audience union, immutable initial association set, and optional search-metadata progress. Later association changes do not alter this receipt.
`,
  "updates-search": `usage: echo-brain person updates search --query <text> [--limit <1-10>]

Find original uploads you may read. Optional search hints help matching; excerpts come from the original text.
`,
  "updates-search-v3": `usage: echo-brain person updates search-v3 --query <text> [--limit <1-10>]

Find V3 original uploads you may read. Results preserve the exact selected audience union and current access checks.
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

const TOOL_VERBS: readonly PersonToolVerbNameV1[] = ['setup', 'connect', 'disconnect', 'status', 'cancel', 'project', 'meetings'];

function toolVerb(value: string | undefined): PersonToolVerbNameV1 | undefined {
  return TOOL_VERBS.find((verb) => verb === value);
}

/** Built from each registered tool, so help never names an option the parser refuses. */
function toolVerbHelp(value: string | undefined, providers: readonly PersonToolProviderV1[]): string | undefined {
  const verb = toolVerb(value);
  if (verb === undefined) return undefined;
  const tools = providers.flatMap((provider) => {
    const definition = provider.verbs[verb];
    if (definition === undefined) return [];
    const options = Object.entries(definition.options).map(([name, { type }]) => {
      const text = type === 'boolean' ? `--${name}` : `--${name} <value>`;
      return definition.requires?.includes(name) === true ? ` ${text}` : ` [${text}]`;
    }).join('');
    return [`  --tool ${provider.tool_id}${options}\n      ${definition.description}\n`];
  });
  return `usage: echo-brain person tools ${verb} --tool <tool> [options]\n\n${tools.join('')}`;
}

/** Tool ids are unique; a verb's options never shadow a core option or `--tool`, nor change type between tools. */
function registerToolProviders(list: readonly PersonToolProviderV1[]) {
  const providers = new Map<string, PersonToolProviderV1>();
  const options: Record<string, { readonly type: 'string' | 'boolean' }> = {};
  for (const provider of list) {
    let valid = !providers.has(provider.tool_id) && /^[a-z][a-z0-9-]*$/.test(provider.tool_id);
    for (const [verb, definition] of Object.entries(provider.verbs)) {
      valid &&= toolVerb(verb) !== undefined && definition !== undefined &&
        (definition.requires ?? []).every((name) => Object.hasOwn(definition.options, name));
      for (const [name, option] of Object.entries(definition?.options ?? {})) {
        valid &&= name !== 'tool' && !Object.hasOwn(OPTIONS, name) && (options[name] ?? option).type === option.type;
        options[name] = option;
      }
    }
    if (!valid) throw new Error('Person tool provider registration is invalid or duplicated');
    providers.set(provider.tool_id, provider);
  }
  return { providers, options };
}

/** Returns supported human CLI help without constructing a client or session. */
function personClientCliHelp(argv: readonly string[], providers: readonly PersonToolProviderV1[]): string | undefined {
  if (argv.length === 3 && (argv[0] === 'updates' || argv[0] === 'projects' || argv[0] === 'documents' || argv[0] === 'evidence') && argv[2] === '--help') return HELP[`${argv[0]}-${argv[1]}`];
  if (argv.length === 3 && argv[0] === 'tools' && argv[2] === '--help') return toolVerbHelp(argv[1], providers);
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

function printDocument(output: Output, result: unknown): void {
  const text = `${JSON.stringify({ ok: true, result })}\n`;
  if (Buffer.byteLength(text) > 32 * 1024) throw new PersonAuthorityClientError('invalid_response', null, 'Document response exceeded its CLI output bound.');
  output.write(text);
}

function canonicalProjectIdArray(value: string | boolean | undefined, label: string): ReturnType<typeof parseCanonicalAssociationProjectIdsJsonV1> {
  if (value === undefined) return [];
  try { return parseCanonicalAssociationProjectIdsJsonV1(value); }
  catch { throw new Error(`${label} must be canonical JSON`); }
}

function uploadAudienceV3(values: Record<Option, string | boolean | undefined>) {
  const kind = values.audience === undefined ? 'only_me' : requiredText(values, 'audience').replace('only-me', 'only_me');
  if (kind === 'projects') {
    if (values['audience-project-id'] !== undefined) throw new Error('--audience-project-id is not valid for projects audience');
    return validatePersonUploadAudienceV3({ kind, project_ids: canonicalProjectIdArray(values['audience-project-ids-json'], '--audience-project-ids-json') });
  }
  if (kind === 'project') {
    if (values['audience-project-ids-json'] !== undefined) throw new Error('--audience-project-ids-json is not valid for project audience');
    return validatePersonUploadAudienceV3({ kind, project_id: requiredText(values, 'audience-project-id') });
  }
  if (kind !== 'only_me' && kind !== 'team') throw new Error('Invalid upload audience');
  if (values['audience-project-id'] !== undefined || values['audience-project-ids-json'] !== undefined) throw new Error('Audience project options require project audience');
  return validatePersonUploadAudienceV3({ kind });
}

function isContextAction(action: string): boolean {
  return action === 'directory' || action.startsWith('projects-') || action.startsWith('updates-') || action.startsWith('documents-');
}

function contextCliFailure(action: string, error: unknown, values: Record<Option, string | boolean | undefined>) {
  const mutation = ['projects-create', 'projects-rename', 'projects-archive', 'projects-unarchive', 'projects-leave', 'projects-member-add', 'projects-member-set', 'projects-member-remove', 'projects-associate', 'projects-dissociate', 'updates-submit-v3', 'documents-upload-v2', 'documents-retry', 'documents-associate', 'documents-dissociate'].includes(action);
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

/**
 * Reads one secret line that is never echoed. A terminal gets one prompt line
 * on standard error, then raw-mode input read with no output stream at all;
 * closing the reader restores the terminal on Enter, Ctrl-C and every error.
 * Piped input gets no prompt and no echo.
 */
export async function readSecretLine(
  prompt: string,
  input: NodeJS.ReadableStream & { readonly isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
  const terminal = input.isTTY === true;
  if (terminal) output.write(`${prompt}\n`);
  return await readBoundedLine(input, undefined, terminal);
}

/** Shown as typed, for an acknowledgement such as a DM code's Enter. */
function readBoundedStdinLine(): Promise<string> {
  return readBoundedLine(process.stdin, process.stderr);
}

async function readBoundedLine(input: NodeJS.ReadableStream, output: NodeJS.WritableStream | undefined, terminal?: boolean): Promise<string> {
  const prompt = createInterface({ input, output, terminal });
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
  const toolProviders = dependencies.tool_providers ?? [];
  const { providers, options: toolOptions } = registerToolProviders(toolProviders);
  const help = personClientCliHelp(argv, toolProviders);
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
  const evidenceAction = argv[0] === 'evidence' ? `evidence-${argv[1] ?? ''}` : undefined;
  const updateAction = argv[0] === 'updates' && ['search', 'submit-v3', 'status-v3', 'search-v3'].includes(argv[1] ?? '') ? `updates-${argv[1]}` : undefined;
  const projectAction = argv[0] === 'projects' ? `projects-${argv[1] ?? ''}` : undefined;
  // `tools` alone lists tools; `tools <verb>` is a tool verb, refused unless it is one of the five.
  const toolAction = argv[0] === 'tools' && argv[1] !== undefined && !argv[1].startsWith('-') ? `tools-${argv[1]}` : undefined;
  const verbName = toolAction === undefined ? undefined : toolVerb(argv[1]);
  const action = documentAction ?? evidenceAction ?? projectAction ?? updateAction ?? employeeAction ?? toolAction ?? (argv[0] ?? "");
  const rule = RULES[action] ?? (verbName === undefined ? undefined : { accepts: ['tool', ...Object.keys(toolOptions)], requires: ['tool'] });
  if (rule === undefined) {
    print(stderr, { ok: false, error: usage() });
    return 2;
  }

  let values: Record<Option, string | boolean | undefined> = {};
  let listRequest: PersonListRequestV1 | undefined;
  let openRequest: PersonOpenRequestV1 | undefined;
  let toolVerbDefinition: PersonToolVerbV1 | undefined;
  try {
    const args = [...argv.slice(employeeAction === undefined && updateAction === undefined && projectAction === undefined && documentAction === undefined && evidenceAction === undefined && toolAction === undefined ? 1 : 2)];
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
      options: { ...OPTIONS, ...(verbName === undefined ? {} : { tool: { type: 'string' as const }, ...toolOptions }) },
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
    if (verbName !== undefined) {
      const tool = String(values.tool);
      toolVerbDefinition = providers.get(tool)?.verbs[verbName];
      // An unknown tool is a usage error that never repeats the caller's value.
      if (toolVerbDefinition === undefined) throw new Error(usage());
      const command = `echo-brain person tools ${verbName} --tool ${tool}`;
      for (const [name, value] of Object.entries(values)) {
        if (value !== undefined && value !== false && name !== 'tool' && !Object.hasOwn(toolVerbDefinition.options, name)) {
          throw new Error(`--${name} is not valid with \`${command}\``);
        }
      }
      for (const required of toolVerbDefinition.requires ?? []) {
        if (values[required] === undefined) throw new Error(`\`${command}\` requires --${required}`);
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
    if ((action === "ask" || action === "list") && values.project !== undefined && values.mine === true) {
      throw new Error(`--project and --mine cannot be combined with \`echo-brain person ${action}\``);
    }
    // List and open requests are complete and validated before any network or session use.
    if (action === "list") {
      listRequest = validatePersonListRequestV1({
        schema_version: 1,
        ...(values.project === undefined ? {} : { project_id: values.project }),
        ...(values.mine === true ? { mine: true } : {}),
        ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
      });
    }
    if (action === "open") {
      openRequest = validatePersonOpenRequestV1({
        schema_version: 1,
        ref: values.ref,
        ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
      });
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
  const readInteractiveLine = dependencies.read_input ?? readBoundedStdinLine;

  try {
    if (toolVerbDefinition !== undefined) {
      await toolVerbDefinition.run({
        host: { withToolSession: operation => client.withToolSession(operation, dependencies.abort_signal) },
        values, print: (value) => print(stdout, value),
        read_interactive_line: async () => await readInteractiveLine(),
        read_secret_line: async (prompt) => await (dependencies.read_input?.(prompt) ?? readSecretLine(prompt)),
        open_browser: dependencies.open_authorization_url ?? openAuthorizationUrl,
        sleep: async ms => {
          dependencies.abort_signal?.throwIfAborted();
          await (dependencies.sleep ?? ((delay: number) => new Promise<void>(resolve => setTimeout(resolve, delay))))(ms);
          dependencies.abort_signal?.throwIfAborted();
        } });
      return 0;
    }
    switch (action) {
      case 'documents-upload-v2': {
        const requestId = validatePersonUpdateRequestId(requiredText(values, 'request-id'));
        printDocument(stdout, await client.uploadDocumentV2({ file: requiredText(values, 'file'), request_id: requestId,
          title: requiredText(values, 'title'), audience: uploadAudienceV3(values),
          association_project_ids: canonicalProjectIdArray(values['association-project-ids-json'], '--association-project-ids-json'),
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
      case 'documents-status-v2':
        printDocument(stdout, await client.documentStatusV2(requiredText(values, 'request-id')));
        break;
      case 'documents-search-v2':
        printDocument(stdout, await client.searchDocumentsV2(validatePersonDocumentSearchV2({ schema_version: 2, kind: 'echo-person-document-search-v2',
          project_id: values['project-id'] === undefined ? null : validateProjectIdV1(values['project-id']), query: values.query === undefined ? '' : requiredText(values, 'query'),
          limit: optionalRecordLimit(values, 20) ?? 10, cursor: values.cursor === undefined ? null : requiredText(values, 'cursor') })));
        break;
      case 'documents-download-v2':
        printDocument(stdout, await client.downloadDocumentV2(requiredText(values, 'document-id'), requiredText(values, 'out'), values['project-id'] === undefined ? undefined : requiredText(values, 'project-id')));
        break;
      case 'projects-list-v2':
        print(stdout, await client.projectsV2({ ...contextPaging(values), ...(values.status === undefined ? {} : { status: requiredText(values, 'status') as 'active' | 'archived' }) }));
        break;
      case 'projects-create':
        print(stdout, await client.createProject(validateProjectCreateV1({ schema_version: 1, kind: 'echo-project-create-v1',
          request_id: requiredText(values, 'request-id'), name: requiredText(values, 'name') })));
        break;
      case 'projects-read-v2':
        print(stdout, await client.readProjectV2(requiredText(values, 'project-id')));
        break;
      case 'projects-rename':
        print(stdout, await client.renameProject(validateProjectRenameV1({ schema_version: 1, kind: 'echo-project-rename-v1', request_id: requiredText(values, 'request-id'), project_id: requiredText(values, 'project-id'), name: requiredText(values, 'name') })));
        break;
      case 'projects-archive':
      case 'projects-unarchive':
        print(stdout, await client.archiveProject(validateProjectArchiveV1({ schema_version: 1, kind: 'echo-project-archive-v1', request_id: requiredText(values, 'request-id'), project_id: requiredText(values, 'project-id'), archived: action === 'projects-archive' })));
        break;
      case 'projects-leave':
        print(stdout, await client.leaveProject(validateProjectLeaveV1({ schema_version: 1, kind: 'echo-project-leave-v1', request_id: requiredText(values, 'request-id'), project_id: requiredText(values, 'project-id') })));
        break;
      case 'projects-members':
        print(stdout, await client.projectMembers({ project_id: validateProjectIdV1(values['project-id']), ...contextPaging(values) }));
        break;
      case 'projects-directory':
        print(stdout, await client.projectDirectory({ project_id: validateProjectIdV1(values['project-id']), ...(values.query === undefined ? {} : { query: requiredText(values, 'query') }), ...contextPaging(values) }));
        break;
      case 'directory':
        print(stdout, await client.organizationDirectory({ ...(values.query === undefined ? {} : { query: requiredText(values, 'query') }), ...contextPaging(values) }));
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
      case 'projects-search-v2':
        print(stdout, await client.searchProjectContextV2({ project_id: validateProjectIdV1(values['project-id']), query: requiredText(values, 'query'), ...contextPaging(values) }));
        break;
      case 'updates-submit-v3': {
        const request = validatePersonUpdateSubmitV3({ schema_version: 3, kind: 'echo-person-update-submit-v3', request_id: validatePersonUpdateRequestId(requiredText(values, 'request-id')),
          title: requiredText(values, 'title'), text: readUpdateFile(requiredText(values, 'file')),
          association_project_ids: canonicalProjectIdArray(values['association-project-ids-json'], '--association-project-ids-json'), audience: uploadAudienceV3(values) });
        print(stdout, await client.submitUpdateV3(request));
        break;
      }
      case 'updates-status-v3':
        print(stdout, await client.updateStatusV3(requiredText(values, 'request-id')));
        break;
      case 'updates-search-v3':
        print(stdout, await client.searchUploadsV3({ query: requiredText(values, 'query'), ...contextPaging(values) }));
        break;
      case 'updates-search':
        print(stdout, await client.searchUploadsV2({ query: requiredText(values, 'query'), ...contextPaging(values) }));
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
        if (values.tickets === true && values.live === true) throw new Error('Choose --tickets or --live');
        print(stdout, {
          ok: true,
          result: await (values.live === true ? client.askWithLiveSources.bind(client) : values.tickets === true ? client.askWithTickets.bind(client) : client.ask.bind(client))(
            requiredText(values, "question"),
            values.project !== undefined
              ? validateProjectIdV1(requiredText(values, "project"))
              : values.mine === true ? { mine: true } : undefined,
            dependencies.abort_signal,
          ),
        });
        break;
      case "list":
        print(stdout, { ok: true, result: await client.list(listRequest!, dependencies.abort_signal) });
        break;
      case "open":
        print(stdout, { ok: true, result: await client.open(openRequest!, dependencies.abort_signal) });
        break;
      case 'evidence-search': {
        const project_id = values.project === undefined ? undefined : validateProjectIdV1(requiredText(values, 'project'));
        const kind = values.kind;
        if (kind !== undefined && !['imported_meeting', 'decision', 'action', 'rationale', 'note', 'document_passage'].includes(String(kind))) throw new Error('Invalid evidence kind');
        const limit = values.limit === undefined ? undefined : Number(values.limit);
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) throw new Error('Invalid evidence limit');
        print(stdout, { ok: true, result: await client.evidenceSearch({ schema_version: 1,
          ...(values.query === undefined ? {} : { query: requiredText(values, 'query') }),
          ...(kind === undefined ? {} : { kinds: [kind as 'imported_meeting' | 'decision' | 'action' | 'rationale' | 'note' | 'document_passage'] as const }),
          ...(limit === undefined ? {} : { limit }),
          ...(project_id === undefined ? {} : { project_id }),
        }, dependencies.abort_signal) });
        break;
      }
      case 'evidence-open': {
        let citation: unknown;
        try { citation = JSON.parse(requiredText(values, 'item')); } catch { throw new Error('Evidence citation JSON is invalid'); }
        const neighbours = values.neighbours === undefined ? undefined : Number(values.neighbours);
        if (neighbours !== undefined && (!Number.isSafeInteger(neighbours) || neighbours < 0 || neighbours > 2)) throw new Error('Invalid evidence neighbours');
        const project_id = values.project === undefined ? undefined : validateProjectIdV1(requiredText(values, 'project'));
        print(stdout, { ok: true, result: await client.evidenceOpen({ schema_version: 1, citation: citation as never,
          ...(neighbours === undefined ? {} : { neighbours: neighbours as 0 | 1 | 2 }),
          ...(project_id === undefined ? {} : { project_id }),
        }, dependencies.abort_signal) });
        break;
      }
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
      case "transcript": {
        const project_id = values.project === undefined
          ? undefined
          : validateProjectIdV1(requiredText(values, "project"));
        const offset = values.offset === undefined ? undefined : Number(values.offset);
        print(stdout, {
          ok: true,
          result: await client.readMeetingTranscript(validatePersonMeetingTranscriptReadRequestV1({
            schema_version: 1,
            scope: project_id === undefined ? { kind: "global" } : { kind: "project", project_id },
            citation: {
              kind: "approved_meeting_transcript",
              approval_id: requiredText(values, "approval-id"),
              source_id: requiredText(values, "source-id"),
              revision_id: requiredText(values, "revision-id"),
              source_sha256: requiredText(values, "source-sha256"),
            },
            ...(offset === undefined ? {} : { offset }),
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
        error instanceof PersonClientSessionUnavailableError || !["ask", "records", "list", "open"].includes(action)
        ? (error as Error).message : "Person request could not be completed",
      ...(error instanceof PersonAuthorityClientError ? { code: error.code, status: error.status } : {}),
      ...(error instanceof PersonQueryInputError ? { code: error.code } : {}),
      ...(error instanceof PersonToolOutcomeErrorV1 ? { reason: error.reason } : {}),
      ...(error instanceof EmployeeMutationError
        ? { code: error.code, mutation_outcome: error.mutation_outcome }
        : {}),
    });
    return 1;
  }
}
