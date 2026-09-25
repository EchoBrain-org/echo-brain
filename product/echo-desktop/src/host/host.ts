// The person host: an Electron utility process that runs the TypeScript person
// client in-process. It is the only process that reads the session or holds a
// token; what it posts back is a token-free view model or a failure code.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  externalUrl, WRITE_METHODS, type AppStatus, type AskScope, type Audience, type Expect, type Failure, type HostMethods,
  type HostMethodName, type HostRequest, type ProjectChange, type Result,
} from '../shared/protocol.js';
import { askText, searchQuery } from '../shared/query.js';
import { jsonLines, lastJson, runCli, type CliRun, type PersonCli } from './cli.js';
import {
  abandonView, answerView, changeView, contextView, createdView, documentPageView, documentTextView, employeesView, evidenceView, failureView,
  feedView, invitationView, isRecordRef, membersView, noteMatchesView, noteTitle, noteView, projectMatchesView, projectPageView, projectView,
  receiptView, recordView, revokedView, savedOriginalView, statusView, toolsView, unwrap, ViewError, writeStatusView,
} from './views.js';

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}
const port = (process as unknown as { parentPort: ParentPort }).parentPort;
if (__ECHO_TEST_HOOK__ && process.env.ECHO_DESKTOP_TEST_MODE === 'host-crash') process.exit(3);

const entry = process.env.ECHO_PERSON_CLIENT_ENTRY;
const home = process.env.ECHO_HOME;
if (!entry || !home) throw new Error('The person host needs ECHO_PERSON_CLIENT_ENTRY and ECHO_HOME');

interface SessionStore { read(): { session: { access_expires_at: string } } }
interface SessionPaths { refresh_claim: string; refreshing: string }
interface ClientModules {
  cli: PersonCli;
  store: SessionStore;
  paths: SessionPaths;
  dependencies: Record<string, unknown>;
  now: () => number;
}

async function load(): Promise<ClientModules> {
  const client = await import(pathToFileURL(entry!).href) as { runPersonClientCli: PersonCli };
  const sessions = await import(pathToFileURL(join(entry!, '..', 'session-store.js')).href) as {
    PersonSessionStore: new (home: string) => SessionStore;
    personSessionStorePaths: (home: string) => SessionPaths;
  };
  const dependencies: Record<string, unknown> = {
    home_directory: home,
    open_authorization_url: (url: string) => {
      // Main opens only what externalUrl allows: anything else never opened,
      // so the client must not wait on it. The renderer never sees the URL.
      if (externalUrl(url) === null) return false;
      port.postMessage({ notice: 'open-external', payload: { url } });
      return true;
    },
  };
  let now = () => Date.now();
  if (__ECHO_TEST_HOOK__ && process.env.ECHO_DESKTOP_TEST_FIXTURES) {
    // Belt and braces with main: the fixture never writes into the real home.
    if (resolve(home!) === resolve(homedir())) throw new Error('The test Authority needs a private ECHO_HOME');
    const test = await import('./test-authority.js');
    const hook = test.installTestAuthority(home!, process.env.ECHO_DESKTOP_TEST_FIXTURES, sessions.PersonSessionStore);
    Object.assign(dependencies, hook.dependencies);
    now = hook.now;
  }
  return {
    cli: client.runPersonClientCli, store: new sessions.PersonSessionStore(home!), paths: sessions.personSessionStorePaths(home!),
    dependencies, now,
  };
}
// A note's text left behind by a host that was stopped mid-send.
try {
  for (const name of readdirSync(tmpdir())) if (name.startsWith('echo-note-')) rmSync(join(tmpdir(), name), { recursive: true, force: true });
} catch { /* best effort */ }
const modules = load();
modules.catch(error => { console.error('person host failed to load the client:', error); });

/** Per-method limits; the client enforces its own shorter network timeouts. */
const TIMEOUT_MS: Record<HostMethodName, number> = {
  'app.status': 5_000, 'signin.begin': 11 * 60_000, 'signin.invitation': 11 * 60_000, 'projects.list': 45_000,
  'projects.feed': 45_000, 'projects.readContext': 45_000, 'notes.submit': 45_000, 'documents.upload': 720_000,
  'ask.run': 145_000, 'ask.source': 15_000, 'ask.record': 15_000, 'writes.status': 45_000, 'documents.retry': 720_000, 'documents.abandon': 15_000,
  'account.signOut': 45_000, 'account.tools': 45_000, 'search.run': 45_000, 'search.read': 45_000, 'documents.list': 45_000,
  'documents.read': 45_000, 'documents.save': 720_000, 'projects.read': 45_000, 'projects.members': 45_000, 'projects.directory': 45_000,
  'projects.change': 45_000, 'projects.create': 45_000, 'employees.list': 45_000, 'employees.invite': 45_000, 'employees.reissue': 45_000,
  'employees.revoke': 45_000,
};
/** Calls that never reach the Authority: they wait out a refresh, never start one. */
const LOCAL: ReadonlySet<HostMethodName> = new Set<HostMethodName>(['app.status', 'documents.abandon']);
/** A saved note's id, as the client takes it. */
const CONTEXT_ID = /^ctx_[0-9a-f]{64}$/;
/** A request id the client accepts: a lowercase UUID v4. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PROJECT_ID = new RegExp(`^prj_${UUID}$`);
const MEMBERSHIP_ID = new RegExp(`^mem_${UUID}$`);
const DOCUMENT_ID = /^doc_[0-9a-f]{64}$/;
/** A page cursor, as the API writes one. */
const CURSOR = /^[A-Za-z0-9_-]{1,1024}$/;
/** Writes this host has handed to the client and not yet heard back on. */
const inFlight = new Set<string>();

/** A project's name as the API takes it: one line, trimmed, NFC, at most 200 UTF-8 bytes. */
function projectName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').trim();
  return name === '' || Buffer.byteLength(name) > 200 || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(name) ? null : name;
}

/** An employee's name and email, bounded; the client checks them exactly before anything is sent. */
function employeeText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Values the page supplied go in `--name=value` form: a leading '-' stays text. */
function option(name: string, value: string): string { return `--${name}=${value}`; }
/** The client's own account binding for document writes. */
function expected(expect: Expect): string[] {
  return [option('expected-membership-id', expect.membership_id), option('expected-authority', expect.authority)];
}

// Refresh gate. Calls normally run side by side. Before a call that needs the
// network, when the access token is within a minute of expiring, one explicit
// refresh runs alone first, so a concurrent call never reads the session while
// it is being replaced. Status is local: it waits out a refresh, never starts one.
let active = 0;
let exclusive: Promise<void> | null = null;
const idle: Array<() => void> = [];

function refreshDue(store: SessionStore, now: number): boolean {
  try {
    return now >= Date.parse(store.read().session.access_expires_at) - 60_000;
  } catch {
    return false; // Signed out or mid-refresh: the command itself reports it.
  }
}

async function gated<T>(run: () => Promise<T>, network: boolean, refreshFailed?: (refresh: CliRun) => T): Promise<T> {
  const { store, now } = await modules;
  while (exclusive) await exclusive;
  if (network && refreshDue(store, now())) {
    let release!: () => void;
    exclusive = new Promise(resolve => { release = resolve; });
    try {
      while (active > 0) await new Promise<void>(resolve => idle.push(resolve));
      // A refresh that failed leaves the client signed out, and the call
      // reports that; only one that never left the machine (no network yet)
      // puts the session back. Then the call is not made, since its client
      // would only try the same refresh again; the next call does.
      if (refreshDue(store, now())) {
        const refresh = await cli(['session-refresh']);
        if (refresh.exit !== 0 && refreshFailed && refreshDue(store, now())) return refreshFailed(refresh);
      }
    } finally {
      exclusive = null;
      release();
    }
  }
  active += 1;
  try {
    return await run();
  } finally {
    active -= 1;
    if (active === 0) idle.splice(0).forEach(resolve => resolve());
  }
}

async function cli(argv: readonly string[], onLine?: (line: string) => void): Promise<CliRun> {
  const { cli: run, dependencies } = await modules;
  return runCli(run, argv, dependencies, onLine);
}

function ok<T>(value: T): Result<T> { return { ok: true, value }; }
function fail(failure: Failure): Result<never> { return { ok: false, failure }; }
function code(value: string, write = false, requestId?: string): Result<never> {
  return fail(failureView({ code: value }, value, write, requestId));
}

async function readStatus(): Promise<AppStatus | null> {
  const run = await cli(['status']);
  if (run.exit !== 0 || run.overflow) return null;
  try { return statusView(lastJson(run.stdout)); } catch { return null; }
}

/**
 * While another process (the terminal CLI) refreshes, the session file is set
 * aside and the client reads as signed out. A claim whose session is past its
 * weekly deadline is left over from an older client's expiry: that one is
 * signed out at once.
 */
async function refreshRunningElsewhere(): Promise<boolean> {
  const { paths, now } = await modules;
  if (!existsSync(paths.refresh_claim) || !existsSync(paths.refreshing)) return false;
  try {
    const stored = JSON.parse(readFileSync(paths.refreshing, 'utf8')) as { session?: { hard_reauthentication_at?: unknown } };
    const deadline = Date.parse(String(stored.session?.hard_reauthentication_at));
    return Number.isFinite(deadline) && now() < deadline;
  } catch {
    return false;
  }
}

/** Waits at most 3 s on another process's refresh: well inside app.status's 5 s. */
async function status(): Promise<AppStatus | null> {
  for (let attempt = 0; ; attempt += 1) {
    const current = await readStatus();
    if (current === null || current.signed_in || attempt >= 6 || !(await refreshRunningElsewhere())) return current;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

function sameAccount(current: AppStatus | null, expect: Expect): boolean {
  return current?.account?.authority === expect.authority && current.account.membership_id === expect.membership_id;
}

/** Runs a command for the account the renderer is showing, never another. */
async function forAccount<T>(
  method: HostMethodName, expect: Expect, argv: readonly string[], view: (stdout: string) => T, requestId?: string,
): Promise<Result<T>> {
  const write = WRITE_METHODS.has(method);
  if (!sameAccount(await status(), expect)) return code('account_changed', write, requestId);
  if (write && requestId !== undefined) inFlight.add(requestId);
  let run: CliRun;
  try {
    run = await cli(argv);
  } finally {
    if (write && requestId !== undefined) inFlight.delete(requestId);
  }
  const after = await status();
  if (!sameAccount(after, expect)) {
    // A write may have gone out before the switch; never call it saved or not.
    return fail({ code: 'account_changed', retryable: false, ...(write ? { mutation_outcome: 'unknown' as const } : {}),
      ...(requestId === undefined ? {} : { request_id: requestId }) });
  }
  if (run.overflow) return code('invalid_output', write, requestId);
  if (__ECHO_TEST_HOOK__ && run.exit !== 0) console.error(`[client] ${argv[0]} ${argv[1] ?? ''} failed: ${run.stderr.slice(0, 600)}`);
  if (run.exit !== 0) {
    const fallback = after?.signed_in === false ? 'signed_out' : 'failed';
    return fail(failureView(lastJson(run.stderr), fallback, write, requestId));
  }
  try {
    return ok(view(run.stdout));
  } catch (error) {
    // A write that succeeded with a reply we cannot read may well have landed.
    if (error instanceof ViewError) {
      return fail({ code: 'invalid_output', retryable: true, ...(write ? { mutation_outcome: 'unknown' as const } : {}),
        ...(requestId === undefined ? {} : { request_id: requestId }) });
    }
    throw error;
  }
}

/** Google in the browser, then the new session. Only the phase crosses to the renderer; the sign-in URL never does. */
async function login(identity: string[], fallback: string): Promise<Result<AppStatus>> {
  const run = await cli(['login', ...identity, '--open-browser'], line => {
    for (const value of jsonLines(line)) {
      const phase = value as { phase?: unknown; browser_opened?: unknown };
      if (phase.phase === 'open-browser' || phase.phase === 'installed') {
        port.postMessage({ notice: 'signin.phase', payload: {
          phase: phase.phase,
          ...(typeof phase.browser_opened === 'boolean' ? { browser_opened: phase.browser_opened } : {}),
        } });
      }
    }
  });
  if (run.exit !== 0) return fail(failureView(lastJson(run.stderr), fallback, false));
  const current = await status();
  return current === null ? code('unavailable') : ok(current);
}

function audienceArgs(audience: Audience, projectId: string | undefined): string[] {
  const association = projectId === undefined ? [] : [option('association-project-ids-json', JSON.stringify([projectId]))];
  switch (audience.kind) {
    case 'only-me': return [option('audience', 'only-me'), ...association];
    case 'team': return [option('audience', 'team'), ...association];
    case 'project': return [option('audience', 'project'), option('audience-project-id', audience.project_id), ...association];
  }
}

function scopeArgs(scope: AskScope): string[] {
  return scope.kind === 'project' ? [option('project', scope.project_id)] : [];
}

/** Ten at a time, from where the last page ended. */
function page(cursor: string | undefined): string[] {
  return cursor === undefined ? ['--limit=10'] : ['--limit=10', option('cursor', cursor)];
}

/** A project, and the cursor of a page the host gave: anything else is refused before the client sees it. */
function pageable(projectId: unknown, cursor: unknown): boolean {
  return typeof projectId === 'string' && PROJECT_ID.test(projectId) && (cursor === undefined || (typeof cursor === 'string' && CURSOR.test(cursor)));
}

/** The command for one project change, or null for anything the page should not have sent. */
function changeArgs(change: ProjectChange | undefined, requestId: string, expect: Expect): string[] | null {
  if (!change || typeof change !== 'object' || typeof change.project_id !== 'string' || !PROJECT_ID.test(change.project_id)) return null;
  const common = [option('project-id', change.project_id), option('request-id', requestId)];
  switch (change.kind) {
    case 'member-add':
    case 'member-remove':
      if (typeof change.membership_id !== 'string' || !MEMBERSHIP_ID.test(change.membership_id)) return null;
      return ['projects', change.kind, ...common, option('membership-id', change.membership_id)];
    case 'member-set':
      if (typeof change.membership_id !== 'string' || !MEMBERSHIP_ID.test(change.membership_id) || !['lead', 'member'].includes(change.role)) return null;
      return ['projects', 'member-set', ...common, option('membership-id', change.membership_id), option('role', change.role)];
    case 'associate':
    case 'dissociate':
      if (typeof change.context_id !== 'string' || !CONTEXT_ID.test(change.context_id)) return null;
      return ['projects', change.kind, ...common, option('context-id', change.context_id)];
    case 'document-associate':
    case 'document-dissociate':
      if (typeof change.document_id !== 'string' || !DOCUMENT_ID.test(change.document_id)) return null;
      return ['documents', change.kind.slice('document-'.length), ...common, option('document-id', change.document_id), ...expected(expect)];
    default:
      return null;
  }
}

type Params<M extends HostMethodName> = HostMethods[M]['params'];

async function handle(method: HostMethodName, params: unknown): Promise<Result<unknown>> {
  switch (method) {
    case 'app.status': {
      const current = await status();
      return current === null ? code('unavailable') : ok(current);
    }
    case 'signin.begin': {
      const { authority_url } = params as Params<'signin.begin'>;
      return login([option('authority-url', authority_url)], 'signin_failed');
    }
    case 'signin.invitation': {
      // Main put the path here in place of the page's handle.
      const invitation = (params as { invitation?: unknown }).invitation;
      if (typeof invitation !== 'string') return code('invalid_request');
      return login([option('invitation', invitation)], 'invitation_failed');
    }
    case 'projects.list': {
      const { expect, cursor } = params as Params<'projects.list'>;
      return forAccount(method, expect, ['projects', 'list', '--limit=10', ...(cursor ? [option('cursor', cursor)] : [])],
        stdout => projectPageView(lastJson(stdout)));
    }
    case 'projects.feed': {
      const { expect, project_id, cursor } = params as Params<'projects.feed'>;
      if (!pageable(project_id, cursor)) return code('invalid_request');
      return forAccount(method, expect, ['projects', 'feed-v2', option('project-id', project_id), ...page(cursor)],
        stdout => feedView(lastJson(stdout), project_id));
    }
    case 'documents.list': {
      // No query: the project's documents, newest first.
      const { expect, project_id, cursor } = params as Params<'documents.list'>;
      if (!pageable(project_id, cursor)) return code('invalid_request');
      return forAccount(method, expect, ['documents', 'search-v2', option('project-id', project_id), ...page(cursor)],
        stdout => documentPageView(lastJson(stdout)));
    }
    case 'documents.read': {
      const { expect, document_id, project_id, cursor } = params as Params<'documents.read'>;
      if (typeof document_id !== 'string' || !DOCUMENT_ID.test(document_id)) return code('invalid_request');
      if (project_id !== undefined && (typeof project_id !== 'string' || !PROJECT_ID.test(project_id))) return code('invalid_request');
      if (cursor !== undefined && (typeof cursor !== 'string' || !CURSOR.test(cursor))) return code('invalid_request');
      return forAccount(method, expect, [
        'documents', 'read-v2', option('document-id', document_id), ...(project_id ? [option('project-id', project_id)] : []),
        ...(cursor ? [option('cursor', cursor)] : []),
      ], stdout => documentTextView(lastJson(stdout), document_id));
    }
    case 'documents.save': {
      // Main put the chosen file here in place of the page's handle.
      const { expect, document_id, project_id } = params as Params<'documents.save'>;
      const out = (params as { out?: unknown }).out;
      if (typeof out !== 'string' || typeof document_id !== 'string' || !DOCUMENT_ID.test(document_id)) return code('invalid_request');
      if (project_id !== undefined && (typeof project_id !== 'string' || !PROJECT_ID.test(project_id))) return code('invalid_request');
      return forAccount(method, expect, [
        'documents', 'download-v2', option('document-id', document_id), option('out', out),
        ...(project_id ? [option('project-id', project_id)] : []),
      ], stdout => savedOriginalView(lastJson(stdout), document_id));
    }
    case 'projects.read': {
      const { expect, project_id } = params as Params<'projects.read'>;
      if (typeof project_id !== 'string' || !PROJECT_ID.test(project_id)) return code('invalid_request');
      return forAccount(method, expect, ['projects', 'read', option('project-id', project_id)], stdout => projectView(lastJson(stdout), project_id));
    }
    case 'projects.members': {
      const { expect, project_id, cursor } = params as Params<'projects.members'>;
      if (!pageable(project_id, cursor)) return code('invalid_request');
      return forAccount(method, expect, ['projects', 'members', option('project-id', project_id), ...page(cursor)],
        stdout => membersView(lastJson(stdout), project_id));
    }
    case 'projects.directory': {
      const { expect, project_id, query, cursor } = params as Params<'projects.directory'>;
      if (!pageable(project_id, cursor)) return code('invalid_request');
      // No name: the first people the directory has.
      const name = typeof query === 'string' ? askText(query) : '';
      return forAccount(method, expect, [
        'projects', 'directory', option('project-id', project_id), ...(name === '' ? [] : [option('query', name)]), ...page(cursor),
      ], stdout => membersView(lastJson(stdout), project_id, true));
    }
    case 'projects.change': {
      const { expect, request_id, change } = params as Params<'projects.change'>;
      if (typeof request_id !== 'string' || !REQUEST_ID.test(request_id)) return code('invalid_request');
      const argv = changeArgs(change, request_id, expect);
      if (!argv) return code('invalid_request', true, request_id);
      return forAccount(method, expect, argv, stdout => changeView(lastJson(stdout), request_id, change), request_id);
    }
    case 'projects.create': {
      const { expect, request_id, name } = params as Params<'projects.create'>;
      if (typeof request_id !== 'string' || !REQUEST_ID.test(request_id)) return code('invalid_request');
      const title = projectName(name);
      if (title === null) return code('invalid_request', true, request_id);
      return forAccount(method, expect, ['projects', 'create', option('request-id', request_id), option('name', title)],
        stdout => createdView(lastJson(stdout), request_id), request_id);
    }
    case 'employees.list': {
      const { expect } = params as Params<'employees.list'>;
      return forAccount(method, expect, ['employee', 'list'], stdout => employeesView(lastJson(stdout)));
    }
    case 'employees.invite':
    case 'employees.reissue': {
      // Main put the invitation's file here, in the private folder it made, in place of the page's handle.
      const { expect, email } = params as Params<'employees.reissue'>;
      const name = (params as { name?: unknown }).name;
      const out = (params as { out?: unknown }).out;
      if (typeof out !== 'string' || !employeeText(email, 254) || (method === 'employees.invite' && !employeeText(name, 200))) {
        return code('invalid_request', true);
      }
      const who = method === 'employees.invite' ? ['invite', option('name', name as string)] : ['reissue'];
      return forAccount(method, expect, ['employee', ...who, option('email', email), option('out', out)],
        stdout => invitationView(lastJson(stdout), out));
    }
    case 'employees.revoke': {
      const { expect, email } = params as Params<'employees.revoke'>;
      if (!employeeText(email, 254)) return code('invalid_request', true);
      return forAccount(method, expect, ['employee', 'revoke', option('email', email)], stdout => revokedView(lastJson(stdout)));
    }
    case 'projects.readContext': {
      const { expect, project_id, context_id } = params as Params<'projects.readContext'>;
      return forAccount(method, expect, ['projects', 'read-context-v2', option('project-id', project_id), option('context-id', context_id)],
        stdout => contextView(lastJson(stdout)));
    }
    case 'notes.submit': {
      const { expect, request_id, text, audience, project_id } = params as Params<'notes.submit'>;
      const title = noteTitle(text);
      if (title === '' || Buffer.byteLength(text) > 8 * 1024) return code('invalid_request', true, request_id);
      // The client saves a file unchanged; write the exact text privately.
      const folder = mkdtempSync(join(tmpdir(), 'echo-note-'));
      const file = join(folder, 'note.txt');
      try {
        writeFileSync(file, text, { mode: 0o600 });
        return await forAccount(method, expect,
          ['updates', 'submit-v3', option('request-id', request_id), option('title', title), option('file', file), ...audienceArgs(audience, project_id)],
          stdout => receiptView(lastJson(stdout), request_id, audience), request_id);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    }
    case 'documents.upload': {
      const { expect, request_id, title, audience, project_id } = params as Params<'documents.upload'>;
      const file = (params as { file?: unknown }).file;
      const safeTitle = noteTitle(title);
      if (typeof file !== 'string' || safeTitle === '') return code('invalid_request', true, request_id);
      return forAccount(method, expect, [
        'documents', 'upload-v2', option('file', file), option('title', safeTitle), option('request-id', request_id),
        ...audienceArgs(audience, project_id), ...expected(expect),
      ], stdout => receiptView(unwrap(lastJson(stdout)), request_id, audience), request_id);
    }
    case 'documents.retry': {
      const { expect, request_id, audience } = params as Params<'documents.retry'>;
      return forAccount(method, expect, ['documents', 'retry', option('request-id', request_id), ...expected(expect)],
        stdout => receiptView(unwrap(lastJson(stdout)), request_id, audience), request_id);
    }
    case 'documents.abandon': {
      const { expect, request_id } = params as Params<'documents.abandon'>;
      if (typeof request_id !== 'string' || !REQUEST_ID.test(request_id)) return code('invalid_request');
      return forAccount(method, expect, ['documents', 'abandon', option('request-id', request_id), ...expected(expect)],
        stdout => abandonView(lastJson(stdout), request_id));
    }
    case 'ask.run': {
      const { expect, question, scope } = params as Params<'ask.run'>;
      const text = askText(question);
      if (text === '') return code('invalid_request');
      return forAccount(method, expect, ['ask', option('question', text), ...scopeArgs(scope)],
        stdout => answerView(lastJson(stdout), scope));
    }
    case 'ask.source': {
      const { expect, scope, ref } = params as Params<'ask.source'>;
      return forAccount(method, expect, [
        'ask-source', option('source-id', ref.source_id), option('revision-id', ref.revision_id),
        option('source-sha256', ref.source_sha256), option('representation-sha256', ref.representation_sha256),
        option('anchor-sha256', ref.anchor_sha256), ...(ref.document_id ? [option('document-id', ref.document_id)] : []), ...scopeArgs(scope),
      ], stdout => evidenceView(lastJson(stdout)));
    }
    case 'ask.record': {
      const { expect, record } = params as Params<'ask.record'>;
      if (!isRecordRef(record)) return code('invalid_request');
      const asked = { record_sha256: record.record_sha256, policy_id: record.policy_id };
      return forAccount(method, expect, ['records', option('record-sha256', asked.record_sha256)],
        stdout => recordView(lastJson(stdout), asked));
    }
    case 'search.run': {
      const { expect, query, scope } = params as Params<'search.run'>;
      const text = typeof query === 'string' ? searchQuery(query) : null;
      if (text === null) return code('invalid_request');
      const terms = [option('query', text), '--limit=10'];
      if (scope?.kind === 'project' && typeof scope.project_id === 'string') {
        return forAccount(method, expect, ['projects', 'search-v2', option('project-id', scope.project_id), ...terms],
          stdout => projectMatchesView(lastJson(stdout), scope.project_id));
      }
      if (scope?.kind !== 'global') return code('invalid_request');
      // All context: your saved notes, which the API searches one note
      // version at a time. Newer notes (V3) first, ten in all.
      const [newer, older] = await Promise.all([
        forAccount(method, expect, ['updates', 'search-v3', ...terms], stdout => noteMatchesView(lastJson(stdout), 3)),
        forAccount(method, expect, ['updates', 'search', ...terms], stdout => noteMatchesView(lastJson(stdout), 2)),
      ]);
      if (!newer.ok) return newer;
      if (!older.ok) return older;
      return ok({ items: [...newer.value, ...older.value].slice(0, 10) });
    }
    case 'search.read': {
      const { expect, context_id, source } = params as Params<'search.read'>;
      if (typeof context_id !== 'string' || !CONTEXT_ID.test(context_id) || (source !== 'v2' && source !== 'v3')) return code('invalid_request');
      return forAccount(method, expect, ['updates', source === 'v3' ? 'read-v3' : 'read', option('context-id', context_id)],
        stdout => noteView(lastJson(stdout), source === 'v3' ? 3 : 2, context_id));
    }
    case 'writes.status': {
      const { expect, request_id, kind } = params as Params<'writes.status'>;
      // Still in the client's hands (it outlived its timeout): not known yet.
      if (inFlight.has(request_id)) return ok({ state: 'unknown' as const });
      const argv = kind === 'note' ? ['updates', 'status-v3', option('request-id', request_id)] : ['documents', 'status-v2', option('request-id', request_id)];
      const result = await forAccount(method, expect, argv, stdout => writeStatusView(lastJson(stdout), kind));
      // Nothing stored under this request: it never arrived, so resending is safe.
      if (!result.ok && result.failure.code === 'not_found') return ok({ state: 'not_saved' as const });
      return result;
    }
    case 'account.tools': {
      const { expect } = params as Params<'account.tools'>;
      return forAccount(method, expect, ['tools'], stdout => toolsView(lastJson(stdout), expect.membership_id));
    }
    case 'account.signOut': {
      const { expect } = params as Params<'account.signOut'>;
      const before = await status();
      if (before === null) return code('unavailable');
      // Already signed out (a failed refresh does that) is what was asked.
      if (before.signed_in && !sameAccount(before, expect)) return code('account_changed');
      // The client removes the session even when the Authority cannot be
      // reached to end it there, so the status after is what counts.
      if (before.signed_in) await cli(['logout']);
      const after = await status();
      if (after === null) return code('unavailable');
      return after.signed_in ? code('signout_failed') : ok(after);
    }
  }
}

port.on('message', ({ data }) => {
  const request = data as HostRequest | { id: number; method: 'host.drain' };
  if (request.method === 'host.drain') {
    // Main is quitting: let a refresh in progress finish, so the session is not left claimed.
    void (async () => { while (exclusive) await exclusive; })().then(() => port.postMessage({ id: request.id, result: ok(null) }));
    return;
  }
  const requestId = typeof (request.params as { request_id?: unknown })?.request_id === 'string'
    ? (request.params as { request_id: string }).request_id : undefined;
  const write = WRITE_METHODS.has(request.method);
  // A call still queued behind a refresh when its time runs out never starts.
  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Result<unknown>>(resolve => {
    timer = setTimeout(() => { expired = true; resolve(code('timeout', write, requestId)); }, TIMEOUT_MS[request.method]);
  });
  // Sign-in still runs after a refresh with no answer: it replaces the
  // session, and sign-out ends it either way. Any other call was not made,
  // so no write went out.
  const refreshFailed = ['signin.begin', 'signin.invitation', 'account.signOut'].includes(request.method) ? undefined
    : (refresh: CliRun) => {
      const failure = failureView(lastJson(refresh.stderr), 'failed', false, requestId);
      return fail(write ? { ...failure, mutation_outcome: 'not_submitted' as const } : failure);
    };
  // Status goes through the gate too: mid-refresh the client reports signed out.
  const work = gated(() => expired ? timeout : handle(request.method, request.params), !LOCAL.has(request.method), refreshFailed)
    // A write that threw after reaching the client may have landed.
    .catch((error: unknown) => {
      if (__ECHO_TEST_HOOK__) console.error(`[client] ${request.method} threw:`, error);
      return write ? fail({ code: 'failed', retryable: true, mutation_outcome: 'unknown',
      ...(requestId === undefined ? {} : { request_id: requestId }) }) : code('failed');
    });
  void Promise.race([work, timeout])
    .then(result => { clearTimeout(timer); port.postMessage({ id: request.id, result }); });
});
