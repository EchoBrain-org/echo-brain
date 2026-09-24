// ECHO desktop main process: windows, tray, shortcuts and the IPC broker. It
// never reads the session or holds a token; the person host does that.
import {
  app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, protocol, session, shell,
  Tray, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
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
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

// ---- person host -----------------------------------------------------------

const clientEntry = process.env.ECHO_PERSON_CLIENT_ENTRY
  ?? resolve(BUILD, '..', '..', '..', 'src', 'product', 'person-client', 'dist', 'composition.js');
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
  if (__ECHO_TEST_HOOK__) {
    for (const name of ['ECHO_DESKTOP_TEST_FIXTURES', 'ECHO_DESKTOP_TEST_MODE']) if (test[name]) env[name] = test[name]!;
    if (test.ECHO_HOME) env.ECHO_HOME = test.ECHO_HOME;
  }
  const child = utilityProcess.fork(join(BUILD, 'host.mjs'), [], { serviceName: 'ECHO person host', env, stdio: 'pipe' });
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
  child.on('exit', () => {
    host = null;
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
    case 'drop.accept': {
      const vetted = vetDocument((params as MainMethods['drop.accept']['params']).path);
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
  }
  return refused();
}

ipcMain.handle('rpc', async (event, request: unknown): Promise<Result<unknown>> => {
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
});

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
      webSecurity: true, spellcheck: true, backgroundThrottling: false,
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
  tray = new Tray(trayImage());
  tray.setToolTip('ECHO');
  const menu = Menu.buildFromTemplate([
    { label: 'Open ECHO', accelerator: 'CommandOrControl+E', click: show },
    { label: 'Capture', accelerator: 'CommandOrControl+Shift+E', click: capture },
    { type: 'separator' },
    { label: 'Quit ECHO', role: 'quit' },
  ]);
  tray.setContextMenu(menu);
}

function registerShortcuts(): void {
  globalShortcut.register('CommandOrControl+E', toggle);
  globalShortcut.register('CommandOrControl+Shift+E', capture);
}

app.on('second-instance', (_event, argv) => {
  if (argv.includes('--capture')) capture(); else show();
});

app.on('did-resign-active', () => send('lifecycle.conceal', {}));
app.on('did-become-active', () => send('lifecycle.resume', {}));
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); host?.kill(); });
app.on('window-all-closed', () => { /* stays in the tray */ });

if (__ECHO_TEST_HOOK__) {
  // Playwright cannot press a global shortcut; it emits these instead.
  (app as unknown as NodeJS.EventEmitter).on('echo-test:capture', capture);
  (app as unknown as NodeJS.EventEmitter).on('echo-test:conceal', () => send('lifecycle.conceal', {}));
  (app as unknown as NodeJS.EventEmitter).on('echo-test:resume', () => send('lifecycle.resume', {}));
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
  startHost();
  window = createWindow();
  window.once('ready-to-show', () => { if (!test.ECHO_DESKTOP_HIDDEN) show(); });
  createTray();
  registerShortcuts();
});
