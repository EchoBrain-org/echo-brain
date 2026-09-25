// All renderer state and the actions that change it. Every request carries the
// account being shown; late replies for a page that has moved on are dropped.
import { useEffect, useState } from 'preact/hooks';
import type {
  AccountCommand, Answer, AppStatus, AskScope, Audience, ConnectedTool, ContextContent, Expect, Extraction, Failure, FeedItem, FileHandle,
  Match, ProjectSummary, Receipt, Result,
} from '../shared/protocol.js';
import { searchQuery } from '../shared/query.js';
import { dropFile, rpc } from './api.js';
import { message } from './messages.js';

type Route = { page: 'home' } | { page: 'project'; project: ProjectSummary };

interface AskState {
  seq: number;
  question: string;
  scope: AskScope;
  scopeName: string;
  askedAt: number;
  status: 'loading' | 'answer' | 'error';
  answer?: Answer;
  failure?: Failure;
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

export type Sheet = SignOutSheet | ToolsSheet;

/** An original open in the reader: an item of a project, or a saved note found in all context. */
export interface ReaderState {
  contextId: string;
  from: { kind: 'project'; project_id: string } | { kind: 'note'; source: 'v2' | 'v3' };
  loading: boolean;
  content?: ContextContent;
  failure?: Failure;
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
  feed: { projectId: string; items: FeedItem[]; loading: boolean; failure?: Failure } | null;
  reader: ReaderState | null;
  /**
   * What the bar asks about, and searches: a project (the chip) or all
   * context. The page never moves with it.
   */
  barScope: AskScope;
  /** The bar's text. Only asking, Escape, or a real change of access empties it. */
  barText: string;
  matches: MatchesState | null;
  ask: AskState | null;
  evidence: { seq: number; label: string; loading: boolean; text?: string; failure?: Failure } | null;
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
}

const SIDEBAR_OPEN = 'echo.sidebarOpen';

function rememberedSidebar(): boolean {
  try { return localStorage.getItem(SIDEBAR_OPEN) !== 'false'; } catch { return true; }
}

let state: State = {
  status: null, booting: true, route: { page: 'home' }, projects: { items: [], next: null, loading: false }, feed: null, reader: null,
  barScope: { kind: 'global' }, barText: '', matches: null, ask: null, evidence: null, compose: null, toast: null, concealed: false,
  signin: { phase: 'idle', form: false }, sheet: null, startFailed: false, sidebarOpen: rememberedSidebar(),
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
const ACCESS_LOST = ['signed_out', 'unauthorized', 'stale_access_state', 'sign_in_required', 'not_found', 'forbidden'];

/**
 * Signed out or switched under us: re-read the account. The page that failed
 * still shows its failure, so nothing is left loading when the account is the
 * same one after all. Lost or refused access also empties the bar.
 */
function accountLost(failure: Failure): void {
  if (ACCESS_LOST.includes(failure.code)) emptyBar();
  if (['signed_out', 'account_changed', 'unauthorized', 'stale_access_state', 'sign_in_required'].includes(failure.code)) {
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
  if (!next) { emptyBar(); set({ sheet: null }); return; }
  const same = lastAccount?.authority === next.authority && lastAccount.membership_id === next.membership_id;
  // Someone else: nothing of the last account's survives, not even a draft.
  if (!same) forgetAccount();
  // A new role is a change of access: the bar's text goes.
  else if (before && before.role !== next.role) emptyBar();
  lastAccount = { authority: next.authority, membership_id: next.membership_id };
  if (!same || !wasSignedIn) void loadProjects();
}

/** Nothing of an account's stays on screen or in memory, not even a draft. */
function forgetAccount(): void {
  lastAccount = null;
  emptyBar();
  set({ route: { page: 'home' }, feed: null, reader: null, ask: null, evidence: null, sheet: null, toast: null,
    barScope: { kind: 'global' }, projects: { items: [], next: null, loading: false } });
  setCompose(null);
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
  // A sign-out already under way is not interrupted.
  if (!signedIn || (state.sheet?.kind !== 'tools' && state.sheet?.busy)) return;
  if (command === 'tools') void loadTools();
  else set({ sheet: { kind: command, busy: false } });
}

export function closeSheet(): void {
  if (!state.sheet || (state.sheet.kind !== 'tools' && state.sheet.busy)) return;
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

/** A save on its way: signing out now would lose whether it arrived. */
export function saveInFlight(): boolean {
  const status = state.compose?.status;
  return status === 'sending' || status === 'checking';
}

/** Sign out, or Switch account, after the person confirmed it. */
export async function signOut(): Promise<void> {
  const account = expect();
  const sheet = state.sheet;
  if (!account || !sheet || sheet.kind === 'tools' || sheet.busy || saveInFlight()) return;
  set({ sheet: { ...sheet, busy: true, failure: undefined } });
  const result = await rpc('account.signOut', { expect: account });
  if (!result.ok) {
    if (state.sheet?.kind === sheet.kind) set({ sheet: { ...sheet, busy: false, failure: result.failure } });
    accountLost(result.failure);
    return;
  }
  // Applied even if a status read already showed sign-in and closed the sheet.
  forgetAccount();
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
  set({ route: { page: 'home' }, feed: null, reader: null, ask: null, evidence: null, barScope: { kind: 'global' }, toast: null });
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
  const account = expect();
  if (!account) return;
  set({
    route: { page: 'project', project }, reader: null, ask: null, evidence: null, toast: null,
    barScope: { kind: 'project', project_id: project.project_id },
    feed: { projectId: project.project_id, items: [], loading: true },
  });
  syncSearch();
  const result = await rpc('projects.feed', { expect: account, project_id: project.project_id });
  if (state.feed?.projectId !== project.project_id) return; // moved on
  if (!result.ok) {
    accountLost(result.failure);
    set({ feed: { projectId: project.project_id, items: [], loading: false, failure: result.failure } });
    return;
  }
  set({ feed: { projectId: project.project_id, items: [...result.value.items], loading: false } });
}

/** A save landed in the project on screen: new rows, nothing else moves. */
async function refreshFeed(projectId: string): Promise<void> {
  const account = expect();
  if (!account || state.feed?.projectId !== projectId) return;
  const result = await rpc('projects.feed', { expect: account, project_id: projectId });
  if (!result.ok || state.feed?.projectId !== projectId) return;
  set({ feed: { ...state.feed, items: [...result.value.items], loading: false, failure: undefined } });
}

export function openItem(item: FeedItem): Promise<void> {
  const route = state.route;
  if (route.page !== 'project') return Promise.resolve();
  return read(item.context_id, { kind: 'project', project_id: route.project.project_id });
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
  if (!account) return;
  const mine = ++readSeq;
  set({ reader: { contextId, from, loading: true }, toast: null });
  const result = from.kind === 'project'
    ? await rpc('projects.readContext', { expect: account, project_id: from.project_id, context_id: contextId })
    : await rpc('search.read', { expect: account, context_id: contextId, source: from.source });
  if (state.reader?.contextId !== contextId || readSeq !== mine) return;
  if (!result.ok) {
    set({ reader: { contextId, from, loading: false, failure: result.failure } });
    accountLost(result.failure);
    return;
  }
  set({ reader: { contextId, from, loading: false, content: result.value } });
}

export function closeReader(): void { readSeq += 1; set({ reader: null }); }

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

export async function ask(question: string, scope: AskScope = state.barScope): Promise<void> {
  const account = expect();
  const text = question.trim();
  if (!account || text === '') return;
  const mine = ++seq;
  set({ ask: { seq: mine, question: text, scope, scopeName: scopeName(scope), askedAt: Date.now(), status: 'loading' }, evidence: null, toast: null });
  const result = await rpc('ask.run', { expect: account, question: text, scope });
  if (state.ask?.seq !== mine) return;
  if (!result.ok) {
    accountLost(result.failure);
    set({ ask: { ...state.ask, status: 'error', failure: result.failure } });
    return;
  }
  set({ ask: { ...state.ask, status: 'answer', answer: result.value } });
}

/** Leaves the answer. While asking it is Cancel: a late answer is dropped. */
export function closeAsk(): void {
  set({ ask: null, evidence: null });
  syncSearch();
}

export async function openSource(index: number): Promise<void> {
  const account = expect();
  const current = state.ask;
  const source = current?.answer?.sources[index];
  if (!account || !current || !source?.ref) return;
  const mine = ++seq;
  set({ evidence: { seq: mine, label: source.label, loading: true } });
  const result = await rpc('ask.source', { expect: account, scope: current.scope, ref: source.ref });
  // Replies that land while another app is in front are dropped, not shown later.
  if (state.ask?.seq !== current.seq || state.evidence?.seq !== mine) return;
  if (state.concealed) { set({ evidence: null }); return; }
  if (!result.ok) {
    accountLost(result.failure);
    set({ evidence: { seq: mine, label: source.label, loading: false, failure: result.failure } });
    return;
  }
  set({ evidence: { seq: mine, label: result.value.label, loading: false, text: result.value.text } });
}

export function closeSource(): void { set({ evidence: null }); }

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
 * the matches go.
 */
function syncSearch(fresh = false): void {
  clearTimeout(searchTimer);
  searchTimer = undefined;
  const wanted = wantedSearch();
  if (!wanted) { if (state.matches) set({ matches: null }); return; }
  const current = state.matches;
  const sameList = current !== null && sameScope(current.scope, wanted.scope);
  if (!fresh && sameList && current.query === wanted.query && !current.failure) return;
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
  searchTimer = setTimeout(() => syncSearch(), SEARCH_PAUSE_MS);
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
  if (text.trim() === '') return;
  emptyBar();
  void ask(text, state.barScope);
}

/** The matches show over the page: not over a reader, an answer, a sheet, or a covered window. */
export function matchesShown(current: State = state): boolean {
  return current.matches !== null && !current.concealed && !current.ask && !current.reader && !current.sheet &&
    !(current.compose && !current.compose.hidden) && searchQuery(current.barText) !== null;
}

/** The project the chip names, while its page is on screen. */
export function chipProject(current: State = state): ProjectSummary | null {
  const { route, barScope } = current;
  return !current.concealed && route.page === 'project' && barScope.kind === 'project' && barScope.project_id === route.project.project_id
    ? route.project : null;
}

// ---- capture -----------------------------------------------------------------

const NOTE_OR_FILE = 'Save this note before attaching a file.';

/** Main's quit guard: a note or a file on its way, or not yet confirmed either way. */
function unresolvedChanged(): void {
  const compose = state.compose;
  const unresolved = compose?.status === 'sending' || compose?.status === 'unknown' || compose?.status === 'checking';
  void rpc('app.setUnresolved', { unresolved, ...(unresolved && compose.file ? { file: true } : {}) });
}

function setCompose(compose: ComposeState | null): void {
  const before = state.compose?.status;
  set({ compose });
  if (before !== compose?.status) unresolvedChanged();
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

/** A project chosen under More…: the capture goes there, for its members. */
export function chooseProject(project: ProjectSummary): void { editCompose({ project, readers: 'project', picking: false }); }

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
const EXTRACTION: Record<Extraction, string> = {
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
 * its text; its matches go, and are read again for the account on return.
 */
export function conceal(): void {
  set({ concealed: true });
  syncSearch();
}
export function resume(): void {
  if (!state.concealed) return;
  set({ concealed: false });
  void refreshStatus().then(searchAgain);
}

/** The window came forward (⌘E, the tray): the account, Home and the bar's search are read again. */
export async function windowShown(): Promise<void> {
  if (state.concealed) return;
  await refreshStatus();
  searchAgain();
  await refreshHome();
}
