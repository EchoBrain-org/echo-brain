// The deb's maintainer scripts and AppArmor profile (ADR-0035): dpkg runs the
// scripts as root, and the update feed binds all three to the release commit.
// electron-builder's own templating must copy them unchanged, and the scripts
// run here with real bash against stand-in system commands.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const desktop = resolve(import.meta.dirname, '../..');
const linux = join(desktop, 'linux');
const require = createRequire(import.meta.url);
const config = require('../../electron-builder.config.cjs');
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function folder(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'echo-deb-scripts-')));
  folders.push(path);
  return path;
}

it('builds the deb with the reviewed files, which electron-builder copies byte for byte', async () => {
  expect(config.deb).toMatchObject({ afterInstall: 'linux/postinst', afterRemove: 'linux/postrm', appArmorProfile: 'linux/apparmor-profile' });
  expect({ depends: config.deb.depends, recommends: config.deb.recommends })
    .toEqual(JSON.parse(readFileSync(join(linux, 'deb-relationships.json'), 'utf8')));
  // electron-builder 26's FpmTarget renders all three through its template
  // macros before fpm packs them; run that step on the committed files.
  const { default: FpmTarget } = require('app-builder-lib/out/targets/FpmTarget');
  const temporary = folder();
  let count = 0;
  const packager = {
    config, projectDir: desktop, platformSpecificBuildOptions: config.linux, executableName: 'echo-desktop',
    appInfo: { sanitizedProductName: 'ECHO', productFilename: 'ECHO' },
    info: { tempDirManager: { getTempFile: async ({ suffix }: { suffix: string }) => join(temporary, `${count++}-${suffix}`) } },
  };
  const scripts = await new FpmTarget('deb', packager, null, temporary).scriptFiles;
  expect(readFileSync(scripts.afterInstall)).toEqual(readFileSync(join(linux, 'postinst')));
  expect(readFileSync(scripts.afterRemove)).toEqual(readFileSync(join(linux, 'postrm')));
  expect(readFileSync(scripts.appArmor)).toEqual(readFileSync(join(linux, 'apparmor-profile')));
});

describe('the maintainer scripts', () => {
  /** Runs a script with only stand-in commands on PATH, each recording its arguments. */
  function run(script: 'postinst' | 'postrm', argument: string): { status: number | null; calls: string[] } {
    const bin = folder();
    const log = join(bin, 'calls.log');
    writeFileSync(log, '');
    for (const command of ['update-alternatives', 'chmod', 'ln', 'rm', 'cp', 'readlink', 'update-mime-database', 'update-desktop-database', 'apparmor_parser']) {
      writeFileSync(join(bin, command), `#!/bin/bash\nprintf '%s\\n' "${command} $*" >> '${log}'\n`, { mode: 0o755 });
    }
    // AppArmor off, and no user namespaces, the case the template made setuid for.
    writeFileSync(join(bin, 'apparmor_status'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'unshare'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
    const result = spawnSync('/bin/bash', [join(linux, script), argument], { env: { PATH: bin }, encoding: 'utf8' });
    return { status: result.status, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  }

  it('installs the alternative and never makes chrome-sandbox setuid', () => {
    const { status, calls } = run('postinst', 'configure');
    expect(status).toBe(0);
    expect(calls).toContain("update-alternatives --install /usr/bin/echo-desktop echo-desktop /opt/ECHO/echo-desktop 100");
    expect(calls).toContain('chmod 0755 /opt/ECHO/chrome-sandbox');
    expect(calls.filter(call => call.startsWith('chmod '))).toEqual(['chmod 0755 /opt/ECHO/chrome-sandbox']);
  });

  it('removes the alternative when the package is removed', () => {
    const { status, calls } = run('postrm', 'remove');
    expect(status).toBe(0);
    expect(calls).toContain('update-alternatives --remove echo-desktop /opt/ECHO/echo-desktop');
  });

  // dpkg runs the old postrm with "upgrade" before the new postinst on every
  // update and on apt's reinstall; the profile and alternative must stay.
  it.each(['upgrade', 'failed-upgrade', 'abort-install', 'abort-upgrade', 'purge'])('leaves everything in place on %s', (argument) => {
    expect(run('postrm', argument)).toEqual({ status: 0, calls: [] });
  });
});
