// ECHO desktop main process: windows, tray, shortcuts and the IPC broker. It
// never reads the session or holds a token; the person host does that.
import {
  app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, protocol, session, shell,
  Tray, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HOST_METHODS, MAIN_METHODS, MAX_PARAMS_BYTES, type EventName, type Events, type FileHandle, type HostMethodName,
  type HostNotice, type HostReply, type MainMethods, type Result,
} from '../shared/protocol.js';

const BUILD = __dirname;
const RENDERER_ROOT = join(BUILD, 'renderer');
const ORIGIN = 'app://echo';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'";
const DOCUMENT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.pdf', '.docx']);
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const test = __ECHO_TEST_HOOK__ ? process.env : {} as NodeJS.ProcessEnv;

if (__ECHO_TEST_HOOK__ && test.ECHO_DESKTOP_USER_DATA) app.setPath('userData', test.ECHO_DESKTOP_USER_DATA);
// Chromium's own data sits beside ECHO's, never among the kit's releases.
else if (app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'ECHO', 'chromium'));
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);

// Release builds: no fuse covers remote debugging, so refuse every form of it.
if (!__ECHO_TEST_HOOK__ && process.argv.some(argument => /^--remote-(debugging|allow-origins)/.test(argument))) {
  app.exit(1);
}
const smoke = process.argv.includes('--smoke');
if (!smoke && !app.requestSingleInstanceLock()) {
  app.exit(0);
}

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
/** A save whose outcome is unknown: quitting asks first. */
let unresolved = false;
const shortcutProblems: string[] = [];

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
const clientEntry = (__ECHO_TEST_HOOK__ && process.env.ECHO_PERSON_CLIENT_ENTRY) || (app.isPackaged
  ? join(process.resourcesPath, 'person-client', 'package', 'dist', 'composition.js')
  : resolve(BUILD, '..', '..', '..', 'src', 'product', 'person-client', 'dist', 'composition.js'));
let host: UtilityProcess | null = null;
let nextId = 1;
const pending = new Map<number, (result: Result<unknown>) => void>();

function startHost(): void {
  const env: Record<string, string> = { ECHO_PERSON_CLIENT_ENTRY: clientEntry, ECHO_HOME: homedir() };
  for (const name of ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LOCALAPPDATA', 'XDG_DATA_HOME',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'LANG']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // The fixture Authority writes a synthetic session: only ever into a home
  // the test named, never the person's own.
  if (__ECHO_TEST_HOOK__ && test.ECHO_HOME && resolve(test.ECHO_HOME) !== resolve(homedir())) {
    env.ECHO_HOME = test.ECHO_HOME;
    for (const name of ['ECHO_DESKTOP_TEST_FIXTURES', 'ECHO_DESKTOP_TEST_MODE']) if (test[name]) env[name] = test[name]!;
  }
  const child = utilityProcess.fork(HOST_PATH, [], { serviceName: 'ECHO person host', env, stdio: 'pipe' });
  if (__ECHO_TEST_HOOK__) {
    // Dev and test builds only: the host's own diagnostics, never shown in the UI.
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[host] ${chunk}`));
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[host] ${chunk}`));
  }
  child.on('message', (message: HostReply | HostNotice) => {
    if ('notice' in message) return onHostNotice(message);
    const resolveReply = pending.get(message.id);
    pending.delete(message.id);
    resolveReply?.(message.result);
  });
  child.on('exit', code => {
    host = null;
    log(`host exit ${code}`);
    for (const [id, resolveReply] of pending) {
      pending.delete(id);
      resolveReply({ ok: false, failure: { code: 'host_restarted', retryable: true } });
    }
    if (!quitting) {
      setTimeout(startHost, 500);
      send('host.restarted', {});
    }
  });
  host = child;
}

function callHost(method: HostMethodName, params: unknown): Promise<Result<unknown>> {
  if (!host) return Promise.resolve({ ok: false, failure: { code: 'host_restarted', retryable: true } });
  const id = nextId++;
  return new Promise(resolveReply => {
    pending.set(id, resolveReply);
    host!.postMessage({ id, method, params });
  });
}

function onHostNotice(message: HostNotice): void {
  if (message.notice === 'signin.phase') {
    send('signin.phase', message.payload as Events['signin.phase']);
  } else if (message.notice === 'open-external') {
    const raw = (message.payload as { url?: unknown }).url;
    try {
      const url = new URL(String(raw));
      if (url.protocol === 'https:' && url.username === '' && url.password === '') void shell.openExternal(url.href);
    } catch { /* not a URL: ignored */ }
  }
}

// ---- file handles (the renderer never sees a path) -------------------------

const handles = new Map<string, { path: string; expires: number }>();

function vetDocument(path: string): FileHandle | null {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path) || !DOCUMENT_EXTENSIONS.has(extname(path).toLowerCase())) return null;
  let stats;
  try { stats = lstatSync(path); } catch { return null; }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0 || stats.size > MAX_DOCUMENT_BYTES) return null;
  const handle = randomUUID();
  handles.set(handle, { path, expires: Date.now() + 10 * 60_000 });
  return { handle, name: path.split(sep).pop() ?? 'Document', size: stats.size };
}

/** A handle stays valid for 10 minutes, so an unconfirmed upload can be retried. */
function resolveHandle(handle: unknown): string | null {
  if (typeof handle !== 'string') return null;
  const entry = handles.get(handle);
  if (!entry || entry.expires <= Date.now()) { handles.delete(handle); return null; }
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
    case 'clipboard.writeText': {
      const text = (params as MainMethods['clipboard.writeText']['params']).text;
      if (typeof text !== 'string' || text.length > 12_000) return refused();
      clipboard.writeText(text);
      return { ok: true, value: null };
    }
    case 'window.hide':
      window?.hide();
      return { ok: true, value: null };
    case 'app.quit':
      app.quit();
      return { ok: true, value: null };
    case 'app.setUnresolved':
      unresolved = (params as MainMethods['app.setUnresolved']['params']).unresolved === true;
      return { ok: true, value: null };
  }
  return refused();
}

ipcMain.handle('rpc', async (event, request: unknown): Promise<Result<unknown>> => {
  const started = Date.now();
  const result = await broker(event, request);
  // Only names from the allowlists reach the log; anything else the page sent is '?'.
  const named = (request as { method?: unknown })?.method;
  const method = typeof named === 'string' && (hostMethods.has(named) || mainMethods.has(named)) ? named : '?';
  const requestId = (request as { params?: { request_id?: unknown } })?.params?.request_id;
  log(`${method} ${result.ok ? 'ok' : result.failure.code}` +
    `${typeof requestId === 'string' && /^[0-9a-f-]{36}$/.test(requestId) ? ` ${requestId}` : ''} ${Date.now() - started}ms`);
  return result;
});

// A dropped file's path comes only from the preload, which reads it off a real
// File the person dropped; the page's rpc can never name a path.
ipcMain.handle('drop', (event, path: unknown): Result<FileHandle> => {
  if (!trustedSender(event)) return refused('forbidden');
  const vetted = typeof path === 'string' ? vetDocument(path) : null;
  log(`drop ${vetted ? 'ok' : 'unsupported_file'}`);
  return vetted ? { ok: true, value: vetted } : refused('unsupported_file');
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
    const file = resolveHandle(fileHandle);
    if (!file) return refused('unsupported_file');
    return callHost(method, { ...rest, file });
  }
  return callHost(method as HostMethodName, value);
}

function send<N extends EventName>(name: N, payload: Events[N]): void {
  window?.webContents.send('event', { name, payload });
}

// ---- window, tray, shortcuts -----------------------------------------------

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 900, height: 680, minWidth: 720, minHeight: 560, show: false,
    title: 'ECHO', backgroundColor: '#242222',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(BUILD, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, spellcheck: true, backgroundThrottling: false, devTools: __ECHO_TEST_HOOK__,
    },
  });
  created.webContents.on('will-navigate', event => event.preventDefault());
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  created.on('close', event => {
    if (!quitting) { event.preventDefault(); created.hide(); }
  });
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
  // The compose layer is always mounted: ask it to open, then bring it forward.
  send('capture.open', {});
  show();
}

function trayImage(): Electron.NativeImage {
  const image = nativeImage.createFromPath(join(BUILD, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  if (process.platform === 'darwin') image.setTemplateImage(true);
  return image;
}

function createTray(): void {
  tray ??= new Tray(trayImage());
  tray.setToolTip('ECHO');
  const info = buildInfo();
  const menu = Menu.buildFromTemplate([
    { label: 'Open ECHO', accelerator: 'CommandOrControl+E', click: show },
    { label: 'Capture', accelerator: 'CommandOrControl+Shift+E', click: capture },
    ...shortcutProblems.map(problem => ({ label: problem, enabled: false })),
    { type: 'separator' },
    ...(info ? [{ label: `Build ${info.source_sha.slice(0, 7)}${info.dirty ? ' (modified)' : ''}`, enabled: false }] : []),
    { label: 'Quit ECHO', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
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

app.on('second-instance', (_event, argv) => {
  if (argv.includes('--capture')) capture(); else show();
});

app.on('did-resign-active', () => send('lifecycle.conceal', {}));
app.on('did-become-active', () => send('lifecycle.resume', {}));
app.on('before-quit', event => {
  if (unresolved && !quitting) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning', message: 'A note may not have been sent.',
      detail: 'Check or retry it before quitting, or quit anyway.', buttons: ['Quit Anyway', 'Cancel'], defaultId: 1, cancelId: 1,
    });
    if (choice !== 0) { event.preventDefault(); show(); return; }
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
  quitting = true;
  host?.kill();
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
  registerShortcuts();
  createTray();
  log('started');
});
