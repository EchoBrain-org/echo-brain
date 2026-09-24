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
  readonly excerpt: string;
  readonly received_at: string;
}

export interface FeedPage {
  readonly project_id: string;
  readonly items: readonly FeedItem[];
  readonly next_cursor: string | null;
}

export interface ContextContent {
  readonly context_id: string;
  readonly title: string;
  readonly text: string;
  readonly received_at: string;
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

export interface AnswerSource {
  readonly label: string;
  readonly ref: SourceRef | null;
}

export interface Answer {
  readonly text: string;
  readonly scope: AskScope;
  readonly sources: readonly AnswerSource[];
}

export interface SourceEvidence {
  readonly label: string;
  readonly text: string;
}

/** One audience per item: only you, one project, or everyone. */
export type Audience = { readonly kind: 'only-me' } | { readonly kind: 'project'; readonly project_id: string } | { readonly kind: 'team' };

export interface Receipt {
  readonly request_id: string;
  readonly audience: Audience;
}

export interface FileHandle {
  readonly handle: string;
  readonly name: string;
  readonly size: number;
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
  'account.logout': { params: { expect: Expect }; result: AppStatus };
  'projects.list': { params: { expect: Expect; cursor?: string }; result: ProjectPage };
  'projects.feed': { params: { expect: Expect; project_id: string; cursor?: string }; result: FeedPage };
  'projects.readContext': { params: { expect: Expect; project_id: string; context_id: string }; result: ContextContent };
  'notes.submit': { params: { expect: Expect; request_id: string; text: string; audience: Audience; project_id?: string }; result: Receipt };
  /** The renderer names a file only by a handle main issued; main swaps in the path. */
  'documents.upload': { params: { expect: Expect; request_id: string; file_handle: string; title: string; audience: Audience; project_id?: string }; result: Receipt };
  'ask.run': { params: { expect: Expect; question: string; scope: AskScope }; result: Answer };
  'ask.source': { params: { expect: Expect; scope: AskScope; ref: SourceRef }; result: SourceEvidence };
}

export interface MainMethods {
  'dialog.openDocument': { params: Record<string, never>; result: FileHandle | null };
  'drop.accept': { params: { path: string }; result: FileHandle };
  'clipboard.writeText': { params: { text: string }; result: null };
  'window.hide': { params: Record<string, never>; result: null };
  'app.quit': { params: Record<string, never>; result: null };
}

export type Methods = HostMethods & MainMethods;
export type MethodName = keyof Methods;
export type HostMethodName = keyof HostMethods;

export const HOST_METHODS: readonly HostMethodName[] = [
  'app.status', 'signin.begin', 'account.logout', 'projects.list', 'projects.feed', 'projects.readContext',
  'notes.submit', 'documents.upload', 'ask.run', 'ask.source',
];
export const MAIN_METHODS: readonly (keyof MainMethods)[] = [
  'dialog.openDocument', 'drop.accept', 'clipboard.writeText', 'window.hide', 'app.quit',
];

/** Events main pushes to the renderer. */
export interface Events {
  'capture.open': Record<string, never>;
  'window.shown': Record<string, never>;
  'lifecycle.conceal': Record<string, never>;
  'lifecycle.resume': Record<string, never>;
  'signin.phase': { phase: 'open-browser' | 'installed'; expires_at?: string; browser_opened?: boolean };
  'host.restarted': Record<string, never>;
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

/** Parameters larger than this are refused at the broker. */
export const MAX_PARAMS_BYTES = 64 * 1024;
