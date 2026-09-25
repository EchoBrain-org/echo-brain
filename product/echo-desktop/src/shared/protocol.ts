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
}

export interface ProjectPage {
  readonly items: readonly ProjectSummary[];
  readonly next_cursor: string | null;
}

export interface FeedItem {
  readonly context_id: string;
  readonly title: string;
  readonly received_at: string;
  /** Who can read it; project rows carry no mark. */
  readonly audience: 'only-me' | 'project' | 'team';
}

export interface FeedPage {
  readonly project_id: string;
  readonly items: readonly FeedItem[];
}

export interface ContextContent {
  readonly context_id: string;
  readonly title: string;
  readonly text: string;
  readonly received_at: string;
}

/**
 * A live match for the bar's text: an item in the project in scope, or, in
 * all context, one of the saved notes you can read (of either note version).
 */
export interface Match {
  readonly context_id: string;
  readonly title: string;
  readonly excerpt: string;
  readonly received_at: string;
  /** Which read opens it: the project's, or the saved-note read of its version. */
  readonly source: 'project' | 'v2' | 'v3';
}

export interface Matches {
  readonly items: readonly Match[];
}

/** Ask is always explicitly scoped; there is no default. */
export type AskScope = { readonly kind: 'global' } | { readonly kind: 'project'; readonly project_id: string };

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
export type RecordPolicy = 'organization-member-readable-person-v2' | 'restricted-reviewer-person-v2';

/** An approved record an answer cites, read with `person records --record-sha256`. */
export interface RecordRef {
  readonly record_sha256: string;
  readonly policy_id: RecordPolicy;
}

/** What an answer is based on: an approved meeting record, or an original source. */
export type AnswerSource =
  | { readonly kind: 'record'; readonly label: string; readonly record: RecordRef }
  | { readonly kind: 'original'; readonly label: string; readonly ref: SourceRef };

export interface Answer {
  readonly text: string;
  readonly scope: AskScope;
  readonly sources: readonly AnswerSource[];
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
  readonly excerpts: readonly { readonly quote: string; readonly at?: string }[];
}

/** At most 32 items; `more` says some were left out. */
export interface RecordSection {
  readonly items: readonly RecordItem[];
  readonly more: boolean;
}

/** An approved meeting record, as the source pane shows it. Every text is at most 2,000 characters. */
export interface ApprovedRecord {
  readonly title?: string;
  /** When the meeting started (ISO 8601), in which time zone, and whether it was all day. */
  readonly started_at?: string;
  readonly timezone?: string;
  readonly all_day: boolean;
  readonly approved_by?: string;
  /** At most 32 names; `participants_more` says others were left out. */
  readonly participants: readonly string[];
  readonly participants_more: boolean;
  readonly visibility: 'organization' | 'approver';
  readonly decisions: RecordSection;
  readonly actions: RecordSection;
  readonly rationales: RecordSection;
}

/** One audience per item: only you, one project, or everyone. */
export type Audience = { readonly kind: 'only-me' } | { readonly kind: 'project'; readonly project_id: string } | { readonly kind: 'team' };

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
  'projects.list': { params: { expect: Expect; cursor?: string }; result: ProjectPage };
  'projects.feed': { params: { expect: Expect; project_id: string }; result: FeedPage };
  'projects.readContext': { params: { expect: Expect; project_id: string; context_id: string }; result: ContextContent };
  'notes.submit': { params: { expect: Expect; request_id: string; text: string; audience: Audience; project_id?: string }; result: Receipt };
  /** The renderer names a file only by a handle main issued; main swaps in the path. */
  'documents.upload': { params: { expect: Expect; request_id: string; file_handle: string; title: string; audience: Audience; project_id?: string }; result: Receipt };
  'ask.run': { params: { expect: Expect; question: string; scope: AskScope }; result: Answer };
  /** The bar's live search, within its scope: a project, or all context. */
  'search.run': { params: { expect: Expect; query: string; scope: AskScope }; result: Matches };
  /** Reads a saved note found in all context. A project's match is read with projects.readContext. */
  'search.read': { params: { expect: Expect; context_id: string; source: 'v2' | 'v3' }; result: ContextContent };
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
  'dialog.openDocument': { params: Record<string, never>; result: FileHandle | null };
  /** The invitation folder (or its file) the organization owner sent. */
  'dialog.openInvitation': { params: Record<string, never>; result: FileHandle | null };
  /** A save's outcome is unknown: quitting asks first, naming a note or a file. */
  'app.setUnresolved': { params: { unresolved: boolean; file?: boolean }; result: null };
  /** After the host gave up: start it again. */
  'app.retryHost': { params: Record<string, never>; result: null };
  /** Pops up the Account menu at a point in the window, in CSS pixels. */
  'menu.account': { params: { x: number; y: number }; result: null };
}

export type Methods = HostMethods & MainMethods;
export type MethodName = keyof Methods;
export type HostMethodName = keyof HostMethods;

export const HOST_METHODS: readonly HostMethodName[] = [
  'app.status', 'signin.begin', 'signin.invitation', 'projects.list', 'projects.feed', 'projects.readContext',
  'notes.submit', 'documents.upload', 'ask.run', 'ask.source', 'ask.record', 'writes.status', 'documents.retry', 'documents.abandon',
  'account.signOut', 'account.tools', 'search.run', 'search.read',
];
export const MAIN_METHODS: readonly (keyof MainMethods)[] = [
  'dialog.openDocument', 'dialog.openInvitation', 'app.setUnresolved', 'app.retryHost', 'menu.account',
];
/** Host methods that change what the Authority stores. */
export const WRITE_METHODS: ReadonlySet<string> = new Set<HostMethodName>(['notes.submit', 'documents.upload', 'documents.retry']);
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

/** Parameters larger than this are refused at the broker. */
export const MAX_PARAMS_BYTES = 64 * 1024;
