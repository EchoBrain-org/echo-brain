// The only shapes that cross process boundaries. Everything here is
// token-free: the person host builds these view models from the client's
// validated output, and the renderer never sees a token, a path or a
// server-written error message.

export interface Account {
  readonly authority: string;
  readonly membership_id: string;
  readonly display_name: string;
  readonly role: 'owner' | 'employee';
}

export interface AppStatus {
  readonly signed_in: boolean;
  readonly account: Account | null;
  readonly client_version: string;
}

export interface ProjectSummary {
  readonly project_id: string;
  readonly name: string;
  readonly role: 'lead' | 'member';
  readonly created_at: string;
  /** Archived projects remain readable, but do not accept new material. */
  readonly status: 'active' | 'archived';
}

export interface ProjectPage {
  readonly items: readonly ProjectSummary[];
  readonly next_cursor: string | null;
}

/** The receipt that settles a rename, archive or leave operation. */
export interface ProjectSettingsReceipt {
  readonly request_id: string;
  readonly project_id: string;
  readonly operation: 'rename' | 'archive' | 'leave';
}

/** Who can read an item: only you, everyone in the organization, or one or more projects' members. */
export type Visibility = 'only-me' | 'team' | 'project';

/** What a list shows: what you added, or one project's items. The desktop never lists all you can read. */
export type ListScope = { readonly kind: 'mine' } | { readonly kind: 'project'; readonly project_id: string };

/** One item, by kind and id: a note's context id, a document's id, or an approved meeting's record digest. */
export interface ItemRef {
  readonly kind: 'note' | 'document' | 'meeting';
  readonly id: string;
}

/** One row of a list: never an item's text, and never a project's id. */
export interface ListItem {
  readonly ref: ItemRef;
  readonly title: string;
  /** When it entered ECHO (ISO 8601). */
  readonly added_at: string;
  readonly visibility: Visibility;
  /** The names of your projects it is filed in. */
  readonly projects: readonly string[];
  /** A document's kind and size, from the bytes the Authority checked, and where its text stands. */
  readonly document?: { readonly type: DocumentSummary['type']; readonly size: number; readonly extraction: Extraction };
  /** A meeting's own date (YYYY-MM-DD), when it has one. */
  readonly meeting_date?: string;
}

/** Newest first. Meetings still being indexed are held for a later read. */
export interface ListPage {
  readonly items: readonly ListItem[];
  readonly next_cursor: string | null;
  readonly meetings_held: boolean;
}

/** A saved document: an original file, and the text extracted from it. */
export interface DocumentSummary {
  readonly document_id: string;
  readonly title: string;
  readonly filename: string;
  readonly received_at: string;
  /** What kind of file it is, from the bytes the Authority checked. */
  readonly type: 'pdf' | 'word' | 'markdown' | 'text';
  /** Bytes. */
  readonly size: number;
  readonly audience: Visibility;
  readonly extraction: Extraction;
  /** The projects it is filed in that are yours. */
  readonly project_ids: readonly string[];
}

/** One piece of a document's extracted text, from a page or a paragraph. */
export interface TextChunk {
  readonly anchor: 'page' | 'paragraph';
  readonly start: number;
  readonly text: string;
}

/** A document and one page of its extracted text. */
export interface DocumentText {
  readonly document: DocumentSummary;
  readonly chunks: readonly TextChunk[];
  readonly next_cursor: string | null;
}

/** A person in a project, or one a directory found. */
export interface Member {
  readonly membership_id: string;
  readonly display_name: string;
  /** Absent for a directory entry. */
  readonly role?: 'lead' | 'member';
}

export interface MemberPage {
  readonly items: readonly Member[];
  readonly next_cursor: string | null;
}

/**
 * A change to a project: who is in it, or what is filed in it. Each is sent
 * with a request id, and resending the same one never changes anything twice.
 */
export type ProjectChange =
  | { readonly kind: 'member-add' | 'member-remove'; readonly project_id: string; readonly membership_id: string }
  | { readonly kind: 'member-set'; readonly project_id: string; readonly membership_id: string; readonly role: 'lead' | 'member' }
  | { readonly kind: 'associate' | 'dissociate'; readonly project_id: string; readonly context_id: string }
  | { readonly kind: 'document-associate' | 'document-dissociate'; readonly project_id: string; readonly document_id: string };

/** A project the Authority made for one request. Its name and your role in it come from reading it. */
export interface CreatedProject {
  readonly project_id: string;
}

/** One of the organization's employees, as its owner's list shows them. */
export interface Employee {
  readonly email: string;
  readonly display_name: string;
  readonly membership: 'active' | 'revoked';
  readonly invitation: 'pending' | 'expired' | 'redeemed' | 'none';
}

export interface Employees {
  readonly items: readonly Employee[];
}

/** An invitation saved in the folder main made. The path stays in main. */
export interface InvitationSaved {
  /** When the invitation stops working (ISO 8601). */
  readonly expires_at: string;
}

/** Add files…: the documents chosen in main's dialog, each as a handle, and the names of any it refused. */
export interface ChosenFiles {
  readonly files: readonly FileHandle[];
  readonly refused: readonly string[];
}

export interface ContextContent {
  readonly context_id: string;
  readonly title: string;
  readonly text: string;
  readonly received_at: string;
  /** Who can read it, as its row marks it. */
  readonly audience: Visibility;
  /** The projects it is filed in that are yours. */
  readonly project_ids: readonly string[];
}

/**
 * A live match for the bar's text: an item in the project in scope, or, in
 * all context, one of the saved notes you can read (of either note version).
 * Each opens by its ref, as a note.
 */
export interface Match {
  readonly context_id: string;
  readonly title: string;
  readonly excerpt: string;
  readonly received_at: string;
}

export interface Matches {
  readonly items: readonly Match[];
}

/** Ask is always explicitly scoped; there is no default. Mine is only what you added. */
export type AskScope = { readonly kind: 'global' } | { readonly kind: 'project'; readonly project_id: string } | { readonly kind: 'mine' };

/** Immutable coordinates of one answer source; opaque to the renderer. */
export interface SourceRef {
  readonly source_id: string;
  readonly revision_id: string;
  readonly source_sha256: string;
  readonly representation_sha256: string;
  readonly anchor_sha256: string;
  readonly document_id?: string;
}

/** Who may read an approved record: the organization's members, or its reviewer only. */
export type RecordPolicy = 'organization-member-readable-person-v2' | 'restricted-reviewer-person-v2' | 'project-members-readable-person-v1';

/** An approved record an answer cites, read with `person records --record-sha256`. */
export interface RecordRef {
  readonly record_sha256: string;
  readonly policy_id: RecordPolicy;
}

/** What an answer is based on: an approved record, an original, or live evidence. */
export type AnswerSource =
  | { readonly kind: 'record'; readonly label: string; readonly record: RecordRef }
  | { readonly kind: 'original'; readonly label: string; readonly ref: SourceRef }
  | { readonly kind: 'slack'; readonly label: string; readonly permalink: string }
  | { readonly kind: 'ticket'; readonly label: string; readonly permalink: string };

/** A cited statement in the Agentic Ask response. Citation indexes address Answer.sources. */
export interface AnswerStatement {
  readonly text: string;
  readonly citation_indexes: readonly number[];
  readonly private: boolean;
}

export interface AnswerPart {
  readonly question: string;
  readonly status: 'answered' | 'partial' | 'not_found' | 'records_only';
  readonly statements: readonly AnswerStatement[];
  readonly gap?: string;
  readonly records?: readonly AnswerStatement[];
}

/** An Agentic Ask answer. `text` is its plain reading, for Copy answer and earlier turns. */
export interface Answer {
  readonly text: string;
  readonly scope: AskScope;
  readonly sources: readonly AnswerSource[];
  readonly direct?: AnswerStatement;
  /** At least one. */
  readonly parts: readonly AnswerPart[];
  /** Off-scope: the evidence is about another subject, so a wider ask would not help. */
  readonly outcome: 'answered' | 'partial' | 'not_found' | 'off_scope';
  readonly assumption?: string;
  readonly notice?: string;
}

export interface SourceEvidence {
  readonly label: string;
  readonly text: string;
}

/** One approved decision, action or rationale, with up to three excerpts that support it. */
export interface RecordItem {
  readonly text: string;
  /** Only a decision still open says so. */
  readonly status?: 'proposed' | 'unresolved';
  /** An action's owner, only as the approver confirmed it at approval. */
  readonly owner?: string;
  readonly excerpts: readonly { readonly quote: string; readonly at?: string }[];
  /**
   * A long item read in parts, while some are still unread: its text holds
   * parts `from` to `to` of `count`, and the next page's first part goes on.
   */
  readonly parts?: { readonly from: number; readonly to: number; readonly count: number };
}

/** At most 32 items; `more` says some were left out. */
export interface RecordSection {
  readonly items: readonly RecordItem[];
  readonly more: boolean;
}

/** An approved meeting record, as the source pane shows it. Every text is at most 2,000 characters. */
export interface ApprovedRecord {
  readonly title?: string;
  /** When it was approved (ISO 8601), as its row shows it: only on a record opened by its ref. */
  readonly added_at?: string;
  /** When the meeting started (ISO 8601), in which time zone, and whether it was all day. */
  readonly started_at?: string;
  readonly timezone?: string;
  readonly all_day: boolean;
  readonly approved_by?: string;
  /** At most 32 names; `participants_more` says others were left out. */
  readonly participants: readonly string[];
  readonly participants_more: boolean;
  readonly visibility: 'organization' | 'project' | 'approver';
  readonly decisions: RecordSection;
  readonly actions: RecordSection;
  readonly rationales: RecordSection;
}

/** One item opened by its ref: a note's text, a page of a document's text, or a page of a meeting's approved record. */
export type Opened =
  | { readonly kind: 'note'; readonly content: ContextContent }
  | { readonly kind: 'document'; readonly document: DocumentText }
  | { readonly kind: 'meeting'; readonly record: ApprovedRecord; readonly next_cursor: string | null };

/** One audience per item: only you, one project's members, several projects' members, or everyone. */
export type Audience =
  | { readonly kind: 'only-me' }
  | { readonly kind: 'project'; readonly project_id: string }
  /** Several projects, in any order (the host sends them sorted). Capture sends a single project as `project`. */
  | { readonly kind: 'projects'; readonly project_ids: readonly string[] }
  | { readonly kind: 'team' };

/**
 * The most projects a capture is filed in, and the most whose members can
 * read it: the API's own bound (PERSON_UPLOAD_PROJECT_SET_MAX).
 */
export const MAX_CAPTURE_PROJECTS = 20;

/** Where a saved document's text extraction stands (the Authority's own states). */
export type Extraction = 'extracting' | 'ready' | 'partial' | 'no_text' | 'encrypted' | 'malformed' | 'limit_exceeded' | 'timed_out'
  | 'unsupported' | 'unavailable';

export interface Receipt {
  readonly request_id: string;
  readonly audience: Audience;
  /** A document's extraction state, when the Authority's receipt carries it. */
  readonly extraction?: Extraction;
}

/** One of the organization's tools, and whether you linked your own account to it. */
export interface ConnectedTool {
  readonly name: string;
  readonly enabled: boolean;
  readonly linked: boolean;
}

export interface ConnectedTools {
  readonly tools: readonly ConnectedTool[];
}

/** What a status check says about a save whose outcome was unknown. */
export interface WriteStatus {
  readonly state: 'saved' | 'not_saved' | 'unknown';
  readonly extraction?: Extraction;
}

export interface FileHandle {
  readonly handle: string;
  readonly name: string;
  /** Bytes, for a document. */
  readonly size?: number;
}

export interface Failure {
  readonly code: string;
  readonly retryable: boolean;
  /** Present for writes: whether the change may already have been applied. */
  readonly mutation_outcome?: 'unknown' | 'not_submitted';
  readonly request_id?: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure };

/** The account the renderer is showing; host calls refuse to run for another. */
export interface Expect {
  readonly authority: string;
  readonly membership_id: string;
}

export interface HostMethods {
  'app.status': { params: Record<string, never>; result: AppStatus };
  'signin.begin': { params: { authority_url: string }; result: AppStatus };
  /** The renderer names the invitation only by a handle main issued; main swaps in the path. */
  'signin.invitation': { params: { invitation_handle: string }; result: AppStatus };
  'projects.list': { params: { expect: Expect; status?: 'active' | 'archived'; cursor?: string }; result: ProjectPage };
  /** One page of what you added, or of one project's notes, documents and meetings, newest first. */
  'list.page': { params: { expect: Expect; scope: ListScope; cursor?: string }; result: ListPage };
  /** One item by its ref, under your current access: a document's text or a meeting's record a page at a time. */
  'open.ref': { params: { expect: Expect; ref: ItemRef; cursor?: string }; result: Opened };
  /** Save original…: the renderer names the file only by a handle main issued; main swaps in the path. */
  'documents.save': { params: { expect: Expect; document_id: string; save_handle: string }; result: null };
  /** The project as it is now, with your role in it. */
  'projects.read': { params: { expect: Expect; project_id: string }; result: ProjectSummary };
  'projects.members': { params: { expect: Expect; project_id: string; cursor?: string }; result: MemberPage };
  /** People in the organization a lead can add, by name. */
  'projects.directory': { params: { expect: Expect; project_id: string; query?: string; cursor?: string }; result: MemberPage };
  /**
   * People in your own organization, by name, for any member and with no
   * project: New project's people before the project exists. An Authority
   * without it answers not_found.
   */
  'people.directory': { params: { expect: Expect; query?: string; cursor?: string }; result: MemberPage };
  /** A change to a project. Only the Authority's receipt says it was made. */
  'projects.change': { params: { expect: Expect; request_id: string; change: ProjectChange }; result: null };
  /** New project: made once per request id, and only the receipt says it was made. */
  'projects.create': { params: { expect: Expect; request_id: string; name: string }; result: CreatedProject };
  'projects.rename': { params: { expect: Expect; request_id: string; project_id: string; name: string }; result: ProjectSettingsReceipt };
  'projects.archive': { params: { expect: Expect; request_id: string; project_id: string; archived: boolean }; result: ProjectSettingsReceipt };
  'projects.leave': { params: { expect: Expect; request_id: string; project_id: string }; result: ProjectSettingsReceipt };
  /** People & invites (owners only): everyone the organization invited, and where each stands. */
  'employees.list': { params: { expect: Expect }; result: Employees };
  /**
   * Invite or Reissue: the renderer names where to save only by a handle main
   * issued; main makes a private folder there and swaps in the file's path.
   */
  'employees.invite': { params: { expect: Expect; name: string; email: string; invitation_handle: string }; result: InvitationSaved };
  'employees.reissue': { params: { expect: Expect; email: string; invitation_handle: string }; result: InvitationSaved };
  /** Revoke access: ends the employee's membership at once. */
  'employees.revoke': { params: { expect: Expect; email: string }; result: null };
  /** `project_ids`: the projects it is filed in, at most MAX_CAPTURE_PROJECTS, in any order. */
  'notes.submit': { params: { expect: Expect; request_id: string; text: string; audience: Audience; project_ids: readonly string[] }; result: Receipt };
  /** The renderer names a file only by a handle main issued; main swaps in the path. */
  'documents.upload': {
    params: { expect: Expect; request_id: string; file_handle: string; title: string; audience: Audience; project_ids: readonly string[] };
    result: Receipt;
  };
  'ask.run': { params: { expect: Expect; question: string; scope: AskScope; cancel_id: string }; result: Answer };
  /** Cancels an active Ask by its renderer-issued opaque id. */
  'ask.cancel': { params: { cancel_id: string }; result: null };
  /** The bar's live search, within its scope: a project, or all context. */
  'search.run': { params: { expect: Expect; query: string; scope: AskScope }; result: Matches };
  'ask.source': { params: { expect: Expect; scope: AskScope; ref: SourceRef }; result: SourceEvidence };
  /** Reads one approved record an answer cites. */
  'ask.record': { params: { expect: Expect; record: RecordRef }; result: ApprovedRecord };
  'writes.status': { params: { expect: Expect; request_id: string; kind: 'note' | 'document' }; result: WriteStatus };
  /** Resends a document's retained original under the same request. */
  'documents.retry': { params: { expect: Expect; request_id: string; audience: Audience }; result: Receipt };
  /** Start over: removes the private copy the client kept to resend a document. The Authority is not asked. */
  'documents.abandon': { params: { expect: Expect; request_id: string }; result: null };
  /** Signs the account on screen out of this computer; the reply is the new status. */
  'account.signOut': { params: { expect: Expect }; result: AppStatus };
  /** Connected tools…: a read, for the account on screen. */
  'account.tools': { params: { expect: Expect }; result: ConnectedTools };
}

export interface MainMethods {
  /** Opens one cited Slack message in the system browser; only Slack message permalinks are allowed. */
  'source.openSlack': { params: { permalink: string }; result: null };
  /** Opens a validated ticket display link; the provider owns tenant validation. */
  'source.openTicket': { params: { permalink: string }; result: null };
  'dialog.openDocument': { params: Record<string, never>; result: FileHandle | null };
  /** Add files…, in New project: up to 20 documents at once. */
  'dialog.openDocuments': { params: Record<string, never>; result: ChosenFiles };
  /**
   * Invite employee… and Reissue invitation…: where the private invitation
   * folder goes, chosen in main's dialog. `name` only suggests the folder's name.
   */
  'dialog.saveInvitation': { params: { name: string; reissue?: boolean }; result: FileHandle | null };
  /** Show invitation in Finder: the invitation saved under a handle an invite or a reissue used. */
  'invitation.show': { params: { invitation_handle: string }; result: null };
  /** Copy answer: at most 12,000 characters, an answer's own bound. */
  'clipboard.writeText': { params: { text: string }; result: null };
  /** The invitation folder (or its file) the organization owner sent. */
  'dialog.openInvitation': { params: Record<string, never>; result: FileHandle | null };
  /** Save original…: where to save it, chosen in main's dialog. The page gets a handle, never the path. */
  'dialog.saveDocument': { params: { name: string }; result: FileHandle | null };
  /** A save's or a project change's outcome is unknown: quitting asks first, naming a note, a file or a change. */
  'app.setUnresolved': { params: { unresolved: boolean; file?: boolean; change?: boolean }; result: null };
  /** After the host gave up: start it again. */
  'app.retryHost': { params: Record<string, never>; result: null };
  /** Pops up the Account menu at a point in the window, in CSS pixels. */
  'menu.account': { params: { x: number; y: number }; result: null };
}

export type Methods = HostMethods & MainMethods;
export type MethodName = keyof Methods;
export type HostMethodName = keyof HostMethods;

export const HOST_METHODS: readonly HostMethodName[] = [
  'app.status', 'signin.begin', 'signin.invitation', 'projects.list', 'list.page', 'open.ref',
  'notes.submit', 'documents.upload', 'ask.run', 'ask.cancel', 'ask.source', 'ask.record', 'writes.status', 'documents.retry', 'documents.abandon',
  'account.signOut', 'account.tools', 'search.run', 'documents.save', 'projects.read',
  'projects.members', 'projects.directory', 'people.directory', 'projects.change', 'projects.create', 'projects.rename', 'projects.archive', 'projects.leave', 'employees.list', 'employees.invite',
  'employees.reissue', 'employees.revoke',
];
export const MAIN_METHODS: readonly (keyof MainMethods)[] = [
  'source.openSlack', 'source.openTicket', 'dialog.openDocument', 'clipboard.writeText', 'dialog.openInvitation', 'app.setUnresolved', 'app.retryHost', 'menu.account',
  'dialog.saveDocument', 'dialog.openDocuments', 'dialog.saveInvitation', 'invitation.show',
];
/** Host methods that change what the Authority stores. */
export const WRITE_METHODS: ReadonlySet<string> = new Set<HostMethodName>([
  'notes.submit', 'documents.upload', 'documents.retry', 'projects.change', 'projects.create', 'projects.rename', 'projects.archive', 'projects.leave', 'employees.invite', 'employees.reissue',
  'employees.revoke',
]);
/** Host methods whose reply is the account status: main keeps the Account menu current from them. */
export const STATUS_METHODS: ReadonlySet<string> = new Set<HostMethodName>(['app.status', 'signin.begin', 'signin.invitation', 'account.signOut']);

/** What an Account menu item asks the window to do. */
export type AccountCommand = 'signin' | 'invitation' | 'switch' | 'signout' | 'tools';

/** Events main pushes to the renderer. */
export interface Events {
  'capture.open': Record<string, never>;
  'window.shown': Record<string, never>;
  'lifecycle.conceal': Record<string, never>;
  'lifecycle.resume': Record<string, never>;
  'signin.phase': { phase: 'open-browser' | 'installed'; browser_opened?: boolean };
  'host.restarted': Record<string, never>;
  /** The host kept exiting and main stopped restarting it. */
  'host.failed': Record<string, never>;
  /** An Account menu item was chosen, in the window or the tray. */
  'account.command': { command: AccountCommand };
  /** Organization ▸ People & invites… was chosen in the tray (owners only). */
  'organization.open': Record<string, never>;
}
export type EventName = keyof Events;

/** Requests main sends to the host process, and its replies. */
export interface HostRequest {
  readonly id: number;
  readonly method: HostMethodName;
  readonly params: unknown;
}
export interface HostReply {
  readonly id: number;
  readonly result: Result<unknown>;
}
export interface HostNotice {
  readonly notice: 'signin.phase' | 'open-external';
  readonly payload: unknown;
}

/** The only address an 'open-external' notice opens: https, with no credentials in it. */
export function externalUrl(raw: unknown): string | null {
  try {
    const url = new URL(String(raw));
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : null;
  } catch {
    return null;
  }
}

/** The Ask contract's Slack permalink grammar, checked again before main opens a renderer request. */
export function slackPermalink(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length <= 512 &&
    /^https:\/\/[a-z0-9-]+(\.enterprise)?\.slack\.com\/archives\/[CDG][A-Z0-9]{2,30}\/p\d{15,17}(\?[A-Za-z0-9_=&.%-]{0,200})?$/.test(raw)
    ? raw : null;
}

/** A ticket display link has no embedded authorization or redirect parameters. */
export function ticketPermalink(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\s\\\p{Cc}]/u.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '' &&
      url.search === '' && url.hash === '' && url.href === raw ? raw : null;
  } catch { return null; }
}

/** Parameters larger than this are refused at the broker. */
export const MAX_PARAMS_BYTES = 64 * 1024;
