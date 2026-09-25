// ECHO desktop main process: windows, tray, shortcuts and the IPC broker. It
// never reads the session or holds a token; the person host does that.
import {
  app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, protocol, session, shell,
  Tray, utilityProcess, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type UtilityProcess,
} from 'electron';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  externalUrl, HOST_METHODS, MAIN_METHODS, MAX_PARAMS_BYTES, STATUS_METHODS, WRITE_METHODS, type AccountCommand, type AppStatus,
  type EventName, type Events, type FileHandle, type HostMethodName, type HostNotice, type HostReply, type MainMethods, type Result,
} from '../shared/protocol.js';

const BUILD = __dirname;
const RENDERER_ROOT = join(BUILD, 'renderer');
const ORIGIN = 'app://echo';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'";
const DOCUMENT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.pdf', '.docx']);
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
/** What an owner's invitation export holds; the person client checks the rest. */
const INVITATION_FILE = 'person-invitation.json';
const MAX_INVITATION_BYTES = 8 * 1024;
const test = __ECHO_TEST_HOOK__ ? process.env : {} as NodeJS.ProcessEnv;
const smoke = process.argv.includes('--smoke');
/** `--smoke` never touches the person's session or data: it gets its own. */
if (smoke) {
  // Chromium writes its preferences while exiting, after smoke cleans up; sweep earlier runs.
  try {
    for (const name of readdirSync(tmpdir())) if (name.startsWith('echo-smoke-')) rmSync(join(tmpdir(), name), { recursive: true, force: true });
  } catch { /* best effort */ }
}
const smokeRoot = smoke ? realpathSync(mkdtempSync(join(tmpdir(), 'echo-smoke-'))) : null;

if (smokeRoot) app.setPath('userData', join(smokeRoot, 'data'));
else if (__ECHO_TEST_HOOK__ && test.ECHO_DESKTOP_USER_DATA) app.setPath('userData', test.ECHO_DESKTOP_USER_DATA);
// Chromium's own data sits beside ECHO's, never among the kit's releases.
else if (app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'ECHO', 'chromium'));
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);

// Release builds: no fuse covers remote debugging, so refuse every form of it.
if (!__ECHO_TEST_HOOK__ && process.argv.some(argument => /^--remote-(debugging|allow-origins)/.test(argument))) {
  app.exit(1);
}
// Dev builds never run on the person's real session: they need a named home.
if (__ECHO_TEST_HOOK__ && !smoke && !test.ECHO_HOME) {
  process.stderr.write('Dev builds need ECHO_HOME. Use `npm start` for fixture data, or set ECHO_HOME to a private folder.\n');
  app.exit(1);
}
if (!smoke && !app.requestSingleInstanceLock()) {
  app.exit(0);
}

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
/** A save whose outcome is unknown, a note or a file: quitting asks first. */
let unresolved: 'note' | 'file' | null = null;
const shortcutProblems: string[] = [];
/** The last account status the host reported, for the Account menu. Main reads no session itself. */
let accountStatus: AppStatus | null = null;
/** Sign-ins waiting on the browser. */
let signingIn = 0;

// ---- diagnostic log: codes only, never content, tokens or paths ------------

function log(line: string): void {
  try {
    const folder = join(app.getPath('userData'), 'logs');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = join(folder, 'desktop.log');
    if (existsSync(file) && statSync(file).size > 1024 * 1024) renameSync(file, `${file}.1`);
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch { /* logging never breaks the app */ }
}

interface BuildInfo { source_sha: string; dirty: boolean }
function buildInfo(): BuildInfo | null {
  try { return JSON.parse(readFileSync(join(BUILD, 'build-info.json'), 'utf8')) as BuildInfo; } catch { return null; }
}

// ---- person host -----------------------------------------------------------

// A packaged app ships the person client exactly as packed, beside the host,
// and never takes a code path from the environment.
const HOST_PATH = app.isPackaged ? join(process.resourcesPath, 'host.mjs') : join(BUILD, 'host.mjs');
const clientEntry = app.isPackaged
  ? join(process.resourcesPath, 'person-client', 'package', 'dist', 'composition.js')
  : resolve(BUILD, '..', '..', '..', 'src', 'product', 'person-client', 'dist', 'composition.js');
let host: UtilityProcess | null = null;
let nextId = 1;
const pending = new Map<number, { method: string; requestId?: string; resolve: (result: Result<unknown>) => void }>();
/** Exits in the last minute. Three and the supervisor stops. */
let exits: number[] = [];
let hostGaveUp = false;
/** Test builds: the host runs the fixture Authority, whose fake browser stands in for a real one. */
let fixtureHost = false;

function startHost(restarted = false): void {
  const home = smokeRoot ? join(smokeRoot, 'home') : homedir();
  if (smokeRoot) mkdirSync(home, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = { ECHO_PERSON_CLIENT_ENTRY: clientEntry, ECHO_HOME: home };
  for (const name of ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LOCALAPPDATA', 'XDG_DATA_HOME',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'LANG']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // The fixture Authority writes a synthetic session: only ever into a home
  // the test named, never the person's own.
  if (__ECHO_TEST_HOOK__ && !smokeRoot && test.ECHO_HOME && resolve(test.ECHO_HOME) !== resolve(homedir())) {
    env.ECHO_HOME = test.ECHO_HOME;
    for (const name of ['ECHO_DESKTOP_TEST_FIXTURES', 'ECHO_DESKTOP_TEST_MODE']) if (test[name]) env[name] = test[name]!;
    fixtureHost = Boolean(env.ECHO_DESKTOP_TEST_FIXTURES);
  }
  // Dev builds reach the local Authority, whose certificate is the kit's own.
  if (__ECHO_TEST_HOOK__ && test.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = test.NODE_EXTRA_CA_CERTS;
  const child = utilityProcess.fork(HOST_PATH, [], { serviceName: 'ECHO person host', env, stdio: 'pipe' });
  if (__ECHO_TEST_HOOK__) {
    // Dev and test builds only: the host's own diagnostics, never shown in the UI.
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[host] ${chunk}`));
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[host] ${chunk}`));
  }
  child.on('message', (message: HostReply | HostNotice) => {
    if ('notice' in message) return onHostNotice(message);
    const call = pending.get(message.id);
    pending.delete(message.id);
    call?.resolve(message.result);
  });
  child.on('exit', code => {
    if (host === child) host = null;
    log(`host exit ${code}`);
    for (const [id, call] of pending) {
      pending.delete(id);
      // A write the host was holding may already have reached the Authority.
      call.resolve({ ok: false, failure: { code: 'host_restarted', retryable: true,
        ...(WRITE_METHODS.has(call.method) ? { mutation_outcome: 'unknown' as const } : {}),
        ...(call.requestId === undefined ? {} : { request_id: call.requestId }) } });
    }
    if (quitting) return;
    const now = Date.now();
    exits = [...exits.filter(at => now - at < 60_000), now];
    if (exits.length >= 3) {
      hostGaveUp = true;
      log('host gave-up');
      send('host.failed', {});
      return;
    }
    setTimeout(() => startHost(true), 500 * 2 ** (exits.length - 1));
  });
  host = child;
  // Tell the page once the new host can answer, so its re-check is not refused.
  if (restarted) send('host.restarted', {});
}

function callHost(method: HostMethodName | 'host.drain', params: unknown): Promise<Result<unknown>> {
  if (!host) return Promise.resolve({ ok: false, failure: { code: hostGaveUp ? 'host_failed' : 'host_restarted', retryable: true } });
  const id = nextId++;
  const requestId = (params as { request_id?: unknown } | null)?.request_id;
  return new Promise(resolveReply => {
    pending.set(id, { method, resolve: resolveReply, ...(typeof requestId === 'string' ? { requestId } : {}) });
    host!.postMessage({ id, method, params });
  });
}

function onHostNotice(message: HostNotice): void {
  if (message.notice === 'signin.phase') {
    send('signin.phase', message.payload as Events['signin.phase']);
  } else if (message.notice === 'open-external') {
    // The fixture Authority brings its own browser: tests never open a real one.
    // Only a host that runs it: any other host's sign-in needs this browser.
    if (__ECHO_TEST_HOOK__ && fixtureHost) return;
    const url = externalUrl((message.payload as { url?: unknown }).url);
    if (url) void shell.openExternal(url);
  }
}

// ---- file handles (the renderer never sees a path) -------------------------

type HandleKind = 'document' | 'invitation';
const handles = new Map<string, { path: string; kind: HandleKind; expires: number }>();

function issueHandle(path: string, kind: HandleKind, size?: number): FileHandle {
  const handle = randomUUID();
  handles.set(handle, { path, kind, expires: Date.now() + 10 * 60_000 });
  return { handle, name: path.split(sep).pop() ?? 'Document', ...(size === undefined ? {} : { size }) };
}

function vetDocument(path: string): FileHandle | null {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path) || !DOCUMENT_EXTENSIONS.has(extname(path).toLowerCase())) return null;
  let stats;
  try { stats = lstatSync(path); } catch { return null; }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0 || stats.size > MAX_DOCUMENT_BYTES) return null;
  return issueHandle(path, 'document', stats.size);
}

/** The folder the owner sent, or the file in it. Never a link. */
function vetInvitation(chosen: string): FileHandle | null {
  if (typeof chosen !== 'string' || !isAbsolute(chosen)) return null;
  try {
    const path = lstatSync(chosen).isDirectory() ? join(chosen, INVITATION_FILE) : chosen;
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_INVITATION_BYTES || extname(path).toLowerCase() !== '.json') return null;
    return issueHandle(path, 'invitation');
  } catch {
    return null;
  }
}

/** A handle stays valid for 10 minutes, so an unconfirmed upload can be retried. It names one kind of file. */
function resolveHandle(handle: unknown, kind: HandleKind): string | null {
  if (typeof handle !== 'string') return null;
  const entry = handles.get(handle);
  if (!entry || entry.kind !== kind) return null;
  if (entry.expires <= Date.now()) { handles.delete(handle); return null; }
  return entry.path;
}

// ---- broker ----------------------------------------------------------------

const hostMethods = new Set<string>(HOST_METHODS);
const mainMethods = new Set<string>(MAIN_METHODS);

function refused(code = 'invalid_request'): Result<never> {
  return { ok: false, failure: { code, retryable: false } };
}

function trustedSender(event: IpcMainInvokeEvent): boolean {
  return window !== null && event.sender === window.webContents && event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith(`${ORIGIN}/`);
}

async function mainMethod<M extends keyof MainMethods>(method: M, params: MainMethods[M]['params']): Promise<Result<unknown>> {
  switch (method) {
    case 'dialog.openDocument': {
      if (!window) return refused();
      const chosen = await dialog.showOpenDialog(window, {
        properties: ['openFile'], filters: [{ name: 'Documents', extensions: ['txt', 'md', 'pdf', 'docx'] }],
      });
      if (chosen.canceled || chosen.filePaths.length !== 1) return { ok: true, value: null };
      const vetted = vetDocument(chosen.filePaths[0]!);
      return vetted ? { ok: true, value: vetted } : refused('unsupported_file');
    }
    case 'dialog.openInvitation': {
      if (!window) return refused();
      // macOS chooses the folder or the file in it; elsewhere a dialog is one or the other.
      const chosen = await dialog.showOpenDialog(window, {
        title: 'Choose your ECHO invitation', message: 'Choose the invitation folder your organization owner sent you.',
        properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
        filters: [{ name: 'ECHO invitation', extensions: ['json'] }],
      });
      if (chosen.canceled || chosen.filePaths.length !== 1) return { ok: true, value: null };
      const vetted = vetInvitation(chosen.filePaths[0]!);
      return vetted ? { ok: true, value: vetted } : refused('unsupported_invitation');
    }
    case 'app.setUnresolved': {
      const { unresolved: open, file } = params as MainMethods['app.setUnresolved']['params'];
      unresolved = open === true ? (file === true ? 'file' : 'note') : null;
      return { ok: true, value: null };
    }
    case 'app.retryHost':
      if (hostGaveUp && !host) { hostGaveUp = false; exits = []; startHost(true); }
      return { ok: true, value: null };
    case 'menu.account': {
      const { x, y } = params as MainMethods['menu.account']['params'];
      const inside = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10_000;
      if (!window || !inside(x) || !inside(y)) return refused();
      popupAccountMenu(x, y);
      return { ok: true, value: null };
    }
  }
  return refused();
}

ipcMain.handle('rpc', async (event, request: unknown): Promise<Result<unknown>> => {
  const started = Date.now();
  const result = await broker(event, request);
  // Only names from the allowlists reach the log; anything else the page sent is '?'.
  const named = (request as { method?: unknown })?.method;
  const method = typeof named === 'string' && (hostMethods.has(named) || mainMethods.has(named)) ? named : '?';
  if (result.ok && STATUS_METHODS.has(method)) accountChanged(result.value as AppStatus);
  const requestId = (request as { params?: { request_id?: unknown } })?.params?.request_id;
  log(`${method} ${result.ok ? 'ok' : result.failure.code}` +
    `${typeof requestId === 'string' && /^[0-9a-f-]{36}$/.test(requestId) ? ` ${requestId}` : ''} ${Date.now() - started}ms`);
  return result;
});

async function broker(event: IpcMainInvokeEvent, request: unknown): Promise<Result<unknown>> {
  if (!trustedSender(event)) return refused('forbidden');
  if (request === null || typeof request !== 'object') return refused();
  const { method, params } = request as { method?: unknown; params?: unknown };
  if (typeof method !== 'string') return refused();
  const value = params ?? {};
  if (typeof value !== 'object' || JSON.stringify(value).length > MAX_PARAMS_BYTES) return refused();
  if (mainMethods.has(method)) return mainMethod(method as keyof MainMethods, value as never);
  if (!hostMethods.has(method)) return refused();
  if (method === 'documents.upload') {
    const { file_handle: fileHandle, ...rest } = value as { file_handle?: unknown };
    const file = resolveHandle(fileHandle, 'document');
    if (!file) return refused('unsupported_file');
    return callHost(method, { ...rest, file });
  }
  if (method === 'signin.invitation') {
    const handle = (value as { invitation_handle?: unknown }).invitation_handle;
    const invitation = resolveHandle(handle, 'invitation');
    if (!invitation) return refused('unsupported_invitation');
    handles.delete(handle as string); // one sign-in per choice
    return whileSigningIn(() => callHost(method, { invitation }));
  }
  if (method === 'signin.begin') return whileSigningIn(() => callHost(method, value));
  return callHost(method as HostMethodName, value);
}

async function whileSigningIn(run: () => Promise<Result<unknown>>): Promise<Result<unknown>> {
  signingIn += 1;
  updateTray();
  try {
    return await run();
  } finally {
    signingIn -= 1;
    updateTray();
  }
}

function send<N extends EventName>(name: N, payload: Events[N]): void {
  window?.webContents.send('event', { name, payload });
}

// ---- window, tray, shortcuts -----------------------------------------------

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 900, height: 680, minWidth: 800, minHeight: 560, show: false,
    title: 'ECHO', backgroundColor: '#242222',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(BUILD, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, spellcheck: true, backgroundThrottling: false, devTools: __ECHO_TEST_HOOK__,
    },
  });
  created.webContents.on('will-navigate', event => event.preventDefault());
  // A crashed page comes back; mounting it re-reads status.
  created.webContents.on('render-process-gone', (_event, details) => {
    log(`renderer gone ${details.reason}`);
    if (!quitting && !created.isDestroyed()) void created.loadURL(`${ORIGIN}/index.html`);
  });
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  created.on('close', event => {
    if (!quitting) { event.preventDefault(); created.hide(); }
  });
  // Quitting closes the window before macOS stops reporting app events.
  created.on('closed', () => { if (window === created) window = null; });
  created.on('blur', () => {
    if (process.platform === 'darwin') return;
    setTimeout(() => { if (!BrowserWindow.getFocusedWindow()) send('lifecycle.conceal', {}); }, 150);
  });
  created.on('focus', () => { if (process.platform !== 'darwin') send('lifecycle.resume', {}); });
  void created.loadURL(`${ORIGIN}/index.html`);
  return created;
}

function show(): void {
  if (!window) return;
  window.show();
  window.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
  send('window.shown', {});
}

function toggle(): void {
  if (window?.isVisible() && window.isFocused()) window.hide();
  else show();
}

function capture(): void {
  // The page stays loaded while hidden: ask it to open compose, then bring it forward.
  send('capture.open', {});
  show();
}

function trayImage(): Electron.NativeImage {
  const image = nativeImage.createFromPath(join(BUILD, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  if (process.platform === 'darwin') image.setTemplateImage(true);
  return image;
}

// ---- the Account menu: in the tray, and popped up from the window ----------

/** Test builds: a test cannot click a native menu, so it reads and clicks these. */
interface TestMenus { echoTestAccountMenu?: Electron.Menu; echoTestTrayMenu?: Electron.Menu }

/** The window does the work: it confirms what cannot be undone, and asks the host. */
function accountCommand(command: AccountCommand, fromTray: boolean): void {
  send('account.command', { command });
  if (fromTray) show();
}

function accountItems(fromTray: boolean): MenuItemConstructorOptions[] {
  const run = (command: AccountCommand) => () => accountCommand(command, fromTray);
  if (signingIn > 0) return [{ label: 'Finish signing in in your browser.', enabled: false }];
  const account = accountStatus?.account ?? null;
  if (account) {
    return [
      { label: `Signed in as ${account.display_name} · ${account.role}`, enabled: false },
      { label: `Organization: ${account.authority}`, enabled: false },
      { label: `ECHO ${accountStatus!.client_version}`, enabled: false },
      { type: 'separator' },
      { label: 'Switch account…', click: run('switch') },
      { label: 'Sign out…', click: run('signout') },
      { label: 'Connected tools…', click: run('tools') },
    ];
  }
  // Signing in is offered only once the host has said no one is signed in.
  if (!accountStatus) return [{ label: 'Account status unavailable', enabled: false }];
  return [
    { label: 'Not signed in', enabled: false },
    { type: 'separator' },
    { label: 'Sign in with Google…', click: run('signin') },
    { label: 'Open invitation…', click: run('invitation') },
  ];
}

function popupAccountMenu(x: number, y: number): void {
  const menu = Menu.buildFromTemplate(accountItems(false));
  if (__ECHO_TEST_HOOK__ && test.ECHO_DESKTOP_HIDDEN) { (globalThis as TestMenus).echoTestAccountMenu = menu; return; }
  menu.popup({ window: window!, x, y });
}

let trayShown = '';
function accountChanged(next: AppStatus): void {
  accountStatus = next;
  updateTray();
}

function updateTray(): void {
  tray ??= new Tray(trayImage());
  // Rebuilt only when what it shows changes: status is read every time the window comes forward.
  const shown = JSON.stringify([accountStatus, signingIn > 0, shortcutProblems]);
  if (shown === trayShown) return;
  trayShown = shown;
  tray.setToolTip('ECHO');
  const info = buildInfo();
  const menu = Menu.buildFromTemplate([
    { label: 'Open ECHO', accelerator: 'CommandOrControl+E', click: show },
    { label: 'Capture', accelerator: 'CommandOrControl+Shift+E', click: capture },
    ...shortcutProblems.map(problem => ({ label: problem, enabled: false })),
    { label: 'Account', submenu: accountItems(true) },
    { type: 'separator' },
    ...(info ? [{ label: `Build ${info.source_sha.slice(0, 7)}${info.dirty ? ' (modified)' : ''}`, enabled: false }] : []),
    { label: 'Quit ECHO', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  if (__ECHO_TEST_HOOK__) (globalThis as TestMenus).echoTestTrayMenu = menu;
}

function registerShortcuts(): void {
  for (const [accelerator, label, run] of [
    ['CommandOrControl+E', process.platform === 'darwin' ? '⌘E' : 'Ctrl+E', toggle],
    ['CommandOrControl+Shift+E', process.platform === 'darwin' ? '⌘⇧E' : 'Ctrl+Shift+E', capture],
  ] as const) {
    if (!globalShortcut.register(accelerator, run) || !globalShortcut.isRegistered(accelerator)) {
      shortcutProblems.push(`${label} is used by another app`);
    }
  }
}

/** macOS needs an Edit menu for copy, paste and undo, even with no menu bar. */
function applicationMenu(): void {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
}

app.on('second-instance', show);

app.on('did-resign-active', () => send('lifecycle.conceal', {}));
app.on('did-become-active', () => send('lifecycle.resume', {}));
let drained = false;
app.on('before-quit', event => {
  // Never kill the host mid-refresh: that leaves the shared session claimed.
  // Wait here, while the window is open: once it closes the app must exit at
  // once, or a late macOS notice to the closed window throws, and Electron's
  // error box can hold the quit open for good.
  if (host && !drained) {
    event.preventDefault();
    drained = true;
    const cap = new Promise(resolveCap => setTimeout(resolveCap, 5_000));
    void Promise.race([callHost('host.drain', {}), cap]).then(() => app.quit());
    return;
  }
  // Asked after the wait: the page stays usable during it and may start a save.
  if (unresolved && !quitting) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning', message: `A ${unresolved} may not have been sent.`,
      detail: 'Check or retry it before quitting, or quit anyway.', buttons: ['Quit Anyway', 'Cancel'], defaultId: 1, cancelId: 1,
    });
    if (choice !== 0) { event.preventDefault(); drained = false; show(); return; }
  }
  quitting = true;
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); host?.kill(); });
app.on('window-all-closed', () => { /* stays in the tray */ });

if (__ECHO_TEST_HOOK__) {
  // Playwright cannot press a global shortcut; it emits these instead.
  (app as unknown as NodeJS.EventEmitter).on('echo-test:capture', capture);
  (app as unknown as NodeJS.EventEmitter).on('echo-test:conceal', () => send('lifecycle.conceal', {}));
  (app as unknown as NodeJS.EventEmitter).on('echo-test:resume', () => send('lifecycle.resume', {}));
  (app as unknown as NodeJS.EventEmitter).on('echo-test:kill-host', () => { host?.kill(); });
  // What show() tells the page, without putting a window on the test machine's screen.
  (app as unknown as NodeJS.EventEmitter).on('echo-test:shown', () => send('window.shown', {}));
}

/**
 * `--smoke`: prove a packaged build is sound without showing anything. The
 * renderer is locked down, the test hook is absent, the host starts and the
 * person client reports its build identity.
 */
async function runSmoke(): Promise<void> {
  const checks: Record<string, boolean> = {};
  // Load the real page hidden and look from inside it: no Node, only the bridge.
  const probe = createWindow();
  await new Promise<void>(resolveLoad => probe.webContents.once('did-finish-load', () => resolveLoad()));
  const inside = await probe.webContents.executeJavaScript(
    '({ node: typeof require !== "undefined" || typeof process !== "undefined", bridge: typeof window.echo === "object" })',
  ) as { node: boolean; bridge: boolean };
  checks.renderer_has_no_node = !inside.node;
  checks.bridge_present = inside.bridge;
  checks.test_hook_absent = !__ECHO_TEST_HOOK__;
  quitting = true;
  probe.destroy();
  startHost();
  const status = await callHost('app.status', {});
  checks.host_started = status.ok || status.failure.code !== 'host_restarted';
  checks.client_identity = status.ok && typeof (status.value as { client_version?: unknown }).client_version === 'string';
  const passed = Object.values(checks).every(Boolean);
  process.stdout.write(`${JSON.stringify({ smoke: passed ? 'passed' : 'failed', checks, build: buildInfo() })}\n`);
  host?.kill();
  try { rmSync(smokeRoot!, { recursive: true, force: true }); } catch { /* temporary */ }
  app.exit(passed ? 0 : 1);
}

void app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle('app', async request => {
    const url = new URL(request.url);
    const target = resolve(RENDERER_ROOT, `.${decodeURIComponent(url.pathname)}`);
    if (url.host !== 'echo' || !target.startsWith(`${RENDERER_ROOT}${sep}`) ||
        !['.html', '.js', '.css', '.map'].includes(extname(target))) {
      return new Response('Not found', { status: 404 });
    }
    const file = await net.fetch(pathToFileURL(target).href);
    const headers = new Headers(file.headers);
    headers.set('content-security-policy', CSP);
    return new Response(file.body, { status: file.status, headers });
  });
  applicationMenu();
  if (smoke) return void runSmoke();
  startHost();
  window = createWindow();
  window.once('ready-to-show', () => { if (!test.ECHO_DESKTOP_HIDDEN) show(); });
  // Tests never take the person's own keys.
  if (!test.ECHO_DESKTOP_HIDDEN) registerShortcuts();
  updateTray();
  log('started');
});
