import type { PersonMeetingOperationV2, PersonMeetingResultsV2, PersonMeetingReviewV2, PersonRunV1, PersonRunsRequestV1 } from '@echo-brain/organization-api';
// All renderer state and the actions that change it. Every request carries the
// account being shown; late replies for a page that has moved on are dropped.
import { useEffect, useState } from 'preact/hooks';
import type {
  AccountCommand, Answer, AnswerSource, AppStatus, ApprovedRecord, AskScope, Audience, ConnectedTool, ContextContent, DocumentText, Employee, Expect,
  Extraction, Failure, FileHandle, ImpactView, ItemRef, ListItem, ListScope, Match, Member, ProjectChange, ProjectConfluenceMapping, ConfluenceSpace, ProjectJiraMapping, ProjectSummary, Receipt, RecordItem, RecordRef,
  RecordSection, Result, RunsResults, SourceEvidence, ToolAttempt, ExternalAnswerSource,
} from '../shared/protocol.js';
import { MAX_CAPTURE_PROJECTS } from '../shared/protocol.js';
import { askText, searchQuery } from '../shared/query.js';
import { sourceGroups, type SourceGroup } from './answer.js';
import { dropFile, rpc } from './api.js';
import { renamedProject, reread } from './feed.js';
import { message } from './messages.js';

/** Mine: only what you added, to see and to ask about. */
type Route = { page: 'home' } | { page: 'project'; project: ProjectSummary } | { page: 'organization' } | { page: 'mine' } | { page: 'tools' } | { page: 'decision'; approval_id: string };

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
 * the answer before it current.
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
  /** The source the pane shows, by its number in the answer less one; null while the pane is closed. */
  open: number | null;
  /** The sentence whose number opened the pane: "direct", or its part and place ("0.2", "0.r1" for a passage found); null when a row did. */
  focus: string | null;
  /** Approved records read for this answer, by digest. */
  records: Readonly<Record<string, Read<ApprovedRecord>>>;
  /** The cited passages of the original the pane shows, by citation; read each time it is chosen. */
  evidence: { seq: number; group: number; reads: Readonly<Record<number, Read<SourceEvidence>>> } | null;
}

/** Who can read a capture: only you, the members of the projects ticked under Projects, or everyone in the organization. */
export type Readers = 'only-me' | 'projects' | 'team';

/** Capture: one page, a note or one file, and who can read it. */
export interface ComposeState {
  seq: number;
  text: string;
  file: FileHandle | null;
  /** The project Capture was opened for: the page's, or the row a file was dropped on. */
  context: ProjectSummary | null;
  /**
   * The projects ticked under Projects, in the order they were ticked. The
   * capture is filed in them whoever can read it, or in the context when
   * none is ticked.
   */
  projects: ProjectSummary[];
  /** 'projects' with none ticked has nothing to save until one is. */
  readers: Readers;
  /** The Projects list is open: the choice it goes back to if it closes with none ticked. */
  picking: { readers: Readers; projects: ProjectSummary[] } | null;
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

/** Tools, while it is the page: the organization's tools and your connection to each. */
export interface ToolsPage {
  seq: number;
  loading: boolean;
  items: readonly ConnectedTool[] | null;
  failure?: Failure;
}

/**
 * Connect or Reconnect: starting (the page is being opened), waiting (for the
 * person in the browser; read every few seconds), or failed. `reason` is the
 * tool's own failure code, or expired.
 */
export interface ToolConnectSheet {
  kind: 'tool-connect';
  seq: number;
  tool: ConnectedTool;
  phase: 'starting' | 'waiting' | 'failed';
  attempt?: ToolAttempt;
  reason?: string;
  failure?: Failure;
}

/** Manage: a connected tool, and Disconnect. */
export interface ToolManageSheet {
  kind: 'tool-manage';
  tool: ConnectedTool;
  busy: boolean;
  failure?: Failure;
}

/**
 * Finding people by name. People finds them in the project's directory and
 * adds one at once, with an Undo; making a lead or removing someone is asked
 * first. New project finds them in the organization's directory and lists
 * the ones picked, or, on an Authority without it, uses People's way once
 * its project exists.
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

/** One file in New project. Once the project exists they save one at a time, each under its own request. */
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

/** One person picked in New project. Once the project exists they are added one at a time, each under its own request. */
export interface ProjectPick {
  /** From the same sequence as the files', so a Skip… names either. */
  id: number;
  person: Member;
  requestId: string;
  /** unknown: the add may or may not have arrived; nothing after it starts until that is settled. */
  status: 'waiting' | 'adding' | 'added' | 'unknown' | 'failed' | 'skipped';
  failure?: Failure;
}

/**
 * New project, one page: a name, the people to add and the files to save,
 * both optional. Nothing is sent before Create. Create makes the project;
 * then the same page adds each person and saves each file, in turn, and the
 * project opens behind the sheet. Done closes it.
 */
export interface NewProjectSheet extends Finding {
  kind: 'new-project';
  seq: number;
  name: string;
  /** The create: its request, the name it sends, and where it stands. An unknown one is resent as it was. */
  create: { requestId: string; name: string; status: 'editing' | 'sending' | 'unknown' | 'failed' | 'created'; failure?: Failure };
  /** Close was chosen while the create, an add or a file may have arrived: closing gives up finding out, so it is asked first. */
  confirmClose: boolean;
  /** The project Create made, once read. */
  project: ProjectSummary | null;
  /** Made, but not read yet: Open reads it again, and Create is never offered twice. */
  createdId: string | null;
  opening: boolean;
  openFailure?: Failure;
  /** The project opened behind the sheet, once nothing more could start. */
  opened: boolean;
  /** The people to add, in the order picked. You lead the project, so you are never one of them. */
  picks: ProjectPick[];
  /**
   * This Authority has no organization directory (an older one): people are
   * added after Create, from the project's own directory, as People does.
   */
  peopleLater: boolean;
  files: ProjectFile[];
  /** The person or file whose Skip… is being asked. */
  skip: number | null;
  /** A fixed line about the last gesture, such as too many files. */
  notice?: string;
}

export type Sheet = SignOutSheet | ToolConnectSheet | ToolManageSheet | PeopleSheet | NewProjectSheet;

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

/** Where an item was opened: a project's page (a row or a match in it), Mine, or a saved note found in all context. */
export type ReaderFrom = { kind: 'project'; project_id: string } | { kind: 'mine' } | { kind: 'search' };

/**
 * An item open in the reader, by its ref: a note's text, a document's text a
 * page at a time, or a meeting's approved record, read on with More.
 */
export interface ReaderState {
  ref: ItemRef;
  from: ReaderFrom;
  loading: boolean;
  content?: ContextContent;
  importedNext?: string | null;
  document?: DocumentText;
  record?: ApprovedRecord;
  /** The record's next page, until all of it is read. */
  recordNext?: string | null;
  failure?: Failure;
  /** The ⋯ menu, and its list of projects to add to. */
  menu: 'closed' | 'open' | 'projects';
  /** Save original…: on its way, done, or not done. */
  save?: { status: 'saving' | 'saved' | 'failed'; failure?: Failure };
}

/** A page's list: what you added, or a project's notes, documents and meetings, newest first, a page at a time. */
export interface ListState {
  scope: ListScope;
  /** This visit to the page: where its list was scrolled is kept while it lasts. */
  opened: number;
  items: ListItem[];
  next: string | null;
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

/** Shared load/save state; an unconfirmed write must be reloaded before editing. */
export interface ProjectToolSetting<Value> {
  seq: number;
  status: 'loading' | 'ready' | 'saving' | 'failed';
  value?: Value;
  failure?: Failure;
  writeFailed?: boolean;
}
export interface ProjectJiraSetting extends ProjectToolSetting<ProjectJiraMapping> { key: string }
export interface ProjectConfluenceSetting extends ProjectToolSetting<ProjectConfluenceMapping> {
  spaces: readonly ConfluenceSpace[];
  next: string | null;
  selected: readonly string[];
  loadingMore?: boolean;
  /** The lead-only space catalog failed; the shared project mapping is still readable. */
  pickerFailure?: Failure;
}

export interface ProjectSettingsState {
  jira?: ProjectJiraSetting;
  confluence?: ProjectConfluenceSetting;
  project: ProjectSummary;
  menu: boolean;
  menuOrigin: 'header' | 'sidebar';
  rename: string | null;
  confirm: 'archive' | 'unarchive' | 'leave' | null;
  write: {
    requestId: string;
    operation: 'rename' | 'archive' | 'leave';
    name?: string;
    archived?: boolean;
    status: 'sending' | 'unknown' | 'failed';
    failure?: Failure;
    /** Forgetting an unknown request is itself asked once. */
    dismissConfirm?: boolean;
  } | null;
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
  archivedProjects: { items: ProjectSummary[]; next: string | null; loading: boolean; failure?: Failure };
  list: ListState | null;
  roster: RosterState | null;
  reader: ReaderState | null;
  change: ChangeState | null;
  projectSettings: ProjectSettingsState | null;
  /**
   * What the bar asks about, and searches: a project or Mine (the chip), or
   * all context. The page never moves with it.
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
  /** Tools, while it is the page. */
  tools: ToolsPage | null;
  /**
   * The employee change on its way. It outlives a visit to People & invites:
   * no other change starts while it is, and a visit made meanwhile shows what
   * it did.
   */
  employeeWrite: { id: number; action: 'invite' | 'reissue' | 'revoke' } | null;
  /** Home: what needs you. */
  home: HomeState | null;
  /** The decision open from Home, while it is the page. */
  decision: DecisionState | null;
}

const SIDEBAR_OPEN = 'echo.sidebarOpen';

function rememberedSidebar(): boolean {
  try { return localStorage.getItem(SIDEBAR_OPEN) !== 'false'; } catch { return true; }
}

let state: State = {
  status: null, booting: true, route: { page: 'home' }, projects: { items: [], next: null, loading: false },
  archivedProjects: { items: [], next: null, loading: false }, list: null, roster: null, reader: null, change: null, projectSettings: null,
  barScope: { kind: 'global' }, barText: '', matches: null, ask: null, sources: null, compose: null, toast: null, concealed: false,
  signin: { phase: 'idle', form: false }, sheet: null, startFailed: false, sidebarOpen: rememberedSidebar(), organization: null, tools: null, employeeWrite: null,
  home: null, decision: null,
};
const listeners = new Set<() => void>();
let seq = 0;
/** The active request's host cancellation id. It never leaves the desktop IPC. */
let activeAskCancelId: string | null = null;

export function getState(): State { return state; }
function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  // A modal owns keyboard focus. Dismiss only the transient project menu,
  // retaining settings drafts and writes while unmounting its global handlers.
  if (state.projectSettings?.menu && (state.sheet || (state.compose && !state.compose.hidden))) {
    state = { ...state, projectSettings: { ...state.projectSettings, menu: false } };
  }
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
  // Signed out: the sign-in page covers everything until someone signs in. Mine, and what was read in it, goes.
  if (!next) {
    emptyBar();
    set({ sheet: null });
    if (state.route.page === 'mine') {
      readSeq += 1;
      set({ route: { page: 'home' }, list: null, reader: null, ask: null, sources: null, barScope: { kind: 'global' } });
    }
    unresolvedChanged();
    return;
  }
  const same = lastAccount?.authority === next.authority && lastAccount.membership_id === next.membership_id;
  // Someone else: nothing of the last account's survives, not even a draft.
  if (!same) forgetAccount();
  // A new role is a change of access: the bar's text goes, and People & invites is for owners.
  else if (before && before.role !== next.role) {
    emptyBar();
    if (state.route.page === 'organization' && next.role !== 'owner') goHome();
  }
  lastAccount = { authority: next.authority, membership_id: next.membership_id };
  if (!same || !wasSignedIn) { void loadProjects(); void loadArchivedProjects(); void loadHome(); }
}

/** Nothing of an account's stays on screen or in memory, not even a draft. */
function forgetAccount(): void {
  stopRunPolling();
  lastAccount = null;
  emptyBar();
  set({ route: { page: 'home' }, list: null, roster: null, reader: null, ask: null, sources: null, sheet: null, toast: null,
    barScope: { kind: 'global' }, projects: { items: [], next: null, loading: false }, archivedProjects: { items: [], next: null, loading: false },
    projectSettings: null, organization: null, tools: null, employeeWrite: null, home: null, decision: null });
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
  if (command === 'tools') openTools();
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
  if (sheet?.kind === 'tool-manage') return sheet.busy;
  return false;
}

export function closeSheet(): void {
  const sheet = state.sheet;
  if (!sheet || signingOut()) return;
  if (sheet.kind === 'new-project') { closeNewProject(); return; }
  if (sheet.kind === 'people' && memberChangeSending()) return;
  if (sheet.kind === 'tool-connect') { cancelConnect(); return; }
  if (sheet.kind === 'tool-manage' && sheet.busy) return;
  set({ sheet: null });
}

// ---- tools ----------------------------------------------------------------------

/** How often a waiting connection is read: the terminal client's own pace. */
const TOOL_POLL_MS = 2_000;

/** The sidebar's Tools, and the Account menu's Connected tools…. The bar searches all context. */
export function openTools(): void {
  if (!state.status?.account || state.concealed) return;
  readSeq += 1;
  set({ route: { page: 'tools' }, list: null, roster: null, reader: null, ask: null, sources: null, toast: null, barScope: { kind: 'global' },
    organization: null, tools: { seq: ++seq, loading: false, items: null } });
  syncSearch();
  void loadToolList();
}

function toolsPage(mine?: number): ToolsPage | null {
  const page = state.tools;
  return page && state.route.page === 'tools' && (mine === undefined || page.seq === mine) ? page : null;
}

/** The list, read (again): on opening, Try again, and after a connection changes. */
export async function loadToolList(): Promise<void> {
  const account = expect();
  const page = toolsPage();
  if (!account || !page) return;
  const mine = page.seq;
  set({ tools: { ...page, loading: true, failure: undefined } });
  const result = await rpc('account.tools', { expect: account });
  const current = toolsPage(mine);
  if (!current) return;
  if (!result.ok) {
    set({ tools: { ...current, loading: false, failure: result.failure } });
    accountLost(result.failure);
    return;
  }
  set({ tools: { ...current, loading: false, items: result.value.tools, failure: undefined } });
}

function connectSheet(mine: number): ToolConnectSheet | null {
  const sheet = state.sheet;
  return sheet?.kind === 'tool-connect' && sheet.seq === mine ? sheet : null;
}

/**
 * Connect, Reconnect or Try again: the tool's page opens in the browser and
 * the sheet waits, reading the attempt every few seconds. A read is what
 * completes it, so the reads go on until it settles or is cancelled.
 */
export async function connectTool(tool: ConnectedTool): Promise<void> {
  const account = expect();
  if (!account || state.concealed || (state.sheet && state.sheet.kind !== 'tool-connect')) return;
  const mine = ++seq;
  set({ sheet: { kind: 'tool-connect', seq: mine, tool, phase: 'starting' } });
  const result = await rpc('tools.connect', { expect: account, tool_id: tool.tool_id });
  if (!connectSheet(mine)) {
    // Cancelled while the page was opening: the attempt it started is cancelled too.
    if (result.ok) void rpc('tools.cancel', { expect: account, tool_id: tool.tool_id, attempt_id: result.value.attempt_id });
    return;
  }
  if (!result.ok) {
    set({ sheet: { kind: 'tool-connect', seq: mine, tool, phase: 'failed', failure: result.failure } });
    accountLost(result.failure);
    return;
  }
  const attempt = result.value;
  set({ sheet: { kind: 'tool-connect', seq: mine, tool, phase: 'waiting', attempt } });
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, TOOL_POLL_MS));
    if (!connectSheet(mine)) return;
    const read = await rpc('tools.status', { expect: account, tool_id: tool.tool_id, attempt_id: attempt.attempt_id });
    if (!connectSheet(mine)) return;
    if (!read.ok) {
      if (ACCESS_LOST.includes(read.failure.code) || read.failure.code === 'account_changed') {
        set({ sheet: { kind: 'tool-connect', seq: mine, tool, phase: 'failed', failure: read.failure } });
        accountLost(read.failure);
        return;
      }
      // A slow or failed read says nothing about the attempt: read again until it would have expired.
      if (Date.now() <= Date.parse(attempt.expires_at)) continue;
      set({ sheet: { kind: 'tool-connect', seq: mine, tool, phase: 'failed', reason: 'expired' } });
      return;
    }
    const { status, failure_reason: reason } = read.value;
    if (status === 'pending') continue;
    if (status === 'complete') {
      set({ sheet: null, toast: `${tool.name} connected` });
      void loadToolList();
      return;
    }
    if (status === 'cancelled') { set({ sheet: null }); void loadToolList(); return; }
    set({ sheet: { kind: 'tool-connect', seq: mine, tool, phase: 'failed', reason: status === 'expired' ? 'expired' : reason ?? 'failed' } });
    return;
  }
}

/** Cancel, Close or Escape: a waiting attempt is cancelled, so a late approval in the browser binds nothing. */
export function cancelConnect(): void {
  const sheet = state.sheet;
  if (sheet?.kind !== 'tool-connect') return;
  const account = expect();
  set({ sheet: null });
  if (account && sheet.phase === 'waiting' && sheet.attempt) {
    void rpc('tools.cancel', { expect: account, tool_id: sheet.tool.tool_id, attempt_id: sheet.attempt.attempt_id });
  }
}

/** Account-fenced command for the personal meeting sheet. No provider token enters the renderer. */
export async function meetingCommand<K extends PersonMeetingOperationV2['operation']>(operation: PersonMeetingOperationV2 & { readonly operation: K }): Promise<PersonMeetingResultsV2[K]> {
  const account = expect();
  if (!account || state.concealed) throw new Error('Sign in to use meetings.');
  const result = await rpc('tools.meetings', { expect: account, request: { ...operation, schema_version: 2, tool_id: 'granola' } });
  if (JSON.stringify(expect()) !== JSON.stringify(account) || state.concealed) throw new Error('Account or screen changed.');
  if (!result.ok) { accountLost(result.failure); throw new Error(message(result.failure)); }
  return result.value as PersonMeetingResultsV2[K];
}

/** Account-fenced impact-check request for the personal meeting sheet: only your own approvals' runs. */
export async function runsCommand<K extends PersonRunsRequestV1['operation']>(request: PersonRunsRequestV1 & { readonly operation: K }): Promise<RunsResults[K]> {
  const account = expect();
  if (!account || state.concealed) throw new Error('Sign in to use meetings.');
  const result = await rpc('runs', { expect: account, request });
  if (JSON.stringify(expect()) !== JSON.stringify(account) || state.concealed) throw new Error('Account or screen changed.');
  if (!result.ok) { accountLost(result.failure); throw new Error(message(result.failure)); }
  return result.value as RunsResults[K];
}

/** Open in Jira, Confluence or Slack, from an impact card: the tool checks your access when it opens. */
export async function openImpactSource(source: ExternalAnswerSource): Promise<boolean> {
  return !state.concealed && (await rpc('source.openExternal', { kind: source.kind, permalink: source.permalink })).ok;
}

export function manageTool(tool: ConnectedTool): void {
  if (!state.status?.account || state.concealed || state.sheet) return;
  set({ sheet: { kind: 'tool-manage', tool, busy: false } });
}

/** Disconnect, from Manage: your own connection goes; the organization's stays. */
export async function disconnectTool(): Promise<void> {
  const sheet = state.sheet;
  const account = expect();
  if (sheet?.kind !== 'tool-manage' || sheet.busy || !account) return;
  set({ sheet: { ...sheet, busy: true, failure: undefined } });
  const result = await rpc('tools.disconnect', { expect: account, tool_id: sheet.tool.tool_id });
  if (state.sheet?.kind !== 'tool-manage' || state.sheet.tool.tool_id !== sheet.tool.tool_id) return;
  if (!result.ok) {
    set({ sheet: { ...sheet, busy: false, failure: result.failure } });
    accountLost(result.failure);
    void loadToolList();
    return;
  }
  set({ sheet: null, toast: `${sheet.tool.name} disconnected` });
  void loadToolList();
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
    state.change?.status === 'unknown' || projectSettingsBlocked() || (sheet?.kind === 'new-project' && newProjectBusy(sheet)) || state.employeeWrite !== null;
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
  const result = await rpc('projects.list', { expect: account, status: 'active', ...(cursor ? { cursor } : {}) });
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

/** Archived projects live in their own list: they can be opened, but never picked for new material. */
export async function loadArchivedProjects(more = false): Promise<void> {
  const account = expect();
  if (!account || (more && !state.archivedProjects.next)) return;
  const cursor = more ? state.archivedProjects.next ?? undefined : undefined;
  set({ archivedProjects: { ...state.archivedProjects, loading: true, failure: undefined } });
  const result = await rpc('projects.list', { expect: account, status: 'archived', ...(cursor ? { cursor } : {}) });
  if (!result.ok) {
    accountLost(result.failure);
    set({ archivedProjects: { ...state.archivedProjects, loading: false, failure: result.failure } });
    return;
  }
  const seen = new Set(more ? state.archivedProjects.items.map(project => project.project_id) : []);
  const items = [...(more ? state.archivedProjects.items : []), ...result.value.items.filter(project => !seen.has(project.project_id))];
  set({ archivedProjects: { items, next: result.value.next_cursor, loading: false } });
}

/** A project you were lead of is now one you are a member of, or the other way: a change of access. */
function rolesChanged(fresh: readonly ProjectSummary[]): boolean {
  const known = new Map(state.projects.items.map(project => [project.project_id, project.role]));
  return fresh.some(project => known.has(project.project_id) && known.get(project.project_id) !== project.role);
}

/** Back to Home as it was left: the same pages, the same scroll. The bar searches all context. */
export function goHome(): void {
  readSeq += 1;
  set({ route: { page: 'home' }, list: null, roster: null, reader: null, ask: null, sources: null, barScope: { kind: 'global' }, toast: null,
    organization: null, decision: null });
  syncSearch();
  void loadHome();
}

/**
 * The window came forward on Home: re-read the first page and keep the pages
 * loaded after it, so More projects is not lost.
 */
export async function refreshHome(): Promise<void> {
  const account = expect();
  if (!account || state.route.page !== 'home' || state.projects.loading) return;
  const result = await rpc('projects.list', { expect: account, status: 'active' });
  if (!result.ok) { accountLost(result.failure); return; }
  if (state.route.page !== 'home') return;
  const first = result.value.items;
  if (rolesChanged(first)) emptyBar();
  const seen = new Set(first.map(project => project.project_id));
  const loadedMore = state.projects.items.length > first.length;
  const later = loadedMore ? state.projects.items.slice(first.length).filter(project => !seen.has(project.project_id)) : [];
  set({ projects: { items: [...first, ...later], next: loadedMore ? state.projects.next : result.value.next_cursor, loading: false } });
  void loadArchivedProjects();
  void loadHome();
}

/** Opens a project, from Home or the sidebar: the bar's scope narrows to it, and its text stays. */
export async function openProject(project: ProjectSummary): Promise<void> {
  if (!expect()) return;
  readSeq += 1;
  set({
    route: { page: 'project', project }, reader: null, ask: null, sources: null, toast: null, organization: null,
    barScope: { kind: 'project', project_id: project.project_id },
    list: { scope: { kind: 'project', project_id: project.project_id }, opened: ++seq, items: [], next: null, loading: true },
  });
  syncSearch();
  void loadRoster(project.project_id);
  await loadList('first');
}

/**
 * Mine, from the sidebar or a toast: only what you added, newest first. The
 * bar asks about it (its chip is Mine); nothing is captured or dropped here.
 */
export async function openMine(): Promise<void> {
  if (!expect()) return;
  readSeq += 1;
  set({
    route: { page: 'mine' }, reader: null, ask: null, sources: null, toast: null, organization: null, roster: null, barScope: { kind: 'mine' },
    list: { scope: { kind: 'mine' }, opened: ++seq, items: [], next: null, loading: true },
  });
  syncSearch();
  await loadList('first');
}

/** The visit whose refused project list has already had your access read again. */
let accessCheckedVisit = 0;

/**
 * The list's first page (opening the page, or Try again with nothing shown),
 * its next page (More), or its first page again, quietly, after something
 * landed in it or left it. A quiet read leads with the first page and keeps
 * the older rows More loaded; it fails quietly, unless the account is gone.
 * While meetings wait to be indexed, a quiet read that would drop the
 * meetings shown is not applied. A project that refuses its list is one you
 * are no longer in: it says so, and your account and projects are read again
 * once per visit, but you are not signed out.
 */
async function loadList(how: 'first' | 'more' | 'quiet'): Promise<void> {
  const account = expect();
  const list = state.list;
  if (!account || !list || (how === 'more' && (!list.next || list.loading))) return;
  const { scope, opened } = list;
  const cursor = how === 'more' ? list.next! : undefined;
  if (how !== 'quiet') set({ list: { ...list, loading: true, failure: undefined } });
  const result = await rpc('list.page', { expect: account, scope, ...(cursor ? { cursor } : {}) });
  const current = state.list;
  if (current?.opened !== opened) return; // moved on
  const refused = !result.ok && result.failure.code === 'unauthorized' && scope.kind === 'project';
  if (how === 'quiet') {
    if (!result.ok) {
      if (!refused && ACCOUNT_GONE.includes(result.failure.code)) accountLost(result.failure);
      return;
    }
    if (result.value.meetings_held && current.items.some(item => item.ref.kind === 'meeting')) return;
    const rows = reread({ items: current.items, next: current.next }, { items: result.value.items, next: result.value.next_cursor }, refKey);
    set({ list: { ...current, items: rows.items, next: rows.next } });
    return;
  }
  if (!result.ok) {
    set({ list: { ...current, loading: false, failure: refused ? { ...result.failure, code: 'not_found' } : result.failure } });
    if (!refused) accountLost(result.failure);
    else if (accessCheckedVisit !== opened) {
      accessCheckedVisit = opened;
      void refreshStatus();
      void loadProjects();
    }
    return;
  }
  const page = result.value;
  if (how === 'first') { set({ list: { ...current, loading: false, items: [...page.items], next: page.next_cursor } }); return; }
  const seen = new Set(current.items.map(refKey));
  set({ list: { ...current, loading: false, items: [...current.items, ...page.items.filter(item => !seen.has(refKey(item)))], next: page.next_cursor } });
}

function refKey(item: ListItem): string { return `${item.ref.kind}:${item.ref.id}`; }

/** More: the list's next page. */
export function moreList(): Promise<void> { return loadList('more'); }

/** Try again: the first page when nothing shows, or else the page More could not read. */
export function retryList(): Promise<void> {
  const list = state.list;
  return list ? loadList(list.items.length === 0 && !list.next ? 'first' : 'more') : Promise.resolve();
}

/** Something landed in or left the list on screen: its first page again, and what shows stays. */
function refreshList(scope: ListScope): void {
  const list = state.list;
  if (list && sameList(list.scope, scope)) void loadList('quiet');
}

function sameList(a: ListScope, b: ListScope): boolean {
  return a.kind === b.kind && (a.kind === 'mine' || (b.kind === 'project' && a.project_id === b.project_id));
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

/** A row of the page's list, read in place: the list stays, and Back returns to it. */
export function openListItem(item: ListItem): Promise<void> {
  const route = state.route;
  if (route.page === 'mine') return openReader(item.ref, { kind: 'mine' });
  if (route.page !== 'project') return Promise.resolve();
  return openReader(item.ref, { kind: 'project', project_id: route.project.project_id });
}

/** A live match, read in place: the page stays, and Back returns to the matches. */
export function openMatch(match: Match): Promise<void> {
  const scope = state.matches?.scope;
  return openReader({ kind: 'note', id: match.context_id }, scope?.kind === 'project' ? { kind: 'project', project_id: scope.project_id } : { kind: 'search' });
}

/** The read on screen; a reply for one since closed or replaced is dropped. */
let readSeq = 0;

function sameRef(a: ItemRef | undefined, b: ItemRef): boolean {
  return a?.kind === b.kind && a.id === b.id;
}

/**
 * An item opened by its ref, under your current access: a note, a page of a
 * document's text (the first, or the one a cursor names), or a page of a
 * meeting's record, joined to what shows. While a page loads, what the
 * reader shows of that item stays.
 */
async function openReader(ref: ItemRef, from: ReaderFrom, cursor?: string): Promise<void> {
  const account = expect();
  if (!account) return;
  const mine = ++readSeq;
  const shown = sameRef(state.reader?.ref, ref) ? state.reader : null;
  const kept = {
    ...(shown?.content ? { content: shown.content, importedNext: shown.importedNext } : {}),
    ...(shown?.document ? { document: shown.document } : {}),
    ...(shown?.record ? { record: shown.record, recordNext: shown.recordNext } : {}),
  };
  set({ reader: { ref, from, loading: true, menu: 'closed', ...kept }, toast: null });
  const result = await rpc('open.ref', { expect: account, ref, ...(cursor ? { cursor } : {}) });
  if (!sameRef(state.reader?.ref, ref) || readSeq !== mine) return;
  if (!result.ok) {
    set({ reader: { ref, from, loading: false, menu: 'closed', failure: result.failure, ...kept } });
    accountLost(result.failure);
    return;
  }
  const opened = result.value;
  if (opened.kind === 'imported_meeting') {
    const content = cursor === undefined ? opened.content : kept.content ? { ...opened.content, text: kept.content.text + opened.content.text } : null;
    if (!content) return;
    set({ reader: { ref, from, loading: false, menu: 'closed', content, importedNext: opened.next_cursor } }); return;
  }
  if (opened.kind === 'note') { set({ reader: { ref, from, loading: false, menu: 'closed', content: opened.content } }); return; }
  if (opened.kind === 'document') { set({ reader: { ref, from, loading: false, menu: 'closed', document: opened.document } }); return; }
  const record = cursor === undefined ? opened.record : kept.record ? joinRecord(kept.record, opened.record) : null;
  // A page that does not go on from what shows is never joined to it.
  if (!record) { set({ reader: { ref, from, loading: false, menu: 'closed', failure: { code: 'invalid_output', retryable: true }, ...kept } }); return; }
  set({ reader: { ref, from, loading: false, menu: 'closed', record, recordNext: opened.next_cursor } });
}

/**
 * A meeting's next page, joined to the record shown: its three sections go
 * on. A long item left in parts goes on with the next page's first part,
 * which must be its very next part; anything else is refused (null).
 */
export function joinRecord(shown: ApprovedRecord, next: ApprovedRecord): ApprovedRecord | null {
  const join = (before: RecordSection, after: RecordSection): RecordSection | null => {
    const last = before.items.at(-1);
    const [first, ...rest] = after.items;
    const unfinished = last?.parts !== undefined && last.parts.to < last.parts.count;
    const continues = first?.parts !== undefined && first.parts.from > 1;
    if (!continues) return unfinished ? null : { items: [...before.items, ...after.items], more: false };
    const [was, goes] = [last?.parts, first!.parts!];
    if (!last || !was || was.to !== goes.from - 1 || was.count !== goes.count) return null;
    const text = last.text + first!.text;
    const { parts: _parts, ...item } = last;
    const joined: RecordItem = goes.to === goes.count && was.from === 1 ? { ...item, text: text.trim() } : { ...item, text, parts: { ...was, to: goes.to } };
    return { items: [...before.items.slice(0, -1), joined, ...rest], more: false };
  };
  const decisions = join(shown.decisions, next.decisions);
  const actions = join(shown.actions, next.actions);
  const rationales = join(shown.rationales, next.rationales);
  return decisions && actions && rationales ? { ...shown, decisions, actions, rationales } : null;
}

export function moreImportedMeeting(): void {
  const reader = state.reader;
  if (reader?.ref.kind !== 'imported_meeting' || !reader.importedNext || reader.loading) return;
  void openReader(reader.ref, reader.from, reader.importedNext);
}

/** More, under a meeting's record: its next page. */
export function moreRecord(): void {
  const reader = state.reader;
  if (reader?.ref.kind !== 'meeting' || !reader.recordNext || reader.loading) return;
  void openReader(reader.ref, reader.from, reader.recordNext);
}

/** Next text page, from the ⋯ menu. */
export function nextTextPage(): void {
  const reader = state.reader;
  const next = reader?.document?.next_cursor;
  if (reader?.ref.kind !== 'document' || !next || reader.loading) return;
  void openReader(reader.ref, reader.from, next);
}

/** Refresh document: its metadata and first text page again, as text extraction may have moved on. */
export function refreshDocument(): void {
  const reader = state.reader;
  if (reader?.ref.kind !== 'document' || reader.loading) return;
  void openReader(reader.ref, reader.from);
}

/**
 * Save original…: main asks where, and hands the page a handle for it, never
 * the path. The client writes the file only once it matches the original.
 */
export async function saveOriginal(): Promise<void> {
  const account = expect();
  const reader = state.reader;
  const document = reader?.document?.document;
  if (!account || reader?.ref.kind !== 'document' || !document || reader.save?.status === 'saving') return;
  set({ reader: { ...reader, menu: 'closed', save: undefined } });
  const chosen = await rpc('dialog.saveDocument', { name: document.filename });
  const stillHere = () => state.reader?.ref.id === document.document_id ? state.reader : null;
  if (!stillHere()) return;
  if (!chosen.ok) { set({ reader: { ...stillHere()!, save: { status: 'failed', failure: chosen.failure } } }); return; }
  if (!chosen.value) return; // cancelled
  set({ reader: { ...stillHere()!, save: { status: 'saving' } } });
  const result = await rpc('documents.save', { expect: account, document_id: document.document_id, save_handle: chosen.value.handle });
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

/**
 * A note or a document, once read, can be filed in projects. An approved
 * meeting cannot: its projects were set when it was approved.
 */
export function canFile(reader: ReaderState): boolean {
  return reader.ref.kind === 'document' ? reader.document !== undefined : reader.ref.kind === 'note' && reader.content !== undefined;
}

/** The reader's ⋯: a document's original and text pages, and where a note or document is filed. A meeting has none. */
export function hasReaderMenu(reader: ReaderState): boolean {
  return reader.ref.kind !== 'meeting';
}

/** The projects an original can be added to: yours, less the ones it is already filed in that the page knows of. */
export function projectChoices(current: State = state): ProjectSummary[] {
  const reader = current.reader;
  if (!reader || !canFile(reader)) return [];
  const filed = new Set(reader.content?.project_ids ?? reader.document?.document.project_ids ?? []);
  if (reader.from.kind === 'project') filed.add(reader.from.project_id);
  return current.projects.items.filter(project => project.status === 'active' && !filed.has(project.project_id));
}

/** What the reader shows can leave the project it was opened in. */
export function removableFrom(current: State = state): ProjectSummary | null {
  const { reader, route } = current;
  if (!reader || !canFile(reader) || route.page !== 'project') return null;
  return reader.from.kind === 'project' && reader.from.project_id === route.project.project_id ? route.project : null;
}

/** Remove from this project: the original stays, and so does who can read it. */
export function removeFromProject(): void {
  const reader = state.reader;
  const project = removableFrom();
  if (!reader || !project) return;
  set({ reader: { ...reader, menu: 'closed' } });
  void sendChange(reader.ref.kind === 'document'
    ? { kind: 'document-dissociate', project_id: project.project_id, document_id: reader.ref.id }
    : { kind: 'dissociate', project_id: project.project_id, context_id: reader.ref.id }, { project, origin: 'reader' });
}

/** Add to project: filed there too; who can read it does not change. */
export function addToProject(project: ProjectSummary): void {
  const reader = state.reader;
  if (!reader || project.status !== 'active' || !canFile(reader)) return;
  set({ reader: { ...reader, menu: 'closed' } });
  void sendChange(reader.ref.kind === 'document'
    ? { kind: 'document-associate', project_id: project.project_id, document_id: reader.ref.id }
    : { kind: 'associate', project_id: project.project_id, context_id: reader.ref.id }, { project, origin: 'reader' });
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
      if (reader?.ref.id === id) closeReader();
      // It left the project: it goes from the rows shown, older ones More loaded included.
      const list = state.list;
      if (list?.scope.kind === 'project' && list.scope.project_id === project.project_id) {
        set({ list: { ...list, items: list.items.filter(item => item.ref.id !== id) } });
      }
      set({ toast: `Removed from ${project.name}` });
      refreshList({ kind: 'project', project_id: project.project_id });
      return;
    }
    case 'associate':
    case 'document-associate': {
      const id = 'context_id' in change ? change.context_id : change.document_id;
      // Still reading it: the project it went to opens, and shows it.
      if (reader?.ref.id === id) void openProject(project);
      else refreshList({ kind: 'project', project_id: project.project_id });
      set({ toast: `Added to ${project.name}` });
      return;
    }
  }
}

// ---- project settings ----------------------------------------------------------

/** A project settings operation is unsettled until its exact receipt arrives. */
export function projectSettingsBlocked(current: State = state): boolean {
  const status = current.projectSettings?.write?.status;
  return status === 'sending' || status === 'unknown' || activeProjectMapping(current.projectSettings)?.status === 'saving';
}

export function toggleProjectSettings(target?: ProjectSummary, menuOrigin: 'header' | 'sidebar' = 'header'): void {
  const project = target ?? (state.route.page === 'project' ? state.route.project : null);
  if (!project || state.concealed || state.sheet || (state.compose && !state.compose.hidden) ||
      (menuOrigin === 'header' && (state.ask || state.reader)) || projectSettingsBlocked()) return;
  const shown = state.projectSettings;
  set({ projectSettings: shown?.project.project_id === project.project_id ? {
    ...clearProjectMappings(shown), menu: shown.menuOrigin !== menuOrigin || !shown.menu, menuOrigin, rename: null, confirm: null,
  } : {
    project, menu: true, menuOrigin, rename: null, confirm: null, write: null,
  } });
}

export function closeProjectSettings(): void {
  const settings = state.projectSettings;
  if (settings && !projectSettingsBlocked()) set({ projectSettings: null });
}

const PROJECT_MAPPING_TOOLS = ['jira', 'confluence'] as const;
type MappingTool = typeof PROJECT_MAPPING_TOOLS[number];
type MappingSetting<Tool extends MappingTool> = NonNullable<ProjectSettingsState[Tool]>;
type MappingValue<Tool extends MappingTool> = NonNullable<MappingSetting<Tool>['value']>;
function activeProjectMapping(settings: ProjectSettingsState | null): MappingSetting<MappingTool> | undefined {
  return PROJECT_MAPPING_TOOLS.map(tool => settings?.[tool]).find(setting => setting !== undefined);
}
function clearProjectMappings(settings: ProjectSettingsState): ProjectSettingsState {
  const cleared = { ...settings };
  for (const tool of PROJECT_MAPPING_TOOLS) delete cleared[tool];
  return cleared;
}
interface MappingAdapter<Tool extends MappingTool> {
  readonly tool: Tool;
  initial(seq: number): MappingSetting<Tool>;
  read(account: Expect, project_id: string): Promise<Result<MappingValue<Tool>>>;
  write(account: Expect, project_id: string, setting: MappingSetting<Tool>, remove: boolean, request_id: string): Promise<Result<MappingValue<Tool>>>;
  accepted(setting: MappingSetting<Tool>, value: MappingValue<Tool>): MappingSetting<Tool>;
  valid(setting: MappingSetting<Tool>): boolean;
}

const jiraMapping: MappingAdapter<'jira'> = {
  tool: 'jira', initial: seq => ({ seq, status: 'loading', key: '' }),
  read: (expect, project_id) => rpc('projects.jiraRead', { expect, project_id }),
  write: (expect, project_id, setting, remove, request_id) => rpc('projects.jiraSet', { expect, project_id, request_id,
    expected_revision: setting.value!.revision, jira_project: remove ? null : setting.key.trim() }),
  accepted: (setting, value) => ({ seq: setting.seq, status: 'ready', key: value.mapping?.project_key ?? '', value }),
  valid: setting => /^[A-Z][A-Z0-9_]{0,63}$/.test(setting.key.trim()) && setting.key.trim() !== setting.value?.mapping?.project_key,
};
const confluenceMapping: MappingAdapter<'confluence'> = {
  tool: 'confluence', initial: seq => ({ seq, status: 'loading', spaces: [], next: null, selected: [] }),
  read: (expect, project_id) => rpc('projects.confluenceRead', { expect, project_id }),
  write: (expect, project_id, setting, remove, request_id) => rpc('projects.confluenceSet', { expect, project_id, request_id,
    expected_revision: setting.value!.revision, space_ids: remove ? null : setting.selected }),
  accepted: (setting, value) => ({ ...setting, status: 'ready', value, selected: value.mapping?.space_ids ?? [] }),
  valid: setting => setting.pickerFailure === undefined && setting.selected.length > 0,
};

/** Every reply belongs to this account and this opening of the project sheet. */
function mappingAt<Tool extends MappingTool>(tool: Tool, account: Expect, opening: number) {
  const settings = state.projectSettings;
  const setting = settings?.[tool];
  return settings && setting?.seq === opening && expect()?.authority === account.authority && expect()?.membership_id === account.membership_id
    ? { settings, setting: setting as MappingSetting<Tool> } : undefined;
}
function setMapping<Tool extends MappingTool>(settings: ProjectSettingsState, tool: Tool, setting: MappingSetting<Tool>): void {
  set({ projectSettings: { ...settings, [tool]: setting } });
}
async function readProjectMapping<Tool extends MappingTool>(adapter: MappingAdapter<Tool>) {
  const settings = state.projectSettings;
  const account = expect();
  if (!settings || !account || projectSettingsBlocked()) return;
  const initial = adapter.initial(++seq);
  setMapping({ ...clearProjectMappings(settings), menu: false, rename: null, confirm: null }, adapter.tool, initial);
  const result = await adapter.read(account, settings.project.project_id);
  const current = mappingAt(adapter.tool, account, initial.seq);
  if (!current) return;
  const setting = result.ok ? adapter.accepted(initial, result.value) : { ...initial, status: 'failed' as const, failure: result.failure };
  setMapping(current.settings, adapter.tool, setting);
  if (!result.ok) { accountLost(result.failure); return; }
  return { account, settings: current.settings, setting };
}
async function saveProjectMapping<Tool extends MappingTool>(adapter: MappingAdapter<Tool>, remove: boolean): Promise<void> {
  const settings = state.projectSettings;
  const setting = settings?.[adapter.tool] as MappingSetting<Tool> | undefined;
  const account = expect();
  if (!settings || !setting?.value || !account || settings.project.role !== 'lead' || setting.status !== 'ready' ||
      (remove ? setting.value.mapping === null : !adapter.valid(setting))) return;
  setMapping(settings, adapter.tool, { ...setting, status: 'saving' });
  unresolvedChanged();
  const result = await adapter.write(account, settings.project.project_id, setting, remove, crypto.randomUUID());
  const current = mappingAt(adapter.tool, account, setting.seq);
  if (!current) return;
  setMapping(current.settings, adapter.tool, result.ok ? adapter.accepted(setting, result.value)
    : { ...setting, status: 'failed', failure: result.failure, writeFailed: true });
  unresolvedChanged();
  if (!result.ok) accountLost(result.failure);
}

export async function beginProjectJira(): Promise<void> { await readProjectMapping(jiraMapping); }
export const saveProjectJira = (remove = false): Promise<void> => saveProjectMapping(jiraMapping, remove);
export const saveProjectConfluence = (remove = false): Promise<void> => saveProjectMapping(confluenceMapping, remove);
export function setProjectJira(key: string): void {
  const settings = state.projectSettings;
  if (settings?.jira?.status === 'ready' && settings.project.role === 'lead') setMapping(settings, 'jira', { ...settings.jira, key: key.toUpperCase() });
}
export const projectJiraValid = (setting: ProjectJiraSetting): boolean => setting.status === 'ready' && jiraMapping.valid(setting);

/** Read the shared mapping first. Only leads need their personal space picker. */
export async function beginProjectConfluence(): Promise<void> {
  const loaded = await readProjectMapping(confluenceMapping);
  if (!loaded || loaded.settings.project.role !== 'lead') return;
  const spaces = await rpc('projects.confluenceSpaces', { expect: loaded.account });
  const current = mappingAt('confluence', loaded.account, loaded.setting.seq);
  if (!current) return;
  setMapping(current.settings, 'confluence', spaces.ok
    ? { ...current.setting, spaces: spaces.value.items, next: spaces.value.next_cursor }
    : { ...current.setting, pickerFailure: spaces.failure });
  if (!spaces.ok) accountLost(spaces.failure);
}
export function toggleProjectConfluenceSpace(id: string): void {
  const settings = state.projectSettings; const setting = settings?.confluence;
  if (!settings || !setting || setting.status !== 'ready' || settings.project.role !== 'lead' || !setting.spaces.some(space => space.id === id)) return;
  const selected = setting.selected.includes(id) ? setting.selected.filter(value => value !== id) : [...setting.selected, id];
  if (selected.length <= 20) setMapping(settings, 'confluence', { ...setting, selected });
}
export async function moreProjectConfluenceSpaces(): Promise<void> {
  const settings = state.projectSettings; const setting = settings?.confluence; const account = expect();
  if (!settings || !setting || !account || setting.status !== 'ready' || setting.next === null || setting.loadingMore) return;
  setMapping(settings, 'confluence', { ...setting, loadingMore: true });
  const result = await rpc('projects.confluenceSpaces', { expect: account, cursor: setting.next });
  const current = mappingAt('confluence', account, setting.seq);
  if (!current) return;
  setMapping(current.settings, 'confluence', result.ok
    ? { ...current.setting, spaces: [...current.setting.spaces, ...result.value.items.filter(space => !current.setting.spaces.some(old => old.id === space.id))], next: result.value.next_cursor, loadingMore: false }
    : { ...current.setting, loadingMore: false, failure: result.failure });
  if (!result.ok) accountLost(result.failure);
}

export function beginProjectRename(): void {
  const settings = state.projectSettings;
  if (!settings || settings.project.role !== 'lead' || projectSettingsBlocked()) return;
  set({ projectSettings: { ...settings, menu: false, confirm: null, rename: settings.project.name } });
}

export function setProjectRename(name: string): void {
  const settings = state.projectSettings;
  if (settings && settings.rename !== null && !projectSettingsBlocked()) set({ projectSettings: { ...settings, rename: name } });
}

export function cancelProjectSettingsAction(): void {
  const settings = state.projectSettings;
  if (settings && !projectSettingsBlocked()) set({ projectSettings: { ...clearProjectMappings(settings), rename: null, confirm: null, menu: false } });
}

export function askProjectSetting(action: 'archive' | 'unarchive' | 'leave'): void {
  const settings = state.projectSettings;
  if (!settings || projectSettingsBlocked() || (action !== 'leave' && settings.project.role !== 'lead')) return;
  set({ projectSettings: { ...settings, menu: false, rename: null, confirm: action } });
}

function settingsName(value: string): string | null {
  const name = value.normalize('NFC').trim();
  return name === '' || new TextEncoder().encode(name).byteLength > 200 || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(name) ? null : name;
}

export function projectRenameValid(name: string, previous: string): boolean {
  const valid = settingsName(name);
  return valid !== null && valid !== previous;
}

/** Rename sends the exact visible name; archive and leave begin only after their confirmation. */
export function confirmProjectSetting(): void {
  const settings = state.projectSettings;
  if (!settings || projectSettingsBlocked()) return;
  if (settings.rename !== null) {
    const name = settingsName(settings.rename);
    if (!projectRenameValid(settings.rename, settings.project.name) || name === null) return;
    void sendProjectSetting(settings.project, 'rename', { name });
    return;
  }
  if (!settings.confirm) return;
  const operation = settings.confirm === 'leave' ? 'leave' : 'archive';
  void sendProjectSetting(settings.project, operation, settings.confirm === 'leave' ? {} : { archived: settings.confirm === 'archive' });
}

async function sendProjectSetting(project: ProjectSummary, operation: 'rename' | 'archive' | 'leave', detail: { name?: string; archived?: boolean }, requestId: string = crypto.randomUUID()): Promise<void> {
  const account = expect();
  const settings = state.projectSettings;
  const retrying = settings?.write?.requestId === requestId;
  if (!account || !settings || settings.project.project_id !== project.project_id || (!retrying && projectSettingsBlocked())) return;
  const write = { requestId, operation, ...detail, status: 'sending' as const };
  set({ projectSettings: { ...settings, menu: false, rename: null, confirm: null, write } });
  unresolvedChanged();
  const result = operation === 'rename'
    ? await rpc('projects.rename', { expect: account, request_id: requestId, project_id: project.project_id, name: detail.name! })
    : operation === 'archive'
      ? await rpc('projects.archive', { expect: account, request_id: requestId, project_id: project.project_id, archived: detail.archived! })
      : await rpc('projects.leave', { expect: account, request_id: requestId, project_id: project.project_id });
  const current = state.projectSettings;
  if (current?.write?.requestId !== requestId) return;
  if (!result.ok) {
    const unknown = retrying || result.failure.mutation_outcome === 'unknown';
    set({ projectSettings: { ...current, write: { ...current.write, status: unknown ? 'unknown' : 'failed', failure: result.failure } } });
    unresolvedChanged();
    accountLost(result.failure);
    return;
  }
  set({ projectSettings: null });
  unresolvedChanged();
  appliedProjectSetting(project, operation, detail);
}

export function retryProjectSetting(): void {
  const settings = state.projectSettings;
  const write = settings?.write;
  if (!settings || !write || write.status !== 'unknown') return;
  void sendProjectSetting(settings.project, write.operation, { name: write.name, archived: write.archived }, write.requestId);
}

export function dismissProjectSetting(): void {
  const settings = state.projectSettings;
  if (settings?.write?.status === 'sending') return;
  if (settings?.write?.status === 'unknown' && !settings.write.dismissConfirm) {
    set({ projectSettings: { ...settings, write: { ...settings.write, dismissConfirm: true } } });
    return;
  }
  set({ projectSettings: null });
  unresolvedChanged();
}

export function keepProjectSetting(): void {
  const settings = state.projectSettings;
  if (settings?.write?.dismissConfirm) set({ projectSettings: { ...settings, write: { ...settings.write, dismissConfirm: false } } });
}

function replaceProject(project: ProjectSummary): void {
  const update = (items: ProjectSummary[]) => items.map(item => item.project_id === project.project_id ? project : item);
  set({ projects: { ...state.projects, items: update(state.projects.items) }, archivedProjects: { ...state.archivedProjects, items: update(state.archivedProjects.items) },
    ...(state.route.page === 'project' && state.route.project.project_id === project.project_id ? { route: { page: 'project' as const, project } } : {}) });
}

function appliedProjectSetting(project: ProjectSummary, operation: 'rename' | 'archive' | 'leave', detail: { name?: string; archived?: boolean }): void {
  if (operation === 'rename') {
    const fresh = { ...project, name: detail.name! };
    replaceProject(fresh);
    set({ toast: `Renamed to ${fresh.name}` });
    // Mine's rows name the projects they are filed in: every row shown takes the new name, then the first page is read again.
    // Rows hold names only, so when another of your projects had the old name, Mine is read again from its first page.
    const list = state.list;
    if (state.route.page === 'mine' && list?.scope.kind === 'mine') {
      const shared = [...state.projects.items, ...state.archivedProjects.items].some(item => item.project_id !== project.project_id && item.name === project.name);
      if (shared) { void loadList('first'); return; }
      set({ list: { ...list, items: renamedProject(list.items, project.name, fresh.name) } });
      refreshList({ kind: 'mine' });
    }
    return;
  }
  if (operation === 'archive') {
    const fresh = { ...project, status: detail.archived ? 'archived' as const : 'active' as const };
    const from = detail.archived ? state.projects : state.archivedProjects;
    const to = detail.archived ? state.archivedProjects : state.projects;
    const without = from.items.filter(item => item.project_id !== project.project_id);
    const moved = [...to.items.filter(item => item.project_id !== project.project_id), fresh];
    set({ ...(detail.archived ? { projects: { ...from, items: without }, archivedProjects: { ...to, items: moved } }
      : { archivedProjects: { ...from, items: without }, projects: { ...to, items: moved } }),
      ...(state.route.page === 'project' && state.route.project.project_id === project.project_id ? { route: { page: 'project' as const, project: fresh } } : {}),
      toast: detail.archived ? `Archived ${fresh.name}` : `Restored ${fresh.name}` });
    return;
  }
  forgetLeftProject(project.project_id);
  set({ toast: `Left ${project.name}` });
}

/** Leaving removes every local target for the project before returning Home. */
function forgetLeftProject(projectId: string): void {
  const projects = state.projects.items.filter(project => project.project_id !== projectId);
  const archivedProjects = state.archivedProjects.items.filter(project => project.project_id !== projectId);
  const compose = state.compose;
  let nextCompose = compose;
  if (compose) {
    const picked = compose.projects.filter(project => project.project_id !== projectId);
    const previous = compose.picking ? { ...compose.picking, projects: compose.picking.projects.filter(project => project.project_id !== projectId) } : null;
    nextCompose = { ...compose, context: compose.context?.project_id === projectId ? null : compose.context, projects: picked, picking: previous,
      ...(compose.readers === 'projects' && picked.length === 0 ? { readers: 'only-me' as const } : {}) };
  }
  readSeq += 1;
  emptyBar();
  set({ projects: { ...state.projects, items: projects }, archivedProjects: { ...state.archivedProjects, items: archivedProjects }, compose: nextCompose,
    route: { page: 'home' }, list: null, roster: null, reader: null, ask: null, sources: null, sheet: null, barScope: { kind: 'global' }, organization: null });
}

// ---- people ----------------------------------------------------------------------

/**
 * A sheet that finds people in a project's directory: People, or New project
 * once its project exists when the Authority has no organization directory.
 */
export type FindingSheet = PeopleSheet | (NewProjectSheet & { project: ProjectSummary });

export function findingSheet(current: State = state): FindingSheet | null {
  const sheet = current.sheet;
  return sheet?.kind === 'people' || (sheet?.kind === 'new-project' && sheet.project && sheet.peopleLater) ? sheet as FindingSheet : null;
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

/**
 * The current people picker's directory, searched by name or paged with More.
 * New project uses the organization's directory; a project's People sheet
 * (including New project's fallback) uses its directory and requires a lead.
 * Replies for a search or sheet that has moved on are discarded.
 */
export async function findPeople(more = false): Promise<void> {
  clearTimeout(peopleTimer);
  const account = expect();
  const sheet = newProjectSheet() ?? peopleSheet();
  if (!account || !sheet) return;
  const wholeOrganization = sheet.kind === 'new-project' && !sheet.peopleLater;
  if (!wholeOrganization && sheet.project?.role !== 'lead') return;
  const patch = (value: Partial<Finding>) => {
    if (wholeOrganization) setNewProject(value, sheet.seq);
    else setPeople(value, sheet.seq);
  };
  const cursor = more ? sheet.directory?.next : undefined;
  if (more && !cursor) return;
  const query = askText(sheet.query);
  const mine = ++seq;
  const shown = more ? sheet.directory?.items ?? [] : [];
  // A new project-directory search ends the last add's Undo.
  patch({ directory: { seq: mine, items: shown, next: sheet.directory?.next ?? null, loading: true },
    ...(!wholeOrganization && !more ? { added: null } : {}) });
  const params = { expect: account, ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) };
  const result = wholeOrganization ? await rpc('people.directory', params)
    : await rpc('projects.directory', { ...params, project_id: sheet.project!.project_id });
  const current = wholeOrganization ? newProjectSheet(sheet.seq) : peopleSheet(sheet.seq);
  if (!current || current.directory?.seq !== mine) return;
  if (!result.ok) {
    if (wholeOrganization && NO_DIRECTORY.includes(result.failure.code)) {
      setNewProject({ peopleLater: true, query: '', directory: null }, sheet.seq);
      return;
    }
    patch({ directory: { seq: mine, items: shown, next: null, loading: false, failure: result.failure } });
    accountLost(result.failure);
    return;
  }
  const seen = new Set(shown.map(person => person.membership_id));
  patch({ directory: {
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

/** New project takes up to 20 files. */
export const MAX_PROJECT_FILES = 20;
const TOO_MANY_FILES = 'Add up to 20 files.';
/** Said when New project closes after Create with files that may not have been saved, people who may not have been added, or both. */
export const UNSAVED_FILES = 'Some files may not have been saved.';
const UNADDED_PEOPLE = 'Some people may not have been added.';
const UNFINISHED = 'Some people and files may not have been added.';
/** The toasts that warn, shown with the warning mark. */
export const WARNINGS: ReadonlySet<string> = new Set([UNSAVED_FILES, UNADDED_PEOPLE, UNFINISHED]);
/** How an Authority without the organization directory answers it: the route is not there. */
const NO_DIRECTORY = ['not_found', 'unsupported'];

/** New project's people and files, numbered in one sequence. */
let rowIds = 0;

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

/** Something in New project is on its way: the create, the read of what it made, an add, or a file. */
export function newProjectBusy(sheet: NewProjectSheet): boolean {
  return sheet.create.status === 'sending' || sheet.opening || memberChangeSending() || sheet.picks.some(pick => pick.status === 'adding') ||
    sheet.files.some(file => file.status === 'saving' || file.status === 'checking');
}

/** A project's name as the API takes it: one line, trimmed, NFC, at most 200 UTF-8 bytes. */
export function projectName(text: string): string | null {
  const name = text.normalize('NFC').trim();
  return name === '' || new TextEncoder().encode(name).length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(name) ? null : name;
}

/** The sidebar's New project, and Home's when there are no projects. The organization's first people show at once. */
export function openNewProject(): void {
  if (!expect() || state.sheet || state.concealed || (state.compose && !state.compose.hidden)) return;
  set({
    toast: null,
    sheet: {
      kind: 'new-project', seq: ++seq, name: '', create: { requestId: crypto.randomUUID(), name: '', status: 'editing' }, confirmClose: false,
      project: null, createdId: null, opening: false, opened: false, picks: [], peopleLater: false, files: [], skip: null,
      query: '', directory: null, menu: null, confirm: null, added: null,
    },
  });
  void findPeople();
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
 * the project is read, and the people and files picked go into it. Made but
 * not read, the button reads it again (Open): it never creates twice.
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

/**
 * The project Create made, read: it joins your projects, and the people and
 * files picked go into it. Without the organization's directory, a lead now
 * finds people in the project's own.
 */
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
  setNewProject({ opening: false, project, notice: undefined }, mine);
  if (newProjectSheet(mine)?.peopleLater && project.role === 'lead') {
    void loadRoster(project.project_id);
    void findPeople();
  }
  pumpNewProject();
}

/**
 * Once the project exists, New project works down its list one request at a
 * time: each person, then each file. One whose outcome is unknown holds back
 * the rest until it is settled. When nothing more can start, the project
 * opens behind the sheet, once.
 */
function pumpNewProject(): void {
  const sheet = newProjectSheet();
  if (!sheet?.project) return;
  if (sheet.picks.some(pick => pick.status === 'adding') || sheet.files.some(file => file.status === 'saving' || file.status === 'checking')) return;
  const held = sheet.picks.some(pick => pick.status === 'unknown');
  const person = held ? undefined : sheet.picks.find(pick => pick.status === 'waiting');
  if (person) { void addPick(sheet.seq, person.id, false); return; }
  const file = held || sheet.files.some(entry => entry.status === 'unknown') ? undefined : sheet.files.find(entry => entry.status === 'waiting');
  if (file) { void saveFile(sheet.seq, file.id, false); return; }
  if (sheet.opened) return;
  setNewProject({ opened: true }, sheet.seq);
  void openProject(sheet.project);
}

/** The create, an add, or a file may have arrived and nothing says yet whether it did. */
export function newProjectUnsettled(sheet: NewProjectSheet): boolean {
  return (!sheet.project && !sheet.createdId && sheet.create.status === 'unknown') || sheet.picks.some(pick => pick.status === 'unknown') ||
    sheet.files.some(file => file.status === 'unknown');
}

/**
 * Close, Cancel or Done. A create, an add or a file whose outcome is unknown
 * is asked about once, as closing gives up its Try again; nothing on its way
 * is cut off.
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

/** Keep it: back to what may have arrived. */
export function keepNewProject(): void {
  if (newProjectSheet()) setNewProject({ confirmClose: false });
}

/**
 * New project goes. Copies kept to resend a file go too, as nothing can
 * resend them now. Once the project was made, the toast says if some people
 * were not added to it or some files not saved into it, or may not have been.
 * Before Create nothing was sent, so nothing is said.
 */
function finishNewProject(sheet: NewProjectSheet): void {
  for (const file of sheet.files) if (file.kept) releaseCopy(file.requestId);
  const made = sheet.createdId !== null;
  const people = made && sheet.picks.some(pick => pick.status !== 'added');
  const files = made && sheet.files.some(file => file.status !== 'saved');
  const toast = people && files ? UNFINISHED : people ? UNADDED_PEOPLE : files ? UNSAVED_FILES : null;
  set({ sheet: null, ...(toast ? { toast } : {}) });
  unresolvedChanged();
  if (!sheet.project) return;
  refreshList({ kind: 'project', project_id: sheet.project.project_id });
  // Someone added after the project opened shows in its title bar too.
  if (state.roster?.projectId === sheet.project.project_id) void loadRoster(sheet.project.project_id);
}

function releaseCopy(requestId: string): void {
  const account = expect();
  if (account) void rpc('documents.abandon', { expect: account, request_id: requestId });
}

// People, picked on the page from the organization's directory.

/** Typing a name finds the organization's people once it pauses. */
export function setPickQuery(query: string): void {
  const sheet = newProjectSheet();
  if (!sheet || sheet.peopleLater) return;
  setNewProject({ query });
  clearTimeout(peopleTimer);
  peopleTimer = setTimeout(() => void findPeople(), SEARCH_PAUSE_MS);
}

/** The people found who can be picked: not you, who lead it, and not picked already. */
export function pickable(current: State = state): readonly Member[] {
  const sheet = current.sheet;
  if (sheet?.kind !== 'new-project' || sheet.peopleLater || !sheet.directory) return [];
  const me = current.status?.account?.membership_id;
  const picked = new Set(sheet.picks.map(pick => pick.person.membership_id));
  return sheet.directory.items.filter(person => person.membership_id !== me && !picked.has(person.membership_id));
}

/** Add: listed at once. Before the project exists nothing is sent; after, they are added in turn. */
export function pickPerson(person: Member): void {
  const sheet = newProjectSheet();
  if (!sheet || !pickable().some(entry => entry.membership_id === person.membership_id)) return;
  const pick: ProjectPick = {
    id: ++rowIds, person: { membership_id: person.membership_id, display_name: person.display_name }, requestId: crypto.randomUUID(), status: 'waiting',
  };
  setNewProject({ picks: [...sheet.picks, pick] });
  pumpNewProject();
}

/** ×: a person or a file never sent leaves the list. */
export function removeRow(id: number): void {
  const sheet = newProjectSheet();
  if (!sheet) return;
  setNewProject({
    picks: sheet.picks.filter(pick => pick.id !== id || pick.status !== 'waiting'),
    files: sheet.files.filter(file => file.id !== id || !unsent(file)),
  });
}

/** A file nothing was sent for: waiting its turn, or one main refused. */
export function unsent(file: ProjectFile): boolean {
  return file.status === 'waiting' || (file.status === 'failed' && !file.handle);
}

/** A person moves on (Try again, Skip, or the add): a close question asked before it no longer stands. */
function patchPick(mine: number, id: number, patch: Partial<ProjectPick>): void {
  const sheet = newProjectSheet(mine);
  if (sheet) setNewProject({ picks: sheet.picks.map(pick => pick.id === id ? { ...pick, ...patch } : pick), confirmClose: false }, mine);
}

/** Adds a person picked to the new project, or resends the same request (Try again). Only the receipt says they were added. */
async function addPick(mine: number, id: number, retrying: boolean): Promise<void> {
  const account = expect();
  const sheet = newProjectSheet(mine);
  const pick = sheet?.picks.find(entry => entry.id === id);
  if (!account || !sheet?.project || !pick) return;
  patchPick(mine, id, { status: 'adding', failure: undefined });
  const result = await rpc('projects.change', {
    expect: account, request_id: pick.requestId,
    change: { kind: 'member-add', project_id: sheet.project.project_id, membership_id: pick.person.membership_id },
  });
  if (!newProjectSheet(mine)?.picks.some(entry => entry.id === id)) return;
  if (!result.ok) {
    // Only the Authority's answer settles an unknown add: a failed resend leaves it unknown.
    const unknown = retrying || result.failure.mutation_outcome === 'unknown';
    patchPick(mine, id, { status: unknown ? 'unknown' : 'failed', failure: result.failure });
    accountLost(result.failure);
    // Refused, the rest carry on; unknown, they wait, and the project opens meanwhile.
    pumpNewProject();
    return;
  }
  patchPick(mine, id, { status: 'added' });
  pumpNewProject();
}

/** Try again: the same add, under the same request id. */
export function retryPick(id: number): void {
  const sheet = newProjectSheet();
  const pick = sheet?.picks.find(entry => entry.id === id);
  if (!sheet || pick?.status !== 'unknown' || newProjectBusy(sheet)) return;
  void addPick(sheet.seq, id, true);
}

// Files, added on the page and saved into the project once it exists.

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

/** Files dropped on New project: each is handed to main on its own, which answers with a handle. */
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

/** Files join the list, and save in turn once the project exists; one main refused says why. */
function addFiles(mine: number, chosen: readonly { name: string; handle?: FileHandle; failure?: Failure }[]): void {
  const sheet = newProjectSheet(mine);
  if (!sheet || chosen.length === 0) return;
  if (sheet.files.length + chosen.length > MAX_PROJECT_FILES) { setNewProject({ notice: TOO_MANY_FILES }, mine); return; }
  const added: ProjectFile[] = chosen.map(file => ({
    id: ++rowIds, name: file.name, requestId: crypto.randomUUID(), kept: false,
    ...(file.handle ? { handle: file.handle, status: 'waiting' as const } : { status: 'failed' as const, failure: file.failure }),
  }));
  setNewProject({ files: [...sheet.files, ...added], notice: undefined }, mine);
  pumpNewProject();
}

/** A file moves on (Check status, Try again, or its save): a close question asked before it no longer stands. */
function patchFile(mine: number, id: number, patch: Partial<ProjectFile>): void {
  const sheet = newProjectSheet(mine);
  if (sheet) setNewProject({ files: sheet.files.map(file => file.id === id ? { ...file, ...patch } : file), confirmClose: false }, mine);
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
    : await rpc('documents.upload', {
      expect: account, request_id: file.requestId, file_handle: file.handle!.handle, title: file.name, audience, project_ids: [project_id],
    });
  const current = newProjectSheet(mine)?.files.find(entry => entry.id === id);
  if (!current) return;
  if (!result.ok) {
    // Only the Authority's answer settles an unknown save: a failed resend leaves it unknown.
    const unknown = retrying || result.failure.mutation_outcome === 'unknown';
    patchFile(mine, id, { status: unknown ? 'unknown' : 'failed', failure: result.failure, kept: current.kept || unknown });
    accountLost(result.failure);
    // Refused, the rest carry on; unknown, they wait, and the project opens meanwhile.
    pumpNewProject();
    return;
  }
  patchFile(mine, id, { status: 'saved', kept: false, ...(result.value.extraction ? { extraction: result.value.extraction } : {}) });
  pumpNewProject();
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
    pumpNewProject();
    return;
  }
  if (result.ok && result.value.state === 'not_saved') {
    // It never arrived: Try again resends it, and the rest carry on meanwhile.
    patchFile(mine, id, { status: 'failed', failure: { code: 'not_saved', retryable: true } });
    pumpNewProject();
    return;
  }
  patchFile(mine, id, { status: 'unknown' });
  if (!result.ok) accountLost(result.failure);
}

/** Skip…: asked first, since the person may have been added or the file saved. */
export function askSkip(id: number): void {
  const sheet = newProjectSheet();
  if (sheet?.picks.some(pick => pick.id === id && pick.status === 'unknown') || sheet?.files.some(file => file.id === id && file.status === 'unknown')) {
    setNewProject({ skip: id });
  }
}

export function cancelSkip(): void { setNewProject({ skip: null }); }

/** Skip: the person or file is left as it is (a file's kept copy goes), and the rest carry on. */
export function confirmSkip(): void {
  const sheet = newProjectSheet();
  const pick = sheet?.picks.find(entry => entry.id === sheet.skip && entry.status === 'unknown');
  const file = sheet?.files.find(entry => entry.id === sheet.skip && entry.status === 'unknown');
  if (!sheet || (!pick && !file)) { cancelSkip(); return; }
  if (file?.kept) releaseCopy(file.requestId);
  setNewProject({
    skip: null, confirmClose: false,
    picks: sheet.picks.map(entry => entry === pick ? { ...entry, status: 'skipped' as const } : entry),
    files: sheet.files.map(entry => entry === file ? { ...entry, status: 'skipped' as const, kept: false } : entry),
  });
  pumpNewProject();
}

/** Files can be dropped on New project, one or more, while it is up. */
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
    route: { page: 'organization' }, list: null, roster: null, reader: null, ask: null, sources: null, toast: null, barScope: { kind: 'global' },
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

/** A new employee's email as the Authority takes it. */
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
  if (scope.kind === 'mine') return 'Mine';
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
  const cancelId = crypto.randomUUID();
  activeAskCancelId = cancelId;
  const asking: AskQuestion = { question: text, scope, scopeName: scopeName(scope) };
  set({ ask: { seq: mine, earlier: thread?.earlier ?? [], previous: thread?.shown ?? null, shown: null, asking, failed: null }, sources: null, toast: null });
  const result = await rpc('ask.run', { expect: account, question: text, scope, cancel_id: cancelId });
  if (activeAskCancelId === cancelId) activeAskCancelId = null;
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

/**
 * A project question whose answer cites nothing: nothing in the project
 * matched. Ask never widens on its own (ADR-0015); the reader may ask the same
 * question across everything they can read, with one tap.
 */
export function foundNothingInProject(turn: AskTurn): boolean {
  // An off-scope answer would not change with a wider ask.
  return turn.scope.kind === 'project' && turn.answer.sources.length === 0 && turn.answer.outcome !== 'off_scope';
}

/**
 * Ask across everything you can see: the current answer's question again, in
 * all accessible context. The bar widens with it, as its × would, so the chip
 * goes and follow-ups ask there too. The project answer stays in the thread.
 */
export function askEverywhere(): void {
  const turn = state.ask?.shown;
  if (!turn || state.ask?.asking || !foundNothingInProject(turn)) return;
  widenScope();
  void ask(turn.question, { kind: 'global' });
}

/** Cancel, while asking: the answer before comes back, or with none Ask closes. A late answer is dropped. */
export function cancelAsk(): void {
  const thread = state.ask;
  if (!thread?.asking) return;
  const cancelId = activeAskCancelId;
  activeAskCancelId = null;
  if (cancelId) void rpc('ask.cancel', { cancel_id: cancelId });
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
  const cancelId = activeAskCancelId;
  activeAskCancelId = null;
  if (cancelId) void rpc('ask.cancel', { cancel_id: cancelId });
  set({ ask: null, sources: null });
  syncSearch();
}

// ---- an answer's sources -----------------------------------------------------

/** What the pane may show: at most 32 sources. */
export const MAX_SOURCES = 32;

/** The citations of the answer on screen. */
export function answerSources(current: State = state): readonly AnswerSource[] {
  return current.ask?.shown?.answer.sources.slice(0, MAX_SOURCES) ?? [];
}

/** The answer's sources, numbered from one: each document, meeting record or Slack message it cites. */
export function answerGroups(current: State = state): SourceGroup[] {
  return sourceGroups(answerSources(current));
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
  set({ sources: { gen, open: null, focus: null, records: {}, evidence: null } });
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

/**
 * A source's number or row: the pane opens beside the answer on that source,
 * read unless it already was. A sentence's number also names the sentence.
 */
export function chooseSource(group: number, focus: string | null = null): void {
  const sources = state.sources;
  const chosen = answerGroups()[group];
  const source = chosen ? answerSources()[chosen.indexes[0]!] : undefined;
  if (!sources || !source) return;
  set({ sources: { ...sources, open: group, focus, evidence: null } });
  if (source.kind === 'original') { void readEvidence(sources.gen, group); return; }
  if ('permalink' in source) return;
  const read = sources.records[source.record.record_sha256];
  if (!read || (!read.loading && 'failure' in read)) void readRecord(sources.gen, source.record, false);
}

/** External providers check current access when the person opens a cited link. */
export async function openExternalSource(index: number): Promise<boolean> {
  const source = answerSources()[index];
  return !state.concealed && source !== undefined && 'permalink' in source &&
    (await rpc('source.openExternal', { kind: source.kind, permalink: source.permalink })).ok;
}

/** × on the pane: it closes, and forgets the passages it read. */
export function closeSources(): void {
  const sources = state.sources;
  if (sources) set({ sources: { ...sources, open: null, focus: null, evidence: null } });
}

/** Passages read at once: each is its own client call. */
const EVIDENCE_READS_AT_ONCE = 3;

/** An original's cited passages, each a verified evidence packet, read in order each time it is chosen. */
async function readEvidence(gen: number, group: number): Promise<void> {
  const account = expect();
  const answer = state.ask?.shown?.answer;
  const indexes = answerGroups()[group]?.indexes ?? [];
  const sources = sourcesAt(gen);
  if (!account || !answer || !sources || indexes.length === 0) return;
  const mine = ++seq;
  set({ sources: { ...sources, evidence: { seq: mine, group, reads: Object.fromEntries(indexes.map(index => [index, { loading: true }])) } } });
  let next = 0;
  const reader = async () => {
    // A pane that moved on, or another app in front, stops the rest.
    while (next < indexes.length && sourcesAt(gen)?.evidence?.seq === mine) {
      const index = indexes[next++]!;
      const source = answerSources()[index];
      if (source?.kind !== 'original') continue;
      const result = await rpc('ask.source', { expect: account, scope: answer.scope, ref: source.ref });
      // Replies for another source or answer, or that land while another app is in front, are dropped.
      const now = sourcesAt(gen);
      if (now?.evidence?.seq !== mine) return;
      set({ sources: { ...now, evidence: { ...now.evidence, reads: { ...now.evidence.reads,
        [index]: result.ok ? { loading: false, value: result.value } : { loading: false, failure: result.failure } } } } });
      if (!result.ok) accountLost(result.failure);
    }
  };
  await Promise.all(Array.from({ length: Math.min(EVIDENCE_READS_AT_ONCE, indexes.length) }, reader));
}

/** Try again, on the original the pane shows: all its passages, read again. */
export function retryEvidence(): void {
  const sources = state.sources;
  if (sources?.open != null) void readEvidence(sources.gen, sources.open);
}

/** Try again, on an approved record that could not be read. */
export function retryRecord(): void {
  const sources = state.sources;
  const chosen = sources?.open != null ? answerGroups()[sources.open] : undefined;
  const source = chosen ? answerSources()[chosen.indexes[0]!] : undefined;
  if (sources && source?.kind === 'record') void readRecord(sources.gen, source.record, false);
}

// ---- the bar: live search -------------------------------------------------------

/** Typing searches once it pauses. */
const SEARCH_PAUSE_MS = 250;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

function sameScope(a: AskScope, b: AskScope): boolean {
  return a.kind === b.kind && (a.kind !== 'project' || (b.kind === 'project' && a.project_id === b.project_id));
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
  // Mine is not searched: the bar only asks it.
  if (wanted.scope.kind === 'mine') { set({ matches: { seq: ++seq, query: wanted.query, scope: wanted.scope, loading: false, items: [] } }); return; }
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
 * Another app is in front and the page is covered: a project, Mine, People &
 * invites, Tools, Home, a decision, an answer or an original. The bar's text is covered with it.
 */
export function pageCovered(current: State = state): boolean {
  const { route } = current;
  return current.concealed && (current.ask !== null || route.page === 'home' || route.page === 'decision' || route.page === 'project' || route.page === 'mine' || current.reader !== null ||
    (route.page === 'organization' && current.organization !== null) || (route.page === 'tools' && current.tools !== null));
}

/** What the chip names while its page is on screen: the project, or Mine. */
export function chipName(current: State = state): string | null {
  const { route, barScope } = current;
  if (current.concealed) return null;
  if (route.page === 'mine' && barScope.kind === 'mine') return 'Mine';
  return route.page === 'project' && barScope.kind === 'project' && barScope.project_id === route.project.project_id ? route.project.name : null;
}

// ---- capture -----------------------------------------------------------------

const NOTE_OR_FILE = 'Save this note before attaching a file.';
/** What a note may hold, as the API takes it: 8 KiB of text. */
const MAX_NOTE_BYTES = 8 * 1024;
const TOO_LONG = 'Up to 8 KiB of text.';

/** What main's quit guard was last told. */
let unresolvedTold = '';

/**
 * Main's quit guard: a note, a file or a project change (a create, and New
 * project's adds, included) on its way, or not yet confirmed either way.
 */
function unresolvedChanged(): void {
  const compose = state.compose;
  const saving = compose?.status === 'sending' || compose?.status === 'unknown' || compose?.status === 'checking';
  const sheet = state.sheet?.kind === 'new-project' ? state.sheet : null;
  const uploading = sheet?.files.some(file => file.status === 'saving' || file.status === 'checking' || file.status === 'unknown') === true;
  const changing = changeBlocked() || projectSettingsBlocked() || sheet?.create.status === 'sending' || sheet?.create.status === 'unknown' ||
    sheet?.picks.some(pick => pick.status === 'adding' || pick.status === 'unknown') === true;
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
    seq: ++seq, text: '', file: null, context: project, projects: project ? [project] : [], readers: project ? 'projects' : 'only-me',
    picking: null, status: 'editing', requestId: crypto.randomUUID(), kept: false, hidden: false, confirmNew: false,
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
  return state.route.page === 'project' && !state.concealed && state.route.project.status === 'active' ? state.route.project : null;
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
  // New project stays in front, as Capture would open under it. Files dropped on it go into its project.
  if (state.sheet?.kind === 'new-project' || activeProjectMapping(state.projectSettings) !== undefined) return;
  set({ toast: null });
  setCompose(current ? { ...current, hidden: false } : fresh(null));
}

/** Escape or Close hides the sheet and keeps the draft. */
export function closeCompose(): void {
  if (!state.compose || state.compose.status === 'sending' || state.compose.status === 'checking') return;
  closeProjects();
  setCompose({ ...state.compose, hidden: true, confirmNew: false, notice: undefined });
}

function locked(compose: ComposeState): boolean {
  return compose.status === 'sending' || compose.status === 'checking' || compose.status === 'unknown';
}

function editCompose(patch: Partial<ComposeState>): void {
  const compose = state.compose;
  if (!compose || locked(compose)) return;
  // Any change to what would be saved, for whom, or where it is filed, makes it a new request.
  const changesContent = 'text' in patch || 'file' in patch || 'projects' in patch || 'readers' in patch;
  if (changesContent) release(compose);
  setCompose({ ...compose, notice: undefined, ...patch,
    ...(changesContent ? { requestId: crypto.randomUUID(), kept: false, status: 'editing' as const, failure: undefined } : {}) });
}

export function setComposeText(text: string): void { editCompose({ text }); }

/**
 * A choice in Who can read. Only me and Organization keep the projects
 * ticked: the capture stays filed in them. Chosen with the list open, they
 * close it as it stands, so projects just unticked stay unticked. Projects
 * with none ticked has nothing to save until one is.
 */
export function chooseReaders(readers: Readers): void {
  const compose = state.compose;
  if (!compose || locked(compose)) return;
  if (compose.picking && readers !== 'projects') { editCompose({ picking: null, readers }); return; }
  closeProjects();
  if (readers !== state.compose!.readers) editCompose({ readers });
}

/**
 * Projects: choosing it opens the list of projects to tick, and choosing it
 * again closes the list.
 */
export function openProjects(): void {
  const compose = state.compose;
  if (!compose || locked(compose)) return;
  if (compose.picking) { closeProjects(); return; }
  const picking = { readers: compose.readers, projects: compose.projects };
  if (compose.readers === 'projects') setCompose({ ...compose, picking });
  else editCompose({ readers: 'projects', picking });
}

/** Ticks a project in the list, or unticks it. No more than the API takes. */
export function tickProject(project: ProjectSummary): void {
  const compose = state.compose;
  if (!compose?.picking || project.status !== 'active') return;
  const ticked = compose.projects.some(entry => entry.project_id === project.project_id);
  if (!ticked && compose.projects.length >= MAX_CAPTURE_PROJECTS) return;
  editCompose({ projects: ticked ? compose.projects.filter(entry => entry.project_id !== project.project_id) : [...compose.projects, project] });
}

/** Done, a click outside or Escape: closed with none ticked, the choice goes back to what it was before. */
export function closeProjects(): void {
  const compose = state.compose;
  if (!compose?.picking) return;
  if (compose.projects.length > 0) setCompose({ ...compose, picking: null });
  else editCompose({ picking: null, readers: compose.picking.readers, projects: compose.picking.projects });
}

/** A few project names, the short way: "tdk", "tdk and lin", "tdk, lin and 1 more". */
export function projectNames(projects: readonly ProjectSummary[]): string {
  const names = projects.map(project => project.name);
  return names.length <= 2 ? names.join(' and ') : `${names[0]}, ${names[1]} and ${names.length - 2} more`;
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

/** Projects with none ticked: nothing to save yet. */
export function choosingProjects(compose: ComposeState): boolean {
  return compose.readers === 'projects' && compose.projects.length === 0;
}

/** A project moved to Archived after a draft started cannot be silently replaced with a different audience. */
function archivedComposeTarget(compose: ComposeState): ProjectSummary | null {
  // Home can hold only its first active page. Absence from that page says
  // nothing about a target chosen from a later page, so only a known archived
  // record (or the target's own current status) closes the admission path.
  const archived = new Set(state.archivedProjects.items.map(project => project.project_id));
  const unavailable = (project: ProjectSummary) => project.status === 'archived' || archived.has(project.project_id);
  const target = compose.projects.find(unavailable) ??
    (compose.projects.length === 0 && compose.context && unavailable(compose.context) ? compose.context : null);
  return target ?? null;
}

/** One project's members, or several projects' (sorted, so a resend is the identical request). */
function audienceOf(compose: ComposeState): Audience {
  if (compose.readers === 'team') return { kind: 'team' };
  if (compose.readers !== 'projects' || compose.projects.length === 0) return { kind: 'only-me' };
  const ids = compose.projects.map(project => project.project_id).sort();
  return ids.length === 1 ? { kind: 'project', project_id: ids[0]! } : { kind: 'projects', project_ids: ids };
}

/** Where it is filed: the projects ticked, or else the project Capture was opened for. */
function filedIn(compose: ComposeState): string[] {
  const projects = compose.projects.length > 0 ? compose.projects : compose.context ? [compose.context] : [];
  return projects.map(project => project.project_id).sort();
}

/** A document's extraction state, in the app's own words. */
export const EXTRACTION: Record<Extraction, string> = {
  extracting: 'Extracting text', ready: 'Text ready', partial: 'Partial text', no_text: 'No searchable text',
  encrypted: 'Encrypted · text unavailable', malformed: 'Unreadable document · text unavailable',
  limit_exceeded: 'Extraction limit reached', timed_out: 'Text extraction timed out', unsupported: 'Text unavailable',
  unavailable: 'Text unavailable',
};

/** Where an Only me save, or one for the whole organization, went: Mine, which its toast opens. */
const SAVED_FOR_YOU = 'Saved for you';
const SHARED = 'Shared with your organization';

/** Where a confirmed save went, and for a file how its text is coming along. */
function savedLabel(compose: ComposeState, extraction: Extraction | undefined): string {
  const where = compose.readers === 'team' ? SHARED
    : compose.readers === 'projects' && compose.projects.length > 0 ? `Saved to ${projectNames(compose.projects)}` : SAVED_FOR_YOU;
  return compose.file && extraction ? `${where} · ${EXTRACTION[extraction]}` : where;
}

/** A save no project page shows says where it went, and a click opens Mine on it. */
export function toastOpensMine(toast: string): boolean {
  return [SAVED_FOR_YOU, SHARED].some(where => toast === where || toast.startsWith(`${where} · `));
}

/**
 * The Authority confirmed it: the sheet closes itself, and the toast says
 * where it went. The list on screen that holds it is read again: Mine holds
 * every save, a project page what is filed in it.
 */
function saved(compose: ComposeState, extraction: Extraction | undefined): void {
  setCompose(null);
  set({ toast: savedLabel(compose, extraction) });
  const route = state.route;
  if (route.page === 'mine') refreshList({ kind: 'mine' });
  if (route.page === 'project' && filedIn(compose).includes(route.project.project_id)) refreshList({ kind: 'project', project_id: route.project.project_id });
}

/** Save, or resend the exact same request after an unconfirmed outcome. */
export async function sendCompose(): Promise<void> {
  const account = expect();
  const compose = state.compose;
  if (!account || !compose || compose.status === 'sending' || compose.status === 'checking') return;
  if ((!compose.file && compose.text.trim() === '') || choosingProjects(compose)) return;
  const retrying = compose.status === 'unknown';
  // Retrying an accepted upload is not a new admission. Its immutable request
  // must reach the Authority even if the project was archived meanwhile.
  const archived = retrying ? null : archivedComposeTarget(compose);
  if (archived) {
    setCompose({ ...compose, notice: `${archived.name} is archived. Restore it or choose another project.` });
    return;
  }
  // Too long is said here, before anything is sent, not as a refusal.
  if (!compose.file && !retrying && new TextEncoder().encode(compose.text).length > MAX_NOTE_BYTES) {
    setCompose({ ...compose, notice: TOO_LONG });
    return;
  }
  // ⌘↩ from the Projects list saves: the list closes with what is ticked.
  setCompose({ ...compose, status: 'sending', picking: null, failure: undefined, confirmNew: false, notice: undefined });
  const audience = audienceOf(compose);
  const project_ids = filedIn(compose);
  let result: Result<Receipt>;
  if (compose.file && retrying) {
    // The client kept the original: resend it, not whatever the path holds now.
    result = await rpc('documents.retry', { expect: account, request_id: compose.requestId, audience });
  } else if (compose.file) {
    result = await rpc('documents.upload', {
      expect: account, request_id: compose.requestId, file_handle: compose.file.handle, title: compose.file.name, audience, project_ids,
    });
  } else {
    result = await rpc('notes.submit', { expect: account, request_id: compose.requestId, text: compose.text, audience, project_ids });
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
  setCompose({ ...fresh(compose.context), readers: compose.readers, projects: compose.projects });
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

/** The window takes a file dropped anywhere but a project row: not on Mine, which only shows and asks, unless Capture is up over it. */
export function windowTakesDrop(current: State = state): boolean {
  return current.route.page !== 'mine' || Boolean(current.compose && !current.compose.hidden);
}

/**
 * A dropped file. On the open sheet it is attached, and who can read it
 * stays; on a project row it is captured into that project; anywhere else
 * into the project on screen, or Only me. A draft with words in it, or a save
 * not yet settled, is never changed: it comes back and says the file was not
 * attached.
 */
export async function acceptDrop(file: File, on: ProjectSummary | 'window' | 'sheet'): Promise<void> {
  if (!expect() || state.sheet || (on === 'window' && !windowTakesDrop())) return;
  const target = on === 'window' || on === 'sheet' ? (on === 'window' ? state.route.page === 'project' ? state.route.project : null : null) : on;
  if (target?.status === 'archived') { set({ toast: 'Restore this project to add files or notes.' }); return; }
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
  stopRunPolling();
  // The source pane closes and forgets what it read; the records are read again on return.
  const reading = state.sources !== null;
  // People closes, as Home's and the sidebar's rows must take a drop; unless a change in it is on its way.
  const people = state.sheet?.kind === 'people' && !memberChangeSending();
  // New project stays: files are dropped on it from other apps.
  // People & invites closes what is open in it, and an invitation just saved is no longer offered back (its Undo ends).
  set({
    concealed: true, ...(reading ? { sources: { ...state.sources!, gen: ++seq, open: null, focus: null, records: {}, evidence: null } } : {}),
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
    // Resume healthy or interrupted Home reads, including an open decision.
    // A failed initial Home retains its explicit retry; an ongoing check or open
    // decision resumes its interrupted retry when the window returns.
    if (state.home && (!state.home.failure || homeNeedsPolling()) && !state.concealed) void loadHome();
  });
}

/** The window came forward (⌘E, the tray): the account, Home and the bar's search are read again. */
export async function windowShown(): Promise<void> {
  if (state.concealed) return;
  await refreshStatus();
  searchAgain();
  await refreshHome();
}

// ---- Home: what needs you ---------------------------------------------------------

/**
 * One row on Home. `approve`: a meeting's decisions wait for you. `impact`:
 * you approved, and ECHO found what it changes (or could not). `checking`:
 * the check is on its way.
 */
export type NeedKind = 'approve' | 'impact' | 'checking';
export interface NeedRow {
  kind: NeedKind;
  review: PersonMeetingReviewV2;
  run?: PersonRunV1;
}
export interface HomeState {
  seq: number;
  loading: boolean;
  failure?: Failure;
  rows: NeedRow[];
  /** Meetings are turned on for the organization: decisions can reach Home at all. */
  meetings: boolean;
}

type ReviewOpen = PersonMeetingResultsV2['review_open'];

/** The decision open from Home: what was proposed, your choices, and what it changed once approved. */
export interface DecisionState {
  approval_id: string;
  seq: number;
  loading: boolean;
  failure?: string;
  open: ReviewOpen | null;
  /** The card's idempotency key: one per opening. */
  command: string;
  audience: 'only-me' | 'projects';
  project_ids: string[];
  share: boolean;
  owners: { signal_id: string; action: string; owner: string }[];
  busy: boolean;
  /** The impact check of an approved decision, and its card once read. */
  run: PersonRunV1 | null;
  impact: ImpactView | null | undefined;
}

/** How often Home looks again while an impact check is going. */
const RUN_POLL_MS = 5_000;
const SEEN_IMPACT = 'echo.seenImpact';

/** Impact cards this computer has shown and you said Got it to, by account. */
function seenImpact(): Set<string> {
  const account = expect();
  if (!account) return new Set();
  try {
    const all = JSON.parse(localStorage.getItem(SEEN_IMPACT) ?? '{}') as Record<string, string[]>;
    return new Set(all[account.membership_id] ?? []);
  } catch { return new Set(); }
}
function markImpactSeen(runId: string): void {
  const account = expect();
  if (!account) return;
  try {
    const all = JSON.parse(localStorage.getItem(SEEN_IMPACT) ?? '{}') as Record<string, string[]>;
    const mine = new Set(all[account.membership_id] ?? []);
    mine.add(runId);
    localStorage.setItem(SEEN_IMPACT, JSON.stringify({ ...all, [account.membership_id]: [...mine].slice(-200) }));
  } catch { /* a convenience only */ }
}

function needsRows(reviews: readonly PersonMeetingReviewV2[], runs: readonly PersonRunV1[]): NeedRow[] {
  const seen = seenImpact();
  const byApproval = new Map(runs.map(run => [run.event_ref, run]));
  const rows: NeedRow[] = [];
  for (const review of reviews) {
    if (review.status === 'pending') { rows.push({ kind: 'approve', review }); continue; }
    if (review.status !== 'approved' && review.status !== 'publishing') continue;
    const run = byApproval.get(review.approval_id);
    if (!run) {
      // The publisher queues the run only after the approved record is written.
      if (review.status === 'publishing') rows.push({ kind: 'checking', review });
      continue;
    }
    if (seen.has(run.run_id)) continue;
    rows.push({ kind: run.state === 'done' || run.state === 'failed' ? 'impact' : 'checking', review, run });
  }
  // What needs a click first; then what is still on its way.
  const order: Record<NeedKind, number> = { approve: 0, impact: 1, checking: 2 };
  return rows.sort((a, b) => order[a.kind] - order[b.kind]);
}

/** Rows that wait for a click: Home's badge. */
export function needsCount(current: State = state): number {
  return current.home?.rows.filter(row => row.kind !== 'checking').length ?? 0;
}

function homeShown(mine?: number): HomeState | null {
  const home = state.home;
  return home && !state.concealed && state.status?.signed_in && (state.route.page === 'home' || state.route.page === 'decision') && (mine === undefined || home.seq === mine) ? home : null;
}

function homeNeedsPolling(): boolean {
  return state.route.page === 'decision' || (state.home?.rows.some(row => row.kind === 'checking') ?? false);
}

/**
 * Home: the decisions waiting for you and the impact of ones you approved.
 * Read when Home opens, when the window comes forward, and after a decision.
 */
export async function loadHome(): Promise<void> {
  const account = expect();
  if (!account || state.concealed || (state.route.page !== 'home' && state.route.page !== 'decision')) return;
  stopRunPolling();
  const mine = ++seq;
  set({ home: { seq: mine, loading: true, rows: state.home?.rows ?? [], meetings: state.home?.meetings ?? false, failure: undefined } });
  const tools = await rpc('account.tools', { expect: account });
  if (!homeShown(mine)) return;
  if (!tools.ok) { set({ home: { ...state.home!, loading: false, failure: tools.failure } }); accountLost(tools.failure); return; }
  const granola = tools.value.tools.find(tool => tool.tool_id === 'granola');
  const meetings = granola !== undefined && granola.status !== 'unavailable';
  if (!meetings) { set({ home: { ...state.home!, loading: false, rows: [], meetings: false } }); return; }
  try {
    const [reviews, runs] = await Promise.all([
      meetingCommand({ operation: 'reviews' }),
      runsCommand({ schema_version: 1, operation: 'list' }),
    ]);
    if (!homeShown(mine)) return;
    set({ home: { ...state.home!, loading: false, meetings: true, rows: needsRows(reviews.reviews, runs.runs) } });
    updateDecisionRun(runs.runs);
    void driveRuns(runs.runs, reviews.reviews.some(review => review.status === 'publishing'));
  } catch (error) {
    if (!homeShown(mine)) return;
    void error;
    set({ home: { ...state.home!, loading: false, meetings: true, failure: { code: 'unavailable', retryable: true } } });
    // Keep known rows and the open card intact. Active work must recover even
    // when the decision page has no Home retry button.
    if (homeNeedsPolling()) pollRuns(runSeq);
  }
}

let runPoll: ReturnType<typeof setTimeout> | null = null;
let runSeq = 0;

function stopRunPolling(): void {
  runSeq += 1;
  if (runPoll) clearTimeout(runPoll);
  runPoll = null;
}

function pollRuns(mine: number): void {
  runPoll = setTimeout(() => {
    runPoll = null;
    if (mine === runSeq && homeShown()) void refreshRuns(mine);
  }, RUN_POLL_MS);
}

/**
 * Impact checks run only from your signed-in desktop: start the oldest queued
 * one when none is going, and look again while publishing or checking.
 */
async function driveRuns(listed: readonly PersonRunV1[], publishing = false): Promise<void> {
  stopRunPolling();
  const mine = runSeq;
  const current = () => mine === runSeq && homeShown() !== null;
  try {
    const running = listed.some(run => run.state === 'running');
    let again = running || publishing;
    const queued = [...listed].reverse().find(run => run.state === 'pending');
    if (!running && queued) {
      await runsCommand({ schema_version: 1, operation: 'start', run_id: queued.run_id });
      if (!current()) return;
      again = true;
    }
    if (again && current()) pollRuns(mine);
  } catch {
    if (current()) pollRuns(mine);
  }
}

/** A fresh list updates the open card too, even if its check finished while hidden. */
function updateDecisionRun(runs: readonly PersonRunV1[]): void {
  const decision = state.decision;
  if (!decision || !decisionShown(decision.seq)) return;
  const run = runs.find(item => item.event_ref === decision.approval_id) ?? null;
  if (run?.run_id !== decision.run?.run_id || run?.state !== decision.run?.state) {
    set({ decision: { ...decision, run, impact: undefined } });
    if (run?.state === 'done') void readImpact(decision.seq, run.run_id);
  }
}

/** The runs read again while one is going: Home's rows and the open decision follow. */
async function refreshRuns(mine: number): Promise<void> {
  const home = homeShown();
  if (!home || mine !== runSeq) return;
  try {
    const [reviews, runs] = await Promise.all([meetingCommand({ operation: 'reviews' }), runsCommand({ schema_version: 1, operation: 'list' })]);
    if (!homeShown(home.seq) || mine !== runSeq) return;
    set({ home: { ...state.home!, failure: undefined, rows: needsRows(reviews.reviews, runs.runs) } });
    updateDecisionRun(runs.runs);
    void driveRuns(runs.runs, reviews.reviews.some(review => review.status === 'publishing'));
  } catch {
    if (homeShown(home.seq) && mine === runSeq) pollRuns(mine);
  }
}

function decisionShown(mine: number): DecisionState | null {
  const decision = state.decision;
  return decision && state.route.page === 'decision' && decision.seq === mine ? decision : null;
}

/** A decision, from its Home row: what was proposed, and what it changed if it was approved. */
export async function openDecision(row: NeedRow): Promise<void> {
  if (!expect() || state.concealed) return;
  readSeq += 1;
  const mine = ++seq;
  const run = row.run ?? null;
  set({
    route: { page: 'decision', approval_id: row.review.approval_id }, reader: null, ask: null, sources: null, toast: null, organization: null, list: null, roster: null,
    barScope: { kind: 'global' },
    decision: { approval_id: row.review.approval_id, seq: mine, loading: true, open: null, command: crypto.randomUUID(), audience: 'only-me', project_ids: [], share: false,
      owners: [], busy: false, run, impact: undefined },
  });
  syncSearch();
  if (run?.state === 'done') void readImpact(mine, run.run_id);
  try {
    const open = await meetingCommand({ operation: 'review_open', approval_id: row.review.approval_id });
    const decision = decisionShown(mine);
    if (!decision) return;
    set({ decision: { ...decision, loading: false, open, audience: open.suggested_projects.length > 0 ? 'projects' : 'only-me',
      project_ids: open.suggested_projects.map(project => project.project_id),
      owners: open.owners.map(owner => ({ signal_id: owner.signal_id, action: owner.action, owner: owner.proposed })) } });
  } catch (error) {
    const decision = decisionShown(mine);
    if (decision) set({ decision: { ...decision, loading: false, failure: error instanceof Error ? error.message : 'The decision could not be read.' } });
  }
}

async function readImpact(mine: number, runId: string): Promise<void> {
  try {
    const view = await runsCommand({ schema_version: 1, operation: 'view', run_id: runId });
    const decision = decisionShown(mine);
    if (decision && decision.run?.run_id === runId) set({ decision: { ...decision, impact: view } });
  } catch {
    const decision = decisionShown(mine);
    if (decision && decision.run?.run_id === runId) set({ decision: { ...decision, impact: null } });
  }
}

function editDecision(patch: Partial<DecisionState>): void {
  if (state.decision && state.route.page === 'decision') set({ decision: { ...state.decision, ...patch } });
}
export function setDecisionAudience(audience: DecisionState['audience']): void { editDecision({ audience }); }
export function setDecisionShare(share: boolean): void { editDecision({ share }); }
export function setDecisionOwner(signalId: string, owner: string): void {
  const decision = state.decision;
  if (decision) editDecision({ owners: decision.owners.map(item => item.signal_id === signalId ? { ...item, owner } : item) });
}
export function tickDecisionProject(projectId: string): void {
  const decision = state.decision;
  if (!decision) return;
  const ticked = decision.project_ids.includes(projectId);
  if (!ticked && decision.project_ids.length >= MAX_CAPTURE_PROJECTS) return;
  editDecision({ project_ids: ticked ? decision.project_ids.filter(id => id !== projectId) : [...decision.project_ids, projectId].sort() });
}

/** Approve or Reject: one send per opening. Home shows where it went; the check runs by itself. */
export async function decide(action: 'approve' | 'reject'): Promise<void> {
  const decision = state.decision;
  if (!decision?.open || decision.busy || state.route.page !== 'decision') return;
  const mine = decision.seq;
  editDecision({ busy: true, failure: undefined });
  try {
    const result = await meetingCommand({
      operation: 'review', approval_id: decision.approval_id, command_id: decision.command, snapshot_sha256: decision.open.snapshot_sha256, action,
      project_ids: action === 'approve' && decision.audience === 'projects' ? decision.project_ids : [],
      share_transcript: action === 'approve' && decision.share,
      owners: action === 'approve' ? decision.owners.flatMap(owner => owner.owner.trim() ? [{ signal_id: owner.signal_id, owner: owner.owner.trim() }] : []) : [],
    });
    if (!decisionShown(mine)) return;
    const toast = result.decided_on === 'slack' ? `Already ${result.status === 'rejected' ? 'rejected' : 'approved'} in Slack`
      : result.status === 'rejected' ? 'Rejected' : 'Approved · checking what it changes';
    goHome();
    set({ toast });
  } catch (error) {
    if (decisionShown(mine)) editDecision({ busy: false, failure: error instanceof Error ? error.message : 'That was not sent. Try again.' });
  }
}

/** Got it: the impact card leaves Home on this computer. */
export function dismissImpact(): void {
  const decision = state.decision;
  if (decision?.run) markImpactSeen(decision.run.run_id);
  goHome();
}

/** Try again on a failed impact check. */
export async function retryImpact(): Promise<void> {
  const decision = state.decision;
  if (!decision?.run || decision.run.state !== 'failed') return;
  const mine = decision.seq;
  try {
    await runsCommand({ schema_version: 1, operation: 'retry', run_id: decision.run.run_id });
    if (!decisionShown(mine)) return;
    editDecision({ run: { ...decision.run, state: 'pending', error_code: null }, impact: undefined });
    const runs = await runsCommand({ schema_version: 1, operation: 'list' });
    void driveRuns(runs.runs);
  } catch { /* the card still offers Try again */ }
}
