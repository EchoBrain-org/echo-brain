// All renderer state and the actions that change it. Every request carries the
// account being shown; late replies for a page that has moved on are dropped.
import { useEffect, useState } from 'preact/hooks';
import type {
  AccountCommand, Answer, AnswerSource, AppStatus, ApprovedRecord, AskScope, Audience, ConnectedTool, ContextContent, DocumentSummary,
  DocumentText, Employee, Expect, Extraction, Failure, FeedItem, FileHandle, Match, Member, ProjectChange, ProjectSummary, Receipt, RecordRef,
  Result, SourceEvidence,
} from '../shared/protocol.js';
import { askText, searchQuery } from '../shared/query.js';
import { dropFile, rpc } from './api.js';
import { moreSources, reread, type FeedSource } from './feed.js';
import { message } from './messages.js';

type Route = { page: 'home' } | { page: 'project'; project: ProjectSummary } | { page: 'organization' };

/** A question, in the scope it was asked in. */
export interface AskQuestion {
  question: string;
  scope: AskScope;
  scopeName: string;
}

/** One answered question of the thread. */
export interface AskTurn extends AskQuestion {
  id: number;
  answer: Answer;
}

/**
 * The Ask thread: follow-ups stack, newest at the bottom. Only the current
 * answer has chips and sources. A question that fails or is cancelled leaves
 * the answer before it current, as the Swift app did.
 */
export interface AskState {
  /** The question on its way; a reply for any other is dropped. */
  seq: number;
  /** Earlier answers, oldest first: at most five. */
  earlier: readonly AskTurn[];
  /** The answer that was current when the question on its way was asked. */
  previous: AskTurn | null;
  /** The current answer. */
  shown: AskTurn | null;
  asking: AskQuestion | null;
  /** The last question that could not be answered. */
  failed: (AskQuestion & { failure: Failure }) | null;
}

/** A read the source pane waits on, has, or could not make. */
export type Read<T> =
  | { readonly loading: true }
  | { readonly loading: false; readonly value: T }
  | { readonly loading: false; readonly failure: Failure };

/**
 * The current answer's sources: the pane beside it, and the approved records
 * read for it. Nothing here outlives the answer, or another app coming in
 * front: those start it over.
 */
export interface SourcesState {
  /** Which start this is: a read for an earlier one is dropped. */
  gen: number;
  /** The source the pane shows, by its place in the answer; null while the pane is closed. */
  open: number | null;
  /** The last one chosen: Sources (n) opens the pane on it again. */
  selected: number;
  /** Approved records read for this answer, by digest. */
  records: Readonly<Record<string, Read<ApprovedRecord>>>;
  /** The original the pane shows, read each time it is chosen. */
  evidence: { seq: number; index: number; read: Read<SourceEvidence> } | null;
}

/** Who can read a capture: only you, the members of its project, or everyone in the organization. */
export type Readers = 'only-me' | 'project' | 'team';

/** Capture: one page, a note or one file, and who can read it. */
export interface ComposeState {
  seq: number;
  text: string;
  file: FileHandle | null;
  /**
   * The project in the Who can read row: the page's, or one chosen under
   * More…. The capture is filed there, whoever can read it.
   */
  project: ProjectSummary | null;
  /** 'project' only ever with a project. */
  readers: Readers;
  /** More… is open: the other projects to choose from. */
  picking: boolean;
  /** unknown: the save may or may not have arrived; the text is locked. */
  status: 'editing' | 'sending' | 'error' | 'unknown' | 'checking';
  /** The exact request a retry resends. */
  requestId: string;
  /** A file whose outcome was unknown: the client keeps a private copy to resend it. */
  kept: boolean;
  failure?: Failure;
  /** Closed but kept: ⌘⇧E or + brings it back. */
  hidden: boolean;
  /** Asking once before starting over on an unconfirmed save. */
  confirmNew: boolean;
  /** A fixed line about the last gesture, such as a file that was not attached. */
  notice?: string;
}

/** Sign out or Switch account: asked first, since it cannot be undone. */
export interface SignOutSheet {
  kind: 'signout' | 'switch';
  busy: boolean;
  failure?: Failure;
}

/** Connected tools…: a read of the organization's tools. It can be closed while it loads. */
export interface ToolsSheet {
  kind: 'tools';
  seq: number;
  loading: boolean;
  tools?: readonly ConnectedTool[];
  failure?: Failure;
}

/**
 * Finding people for a project and adding one, which People and New project
 * share. Adding is instant, with an Undo; making a lead or removing someone
 * is asked first.
 */
export interface Finding {
  /** The name typed to find someone. */
  query: string;
  /** People the directory found for the name, or its first people. */
  directory: { seq: number; items: readonly Member[]; next: string | null; loading: boolean; failure?: Failure } | null;
  /** The member whose ⋯ is open. */
  menu: string | null;
  /** What is being asked before it is done. */
  confirm: { action: 'lead' | 'member' | 'remove'; person: Member } | null;
  /**
   * The person the last add added, offered back as Undo. `created` says the
   * whole list was read and did not have them, so the add made them a member.
   */
  added: { requestId: string; person: Member; created: boolean } | null;
}

/** People: a project's members and, for a lead, the organization's people to add. */
export interface PeopleSheet extends Finding {
  kind: 'people';
  seq: number;
  /** The project, with your role in it as last read. */
  project: ProjectSummary;
  /** The project could not be read again. */
  failure?: Failure;
}

/** One file in New project. They save one at a time, each under its own request. */
export interface ProjectFile {
  id: number;
  name: string;
  /** Absent for a file main refused. */
  handle?: FileHandle;
  requestId: string;
  /** unknown: it may or may not have arrived; nothing after it starts until that is settled. */
  status: 'waiting' | 'saving' | 'saved' | 'unknown' | 'checking' | 'failed' | 'skipped';
  extraction?: Extraction;
  failure?: Failure;
  /** The client kept a private copy to resend it. */
  kept: boolean;
}

/**
 * New project: a name and files, then Create. Once the project exists it
 * opens behind the sheet, people can be added to it, and the files save into
 * it one by one.
 */
export interface NewProjectSheet extends Finding {
  kind: 'new-project';
  seq: number;
  name: string;
  /** The create: its request, the name it sends, and where it stands. An unknown one is resent as it was. */
  create: { requestId: string; name: string; status: 'editing' | 'sending' | 'unknown' | 'failed' | 'created'; failure?: Failure };
  /** Close was chosen while the create or a file may have arrived: closing gives up finding out, so it is asked first. */
  confirmClose: boolean;
  /** The project Create made, once read. */
  project: ProjectSummary | null;
  /** Made, but not read yet: Open reads it again, and Create is never offered twice. */
  createdId: string | null;
  opening: boolean;
  openFailure?: Failure;
  files: ProjectFile[];
  /** The file whose Skip… is being asked. */
  skip: number | null;
  /** A fixed line about the last gesture, such as too many files. */
  notice?: string;
}

export type Sheet = SignOutSheet | ToolsSheet | PeopleSheet | NewProjectSheet;

/**
 * People & invites, for owners: the organization's employees, and inviting,
 * reissuing and revoking. There are no request ids here: only reading the
 * list again settles a change whose outcome is unknown.
 */
export interface OrganizationState {
  seq: number;
  loading: boolean;
  /** Null until read, and again once a change's outcome is unknown. */
  items: readonly Employee[] | null;
  failure?: Failure;
  /** Typed to invite someone; they also narrow the list. */
  name: string;
  email: string;
  /** The email whose ⋯ is open. */
  menu: string | null;
  /** Revoke access…, asked first. */
  confirm: Employee | null;
  /** A change on its way, or one whose outcome only a new read of the list can settle. */
  write: { action: 'invite' | 'reissue' | 'revoke'; status: 'sending' | 'unknown' } | null;
  /** What the last change did, or why it did not. */
  notice: string | null;
  /** The invitation just saved: Show invitation in Finder, and an invite's Undo. */
  saved: { handle: string; action: 'invite' | 'reissue'; name: string; email: string; expires_at: string } | null;
}

/** Where an original was opened: a project's item, a saved note found in all context, or a document. */
export type ReaderFrom =
  | { kind: 'project'; project_id: string }
  | { kind: 'note'; source: 'v2' | 'v3' }
  | { kind: 'document'; project_id: string | null };

/** An original open in the reader: a note's text, or a document's text a page at a time. */
export interface ReaderState {
  /** The note's context id, or the document's id. */
  id: string;
  from: ReaderFrom;
  loading: boolean;
  content?: ContextContent;
  document?: DocumentText;
  failure?: Failure;
  /** The ⋯ menu, and its list of projects to add to. */
  menu: 'closed' | 'open' | 'projects';
  /** Save original…: on its way, done, or not done. */
  save?: { status: 'saving' | 'saved' | 'failed'; failure?: Failure };
}

/** A project's notes and documents, each read ten at a time. */
export interface FeedState {
  projectId: string;
  /** This visit to the project: where its feed was scrolled is kept while it lasts. */
  opened: number;
  notes: FeedItem[];
  notesNext: string | null;
  documents: DocumentSummary[];
  documentsNext: string | null;
  /** The lists whose first page could not be read: Try again reads them. */
  unread: FeedSource[];
  loading: boolean;
  failure?: Failure;
}

/** A project's members: the stack in the title bar, and People. */
export interface RosterState {
  projectId: string;
  items: Member[];
  next: string | null;
  loading: boolean;
  failure?: Failure;
}

/**
 * The project change on its way, or whose outcome is unknown. While it is
 * either, no other change starts. Try again resends exactly it; only the
 * Authority's receipt settles it.
 */
export interface ChangeState {
  seq: number;
  requestId: string;
  change: ProjectChange;
  /** The project it changes. */
  project: ProjectSummary;
  /** People or the reader: where it was asked for. */
  origin: 'people' | 'reader';
  /** The person a member change is about. */
  person?: Member;
  /** An add of someone the whole member list did not have: its Undo is not asked first. */
  created?: boolean;
  status: 'sending' | 'unknown' | 'failed';
  failure?: Failure;
  /** Dismiss was chosen once: forgetting it is asked first. */
  confirmDismiss: boolean;
}

/** The live matches for the bar's text, within the scope they were searched in. */
export interface MatchesState {
  seq: number;
  query: string;
  scope: AskScope;
  loading: boolean;
  items: readonly Match[];
  failure?: Failure;
}

export interface State {
  status: AppStatus | null;
  booting: boolean;
  route: Route;
  projects: { items: ProjectSummary[]; next: string | null; loading: boolean; failure?: Failure };
  feed: FeedState | null;
  roster: RosterState | null;
  reader: ReaderState | null;
  change: ChangeState | null;
  /**
   * What the bar asks about, and searches: a project (the chip) or all
   * context. The page never moves with it.
   */
  barScope: AskScope;
  /** The bar's text. Only asking, Escape, or a real change of access empties it. */
  barText: string;
  matches: MatchesState | null;
  ask: AskState | null;
  sources: SourcesState | null;
  compose: ComposeState | null;
  /** Where the last confirmed save went, until the next capture or page. */
  toast: string | null;
  concealed: boolean;
  /** form: the organization address is being asked for (Sign in with Google…). */
  signin: { phase: 'idle' | 'waiting' | 'failed'; form: boolean; failure?: Failure; browserOpened?: boolean };
  /** A sheet over the window for the account: only one at a time. */
  sheet: Sheet | null;
  /** No status could be read (the host is down): not the same as signed out. */
  startFailed: boolean;
  /** On by default; the toggle only hides it, and this computer remembers. */
  sidebarOpen: boolean;
  /** People & invites, while it is the page. */
  organization: OrganizationState | null;
  /**
   * The employee change on its way. It outlives a visit to People & invites:
   * no other change starts while it is, and a visit made meanwhile shows what
   * it did.
   */
  employeeWrite: { id: number; action: 'invite' | 'reissue' | 'revoke' } | null;
}

const SIDEBAR_OPEN = 'echo.sidebarOpen';

function rememberedSidebar(): boolean {
  try { return localStorage.getItem(SIDEBAR_OPEN) !== 'false'; } catch { return true; }
}

let state: State = {
  status: null, booting: true, route: { page: 'home' }, projects: { items: [], next: null, loading: false }, feed: null, roster: null,
  reader: null, change: null,
  barScope: { kind: 'global' }, barText: '', matches: null, ask: null, sources: null, compose: null, toast: null, concealed: false,
  signin: { phase: 'idle', form: false }, sheet: null, startFailed: false, sidebarOpen: rememberedSidebar(), organization: null, employeeWrite: null,
};
const listeners = new Set<() => void>();
let seq = 0;

export function getState(): State { return state; }
function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  listeners.forEach(listener => listener());
}

export function useStore(): State {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force(value => value + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  return state;
}

function expect(): Expect | null {
  const account = state.status?.account;
  return account ? { authority: account.authority, membership_id: account.membership_id } : null;
}

/** Access that was lost or refused. A timeout, an outage or a bad reply says nothing about it. */
const ACCESS_LOST = ['signed_out', 'unauthorized', 'stale_access_state', 'sign_in_required', 'not_found', 'forbidden', 'owner_access_required'];

/**
 * Signed out or switched under us: re-read the account. The page that failed
 * still shows its failure, so nothing is left loading when the account is the
 * same one after all. Lost or refused access also empties the bar.
 */
function accountLost(failure: Failure): void {
  if (ACCESS_LOST.includes(failure.code)) emptyBar();
  if (['signed_out', 'account_changed', 'unauthorized', 'stale_access_state', 'sign_in_required', 'owner_access_required'].includes(failure.code)) {
    void refreshStatus();
  }
}

// ---- status and sign-in ------------------------------------------------------

/** The last account signed in here. Signing out and back in as it keeps the drafts. */
let lastAccount: Expect | null = null;

let statusSeq = 0;

export async function refreshStatus(): Promise<void> {
  const mine = ++statusSeq;
  const result = await rpc('app.status', {});
  if (mine !== statusSeq) return; // a newer read is on its way
  // Keep what is on screen; with nothing on screen yet, say ECHO could not start.
  if (!result.ok) { set({ booting: false, startFailed: state.status === null || result.failure.code === 'host_failed' }); return; }
  applyStatus(result.value);
}

function applyStatus(status: AppStatus): void {
  statusSeq += 1; // an older read still on its way is stale now
  const wasSignedIn = state.status?.signed_in === true;
  const before = state.status?.account ?? null;
  const next = status.account;
  set({ status, booting: false, startFailed: false });
  // Signed out: the sign-in page covers everything until someone signs in.
  if (!next) { emptyBar(); set({ sheet: null }); unresolvedChanged(); return; }
  const same = lastAccount?.authority === next.authority && lastAccount.membership_id === next.membership_id;
  // Someone else: nothing of the last account's survives, not even a draft.
  if (!same) forgetAccount();
  // A new role is a change of access: the bar's text goes, and People & invites is for owners.
  else if (before && before.role !== next.role) {
    emptyBar();
    if (state.route.page === 'organization' && next.role !== 'owner') goHome();
  }
  lastAccount = { authority: next.authority, membership_id: next.membership_id };
  if (!same || !wasSignedIn) void loadProjects();
}

/** Nothing of an account's stays on screen or in memory, not even a draft. */
function forgetAccount(): void {
  lastAccount = null;
  emptyBar();
  set({ route: { page: 'home' }, feed: null, roster: null, reader: null, ask: null, sources: null, sheet: null, toast: null,
    barScope: { kind: 'global' }, projects: { items: [], next: null, loading: false }, organization: null, employeeWrite: null });
  setCompose(null);
  setChange(null);
}

export async function signIn(authorityUrl: string): Promise<void> {
  set({ signin: { phase: 'waiting', form: state.signin.form } });
  await afterSignIn(await rpc('signin.begin', { authority_url: authorityUrl }));
}

/** Open invitation…: the folder the owner sent, chosen in main's dialog. The page gets a handle, never the path. */
async function openInvitation(): Promise<void> {
  const chosen = await rpc('dialog.openInvitation', {});
  if (state.status?.signed_in || state.signin.phase === 'waiting') return;
  if (!chosen.ok) { set({ signin: { phase: 'failed', form: false, failure: chosen.failure } }); return; }
  if (!chosen.value) return;
  set({ signin: { phase: 'waiting', form: false } });
  await afterSignIn(await rpc('signin.invitation', { invitation_handle: chosen.value.handle }));
}

async function afterSignIn(result: Result<AppStatus>): Promise<void> {
  if (!result.ok) { set({ signin: { phase: 'failed', form: state.signin.form, failure: result.failure } }); return; }
  set({ signin: { phase: 'idle', form: false } });
  await refreshStatus();
}

/** Escape or Cancel on the organization address: back to "Sign in to use ECHO". */
export function closeSigninForm(): void {
  if (state.signin.phase !== 'waiting') set({ signin: { phase: 'idle', form: false } });
}

// ---- the Account menu --------------------------------------------------------

/** The menu is native, in main: the page says where to pop it up. */
export function showAccountMenu(anchor: HTMLElement, placement: 'row' | 'below'): void {
  const box = anchor.getBoundingClientRect();
  const x = placement === 'row' ? box.left + 16 : box.left;
  const y = placement === 'row' ? box.top + 8 : box.bottom + 4;
  void rpc('menu.account', { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) });
}

/** An Account menu item, chosen in the window or the tray. */
export function accountCommand(command: AccountCommand): void {
  const signedIn = state.status?.signed_in === true;
  if (command === 'signin' || command === 'invitation') {
    if (signedIn || state.signin.phase === 'waiting') return;
    if (command === 'signin') set({ signin: { phase: 'idle', form: true } });
    else void openInvitation();
    return;
  }
  // A sign-out already under way is not interrupted, nor a sheet with work on its way.
  if (!signedIn || signingOut() || sheetHeld()) return;
  if (state.sheet?.kind === 'new-project') finishNewProject(state.sheet);
  if (command === 'tools') void loadTools();
  else set({ sheet: { kind: command, busy: false } });
}

function signingOut(): boolean {
  const sheet = state.sheet;
  return (sheet?.kind === 'signout' || sheet?.kind === 'switch') && sheet.busy;
}

/** A sheet that must stay up: a change in it is on its way, or New project has work it would lose. */
function sheetHeld(): boolean {
  const sheet = state.sheet;
  if (sheet?.kind === 'people') return memberChangeSending();
  if (sheet?.kind === 'new-project') return newProjectBusy(sheet) || newProjectUnsettled(sheet);
  return false;
}

export function closeSheet(): void {
  const sheet = state.sheet;
  if (!sheet || signingOut()) return;
  if (sheet.kind === 'new-project') { closeNewProject(); return; }
  if (sheet.kind === 'people' && memberChangeSending()) return;
  set({ sheet: null });
}

/** Opens Connected tools, or reads it again (Try again). A reply for a sheet since closed is dropped. */
export async function loadTools(): Promise<void> {
  const account = expect();
  if (!account) return;
  const mine = ++seq;
  set({ sheet: { kind: 'tools', seq: mine, loading: true } });
  const result = await rpc('account.tools', { expect: account });
  if (state.sheet?.kind !== 'tools' || state.sheet.seq !== mine) return;
  if (!result.ok) {
    set({ sheet: { kind: 'tools', seq: mine, loading: false, failure: result.failure } });
    accountLost(result.failure);
    return;
  }
  set({ sheet: { kind: 'tools', seq: mine, loading: false, tools: result.value.tools } });
}

/**
 * A save or a project change on its way, or one whose outcome is unknown:
 * signing out now would lose whether it arrived, and the request a retry must
 * resend. Check or Try again settles it; Start over or Dismiss gives it up.
 */
export function signOutHeld(): boolean {
  const status = state.compose?.status;
  const sheet = state.sheet;
  return status === 'sending' || status === 'checking' || status === 'unknown' || state.change?.status === 'sending' ||
    state.change?.status === 'unknown' || (sheet?.kind === 'new-project' && newProjectBusy(sheet)) || state.employeeWrite !== null;
}

/** Sign out, or Switch account, after the person confirmed it. */
export async function signOut(): Promise<void> {
  const account = expect();
  const sheet = state.sheet;
  if (!account || !sheet || (sheet.kind !== 'signout' && sheet.kind !== 'switch') || sheet.busy || signOutHeld()) return;
  const busy: SignOutSheet = { ...sheet, busy: true, failure: undefined };
  set({ sheet: busy });
  const result = await rpc('account.signOut', { expect: account });
  if (!result.ok) {
    if (state.sheet?.kind === sheet.kind) set({ sheet: { ...sheet, busy: false, failure: result.failure } });
    accountLost(result.failure);
    return;
  }
  // The account is forgotten even if a status read already showed sign-in
  // and closed the sheet (the window came forward while the Authority ended
  // the session). A sign-in may have begun since: then this reply is stale,
  // so that sign-in is left alone and who is signed in is read again.
  const stale = state.sheet !== busy;
  forgetAccount();
  if (stale) { await refreshStatus(); return; }
  applyStatus(result.value);
  // Switch account goes straight on to the next organization's address.
  set({ signin: { phase: 'idle', form: sheet.kind === 'switch' } });
}

/** The host gave up after repeated exits. */
export function hostFailed(): void { set({ startFailed: true, booting: false }); }

export async function retryStart(): Promise<void> {
  set({ booting: true });
  await rpc('app.retryHost', {});
  await refreshStatus();
}

export function signinPhase(browserOpened: boolean | undefined): void {
  if (state.signin.phase === 'waiting') set({ signin: { ...state.signin, browserOpened } });
}

// ---- home and projects -------------------------------------------------------

/** The first page again, or the next page appended (More projects). */
export async function loadProjects(more = false): Promise<void> {
  const account = expect();
  if (!account || (more && !state.projects.next)) return;
  const cursor = more ? state.projects.next ?? undefined : undefined;
  set({ projects: { ...state.projects, loading: true, failure: undefined } });
  const result = await rpc('projects.list', { expect: account, ...(cursor ? { cursor } : {}) });
  if (!result.ok) {
    accountLost(result.failure);
    set({ projects: { ...state.projects, loading: false, failure: result.failure } });
    return;
  }
  if (rolesChanged(result.value.items)) emptyBar();
  const seen = new Set(more ? state.projects.items.map(project => project.project_id) : []);
  const items = [...(more ? state.projects.items : []), ...result.value.items.filter(project => !seen.has(project.project_id))];
  set({ projects: { items, next: result.value.next_cursor, loading: false } });
}

/** A project you were lead of is now one you are a member of, or the other way: a change of access. */
function rolesChanged(fresh: readonly ProjectSummary[]): boolean {
  const known = new Map(state.projects.items.map(project => [project.project_id, project.role]));
  return fresh.some(project => known.has(project.project_id) && known.get(project.project_id) !== project.role);
}

/** Back to Home as it was left: the same pages, the same scroll. The bar searches all context. */
export function goHome(): void {
  readSeq += 1;
  set({ route: { page: 'home' }, feed: null, roster: null, reader: null, ask: null, sources: null, barScope: { kind: 'global' }, toast: null,
    organization: null });
  syncSearch();
}

/**
 * The window came forward on Home: re-read the first page and keep the pages
 * loaded after it, so More projects is not lost.
 */
export async function refreshHome(): Promise<void> {
  const account = expect();
  if (!account || state.route.page !== 'home' || state.projects.loading) return;
  const result = await rpc('projects.list', { expect: account });
  if (!result.ok) { accountLost(result.failure); return; }
  if (state.route.page !== 'home') return;
  const first = result.value.items;
  if (rolesChanged(first)) emptyBar();
  const seen = new Set(first.map(project => project.project_id));
  const loadedMore = state.projects.items.length > first.length;
  const later = loadedMore ? state.projects.items.slice(first.length).filter(project => !seen.has(project.project_id)) : [];
  set({ projects: { items: [...first, ...later], next: loadedMore ? state.projects.next : result.value.next_cursor, loading: false } });
}

/** Opens a project, from Home or the sidebar: the bar's scope narrows to it, and its text stays. */
export async function openProject(project: ProjectSummary): Promise<void> {
  if (!expect()) return;
  readSeq += 1;
  set({
    route: { page: 'project', project }, reader: null, ask: null, sources: null, toast: null, organization: null,
    barScope: { kind: 'project', project_id: project.project_id },
    feed: { projectId: project.project_id, opened: ++seq, notes: [], notesNext: null, documents: [], documentsNext: null, unread: [], loading: true },
  });
  syncSearch();
  void loadRoster(project.project_id);
  await loadFeed(project.project_id);
}

/**
 * A project's first page of notes and of documents, read side by side. A
 * list read leads with its first page and keeps the older rows More loaded;
 * a list that could not be read keeps what it showed. Opening the project,
 * or Try again, says why a list could not be read, and the other still
 * shows. A read the person did not ask for (quiet) fails quietly, unless
 * the account is gone.
 */
async function loadFeed(projectId: string, sources: readonly FeedSource[] = ['notes', 'documents'], quiet = false): Promise<void> {
  const account = expect();
  if (!account) return;
  const [notes, documents] = await Promise.all([
    sources.includes('notes') ? rpc('projects.feed', { expect: account, project_id: projectId }) : null,
    sources.includes('documents') ? rpc('documents.list', { expect: account, project_id: projectId }) : null,
  ]);
  const current = state.feed;
  if (current?.projectId !== projectId) return; // moved on
  const failure = notes && !notes.ok ? notes.failure : documents && !documents.ok ? documents.failure : undefined;
  // A list stays unread until a read of it succeeds; a quiet read never makes one unread.
  const unread = (['notes', 'documents'] as const).filter(source => {
    const read = source === 'notes' ? notes : documents;
    return read === null || (!read.ok && quiet) ? current.unread.includes(source) : !read.ok;
  });
  const noteRows = notes?.ok
    ? reread({ items: current.notes, next: current.notesNext }, { items: notes.value.items, next: notes.value.next_cursor }, item => item.context_id) : null;
  const documentRows = documents?.ok
    ? reread({ items: current.documents, next: current.documentsNext }, { items: documents.value.items, next: documents.value.next_cursor },
      item => item.document_id) : null;
  set({ feed: {
    ...current, unread, loading: quiet ? current.loading : false,
    failure: !quiet ? failure : !failure && unread.length === 0 ? undefined : current.failure,
    ...(noteRows ? { notes: noteRows.items, notesNext: noteRows.next } : {}),
    ...(documentRows ? { documents: documentRows.items, documentsNext: documentRows.next } : {}),
  } });
  if (failure && (!quiet || ACCOUNT_GONE.includes(failure.code))) accountLost(failure);
}

/** Try again: the lists whose first page could not be read. */
export async function retryFeed(): Promise<void> {
  const feed = state.feed;
  if (!feed || feed.loading || feed.unread.length === 0) return;
  set({ feed: { ...feed, loading: true } });
  await loadFeed(feed.projectId, feed.unread);
}

/** More: the next page of whichever list stops the feed from going further back. */
export async function moreFeed(): Promise<void> {
  const account = expect();
  const feed = state.feed;
  if (!account || !feed || feed.loading) return;
  const sources = moreSources(feed);
  if (sources.length === 0) return;
  // A list that could not be read still says why.
  set({ feed: { ...feed, loading: true, failure: feed.unread.length > 0 ? feed.failure : undefined } });
  const [notes, documents] = await Promise.all([
    sources.includes('notes') && feed.notesNext ? rpc('projects.feed', { expect: account, project_id: feed.projectId, cursor: feed.notesNext }) : null,
    sources.includes('documents') && feed.documentsNext
      ? rpc('documents.list', { expect: account, project_id: feed.projectId, cursor: feed.documentsNext }) : null,
  ]);
  const current = state.feed;
  if (current?.projectId !== feed.projectId) return;
  const failure = notes && !notes.ok ? notes.failure : documents && !documents.ok ? documents.failure : undefined;
  const seenNotes = new Set(current.notes.map(item => item.context_id));
  const seenDocuments = new Set(current.documents.map(item => item.document_id));
  set({ feed: {
    ...current, loading: false, ...(failure ? { failure } : {}),
    ...(notes?.ok ? { notes: [...current.notes, ...notes.value.items.filter(item => !seenNotes.has(item.context_id))], notesNext: notes.value.next_cursor } : {}),
    ...(documents?.ok ? {
      documents: [...current.documents, ...documents.value.items.filter(item => !seenDocuments.has(item.document_id))],
      documentsNext: documents.value.next_cursor,
    } : {}),
  } });
  if (failure) accountLost(failure);
}

/** Something landed in or left the project on screen: its first pages again, and what shows stays. */
async function refreshFeed(projectId: string): Promise<void> {
  if (state.feed?.projectId !== projectId) return;
  await loadFeed(projectId, ['notes', 'documents'], true);
}

/** A project's members, the first page or the next one (More, in People). */
async function loadRoster(projectId: string, more = false): Promise<void> {
  const account = expect();
  const roster = state.roster?.projectId === projectId ? state.roster : null;
  if (!account || (more && !roster?.next)) return;
  const cursor = more ? roster?.next ?? undefined : undefined;
  set({ roster: { projectId, items: more ? roster!.items : roster?.items ?? [], next: roster?.next ?? null, loading: true } });
  const result = await rpc('projects.members', { expect: account, project_id: projectId, ...(cursor ? { cursor } : {}) });
  const current = state.roster;
  if (current?.projectId !== projectId) return;
  if (!result.ok) {
    set({ roster: { ...current, loading: false, failure: result.failure } });
    accountLost(result.failure);
    return;
  }
  const seen = new Set(more ? current.items.map(person => person.membership_id) : []);
  const items = [...(more ? current.items : []), ...result.value.items.filter(person => !seen.has(person.membership_id))];
  set({ roster: { projectId, items, next: result.value.next_cursor, loading: false } });
}

export function moreMembers(): void {
  if (state.roster) void loadRoster(state.roster.projectId, true);
}

export function openItem(item: FeedItem): Promise<void> {
  const route = state.route;
  if (route.page !== 'project') return Promise.resolve();
  return read(item.context_id, { kind: 'project', project_id: route.project.project_id });
}

/** A document in a project's feed: read with that project, a page of its text at a time. */
export function openDocument(item: DocumentSummary): Promise<void> {
  const route = state.route;
  return readDocument(item.document_id, route.page === 'project' ? route.project.project_id : null);
}

/** A live match, read in place: the page stays, and Back returns to the matches. */
export function openMatch(match: Match): Promise<void> {
  const scope = state.matches?.scope;
  if (match.source !== 'project') return read(match.context_id, { kind: 'note', source: match.source });
  if (scope?.kind !== 'project') return Promise.resolve();
  return read(match.context_id, { kind: 'project', project_id: scope.project_id });
}

/** The read on screen; a reply for one since closed or replaced is dropped. */
let readSeq = 0;

async function read(contextId: string, from: ReaderState['from']): Promise<void> {
  const account = expect();
  if (!account || from.kind === 'document') return;
  const mine = ++readSeq;
  set({ reader: { id: contextId, from, loading: true, menu: 'closed' }, toast: null });
  const result = from.kind === 'project'
    ? await rpc('projects.readContext', { expect: account, project_id: from.project_id, context_id: contextId })
    : await rpc('search.read', { expect: account, context_id: contextId, source: from.source });
  if (state.reader?.id !== contextId || readSeq !== mine) return;
  if (!result.ok) {
    set({ reader: { id: contextId, from, loading: false, menu: 'closed', failure: result.failure } });
    accountLost(result.failure);
    return;
  }
  set({ reader: { id: contextId, from, loading: false, menu: 'closed', content: result.value } });
}

/**
 * A document and one page of its text: the first, or the page a cursor
 * names (Next text page). While the next page loads, the one shown stays.
 */
async function readDocument(documentId: string, projectId: string | null, cursor?: string): Promise<void> {
  const account = expect();
  if (!account) return;
  const mine = ++readSeq;
  const from: ReaderFrom = { kind: 'document', project_id: projectId };
  const shown = state.reader?.id === documentId ? state.reader.document : undefined;
  set({ reader: { id: documentId, from, loading: true, menu: 'closed', ...(shown ? { document: shown } : {}) }, toast: null });
  const result = await rpc('documents.read', {
    expect: account, document_id: documentId, ...(projectId ? { project_id: projectId } : {}), ...(cursor ? { cursor } : {}),
  });
  if (state.reader?.id !== documentId || readSeq !== mine) return;
  if (!result.ok) {
    set({ reader: { id: documentId, from, loading: false, menu: 'closed', failure: result.failure, ...(shown ? { document: shown } : {}) } });
    accountLost(result.failure);
    return;
  }
  set({ reader: { id: documentId, from, loading: false, menu: 'closed', document: result.value } });
}

/** Next text page, from the ⋯ menu. */
export function nextTextPage(): void {
  const reader = state.reader;
  const next = reader?.document?.next_cursor;
  if (reader?.from.kind !== 'document' || !next || reader.loading) return;
  void readDocument(reader.id, reader.from.project_id, next);
}

/** Refresh document: its metadata and first text page again, as text extraction may have moved on. */
export function refreshDocument(): void {
  const reader = state.reader;
  if (reader?.from.kind !== 'document' || reader.loading) return;
  void readDocument(reader.id, reader.from.project_id);
}

/**
 * Save original…: main asks where, and hands the page a handle for it, never
 * the path. The client writes the file only once it matches the original.
 */
export async function saveOriginal(): Promise<void> {
  const account = expect();
  const reader = state.reader;
  const document = reader?.document?.document;
  if (!account || reader?.from.kind !== 'document' || !document || reader.save?.status === 'saving') return;
  const projectId = reader.from.project_id;
  set({ reader: { ...reader, menu: 'closed', save: undefined } });
  const chosen = await rpc('dialog.saveDocument', { name: document.filename });
  const stillHere = () => state.reader?.id === document.document_id ? state.reader : null;
  if (!stillHere()) return;
  if (!chosen.ok) { set({ reader: { ...stillHere()!, save: { status: 'failed', failure: chosen.failure } } }); return; }
  if (!chosen.value) return; // cancelled
  set({ reader: { ...stillHere()!, save: { status: 'saving' } } });
  const result = await rpc('documents.save', {
    expect: account, document_id: document.document_id, ...(projectId ? { project_id: projectId } : {}), save_handle: chosen.value.handle,
  });
  const current = stillHere();
  if (!current) return;
  set({ reader: { ...current, save: result.ok ? { status: 'saved' } : { status: 'failed', failure: result.failure } } });
  if (!result.ok) accountLost(result.failure);
}

export function closeReader(): void { readSeq += 1; set({ reader: null }); }

/** The reader's ⋯: open or closed. */
export function toggleReaderMenu(): void {
  const reader = state.reader;
  if (reader) set({ reader: { ...reader, menu: reader.menu === 'closed' ? 'open' : 'closed' } });
}

/** Add to project: the projects to choose from. */
export function showProjectChoices(): void {
  const reader = state.reader;
  if (reader) set({ reader: { ...reader, menu: 'projects' } });
}

/** The projects an original can be added to: yours, less the ones it is already filed in that the page knows of. */
export function projectChoices(current: State = state): ProjectSummary[] {
  const reader = current.reader;
  if (!reader) return [];
  const filed = new Set(reader.document?.document.project_ids ?? []);
  if (reader.from.kind === 'project') filed.add(reader.from.project_id);
  if (reader.from.kind === 'document' && reader.from.project_id) filed.add(reader.from.project_id);
  return current.projects.items.filter(project => !filed.has(project.project_id));
}

/** What the reader shows can leave the project it was opened in. */
export function removableFrom(current: State = state): ProjectSummary | null {
  const { reader, route } = current;
  if (!reader || route.page !== 'project') return null;
  const projectId = reader.from.kind === 'project' || reader.from.kind === 'document' ? reader.from.project_id : null;
  return projectId === route.project.project_id ? route.project : null;
}

/** Remove from this project: the original stays, and so does who can read it. */
export function removeFromProject(): void {
  const reader = state.reader;
  const project = removableFrom();
  if (!reader || !project || (reader.from.kind === 'document' && !reader.document)) return;
  set({ reader: { ...reader, menu: 'closed' } });
  void sendChange(reader.from.kind === 'document'
    ? { kind: 'document-dissociate', project_id: project.project_id, document_id: reader.id }
    : { kind: 'dissociate', project_id: project.project_id, context_id: reader.id }, { project, origin: 'reader' });
}

/** Add to project: filed there too; who can read it does not change. */
export function addToProject(project: ProjectSummary): void {
  const reader = state.reader;
  if (!reader || (reader.from.kind === 'document' && !reader.document) || (reader.from.kind !== 'document' && !reader.content)) return;
  set({ reader: { ...reader, menu: 'closed' } });
  void sendChange(reader.from.kind === 'document'
    ? { kind: 'document-associate', project_id: project.project_id, document_id: reader.id }
    : { kind: 'associate', project_id: project.project_id, context_id: reader.id }, { project, origin: 'reader' });
}

// ---- project changes -----------------------------------------------------------

function setChange(change: ChangeState | null): void {
  set({ change });
  unresolvedChanged();
}

/** A change on its way, or one whose outcome is unknown: no other starts until it is settled. */
export function changeBlocked(current: State = state): boolean {
  const status = current.change?.status;
  return status === 'sending' || status === 'unknown';
}

/** A change to who is in a project, on its way: People stays up until it is answered. */
function memberChangeSending(): boolean {
  return state.change?.status === 'sending' && state.change.origin === 'people';
}

/** Sends one project change. Only the Authority's receipt says it was made. */
async function sendChange(
  change: ProjectChange, context: Pick<ChangeState, 'project' | 'origin' | 'person' | 'created'>, requestId: string = crypto.randomUUID(),
): Promise<void> {
  const account = expect();
  const retrying = state.change?.requestId === requestId;
  if (!account || (!retrying && changeBlocked())) return;
  const mine = ++seq;
  const { project, origin, person, created } = context;
  setChange({
    seq: mine, requestId, change, project, origin, ...(person ? { person } : {}), ...(created === undefined ? {} : { created }),
    status: 'sending', confirmDismiss: false,
  });
  const result = await rpc('projects.change', { expect: account, request_id: requestId, change });
  const current = state.change;
  if (current?.seq !== mine) return;
  if (!result.ok) {
    // Only the Authority's answer settles an unknown change: a failed resend leaves it unknown.
    const unknown = retrying || result.failure.mutation_outcome === 'unknown';
    setChange({ ...current, status: unknown ? 'unknown' : 'failed', failure: result.failure });
    accountLost(result.failure);
    return;
  }
  setChange(null);
  changed(current);
}

/** Try again: exactly the same change, under the same request id. */
export function retryChange(): void {
  const change = state.change;
  if (change?.status !== 'unknown') return;
  void sendChange(change.change, change, change.requestId);
}

/** Dismiss: asked once, since it may have been made; then forgotten. A refused change just goes. */
export function dismissChange(): void {
  const change = state.change;
  if (!change || change.status === 'sending') return;
  if (change.status === 'unknown' && !change.confirmDismiss) { setChange({ ...change, confirmDismiss: true }); return; }
  setChange(null);
}

export function keepChange(): void {
  if (state.change) setChange({ ...state.change, confirmDismiss: false });
}

/** A change was made: what it changed is read again, where it shows. */
function changed(done: ChangeState): void {
  const { change, project } = done;
  const reader = state.reader;
  switch (change.kind) {
    case 'member-add':
    case 'member-set':
    case 'member-remove': {
      const sheet = peopleSheet();
      // Only this add is offered back; any other change ends the last one's Undo.
      if (sheet && sheet.project.project_id === project.project_id) {
        const added = change.kind === 'member-add' && done.person
          ? { requestId: done.requestId, person: done.person, created: done.created === true } : null;
        set({ sheet: { ...sheet, added } });
      }
      if (state.roster?.projectId === project.project_id) void loadRoster(project.project_id);
      return;
    }
    case 'dissociate':
    case 'document-dissociate': {
      const id = 'context_id' in change ? change.context_id : change.document_id;
      if (reader?.id === id) closeReader();
      // It left the project: it goes from the rows shown, older ones More loaded included.
      const feed = state.feed;
      if (feed?.projectId === project.project_id) {
        set({ feed: { ...feed, notes: feed.notes.filter(item => item.context_id !== id), documents: feed.documents.filter(item => item.document_id !== id) } });
      }
      set({ toast: `Removed from ${project.name}` });
      void refreshFeed(project.project_id);
      return;
    }
    case 'associate':
    case 'document-associate': {
      const id = 'context_id' in change ? change.context_id : change.document_id;
      // Still reading it: the project it went to opens, and shows it.
      if (reader?.id === id) void openProject(project);
      else void refreshFeed(project.project_id);
      set({ toast: `Added to ${project.name}` });
      return;
    }
  }
}

// ---- people ----------------------------------------------------------------------

/** A sheet that finds people for a project: People, or New project once its project exists. */
export type FindingSheet = PeopleSheet | (NewProjectSheet & { project: ProjectSummary });

export function findingSheet(current: State = state): FindingSheet | null {
  const sheet = current.sheet;
  return sheet?.kind === 'people' || (sheet?.kind === 'new-project' && sheet.project) ? sheet as FindingSheet : null;
}

function peopleSheet(mine?: number): FindingSheet | null {
  const sheet = findingSheet();
  return sheet && (mine === undefined || sheet.seq === mine) ? sheet : null;
}

function setPeople(patch: Partial<Finding> & Partial<Pick<PeopleSheet, 'project' | 'failure'>>, mine?: number): void {
  const sheet = peopleSheet(mine);
  if (sheet) set({ sheet: { ...sheet, ...patch } as Sheet });
}

/** A lead can change who is in the project, while no other change is unsettled. */
export function canManage(current: State = state): boolean {
  const sheet = findingSheet(current);
  return sheet !== null && sheet.project.role === 'lead' && !changeBlocked(current);
}

/**
 * The stack of members opens People: the project and its members are read
 * again, and for a lead the directory's first people.
 */
export async function openPeople(): Promise<void> {
  const account = expect();
  const route = state.route;
  if (!account || route.page !== 'project' || state.sheet || state.concealed) return;
  const mine = ++seq;
  set({ sheet: { kind: 'people', seq: mine, project: route.project, query: '', directory: null, menu: null, confirm: null, added: null } });
  void loadRoster(route.project.project_id);
  const result = await rpc('projects.read', { expect: account, project_id: route.project.project_id });
  if (!peopleSheet(mine)) return;
  if (!result.ok) {
    setPeople({ failure: result.failure }, mine);
    accountLost(result.failure);
    return;
  }
  roleRead(result.value);
  setPeople({ project: result.value, failure: undefined }, mine);
  if (result.value.role === 'lead') void findPeople();
}

/** A project read again. A new role for you in it is a change of access: the bar's text goes. */
function roleRead(project: ProjectSummary): void {
  const known = state.projects.items.find(item => item.project_id === project.project_id);
  const shown = state.route.page === 'project' && state.route.project.project_id === project.project_id ? state.route.project : null;
  if ((known && known.role !== project.role) || (shown && shown.role !== project.role)) emptyBar();
  set({
    projects: { ...state.projects, items: state.projects.items.map(item => item.project_id === project.project_id ? { ...item, role: project.role } : item) },
    ...(shown ? { route: { page: 'project' as const, project: { ...shown, role: project.role } } } : {}),
  });
}

/** Typing a name finds people once it pauses. */
let peopleTimer: ReturnType<typeof setTimeout> | undefined;

export function setPeopleQuery(query: string): void {
  if (!peopleSheet()) return;
  setPeople({ query });
  clearTimeout(peopleTimer);
  peopleTimer = setTimeout(() => void findPeople(), SEARCH_PAUSE_MS);
}

/** The directory's people for the name typed (all, with none), or the next page of them (More people). */
export async function findPeople(more = false): Promise<void> {
  clearTimeout(peopleTimer);
  const account = expect();
  const sheet = peopleSheet();
  if (!account || !sheet || sheet.project.role !== 'lead') return;
  const cursor = more ? sheet.directory?.next : undefined;
  if (more && !cursor) return;
  const query = askText(sheet.query);
  const mine = ++seq;
  const shown = more ? sheet.directory?.items ?? [] : [];
  // A new search ends the last add's Undo.
  setPeople({ directory: { seq: mine, items: shown, next: sheet.directory?.next ?? null, loading: true }, ...(more ? {} : { added: null }) });
  const result = await rpc('projects.directory', {
    expect: account, project_id: sheet.project.project_id, ...(query ? { query } : {}), ...(cursor ? { cursor } : {}),
  });
  const current = peopleSheet(sheet.seq);
  if (!current || current.directory?.seq !== mine) return;
  if (!result.ok) {
    setPeople({ directory: { seq: mine, items: shown, next: null, loading: false, failure: result.failure } });
    accountLost(result.failure);
    return;
  }
  const seen = new Set(shown.map(person => person.membership_id));
  setPeople({ directory: {
    seq: mine, items: [...shown, ...result.value.items.filter(person => !seen.has(person.membership_id))], next: result.value.next_cursor, loading: false,
  } });
}

/** The people found who are not members already: adding one can never change a member's role. */
export function candidates(current: State = state): readonly Member[] {
  const sheet = findingSheet(current);
  if (!sheet?.directory) return [];
  const members = new Set(current.roster?.projectId === sheet.project.project_id ? current.roster.items.map(person => person.membership_id) : []);
  return sheet.directory.items.filter(person => !members.has(person.membership_id));
}

/** Add: at once, and offered back as Undo once the Authority has it. */
export function addPerson(person: Member): void {
  const sheet = peopleSheet();
  if (!sheet || !canManage()) return;
  const roster = state.roster;
  // The whole list was read, and did not have them: this add makes them a member.
  const created = roster?.projectId === sheet.project.project_id && roster.next === null && roster.items.length > 0 && !roster.loading;
  setPeople({ added: null, menu: null });
  void sendChange({ kind: 'member-add', project_id: sheet.project.project_id, membership_id: person.membership_id },
    { project: sheet.project, origin: 'people', person, created });
}

/**
 * Undo removes only the person that add added. With the member list not read
 * to the end they may have been a member before, so it is asked first.
 */
export function undoAdd(): void {
  const sheet = peopleSheet();
  const added = sheet?.added;
  if (!sheet || !added || !canManage()) return;
  if (!added.created) { setPeople({ confirm: { action: 'remove', person: added.person }, menu: null }); return; }
  setPeople({ added: null });
  void sendChange({ kind: 'member-remove', project_id: sheet.project.project_id, membership_id: added.person.membership_id },
    { project: sheet.project, origin: 'people', person: added.person });
}

/** A member's ⋯. */
export function toggleMemberMenu(membershipId: string): void {
  const sheet = peopleSheet();
  if (sheet) setPeople({ menu: sheet.menu === membershipId ? null : membershipId });
}

/** Make lead, Make member or Remove from project: asked first. */
export function askMemberChange(action: 'lead' | 'member' | 'remove', person: Member): void {
  if (peopleSheet() && canManage()) setPeople({ confirm: { action, person }, menu: null });
}

export function cancelMemberChange(): void { setPeople({ confirm: null }); }

/** The person confirmed it: the change goes, for the project People shows. */
export function confirmMemberChange(): void {
  const sheet = peopleSheet();
  const confirm = sheet?.confirm;
  if (!sheet || !confirm || !canManage()) return;
  const { person } = confirm;
  const project_id = sheet.project.project_id;
  setPeople({ confirm: null, added: null });
  void sendChange(confirm.action === 'remove'
    ? { kind: 'member-remove', project_id, membership_id: person.membership_id }
    : { kind: 'member-set', project_id, membership_id: person.membership_id, role: confirm.action },
  { project: sheet.project, origin: 'people', person });
}

// ---- new project -----------------------------------------------------------------

/** New project takes up to 20 files, as the Swift app did. */
export const MAX_PROJECT_FILES = 20;
const TOO_MANY_FILES = 'Add up to 20 files.';
/** Said when New project closes with files that may not have been saved. */
export const UNSAVED_FILES = 'Some files may not have been saved.';

let fileIds = 0;

function newProjectSheet(mine?: number): NewProjectSheet | null {
  const sheet = state.sheet;
  return sheet?.kind === 'new-project' && (mine === undefined || sheet.seq === mine) ? sheet : null;
}

function setNewProject(patch: Partial<NewProjectSheet>, mine?: number): void {
  const sheet = newProjectSheet(mine);
  if (!sheet) return;
  set({ sheet: { ...sheet, ...patch } });
  unresolvedChanged();
}

/** Something in New project is on its way: the create, the read of what it made, a file, or an add. */
export function newProjectBusy(sheet: NewProjectSheet): boolean {
  return sheet.create.status === 'sending' || sheet.opening || memberChangeSending() ||
    sheet.files.some(file => file.status === 'saving' || file.status === 'checking');
}

/** A project's name as the API takes it: one line, trimmed, NFC, at most 200 UTF-8 bytes. */
export function projectName(text: string): string | null {
  const name = text.normalize('NFC').trim();
  return name === '' || new TextEncoder().encode(name).length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(name) ? null : name;
}

/** The sidebar's New project, and Home's when there are no projects. */
export function openNewProject(): void {
  if (!expect() || state.sheet || state.concealed || (state.compose && !state.compose.hidden)) return;
  set({
    toast: null,
    sheet: {
      kind: 'new-project', seq: ++seq, name: '', create: { requestId: crypto.randomUUID(), name: '', status: 'editing' }, confirmClose: false,
      project: null, createdId: null, opening: false, files: [], skip: null, query: '', directory: null, menu: null, confirm: null, added: null,
    },
  });
}

/** Typing the name. A different name is a different request; while a create is on its way or unknown it cannot change. */
export function setNewProjectName(name: string): void {
  const sheet = newProjectSheet();
  if (!sheet || sheet.project || sheet.createdId || sheet.create.status === 'sending' || sheet.create.status === 'unknown') return;
  setNewProject({ name, notice: undefined, create: { requestId: crypto.randomUUID(), name: '', status: 'editing' } });
}

/**
 * Create, or Try again on one whose outcome is unknown: the same request,
 * with the same name. Only the Authority's receipt says it was made; then
 * the project is read and opens behind the sheet. Made but not read, the
 * button reads it again (Open): it never creates twice.
 */
export async function createProject(): Promise<void> {
  const account = expect();
  const sheet = newProjectSheet();
  if (!account || !sheet || sheet.project) return;
  if (sheet.createdId) { await openCreated(); return; }
  const { create } = sheet;
  if (create.status === 'sending' || create.status === 'created') return;
  const retrying = create.status === 'unknown';
  const name = retrying ? create.name : projectName(sheet.name);
  if (!name) return;
  const mine = sheet.seq;
  setNewProject({ create: { ...create, name, status: 'sending', failure: undefined }, confirmClose: false, notice: undefined }, mine);
  const result = await rpc('projects.create', { expect: account, request_id: create.requestId, name });
  const current = newProjectSheet(mine);
  if (!current) return;
  if (!result.ok) {
    // Only the Authority's answer settles an unknown create: a failed resend leaves it unknown.
    const unknown = retrying || result.failure.mutation_outcome === 'unknown';
    setNewProject({ create: { ...current.create, status: unknown ? 'unknown' : 'failed', failure: result.failure } }, mine);
    accountLost(result.failure);
    return;
  }
  setNewProject({ create: { ...current.create, status: 'created' }, createdId: result.value.project_id }, mine);
  await openCreated();
}

/** The project Create made, read: it joins your projects, opens behind the sheet, and takes people and files. */
async function openCreated(): Promise<void> {
  const account = expect();
  const sheet = newProjectSheet();
  if (!account || !sheet?.createdId || sheet.project || sheet.opening) return;
  const mine = sheet.seq;
  setNewProject({ opening: true, openFailure: undefined }, mine);
  const result = await rpc('projects.read', { expect: account, project_id: sheet.createdId });
  if (!newProjectSheet(mine)) return;
  if (!result.ok) {
    setNewProject({ opening: false, openFailure: result.failure }, mine);
    accountLost(result.failure);
    return;
  }
  const project = result.value;
  if (!state.projects.items.some(item => item.project_id === project.project_id)) {
    set({ projects: { ...state.projects, items: [project, ...state.projects.items] } });
  }
  setNewProject({ opening: false, project }, mine);
  void openProject(project);
  if (project.role === 'lead') void findPeople();
  pumpFiles();
}

/** The create, or a file, may have arrived and nothing says yet whether it did. */
export function newProjectUnsettled(sheet: NewProjectSheet): boolean {
  return (!sheet.project && !sheet.createdId && sheet.create.status === 'unknown') || sheet.files.some(file => file.status === 'unknown');
}

/**
 * Close, Cancel or Done. A create or a file whose outcome is unknown is asked
 * about once, as closing gives up its Try again; nothing on its way is cut off.
 */
function closeNewProject(): void {
  const sheet = newProjectSheet();
  if (!sheet || newProjectBusy(sheet)) return;
  if (newProjectUnsettled(sheet) && !sheet.confirmClose) {
    setNewProject({ confirmClose: true });
    return;
  }
  finishNewProject(sheet);
}

/** Keep it: back to the create or the file whose outcome is unknown. */
export function keepNewProject(): void {
  if (newProjectSheet()) setNewProject({ confirmClose: false });
}

/**
 * New project goes. Copies kept to resend a file go too, as nothing can
 * resend them now. If the project was made and some files were not saved
 * into it, or may not have been, the toast says so.
 */
function finishNewProject(sheet: NewProjectSheet): void {
  for (const file of sheet.files) if (file.kept) releaseCopy(file.requestId);
  const made = sheet.create.status === 'created' || sheet.create.status === 'unknown';
  const unsaved = made && sheet.files.some(file => file.status !== 'saved');
  set({ sheet: null, ...(unsaved ? { toast: UNSAVED_FILES } : {}) });
  unresolvedChanged();
  if (sheet.project) void refreshFeed(sheet.project.project_id);
}

function releaseCopy(requestId: string): void {
  const account = expect();
  if (account) void rpc('documents.abandon', { expect: account, request_id: requestId });
}

/** Add files…: main's dialog, several at once. */
export async function chooseFiles(): Promise<void> {
  const sheet = newProjectSheet();
  if (!sheet) return;
  const result = await rpc('dialog.openDocuments', {});
  if (!newProjectSheet(sheet.seq)) return;
  if (!result.ok) { setNewProject({ notice: result.failure.code === 'too_many_files' ? TOO_MANY_FILES : message(result.failure) }, sheet.seq); return; }
  const refused: Failure = { code: 'unsupported_file', retryable: false };
  addFiles(sheet.seq, [...result.value.files.map(handle => ({ name: handle.name, handle })), ...result.value.refused.map(name => ({ name, failure: refused }))]);
}

/** Files dropped on New project. Each is handed to main on its own, which answers with a handle. */
export async function dropFiles(files: readonly File[]): Promise<void> {
  const sheet = newProjectSheet();
  if (!sheet || files.length === 0) return;
  if (sheet.files.length + files.length > MAX_PROJECT_FILES) { setNewProject({ notice: TOO_MANY_FILES }, sheet.seq); return; }
  const chosen: { name: string; handle?: FileHandle; failure?: Failure }[] = [];
  for (const file of files) {
    const result = await dropFile(file);
    chosen.push(result.ok ? { name: result.value.name, handle: result.value } : { name: file.name, failure: result.failure });
  }
  addFiles(sheet.seq, chosen);
}

/** Files join the list and wait their turn; one main refused says why. */
function addFiles(mine: number, chosen: readonly { name: string; handle?: FileHandle; failure?: Failure }[]): void {
  const sheet = newProjectSheet(mine);
  if (!sheet || chosen.length === 0) return;
  if (sheet.files.length + chosen.length > MAX_PROJECT_FILES) { setNewProject({ notice: TOO_MANY_FILES }, mine); return; }
  const added: ProjectFile[] = chosen.map(file => ({
    id: ++fileIds, name: file.name, requestId: crypto.randomUUID(), kept: false,
    ...(file.handle ? { handle: file.handle, status: 'waiting' as const } : { status: 'failed' as const, failure: file.failure }),
  }));
  setNewProject({ files: [...sheet.files, ...added], notice: undefined }, mine);
  pumpFiles();
}

/** A file moves on (Check status, Try again, or its save): a close question asked before it no longer stands. */
function patchFile(mine: number, id: number, patch: Partial<ProjectFile>): void {
  const sheet = newProjectSheet(mine);
  if (sheet) setNewProject({ files: sheet.files.map(file => file.id === id ? { ...file, ...patch } : file), confirmClose: false }, mine);
}

/** One save at a time, into the new project. A file whose outcome is unknown stops the ones after it. */
function pumpFiles(): void {
  const sheet = newProjectSheet();
  if (!sheet?.project || sheet.files.some(file => file.status === 'saving' || file.status === 'checking' || file.status === 'unknown')) return;
  const next = sheet.files.find(file => file.status === 'waiting');
  if (next) void saveFile(sheet.seq, next.id, false);
}

/** Saves a file for the project's members, or resends the copy the client kept of one (Try again). */
async function saveFile(mine: number, id: number, retrying: boolean): Promise<void> {
  const account = expect();
  const sheet = newProjectSheet(mine);
  const file = sheet?.files.find(entry => entry.id === id);
  if (!account || !sheet?.project || !file || (!retrying && !file.handle)) return;
  const project_id = sheet.project.project_id;
  const audience: Audience = { kind: 'project', project_id };
  patchFile(mine, id, { status: 'saving', failure: undefined });
  const result = retrying
    ? await rpc('documents.retry', { expect: account, request_id: file.requestId, audience })
    : await rpc('documents.upload', { expect: account, request_id: file.requestId, file_handle: file.handle!.handle, title: file.name, audience, project_id });
  const current = newProjectSheet(mine)?.files.find(entry => entry.id === id);
  if (!current) return;
  if (!result.ok) {
    // Only the Authority's answer settles an unknown save: a failed resend leaves it unknown.
    const unknown = retrying || result.failure.mutation_outcome === 'unknown';
    patchFile(mine, id, { status: unknown ? 'unknown' : 'failed', failure: result.failure, kept: current.kept || unknown });
    accountLost(result.failure);
    if (!unknown) pumpFiles();
    return;
  }
  patchFile(mine, id, { status: 'saved', kept: false, ...(result.value.extraction ? { extraction: result.value.extraction } : {}) });
  pumpFiles();
}

/** Try again: the same request, from the copy the client kept. */
export function retryFile(id: number): void {
  const sheet = newProjectSheet();
  const file = sheet?.files.find(entry => entry.id === id);
  if (!sheet || !file?.kept || (file.status !== 'unknown' && file.status !== 'failed') || newProjectBusy(sheet)) return;
  void saveFile(sheet.seq, id, true);
}

/** Check status: saved carries on with the rest; never arrived can be sent again. */
export async function checkFile(id: number): Promise<void> {
  const account = expect();
  const sheet = newProjectSheet();
  const file = sheet?.files.find(entry => entry.id === id);
  if (!account || !sheet || file?.status !== 'unknown') return;
  const mine = sheet.seq;
  patchFile(mine, id, { status: 'checking' });
  const result = await rpc('writes.status', { expect: account, request_id: file.requestId, kind: 'document' });
  if (!newProjectSheet(mine)?.files.some(entry => entry.id === id)) return;
  if (result.ok && result.value.state === 'saved') {
    patchFile(mine, id, { status: 'saved', kept: false, failure: undefined, ...(result.value.extraction ? { extraction: result.value.extraction } : {}) });
    pumpFiles();
    return;
  }
  if (result.ok && result.value.state === 'not_saved') {
    // It never arrived: Try again resends it, and the rest carry on meanwhile.
    patchFile(mine, id, { status: 'failed', failure: { code: 'not_saved', retryable: true } });
    pumpFiles();
    return;
  }
  patchFile(mine, id, { status: 'unknown' });
  if (!result.ok) accountLost(result.failure);
}

/** Skip…: asked first, since it may have been saved. */
export function askSkip(id: number): void {
  const sheet = newProjectSheet();
  if (sheet?.files.some(file => file.id === id && file.status === 'unknown')) setNewProject({ skip: id });
}

export function cancelSkip(): void { setNewProject({ skip: null }); }

/** Skip: the file is left as it is, its kept copy goes, and the rest carry on. */
export function confirmSkip(): void {
  const sheet = newProjectSheet();
  const file = sheet?.files.find(entry => entry.id === sheet.skip);
  if (!sheet || !file || file.status !== 'unknown') { cancelSkip(); return; }
  if (file.kept) releaseCopy(file.requestId);
  setNewProject({ skip: null, confirmClose: false,
    files: sheet.files.map(entry => entry.id === file.id ? { ...entry, status: 'skipped', kept: false } : entry) });
  pumpFiles();
}

/** Files can be dropped on New project: one or more, while it is up. */
export function canDropFiles(event: DragEvent): boolean {
  const items = event.dataTransfer?.items;
  return state.status?.signed_in === true && state.sheet?.kind === 'new-project' && items !== undefined && items.length > 0 &&
    [...items].every(item => item.kind === 'file');
}

// ---- people & invites (owners) ---------------------------------------------------

/**
 * What an unknown change may have done, and that only reading the list again
 * settles it. There is no request id to resend it under.
 */
const MAY_HAVE: Record<'invite' | 'reissue' | 'revoke', string> = {
  invite: 'The invitation may already have been issued. Refresh before trying again.',
  reissue: 'A new invitation may already have been issued, and the previous one stopped working. Refresh before trying again.',
  revoke: 'Access may already have been revoked. Refresh before trying again.',
};
const ENTER_BOTH = 'Enter the employee’s name and email address.';

function organization(mine?: number): OrganizationState | null {
  const page = state.organization;
  return page && state.route.page === 'organization' && (mine === undefined || page.seq === mine) ? page : null;
}

function setOrganization(patch: Partial<OrganizationState>, mine?: number): void {
  const page = organization(mine);
  if (page) set({ organization: { ...page, ...patch } });
}

/**
 * The sidebar's People & invites: owners only. The page moves, the bar
 * searches all context. The tray's comes while another app may be in front.
 */
export function openOrganization(fromTray = false): void {
  if (state.status?.account?.role !== 'owner' || (state.concealed && !fromTray)) return;
  readSeq += 1;
  // A change sent on an earlier visit may still be on its way: this visit waits for it too.
  const sending = state.employeeWrite;
  set({
    route: { page: 'organization' }, feed: null, roster: null, reader: null, ask: null, sources: null, toast: null, barScope: { kind: 'global' },
    organization: {
      seq: ++seq, loading: false, items: null, name: '', email: '', menu: null, confirm: null,
      write: sending ? { action: sending.action, status: 'sending' } : null, notice: null, saved: null,
    },
  });
  syncSearch();
  void loadEmployees();
}

/**
 * Organization ▸ People & invites… in the tray. A sheet or Capture that is up
 * stays, as does People & invites already open: the window only comes forward.
 */
export function trayOrganization(): void {
  if (state.sheet || (state.compose && !state.compose.hidden) || state.route.page === 'organization') return;
  openOrganization(true);
}

/** Employee list reads, and employee changes, each counted as they start. */
let employeeReads = 0;
let employeeChanges = 0;

/**
 * The list, read (again): Refresh, coming back to ECHO, and after each change.
 * It settles an unknown change, unless a change began after it was sent: then
 * what it read may predate that change, so it is dropped.
 */
export async function loadEmployees(): Promise<void> {
  const account = expect();
  const page = organization();
  if (!account || !page || state.employeeWrite) return;
  const mine = page.seq;
  const read = ++employeeReads;
  const changes = employeeChanges;
  setOrganization({ loading: true, failure: undefined }, mine);
  const result = await rpc('employees.list', { expect: account });
  // A newer read is on its way, and says what the list is.
  if (read !== employeeReads) return;
  const current = organization(mine);
  if (!current) return;
  if (changes !== employeeChanges) { setOrganization({ loading: false }, mine); return; }
  if (!result.ok) {
    // A list that could not be read is never left showing.
    setOrganization({ loading: false, items: null, failure: result.failure }, mine);
    accountLost(result.failure);
    return;
  }
  const { items } = result.value;
  const settled = current.write?.status === 'unknown';
  // An invitation just saved is offered back only while it still waits to be used.
  const saved = current.saved;
  const waiting = saved !== null && items.some(employee => employee.email === saved.email && employee.membership === 'active' &&
    employee.invitation === 'pending');
  setOrganization({ loading: false, items, write: null, ...(settled ? { notice: null } : {}), ...(waiting ? {} : { saved: null }) }, mine);
}

export function setOrganizationField(field: 'name' | 'email', value: string): void {
  const page = organization();
  if (!page) return;
  // Why the list is not shown stays until the list is read again.
  setOrganization({ ...(field === 'name' ? { name: value } : { email: value }), notice: page.items === null ? page.notice : null });
}

/** The employees the typed name or email narrow the list to: search, then Invite. */
export function shownEmployees(page: OrganizationState): readonly Employee[] {
  const name = page.name.trim().toLowerCase();
  const email = page.email.trim().toLowerCase();
  return (page.items ?? []).filter(employee => (name === '' || employee.display_name.toLowerCase().includes(name)) &&
    (email === '' || employee.email.includes(email)));
}

/** A new employee's email as the Authority takes it, the Swift app's rule. */
function invitationEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  const [local, domain, ...rest] = email.split('@');
  return email.length >= 3 && email.length <= 254 && rest.length === 0 && local !== undefined && domain !== undefined &&
    local.length <= 64 && domain.length <= 253 && domain.split('.').every(label => label.length <= 63) &&
    /^[a-z0-9](?:[a-z0-9_+%-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_+%-]*[a-z0-9])?)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(email)
    ? email : null;
}

/** Someone already here under that email: what to do instead. */
function alreadyHere(email: string, page: OrganizationState): string | null {
  const existing = page.items?.find(employee => employee.membership === 'active' && employee.email === email);
  if (!existing) return null;
  if (existing.invitation === 'pending' || existing.invitation === 'expired') return 'This employee already has an invitation. Reissue it from their ⋯ menu.';
  return 'This employee is already a member. Ask them to sign in.';
}

/**
 * Invite employee…: main asks where, makes a private folder there, and the
 * client saves the invitation in it. The page never holds the path.
 */
export async function inviteEmployee(): Promise<void> {
  const page = organization();
  if (!page || !page.items || page.write) return;
  const name = page.name.normalize('NFC').trim();
  const email = invitationEmail(page.email);
  if (name === '' || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name) || !email) { setOrganization({ notice: ENTER_BOTH }); return; }
  const conflict = alreadyHere(email, page);
  if (conflict) { setOrganization({ notice: conflict }); return; }
  const chosen = await rpc('dialog.saveInvitation', { name });
  if (!organization(page.seq)) return;
  if (!chosen.ok) { setOrganization({ notice: message(chosen.failure) }, page.seq); return; }
  if (!chosen.value) return;
  await employeeChange('invite', email, chosen.value.handle, name);
}

/** Reissue invitation…: a new one, saved the same way; the previous one stops working. */
export async function reissueInvitation(employee: Employee): Promise<void> {
  const page = organization();
  if (!page || page.write) return;
  setOrganization({ menu: null });
  const chosen = await rpc('dialog.saveInvitation', { name: employee.display_name, reissue: true });
  if (!organization(page.seq)) return;
  if (!chosen.ok) { setOrganization({ notice: message(chosen.failure) }, page.seq); return; }
  if (!chosen.value) return;
  await employeeChange('reissue', employee.email, chosen.value.handle, employee.display_name);
}

/** Revoke access…: asked first, since it cannot be undone. */
export function askRevoke(employee: Employee): void {
  if (organization()?.write) return;
  setOrganization({ confirm: employee, menu: null });
}

export function cancelRevoke(): void { setOrganization({ confirm: null }); }

export function confirmRevoke(): void {
  const employee = organization()?.confirm;
  if (!employee) return;
  setOrganization({ confirm: null });
  void employeeChange('revoke', employee.email);
}

/** Undo, after an invite: revokes only the employee that invite added, at once. */
export function undoInvite(): void {
  const saved = organization()?.saved;
  if (saved?.action === 'invite') void employeeChange('revoke', saved.email);
}

/**
 * An invite, a reissue or a revoke. Only the list, read again, says what an
 * unknown one did. Its outcome shows on People & invites as it is then, even
 * if the page was left and opened again meanwhile.
 */
async function employeeChange(action: 'invite' | 'reissue' | 'revoke', email: string, handle?: string, name?: string): Promise<void> {
  const account = expect();
  const page = organization();
  if (!account || !page || page.write || state.employeeWrite) return;
  const id = ++employeeChanges;
  // Only the last change is offered back: any other ends its Undo.
  const undoing = action === 'revoke' && page.saved?.action === 'invite' && page.saved.email === email;
  set({
    employeeWrite: { id, action },
    organization: { ...page, write: { action, status: 'sending' }, notice: null, confirm: null, menu: null, saved: null },
  });
  const result = action === 'invite'
    ? await rpc('employees.invite', { expect: account, name: name!, email, invitation_handle: handle! })
    : action === 'reissue'
      ? await rpc('employees.reissue', { expect: account, email, invitation_handle: handle! })
      : await rpc('employees.revoke', { expect: account, email });
  // Another account since: what the change did was the last account's.
  if (getState().employeeWrite?.id !== id) return;
  const current = organization();
  const done = (patch: Partial<OrganizationState>) => set({ employeeWrite: null, ...(current ? { organization: { ...current, ...patch } } : {}) });
  if (!result.ok) {
    const unknown = result.failure.mutation_outcome === 'unknown';
    // An unknown change, or an invitation made whose file could not be saved: the list shown may be wrong now.
    const stale = unknown || result.failure.code === 'invitation_save_failed';
    done({
      write: unknown ? { action, status: 'unknown' } : null, notice: unknown ? MAY_HAVE[action] : message(result.failure),
      ...(stale ? { items: null } : {}),
    });
    accountLost(result.failure);
    return;
  }
  if (action === 'revoke') {
    // Undo says nothing more: the list shows it.
    done({ write: null, notice: undoing ? null : 'Access revoked.' });
  } else {
    const expires = (result.value as { expires_at: string }).expires_at;
    done({
      write: null, notice: null, saved: { handle: handle!, action, name: name ?? email, email, expires_at: expires },
      ...(action === 'invite' ? { name: '', email: '' } : {}),
    });
  }
  await loadEmployees();
}

/** Show invitation in Finder: main shows the file it saved; the page never learns where. */
export function showInvitation(): void {
  const saved = organization()?.saved;
  if (saved) void rpc('invitation.show', { invitation_handle: saved.handle });
}

export function toggleEmployeeMenu(email: string): void {
  const page = organization();
  if (page) setOrganization({ menu: page.menu === email ? null : email });
}

// ---- ask ---------------------------------------------------------------------

/** The × on the scope chip: the bar searches and asks everything you can read. The page stays. */
export function widenScope(): void {
  set({ barScope: { kind: 'global' } });
  syncSearch();
}

function scopeName(scope: AskScope): string {
  if (scope.kind === 'global') return 'All accessible context';
  const route = state.route;
  if (route.page === 'project' && route.project.project_id === scope.project_id) return route.project.name;
  return state.projects.items.find(project => project.project_id === scope.project_id)?.name ?? 'Project';
}

/** Earlier answers kept in a thread. */
const MAX_EARLIER = 5;

/** The earlier answers shown: the thread's and, while a question is on its way, the answer before it. */
export function earlierTurns(thread: AskState): readonly AskTurn[] {
  return [...thread.earlier, ...(thread.previous ? [thread.previous] : [])].slice(-MAX_EARLIER);
}

/**
 * Asks, as a follow-up when a thread is open. One question at a time: a
 * second never replaces one on its way. The current answer moves up, and
 * joins the earlier ones only once the new question is answered.
 */
export async function ask(question: string, scope: AskScope = state.barScope): Promise<void> {
  const account = expect();
  const text = question.trim();
  const thread = state.ask;
  if (!account || text === '' || thread?.asking) return;
  const mine = ++seq;
  const asking: AskQuestion = { question: text, scope, scopeName: scopeName(scope) };
  set({ ask: { seq: mine, earlier: thread?.earlier ?? [], previous: thread?.shown ?? null, shown: null, asking, failed: null }, sources: null, toast: null });
  const result = await rpc('ask.run', { expect: account, question: text, scope });
  const current = state.ask;
  if (current?.seq !== mine) return; // cancelled, or Ask was left
  if (!result.ok) {
    set({ ask: { ...current, previous: null, shown: current.previous, asking: null, failed: { ...asking, failure: result.failure } } });
    if (current.previous) startSources();
    accountLost(result.failure);
    return;
  }
  const earlier = current.previous ? [...current.earlier, current.previous].slice(-MAX_EARLIER) : current.earlier;
  set({ ask: { ...current, earlier, previous: null, shown: { id: mine, ...asking, answer: result.value }, asking: null } });
  startSources();
}

/** Cancel, while asking: the answer before comes back, or with none Ask closes. A late answer is dropped. */
export function cancelAsk(): void {
  const thread = state.ask;
  if (!thread?.asking) return;
  if (!thread.previous) { closeAsk(); return; }
  set({ ask: { ...thread, seq: ++seq, shown: thread.previous, previous: null, asking: null } });
  startSources();
}

/** Copy answer: the current answer's text, onto the clipboard. Says whether it got there. */
export async function copyAnswer(): Promise<boolean> {
  const text = state.ask?.shown?.answer.text;
  return text !== undefined && (await rpc('clipboard.writeText', { text })).ok;
}

/** Back or Escape: leaves the thread, and it is gone. */
export function closeAsk(): void {
  set({ ask: null, sources: null });
  syncSearch();
}

// ---- an answer's sources -----------------------------------------------------

/** What the pane may show: at most 32 sources. */
export const MAX_SOURCES = 32;

/** The sources of the answer on screen. */
export function answerSources(current: State = state): readonly AnswerSource[] {
  return current.ask?.shown?.answer.sources.slice(0, MAX_SOURCES) ?? [];
}

/** Access-level failures: a background read reports only these. */
const ACCOUNT_GONE = ['signed_out', 'account_changed', 'unauthorized', 'stale_access_state', 'sign_in_required'];

/**
 * An answer came on screen: its sources start unread, the pane closed, and
 * its approved records are read one after another, so each chip can name its
 * meeting.
 */
function startSources(): void {
  const gen = ++seq;
  set({ sources: { gen, open: null, selected: state.sources?.selected ?? 0, records: {}, evidence: null } });
  void readRecords(gen);
}

function sourcesAt(gen: number): SourcesState | null {
  return state.sources?.gen === gen && !state.concealed ? state.sources : null;
}

async function readRecords(gen: number): Promise<void> {
  for (const source of answerSources()) {
    const sources = sourcesAt(gen);
    if (!sources) return;
    if (source.kind === 'record' && !sources.records[source.record.record_sha256]) await readRecord(gen, source.record, true);
  }
}

/** One approved record. A read the person did not ask for fails quietly, unless the account is gone. */
async function readRecord(gen: number, record: RecordRef, background: boolean): Promise<void> {
  const account = expect();
  if (!account || !sourcesAt(gen)) return;
  const patch = (read: Read<ApprovedRecord>) => {
    const sources = sourcesAt(gen);
    if (sources) set({ sources: { ...sources, records: { ...sources.records, [record.record_sha256]: read } } });
  };
  patch({ loading: true });
  const result = await rpc('ask.record', { expect: account, record });
  // Replies for another answer, or that land while another app is in front, are dropped.
  patch(result.ok ? { loading: false, value: result.value } : { loading: false, failure: result.failure });
  if (!result.ok && sourcesAt(gen) && (!background || ACCOUNT_GONE.includes(result.failure.code))) accountLost(result.failure);
}

/** A chip: the pane opens beside the answer on that source, read unless it already was. */
export function chooseSource(index: number): void {
  const sources = state.sources;
  const source = answerSources()[index];
  if (!sources || !source) return;
  set({ sources: { ...sources, open: index, selected: index, evidence: null } });
  if (source.kind === 'original') { void readEvidence(sources.gen, index); return; }
  const read = sources.records[source.record.record_sha256];
  if (!read || (!read.loading && 'failure' in read)) void readRecord(sources.gen, source.record, false);
}

/** Sources (n): opens the pane on the last source chosen, or closes it. */
export function toggleSources(): void {
  const sources = state.sources;
  if (!sources) return;
  if (sources.open === null) chooseSource(sources.selected);
  else set({ sources: { ...sources, open: null, evidence: null } });
}

/** The original's verified evidence packet, read each time it is chosen. */
async function readEvidence(gen: number, index: number): Promise<void> {
  const account = expect();
  const answer = state.ask?.shown?.answer;
  const source = answerSources()[index];
  const sources = sourcesAt(gen);
  if (!account || !answer || source?.kind !== 'original' || !sources) return;
  const mine = ++seq;
  set({ sources: { ...sources, evidence: { seq: mine, index, read: { loading: true } } } });
  const result = await rpc('ask.source', { expect: account, scope: answer.scope, ref: source.ref });
  // Replies for another source or answer, or that land while another app is in front, are dropped.
  const now = sourcesAt(gen);
  if (now?.evidence?.seq !== mine) return;
  set({ sources: { ...now, evidence: { seq: mine, index,
    read: result.ok ? { loading: false, value: result.value } : { loading: false, failure: result.failure } } } });
  if (!result.ok) accountLost(result.failure);
}

/** Retry evidence, on the original the pane shows. */
export function retryEvidence(): void {
  const sources = state.sources;
  if (sources?.open != null) void readEvidence(sources.gen, sources.open);
}

/** Try again, on an approved record that could not be read. */
export function retryRecord(): void {
  const sources = state.sources;
  const source = sources?.open != null ? answerSources()[sources.open] : undefined;
  if (sources && source?.kind === 'record') void readRecord(sources.gen, source.record, false);
}

// ---- the bar: live search -------------------------------------------------------

/** Typing searches once it pauses. */
const SEARCH_PAUSE_MS = 250;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

function sameScope(a: AskScope, b: AskScope): boolean {
  return a.kind === b.kind && (a.kind === 'global' || (b.kind === 'project' && a.project_id === b.project_id));
}

/** What the bar should search now: never on the Ask page, never while another app is in front. */
function wantedSearch(): { query: string; scope: AskScope } | null {
  if (!state.status?.signed_in || state.concealed || state.ask) return null;
  const query = searchQuery(state.barText);
  return query === null ? null : { query, scope: state.barScope };
}

/**
 * Searches for the bar's text in its scope, unless the matches shown are
 * already for them; `fresh` reads them again anyway. With nothing to search
 * the matches go. A new search `typed` in the bar closes the reader, so its
 * matches show.
 */
function syncSearch(fresh = false, typed = false): void {
  clearTimeout(searchTimer);
  searchTimer = undefined;
  const wanted = wantedSearch();
  if (!wanted) { if (state.matches) set({ matches: null }); return; }
  const current = state.matches;
  const sameList = current !== null && sameScope(current.scope, wanted.scope);
  if (!fresh && sameList && current.query === wanted.query && !current.failure) return;
  if (typed && state.reader) closeReader();
  void runSearch(wanted.query, wanted.scope, sameList ? current.items : []);
}

/** The search runs; the scope's last matches stay until the new ones arrive. */
async function runSearch(query: string, scope: AskScope, shown: readonly Match[]): Promise<void> {
  const account = expect();
  if (!account) return;
  const mine = ++seq;
  set({ matches: { seq: mine, query, scope, loading: true, items: shown } });
  const result = await rpc('search.run', { expect: account, query, scope });
  if (state.matches?.seq !== mine) return;
  if (!result.ok) {
    set({ matches: { seq: mine, query, scope, loading: false, items: [], failure: result.failure } });
    accountLost(result.failure);
    return;
  }
  set({ matches: { seq: mine, query, scope, loading: false, items: result.value.items } });
}

/** Typing in the bar. A search waits for a pause; text that cannot be searched shows no matches. */
export function setBarText(text: string): void {
  set({ barText: text });
  clearTimeout(searchTimer);
  if (!wantedSearch()) { syncSearch(); return; }
  searchTimer = setTimeout(() => syncSearch(false, true), SEARCH_PAUSE_MS);
}

/** The same search, read again: Try again after a failure, or the window or ECHO came back. */
export function searchAgain(): void { syncSearch(true); }

/** Escape in the bar: the text and its matches go; the page stays. */
export function clearBar(): void { emptyBar(); }

function emptyBar(): void {
  clearTimeout(searchTimer);
  searchTimer = undefined;
  if (state.barText !== '' || state.matches) set({ barText: '', matches: null });
}

/** Return, or the Ask row under the matches: asks the bar's scope, and the bar empties. */
export function submitBar(): void {
  const text = state.barText;
  // While a question is on its way the next one waits in the bar.
  if (text.trim() === '' || state.ask?.asking) return;
  emptyBar();
  void ask(text, state.barScope);
}

/** The matches show over the page: not over a reader, an answer, a sheet, or a covered window. */
export function matchesShown(current: State = state): boolean {
  return current.matches !== null && !current.concealed && !current.ask && !current.reader && !current.sheet &&
    !(current.compose && !current.compose.hidden) && searchQuery(current.barText) !== null;
}

/**
 * Another app is in front and the page is covered: a project, People &
 * invites, an answer or an original. The bar's text is covered with it.
 */
export function pageCovered(current: State = state): boolean {
  const { route } = current;
  return current.concealed && (current.ask !== null || route.page === 'project' || current.reader !== null ||
    (route.page === 'organization' && current.organization !== null));
}

/** The project the chip names, while its page is on screen. */
export function chipProject(current: State = state): ProjectSummary | null {
  const { route, barScope } = current;
  return !current.concealed && route.page === 'project' && barScope.kind === 'project' && barScope.project_id === route.project.project_id
    ? route.project : null;
}

// ---- capture -----------------------------------------------------------------

const NOTE_OR_FILE = 'Save this note before attaching a file.';
/** What a note may hold, as the API takes it: 8 KiB of text. */
const MAX_NOTE_BYTES = 8 * 1024;
const TOO_LONG = 'Up to 8 KiB of text.';

/** What main's quit guard was last told. */
let unresolvedTold = '';

/**
 * Main's quit guard: a note, a file or a project change (a create included)
 * on its way, or not yet confirmed either way.
 */
function unresolvedChanged(): void {
  const compose = state.compose;
  const saving = compose?.status === 'sending' || compose?.status === 'unknown' || compose?.status === 'checking';
  const sheet = state.sheet?.kind === 'new-project' ? state.sheet : null;
  const uploading = sheet?.files.some(file => file.status === 'saving' || file.status === 'checking' || file.status === 'unknown') === true;
  const changing = changeBlocked() || sheet?.create.status === 'sending' || sheet?.create.status === 'unknown';
  const told = {
    unresolved: saving || uploading || changing,
    ...(saving ? (compose.file ? { file: true } : {}) : uploading ? { file: true } : changing ? { change: true } : {}),
  };
  const key = JSON.stringify(told);
  if (key === unresolvedTold) return;
  unresolvedTold = key;
  void rpc('app.setUnresolved', told);
}

function setCompose(compose: ComposeState | null): void {
  set({ compose });
  unresolvedChanged();
}

/** A new capture: filed in this project and readable by its members, or only yours. */
function fresh(project: ProjectSummary | null): ComposeState {
  return {
    seq: ++seq, text: '', file: null, project, readers: project ? 'project' : 'only-me', picking: false, status: 'editing',
    requestId: crypto.randomUUID(), kept: false, hidden: false, confirmNew: false,
  };
}

/**
 * A request that will never be resent: the copy the client kept of its file
 * goes, so kept copies do not pile up (the client holds ten at most). Only
 * this computer's copy: a file that did arrive stays saved.
 */
function release(compose: ComposeState): void {
  const account = expect();
  if (compose.kept && account) void rpc('documents.abandon', { expect: account, request_id: compose.requestId });
}

/** The project on screen, if any. While another app is in front there is none: its page is covered. */
function onScreen(): ProjectSummary | null {
  return state.route.page === 'project' && !state.concealed ? state.route.project : null;
}

/**
 * ⊕ and the sidebar's Capture: the draft comes back as it was, or a new
 * capture for the project on screen, even with the chip widened (asking
 * everything never picks who can read a capture).
 */
export function openCompose(): void {
  const current = state.compose;
  set({ toast: null });
  setCompose(current ? { ...current, hidden: false } : fresh(onScreen()));
}

/**
 * ⌘⇧E, from any app: the draft comes back as it was, or a new capture starts
 * as Only me. Whatever page was left open never picks who can read it.
 */
export function openCapture(): void {
  const current = state.compose;
  // New project stays in front: its files are dropped on it.
  if (state.sheet?.kind === 'new-project') return;
  set({ toast: null });
  setCompose(current ? { ...current, hidden: false } : fresh(null));
}

/** Escape or Close hides the sheet and keeps the draft. */
export function closeCompose(): void {
  const compose = state.compose;
  if (!compose || compose.status === 'sending' || compose.status === 'checking') return;
  setCompose({ ...compose, hidden: true, picking: false, confirmNew: false, notice: undefined });
}

function locked(compose: ComposeState): boolean {
  return compose.status === 'sending' || compose.status === 'checking' || compose.status === 'unknown';
}

function editCompose(patch: Partial<ComposeState>): void {
  const compose = state.compose;
  if (!compose || locked(compose)) return;
  // Any change to what would be saved, or for whom, makes it a new request.
  const changesContent = 'text' in patch || 'file' in patch || 'project' in patch || 'readers' in patch;
  if (changesContent) release(compose);
  setCompose({ ...compose, notice: undefined, ...patch,
    ...(changesContent ? { requestId: crypto.randomUUID(), kept: false, status: 'editing' as const, failure: undefined } : {}) });
}

export function setComposeText(text: string): void { editCompose({ text }); }

/** One of the Who can read choices. The project's needs a project in the row. */
export function chooseReaders(readers: Readers): void {
  if (readers === 'project' && !state.compose?.project) return;
  editCompose({ readers, picking: false });
}

/** More…: the other projects, to capture into one of them instead. */
export function toggleMore(): void {
  const compose = state.compose;
  if (compose && !locked(compose)) setCompose({ ...compose, picking: !compose.picking });
}

/**
 * A project chosen under More…: the capture is filed there. Who can read it
 * never widens by itself: Only me and Organization stay, and the last
 * project's members give way to Only me until this project's are chosen.
 */
export function chooseProject(project: ProjectSummary): void {
  const readers = state.compose?.readers;
  if (readers) editCompose({ project, readers: readers === 'project' ? 'only-me' : readers, picking: false });
}

export function removeFile(): void { editCompose({ file: null }); }

/** The paperclip. A note and a file are never saved together. */
export async function attachFile(): Promise<void> {
  const compose = state.compose;
  if (!compose || locked(compose)) return;
  if (compose.text.trim() !== '') { setCompose({ ...compose, notice: NOTE_OR_FILE }); return; }
  const result = await rpc('dialog.openDocument', {});
  if (result.ok && result.value) editCompose({ file: result.value });
  else if (!result.ok && state.compose && !locked(state.compose)) setCompose({ ...state.compose, notice: message(result.failure) });
}

function audienceOf(compose: ComposeState): Audience {
  if (compose.readers === 'project' && compose.project) return { kind: 'project', project_id: compose.project.project_id };
  return compose.readers === 'team' ? { kind: 'team' } : { kind: 'only-me' };
}

/** A document's extraction state, in the app's own words. */
export const EXTRACTION: Record<Extraction, string> = {
  extracting: 'Extracting text', ready: 'Text ready', partial: 'Partial text', no_text: 'No searchable text',
  encrypted: 'Encrypted · text unavailable', malformed: 'Unreadable document · text unavailable',
  limit_exceeded: 'Extraction limit reached', timed_out: 'Text extraction timed out', unsupported: 'Text unavailable',
  unavailable: 'Text unavailable',
};

/** Where a confirmed save went, and for a file how its text is coming along. */
function savedLabel(compose: ComposeState, extraction: Extraction | undefined): string {
  const where = compose.readers === 'team' ? 'Shared with your organization'
    : compose.readers === 'project' && compose.project ? `Saved to ${compose.project.name}` : 'Saved for you';
  return compose.file && extraction ? `${where} · ${EXTRACTION[extraction]}` : where;
}

/** The Authority confirmed it: the sheet closes itself, and the toast says where it went. */
function saved(compose: ComposeState, extraction: Extraction | undefined): void {
  setCompose(null);
  set({ toast: savedLabel(compose, extraction) });
  const projectId = compose.project?.project_id;
  if (projectId !== undefined && state.route.page === 'project' && state.route.project.project_id === projectId) void refreshFeed(projectId);
}

/** Save, or resend the exact same request after an unconfirmed outcome. */
export async function sendCompose(): Promise<void> {
  const account = expect();
  const compose = state.compose;
  if (!account || !compose || compose.status === 'sending' || compose.status === 'checking') return;
  if (!compose.file && compose.text.trim() === '') return;
  const retrying = compose.status === 'unknown';
  // Too long is said here, before anything is sent, not as a refusal.
  if (!compose.file && !retrying && new TextEncoder().encode(compose.text).length > MAX_NOTE_BYTES) {
    setCompose({ ...compose, notice: TOO_LONG });
    return;
  }
  setCompose({ ...compose, status: 'sending', failure: undefined, picking: false, confirmNew: false, notice: undefined });
  const audience = audienceOf(compose);
  const project = compose.project ? { project_id: compose.project.project_id } : {};
  let result: Result<Receipt>;
  if (compose.file && retrying) {
    // The client kept the original: resend it, not whatever the path holds now.
    result = await rpc('documents.retry', { expect: account, request_id: compose.requestId, audience });
  } else if (compose.file) {
    result = await rpc('documents.upload', {
      expect: account, request_id: compose.requestId, file_handle: compose.file.handle, title: compose.file.name, audience, ...project,
    });
  } else {
    result = await rpc('notes.submit', { expect: account, request_id: compose.requestId, text: compose.text, audience, ...project });
  }
  const current = state.compose;
  if (current?.seq !== compose.seq) return;
  if (!result.ok) {
    // Only the Authority's answer settles an unknown save: a failed retry leaves it unknown.
    const unknown = retrying || result.failure.mutation_outcome === 'unknown';
    setCompose({ ...current, status: unknown ? 'unknown' : 'error', failure: result.failure, hidden: false,
      kept: current.kept || (unknown && current.file !== null) });
    accountLost(result.failure);
    return;
  }
  saved(current, result.value.extraction);
}

/** After an unconfirmed outcome: ask the Authority whether it arrived. */
export async function checkCompose(): Promise<void> {
  const account = expect();
  const compose = state.compose;
  if (!account || !compose || compose.status !== 'unknown') return;
  setCompose({ ...compose, status: 'checking', confirmNew: false });
  const result = await rpc('writes.status', { expect: account, request_id: compose.requestId, kind: compose.file ? 'document' : 'note' });
  const current = state.compose;
  if (current?.seq !== compose.seq) return;
  if (result.ok && result.value.state === 'saved') { saved(current, result.value.extraction); return; }
  if (result.ok && result.value.state === 'not_saved') {
    // It never arrived: sending the same request again is safe.
    setCompose({ ...current, status: 'error', failure: { code: 'not_saved', retryable: true } });
    return;
  }
  setCompose({ ...current, status: 'unknown' });
}

/**
 * Start over while a save is unconfirmed asks once, then clears the note or
 * file. Who can read it stays as it was chosen.
 */
export function newCompose(): void {
  const compose = state.compose;
  if (!compose || compose.status === 'sending' || compose.status === 'checking') return;
  if (compose.status === 'unknown' && !compose.confirmNew) { setCompose({ ...compose, confirmNew: true }); return; }
  release(compose);
  setCompose({ ...fresh(compose.project), readers: compose.readers });
}

export function keepUnresolved(): void {
  if (state.compose) setCompose({ ...state.compose, confirmNew: false });
}

// ---- drops -------------------------------------------------------------------

const NOT_ATTACHED = 'The file was not attached.';

/** A drop can land: someone is signed in, no account sheet is up, and it is one file. */
export function canDrop(event: DragEvent): boolean {
  const items = event.dataTransfer?.items;
  return state.status?.signed_in === true && !state.sheet && items?.length === 1 && items[0]!.kind === 'file';
}

/**
 * A dropped file. On the open sheet it is attached, and who can read it
 * stays; on a project row it is captured into that project; anywhere else
 * into the project on screen, or Only me. A draft with words in it, or a save
 * not yet settled, is never changed: it comes back and says the file was not
 * attached.
 */
export async function acceptDrop(file: File, on: ProjectSummary | 'window' | 'sheet'): Promise<void> {
  if (!expect() || state.sheet) return;
  const result = await dropFile(file);
  if (!expect() || state.sheet) return;
  const current = state.compose;
  if (current && (locked(current) || current.text.trim() !== '')) {
    setCompose({ ...current, hidden: false, notice: locked(current) ? NOT_ATTACHED : `${NOT_ATTACHED} Save this note first.` });
    return;
  }
  if (on === 'sheet' && current && !current.hidden) {
    if (result.ok) editCompose({ file: result.value });
    else setCompose({ ...current, notice: message(result.failure) });
    return;
  }
  set({ toast: null });
  const project = on === 'window' || on === 'sheet' ? onScreen() : on;
  if (!result.ok) {
    setCompose(current ? { ...current, hidden: false, notice: message(result.failure) } : { ...fresh(project), notice: message(result.failure) });
    return;
  }
  // Nothing written yet: the drop starts over, for whoever the gesture says.
  if (current) release(current);
  setCompose({ ...fresh(project), file: result.value });
}

// ---- window ------------------------------------------------------------------------

export function toggleSidebar(): void {
  const open = !state.sidebarOpen;
  set({ sidebarOpen: open });
  try { localStorage.setItem(SIDEBAR_OPEN, String(open)); } catch { /* optional convenience */ }
}

// ---- concealment ---------------------------------------------------------------

/**
 * Another app is in front: cover the window until ECHO is back. The bar keeps
 * its text (out of sight over a covered page); its matches go, and are read
 * again for the account on return.
 */
export function conceal(): void {
  // The source pane closes and forgets what it read; the records are read again on return.
  const reading = state.sources !== null;
  // People closes, as Home's and the sidebar's rows must take a drop; unless a change in it is on its way.
  const people = state.sheet?.kind === 'people' && !memberChangeSending();
  // New project stays: files are dropped on it from other apps.
  // People & invites closes what is open in it, and an invitation just saved is no longer offered back (its Undo ends).
  set({
    concealed: true, ...(reading ? { sources: { ...state.sources!, gen: ++seq, open: null, records: {}, evidence: null } } : {}),
    ...(people ? { sheet: null } : {}), ...(state.reader ? { reader: { ...state.reader, menu: 'closed' as const } } : {}),
    ...(state.organization ? { organization: { ...state.organization, menu: null, confirm: null, saved: null } } : {}),
  });
  syncSearch();
}
export function resume(): void {
  if (!state.concealed) return;
  set({ concealed: false });
  void refreshStatus().then(() => {
    searchAgain();
    // The answer's records are read again. A chip chosen meanwhile keeps its pane open.
    if (state.sources && !state.concealed) void readRecords(state.sources.gen);
    // People & invites is read again for whoever is signed in now.
    if (state.route.page === 'organization' && !state.concealed) void loadEmployees();
  });
}

/** The window came forward (⌘E, the tray): the account, Home and the bar's search are read again. */
export async function windowShown(): Promise<void> {
  if (state.concealed) return;
  await refreshStatus();
  searchAgain();
  await refreshHome();
}
