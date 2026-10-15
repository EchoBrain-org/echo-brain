import type {
  PersonImpactStageV1, PersonMeetingOperationV2, PersonMeetingResultsV2, PersonMeetingReviewV2, PersonOpenItemStateV1, PersonRunV1, PersonRunsRequestV1,
} from '@echo-brain/organization-api';
// All renderer state and the actions that change it. Every request carries the
// account being shown; late replies for a page that has moved on are dropped.
import { useEffect, useState } from 'preact/hooks';
import type {
  AccountCommand, Answer, AnswerSource, AppStatus, ApprovedRecord, AskScope, Audience, ConnectedTool, ContextContent, DocumentText, Employee, Expect,
  ConnectedTools, Extraction, Failure, FileHandle, HomeView, ItemRef, ListItem, ListScope, Match, Member, OpenItemsView, OpenItemView, ProjectChange, ProjectConfluenceMapping, ConfluenceSpace,
  MainMethods, ProjectJiraMapping, ProjectSummary, Receipt, RecordItem, RecordRef, RecordSection, Result, RunsResults, SourceEvidence, ToolAttempt,
  ExternalAnswerSource, UpdateState,
} from '../shared/protocol.js';
import { isWriteCall, MAX_CAPTURE_PROJECTS, NOTICE_ITEMS_MAX, NOTICE_TEXT_MAX } from '../shared/protocol.js';
import { askText, searchQuery } from '../shared/query.js';
import { sourceGroups, type SourceGroup } from './answer.js';
import { dropFile, rpc } from './api.js';
import { renamedProject, reread } from './feed.js';
import { message } from './messages.js';
import { firstName, reopenSends, sentWords } from './needs.js';

/** Mine: only what you added, to see and to ask about. Follow-ups: everything you sent or own. */
type Route = { page: 'home' } | { page: 'project'; project: ProjectSummary } | { page: 'organization' } | { page: 'mine' } | { page: 'tools' } | { page: 'decision' }
  | { page: 'follow-ups' };

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
  /** People the directory found for the name (`query`, as sent), or its first people. */
  directory: { seq: number; query: string; items: readonly Member[]; next: string | null; loading: boolean; failure?: Failure } | null;
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
 * both optional. Nothing is sent before Create. Create makes the project,
 * which opens at once while the sheet steps aside; each person is added and
 * each file saved, in turn, with the toast saying how far it got. The sheet
 * comes back only for one whose outcome needs you, and closes by itself once
 * nothing does.
 */
export interface NewProjectSheet extends Finding {
  kind: 'new-project';
  seq: number;
  /** Stepped aside after Create: the work goes on, and the toast says where it is. */
  hidden: boolean;
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
  /** This read: an earlier read's reply cannot replace it. */
  seq: number;
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
  /** A lead's own spaces to pick from: read once the mapping is, and Confluence is connected. */
  catalog: 'idle' | 'loading' | 'read';
  loadingMore?: boolean;
  /** The lead-only space catalog failed; the shared project mapping is still readable. */
  pickerFailure?: Failure;
}

/**
 * A project's Tools: your connection to each tool a project can read, and
 * what this project reads from it, on one sheet. Connect waits in its row;
 * Save writes every changed setting, then the sheet closes.
 */
export interface ProjectToolsState {
  seq: number;
  /** Your tools as the Authority lists them; null until read, or when the read failed. */
  items: readonly ConnectedTool[] | null;
  failure?: Failure;
  /** A connection started from a row: opening, waiting on the browser, or why it did not connect. */
  connect?: { seq: number; tool: ConnectedTool; phase: 'starting' | 'waiting' | 'failed'; attempt?: ToolAttempt; reason?: string; failure?: Failure };
  /** The tool connected from this sheet, said in its row. */
  connected?: string;
  saving: boolean;
}

/** What the project on screen reads from its tools: undefined until read, or when the read failed. */
export interface ProjectReads {
  /** This opening: replies from earlier visits cannot replace it. */
  seq: number;
  project_id: string;
  /** The organization has a tool a project can read. */
  available?: boolean;
  /** The Jira project key, or null when none. */
  jira?: string | null;
  /** How many Confluence spaces, or null when none. */
  confluence?: number | null;
}

export interface ProjectSettingsState {
  jira?: ProjectJiraSetting;
  confluence?: ProjectConfluenceSetting;
  tools?: ProjectToolsState;
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
  /** Counts each toast shown, so one that says the same again stays its own time. */
  toastShown: number;
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
  /** Follow-up lists and item pages, over the page they were opened from. */
  followUps: FollowUpsState | null;
  /** The follow-ups line of the approved meeting the reader or the decision page shows. */
  impactLine: ItemsLine | null;
  /** The follow-ups line above the feed of the project on screen. */
  projectLine: ItemsLine | null;
  /** The tools line above the feed of the project on screen. */
  projectReads: ProjectReads | null;
  /** The sidebar's one row for a new version (ADR-0035). It is not the account's: no sign-in or sign-out changes it. */
  update: UpdateState;
  /** Why the last click on that row did not install, shown under it until the next click or a new row. */
  updateFailure: Failure | null;
}

const SIDEBAR_OPEN = 'echo.sidebarOpen';

function rememberedSidebar(): boolean {
  try { return localStorage.getItem(SIDEBAR_OPEN) !== 'false'; } catch { return true; }
}

let state: State = {
  status: null, booting: true, route: { page: 'home' }, projects: { items: [], next: null, loading: false },
  archivedProjects: { items: [], next: null, loading: false }, list: null, roster: null, reader: null, change: null, projectSettings: null,
  barScope: { kind: 'global' }, barText: '', matches: null, ask: null, sources: null, compose: null, toast: null, toastShown: 0, concealed: false,
  signin: { phase: 'idle', form: false }, sheet: null, startFailed: false, sidebarOpen: rememberedSidebar(), organization: null, tools: null, employeeWrite: null,
  home: null, decision: null, followUps: null, impactLine: null, projectLine: null, projectReads: null,
  update: { state: 'none' }, updateFailure: null,
};
const listeners = new Set<() => void>();
let seq = 0;
/** The active request's host cancellation id. It never leaves the desktop IPC. */
let activeAskCancelId: string | null = null;

export function getState(): State { return state; }

/** A project settings dialog is up: Tools, Rename, a confirmation, or a write's outcome. It owns the window as a sheet does. */
export function projectSettingsModal(current: State = state): boolean {
  const settings = current.projectSettings;
  return settings !== null && Boolean(settings.tools || settings.rename !== null || settings.confirm || settings.write);
}

/** The sheet over the window, unless it is New project stepped aside while its work goes on. */
export function sheetShown(current: State = state): Sheet | null {
  const sheet = current.sheet;
  return sheet?.kind === 'new-project' && sheet.hidden ? null : sheet;
}

/** A toast that says something went well goes by itself; one that warns stays until the next page. */
export function clearToast(shown: number): void {
  if (state.toastShown === shown) set({ toast: null });
}

function set(patch: Partial<State>): void {
  // Leaving Ask by any route drops a late answer: the host stops working on it.
  if ('ask' in patch && patch.ask === null && activeAskCancelId) {
    const cancelId = activeAskCancelId;
    activeAskCancelId = null;
    void rpc('ask.cancel', { cancel_id: cancelId });
  }
  state = { ...state, ...patch, ...(patch.toast ? { toastShown: state.toastShown + 1 } : {}) };
  // A modal owns keyboard focus. Dismiss only the transient project menu,
  // retaining settings drafts and writes while unmounting its global handlers.
  if (state.projectSettings?.menu && (sheetShown() || (state.compose && !state.compose.hidden))) {
    state = { ...state, projectSettings: { ...state.projectSettings, menu: false } };
  }
  // A held update click says what to settle only while it is unsettled, here or in main.
  if (state.updateFailure?.code === 'update_held' && !signOutHeld() && !unresolvedWork().unresolved) state = { ...state, updateFailure: null };
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

/**
 * Access that was lost or refused. A timeout, an outage or a bad reply says nothing about it, and neither does
 * stale_access_state, which also means only that what was acted on changed meanwhile: the status read settles it.
 */
const ACCESS_LOST = ['signed_out', 'unauthorized', 'sign_in_required', 'not_found', 'forbidden', 'owner_access_required'];

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
/** A sign-out whose reply the host lost: the next status read settles whether it happened. */
let signOutPending: 'signout' | 'switch' | null = null;

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
    // A sign-out the host lost mid-way did happen: the account goes as it would have.
    if (signOutPending) { signOutPending = null; forgetAccount(); }
    // No one to notify: signing in again starts over, learning what is there.
    stopQuietCheck();
    emptyBar();
    // New project with work on its way stays, out of sight behind the sign-in page: its outcome is still owed, and the
    // same person signing back in finds it as it is. Another account's sign-in forgets it.
    set({ sheet: state.sheet?.kind === 'new-project' ? state.sheet : null });
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
  signOutPending = null;
  if (!same || !wasSignedIn) {
    void loadProjects(); void loadArchivedProjects(); void loadHome();
    startQuietCheck(lastAccount);
    // New project kept through a sign-out goes on with what waited while no one was signed in.
    pumpNewProject();
  }
}

/** Nothing of an account's stays on screen or in memory, not even a draft. */
function forgetAccount(): void {
  // Cleanup belongs to the previous account, even after status has changed. The host may refuse it once that session
  // is gone; never try an old request or connection with the newly signed-in account's authority.
  const account = lastAccount;
  if (state.compose) release(state.compose, account);
  if (state.sheet?.kind === 'new-project') for (const file of state.sheet.files) if (file.kept) releaseCopy(file.requestId, account);
  if (state.sheet?.kind === 'tool-connect') cancelWaitingConnection(state.sheet, account);
  if (state.projectSettings?.tools) clearProjectMappings(state.projectSettings, account);
  stopRunPolling();
  stopQuietCheck();
  runFailures = 0;
  openUnread = false;
  resultOwed = false;
  sweepOwed = null;
  lastAccount = null;
  // A Home load on its way is the last account's: the next one starts afresh.
  homeLoading = null;
  homeToken += 1;
  emptyBar();
  set({ route: { page: 'home' }, list: null, roster: null, reader: null, ask: null, sources: null, sheet: null, toast: null,
    barScope: { kind: 'global' }, projects: { items: [], next: null, loading: false }, archivedProjects: { items: [], next: null, loading: false },
    projectSettings: null, organization: null, tools: null, employeeWrite: null, home: null, decision: null, followUps: null, impactLine: null, projectLine: null,
    projectReads: null });
  listChanged();
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
  // A sign-out already under way is not interrupted, nor a sheet with work on its way: New project, out of sight, comes back to say so.
  if (!signedIn || signingOut()) return;
  if (command !== 'tools' && newProjectInTheWay()) return;
  if (command === 'tools' && newProjectSheet()?.hidden) { openTools(true); return; }
  if (sheetHeld()) return;
  if (state.sheet?.kind === 'new-project') finishNewProject(state.sheet);
  if (command === 'tools') openTools(true);
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

/** The sidebar's Tools, and the Account menu's Connected tools… (from the tray, with another app in front). The bar searches all context. */
export function openTools(fromTray = false): void {
  if (!state.status?.account || (state.concealed && !fromTray)) return;
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

/** Where a connection started from a sheet or a row stands, once it is not opening any more. */
type ConnectStep = { phase: 'waiting'; attempt: ToolAttempt } | { phase: 'failed'; failure?: Failure; reason?: string };

/**
 * One connection: the tool's page opens in the browser, and the attempt is
 * read every few seconds. A read is what completes it, so the reads go on
 * until it settles, or until what waits on it (`waiting`) has gone.
 */
async function runConnect(account: Expect, tool: ConnectedTool, waiting: () => boolean, step: (to: ConnectStep) => void): Promise<'complete' | 'cancelled' | null> {
  const result = await rpc('tools.connect', { expect: account, tool_id: tool.tool_id });
  if (!waiting()) {
    // Cancelled while the page was opening: the attempt it started is cancelled too.
    if (result.ok) void rpc('tools.cancel', { expect: account, tool_id: tool.tool_id, attempt_id: result.value.attempt_id });
    return null;
  }
  if (!result.ok) {
    step({ phase: 'failed', failure: result.failure });
    accountLost(result.failure);
    return null;
  }
  const attempt = result.value;
  step({ phase: 'waiting', attempt });
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, TOOL_POLL_MS));
    if (!waiting()) return null;
    const read = await rpc('tools.status', { expect: account, tool_id: tool.tool_id, attempt_id: attempt.attempt_id });
    if (!waiting()) return null;
    if (!read.ok) {
      if (ACCESS_LOST.includes(read.failure.code) || read.failure.code === 'account_changed') {
        step({ phase: 'failed', failure: read.failure });
        accountLost(read.failure);
        return null;
      }
      // A slow or failed read says nothing about the attempt: read again until it would have expired.
      if (Date.now() <= Date.parse(attempt.expires_at)) continue;
      step({ phase: 'failed', reason: 'expired' });
      return null;
    }
    const { status, failure_reason: reason } = read.value;
    if (status === 'pending') continue;
    if (status === 'complete' || status === 'cancelled') return status;
    step({ phase: 'failed', reason: status === 'expired' ? 'expired' : reason ?? 'failed' });
    return null;
  }
}

/**
 * Connect, Reconnect or Try again, from Tools: the sheet waits on the
 * browser, and closes by itself once the tool is connected.
 */
export async function connectTool(tool: ConnectedTool): Promise<void> {
  const account = expect();
  if (!account || state.concealed || newProjectInTheWay() || (state.sheet && state.sheet.kind !== 'tool-connect')) return;
  const mine = ++seq;
  set({ sheet: { kind: 'tool-connect', seq: mine, tool, phase: 'starting' } });
  const done = await runConnect(account, tool, () => connectSheet(mine) !== null,
    to => set({ sheet: { kind: 'tool-connect', seq: mine, tool, ...to } }));
  if (done === 'complete') set({ sheet: null, toast: `${tool.name} connected` });
  else if (done === 'cancelled') set({ sheet: null });
  if (done) void loadToolList();
}

/** Cancel, Close or Escape: a waiting attempt is cancelled, so a late approval in the browser binds nothing. */
export function cancelConnect(): void {
  const sheet = state.sheet;
  if (sheet?.kind !== 'tool-connect') return;
  const account = expect();
  set({ sheet: null });
  cancelWaitingConnection(sheet, account);
}

function cancelWaitingConnection(connect: Pick<ToolConnectSheet, 'tool' | 'phase' | 'attempt'> | undefined, account: Expect | null): void {
  if (account && connect?.phase === 'waiting' && connect.attempt) {
    void rpc('tools.cancel', { expect: account, tool_id: connect.tool.tool_id, attempt_id: connect.attempt.attempt_id });
  }
}

/** A host call that failed: the page's words for it as its message, and the failure itself. */
class CommandFailed extends Error {
  constructor(readonly failure: Failure) { super(message(failure)); }
}

/** The failure a command threw; a plain one when the account or the screen changed under it. */
function failureOf(error: unknown): Failure {
  return error instanceof CommandFailed ? error.failure : { code: 'failed', retryable: true };
}

/** Only the Authority's answer settles a write whose outcome is unknown: a failed resend leaves it unknown. */
function outcomeUnknown(failure: Failure, resend: boolean): boolean {
  return resend || failure.mutation_outcome === 'unknown';
}

/** Account-fenced command for the personal meeting sheet. No provider token enters the renderer. */
export function meetingCommand<K extends PersonMeetingOperationV2['operation']>(operation: PersonMeetingOperationV2 & { readonly operation: K }): Promise<PersonMeetingResultsV2[K]> {
  return fencedCommand<PersonMeetingResultsV2[K]>(account => rpc('tools.meetings', { expect: account, request: { ...operation, schema_version: 2, tool_id: 'granola' } }),
    isWriteCall('tools.meetings', { request: operation }));
}

/** Account-fenced runs request: your own approvals' checks, and the open items you can see. */
export function runsCommand<K extends keyof RunsResults>(request: PersonRunsRequestV1 & { readonly operation: K }): Promise<RunsResults[K]> {
  return fencedCommand<RunsResults[K]>(account => rpc('runs', { expect: account, request }), isWriteCall('runs', { request }));
}

/**
 * Sends for the account shown; a reply once the account changed is refused,
 * and a failure is thrown. A write's, as the host says of one it sent before a
 * switch, may have landed, unless the host says it never went: only a read of
 * it settles that. Another app in front changes nothing: the reply is the
 * Authority's answer, and the page it is for fences it by itself.
 */
async function fencedCommand<T>(send: (account: Expect) => Promise<Result<unknown>>, write: boolean): Promise<T> {
  const account = expect();
  if (!account) throw new Error('Sign in to use meetings.');
  const result = await send(account);
  if (JSON.stringify(expect()) !== JSON.stringify(account)) {
    if (!write) throw new Error('Account changed.');
    const unsent = !result.ok && result.failure.mutation_outcome === 'not_submitted';
    throw new CommandFailed({ code: 'account_changed', retryable: false, mutation_outcome: unsent ? 'not_submitted' : 'unknown' });
  }
  if (!result.ok) { accountLost(result.failure); throw new CommandFailed(result.failure); }
  return result.value as T;
}

/** Open in Jira, Confluence or Slack, from an impact card: the tool checks your access when it opens. */
export async function openImpactSource(source: ExternalAnswerSource): Promise<boolean> {
  return !state.concealed && (await rpc('source.openExternal', { kind: source.kind, permalink: source.permalink })).ok;
}

export function manageTool(tool: ConnectedTool): void {
  if (!state.status?.account || state.concealed || newProjectInTheWay() || state.sheet) return;
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

/** What to settle first, where an unknown outcome shows: sign out and the update row say the same. */
export function settleWords(current: State = state): string {
  return current.compose?.status === 'unknown' ? 'A save may not have arrived. Check it in Capture first.'
    : current.change?.status === 'unknown' ? 'A project change may not have finished. Try it again or dismiss it first.'
    : 'Finish the current save first.';
}

/** Sign out, or Switch account, after the person confirmed it. */
export async function signOut(): Promise<void> {
  const account = expect();
  const sheet = state.sheet;
  if (!account || !sheet || (sheet.kind !== 'signout' && sheet.kind !== 'switch') || sheet.busy || signOutHeld()) return;
  const busy: SignOutSheet = { ...sheet, busy: true, failure: undefined };
  set({ sheet: busy });
  signOutPending = sheet.kind;
  const result = await rpc('account.signOut', { expect: account });
  if (!result.ok) {
    if (state.sheet?.kind === sheet.kind) set({ sheet: { ...sheet, busy: false, failure: result.failure } });
    // The host went while signing out: whether the session went with it, the next status read says.
    if (result.failure.code !== 'host_restarted') signOutPending = null;
    accountLost(result.failure);
    return;
  }
  signOutPending = null;
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

// ---- updates from the signed client feed (ADR-0035) --------------------------

/** Counts the rows main has sent, so a status read that crossed a newer one is dropped. */
let updatesSeen = 0;

/** The row main's updater shows now. A new row clears what the last click said. */
export function updateChanged(next: UpdateState): void {
  updatesSeen += 1;
  set({ update: next, updateFailure: null });
}

/** Reads the row from main: at launch, and when a click found it changed. */
export async function readUpdate(): Promise<void> {
  const seen = updatesSeen;
  const result = await rpc('update.status', {});
  if (result.ok && seen === updatesSeen) updateChanged(result.value);
}

/** New version · Restart, and Try again: main installs the release on the row, then ECHO restarts. */
export async function installUpdate(): Promise<void> {
  const update = state.update;
  if (update.state === 'none' || update.state === 'installing' || (update.state === 'failed' && update.reason === 'location')) return;
  // Held as sign out is: the same work, and the same words under the row.
  if (signOutHeld()) { set({ updateFailure: { code: 'update_held', retryable: true } }); return; }
  set({ updateFailure: null });
  // Progress arrives as update.changed.
  const result = await rpc('update.install', { release: update.release });
  if (result.ok) return;
  if (result.failure.code === 'update_changed') { await readUpdate(); return; }
  // A refusal of a row main has replaced since says nothing about the new one.
  if (state.update === update) set({ updateFailure: result.failure });
}

// ---- home and projects -------------------------------------------------------

/** The rows shown, then the rows of a page they do not have yet. */
function appendPage<T>(shown: readonly T[], page: readonly T[], key: (row: T) => string): T[] {
  const seen = new Set(shown.map(key));
  return [...shown, ...page.filter(row => !seen.has(key(row)))];
}

/** The first page again, or the next page appended (More projects). */
export function loadProjects(more = false): Promise<void> { return loadProjectList('active', more); }

/** Archived projects live in their own list: they can be opened, but never picked for new material. */
export function loadArchivedProjects(more = false): Promise<void> { return loadProjectList('archived', more); }

type ListStatus = 'active' | 'archived';
const LIST_KEY = { active: 'projects', archived: 'archivedProjects' } as const;

/**
 * Counts every change to a project list, read or made here. A foreground
 * refresh that began before a change reads again, so what it shows is never
 * older than the change.
 */
let projectsEdition = 0;
/** A foreground refresh that found a page on its way: it runs once that page is in. */
const refreshOwed = new Set<ListStatus>();
/** Foreground refreshes on their way: a second foreground does not start another. */
const refreshing = new Set<ListStatus>();

function listChanged(): void { projectsEdition += 1; }

/** Your active or archived projects: the first page again, or the next page appended. */
async function loadProjectList(status: ListStatus, more: boolean): Promise<void> {
  const key = LIST_KEY[status];
  const show = (list: State['projects']) => set(key === 'projects' ? { projects: list } : { archivedProjects: list });
  const account = expect();
  if (!account || (more && !state[key].next)) return;
  const cursor = more ? state[key].next ?? undefined : undefined;
  show({ ...state[key], loading: true, failure: undefined });
  const result = await rpc('projects.list', { expect: account, status, ...(cursor ? { cursor } : {}) });
  if (!sameAccount(account)) return;
  if (!result.ok) {
    accountLost(result.failure);
    show({ ...state[key], loading: false, failure: result.failure });
    refreshIfOwed(status);
    return;
  }
  if (status === 'active' && rolesChanged(result.value.items)) emptyBar();
  const items = appendPage(more ? state[key].items : [], result.value.items, project => project.project_id);
  show({ items, next: result.value.next_cursor, loading: false });
  listChanged();
  refreshIfOwed(status);
}

function sameAccount(account: Expect): boolean {
  const now = expect();
  return now?.authority === account.authority && now.membership_id === account.membership_id;
}

function refreshIfOwed(status: ListStatus): void {
  if (refreshOwed.delete(status)) void (status === 'active' ? refreshProjects() : refreshProjectList('archived'));
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

/** The window came forward: the sidebar's lists read again, on every page; the archived one once the active one could be. */
async function refreshProjects(): Promise<void> {
  if (await refreshProjectList('active')) void refreshProjectList('archived');
}

/**
 * A list read again, quietly, over as many pages as it shows: what shows is
 * then what the Authority has now, in its order (creation time, newest first,
 * then project ID), with More going on from the last row read. A page on its
 * way (More, Try again) is waited for; a change made meanwhile, here or by a
 * page landing, makes it read again over the changed list. A read that fails
 * leaves what is shown: the next page read says when access is gone.
 */
async function refreshProjectList(status: ListStatus): Promise<boolean> {
  const key = LIST_KEY[status];
  if (refreshing.has(status)) return false;
  refreshing.add(status);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const account = expect();
      if (!account) return false;
      // Nothing shown yet: the page on its way is as fresh as a refresh.
      if (state[key].loading) { if (state[key].items.length > 0) refreshOwed.add(status); return false; }
      const edition = projectsEdition;
      const shown = state[key].items.length;
      const items: ProjectSummary[] = [];
      let next: string | null = null;
      let cursor: string | undefined;
      for (;;) {
        const result = await rpc('projects.list', { expect: account, status, ...(cursor ? { cursor } : {}) });
        if (!sameAccount(account)) return false;
        if (!result.ok) { accountLost(result.failure); return false; }
        items.push(...result.value.items.filter(project => !items.some(row => row.project_id === project.project_id)));
        next = result.value.next_cursor;
        cursor = next ?? undefined;
        if (next === null || items.length >= shown) break;
      }
      if (edition !== projectsEdition) continue;
      if (state[key].loading) { refreshOwed.add(status); return false; }
      if (status === 'active' && rolesChanged(items)) emptyBar();
      set(key === 'projects' ? { projects: { items, next, loading: false } } : { archivedProjects: { items, next, loading: false } });
      return true;
    }
    return false;
  } finally {
    refreshing.delete(status);
  }
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
  void loadLine('projectLine', 'project', project.project_id);
  void loadProjectReads(project.project_id);
  await loadList('first');
}

/**
 * What the project on screen reads from its tools, for the line above its
 * feed, and whether the organization has a tool a project can read at all.
 * Quiet: a read that fails leaves the line out; the list's own read says
 * when access is gone.
 */
async function loadProjectReads(project_id: string): Promise<void> {
  const account = expect();
  if (!account) return;
  const mine = ++seq;
  set({ projectReads: { project_id, seq: mine } });
  const settle = <Key extends 'available' | 'jira' | 'confluence'>(key: Key, value: ProjectReads[Key]) => {
    const current = state.projectReads;
    // Save may already have confirmed this field while the initial read waited.
    if (current?.seq === mine && current[key] === undefined &&
        expect()?.authority === account.authority && expect()?.membership_id === account.membership_id) {
      set({ projectReads: { ...current, [key]: value } });
    }
  };
  await Promise.all([
    rpc('account.tools', { expect: account })
      .then(result => { if (result.ok) settle('available', projectToolsAvailable(result.value.tools)); }),
    rpc('projects.jiraRead', { expect: account, project_id })
      .then(result => { if (result.ok) settle('jira', jiraMapping.reads(result.value)); }),
    rpc('projects.confluenceRead', { expect: account, project_id })
      .then(result => { if (result.ok) settle('confluence', confluenceMapping.reads(result.value)); }),
  ]);
}

function projectToolsAvailable(tools: readonly ConnectedTool[]): boolean {
  const readable: readonly string[] = PROJECT_MAPPING_TOOLS;
  return tools.some(tool => readable.includes(tool.tool_id) && tool.status !== 'unavailable');
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
  set({ list: { ...current, loading: false, items: appendPage(current.items, page.items, refKey), next: page.next_cursor } });
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
  const mine = ++seq;
  set({ roster: { projectId, seq: mine, items: more ? roster!.items : roster?.items ?? [], next: roster?.next ?? null, loading: true } });
  const result = await rpc('projects.members', { expect: account, project_id: projectId, ...(cursor ? { cursor } : {}) });
  const current = state.roster;
  if (current?.projectId !== projectId || current.seq !== mine) return;
  if (!result.ok) {
    set({ roster: { ...current, loading: false, failure: result.failure } });
    accountLost(result.failure);
    return;
  }
  const items = appendPage(more ? current.items : [], result.value.items, person => person.membership_id);
  set({ roster: { projectId, seq: mine, items, next: result.value.next_cursor, loading: false } });
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
  // An approved meeting's first page counts its follow-ups: its line.
  if (ref.kind === 'meeting' && cursor === undefined) void loadLine('impactLine', 'record', ref.id);
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
    const unknown = outcomeUnknown(result.failure, retrying);
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
  const settings = current.projectSettings;
  const status = settings?.write?.status;
  return status === 'sending' || status === 'unknown' || settings?.tools?.saving === true ||
    PROJECT_MAPPING_TOOLS.some(tool => settings?.[tool]?.status === 'saving');
}

export function toggleProjectSettings(target?: ProjectSummary, menuOrigin: 'header' | 'sidebar' = 'header'): void {
  const project = target ?? (state.route.page === 'project' ? state.route.project : null);
  if (!project || state.concealed || sheetShown() || (state.compose && !state.compose.hidden) ||
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

/** The tools a project can read from, in the order its Tools sheet shows them. */
export const PROJECT_MAPPING_TOOLS = ['jira', 'confluence'] as const;
export type MappingTool = typeof PROJECT_MAPPING_TOOLS[number];
type MappingSetting<Tool extends MappingTool> = NonNullable<ProjectSettingsState[Tool]>;
type MappingValue<Tool extends MappingTool> = NonNullable<MappingSetting<Tool>['value']>;
/** Tools closes: a connection still waiting on the browser is cancelled, so a late approval binds nothing. */
function clearProjectMappings(settings: ProjectSettingsState, account: Expect | null = expect()): ProjectSettingsState {
  cancelWaitingConnection(settings.tools?.connect, account);
  const cleared = { ...settings };
  for (const tool of PROJECT_MAPPING_TOOLS) delete cleared[tool];
  delete cleared.tools;
  return cleared;
}
interface MappingAdapter<Tool extends MappingTool> {
  /** What the project reads from the tool, as the line above its feed says it. */
  reads(value: MappingValue<Tool>): ProjectReads[Tool];
  readonly tool: Tool;
  initial(seq: number): MappingSetting<Tool>;
  read(account: Expect, project_id: string): Promise<Result<MappingValue<Tool>>>;
  write(account: Expect, project_id: string, setting: MappingSetting<Tool>, remove: boolean, request_id: string): Promise<Result<MappingValue<Tool>>>;
  accepted(setting: MappingSetting<Tool>, value: MappingValue<Tool>): MappingSetting<Tool>;
  valid(setting: MappingSetting<Tool>): boolean;
}

const jiraMapping: MappingAdapter<'jira'> = {
  reads: value => value.mapping?.project_key ?? null,
  tool: 'jira', initial: seq => ({ seq, status: 'loading', key: '' }),
  read: (expect, project_id) => rpc('projects.jiraRead', { expect, project_id }),
  write: (expect, project_id, setting, remove, request_id) => rpc('projects.jiraSet', { expect, project_id, request_id,
    expected_revision: setting.value!.revision, jira_project: remove ? null : setting.key.trim() }),
  accepted: (setting, value) => ({ seq: setting.seq, status: 'ready', key: value.mapping?.project_key ?? '', value }),
  valid: setting => /^[A-Z][A-Z0-9_]{0,63}$/.test(setting.key.trim()) && setting.key.trim() !== setting.value?.mapping?.project_key,
};
const confluenceMapping: MappingAdapter<'confluence'> = {
  reads: value => value.mapping ? value.mapping.space_ids.length : null,
  tool: 'confluence', initial: seq => ({ seq, status: 'loading', spaces: [], next: null, selected: [], catalog: 'idle' }),
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
function setProjectTools(settings: ProjectSettingsState, patch: Partial<ProjectToolsState>): void {
  if (settings.tools) set({ projectSettings: { ...settings, tools: { ...settings.tools, ...patch } } });
}

/** Every reply belongs to this account and this opening of Tools. */
function toolsAt(account: Expect, opening: number): ProjectSettingsState | undefined {
  const settings = state.projectSettings;
  return settings?.tools?.seq === opening && expect()?.authority === account.authority && expect()?.membership_id === account.membership_id
    ? settings : undefined;
}

/** Your connection to a tool, as Tools last read it; undefined while unknown. */
export function projectToolEntry(settings: ProjectSettingsState, tool: MappingTool): ConnectedTool | undefined {
  return settings.tools?.items?.find(item => item.tool_id === tool);
}

/** You can pick for a tool once it is connected, or when your connection could not be read (the Authority checks on save). */
export function projectToolUsable(settings: ProjectSettingsState, tool: MappingTool): boolean {
  return !settings.tools?.items || projectToolEntry(settings, tool)?.status === 'linked';
}

/**
 * Tools, from the title bar, the project's tools line or its ⋯ menu: your
 * connection to each tool a project can read, and what this project reads
 * from it, all read at once.
 */
export function openProjectTools(project: ProjectSummary): void {
  const account = expect();
  if (!account || state.concealed || sheetShown() || (state.compose && !state.compose.hidden) || projectSettingsBlocked()) return;
  const tools: ProjectToolsState = { seq: ++seq, items: null, saving: false };
  const jira = jiraMapping.initial(++seq);
  const confluence = confluenceMapping.initial(++seq);
  set({ projectSettings: {
    project, menu: false, menuOrigin: state.projectSettings?.menuOrigin ?? 'header', rename: null, confirm: null, write: null, tools, jira, confluence,
  } });
  void loadProjectToolList(account, tools.seq);
  void readProjectMapping(jiraMapping, account, project.project_id, jira.seq);
  void readProjectMapping(confluenceMapping, account, project.project_id, confluence.seq);
}

async function loadProjectToolList(account: Expect, opening: number): Promise<void> {
  const result = await rpc('account.tools', { expect: account });
  const settings = toolsAt(account, opening);
  if (!settings) return;
  setProjectTools(settings, result.ok ? { items: result.value.tools, failure: undefined } : { failure: result.failure });
  if (!result.ok) accountLost(result.failure);
  // Read or not, the spaces can be read now: without your connections the Authority checks on save.
  void readSpaces(account);
}

async function readProjectMapping<Tool extends MappingTool>(adapter: MappingAdapter<Tool>, account: Expect, project_id: string, opening: number): Promise<void> {
  const result = await adapter.read(account, project_id);
  const current = mappingAt(adapter.tool, account, opening);
  if (!current) return;
  setMapping(current.settings, adapter.tool, result.ok ? adapter.accepted(current.setting, result.value)
    : { ...current.setting, status: 'failed' as const, failure: result.failure });
  if (!result.ok) { accountLost(result.failure); return; }
  // The line above the feed says what was read, even after a save it could not confirm.
  if (state.projectReads?.project_id === project_id) set({ projectReads: { ...state.projectReads, [adapter.tool]: adapter.reads(result.value) } });
  if (adapter.tool === 'confluence') void readSpaces(account);
}

/** A lead picks from their own Confluence spaces: read once the mapping is, and once Confluence is connected. */
async function readSpaces(account: Expect): Promise<void> {
  const settings = state.projectSettings;
  const setting = settings?.confluence;
  if (!settings?.tools || !setting || settings.project.role !== 'lead' || setting.status !== 'ready' || setting.catalog !== 'idle') return;
  // Your connection is still being read: its reply reads the spaces.
  if (settings.tools.items === null && settings.tools.failure === undefined) return;
  if (!projectToolUsable(settings, 'confluence')) return;
  setMapping(settings, 'confluence', { ...setting, catalog: 'loading', pickerFailure: undefined });
  const spaces = await rpc('projects.confluenceSpaces', { expect: account });
  const current = mappingAt('confluence', account, setting.seq);
  if (!current) return;
  setMapping(current.settings, 'confluence', spaces.ok
    ? { ...current.setting, catalog: 'read', spaces: spaces.value.items, next: spaces.value.next_cursor }
    : { ...current.setting, catalog: 'read', pickerFailure: spaces.failure });
  if (!spaces.ok) accountLost(spaces.failure);
}

/** One setting written; true once the Authority has it. A failure stays on its row until it is read again. */
async function writeProjectMapping<Tool extends MappingTool>(adapter: MappingAdapter<Tool>, account: Expect, remove: boolean): Promise<boolean> {
  const settings = state.projectSettings;
  const setting = settings?.[adapter.tool] as MappingSetting<Tool> | undefined;
  if (!settings || !setting?.value || setting.status !== 'ready') return false;
  setMapping(settings, adapter.tool, { ...setting, status: 'saving' });
  unresolvedChanged();
  const result = await adapter.write(account, settings.project.project_id, setting, remove, crypto.randomUUID());
  const current = mappingAt(adapter.tool, account, setting.seq);
  if (!current) return false;
  // Refused outright (a key the tool has no project for, a connection it did not accept), nothing changed on the
  // Authority: the pick stays, with why, to correct. Unconfirmed or changed meanwhile: it is read again first.
  const refused = !result.ok && result.failure.mutation_outcome !== 'unknown' && result.failure.code !== 'conflict';
  setMapping(current.settings, adapter.tool, result.ok ? adapter.accepted(current.setting, result.value)
    : refused ? { ...current.setting, status: 'ready' as const, failure: result.failure, writeFailed: false }
      : { ...current.setting, status: 'failed' as const, failure: result.failure, writeFailed: true });
  unresolvedChanged();
  if (!result.ok && SIGN_IN_LOST.includes(result.failure.code)) accountLost(result.failure);
  return result.ok;
}

/** The sign-in itself is gone or someone else's: a tool's own refusal (not found, not authorized there) is not that. */
const SIGN_IN_LOST = ['signed_out', 'account_changed', 'stale_access_state', 'sign_in_required'];

/** Why a tool's setting on Tools could not be written or read, in the renderer's words; null while nothing failed. */
export function projectToolFailureWords(settings: ProjectSettingsState, tool: MappingTool, name: string): string | null {
  const setting = settings[tool];
  const failure = setting?.failure;
  if (!setting || !failure || (setting.status !== 'failed' && setting.status !== 'ready')) return null;
  if (failure.code === 'conflict') return 'This setting changed. Reload it before editing.';
  if (setting.writeFailed) return 'The change could not be confirmed. Reload the setting before editing again.';
  if (setting.status === 'failed') return message(failure);
  if (failure.code === 'not_found') return tool === 'jira' ? `No ${name} project with that key that you can see.` : `A space could not be read with your ${name} connection.`;
  if (failure.code === 'unauthorized' || failure.code === 'forbidden') return `${name} refused the change. Check your ${name} connection in Tools and try again.`;
  return message(failure);
}

/** What Save would do to a tool's setting: nothing, set it, remove it, or nothing yet, as what is typed is not valid. */
export type ToolChange = 'set' | 'remove' | 'invalid' | null;
export function projectToolChange(settings: ProjectSettingsState, tool: MappingTool): ToolChange {
  if (tool === 'jira') {
    const setting = settings.jira;
    if (setting?.status !== 'ready' || !setting.value) return null;
    const key = setting.key.trim();
    const current = setting.value.mapping?.project_key ?? null;
    if (key === '') return current ? 'remove' : null;
    if (key === current) return null;
    return jiraMapping.valid(setting) ? 'set' : 'invalid';
  }
  const setting = settings.confluence;
  if (setting?.status !== 'ready' || !setting.value) return null;
  const current = setting.value.mapping?.space_ids ?? [];
  if (current.length === setting.selected.length && current.every(id => setting.selected.includes(id))) return null;
  if (setting.selected.length === 0) return current.length > 0 ? 'remove' : null;
  return confluenceMapping.valid(setting) ? 'set' : 'invalid';
}

/** Save is offered to a lead with something changed, nothing invalid, and no connection still waiting on the browser. */
export function projectToolsSavable(settings: ProjectSettingsState): boolean {
  const tools = settings.tools;
  if (!tools || tools.saving || settings.project.role !== 'lead' || (tools.connect && tools.connect.phase !== 'failed')) return false;
  const changes = PROJECT_MAPPING_TOOLS.map(tool => projectToolChange(settings, tool));
  return !changes.includes('invalid') && changes.some(change => change === 'set' || change === 'remove');
}

/** What a project reads, as its tools line and Save's toast say it. */
function readsOf(settings: ProjectSettingsState): Pick<ProjectReads, 'jira' | 'confluence'> {
  const jira = settings.jira?.value;
  const confluence = settings.confluence?.value;
  return {
    ...(jira ? { jira: jira.mapping?.project_key ?? null } : {}),
    ...(confluence ? { confluence: confluence.mapping ? confluence.mapping.space_ids.length : null } : {}),
  };
}

export function readsWords(reads: Pick<ProjectReads, 'jira' | 'confluence'>): string[] {
  return [
    reads.jira ? `Jira ${reads.jira}` : null,
    reads.confluence ? `${reads.confluence} Confluence space${reads.confluence === 1 ? '' : 's'}` : null,
  ].filter((part): part is string => part !== null);
}

/**
 * Save: every changed setting is written, in turn. Once all are, the sheet
 * closes and says what the project reads now; a row that failed keeps the
 * sheet up with its reason.
 */
export async function saveProjectTools(): Promise<void> {
  const settings = state.projectSettings;
  const account = expect();
  if (!settings?.tools || !account || !projectToolsSavable(settings)) return;
  const opening = settings.tools.seq;
  const changes = PROJECT_MAPPING_TOOLS.map(tool => [tool, projectToolChange(settings, tool)] as const)
    .filter(([, change]) => change === 'set' || change === 'remove');
  setProjectTools(settings, { saving: true });
  let saved = true;
  const done: typeof changes = [];
  for (const [tool, change] of changes) {
    const ok = tool === 'jira' ? await writeProjectMapping(jiraMapping, account, change === 'remove')
      : await writeProjectMapping(confluenceMapping, account, change === 'remove');
    saved &&= ok;
    if (ok) done.push([tool, change]);
    if (!toolsAt(account, opening)) return;
  }
  const current = toolsAt(account, opening);
  if (!current) return;
  const reads = readsOf(current);
  // What did save shows above the feed, even when another row failed. Initial
  // replies may still fill unknown fields, but cannot replace these known values.
  if (state.projectReads?.project_id === current.project.project_id) set({ projectReads: {
    ...state.projectReads, ...reads,
    available: current.tools?.items ? projectToolsAvailable(current.tools.items) : state.projectReads.available,
  } });
  if (!saved) {
    setProjectTools(toolsAt(account, opening) ?? current, { saving: false });
    unresolvedChanged();
    return;
  }
  set({ projectSettings: null, toast: savedWords(current.project.name, done, reads) });
  unresolvedChanged();
}

/** What Save did, and only that: "now reads Jira KAN", "no longer reads Confluence", or both. */
function savedWords(name: string, done: readonly (readonly [MappingTool, ToolChange])[], reads: Pick<ProjectReads, 'jira' | 'confluence'>): string {
  const names: Record<MappingTool, string> = { jira: 'Jira', confluence: 'Confluence' };
  const set = done.filter(([, change]) => change === 'set').map(([tool]) => readsWords({ [tool]: reads[tool] })[0]!);
  const removed = done.filter(([, change]) => change === 'remove').map(([tool]) => names[tool]);
  const parts = [set.length > 0 ? `now reads ${set.join(' and ')}` : null, removed.length > 0 ? `no longer reads ${removed.join(' and ')}` : null];
  return `${name} ${parts.filter(Boolean).join(' and ')}`;
}

/** Try again, when your connections could not be read: Tools reads them again. */
export function reloadProjectToolList(): void {
  const settings = state.projectSettings;
  const account = expect();
  if (!settings?.tools || !account || settings.tools.saving) return;
  setProjectTools(settings, { failure: undefined });
  void loadProjectToolList(account, settings.tools.seq);
}

/** Read again: a row whose read or save failed shows what the Authority has now. */
export function reloadProjectTool(tool: MappingTool): void {
  const settings = state.projectSettings;
  const account = expect();
  if (!settings?.tools || !account || settings.tools.saving) return;
  const { project_id } = settings.project;
  if (tool === 'jira') {
    const initial = jiraMapping.initial(++seq);
    setMapping(settings, 'jira', initial);
    void readProjectMapping(jiraMapping, account, project_id, initial.seq);
  } else {
    const initial = confluenceMapping.initial(++seq);
    setMapping(settings, 'confluence', initial);
    void readProjectMapping(confluenceMapping, account, project_id, initial.seq);
  }
}

/** Connect, in a row of Tools: the row waits on the browser, then lets you pick. Nothing else on the sheet is lost. */
export async function connectProjectTool(tool: ConnectedTool): Promise<void> {
  const settings = state.projectSettings;
  const account = expect();
  const sheet = settings?.tools;
  if (!settings || !sheet || !account || state.concealed || sheet.saving || (sheet.connect && sheet.connect.phase !== 'failed')) return;
  const opening = sheet.seq;
  const mine = ++seq;
  setProjectTools(settings, { connect: { seq: mine, tool, phase: 'starting' }, connected: undefined });
  const waiting = () => toolsAt(account, opening)?.tools?.connect?.seq === mine;
  const done = await runConnect(account, tool, waiting, to => {
    const current = toolsAt(account, opening);
    if (current) setProjectTools(current, { connect: { seq: mine, tool, ...to } });
  });
  const current = toolsAt(account, opening);
  if (!done || !current?.tools || current.tools.connect?.seq !== mine) return;
  if (done === 'cancelled') { setProjectTools(current, { connect: undefined }); return; }
  const items = current.tools.items?.map(item => item.tool_id === tool.tool_id ? { ...item, status: 'linked' as const } : item) ?? null;
  setProjectTools(current, { connect: undefined, connected: tool.tool_id, items });
  void readSpaces(account);
}

/** Cancel, in the row: the attempt is cancelled, so a late approval in the browser binds nothing. */
export function cancelProjectConnect(): void {
  const settings = state.projectSettings;
  const connect = settings?.tools?.connect;
  const account = expect();
  if (!settings || !connect) return;
  setProjectTools(settings, { connect: undefined });
  if (account && connect.phase === 'waiting' && connect.attempt) {
    void rpc('tools.cancel', { expect: account, tool_id: connect.tool.tool_id, attempt_id: connect.attempt.attempt_id });
  }
}

export function setProjectJira(key: string): void {
  const settings = state.projectSettings;
  if (settings?.jira?.status === 'ready' && settings.project.role === 'lead') setMapping(settings, 'jira', { ...settings.jira, key: key.toUpperCase() });
}

/** Stop reading: the row's choice is emptied, and Save removes the setting. */
export function clearProjectTool(tool: MappingTool): void {
  const settings = state.projectSettings;
  if (!settings?.tools || settings.tools.saving || settings.project.role !== 'lead') return;
  if (tool === 'jira' && settings.jira?.status === 'ready') setMapping(settings, 'jira', { ...settings.jira, key: '' });
  if (tool === 'confluence' && settings.confluence?.status === 'ready') setMapping(settings, 'confluence', { ...settings.confluence, selected: [] });
}

/** Spaces the project reads that your own catalog does not show: another lead's, or on a page not read yet. */
export function hiddenSpaces(setting: ProjectConfluenceSetting): string[] {
  return setting.selected.filter(id => !setting.spaces.some(space => space.id === id));
}

export function toggleProjectConfluenceSpace(id: string): void {
  const settings = state.projectSettings; const setting = settings?.confluence;
  if (!settings || !setting || setting.status !== 'ready' || settings.project.role !== 'lead' ||
      (!setting.spaces.some(space => space.id === id) && !setting.selected.includes(id))) return;
  const selected = setting.selected.includes(id) ? setting.selected.filter(value => value !== id) : [...setting.selected, id];
  if (selected.length <= 20) setMapping(settings, 'confluence', { ...setting, selected });
}
export async function moreProjectConfluenceSpaces(): Promise<void> {
  const settings = state.projectSettings; const setting = settings?.confluence; const account = expect();
  if (!settings || !setting || !account || setting.status !== 'ready' || setting.next === null || setting.loadingMore) return;
  setMapping(settings, 'confluence', { ...setting, loadingMore: true, failure: undefined });
  const result = await rpc('projects.confluenceSpaces', { expect: account, cursor: setting.next });
  const current = mappingAt('confluence', account, setting.seq);
  if (!current) return;
  setMapping(current.settings, 'confluence', result.ok
    ? { ...current.setting, spaces: appendPage(current.setting.spaces, result.value.items, space => space.id), next: result.value.next_cursor, loadingMore: false }
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
    const unknown = outcomeUnknown(result.failure, retrying);
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

/**
 * The project on screen, as it is now (renamed, archived, your role in it
 * read again): the same page, with its follow-ups still open over it.
 */
function sameProjectRoute(project: ProjectSummary): Partial<State> {
  if (state.route.page !== 'project' || state.route.project.project_id !== project.project_id) return {};
  const was = state.route;
  const route: Route = { page: 'project', project };
  return { route, ...(state.followUps?.route === was ? { followUps: { ...state.followUps, route } } : {}) };
}

function replaceProject(project: ProjectSummary): void {
  const update = (items: ProjectSummary[]) => items.map(item => item.project_id === project.project_id ? project : item);
  set({ projects: { ...state.projects, items: update(state.projects.items) }, archivedProjects: { ...state.archivedProjects, items: update(state.archivedProjects.items) },
    ...sameProjectRoute(project) });
  listChanged();
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
      ...sameProjectRoute(fresh),
      toast: detail.archived ? `Archived ${fresh.name}` : `Restored ${fresh.name}` });
    listChanged();
    return;
  }
  set({ toast: `Left ${project.name}` });
  forgetLeftProject(project.project_id);
}

/** Leaving removes every local target for the project before returning Home, which reads again. */
function forgetLeftProject(projectId: string): void {
  const projects = state.projects.items.filter(project => project.project_id !== projectId);
  const archivedProjects = state.archivedProjects.items.filter(project => project.project_id !== projectId);
  const compose = state.compose;
  let nextCompose = compose;
  // A capture on its way, or kept to resend, was sent as it was: only the Authority's answer changes it.
  if (compose && !locked(compose) && !compose.kept) {
    const picked = compose.projects.filter(project => project.project_id !== projectId);
    const previous = compose.picking ? { ...compose.picking, projects: compose.picking.projects.filter(project => project.project_id !== projectId) } : null;
    nextCompose = { ...compose, context: compose.context?.project_id === projectId ? null : compose.context, projects: picked, picking: previous,
      ...(compose.readers === 'projects' && picked.length === 0 ? { readers: 'only-me' as const } : {}) };
  }
  readSeq += 1;
  emptyBar();
  // New project working out of sight on another project stays at it; on this one, it ends, saying what may not have gone in.
  const making = state.sheet?.kind === 'new-project' ? state.sheet : null;
  const ownProject = making !== null && (making.project?.project_id === projectId || making.createdId === projectId);
  set({ projects: { ...state.projects, items: projects }, archivedProjects: { ...state.archivedProjects, items: archivedProjects }, compose: nextCompose,
    route: { page: 'home' }, list: null, roster: null, reader: null, ask: null, sources: null, sheet: making && !ownProject ? making : null,
    barScope: { kind: 'global' }, organization: null });
  listChanged();
  if (making && ownProject) finishNewProject(making);
  unresolvedChanged();
  void loadHome();
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
  if (!account || route.page !== 'project' || state.concealed || newProjectInTheWay() || state.sheet) return;
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
    ...(shown && shown.role !== project.role ? sameProjectRoute({ ...shown, role: project.role }) : {}),
  });
  listChanged();
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
  const query = askText(sheet.query);
  // More for a name just changed: its page belongs to the old name, so the new one is found afresh.
  if (more && sheet.directory && sheet.directory.query !== query) return findPeople(false);
  const cursor = more ? sheet.directory?.next : undefined;
  if (more && !cursor) return;
  const mine = ++seq;
  const shown = more ? sheet.directory?.items ?? [] : [];
  // A new project-directory search ends the last add's Undo.
  patch({ directory: { seq: mine, query, items: shown, next: sheet.directory?.next ?? null, loading: true },
    ...(!wholeOrganization && !more ? { added: null } : {}) });
  const params = { expect: account, ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) };
  const result = wholeOrganization ? await rpc('people.directory', params)
    : await rpc('projects.directory', { ...params, project_id: sheet.project!.project_id });
  const current = wholeOrganization ? newProjectSheet(sheet.seq) : peopleSheet(sheet.seq);
  if (!current || current.directory?.seq !== mine) return;
  if (!result.ok) {
    if (wholeOrganization && NO_DIRECTORY.includes(result.failure.code)) {
      // Once the project exists its people were picked or are added in People; the sheet's way of working stays.
      setNewProject(current.project ? { directory: null } : { peopleLater: true, query: '', directory: null }, sheet.seq);
      return;
    }
    patch({ directory: { seq: mine, query, items: shown, next: null, loading: false, failure: result.failure } });
    accountLost(result.failure);
    return;
  }
  patch({ directory: {
    seq: mine, query, items: appendPage(shown, result.value.items, person => person.membership_id), next: result.value.next_cursor, loading: false,
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

/**
 * The sidebar's New project, and Home's when there are no projects. The
 * organization's first people show at once. One still at work after Create
 * comes back as it is.
 */
export function openNewProject(): void {
  if (!expect() || state.concealed || (state.compose && !state.compose.hidden)) return;
  const working = newProjectSheet();
  if (working?.hidden) { setNewProject({ hidden: false }, working.seq); return; }
  if (state.sheet) return;
  set({
    toast: null,
    sheet: {
      kind: 'new-project', seq: ++seq, hidden: false, name: '', create: { requestId: crypto.randomUUID(), name: '', status: 'editing' }, confirmClose: false,
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
    const unknown = outcomeUnknown(result.failure, retrying);
    setNewProject({ create: { ...current.create, status: unknown ? 'unknown' : 'failed', failure: result.failure } }, mine);
    accountLost(result.failure);
    return;
  }
  setNewProject({ create: { ...current.create, status: 'created' }, createdId: result.value.project_id }, mine);
  await openCreated();
}

/**
 * The project Create made, read: it joins your projects and opens, the sheet
 * steps aside, and the people and files picked go into it. Without the
 * organization's directory the sheet stays: a lead now finds people in the
 * project's own.
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
    listChanged();
  }
  setNewProject({ opening: false, project, notice: undefined }, mine);
  if (newProjectSheet(mine)?.peopleLater && project.role === 'lead') {
    void loadRoster(project.project_id);
    void findPeople();
  } else {
    setNewProject({ hidden: true, opened: true }, mine);
    void openProject(project);
  }
  pumpNewProject();
}

/**
 * Once the project exists, New project works down its list one request at a
 * time: each person, then each file. One whose outcome is unknown holds back
 * the rest until it is settled. When nothing more can start, the sheet comes
 * back for what needs you, or closes. Without the organization's directory
 * the sheet stays for finding people, and the project opens behind it, once.
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
  if (!sheet.opened) {
    setNewProject({ opened: true }, sheet.seq);
    void openProject(sheet.project);
    return;
  }
  if (!sheet.peopleLater || sheet.hidden) settleNewProject(sheet);
}

/** Once its project is open, New project can step aside while it works, and come back. */
export function newProjectSteppable(sheet: NewProjectSheet): boolean {
  return sheet.project !== null && sheet.opened && !sheet.peopleLater;
}

/**
 * New project works out of sight: a sheet that would open over it would take
 * its place, so New project comes back instead, showing what it is doing.
 */
function newProjectInTheWay(): boolean {
  const sheet = newProjectSheet();
  if (!sheet?.hidden) return false;
  setNewProject({ hidden: false }, sheet.seq);
  return true;
}

/**
 * Nothing more can start. A person or file that may have arrived, or a file
 * Try again can resend, brings the sheet back; otherwise it closes and the
 * toast says how it went. A question already up is left to be answered.
 */
function settleNewProject(sheet: NewProjectSheet): void {
  const refused = sheet.picks.some(pick => pick.status === 'failed') || sheet.files.some(file => file.status === 'failed' && file.handle !== undefined);
  if (newProjectUnsettled(sheet) || refused) {
    if (sheet.hidden) setNewProject({ hidden: false }, sheet.seq);
    return;
  }
  if (sheet.skip !== null || sheet.confirmClose) return;
  finishNewProject(sheet, true);
}

/** Said when New project closes by itself with everyone added and every file saved; nothing when there was nothing to add. */
function readyWords(name: string, people: number, files: number): string | null {
  const parts = [
    people > 0 ? `${people} ${people === 1 ? 'person' : 'people'}` : null,
    files > 0 ? `${files} ${files === 1 ? 'file' : 'files'}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `${name} is ready · ${parts.join(', ')}` : null;
}

/** While New project works out of sight: what it is doing, and how far it got. */
export function newProjectProgress(sheet: NewProjectSheet): { words: string; done: number; total: number } | null {
  if (!sheet.hidden || !sheet.project) return null;
  const files = sheet.files.filter(file => file.handle);
  const total = sheet.picks.length + files.length;
  const done = sheet.picks.filter(pick => pick.status === 'added').length + files.filter(file => file.status === 'saved').length;
  const doing = [
    sheet.picks.length > 0 ? `adding ${sheet.picks.length} ${sheet.picks.length === 1 ? 'person' : 'people'}` : null,
    files.length > 0 ? `saving ${files.length} ${files.length === 1 ? 'file' : 'files'}` : null,
  ].filter(Boolean).join(', ');
  return { words: doing ? `${sheet.project.name} created · ${doing}` : `${sheet.project.name} created`, done, total };
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
  if (!sheet) return;
  // Still working: it steps aside again, and the toast keeps saying how far it got.
  if (newProjectBusy(sheet)) { if (newProjectSteppable(sheet)) setNewProject({ hidden: true }, sheet.seq); return; }
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
 * were not added to it or some files not saved into it, or may not have been;
 * when it closed by itself, it says what went in. Before Create nothing was
 * sent, so nothing is said.
 */
function finishNewProject(sheet: NewProjectSheet, settled = false): void {
  for (const file of sheet.files) if (file.kept) releaseCopy(file.requestId);
  const made = sheet.createdId !== null;
  const people = made && sheet.picks.some(pick => pick.status !== 'added');
  const files = made && sheet.files.some(file => file.status !== 'saved');
  const toast = people && files ? UNFINISHED : people ? UNADDED_PEOPLE : files ? UNSAVED_FILES
    : settled && sheet.project ? readyWords(sheet.project.name, sheet.picks.length, sheet.files.length) : null;
  set({ sheet: null, ...(toast ? { toast } : {}) });
  unresolvedChanged();
  if (!sheet.project) return;
  refreshList({ kind: 'project', project_id: sheet.project.project_id });
  // Someone added after the project opened shows in its title bar too.
  if (state.roster?.projectId === sheet.project.project_id) void loadRoster(sheet.project.project_id);
}

function releaseCopy(requestId: string, account: Expect | null = expect()): void {
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
    const unknown = outcomeUnknown(result.failure, retrying);
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

/**
 * Uploads a document, or with no upload resends the original the client kept
 * of it under the same request (Try again), not whatever its path holds now.
 */
function sendDocument(account: Expect, request_id: string, audience: Audience,
  upload: { file: FileHandle; title: string; project_ids: readonly string[] } | null): Promise<Result<Receipt>> {
  return upload
    ? rpc('documents.upload', { expect: account, request_id, file_handle: upload.file.handle, title: upload.title, audience, project_ids: upload.project_ids })
    : rpc('documents.retry', { expect: account, request_id, audience });
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
  const result = await sendDocument(account, file.requestId, audience, retrying ? null : { file: file.handle!, title: file.name, project_ids: [project_id] });
  const current = newProjectSheet(mine)?.files.find(entry => entry.id === id);
  if (!current) return;
  if (!result.ok) {
    const unknown = outcomeUnknown(result.failure, retrying);
    patchFile(mine, id, { status: unknown ? 'unknown' : 'failed', failure: result.failure, kept: current.kept || unknown });
    accountLost(result.failure);
    // Refused, the rest carry on; unknown, they wait, and the project opens meanwhile.
    pumpNewProject();
    return;
  }
  patchFile(mine, id, { status: 'saved', kept: false, ...(result.value.extraction ? { extraction: result.value.extraction } : {}) });
  // The project on screen shows each file as it lands.
  refreshList({ kind: 'project', project_id });
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
  return state.status?.signed_in === true && sheetShown()?.kind === 'new-project' && items !== undefined && items.length > 0 &&
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
  if ((state.compose && !state.compose.hidden) || state.route.page === 'organization' || newProjectInTheWay() || state.sheet) return;
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
  return current.matches !== null && !current.concealed && !current.ask && !current.reader && !sheetShown(current) &&
    !(current.compose && !current.compose.hidden) && searchQuery(current.barText) !== null;
}

/**
 * Another app is in front and the page is covered: a project, Mine, People &
 * invites, Tools, Home, a decision, follow-ups and an item's page, an answer
 * or an original. The bar's text is covered with it.
 */
export function pageCovered(current: State = state): boolean {
  const { route } = current;
  return current.concealed && (current.ask !== null || route.page === 'home' || route.page === 'decision' || route.page === 'follow-ups' || route.page === 'project' ||
    route.page === 'mine' || current.reader !== null || followUpsShown(current) !== null ||
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
 * What main's quit guard, and its update_held, go by: a note, a file or a
 * project change (a create, and New project's adds, included) on its way, or
 * not yet confirmed either way.
 */
function unresolvedWork(): { unresolved: boolean; file?: true; change?: true } {
  const compose = state.compose;
  const saving = compose?.status === 'sending' || compose?.status === 'unknown' || compose?.status === 'checking';
  const sheet = state.sheet?.kind === 'new-project' ? state.sheet : null;
  const uploading = sheet?.files.some(file => file.status === 'saving' || file.status === 'checking' || file.status === 'unknown') === true;
  const changing = changeBlocked() || projectSettingsBlocked() || sheet?.create.status === 'sending' || sheet?.create.status === 'unknown' ||
    sheet?.picks.some(pick => pick.status === 'adding' || pick.status === 'unknown') === true;
  return {
    unresolved: saving || uploading || changing,
    ...(saving ? (compose.file ? { file: true } : {}) : uploading ? { file: true } : changing ? { change: true } : {}),
  };
}

/** Tells main's quit guard when what is unresolved changes. */
function unresolvedChanged(): void {
  const told = unresolvedWork();
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
function release(compose: ComposeState, account: Expect | null = expect()): void {
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
  if (sheetShown()?.kind === 'new-project' || projectSettingsModal()) return;
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
  const result = compose.file
    ? await sendDocument(account, compose.requestId, audience, retrying ? null : { file: compose.file, title: compose.file.name, project_ids })
    : await rpc('notes.submit', { expect: account, request_id: compose.requestId, text: compose.text, audience, project_ids });
  const current = state.compose;
  if (current?.seq !== compose.seq) return;
  if (!result.ok) {
    const unknown = outcomeUnknown(result.failure, retrying);
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
  return state.status?.signed_in === true && !sheetShown() && !projectSettingsModal() && items?.length === 1 && items[0]!.kind === 'file';
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
  if (!expect() || sheetShown() || projectSettingsModal() || (on === 'window' && !windowTakesDrop())) return;
  const target = on === 'window' || on === 'sheet' ? (on === 'window' ? state.route.page === 'project' ? state.route.project : null : null) : on;
  if (target?.status === 'archived') { set({ toast: 'Restore this project to add files or notes.' }); return; }
  const result = await dropFile(file);
  if (!expect() || sheetShown() || projectSettingsModal()) return;
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
  // People closes, as the sidebar's rows must take a drop; unless a change in it is on its way.
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
    if (!state.concealed) void refreshProjects();
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

/** The window came forward (⌘E, the tray): refresh the account, sidebar and visible Home. */
export async function windowShown(): Promise<void> {
  if (state.concealed) return;
  await refreshStatus();
  searchAgain();
  await refreshProjects();
  if (state.route.page === 'home' && !state.concealed) void loadHome();
}

// ---- Home: what needs you ---------------------------------------------------------

/**
 * One row on Home (open items and Home v1, section 8; R63–R65). `approve`: a
 * meeting's decisions wait for you. `send`: a meeting you approved has
 * follow-ups not sent yet. `update`: a follow-up waits on you. `review`: one
 * someone else owns changed, and still does not match, since you sent it.
 * `failed`: the impact check did not finish. `checking`: it is on its way.
 * Every item row opens the item's page (F5).
 */
export type NeedRow =
  | { kind: 'approve'; review: PersonMeetingReviewV2 }
  | { kind: 'checking'; review: PersonMeetingReviewV2; run?: PersonRunV1 }
  | { kind: 'failed'; review: PersonMeetingReviewV2; run: PersonRunV1 }
  | { kind: 'send'; send: HomeView['send'][number] }
  | { kind: 'update' | 'review'; item: OpenItemView };
export interface HomeState {
  seq: number;
  loading: boolean;
  failure?: Failure;
  /** Meeting review is available; shared open items do not depend on it. */
  meetings: boolean;
  /** Each part keeps its last good value when a later read of it fails. */
  reviews: readonly PersonMeetingReviewV2[];
  runs: readonly PersonRunV1[];
  open: HomeView | null;
  rows: NeedRow[];
  /** What waits on you is being read live: its rows show already, and those not read yet say so faintly. */
  reading: boolean;
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
  /** The approve or reject may have arrived: the choices are locked, and a resend repeats them. */
  unknown?: boolean;
  /** The impact check of an approved decision: its follow-ups line counts what it found. */
  run: PersonRunV1 | null;
  /** The meeting's record, when the decision was opened from its follow-ups: its line counts them by it. */
  record?: string;
}

/**
 * Rows that wait on you first; what is on its way last. Changed items (Update
 * or Review) sort before the others. An item whose last check is `changed`
 * and whose owner is not you (`me`) is a Review row; every other item is an
 * Update row (R64). Only impact checks make rows: a sweep never does, going
 * or failed.
 */
export function needRows(reviews: readonly PersonMeetingReviewV2[], runs: readonly PersonRunV1[], open: HomeView | null, me: string | null): NeedRow[] {
  const byApproval = new Map(runs.filter(run => run.trigger === 'approved_record').map(run => [run.event_ref, run]));
  const approve: NeedRow[] = [];
  const failed: NeedRow[] = [];
  const checking: NeedRow[] = [];
  for (const review of reviews) {
    if (review.status === 'pending') { approve.push({ kind: 'approve', review }); continue; }
    if (review.status !== 'approved' && review.status !== 'publishing') continue;
    const run = byApproval.get(review.approval_id);
    if (!run) {
      // The publisher queues the run only after the approved record is written.
      if (review.status === 'publishing') checking.push({ kind: 'checking', review });
      continue;
    }
    // A finished check makes no row of its own: what it found comes from `home`.
    if (run.state === 'failed') failed.push({ kind: 'failed', review, run });
    else if (run.state !== 'done') checking.push({ kind: 'checking', review, run });
  }
  const items = open?.items ?? [];
  const changed = (item: OpenItemView) => item.check?.verdict === 'changed';
  return [
    ...approve,
    ...(open?.send ?? []).map(send => ({ kind: 'send' as const, send })),
    ...items.filter(changed).map((item): NeedRow => ({ kind: me === null || item.owner.membership_id === me ? 'update' : 'review', item })),
    ...items.filter(item => !changed(item)).map((item): NeedRow => ({ kind: 'update', item })),
    ...failed, ...checking,
  ];
}

/** Rows that wait on you: Home's head and the sidebar's badge. What is on its way is not counted. */
export function needsCount(current: State = state): number {
  return current.home?.rows.filter(row => row.kind !== 'checking').length ?? 0;
}

function homeShown(mine?: number): HomeState | null {
  const home = state.home;
  return home && !state.concealed && state.status?.signed_in && (state.route.page === 'home' || state.route.page === 'decision') && (mine === undefined || home.seq === mine) ? home : null;
}

/** Home's rows from its parts. */
function withRows(home: HomeState): HomeState {
  return { ...home, rows: needRows(home.reviews, home.runs, home.open, state.status?.account?.membership_id ?? null) };
}

function homeNeedsPolling(): boolean {
  return resultOwed || sweepOwed !== null || state.route.page === 'decision' || (state.home?.rows.some(row => row.kind === 'checking') ?? false);
}

/** The Home load on its way, if any; one more is owed after it when `homeAgain`. */
let homeLoading: Promise<void> | null = null;
let homeAgain = false;
/** Bumped on an account change, so an older load neither clears nor repeats a newer one. */
let homeToken = 0;

/**
 * Home: what waits on you. Read when Home opens, when the window comes
 * forward, and after a decision or a Send; read again while a check is going.
 * Each of these is a Home load: it may start one sweep. A load asked for while
 * one is on its way joins it, and one more load runs after it, never more.
 */
export function loadHome(): Promise<void> {
  if (homeLoading) { homeAgain = true; return homeLoading; }
  const token = ++homeToken;
  homeLoading = (async () => {
    try {
      do { homeAgain = false; await loadHomeOnce(); } while (homeAgain && token === homeToken);
    } finally {
      if (token === homeToken) homeLoading = null;
    }
  })();
  return homeLoading;
}

async function loadHomeOnce(): Promise<void> {
  const account = expect();
  if (!account || state.concealed || (state.route.page !== 'home' && state.route.page !== 'decision')) return;
  stopRunPolling();
  homeLoads += 1;
  const mine = ++seq;
  const previous: Omit<HomeState, 'seq' | 'loading'> = state.home ?? { meetings: false, reviews: [], runs: [], open: null, rows: [], reading: false };
  set({ home: { ...previous, seq: mine, loading: true, failure: undefined } });
  // The tools are read beside everything else: only the meeting reviews wait on them, since an owner can receive items from
  // someone else's decision without Granola.
  await readHome(mine, false, rpc('account.tools', { expect: account }));
}

/** The last read of what waits on you failed: the next poll reads it again. */
let openUnread = false;
/** A check ended and what it found has not been read since: Home keeps looking until it has. */
let resultOwed = false;
/**
 * Home loads begun, counted, and the one that asked for its due sweep: each
 * Home load asks for one new sweep at most (ruling R50). A sweep that is
 * already queued is started as an impact check is.
 */
let homeLoads = 0;
let askedIn = 0;
/**
 * The sweep Home asked for: what it finds is owed once a runs list shows it
 * ended, or no longer holds it, even if no list showed it going.
 */
let sweepOwed: string | null = null;

const going = (run: PersonRunV1) => run.state === 'pending' || run.state === 'running';

/** A check that was going before and is not now: what it found may wait on Home. */
function checkEnded(before: readonly PersonRunV1[], after: readonly PersonRunV1[]): boolean {
  return before.some(run => going(run) && !after.some(next => next.run_id === run.run_id && going(next)));
}

/**
 * The meeting reviews, when Granola is there to review them. A load learns
 * that from the tools (`tools`), read beside Home's other reads; a poll keeps
 * what its load learned. Tools that cannot be read fail this part, with their
 * own failure (`failed`).
 */
async function readReviews(mine: number, tools: Promise<Result<ConnectedTools>> | undefined, failed: (failure: Failure) => void): Promise<readonly PersonMeetingReviewV2[]> {
  if (tools) {
    const answer = await tools;
    if (!answer.ok) {
      failed(answer.failure);
      accountLost(answer.failure);
      throw new CommandFailed(answer.failure);
    }
    const granola = answer.value.tools.find(tool => tool.tool_id === 'granola');
    const home = homeShown(mine);
    if (!home) return [];
    set({ home: { ...home, meetings: granola !== undefined && granola.status !== 'unavailable' } });
  }
  return state.home?.meetings ? (await meetingCommand({ operation: 'reviews' })).reviews : [];
}

/**
 * The reviews, your runs and what waits on you, read side by side, each
 * shown as soon as it is read, so quick rows never wait for slow ones. Each
 * part keeps its last good value when its read fails; the runs and home
 * parts fail silently, and only a failed reviews read says so (never on a
 * poll). What waits on you (`readWaiting`) opens each item live in its tool,
 * so a poll (`quiet`) reads it only once a check has ended, or after that
 * read failed. Home stops loading once its rows are read; the live read then
 * fills them, and says whether a sweep is due.
 */
async function readHome(mine: number, quiet: boolean, tools?: Promise<Result<ConnectedTools>>): Promise<void> {
  const before = state.home?.runs ?? [];
  /** One part, shown once read while Home is still this read's; answered as settled. */
  const shown = <T>(read: Promise<T>, apply: (value: T) => Partial<HomeState>): Promise<PromiseSettledResult<T>> => read.then(
    value => {
      const home = homeShown(mine);
      if (home) set({ home: withRows({ ...home, ...apply(value) }) });
      return { status: 'fulfilled' as const, value };
    },
    (reason: unknown) => ({ status: 'rejected' as const, reason }));
  let toolsFailure: Failure | undefined;
  const swept = (runs: readonly PersonRunV1[]) => sweepOwed !== null && !runs.some(run => run.run_id === sweepOwed && going(run));
  const ended = (runs: readonly PersonRunV1[]) => checkEnded(before, runs) || swept(runs);
  const reviewsRead = shown(readReviews(mine, tools, failure => { toolsFailure = failure; }), reviews => ({ reviews }));
  const runsRead = shown(runsCommand({ schema_version: 1, operation: 'list' }), value => {
    // Shown, the list no longer shows the check going: what it found is owed from now, whichever read brings it.
    if (ended(value.runs)) resultOwed = true;
    return { runs: value.runs };
  });
  let waiting = quiet ? null : readWaiting(mine);
  const [reviews, runs] = await Promise.all([reviewsRead, runsRead]);
  const checkSwept = runs.status === 'fulfilled' && swept(runs.value.runs);
  if (waiting === null && homeShown(mine) && (openUnread || resultOwed)) waiting = readWaiting(mine);
  if (waiting) await waiting.rows;
  const loaded = homeShown(mine);
  if (!loaded) return;
  const failure: Failure | undefined = reviews.status === 'fulfilled' ? undefined : quiet ? loaded.failure : toolsFailure ?? { code: 'unavailable', retryable: true };
  set({ home: { ...loaded, loading: false, failure } });
  const open = waiting ? await waiting.done : null;
  // A read that is no longer Home's shows nothing, so it settles nothing Home owes either.
  const home = homeShown(mine);
  if (!home) return;
  if (checkSwept) sweepOwed = null;
  if (open) openUnread = !open.read;
  // A check that ended owes a read of what it found (set as its list showed); only a read that brings its rows pays it.
  if (open?.read) resultOwed = false;
  updateDecisionRun(home.runs);
  // Tools that could not be read fail the load, as Home says: it waits for Try again, and starts no run meanwhile.
  if (toolsFailure) return;
  // The next poll waits longer after a failed runs read, or a failed read of what a check found.
  const failed = runs.status === 'rejected' ? failureOf(runs.reason) : resultOwed && open && !open.read ? open.failure : undefined;
  void driveRuns(home.runs, home.reviews.some(review => review.status === 'publishing'), failed, open?.sweepDue === true);
}

/** How a read of what waits on you went: whether its rows were read (and why not), and whether a sweep is due. */
interface WaitingRead { read: boolean; failure?: Failure; sweepDue: boolean }

/**
 * What waits on you, read twice side by side: rows only, which needs no live
 * read and shows at once from ECHO's own fields, and in full, whose live reads
 * fill in what each item says now, and which alone says whether a sweep is
 * due. Rows read again keep what was read live of each until the full read
 * answers. A full read that fails leaves the rows it did not read saying ECHO
 * couldn't read them just now, and no error of its own. `rows` settles once
 * the rows show (or neither read brought them); `done` once both reads
 * settled.
 */
function readWaiting(mine: number): { rows: Promise<void>; done: Promise<WaitingRead> } {
  let rows: HomeView | null = null;
  let full: HomeView | null = null;
  let fullFailed = false;
  const show = () => {
    const home = homeShown(mine);
    if (!home) return;
    const reading = full === null && !fullFailed;
    let open = home.open;
    if (rows) {
      const kept = keepLive(home.open?.items ?? [], rows.items);
      open = { ...rows, items: full ? withLive(kept, full.items) : fullFailed ? unreadNow(kept) : kept };
    } else if (full) open = full;
    set({ home: withRows({ ...home, open, reading }) });
  };
  const home = homeShown(mine);
  if (home) set({ home: { ...home, reading: true } });
  // Both are sent at once, the full read first.
  const slow = runsCommand({ schema_version: 1, operation: 'home' }).then(value => { full = value; show(); return value; }, (error: unknown) => {
    fullFailed = true;
    show();
    throw error;
  });
  const quick = runsCommand({ schema_version: 1, operation: 'home', rows_only: true }).then(value => { rows = value; show(); return value; });
  const done = Promise.allSettled([quick, slow]).then(([fast, whole]): WaitingRead => ({
    read: fast.status === 'fulfilled' || whole.status === 'fulfilled',
    ...(fast.status === 'rejected' ? { failure: failureOf(fast.reason) } : {}),
    sweepDue: whole.status === 'fulfilled' && whole.value.sweep_due,
  }));
  // The rows show once the quick read brings them; when it fails, the full read is all there is.
  const shownRows = quick.then(() => undefined, () => done.then(() => undefined));
  return { rows: shownRows, done };
}

let runPoll: ReturnType<typeof setTimeout> | null = null;
let runSeq = 0;
/** Polls in a row whose runs read failed, or whose start started nothing: each waits longer than the one before. */
let runFailures = 0;
/** How often Home looks again while a check is going, and the longest it waits after failed reads. */
const RUN_POLL_MS = 5_000;
const RUN_POLL_MAX_MS = 60_000;

function stopRunPolling(): void {
  runSeq += 1;
  if (runPoll) clearTimeout(runPoll);
  runPoll = null;
}

function pollRuns(mine: number, delay: number): void {
  runPoll = setTimeout(() => {
    runPoll = null;
    const home = homeShown();
    if (mine === runSeq && home) void readHome(home.seq, true);
  }, delay);
}

/**
 * Milliseconds until the next runs read, or null for none. `failures` counts
 * consecutive failed reads. Home looks again only while a check is pending or
 * running, a review is publishing, or what a finished check found is still
 * unread (`owed`); after failed reads it waits twice as long each time (10 s,
 * 20 s, at most 60 s). A read that failed as unavailable with nothing in
 * flight is not tried again: an Authority with no model answers so for good,
 * and no check ever ends there.
 */
export function runPollDelay(input: {
  readonly runs: readonly PersonRunV1[]; readonly publishing: boolean; readonly failures: number; readonly lastFailure?: Failure; readonly owed?: boolean;
}): number | null {
  const inFlight = input.publishing || input.owed === true || input.runs.some(run => run.state === 'pending' || run.state === 'running');
  if (input.failures === 0) return inFlight ? RUN_POLL_MS : null;
  if (!inFlight && input.lastFailure?.code === 'unavailable') return null;
  return Math.min(RUN_POLL_MAX_MS, RUN_POLL_MS * 2 ** input.failures);
}

/**
 * The run to start next when none is running: the oldest queued impact check,
 * else the oldest queued sweep (impact checks start before sweeps, spec
 * section 6). Lists come newest first.
 */
export function runToStart(runs: readonly PersonRunV1[]): PersonRunV1 | undefined {
  if (runs.some(run => run.state === 'running')) return undefined;
  const queued = [...runs].reverse().filter(run => run.state === 'pending');
  return queued.find(run => run.trigger === 'approved_record') ?? queued.find(run => run.trigger === 'sweep');
}

/** A start answered `busy`: another run goes first, and this one stays queued. */
const BUSY: Failure = { code: 'busy', retryable: true };

/**
 * Starts a queued run. A start that starts nothing (refused, failed, or
 * `busy`) is answered with why, so the next look waits longer, as after a
 * failed runs read (ruling R50).
 */
async function startRun(run_id: string): Promise<Failure | undefined> {
  try {
    const { state: started } = await runsCommand({ schema_version: 1, operation: 'start', run_id });
    return started === 'busy' ? BUSY : undefined;
  } catch (error) {
    return failureOf(error);
  }
}

/**
 * Runs go only from your signed-in desktop: start the next queued one when
 * none is going, impact checks first, then sweeps (a sweep's attempt that
 * went back to the queue is started again like an impact check's); then look
 * again when `runPollDelay` says. Once no run is queued or going, a sweep
 * Home says is due (`sweepDue`) is asked for and started, once per Home load.
 * `failure` is the runs read's, when it failed: the list is the last good one.
 */
async function driveRuns(listed: readonly PersonRunV1[], publishing = false, failure?: Failure, sweepDue = false): Promise<void> {
  stopRunPolling();
  const mine = runSeq;
  const load = homeLoads;
  const current = () => mine === runSeq && homeShown() !== null;
  // A failed read never skips the start or the sweep request (D6): each is tried, and its failure joins the read's.
  let failed = failure;
  const next = runToStart(listed);
  if (next) {
    const refused = await startRun(next.run_id);
    failed ??= refused;
    if (!current()) return;
  } else if (sweepDue && askedIn !== load && !listed.some(going)) {
    // This load's one sweep request is spent here, as it is made.
    askedIn = load;
    const refused = await startDueSweep();
    failed ??= refused;
    if (!current()) return;
  }
  runFailures = failed ? runFailures + 1 : 0;
  const delay = runPollDelay({ runs: listed, publishing, failures: runFailures, lastFailure: failed, owed: resultOwed || sweepOwed !== null });
  if (delay !== null && current()) pollRuns(mine, delay);
}

/**
 * The sweep of your own items Home says is due, asked for and started. It
 * makes no row: what it finds shows once a runs list shows it ended. A failed
 * request shows nothing (the next Home load may ask again); a start that
 * starts nothing is answered as `startRun` answers it.
 */
async function startDueSweep(): Promise<Failure | undefined> {
  let asked: RunsResults['sweep'];
  try {
    asked = await runsCommand({ schema_version: 1, operation: 'sweep', scope: 'mine' });
  } catch {
    return undefined;
  }
  if (!('run_id' in asked)) return undefined;
  sweepOwed = asked.run_id;
  return startRun(asked.run_id);
}

/** A fresh list updates the open decision too, even if its check finished while hidden. */
function updateDecisionRun(runs: readonly PersonRunV1[]): void {
  const decision = state.decision;
  if (!decision || decision.record !== undefined || !decisionShown(decision.seq)) return;
  const run = runs.find(item => item.event_ref === decision.approval_id) ?? null;
  if (run?.run_id !== decision.run?.run_id || run?.state !== decision.run?.state) {
    set({ decision: { ...decision, run } });
    if (run?.state === 'done') void loadLine('impactLine', 'run', run.run_id);
  }
}

/** Open in Jira (or the item's own tool), from an item ECHO opened for you: the tool checks your access when it opens. */
export async function openItemInTool(item: OpenItemView): Promise<boolean> {
  const source = item.reach === 'opened' ? item.current?.source : undefined;
  return source !== undefined && 'permalink' in source ? openImpactSource(source) : false;
}

/** The decision, while it is the page, or opened over a meeting's follow-ups (`record`) and showing. */
function decisionShown(mine: number): DecisionState | null {
  const decision = state.decision;
  if (!decision || decision.seq !== mine) return null;
  if (decision.record === undefined) return state.route.page === 'decision' ? decision : null;
  return followUpsShown()?.views.some(view => view.kind === 'decision' && view.seq === mine) ? decision : null;
}

/** A decision, from its Home row: what was proposed, and, once approved, its check and its follow-ups. */
export async function openDecision(approval_id: string, run: PersonRunV1 | null = null): Promise<void> {
  if (!expect() || state.concealed) return;
  readSeq += 1;
  const mine = ++seq;
  set({
    route: { page: 'decision' }, reader: null, ask: null, sources: null, toast: null, organization: null, list: null, roster: null,
    barScope: { kind: 'global' },
    decision: newDecision(approval_id, mine, run),
  });
  syncSearch();
  if (run?.state === 'done') void loadLine('impactLine', 'run', run.run_id);
  await readDecision(mine, approval_id);
}

function newDecision(approval_id: string, mine: number, run: PersonRunV1 | null, record?: string): DecisionState {
  return { approval_id, seq: mine, loading: true, open: null, command: crypto.randomUUID(), audience: 'only-me', project_ids: [], share: false, owners: [], busy: false,
    run, ...(record === undefined ? {} : { record }) };
}

/** What was proposed, and your choices on it. */
async function readDecision(mine: number, approval_id: string): Promise<void> {
  try {
    const open = await meetingCommand({ operation: 'review_open', approval_id });
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

function editDecision(patch: Partial<DecisionState>): void {
  if (state.decision && decisionShown(state.decision.seq)) set({ decision: { ...state.decision, ...patch } });
}
/** The choices change only while nothing is on its way or may have arrived: a resend must repeat what was sent. */
function editChoices(patch: Partial<DecisionState>): void {
  if (!state.decision?.busy && !state.decision?.unknown) editDecision(patch);
}
export function setDecisionAudience(audience: DecisionState['audience']): void { editChoices({ audience }); }
export function setDecisionShare(share: boolean): void { editChoices({ share }); }
export function setDecisionOwner(signalId: string, owner: string): void {
  const decision = state.decision;
  if (decision) editChoices({ owners: decision.owners.map(item => item.signal_id === signalId ? { ...item, owner } : item) });
}
export function tickDecisionProject(projectId: string): void {
  const decision = state.decision;
  if (!decision) return;
  const ticked = decision.project_ids.includes(projectId);
  if (!ticked && decision.project_ids.length >= MAX_CAPTURE_PROJECTS) return;
  editChoices({ project_ids: ticked ? decision.project_ids.filter(id => id !== projectId) : [...decision.project_ids, projectId].sort() });
}

/** Approve or Reject: one send per opening. Home shows where it went; the check runs by itself. */
export async function decide(action: 'approve' | 'reject'): Promise<void> {
  const decision = state.decision;
  if (!decision?.open || decision.busy || !decisionShown(decision.seq)) return;
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
    const unknown = outcomeUnknown(failureOf(error), decision.unknown === true);
    if (decisionShown(mine)) editDecision({ busy: false, unknown, failure: error instanceof Error ? error.message : 'That was not sent. Try again.' });
  }
}

/** Try again on a failed impact check. */
export async function retryImpact(): Promise<void> {
  const decision = state.decision;
  if (!decision?.run || decision.run.state !== 'failed') return;
  const mine = decision.seq;
  try {
    await runsCommand({ schema_version: 1, operation: 'retry', run_id: decision.run.run_id });
    if (!decisionShown(mine)) return;
    editDecision({ run: { ...decision.run, state: 'pending', error_code: null } });
    const runs = await runsCommand({ schema_version: 1, operation: 'list' });
    void driveRuns(runs.runs);
  } catch { /* the card still offers Try again */ }
}

// ---- a meeting's and a project's follow-ups line ------------------------------------------

/**
 * A meeting's or a project's follow-ups, counted: the line of the meeting the
 * reader shows (by its record) or the decision page shows (by its check, or
 * by its record when opened from its follow-ups), and the line above a
 * project's feed.
 */
export interface ItemsLine {
  scope: 'record' | 'run' | 'project';
  id: string;
  seq: number;
  loading: boolean;
  summary: OpenItemsView['summary'] | null;
  /** The meeting's own check; `mine` when you approved the meeting, so Try again is yours. */
  stage: PersonImpactStageV1 | null;
  busy: boolean;
}

type LineKey = 'impactLine' | 'projectLine';

function setLine(key: LineKey, line: ItemsLine): void {
  set(key === 'impactLine' ? { impactLine: line } : { projectLine: line });
}

/**
 * A scope's counts read for its line: counts and stages only, so no item is
 * opened in its tool (opening the line lists them). The line keeps what it
 * last said of the same scope while it is read again, and when that read
 * fails. A read the person did not ask for fails quietly, unless the account
 * is gone.
 */
async function loadLine(key: LineKey, scope: ItemsLine['scope'], id: string): Promise<void> {
  const account = expect();
  if (!account || state.concealed) return;
  const mine = ++seq;
  const before = state[key];
  const kept = before?.scope === scope && before.id === id ? { summary: before.summary, stage: before.stage } : { summary: null, stage: null };
  setLine(key, { scope, id, seq: mine, loading: true, ...kept, busy: false });
  const result = await rpc('runs', { expect: account, request: { schema_version: 1, operation: 'items', scope, id, summary_only: true } });
  if (state[key]?.seq !== mine) return;
  if (!result.ok) {
    setLine(key, { ...state[key]!, loading: false });
    if (ACCOUNT_GONE.includes(result.failure.code)) accountLost(result.failure);
    return;
  }
  const page = result.value as OpenItemsView;
  const stage = scope === 'project' ? null : page.stages.find(entry => (scope === 'record' ? entry.record_sha256 : entry.run_id) === id) ?? null;
  setLine(key, { ...state[key]!, loading: false, summary: page.summary, stage });
}

/** The meeting a meeting's line counts: the record it names, or the one its check found. */
export function lineRecord(line: ItemsLine): string | null {
  return line.scope === 'record' ? line.id : line.stage?.record_sha256 ?? line.summary?.by_decision[0]?.record_sha256 ?? null;
}

/** Try again, on a meeting's line: its check runs again, from your desktop. */
export async function retryLineCheck(): Promise<void> {
  const line = state.impactLine;
  if (!line?.stage || line.stage.state !== 'failed' || !line.stage.mine || line.busy) return;
  const { scope, id, stage } = line;
  set({ impactLine: { ...line, busy: true } });
  try {
    await runsCommand({ schema_version: 1, operation: 'retry', run_id: stage.run_id });
    await driveRuns((await runsCommand({ schema_version: 1, operation: 'list' })).runs);
  } catch { /* the line offers Try again again */ }
  if (state.impactLine?.seq === line.seq) await loadLine('impactLine', scope, id);
}

// ---- follow-ups: lists and item pages (follow-ups thread v1) ---------------------------------

/** People by name under an owner chip, to give its item to. */
export interface OwnerPicker {
  item_id: string;
  query: string;
  results: readonly Member[];
  loading: boolean;
  failure?: string;
}

/** What the last change did, said in place (F6): "Sent to Mina", "Done · Undo", or why it did not go. */
export interface Said {
  words: string;
  /** Undo opens the item again: after Mark done, or a Dismiss of an open item. */
  undo?: true;
  error?: true;
}

/** A send, kept while its outcome is unknown: sending exactly the same again replays it, so nothing goes twice. */
interface SendCommand { command: string; key: string }

/** What a list, an item page and a decision opened from a list share. Under another view, `stale` once a change was made over it: it is read again when it shows. */
interface FollowUpViewBase {
  seq: number;
  /** A change on its way. */
  busy: boolean;
  said: Said | null;
  picker: OwnerPicker | null;
  stale: boolean;
}

/**
 * A list's reads: its first page (opening it), what it shows read again
 * (`again`), its current work's next page (`more`), and its closed part's
 * next page, or first (`closed`).
 */
export type ListRead = 'first' | 'again' | 'more' | 'closed';

/** One part of a list, paged on its own: where its next page starts, and how many rows it has read. */
export interface ListPart { next: string | null; rows: number }

/** Where a row sits in a list: oldest first, by when it was made, then by its id, as the Authority pages them. */
interface Place { created_at: string; item_id: string }

/**
 * A live read of a list's rows in some states (`LIVE_STATES`), paged on its
 * own from the first: where its next page starts, the last row it reached,
 * whether it reached the end, and whether a page is on its way.
 */
export interface LiveRead { next: string | null; last: Place | null; ended: boolean; reading: boolean }

/**
 * A list's live reads, by the rows each reads: its current work; a meeting's
 * closed rows together; and yours or a project's closed rows a group at a
 * time, once that group is opened.
 */
export type LiveKey = 'active' | 'closed' | 'done' | 'not_relevant';

/**
 * A follow-ups list: a meeting's (by its record), a project's, or yours
 * (everything you sent or own), a page at a time. Current work (Not sent and
 * Open) is read first, so it is never behind More; closed rows (Done and
 * Dismissed) are read after it, each part with its own More. Not sent rows
 * you may send are ticked to Send or Dismiss them.
 */
export interface FollowUpList extends FollowUpViewBase {
  kind: 'list';
  scope: 'mine' | 'record' | 'project';
  /** The meeting's record or the project; yours name none. */
  id?: string;
  /** The meeting's title or the project's name; null for yours. */
  title: string | null;
  loading: boolean;
  /** Why the last read failed, and which read it was: Try again repeats it. */
  failure?: Failure;
  failed?: ListRead;
  /** Every row shown, each once, as last read. */
  items: readonly OpenItemView[];
  /** Current work: Not sent and Open. */
  active: ListPart;
  /** Closed rows: read once current work has no next page; null until then. */
  closed: ListPart | null;
  summary: OpenItemsView['summary'] | null;
  /** A meeting's own check, from its list's reads: `mine` when you approved it, so its decision page is yours to open. */
  stage: PersonImpactStageV1 | null;
  /** Not sent rows ticked. A meeting's list ticks every one on its first read; nothing keeps them past the list. */
  ticks: Readonly<Record<string, boolean>>;
  /** Sends whose outcome is unknown, by check (run). */
  sends: Readonly<Record<string, SendCommand>>;
  /** Check now: its sweep on its way, nothing open to check, or the sweep failed. Any other read of the list clears what it said. */
  check: 'checking' | 'nothing' | 'failed' | null;
  /**
   * Its rows are read rows only, and then live only where they show (`fillLive`): what each read live has reached. Rows read
   * again after a change keep what was read live of them.
   */
  live: Readonly<Partial<Record<LiveKey, LiveRead>>>;
  /** Closed groups that show their rows: a meeting's always; yours and a project's start closed ("Done · 12") until opened. */
  expanded: Readonly<Partial<Record<'done' | 'not_relevant', true>>>;
  /** The row whose page was opened from this list last: coming back, it takes the focus. */
  opened?: string;
}

/** One follow-up's page (F5): from a row with the row's copy, or by its id alone, then read again. */
export interface ItemPage extends FollowUpViewBase {
  kind: 'item';
  item_id: string;
  /** Null until the first read, when opened by its id alone. */
  item: OpenItemView | null;
  loading: boolean;
  failure?: Failure;
  send: SendCommand | null;
  /** A change made here took the item out of what you see (you gave it away): the page says so, and offers Back. */
  gone?: true;
}

/** A meeting's decision page, opened from its follow-ups list ("Approved Oct 6"): its state is the one decision (`decision`). */
export interface DecisionView extends FollowUpViewBase { kind: 'decision' }

export type FollowUpView = FollowUpList | ItemPage | DecisionView;

/**
 * Follow-up lists, item pages and decisions opened from a list, over the page
 * on screen (`route`): the last one shows, and Back goes to the one before.
 * The Follow-ups page (yours) is a page of its own (`follow-ups`), its list the first
 * view.
 */
export interface FollowUpsState {
  /** The page they show over: another page closes them. */
  route: Route;
  /** Oldest first. */
  views: readonly FollowUpView[];
  /** A change was made from them: the page under them is read again once they close. */
  changed: boolean;
}

/** The follow-ups over the page on screen, if any. */
export function followUpsShown(current: State = state): FollowUpsState | null {
  const stack = current.followUps;
  return stack && stack.route === current.route && stack.views.length > 0 ? stack : null;
}

/** The view that shows. */
export function followUpShown(current: State = state): FollowUpView | null {
  return followUpsShown(current)?.views.at(-1) ?? null;
}

function shownView<Kind extends FollowUpView['kind']>(kind: Kind): Extract<FollowUpView, { kind: Kind }> | null {
  const view = followUpShown();
  return view?.kind === kind ? view as Extract<FollowUpView, { kind: Kind }> : null;
}

/** A view still open, shown or under another; a reply for one since closed is dropped. */
function viewOf<Kind extends FollowUpView['kind']>(kind: Kind, mine: number): Extract<FollowUpView, { kind: Kind }> | null {
  const view = followUpsShown()?.views.find(entry => entry.seq === mine);
  return view?.kind === kind ? view as Extract<FollowUpView, { kind: Kind }> : null;
}

function setView(view: FollowUpView): void {
  const stack = followUpsShown();
  if (stack?.views.some(entry => entry.seq === view.seq)) set({ followUps: { ...stack, views: stack.views.map(entry => (entry.seq === view.seq ? view : entry)) } });
}

/** A view opened over what shows: the page, or the view before it. */
function pushView(view: FollowUpView): void {
  const stack = followUpsShown();
  set({ followUps: { route: state.route, views: [...(stack?.views ?? []), view], changed: stack?.changed ?? false }, ask: null, sources: null, toast: null });
}

const UNCHANGED = { busy: false, said: null, picker: null, stale: false } as const;

function newList(scope: FollowUpList['scope'], id: string | undefined, title: string | null): FollowUpList {
  return { kind: 'list', seq: ++seq, scope, ...(id === undefined ? {} : { id }), title, loading: true, items: [], active: { next: null, rows: 0 }, closed: null,
    summary: null, stage: null, ticks: {}, sends: {}, check: null, live: {}, expanded: scope === 'record' ? { done: true, not_relevant: true } : {}, ...UNCHANGED };
}

/**
 * A meeting's follow-ups (by its record) or a project's, over the page on
 * screen: from a Send row, a meeting's or a project's line, an item's
 * meeting, or a decision. When that list is already open under what shows,
 * Back goes to it, as it was, instead of opening it again.
 */
export function openFollowUps(scope: 'record' | 'project', id: string, title: string): Promise<void> {
  if (!expect() || state.concealed) return Promise.resolve();
  const at = followUpsShown()?.views.findIndex(view => view.kind === 'list' && view.scope === scope && view.id === id) ?? -1;
  if (at >= 0) { backTo(at); return Promise.resolve(); }
  const list = newList(scope, id, title);
  pushView(list);
  return readList(list.seq, 'first');
}

/**
 * Follow-ups (yours), from the sidebar or Home's footer: everything you sent or own, as a page of its own. The bar searches all
 * context. A notification's (`fromNotice`) comes while another app may still be in front.
 */
export function openYourFollowUps(fromNotice = false): Promise<void> {
  if (!expect() || (state.concealed && !fromNotice)) return Promise.resolve();
  readSeq += 1;
  const route: Route = { page: 'follow-ups' };
  const list = newList('mine', undefined, null);
  set({ route, followUps: { route, views: [list], changed: false }, list: null, roster: null, reader: null, ask: null, sources: null, toast: null,
    barScope: { kind: 'global' }, organization: null, decision: null });
  syncSearch();
  return readList(list.seq, 'first');
}

/** A Not sent row you may send: before Send only its approver may pick its owner, exactly when they may send it. */
export function sendable(item: OpenItemView): boolean {
  return item.state === 'unsent' && item.can.assign;
}

/** A list's two parts: current work, read first, and closed rows. */
const ACTIVE_STATES: readonly PersonOpenItemStateV1[] = ['unsent', 'open'];
const CLOSED_STATES: readonly PersonOpenItemStateV1[] = ['done', 'not_relevant'];

/** The states each live read of a list reads. */
const LIVE_STATES: Readonly<Record<LiveKey, readonly PersonOpenItemStateV1[]>> = { active: ACTIVE_STATES, closed: CLOSED_STATES, done: ['done'], not_relevant: ['not_relevant'] };

/** A row ECHO reads live in its tool and has not yet: a document's, never a meeting action's (ECHO's own words). */
export function awaitingLive(item: OpenItemView): boolean {
  return item.kind !== 'action' && item.reach === 'not_read';
}

/** `item`, with the live part of `from`: what it says now, and how that read went. Every other field stays `item`'s. */
function liveOf(item: OpenItemView, from: OpenItemView): OpenItemView {
  const { current: _current, ...rest } = item;
  return from.current === undefined ? { ...rest, reach: from.reach } : { ...rest, reach: from.reach, current: from.current };
}

/**
 * Rows read again rows only (`fresh`), laid over the rows that showed: every
 * ECHO field from the fresh read, and each row's live part (what it says now,
 * and how that read went) kept from what showed when the fresh row was not
 * read live, so a change never costs a live read and never loses one.
 */
export function keepLive(shown: readonly OpenItemView[], fresh: readonly OpenItemView[]): OpenItemView[] {
  const before = new Map(shown.map(item => [item.item_id, item]));
  return fresh.map(item => {
    const was = before.get(item.item_id);
    return item.reach === 'not_read' && was !== undefined && was.reach !== 'not_read' ? liveOf(item, was) : item;
  });
}

/**
 * A live read's parts laid over the rows that show: what each says now and
 * how its read went. Its ECHO fields are not taken, since a rows-only read
 * made since (after a change) knows them better; a row it does not hold, or
 * one that does not show, is left as it is.
 */
export function withLive(rows: readonly OpenItemView[], live: readonly OpenItemView[]): OpenItemView[] {
  const read = new Map(live.map(item => [item.item_id, item]));
  return rows.map(item => {
    const fresh = read.get(item.item_id);
    return fresh === undefined ? item : liveOf(item, fresh);
  });
}

/** A live read that failed: the rows it was to read say ECHO couldn't read them just now (an outage, never lost access). */
function unreadNow(rows: readonly OpenItemView[], covers: (item: OpenItemView) => boolean = () => true): OpenItemView[] {
  return rows.map(item => (awaitingLive(item) && covers(item) ? { ...item, reach: 'unavailable' as const } : item));
}

/** Rows read, laid over what shows: a row read again replaces itself in place, keeping what was read live of it; a new one comes last. */
function mergeRows(shown: readonly OpenItemView[], read: readonly OpenItemView[], before: readonly OpenItemView[] = shown): OpenItemView[] {
  const fresh = new Map(keepLive(before, read).map(item => [item.item_id, item]));
  const kept = shown.map(item => fresh.get(item.item_id) ?? item);
  const known = new Set(shown.map(item => item.item_id));
  return [...kept, ...[...fresh.values()].filter(item => !known.has(item.item_id))];
}

/** The pages of one part a read needs, rows only: from `cursor`, until it has `atLeast` rows or no next page. */
async function readPart(account: Expect, list: FollowUpList, states: readonly PersonOpenItemStateV1[], cursor: string | null, atLeast: number)
  : Promise<{ ok: true; items: OpenItemView[]; next: string | null; page: OpenItemsView } | { ok: false; failure: Failure }> {
  const items: OpenItemView[] = [];
  let next = cursor;
  for (;;) {
    const result = await rpc('runs', { expect: account, request: { schema_version: 1, operation: 'items', scope: list.scope, ...(list.id === undefined ? {} : { id: list.id }),
      states, ...(next === null ? {} : { cursor: next }), rows_only: true } });
    if (!result.ok) return { ok: false, failure: result.failure };
    const page = result.value as OpenItemsView;
    items.push(...page.items);
    next = page.next_cursor;
    if (next === null || items.length >= atLeast) return { ok: true, items, next, page };
  }
}

/**
 * One of a list's reads, rows only, so its rows show at once from ECHO's own
 * fields. Current work first: its first page when the list opens, its next
 * page on More, or as many pages as it shows again (`again`: after a change,
 * or Back to it, so rows move between groups in place). Once current work has
 * no next page, the closed part: its first page, its next on its own More, or
 * again as many as it shows. Each row read again keeps what was read live of
 * it. A meeting's first read ticks every Not sent row you may send; any other
 * keeps the ticks of rows still not sent. A read that fails keeps what shows,
 * and Try again repeats it. Then, except after a change (`again`), the rows
 * that show and were never read live are read live (`fillLive`).
 */
async function readList(mine: number, how: ListRead): Promise<void> {
  const account = expect();
  const list = viewOf('list', mine);
  if (!account || !list) return;
  if ((how === 'more' && (list.active.next === null || list.loading)) || (how === 'closed' && (list.closed?.next === null || list.loading))) return;
  // Check now's word of its last sweep holds until the list is read again; a sweep on its way stays.
  setView({ ...list, loading: true, failure: undefined, failed: undefined, check: list.check === 'checking' ? 'checking' : null });
  const fresh = how === 'first' || how === 'again';
  let items: readonly OpenItemView[] = fresh ? [] : list.items;
  let active = list.active;
  let closed = fresh ? null : list.closed;
  let last: OpenItemsView | undefined;
  let failure: { failure: Failure; read: ListRead } | undefined;
  if (how !== 'closed') {
    const read = await readPart(account, list, ACTIVE_STATES, how === 'more' ? list.active.next : null, how === 'again' ? Math.max(list.active.rows, 1) : 1);
    if (!read.ok) failure = { failure: read.failure, read: how };
    else {
      items = mergeRows(items, read.items, list.items);
      active = { next: read.next, rows: (how === 'more' ? list.active.rows : 0) + read.items.length };
      last = read.page;
    }
  }
  // The closed part, once current work has no next page: read again as far as it showed, or its first or next page.
  if (!failure && active.next === null && (how === 'closed' || closed === null)) {
    const shown = how === 'again' ? list.closed?.rows ?? 0 : 0;
    const read = await readPart(account, list, CLOSED_STATES, how === 'closed' ? closed?.next ?? null : null, Math.max(shown, 1));
    if (!read.ok) failure = { failure: read.failure, read: how === 'again' ? 'again' : 'closed' };
    else {
      items = mergeRows(items, read.items, list.items);
      closed = { next: read.next, rows: (how === 'closed' ? closed?.rows ?? 0 : 0) + read.items.length };
      last = read.page;
    }
  }
  const current = viewOf('list', mine);
  if (!current) return;
  // A read again that failed part way shows what it showed before.
  if (failure && how === 'again') {
    setView({ ...current, loading: false, failure: failure.failure, failed: 'again' });
    accountLost(failure.failure);
    return;
  }
  // What a live read brought while this one was on its way stays.
  items = keepLive(current.items, items);
  const ticked = how === 'first' && current.scope === 'record' ? items.filter(sendable) : items.filter(item => sendable(item) && current.ticks[item.item_id]);
  setView({
    ...current, loading: false, items, active, closed, ...(last ? { summary: last.summary, stage: stageOf(current, last) } : {}),
    ticks: Object.fromEntries(ticked.map(item => [item.item_id, true])), ...(fresh && !failure ? { stale: false } : {}),
    ...(failure ? { failure: failure.failure, failed: failure.read } : {}),
  });
  if (failure) accountLost(failure.failure);
  // The rows that show, read live; one whose part failed to read shows nothing new to read.
  if (how !== 'again') await fillLive(mine);
}

/** The live read that reads rows of this status: current work's; a meeting's closed rows together; yours or a project's by group. */
function liveKeyOf(list: Pick<FollowUpList, 'scope'>, state: PersonOpenItemStateV1): LiveKey {
  if (ACTIVE_STATES.includes(state)) return 'active';
  return list.scope === 'record' ? 'closed' : state === 'done' ? 'done' : 'not_relevant';
}

/** A row whose live read is on its way: its title says what it is and its meeting, faintly, until the read fills it. */
export function rowReading(list: FollowUpList, item: OpenItemView): boolean {
  return awaitingLive(item) && list.live[liveKeyOf(list, item.state)]?.reading === true;
}

/** Whether a row comes before a place in a list's order. */
function before(item: Place, place: Place): boolean {
  return item.created_at < place.created_at || (item.created_at === place.created_at && item.item_id < place.item_id);
}

/** Each list's live reads on their way, by its seq: asked for again meanwhile, they go once more. */
const filling = new Map<number, { again: boolean }>();

/**
 * The rows a list shows, read live (what each says now), and only those:
 * its current work; a meeting's closed rows; yours or a project's closed
 * rows of a group once it is opened. Each live read pages from the first on
 * its own, one page at a time, only as far as the last row that shows and
 * was never read live; one at a time per list. A read that fails leaves
 * those rows saying ECHO couldn't read them just now, and the list says
 * nothing else of it: its rows were read.
 */
async function fillLive(mine: number): Promise<void> {
  const running = filling.get(mine);
  if (running) { running.again = true; return; }
  const turn = { again: true };
  filling.set(mine, turn);
  try {
    while (turn.again) {
      turn.again = false;
      const list = viewOf('list', mine);
      if (!list) return;
      const keys: LiveKey[] = ['active', ...(list.scope === 'record' ? ['closed' as const] : (['done', 'not_relevant'] as const).filter(group => list.expanded[group]))];
      for (const key of keys) await readLive(mine, key);
    }
  } finally {
    filling.delete(mine);
  }
}

/** One live read of a list (`fillLive`), page by page, until it has reached every row of its states that shows and was never read live. */
async function readLive(mine: number, key: LiveKey): Promise<void> {
  const account = expect();
  const states = LIVE_STATES[key];
  for (;;) {
    const list = viewOf('list', mine);
    if (!account || !list || !sameAccount(account)) return;
    const live = list.live[key] ?? { next: null, last: null, ended: false, reading: false };
    // Rows it already passed and did not bring changed meanwhile: they wait for the list's next read.
    const unread = list.items.filter(item => states.includes(item.state) && awaitingLive(item) && (live.last === null || before(live.last, item)));
    if (unread.length === 0 || live.ended) return;
    setView({ ...list, live: { ...list.live, [key]: { ...live, reading: true } } });
    const result = await rpc('runs', { expect: account, request: { schema_version: 1, operation: 'items', scope: list.scope, ...(list.id === undefined ? {} : { id: list.id }),
      states, ...(live.next === null ? {} : { cursor: live.next }) } });
    const current = viewOf('list', mine);
    if (!current || !sameAccount(account)) return;
    if (!result.ok) {
      setView({ ...current, items: unreadNow(current.items, item => states.includes(item.state)), live: { ...current.live, [key]: { ...live, reading: false } } });
      if (ACCOUNT_GONE.includes(result.failure.code)) accountLost(result.failure);
      return;
    }
    const page = result.value as OpenItemsView;
    const reached = page.items.at(-1);
    setView({
      ...current, items: withLive(current.items, page.items),
      live: { ...current.live, [key]: { next: page.next_cursor, last: reached ? { created_at: reached.created_at, item_id: reached.item_id } : live.last, ended: page.next_cursor === null, reading: false } },
    });
  }
}

/**
 * A closed group of yours or a project's list ("Done · 12"), opened or
 * closed. Opened, its rows show and are read live; one whose rows the closed
 * part's pages read so far hold none of reads its next page first.
 */
export function toggleClosedGroup(group: 'done' | 'not_relevant'): void {
  const list = shownView('list');
  if (!list || list.scope === 'record') return;
  const { [group]: open, ...others } = list.expanded;
  setView({ ...list, expanded: open ? others : { ...others, [group]: true } });
  if (open) return;
  if (!list.items.some(item => item.state === group) && list.closed?.next) void readList(list.seq, 'closed');
  else void fillLive(list.seq);
}

/** A meeting's own check, from a read of its list: the list's own word for a project or yours. */
function stageOf(list: FollowUpList, read: Pick<OpenItemsView, 'stages'>): PersonImpactStageV1 | null {
  return list.scope === 'record' ? read.stages.find(stage => stage.record_sha256 === list.id) ?? null : null;
}

/** More: the next page of the list's current work, or of its closed part. */
export function moreFollowUps(part: 'active' | 'closed' = 'active'): Promise<void> {
  const list = shownView('list');
  return list ? readList(list.seq, part === 'active' ? 'more' : 'closed') : Promise.resolve();
}

/** Try again: the read that failed. */
export function retryFollowUps(): Promise<void> {
  const list = shownView('list');
  return list?.failed ? readList(list.seq, list.failed) : Promise.resolve();
}

/** A Not sent row's tick. */
export function tickFollowUp(item_id: string): void {
  const list = shownView('list');
  if (list && !list.busy) setView({ ...list, ticks: { ...list.ticks, [item_id]: !list.ticks[item_id] }, said: null });
}

/**
 * The rows of one check (run), rows only: every row of it you see, as each
 * check holds at most a page of them. Answers null when it could not be read.
 */
async function runRows(account: Expect, run_id: string): Promise<OpenItemView[] | null> {
  const rows: OpenItemView[] = [];
  let cursor: string | null = null;
  do {
    const result = await rpc('runs', { expect: account, request: { schema_version: 1, operation: 'items', scope: 'run', id: run_id, ...(cursor === null ? {} : { cursor }), rows_only: true } });
    if (!result.ok) {
      if (ACCOUNT_GONE.includes(result.failure.code)) accountLost(result.failure);
      return null;
    }
    const page = result.value as OpenItemsView;
    rows.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return rows;
}

/**
 * After a change on a list, its rows read again rows only, as far as each
 * part showed, with its counts (`readList` again): rows move between groups
 * in place, and each keeps what was read live of it, so a change opens
 * nothing in its tool. A changed row the list no longer holds is looked up
 * among its check's rows: there, it moved past what the list shows; not
 * there, you no longer see it. Answers the changed rows as read now, and
 * those you no longer see; nothing of a row that could not be read now.
 */
async function settleRows(mine: number, ids: readonly string[]): Promise<{ fresh: ReadonlyMap<string, OpenItemView>; gone: ReadonlySet<string> }> {
  const fresh = new Map<string, OpenItemView>();
  const gone = new Set<string>();
  const account = expect();
  const list = viewOf('list', mine);
  if (!account || !list) return { fresh, gone };
  const runOf = new Map(list.items.filter(item => ids.includes(item.item_id)).map(item => [item.item_id, item.run_id]));
  await readList(mine, 'again');
  const current = viewOf('list', mine);
  if (!current || !sameAccount(account) || current.failed === 'again') return { fresh, gone };
  for (const item of current.items) if (ids.includes(item.item_id)) fresh.set(item.item_id, item);
  const missing = ids.filter(id => !fresh.has(id));
  for (const run_id of new Set(missing.flatMap(id => runOf.get(id) ?? []))) {
    const rows = await runRows(account, run_id);
    if (rows === null || !sameAccount(account)) continue;
    for (const id of missing.filter(entry => runOf.get(entry) === run_id)) {
      const row = rows.find(item => item.item_id === id);
      if (row) fresh.set(id, row); else gone.add(id);
    }
  }
  return { fresh, gone };
}

/** What a change that did not go says. A conflict shows what changed at once, as the view is read again, so it asks for no Refresh. */
function changeFailed(failure: Failure): Said {
  return { words: failure.code === 'conflict' ? 'That changed meanwhile.' : message(failure), error: true };
}

/** A change made from a view (sent, or maybe sent): every view under it, and the page under them all, are read again when they show. */
function changedFrom(mine: number): void {
  const stack = followUpsShown();
  const at = stack?.views.findIndex(view => view.seq === mine) ?? -1;
  if (!stack || at < 0) return;
  set({ followUps: { ...stack, changed: true, views: stack.views.map((view, index) => (index < at ? { ...view, stale: true } : view)) } });
}

/**
 * One send of a run's items. A send whose outcome was unknown is kept as its
 * command (`kept`): sending exactly the same choices again replays it, so
 * nothing goes twice; any other choice is a new command. Answers why it did
 * not go, and the command to keep while its outcome is unknown.
 */
async function sendRun(run_id: string, items: readonly { item_id: string; include: boolean }[], kept: SendCommand | null | undefined)
  : Promise<{ failure?: Failure; unknown: SendCommand | null }> {
  const key = JSON.stringify(items);
  const command = kept?.key === key ? kept.command : crypto.randomUUID();
  try {
    await runsCommand({ schema_version: 1, operation: 'send', run_id, command_id: command, items });
    return { unknown: null };
  } catch (error) {
    const failure = failureOf(error);
    return { failure, unknown: outcomeUnknown(failure, false) ? { command, key } : null };
  }
}

/**
 * Send N or Dismiss N: the ticked Not sent rows, one send per check (run)
 * listing only those items, to their owners (`include`) or dismissed (F1),
 * for the account shown when it was clicked; it stops once the list closes or
 * the account changes. The list stays: the rows sent are read again in place
 * with its counts, which settles a send whose outcome was unknown (one that
 * went is said as sent and replays no more; one that did not keeps its
 * command for Send again). One line in the list's foot says what happened:
 * "Sent 2 · 1 not sent, try again" when only some went.
 */
export async function sendTicked(include: boolean): Promise<void> {
  const list = shownView('list');
  const account = expect();
  if (!list || !account || list.busy || list.loading || state.concealed) return;
  const ticked = list.items.filter(item => list.ticks[item.item_id] && sendable(item));
  if (ticked.length === 0) return;
  setView({ ...list, busy: true, said: null, picker: null });
  const sends: Record<string, SendCommand> = { ...list.sends };
  const tried: { run_id: string; failure?: Failure }[] = [];
  for (const run_id of [...new Set(ticked.map(item => item.run_id))]) {
    if (!viewOf('list', list.seq) || !sameAccount(account)) break;
    const sent = await sendRun(run_id, ticked.filter(item => item.run_id === run_id).map(item => ({ item_id: item.item_id, include })), sends[run_id]);
    if (sent.unknown) sends[run_id] = sent.unknown; else delete sends[run_id];
    tried.push({ run_id, ...(sent.failure ? { failure: sent.failure } : {}) });
    if (sent.failure) break;
  }
  if (!viewOf('list', list.seq) || !sameAccount(account)) return;
  const triedRows = ticked.filter(item => tried.some(entry => entry.run_id === item.run_id));
  const { fresh } = await settleRows(list.seq, triedRows.map(item => item.item_id));
  const current = viewOf('list', list.seq);
  if (!current || !sameAccount(account)) return;
  // What went: every row of a send that was answered, and of one whose outcome was unknown, each row read again as no longer Not sent.
  const went = triedRows.filter(item => {
    const failed = tried.find(entry => entry.run_id === item.run_id)?.failure;
    return failed === undefined || (outcomeUnknown(failed, false) && fresh.has(item.item_id) && fresh.get(item.item_id)!.state !== 'unsent');
  });
  for (const run_id of Object.keys(sends)) if (went.some(item => item.run_id === run_id)) delete sends[run_id];
  if (went.length > 0 || Object.keys(sends).some(run_id => tried.some(entry => entry.run_id === run_id))) changedFrom(list.seq);
  const failure = tried.find(entry => entry.failure)?.failure;
  const done = went.length === 0 ? null : include ? sentWords(went.map(item => (fresh.get(item.item_id) ?? item).owner), account.membership_id) : `Dismissed ${went.length}`;
  const left = ticked.length - went.length;
  // A send whose outcome was unknown, its rows read again still Not sent, did not go.
  const missed = failure !== undefined && outcomeUnknown(failure, false) && triedRows.every(item => went.includes(item) || fresh.get(item.item_id)?.state === 'unsent');
  const verb = include ? 'sent' : 'dismissed';
  const said: Said = left === 0 ? { words: done! } : done !== null ? { words: `${done} · ${left} not ${verb}, try again`, error: true }
    : missed ? { words: `Not ${verb}. Try again.`, error: true } : changeFailed(failure ?? { code: 'failed', retryable: true });
  setView({ ...viewOf('list', list.seq)!, busy: false, sends, said });
}

/**
 * A follow-up's page (F5), over the page on screen: from any row, with the
 * row's copy at once, then read again live; or from a notification
 * (`fromNotice`, while another app may still be in front), with the row its
 * check read when it has it, else by its id alone. Back returns to where it
 * was opened, and to the row it was opened from.
 */
export function openFollowUp(item_id: string, shown: OpenItemView | null = null, fromNotice = false): Promise<void> {
  if (!expect() || (state.concealed && !fromNotice)) return Promise.resolve();
  const under = followUpShown();
  if (under?.kind === 'list') setView({ ...under, opened: item_id });
  const page: ItemPage = { kind: 'item', seq: ++seq, item_id, item: shown, loading: true, send: null, ...UNCHANGED };
  pushView(page);
  return readItem(page.seq).then(() => undefined);
}

/**
 * The item as it is now, read live: what it says now in its tool, opened
 * for you. The row's copy shows meanwhile (`loading`). A read that fails
 * keeps what shows: with a copy and for a reason that says nothing about the
 * item (an outage, a timeout), it says only that ECHO couldn't read it just
 * now; otherwise it says why (Try again reads it again). Only a lost account
 * reads the account again.
 */
async function readItem(mine: number): Promise<{ item: OpenItemView } | { failure: Failure } | null> {
  const page = viewOf('item', mine);
  const account = expect();
  if (!page || !account) return null;
  setView({ ...page, loading: true, failure: undefined });
  const result = await rpc('runs', { expect: account, request: { schema_version: 1, operation: 'item', item_id: page.item_id } });
  const current = viewOf('item', mine);
  if (!current || !sameAccount(account)) return null;
  if (!result.ok) {
    if (ACCOUNT_GONE.includes(result.failure.code)) accountLost(result.failure);
    const outage = current.item !== null && !ACCESS_LOST.includes(result.failure.code) && !ACCOUNT_GONE.includes(result.failure.code);
    setView(outage ? { ...current, loading: false, item: unreadNow([current.item!])[0]! } : { ...current, loading: false, failure: result.failure });
    return { failure: result.failure };
  }
  const item = result.value as OpenItemView;
  setView({ ...current, loading: false, stale: false, failure: undefined, item });
  return { item };
}

/**
 * The item read again after a change, rows only: its check's rows, so
 * nothing is opened in its tool, and what the page last read live of it
 * stays. Answers the item, or why it could not be read (not_found once you
 * no longer see it), and shows it.
 */
async function rereadItem(mine: number): Promise<{ item: OpenItemView } | { failure: Failure } | null> {
  const page = viewOf('item', mine);
  const account = expect();
  if (!page || !account) return null;
  if (page.item === null) return readItem(mine);
  const rows = await runRows(account, page.item.run_id);
  const current = viewOf('item', mine);
  if (!current || !sameAccount(account)) return null;
  const row = rows?.find(entry => entry.item_id === current.item_id);
  if (!row) {
    const failure: Failure = rows === null ? { code: 'unavailable', retryable: true } : { code: 'not_found', retryable: false };
    setView({ ...current, failure });
    return { failure };
  }
  const item = keepLive(current.item ? [current.item] : [], [row])[0]!;
  setView({ ...current, stale: false, failure: undefined, item });
  return { item };
}

/** Try again, on an item page whose read failed. */
export function retryFollowUp(): void {
  const page = shownView('item');
  if (page && !page.busy && !page.loading) void readItem(page.seq);
}

/**
 * A change to the item on its page: sent, what the Authority answered shown
 * at once (`patch`), then the item read again rows only (`rereadItem`), so a
 * change opens nothing in its tool. The page stays and says what happened
 * (F6). A change whose outcome is unknown is settled by that read
 * (`landed`): one that went is said as done; one that did not says so
 * (`missed`), and `retry` keeps what Send needs to replay it; one the read
 * cannot settle still may have gone. A change that took the item out of what
 * you see leaves the page saying so.
 */
async function changeItem(page: ItemPage, write: () => Promise<{ failure?: Failure; unknown: boolean }>, done: Said,
  landed: (item: OpenItemView) => boolean, patch: (item: OpenItemView) => OpenItemView,
  missed: Said = { words: message({ code: 'not_saved', retryable: true }), error: true }, retry: (kept: boolean) => Partial<ItemPage> = () => ({})): Promise<void> {
  setView({ ...page, busy: true, said: null, picker: null });
  const { failure, unknown } = await write();
  if (!viewOf('item', page.seq)) return;
  if (!failure || unknown) changedFrom(page.seq);
  const answered = viewOf('item', page.seq);
  if (!failure && answered?.item) setView({ ...answered, item: patch(answered.item) });
  const read = failure && !unknown ? null : await rereadItem(page.seq);
  const current = viewOf('item', page.seq);
  if (!current) return;
  const went = !failure || (read !== null && 'item' in read && landed(read.item));
  const said: Said = went ? done : !unknown ? changeFailed(failure!) : read && 'item' in read ? missed : { words: message(failure!), error: true };
  const gone = !failure && read !== null && 'failure' in read && read.failure.code === 'not_found';
  // What went shows as the Authority answered it, even when the read after it failed.
  setView({ ...current, busy: false, said, ...(went && read !== null && 'failure' in read && !gone ? { failure: undefined } : {}), ...retry(unknown && !went),
    ...(gone ? { gone: true as const } : {}) });
  if (failure && !unknown) await rereadItem(page.seq);
}

/**
 * Send to <owner> (Keep it myself) or Dismiss, on a follow-up not sent yet:
 * one send of this item alone, which replays while its outcome is unknown.
 */
export async function sendFollowUp(include: boolean): Promise<void> {
  const page = shownView('item');
  const item = page?.item;
  if (!page || !item || page.busy || !sendable(item) || state.concealed) return;
  const items = [{ item_id: item.item_id, include }];
  let kept: SendCommand | null = null;
  const mine = item.owner.membership_id === expect()?.membership_id;
  await changeItem(page, async () => {
    const sent = await sendRun(item.run_id, items, page.send);
    kept = sent.unknown;
    return { ...(sent.failure ? { failure: sent.failure } : {}), unknown: sent.unknown !== null };
  }, { words: !include ? 'Dismissed' : mine ? 'Kept for you' : `Sent to ${firstName(item.owner.name)}` }, fresh => fresh.state !== 'unsent',
  shown => ({ ...shown, state: include ? 'open' : 'not_relevant', send_included: include }),
  { words: include ? 'Not sent. Try again.' : 'Not dismissed. Try again.', error: true }, keep => ({ send: keep ? kept : null }));
}

/** The one change of state a write makes, and whether its outcome is unknown. */
async function stateWrite(item_id: string, to: 'open' | 'done' | 'not_relevant'): Promise<{ failure?: Failure; unknown: boolean }> {
  try {
    await runsCommand({ schema_version: 1, operation: 'set_state', item_id, state: to });
    return { unknown: false };
  } catch (error) {
    const failure = failureOf(error);
    return { failure, unknown: outcomeUnknown(failure, false) };
  }
}

/**
 * Mark done or Dismiss, on an open follow-up; Reopen on a closed one, which
 * reads "Send to <owner>" on one Send dismissed and nothing reopened since:
 * reopening it reaches its owner. Mark done and that Dismiss offer Undo.
 */
export async function setFollowUpState(to: 'open' | 'done' | 'not_relevant'): Promise<void> {
  const page = shownView('item');
  const item = page?.item;
  if (!page || !item || page.busy || !item.can.set_state || item.state === 'unsent' || state.concealed) return;
  const reaches = to === 'open' && reopenSends(item, expect()?.membership_id ?? null);
  const said: Said = to === 'done' ? { words: 'Done', undo: true } : to === 'not_relevant' ? { words: 'Dismissed', undo: true }
    : { words: reaches ? `Sent to ${firstName(item.owner.name)}` : 'Reopened' };
  await changeItem(page, () => stateWrite(item.item_id, to), said, fresh => fresh.state === to, shown => ({ ...shown, state: to }));
}

/** Undo, after Mark done or a Dismiss of an open item: it is open again. */
export function undoFollowUp(): Promise<void> {
  return shownView('item')?.said?.undo ? setFollowUpState('open') : Promise.resolve();
}

/** Typing in an owner picker, counted: a read for an older name is dropped. */
let pickerSeq = 0;

/** An owner chip: its people picker opens with you first, then the organization's first people; or closes. */
export function toggleOwnerPicker(item_id: string): void {
  const view = followUpShown();
  if (!view || view.kind === 'decision' || view.busy) return;
  pickerSeq += 1;
  if (view.picker?.item_id === item_id) { setView({ ...view, picker: null }); return; }
  setView({ ...view, picker: { item_id, query: '', results: [], loading: true }, said: null });
  void findOwner('');
}

/** Escape or Cancel: the picker closes. */
export function closeOwnerPicker(): void {
  const view = followUpShown();
  if (!view?.picker) return;
  pickerSeq += 1;
  setView({ ...view, picker: null });
}

/** The organization's people by name, from the people directory. Typing reads once it pauses. */
export async function findOwner(query: string): Promise<void> {
  const view = followUpShown();
  const account = expect();
  if (!view?.picker || !account) return;
  const { item_id } = view.picker;
  const mine = ++pickerSeq;
  const typing = query !== view.picker.query;
  setView({ ...view, picker: { ...view.picker, query, loading: true, failure: undefined } });
  if (typing) await new Promise(resolve => setTimeout(resolve, SEARCH_PAUSE_MS));
  if (mine !== pickerSeq) return;
  const name = query.trim();
  const result = await rpc('people.directory', { expect: account, ...(name === '' ? {} : { query: name }) });
  const current = viewOf(view.kind, view.seq);
  if (mine !== pickerSeq || current?.picker?.item_id !== item_id) return;
  if (!result.ok) {
    setView({ ...current, picker: { ...current.picker, loading: false, results: [], failure: message(result.failure) } });
    accountLost(result.failure);
    return;
  }
  setView({ ...current, picker: { ...current.picker, loading: false, results: result.value.items } });
}

/**
 * Who an owner picker offers: you first ("You") while no name is typed, then
 * the people found, never the owner now, unless the item only fell back to
 * its approver (Pick owner): picking them claims it.
 */
export function ownerChoices(picker: OwnerPicker, item: OpenItemView, me: Member | null): { person: Member; me: boolean }[] {
  const offered = (person: Member) => person.membership_id !== item.owner.membership_id || item.owner.match === 'approver';
  const found = picker.results.filter(person => person.membership_id !== me?.membership_id && offered(person));
  return [...(me && picker.query.trim() === '' && offered(me) ? [{ person: me, me: true }] : []), ...found.map(person => ({ person, me: false }))];
}

/** The item a view shows with this id: its page's, or one of its list's rows. */
function itemIn(view: FollowUpView, item_id: string): OpenItemView | undefined {
  return view.kind === 'item' ? (view.item?.item_id === item_id ? view.item : undefined) : view.kind === 'list' ? view.items.find(item => item.item_id === item_id) : undefined;
}

/**
 * A person picked under an owner chip: the item is theirs at once (F2),
 * before Send or after; the view stays and says so ("Owner changed to
 * Mina"), with the item read again (a list's row in place, with its counts).
 * An assign whose outcome is unknown is settled by that read. One you gave
 * away and no longer see says so: the page offers Back, the list's row goes.
 */
export async function pickFollowUpOwner(person: Member): Promise<void> {
  const view = followUpShown();
  const item = view?.picker ? itemIn(view, view.picker.item_id) : undefined;
  if (!view || view.kind === 'decision' || !item || view.busy || !item.can.assign || state.concealed) return;
  pickerSeq += 1;
  const changed: Said = { words: `Owner changed to ${person.membership_id === expect()?.membership_id ? 'you' : firstName(person.display_name)}` };
  const write = async (): Promise<{ failure?: Failure; unknown: boolean }> => {
    try {
      await runsCommand({ schema_version: 1, operation: 'assign', item_id: item.item_id, owner_membership_id: person.membership_id });
      return { unknown: false };
    } catch (error) {
      const failure = failureOf(error);
      return { failure, unknown: outcomeUnknown(failure, false) };
    }
  };
  if (view.kind === 'item') {
    await changeItem(view, write, changed, fresh => fresh.owner.membership_id === person.membership_id, shown => ({
      ...shown, owner: { membership_id: person.membership_id, name: person.display_name, active: true, match: shown.state === 'unsent' ? 'picked' : 'reassigned' },
    }));
    return;
  }
  setView({ ...view, picker: null, busy: true, said: null });
  const { failure, unknown } = await write();
  if (!viewOf('list', view.seq)) return;
  if (failure && !unknown) { setView({ ...viewOf('list', view.seq)!, busy: false, said: changeFailed(failure) }); return; }
  changedFrom(view.seq);
  const { fresh, gone } = await settleRows(view.seq, [item.item_id]);
  const current = viewOf('list', view.seq);
  if (!current) return;
  const went = !unknown || fresh.get(item.item_id)?.owner.membership_id === person.membership_id;
  const said: Said = !went ? { words: message(fresh.has(item.item_id) ? { code: 'not_saved', retryable: true } : failure!), error: true }
    : gone.has(item.item_id) ? { words: `${changed.words} · You no longer see it` } : changed;
  setView({ ...current, busy: false, said });
}

/**
 * Back from a list, an item page or a decision opened from a list: the view
 * before it shows again, read again when a change was made over it; from the
 * first, the page they were opened over, read again when anything changed
 * (the Follow-ups page goes Home). Not while a change is on its way.
 */
export function closeFollowUp(): void {
  const stack = followUpsShown();
  if (stack) backTo(stack.views.length - 2);
}

/**
 * Back to the view at `at` (or, at -1, the page under them all), closing
 * every view over it, unless a change is on its way in one. What changed
 * over it is read again, and what it said last no longer holds.
 */
function backTo(at: number): void {
  const stack = followUpsShown();
  if (!stack || at >= stack.views.length - 1 || stack.views.slice(at + 1).some(view => view.busy)) return;
  pickerSeq += 1;
  if (stack.views.slice(at + 1).some(view => view.kind === 'decision') && state.decision?.record !== undefined) set({ decision: null });
  if (at < 0) {
    set({ followUps: null });
    if (state.route.page === 'follow-ups') goHome();
    else if (stack.changed) refreshUnder();
    return;
  }
  const views = stack.views.slice(0, at + 1);
  const under = views[at]!;
  set({ followUps: { ...stack, views: under.stale ? [...views.slice(0, -1), { ...under, said: null }] : views } });
  if (!under.stale) return;
  // A change was made over it: read again rows only, keeping what was read live.
  if (under.kind === 'list') void readList(under.seq, 'again');
  else if (under.kind === 'item') void rereadItem(under.seq);
  else {
    setView({ ...under, stale: false });
    if (state.decision?.record !== undefined) void loadLine('impactLine', 'record', state.decision.record);
  }
}

/** After follow-ups changed, what they were over is read again: Home, a meeting's line (in the reader or on its decision), a project's line. */
function refreshUnder(): void {
  const route = state.route;
  if (route.page === 'home') void loadHome();
  if (route.page === 'project' && state.projectLine?.id === route.project.project_id) void loadLine('projectLine', 'project', route.project.project_id);
  const line = state.impactLine;
  if (line && (route.page === 'decision' || (state.reader?.ref.kind === 'meeting' && state.reader.ref.id === line.id))) void loadLine('impactLine', line.scope, line.id);
}

/**
 * A meeting's decision page, from its list's "Approved Oct 6": over the list,
 * so Back returns to it. Opened from that decision's own page, or already
 * open under the list, Back goes to it instead. Its check finished (it found
 * the list's follow-ups); its follow-ups line counts them by the record.
 */
export async function openListDecision(): Promise<void> {
  const list = shownView('list');
  const decided = list?.items.find(item => item.decision)?.decision;
  if (!list || list.scope !== 'record' || !decided || !list.stage?.mine || state.concealed || !expect()) return;
  const { approval_id } = decided;
  if (state.route.page === 'decision' && state.decision?.approval_id === approval_id && state.decision.record === undefined) { backTo(-1); return; }
  const stack = followUpsShown()!;
  const at = stack.views.findIndex(view => view.kind === 'decision' && state.decision?.seq === view.seq && state.decision.approval_id === approval_id);
  if (at >= 0) { backTo(at); return; }
  const stage = list.stage;
  const mine = ++seq;
  const run: PersonRunV1 = { run_id: stage.run_id, trigger: 'approved_record', event_ref: approval_id, state: stage.state, error_code: stage.error_code,
    created_at: decided.approved_at, updated_at: decided.approved_at };
  pushView({ kind: 'decision', seq: mine, ...UNCHANGED });
  set({ decision: newDecision(approval_id, mine, run, decided.record_sha256) });
  void loadLine('impactLine', 'record', decided.record_sha256);
  await readDecision(mine, approval_id);
}

/**
 * Check now, faint on a meeting's or a project's list (canvas 9.6, 9.7): a
 * sweep of that scope. With nothing open the list says so; otherwise
 * "Checking…" until the sweep ends, then the list is read again. A sweep that
 * fails says so, and Try again asks for another.
 */
export async function checkNow(): Promise<void> {
  const list = shownView('list');
  if (!list || list.scope === 'mine' || list.id === undefined || list.check === 'checking' || !expect() || state.concealed) return;
  const request = { schema_version: 1 as const, operation: 'sweep' as const, scope: list.scope, id: list.id };
  setView({ ...list, check: 'checking' });
  // Still this list's check, while the list is open.
  const ours = (): FollowUpList | null => {
    const now = viewOf('list', list.seq);
    return now?.check === 'checking' ? now : null;
  };
  let runId: string;
  try {
    const asked = await runsCommand(request);
    const now = ours();
    if (!now) return;
    if (!('run_id' in asked)) { setView({ ...now, check: 'nothing' }); return; }
    runId = asked.run_id;
  } catch {
    const now = ours();
    if (now) setView({ ...now, check: 'failed' });
    return;
  }
  const ended = await followSweep(runId, () => ours() !== null);
  const now = ours();
  if (!now || ended === null) return;
  setView({ ...now, check: ended === 'done' ? null : 'failed' });
  if (ended === 'done') await readList(now.seq, 'again');
}

/**
 * Check now's sweep, followed until it ends (`done` or `failed`; null once
 * nothing waits on it, `ours`). It is started at once; if another run goes
 * first (`busy`), each runs list says what starts next, impact checks before
 * sweeps. The list is read at Home's pace (`runPollDelay`): longer after a
 * failed read or a start that started nothing, and not while ECHO is behind
 * another app.
 */
async function followSweep(runId: string, ours: () => boolean): Promise<'done' | 'failed' | null> {
  let next: string | undefined = runId;
  let failures = 0;
  let lastFailure: Failure | undefined;
  for (;;) {
    if (next !== undefined) {
      const refused = await startRun(next);
      if (!ours()) return null;
      failures = refused ? failures + 1 : 0;
      lastFailure = refused;
    }
    // The list waits on its sweep: it is in flight until a runs list shows it ended.
    await new Promise(resolve => setTimeout(resolve, runPollDelay({ runs: [], publishing: false, failures, lastFailure, owed: true })!));
    next = undefined;
    if (!ours()) return null;
    if (state.concealed) continue;
    let runs: readonly PersonRunV1[];
    try {
      runs = (await runsCommand({ schema_version: 1, operation: 'list' })).runs;
    } catch (error) {
      failures += 1;
      lastFailure = failureOf(error);
      continue;
    }
    if (!ours()) return null;
    const run = runs.find(entry => entry.run_id === runId);
    if (run?.state === 'done') return 'done';
    if (!run || run.state === 'failed') return 'failed';
    next = runToStart(runs)?.run_id;
    // Nothing to start: a run is going, ours or one before it; look again at the usual pace.
    if (next === undefined) {
      failures = 0;
      lastFailure = undefined;
    }
  }
}

// ---- notifications: follow-ups that newly wait on you (F8) ---------------------------------

/** How often the quiet check reads Home's rows while someone is signed in. */
const QUIET_CHECK_MS = 5 * 60_000;
/** The quiet check's next read, and its turn: bumped whenever it stops, so a reply for an earlier turn is dropped. */
let quietTimer: ReturnType<typeof setTimeout> | null = null;
let quietSeq = 0;
/**
 * The account checked, and the follow-ups seen waiting on it: `ids` is null until its first check succeeds. `items` holds the
 * rows of the last check, so a notification clicked opens its item's page with its row at once.
 */
let quietSeen: { account: Expect; ids: ReadonlySet<string> | null; items?: ReadonlyMap<string, OpenItemView> } | null = null;

/**
 * Who last made an item wait on its owner: whoever picked the owner after
 * its state was last set, else whoever set that state (the approver's Send,
 * or a Reopen), else its approver.
 */
function handedBy(item: OpenItemView): OpenItemView['approver'] {
  const at = (value: string | null) => (value === null ? null : Date.parse(value));
  const owned = at(item.owner_set_at);
  const stated = at(item.state_set_at);
  if (item.owner_set_by && owned !== null && (stated === null || owned > stated)) return item.owner_set_by;
  return item.state_set_by ?? item.approver;
}

/**
 * What one quiet check found: every follow-up seen waiting on you so far
 * (open, and yours), and those to tell you of, new since the last check. The
 * first check after sign-in (`seen` null) only learns what is there. An item
 * given to you since is new, as its id was not yours before; one you made
 * yours yourself (Keep it myself, picking yourself) is seen, never told.
 */
export function newFollowUps(seen: ReadonlySet<string> | null, items: readonly OpenItemView[], me: string): { seen: Set<string>; fresh: OpenItemView[] } {
  const waiting = items.filter(item => item.state === 'open' && item.owner.membership_id === me);
  const fresh = seen === null ? [] : waiting.filter(item => !seen.has(item.item_id) && handedBy(item).membership_id !== me);
  return { seen: new Set([...(seen ?? []), ...waiting.map(item => item.item_id)]), fresh };
}

/** One line of a notification, cut to what main takes. */
function noticeLine(text: string): string {
  const chars = [...text.replace(/\p{Cc}+/gu, ' ').trim()];
  return chars.length <= NOTICE_TEXT_MAX ? chars.join('') : `${chars.slice(0, NOTICE_TEXT_MAX - 1).join('')}…`;
}

/**
 * The notification for follow-ups new to you, or null for none. One says who
 * sent it, by first name, and what it is: an action's own words, else its
 * decision's title when you can read it, else "a follow-up". Several are
 * counted.
 */
export function followUpsNotice(fresh: readonly OpenItemView[]): MainMethods['notify.followUps']['params'] | null {
  const ids = [...new Set(fresh.map(item => item.item_id))].slice(0, NOTICE_ITEMS_MAX);
  if (ids.length !== 1) return ids.length === 0 ? null : { item_ids: ids };
  const item = fresh[0]!;
  const title = item.kind === 'action' && item.expected ? item.expected : item.decision?.title ?? 'a follow-up';
  return { item_ids: ids, from: noticeLine(firstName(handedBy(item).name)), title: noticeLine(title) };
}

/** Signed in, or as another account: the quiet check starts over for it at once, then goes every five minutes, whatever the page. */
function startQuietCheck(account: Expect): void {
  stopQuietCheck();
  quietSeen = { account, ids: null };
  void quietCheck(quietSeq);
}

/** Signed out, or the account forgotten: no more checks, and what they saw goes. */
function stopQuietCheck(): void {
  quietSeq += 1;
  if (quietTimer) clearTimeout(quietTimer);
  quietTimer = null;
  quietSeen = null;
}

/**
 * One quiet check (F8): Home's rows only (no live read, never a sweep due),
 * so it starts no sweep or run, and Home shows nothing of it. What newly
 * waits on you is told in one notification, except an item whose page is open
 * now. A read that fails is tried again on the next turn; a reply for an
 * account no longer signed in is dropped.
 */
async function quietCheck(mine: number): Promise<void> {
  const watched = quietSeen;
  if (mine !== quietSeq || !watched) return;
  const result = await rpc('runs', { expect: watched.account, request: { schema_version: 1, operation: 'home', rows_only: true } });
  if (mine !== quietSeq || !sameAccount(watched.account)) return;
  if (result.ok) {
    const { items } = result.value as HomeView;
    const { seen, fresh } = newFollowUps(watched.ids, items, watched.account.membership_id);
    quietSeen = { account: watched.account, ids: seen, items: new Map(items.map(item => [item.item_id, item])) };
    const open = followUpShown();
    const notice = followUpsNotice(fresh.filter(item => open?.kind !== 'item' || open.item_id !== item.item_id));
    if (notice) void rpc('notify.followUps', notice);
  }
  quietTimer = setTimeout(() => { quietTimer = null; void quietCheck(mine); }, QUIET_CHECK_MS);
}

/**
 * A follow-ups notification was clicked, and the window comes forward: the
 * item's page over the page on screen, or the Follow-ups page for several. Only
 * an item this account's check saw wait on it opens, so one told before a
 * sign-out or a switch opens nothing. Capture, a sheet or a dialog that is up
 * stays, as for the tray.
 */
export function openNotified(item_id: string | undefined): void {
  if (!expect() || (state.compose && !state.compose.hidden) || newProjectInTheWay() || state.sheet || projectSettingsModal()) return;
  if (item_id === undefined) { void openYourFollowUps(true); return; }
  const watched = quietSeen;
  if (!watched?.ids?.has(item_id) || !sameAccount(watched.account)) return;
  const shown = followUpShown();
  if (shown?.kind === 'item' && shown.item_id === item_id) void readItem(shown.seq);
  // Its row from the check shows at once, then the page reads it live.
  else void openFollowUp(item_id, watched.items?.get(item_id) ?? null, true);
}
