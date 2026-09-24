// The person host: an Electron utility process that runs the TypeScript person
// client in-process. It is the only process that reads the session or holds a
// token; what it posts back is a token-free view model or a failure code.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AppStatus, AskScope, Audience, Expect, Failure, HostMethods, HostMethodName, HostRequest, Result,
} from '../shared/protocol.js';
import { jsonLines, lastJson, runCli, type CliRun, type PersonCli } from './cli.js';
import {
  answerView, askText, contextView, evidenceView, failureView, feedView, noteTitle, projectPageView, receiptView, statusView,
  unwrap, ViewError, writeStatusView,
} from './views.js';

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}
const port = (process as unknown as { parentPort: ParentPort }).parentPort;

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
      // Main re-checks the URL before opening it; the renderer never sees it.
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
const modules = load();
modules.catch(error => { console.error('person host failed to load the client:', error); });

/** Per-method limits; the client enforces its own shorter network timeouts. */
const TIMEOUT_MS: Record<HostMethodName, number> = {
  'app.status': 5_000, 'signin.begin': 11 * 60_000, 'account.logout': 45_000, 'projects.list': 45_000,
  'projects.feed': 45_000, 'projects.readContext': 45_000, 'notes.submit': 45_000, 'documents.upload': 720_000,
  'ask.run': 145_000, 'ask.source': 15_000, 'writes.status': 45_000, 'documents.retry': 720_000,
};
const WRITES = new Set<HostMethodName>(['notes.submit', 'documents.upload', 'documents.retry']);

/** Values the page supplied go in `--name=value` form: a leading '-' stays text. */
function option(name: string, value: string): string { return `--${name}=${value}`; }
/** The client's own account binding for document writes. */
function expected(expect: Expect): string[] {
  return [option('expected-membership-id', expect.membership_id), option('expected-authority', expect.authority)];
}

// Refresh gate. Calls normally run side by side. When the access token is
// within a minute of expiring, one explicit refresh runs alone first, so a
// concurrent call never reads the session while it is being replaced.
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

async function gated<T>(run: () => Promise<T>): Promise<T> {
  const { store, now } = await modules;
  while (exclusive) await exclusive;
  if (refreshDue(store, now())) {
    let release!: () => void;
    exclusive = new Promise(resolve => { release = resolve; });
    try {
      while (active > 0) await new Promise<void>(resolve => idle.push(resolve));
      if (refreshDue(store, now())) await cli(['session-refresh']);
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
 * weekly deadline is left over from expiry: that one is signed out at once.
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

async function status(): Promise<AppStatus | null> {
  for (let attempt = 0; ; attempt += 1) {
    const current = await readStatus();
    if (current === null || current.signed_in || attempt >= 10 || !(await refreshRunningElsewhere())) return current;
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
  const write = WRITES.has(method);
  if (!sameAccount(await status(), expect)) return code('account_changed', write, requestId);
  const run = await cli(argv);
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

type Params<M extends HostMethodName> = HostMethods[M]['params'];

async function handle(method: HostMethodName, params: unknown): Promise<Result<unknown>> {
  switch (method) {
    case 'app.status': {
      const current = await status();
      return current === null ? code('unavailable') : ok(current);
    }
    case 'signin.begin': {
      const { authority_url } = params as Params<'signin.begin'>;
      const run = await cli(['login', option('authority-url', authority_url), '--open-browser'], line => {
        // Only the phase crosses to the renderer; the sign-in URL never does.
        for (const value of jsonLines(line)) {
          const phase = value as { phase?: unknown; expires_at?: unknown; browser_opened?: unknown };
          if (phase.phase === 'open-browser' || phase.phase === 'installed') {
            port.postMessage({ notice: 'signin.phase', payload: {
              phase: phase.phase,
              ...(typeof phase.expires_at === 'string' ? { expires_at: phase.expires_at } : {}),
              ...(typeof phase.browser_opened === 'boolean' ? { browser_opened: phase.browser_opened } : {}),
            } });
          }
        }
      });
      if (run.exit !== 0) return fail(failureView(lastJson(run.stderr), 'signin_failed', false));
      const current = await status();
      return current === null ? code('unavailable') : ok(current);
    }
    case 'account.logout': {
      const { expect } = params as Params<'account.logout'>;
      if (!sameAccount(await status(), expect)) return code('account_changed');
      const run = await cli(['logout']);
      if (run.exit !== 0) return fail(failureView(lastJson(run.stderr), 'failed', false));
      const current = await status();
      return current === null ? code('unavailable') : ok(current);
    }
    case 'projects.list': {
      const { expect, cursor } = params as Params<'projects.list'>;
      return forAccount(method, expect, ['projects', 'list', '--limit=10', ...(cursor ? [option('cursor', cursor)] : [])],
        stdout => projectPageView(lastJson(stdout)));
    }
    case 'projects.feed': {
      const { expect, project_id, cursor } = params as Params<'projects.feed'>;
      return forAccount(method, expect,
        ['projects', 'feed-v2', option('project-id', project_id), '--limit=10', ...(cursor ? [option('cursor', cursor)] : [])],
        stdout => feedView(lastJson(stdout)));
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
    case 'writes.status': {
      const { expect, request_id, kind } = params as Params<'writes.status'>;
      const argv = kind === 'note' ? ['updates', 'status-v3', option('request-id', request_id)] : ['documents', 'status-v2', option('request-id', request_id)];
      const result = await forAccount(method, expect, argv, stdout => writeStatusView(lastJson(stdout), kind));
      // Nothing stored under this request: it never arrived, so resending is safe.
      if (!result.ok && result.failure.code === 'not_found') return ok({ state: 'not_saved' as const });
      return result;
    }
  }
}

async function withTimeout(method: HostMethodName, run: Promise<Result<unknown>>, requestId?: string): Promise<Result<unknown>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Result<unknown>>(resolve => {
    timer = setTimeout(() => resolve(code('timeout', WRITES.has(method), requestId)), TIMEOUT_MS[method]);
  });
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

port.on('message', ({ data }) => {
  const request = data as HostRequest;
  const requestId = typeof (request.params as { request_id?: unknown })?.request_id === 'string'
    ? (request.params as { request_id: string }).request_id : undefined;
  // Status goes through the gate too: mid-refresh the client reports signed out.
  const work = gated(() => handle(request.method, request.params));
  void withTimeout(request.method, work, requestId)
    .catch(() => code('failed', WRITES.has(request.method), requestId))
    .then(result => port.postMessage({ id: request.id, result }));
});
