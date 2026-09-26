#!/usr/bin/env node
// Runs the packaged app with temporary state, and verifies its release fuses
// and provenance. An explicit executable also checks an installed Linux deb.
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

const root = resolve(import.meta.dirname, '..');
const defaults = {
  darwin: 'dist-app/mac-arm64/ECHO.app/Contents/MacOS/ECHO',
  linux: 'dist-app/linux-unpacked/echo-desktop',
};
const target = process.argv[2] ?? defaults[process.platform];
if (!target) throw new Error('Pass the packaged executable to smoke on this platform.');
const executable = resolve(root, target);
const wire = await getCurrentFuseWire(executable);
for (const option of ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments', 'GrantFileProtocolExtraPrivileges']) {
  if (wire[FuseV1Options[option]] !== FuseState.DISABLE) throw new Error(`Release fuse ${option} must be disabled`);
}
if (wire[FuseV1Options.OnlyLoadAppFromAsar] !== FuseState.ENABLE) throw new Error('OnlyLoadAppFromAsar must be enabled');

const options = { cwd: root, encoding: 'utf8', timeout: 60_000 };
const output = execFileSync(executable, ['--smoke'], options);
const result = JSON.parse(output.trim().split('\n').pop());
const expected = ['renderer_has_no_node', 'bridge_present', 'test_hook_absent', 'host_started', 'client_identity'];
const source = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
if (result.smoke !== 'passed' || !expected.every(check => result.checks?.[check] === true) ||
    result.build?.source_sha !== source || result.build?.dirty !== false) {
  throw new Error(`Packaged smoke failed: ${JSON.stringify(result)}`);
}
const debugging = spawnSync(executable, ['--remote-debugging-port=0', '--smoke'], options);
if (debugging.error || debugging.status !== 1) throw new Error('Release must refuse remote debugging');
console.log(JSON.stringify({ ...result, fuses: 'passed', remote_debugging: 'refused' }));
