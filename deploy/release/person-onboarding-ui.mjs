#!/usr/bin/env node

// The graphical installer receives safe state transitions, never CLI diagnostics.
import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const messages = Object.freeze({
  'invalid-request': 'Choose the invitation file your ECHO owner sent you.',
  'install-failed': 'ECHO could not finish installing. Try again with the approved download from your owner.',
  'status-failed': 'ECHO could not check the installed account. Close setup and try again.',
  'login-failed': 'Sign-in did not finish. Try your invitation again. If it has expired, ask your owner for a new one.',
  'browser-failed': 'Your browser could not open. Check your default browser, then try sign-in again.',
  'access-failed': 'ECHO could not verify your organization access. Check your connection or ask your owner to check your membership.',
  'logout-failed': 'ECHO could not finish signing out. Close setup and try again.',
});
const installReasons = Object.freeze({
  'existing-install-mismatch': 'An earlier ECHO install was left incomplete on this Mac. Ask your ECHO owner for the reset step, then run setup again.',
  'setup-in-progress': 'Another ECHO setup is already running. Close it, then open setup again.',
  'unsupported-mac': 'ECHO setup needs a Mac with Apple silicon. Ask your owner for the build for this Mac.',
  'download-damaged': 'This ECHO download is damaged or unsigned. Ask your owner for a fresh download.',
  'app-running': 'Quit ECHO, then try installation again.',
  'activation-failed': 'ECHO could not finish installing, so the previous version was restored. Try again.',
});
const failed = phase => ({ ok: false, phase, message: messages[phase] });
const parsed = text => { try { return JSON.parse(text); } catch { return undefined; } };
// Accept only an enumerated reason the bridge already knows. Installer prose,
// unknown reasons, and inherited property names all fall back to the generic
// message, so no installer diagnostic can reach the screen.
const failedInstall = stdout => {
  const lines = String(stdout).split('\n').filter(Boolean).slice(-10).reverse();
  for (const line of lines) {
    const event = parsed(line);
    if (event?.ok !== false || event.phase !== 'install-failed') continue;
    const reason = event.reason;
    if (typeof reason !== 'string' || !Object.hasOwn(installReasons, reason)) break;
    return { ok: false, phase: 'install-failed', reason, message: installReasons[reason] };
  }
  return failed('install-failed');
};
const httpsOrigin = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      !url.search && !url.hash && (url.pathname === '/' || url.pathname === '') ? url.origin : undefined;
  } catch { return undefined; }
};
const signedInStatus = value => {
  if (value?.schema_version !== 1 || value?.kind !== 'echo-person-client-status-v1' || value.signed_in !== true ||
      typeof value.display_name !== 'string' || !value.display_name.trim() || value.display_name.length > 200 ||
      /[\u0000-\u001f\u007f]/u.test(value.display_name)) return undefined;
  const authority = httpsOrigin(value.connected_authority);
  return authority ? { display_name: value.display_name, authority } : undefined;
};
const signedOutStatus = value => value?.schema_version === 1 && value?.kind === 'echo-person-client-status-v1' && value.signed_in === false;

export async function withPrivateInvitation(path, operation) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.uid !== process.getuid() || before.size > 64 * 1024) throw new Error('invalid invitation');
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const after = fstatSync(descriptor);
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('invitation changed');
    bytes = buffer.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'echo-person-setup-'));
  try {
    const privatePath = join(root, 'invitation.json');
    writeFileSync(privatePath, bytes, { mode: 0o600, flag: 'wx' });
    return await operation(privatePath);
  } finally {
    bytes.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
}

export function execute(command, args, { onLine, timeoutMs = 120_000 } = {}) {
  return new Promise(resolveResult => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.setEncoding('utf8');
    let stdout = '';
    let pending = '';
    let outputBytes = 0;
    let interrupted = false;
    let killTimer;
    const stop = () => {
      if (interrupted) return;
      interrupted = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }, 2_000);
      killTimer.unref();
    };
    const timer = setTimeout(stop, timeoutMs);
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    child.stdout.on('data', chunk => {
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > 4 * 1024 * 1024) { stop(); return; }
      if (interrupted) return;
      const text = chunk.toString('utf8');
      stdout += text;
      pending += text;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        if (onLine?.(pending.slice(0, newline)) === false) stop();
        pending = pending.slice(newline + 1);
      }
    });
    // Consume and bound stderr without retaining or forwarding private details.
    child.stderr.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 4 * 1024 * 1024) stop();
    });
    child.on('error', () => { interrupted = true; });
    child.on('close', code => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      if (!interrupted && pending) onLine?.(pending);
      resolveResult({ code: interrupted ? 1 : code ?? 1, stdout: interrupted ? '' : stdout });
    });
  });
}

export async function runOnboardingAction(action, value, {
  kitRoot = import.meta.dirname,
  home = homedir(),
  run = execute,
  withInvitation = withPrivateInvitation,
  emit = () => {},
} = {}) {
  if (!['prepare', 'status', 'start', 'login', 'continue', 'logout'].includes(action) ||
      (action === 'start' && (typeof value !== 'string' || !isAbsolute(value))) ||
      (action === 'login' && (typeof value !== 'string' || !httpsOrigin(value))) ||
      (!['start', 'login'].includes(action) && value !== undefined)) return failed('invalid-request');
  const installer = join(kitRoot, 'Start ECHO.command');
  const client = join(home, 'Library/Application Support/ECHO/bin/echo-brain');
  let failurePhase = 'install-failed';
  try {
    if (action === 'prepare' || action === 'status') {
      if (action === 'prepare') {
        emit({ ok: true, phase: 'installing' });
        const installed = await run('/bin/bash', [installer, '--install-only'], {});
        if (installed.code !== 0) return failedInstall(installed.stdout);
      }
      failurePhase = 'status-failed';
      const result = await run(client, ['person', 'status'], { timeoutMs: 10_000 });
      const status = parsed(result.stdout);
      if (result.code !== 0) return failed(failurePhase);
      if (signedOutStatus(status)) return { ok: true, phase: 'needs-invitation' };
      const signedIn = signedInStatus(status);
      if (!signedIn) return failed(failurePhase);
      return { ok: true, phase: 'signed-in', ...signedIn };
    }
    if (action === 'continue') {
      failurePhase = 'access-failed';
      emit({ ok: true, phase: 'checking-access' });
      const beforeResult = await run(client, ['person', 'status'], { timeoutMs: 10_000 });
      const before = beforeResult.code === 0 ? signedInStatus(parsed(beforeResult.stdout)) : undefined;
      if (!before) return failed(failurePhase);
      const result = await run(client, ['person', 'records', '--limit', '1'], { timeoutMs: 45_000 });
      const response = parsed(result.stdout);
      if (result.code !== 0 || response?.ok !== true || response.result?.schema_version !== 1 ||
          response.result?.kind !== 'echo-clean-person-record-list-v1' || !Array.isArray(response.result.records)) return failed(failurePhase);
      const statusResult = await run(client, ['person', 'status'], { timeoutMs: 10_000 });
      const after = statusResult.code === 0 ? signedInStatus(parsed(statusResult.stdout)) : undefined;
      if (!after || after.display_name !== before.display_name || after.authority !== before.authority) return failed(failurePhase);
      return { ok: true, phase: 'ready', authority: after.authority };
    }
    if (action === 'logout') {
      failurePhase = 'logout-failed';
      if ((await run(client, ['person', 'logout'], { timeoutMs: 45_000 })).code !== 0) return failed(failurePhase);
      const statusResult = await run(client, ['person', 'status'], { timeoutMs: 10_000 });
      if (statusResult.code !== 0 || !signedOutStatus(parsed(statusResult.stdout))) return failed(failurePhase);
      return { ok: true, phase: 'needs-invitation' };
    }
    failurePhase = 'login-failed';
    if (action === 'login') {
      const beforeResult = await run(client, ['person', 'status'], { timeoutMs: 10_000 });
      if (beforeResult.code !== 0 || !signedOutStatus(parsed(beforeResult.stdout))) return failed('status-failed');
      emit({ ok: true, phase: 'sign-in' });
      const result = await run(client, ['person', 'login', '--authority-url', httpsOrigin(value), '--open-browser'], { timeoutMs: 10 * 60_000 });
      if (result.code !== 0) return failed(failurePhase);
      const statusResult = await run(client, ['person', 'status'], { timeoutMs: 10_000 });
      const signedIn = statusResult.code === 0 ? signedInStatus(parsed(statusResult.stdout)) : undefined;
      if (!signedIn || signedIn.authority !== httpsOrigin(value)) return failed(failurePhase);
      return { ok: true, phase: 'signed-in', ...signedIn };
    }
    let ready = false;
    let browserFailed = false;
    emit({ ok: true, phase: 'sign-in' });
    const result = await withInvitation(value, privatePath => run(client, ['person', 'start', '--invitation', privatePath], {
      timeoutMs: 10 * 60_000,
      onLine: line => {
        const event = parsed(line);
        if (event?.ok === true && event.phase === 'open-browser' && event.browser_opened === false) {
          browserFailed = true;
          return false;
        }
        if (event?.ok === true && event.phase === 'open-browser') emit({ ok: true, phase: 'sign-in' });
        if (event?.ok === true && event.phase === 'ready' && event.permission_aware_read === 'passed') ready = true;
      },
    }));
    if (result.code !== 0 || !ready || browserFailed) return failed(browserFailed ? 'browser-failed' : failurePhase);
    const statusResult = await run(client, ['person', 'status'], { timeoutMs: 10_000 });
    const signedIn = statusResult.code === 0 ? signedInStatus(parsed(statusResult.stdout)) : undefined;
    return signedIn ? { ok: true, phase: 'ready', authority: signedIn.authority } : failed(failurePhase);
  } catch {
    return failed(failurePhase);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
  const [action, invitation, ...extra] = process.argv.slice(2);
  const result = extra.length ? failed('invalid-request') : await runOnboardingAction(action, invitation, { emit });
  emit(result);
  process.exitCode = result.ok ? 0 : 1;
}
