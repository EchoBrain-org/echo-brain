// All renderer state and the actions that change it. Every request carries the
// account being shown; late replies for a page that has moved on are dropped.
import { useEffect, useState } from 'preact/hooks';
import type {
  Answer, AppStatus, AskScope, Audience, ContextContent, Expect, Failure, FeedItem, FileHandle, ProjectSummary, Result,
} from '../shared/protocol.js';
import { dropFile, rpc } from './api.js';
import { message } from './messages.js';

export type Route = { page: 'home' } | { page: 'project'; project: ProjectSummary };

export interface AskState {
  seq: number;
  question: string;
  scope: AskScope;
  scopeName: string;
  askedAt: number;
  status: 'loading' | 'answer' | 'error';
  answer?: Answer;
  failure?: Failure;
}

export type ComposeTarget = { kind: 'only-me' } | { kind: 'team' } | { kind: 'project'; project: ProjectSummary };

export interface ComposeState {
  seq: number;
  text: string;
  target: ComposeTarget;
  picking: boolean;
  file: FileHandle | null;
  /** unknown: the save may or may not have arrived; the text is locked. */
  status: 'editing' | 'sending' | 'sent' | 'error' | 'unknown' | 'checking';
  /** The exact request a retry resends. */
  requestId: string;
  failure?: Failure;
  /** Closed but kept: ⌘⇧E or + brings it back. */
  hidden: boolean;
  /** Asking once before starting over on an unconfirmed save. */
  confirmNew: boolean;
  /** A fixed line about the last gesture, such as a file that was not attached. */
  notice?: string;
}

export interface State {
  status: AppStatus | null;
  booting: boolean;
  route: Route;
  projects: { items: ProjectSummary[]; next: string | null; loading: boolean; failure?: Failure };
  feed: { projectId: string; items: FeedItem[]; loading: boolean; failure?: Failure } | null;
  reader: { contextId: string; loading: boolean; content?: ContextContent; failure?: Failure } | null;
  barScope: AskScope;
  ask: AskState | null;
  evidence: { seq: number; label: string; loading: boolean; text?: string; failure?: Failure } | null;
  compose: ComposeState | null;
  concealed: boolean;
  signin: { phase: 'idle' | 'waiting' | 'failed'; failure?: Failure; browserOpened?: boolean };
  /** No status could be read (the host is down): not the same as signed out. */
  startFailed: boolean;
}

let state: State = {
  status: null, booting: true, route: { page: 'home' }, projects: { items: [], next: null, loading: false }, feed: null, reader: null,
  barScope: { kind: 'global' }, ask: null, evidence: null, compose: null, concealed: false, signin: { phase: 'idle' },
  startFailed: false,
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

/**
 * Signed out or switched under us: re-read the account. The page that failed
 * still shows its failure, so nothing is left loading when the account is the
 * same one after all.
 */
function accountLost(failure: Failure): void {
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
  const wasSignedIn = state.status?.signed_in === true;
  const next = result.value.account;
  set({ status: result.value, booting: false, startFailed: false });
  // Signed out: the sign-in page covers everything until someone signs in.
  if (!next) return;
  const same = lastAccount?.authority === next.authority && lastAccount.membership_id === next.membership_id;
  lastAccount = { authority: next.authority, membership_id: next.membership_id };
  if (!same) {
    // Someone else: nothing of the last account's survives, not even a draft.
    set({ route: { page: 'home' }, feed: null, reader: null, ask: null, evidence: null,
      barScope: { kind: 'global' }, projects: { items: [], next: null, loading: false } });
    setCompose(null);
    void loadProjects();
  } else if (!wasSignedIn) {
    void loadProjects();
  }
}

export async function signIn(authorityUrl: string): Promise<void> {
  set({ signin: { phase: 'waiting' } });
  const result = await rpc('signin.begin', { authority_url: authorityUrl });
  if (!result.ok) { set({ signin: { phase: 'failed', failure: result.failure } }); return; }
  set({ signin: { phase: 'idle' } });
  await refreshStatus();
}

/** The host gave up after repeated exits. */
export function hostFailed(): void { set({ startFailed: true, booting: false }); }

export async function retryStart(): Promise<void> {
  set({ booting: true });
  await rpc('app.retryHost', {});
  await refreshStatus();
}

export function signinPhase(browserOpened: boolean | undefined): void {
  if (state.signin.phase === 'waiting') set({ signin: { phase: 'waiting', browserOpened } });
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
  const seen = new Set(more ? state.projects.items.map(project => project.project_id) : []);
  const items = [...(more ? state.projects.items : []), ...result.value.items.filter(project => !seen.has(project.project_id))];
  set({ projects: { items, next: result.value.next_cursor, loading: false } });
}

/** Back to Home as it was left: the same pages, the same scroll. */
export function goHome(): void {
  set({ route: { page: 'home' }, feed: null, reader: null, ask: null, evidence: null, barScope: { kind: 'global' } });
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
  const seen = new Set(first.map(project => project.project_id));
  const loadedMore = state.projects.items.length > first.length;
  const later = loadedMore ? state.projects.items.slice(first.length).filter(project => !seen.has(project.project_id)) : [];
  set({ projects: { items: [...first, ...later], next: loadedMore ? state.projects.next : result.value.next_cursor, loading: false } });
}

export async function openProject(project: ProjectSummary): Promise<void> {
  const account = expect();
  if (!account) return;
  set({
    route: { page: 'project', project }, reader: null, ask: null, evidence: null,
    barScope: { kind: 'project', project_id: project.project_id },
    feed: { projectId: project.project_id, items: [], loading: true },
  });
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

export async function openItem(item: FeedItem): Promise<void> {
  const account = expect();
  const route = state.route;
  if (!account || route.page !== 'project') return;
  set({ reader: { contextId: item.context_id, loading: true } });
  const result = await rpc('projects.readContext', { expect: account, project_id: route.project.project_id, context_id: item.context_id });
  if (state.reader?.contextId !== item.context_id) return;
  if (!result.ok) {
    accountLost(result.failure);
    set({ reader: { contextId: item.context_id, loading: false, failure: result.failure } });
    return;
  }
  set({ reader: { contextId: item.context_id, loading: false, content: result.value } });
}

export function closeReader(): void { set({ reader: null }); }

// ---- ask ---------------------------------------------------------------------

/** The × on the scope chip: the next question asks everything you can read. */
export function widenScope(): void { set({ barScope: { kind: 'global' } }); }

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
  set({ ask: { seq: mine, question: text, scope, scopeName: scopeName(scope), askedAt: Date.now(), status: 'loading' }, evidence: null });
  const result = await rpc('ask.run', { expect: account, question: text, scope });
  if (state.ask?.seq !== mine) return;
  if (!result.ok) {
    accountLost(result.failure);
    set({ ask: { ...state.ask, status: 'error', failure: result.failure } });
    return;
  }
  set({ ask: { ...state.ask, status: 'answer', answer: result.value } });
}

export function closeAsk(): void { set({ ask: null, evidence: null }); }
/** Stop waiting: a late answer is dropped. */
export const cancelAsk = closeAsk;

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

export async function copyAnswer(): Promise<void> {
  const text = state.ask?.answer?.text;
  if (text) await rpc('clipboard.writeText', { text });
}

// ---- write and capture -------------------------------------------------------

const NOTE_OR_FILE = 'Send this note before attaching a document.';

/** Main's quit guard: a save on its way or not yet confirmed either way. */
function unresolvedChanged(): void {
  const status = state.compose?.status;
  void rpc('app.setUnresolved', { unresolved: status === 'sending' || status === 'unknown' || status === 'checking' });
}

function setCompose(compose: ComposeState | null): void {
  const before = state.compose?.status;
  set({ compose });
  if (before !== compose?.status) unresolvedChanged();
}

function fresh(file: FileHandle | null, target: ComposeTarget, notice?: string): ComposeState {
  return {
    seq: ++seq, text: '', file, picking: false, status: 'editing', requestId: crypto.randomUUID(), hidden: false, confirmNew: false,
    target, ...(notice === undefined ? {} : { notice }),
  };
}

/** The project on screen, or Only me. */
function onScreen(): ComposeTarget {
  return state.route.page === 'project' ? { kind: 'project', project: state.route.project } : { kind: 'only-me' };
}

/** A draft that is not sent yet: hidden, being written, or unresolved. */
function draft(): ComposeState | null {
  const current = state.compose;
  return current && current.status !== 'sent' ? current : null;
}

/** ⊕: the draft comes back as it was, or a new note for the project on screen. */
export function openCompose(): void {
  const current = draft();
  setCompose(current ? { ...current, hidden: false } : fresh(null, onScreen()));
}

/**
 * ⌘⇧E, from any app: the draft comes back as it was, or a new note starts
 * private. Whatever page was left open never picks the audience.
 */
export function openCapture(): void {
  const current = draft();
  setCompose(current ? { ...current, hidden: false } : fresh(null, { kind: 'only-me' }));
}

/** Escape or Close hides the sheet and keeps the draft; only a sent note is gone. */
export function closeCompose(): void {
  const compose = state.compose;
  if (!compose || compose.status === 'sending' || compose.status === 'checking') return;
  if (compose.status === 'sent') { setCompose(null); return; }
  setCompose({ ...compose, hidden: true, picking: false, confirmNew: false, notice: undefined });
}

function locked(compose: ComposeState): boolean {
  return ['sending', 'checking', 'unknown', 'sent'].includes(compose.status);
}

function editCompose(patch: Partial<ComposeState>): void {
  const compose = state.compose;
  if (!compose || locked(compose)) return;
  // Any change to what would be sent makes it a new request.
  const changesContent = 'text' in patch || 'target' in patch || 'file' in patch;
  setCompose({ ...compose, notice: undefined, ...patch,
    ...(changesContent ? { requestId: crypto.randomUUID(), status: 'editing' as const, failure: undefined } : {}) });
}

export function setComposeText(text: string): void { editCompose({ text }); }
export function toggleTargets(): void {
  const compose = state.compose;
  if (compose && !locked(compose)) setCompose({ ...compose, picking: !compose.picking });
}
export function chooseTarget(target: ComposeTarget): void { editCompose({ target, picking: false }); }
export function removeFile(): void { editCompose({ file: null }); }

/** The paperclip. A note and a file are never sent together. */
export async function attachFile(): Promise<void> {
  const compose = state.compose;
  if (!compose || locked(compose)) return;
  if (compose.text.trim() !== '') { setCompose({ ...compose, notice: NOTE_OR_FILE }); return; }
  const result = await rpc('dialog.openDocument', {});
  if (result.ok && result.value) editCompose({ file: result.value });
  else if (!result.ok && state.compose && !locked(state.compose)) setCompose({ ...state.compose, notice: message(result.failure) });
}

/**
 * A dropped file. On a Home row it is for that project; elsewhere for the
 * project on screen or Only me. A draft with words in it, or a save still
 * unresolved, is never changed: it comes back and says the file was left out.
 */
export async function acceptDrop(file: File, project?: ProjectSummary): Promise<void> {
  const result = await dropFile(file);
  const target: ComposeTarget = project ? { kind: 'project', project } : onScreen();
  const current = draft();
  if (current && (locked(current) || current.text.trim() !== '')) {
    setCompose({ ...current, hidden: false, notice: locked(current) ? 'The file was not attached.' : NOTE_OR_FILE });
    return;
  }
  if (!result.ok) {
    setCompose(current ? { ...current, hidden: false, notice: message(result.failure) } : fresh(null, target, message(result.failure)));
    return;
  }
  // Nothing written yet: the drop starts over, addressed as the gesture says.
  setCompose(fresh(result.value, target));
}

function audienceOf(target: ComposeTarget): Audience {
  return target.kind === 'project' ? { kind: 'project', project_id: target.project.project_id } : { kind: target.kind };
}

export function targetLabel(target: ComposeTarget): string {
  return target.kind === 'only-me' ? 'Only me' : target.kind === 'team' ? 'Everyone' : target.project.name;
}

export function sentLabel(target: ComposeTarget): string {
  return target.kind === 'only-me' ? 'Saved for you' : target.kind === 'team' ? 'Sent to everyone' : `Sent to ${target.project.name}`;
}

/** Send, or resend the exact same request after an unconfirmed outcome. */
export async function sendCompose(): Promise<void> {
  const account = expect();
  const compose = state.compose;
  if (!account || !compose || ['sending', 'checking', 'sent'].includes(compose.status)) return;
  if (!compose.file && compose.text.trim() === '') return;
  const retrying = compose.status === 'unknown';
  setCompose({ ...compose, status: 'sending', failure: undefined, picking: false, confirmNew: false, notice: undefined });
  const audience = audienceOf(compose.target);
  const projectId = compose.target.kind === 'project' ? compose.target.project.project_id : undefined;
  const project = projectId === undefined ? {} : { project_id: projectId };
  let result: Result<unknown>;
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
    setCompose({ ...current, status: unknown ? 'unknown' : 'error', failure: result.failure, hidden: false });
    accountLost(result.failure);
    return;
  }
  setCompose({ ...current, status: 'sent', hidden: false });
  if (state.route.page === 'project' && projectId === state.route.project.project_id) void refreshFeed(projectId);
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
  if (result.ok && result.value.state === 'saved') { setCompose({ ...current, status: 'sent' }); return; }
  if (result.ok && result.value.state === 'not_saved') {
    // It never arrived: sending the same request again is safe.
    setCompose({ ...current, status: 'error', failure: { code: 'not_saved', retryable: true } });
    return;
  }
  setCompose({ ...current, status: 'unknown' });
}

/** Write new while a save is unconfirmed asks once, then starts over. */
export function newCompose(): void {
  const compose = state.compose;
  if (!compose) return;
  if (compose.status === 'unknown' && !compose.confirmNew) { setCompose({ ...compose, confirmNew: true }); return; }
  setCompose(fresh(null, onScreen()));
}

export function keepUnresolved(): void {
  if (state.compose) setCompose({ ...state.compose, confirmNew: false });
}

// ---- concealment ---------------------------------------------------------------

/** Another app is in front: cover the window until ECHO is back. */
export function conceal(): void { set({ concealed: true }); }
export function resume(): void {
  if (!state.concealed) return;
  set({ concealed: false });
  void refreshStatus();
}
