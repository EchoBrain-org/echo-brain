// All renderer state and the actions that change it. Every request carries the
// account being shown; late replies for a page that has moved on are dropped.
import { useEffect, useState } from 'preact/hooks';
import type {
  Answer, AppStatus, AskScope, Audience, ContextContent, Expect, Failure, FeedItem, FileHandle, ProjectSummary, Result,
} from '../shared/protocol.js';
import { dropFile, rpc } from './api.js';

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
  evidence: { label: string; loading: boolean; text?: string; failure?: Failure } | null;
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

/** Signed out or switched under us: go back to a fresh status. */
function accountLost(failure: Failure): boolean {
  if (['signed_out', 'account_changed', 'unauthorized', 'stale_access_state', 'sign_in_required'].includes(failure.code)) {
    void refreshStatus();
    return true;
  }
  return false;
}

// ---- status and sign-in ------------------------------------------------------

export async function refreshStatus(): Promise<void> {
  const result = await rpc('app.status', {});
  // Keep what is on screen; with nothing on screen yet, say ECHO could not start.
  if (!result.ok) { set({ booting: false, startFailed: state.status === null || result.failure.code === 'host_failed' }); return; }
  const previous = state.status?.account;
  const next = result.value.account;
  const changed = previous?.membership_id !== next?.membership_id || previous?.authority !== next?.authority;
  set({ status: result.value, booting: false, startFailed: false });
  if (changed) {
    set({ route: { page: 'home' }, feed: null, reader: null, ask: null, evidence: null, compose: null,
      barScope: { kind: 'global' }, projects: { items: [], next: null, loading: false } });
    if (next) void loadProjects();
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

export async function signOut(): Promise<void> {
  const account = expect();
  if (!account) return;
  await rpc('account.logout', { expect: account });
  await refreshStatus();
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
    if (!accountLost(result.failure)) set({ projects: { ...state.projects, loading: false, failure: result.failure } });
    return;
  }
  const seen = new Set(more ? state.projects.items.map(project => project.project_id) : []);
  const items = [...(more ? state.projects.items : []), ...result.value.items.filter(project => !seen.has(project.project_id))];
  set({ projects: { items, next: result.value.next_cursor, loading: false } });
}

export function goHome(): void {
  set({ route: { page: 'home' }, feed: null, reader: null, ask: null, evidence: null, barScope: { kind: 'global' } });
  void loadProjects();
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
    if (!accountLost(result.failure)) set({ feed: { projectId: project.project_id, items: [], loading: false, failure: result.failure } });
    return;
  }
  set({ feed: { projectId: project.project_id, items: [...result.value.items], loading: false } });
}

export async function openItem(item: FeedItem): Promise<void> {
  const account = expect();
  const route = state.route;
  if (!account || route.page !== 'project') return;
  set({ reader: { contextId: item.context_id, loading: true } });
  const result = await rpc('projects.readContext', { expect: account, project_id: route.project.project_id, context_id: item.context_id });
  if (state.reader?.contextId !== item.context_id) return;
  if (!result.ok) {
    if (!accountLost(result.failure)) set({ reader: { contextId: item.context_id, loading: false, failure: result.failure } });
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
    if (!accountLost(result.failure)) set({ ask: { ...state.ask, status: 'error', failure: result.failure } });
    return;
  }
  set({ ask: { ...state.ask, status: 'answer', answer: result.value } });
}

export function closeAsk(): void { set({ ask: null, evidence: null }); }

export async function openSource(index: number): Promise<void> {
  const account = expect();
  const current = state.ask;
  const source = current?.answer?.sources[index];
  if (!account || !current || !source?.ref) return;
  set({ evidence: { label: source.label, loading: true } });
  const result = await rpc('ask.source', { expect: account, scope: current.scope, ref: source.ref });
  // Replies that land while another app is in front are dropped, not shown later.
  if (state.ask?.seq !== current.seq || state.evidence?.label !== source.label) return;
  if (state.concealed) { set({ evidence: null }); return; }
  if (!result.ok) {
    if (!accountLost(result.failure)) set({ evidence: { label: source.label, loading: false, failure: result.failure } });
    return;
  }
  set({ evidence: { label: result.value.label, loading: false, text: result.value.text } });
}

export function closeSource(): void { set({ evidence: null }); }

export async function copyAnswer(): Promise<void> {
  const text = state.ask?.answer?.text;
  if (text) await rpc('clipboard.writeText', { text });
}

// ---- write and capture -------------------------------------------------------

function unresolvedChanged(): void {
  void rpc('app.setUnresolved', { unresolved: state.compose?.status === 'unknown' || state.compose?.status === 'checking' });
}

function setCompose(compose: ComposeState | null): void {
  const before = state.compose?.status;
  set({ compose });
  if (before !== compose?.status) unresolvedChanged();
}

/**
 * Opens the sheet. A hidden draft (or an unresolved save) always comes back
 * as it was; otherwise a new note starts, for the project on screen or Only
 * me. The audience never widens unless the person picks it.
 */
export function openCompose(file: FileHandle | null = null, project?: ProjectSummary): void {
  const current = state.compose;
  if (current && current.status !== 'sent') {
    const attach = file && !current.file && (current.status === 'editing' || current.status === 'error');
    setCompose({ ...current, hidden: false, ...(attach ? { file, requestId: crypto.randomUUID(), status: 'editing' as const, failure: undefined } : {}) });
    return;
  }
  const route = state.route;
  const inProject = project ?? (route.page === 'project' ? route.project : undefined);
  setCompose({
    seq: ++seq, text: '', file, picking: false, status: 'editing', requestId: crypto.randomUUID(), hidden: false, confirmNew: false,
    target: inProject ? { kind: 'project', project: inProject } : { kind: 'only-me' },
  });
}

/** Escape or Close hides the sheet and keeps the draft; only a sent note is gone. */
export function closeCompose(): void {
  const compose = state.compose;
  if (!compose || compose.status === 'sending' || compose.status === 'checking') return;
  if (compose.status === 'sent') { setCompose(null); return; }
  setCompose({ ...compose, hidden: true, picking: false, confirmNew: false });
}

function locked(compose: ComposeState): boolean {
  return ['sending', 'checking', 'unknown', 'sent'].includes(compose.status);
}

function editCompose(patch: Partial<ComposeState>): void {
  const compose = state.compose;
  if (!compose || locked(compose)) return;
  // Any change to what would be sent makes it a new request.
  const changesContent = 'text' in patch || 'target' in patch || 'file' in patch;
  setCompose({ ...compose, ...patch, ...(changesContent ? { requestId: crypto.randomUUID(), status: 'editing' as const, failure: undefined } : {}) });
}

export function setComposeText(text: string): void { editCompose({ text }); }
export function toggleTargets(): void {
  const compose = state.compose;
  if (compose && !locked(compose)) setCompose({ ...compose, picking: !compose.picking });
}
export function chooseTarget(target: ComposeTarget): void { editCompose({ target, picking: false }); }
export function removeFile(): void { editCompose({ file: null }); }

export async function attachFile(): Promise<void> {
  const result = await rpc('dialog.openDocument', {});
  if (result.ok && result.value) editCompose({ file: result.value });
  else if (!result.ok && state.compose && !locked(state.compose)) setCompose({ ...state.compose, status: 'error', failure: result.failure });
}

export async function acceptDrop(file: File, project?: ProjectSummary): Promise<void> {
  const result = await dropFile(file);
  if (!result.ok) {
    if (state.compose && !locked(state.compose)) setCompose({ ...state.compose, status: 'error', failure: result.failure, hidden: false });
    return;
  }
  openCompose(result.value, project);
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
  const text = compose.text.trim() === '' ? '' : compose.text;
  if (text === '' && !compose.file) return;
  setCompose({ ...compose, status: 'sending', failure: undefined, picking: false, confirmNew: false });
  const audience = audienceOf(compose.target);
  const projectId = compose.target.kind === 'project' ? compose.target.project.project_id : undefined;
  let result: Result<unknown>;
  if (compose.file) {
    const title = text.split('\n').map(line => line.trim()).find(line => line !== '') ?? compose.file.name;
    result = await rpc('documents.upload', {
      expect: account, request_id: compose.requestId, file_handle: compose.file.handle, title,
      audience, ...(projectId === undefined ? {} : { project_id: projectId }),
    });
  } else {
    result = await rpc('notes.submit', {
      expect: account, request_id: compose.requestId, text, audience, ...(projectId === undefined ? {} : { project_id: projectId }),
    });
  }
  const current = state.compose;
  if (current?.seq !== compose.seq) return;
  if (!result.ok) {
    const unknown = result.failure.mutation_outcome === 'unknown';
    setCompose({ ...current, status: unknown ? 'unknown' : 'error', failure: result.failure, hidden: false });
    accountLost(result.failure);
    return;
  }
  setCompose({ ...current, status: 'sent', hidden: false });
  if (state.route.page === 'project' && projectId === state.route.project.project_id) void openProject(state.route.project);
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
  setCompose(null);
  openCompose();
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
