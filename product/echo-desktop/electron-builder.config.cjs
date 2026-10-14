// macOS arm64 zip and Linux x64 deb/tar.gz. Both carry the same client and
// release fuses. macOS is re-signed after flipping its fuses.
const { execFileSync } = require('node:child_process');
const { chmodSync, existsSync } = require('node:fs');
const { join } = require('node:path');

// Only release packaging writes the desktop identity (ADR-0035). A package
// without it has no updater.
const identity = 'echo-desktop-identity.v1.json';
const helper = 'echo-desktop-update-helper';
const debRelationships = require('./linux/deb-relationships.json');

module.exports = {
  appId: 'org.echobrain.echo-desktop',
  productName: 'ECHO',
  directories: { output: 'dist-app' },
  files: [
    'package.json',
    'build/main.cjs', 'build/preload.cjs', 'build/renderer/**', 'build/build-info.json', 'build/tray.png', 'build/trayTemplate.png',
  ],
  extraResources: [
    { from: 'build/host.mjs', to: 'host.mjs' },
    { from: 'build/person-client', to: 'person-client' },
    ...(existsSync(join(__dirname, 'build', identity)) ? [{ from: `build/${identity}`, to: identity }] : []),
  ],
  asar: true,
  mac: {
    target: [{ target: 'zip', arch: ['arm64'] }],
    category: 'public.app-category.productivity',
    identity: null,
    hardenedRuntime: false,
    extendInfo: { LSUIElement: true },
  },
  linux: {
    target: [{ target: 'deb', arch: ['x64'] }, { target: 'tar.gz', arch: ['x64'] }],
    executableName: 'echo-desktop',
    category: 'Office',
    maintainer: 'EchoBrain',
    syncDesktopName: true,
    artifactName: 'ECHO-${version}-linux-${arch}.${ext}',
    // The root helper pkexec runs to re-verify and install an update.
    extraResources: [{ from: `linux/${helper}`, to: helper }],
  },
  deb: {
    // What dpkg runs as root, and the profile postinst loads, are reviewed
    // files in linux/ that the update feed binds to the release commit
    // (scripts/check-deb.mjs). None has template macros, so electron-builder
    // copies each unchanged.
    afterInstall: 'linux/postinst',
    afterRemove: 'linux/postrm',
    appArmorProfile: 'linux/apparmor-profile',
    // apt installs these as root, so the feed binds them too. Setting depends
    // replaces electron-builder 26's default list, so the file repeats it in
    // full before python3 and openssl, which the update helper needs. Likewise
    // for recommends: without pkexec an update fails safely and the manual
    // reinstall remains. fpm joins each list with ", " unchanged, which the
    // feed expects, so an entry is a plain name or a `|` alternative.
    depends: debRelationships.depends,
    recommends: debRelationships.recommends,
  },
  async afterPack(context) {
    if (!['darwin', 'linux'].includes(context.electronPlatformName)) return;
    const mac = context.electronPlatformName === 'darwin';
    const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
    const app = join(context.appOutDir, mac ? `${context.packager.appInfo.productFilename}.app` : context.packager.executableName);
    // Fixed modes whatever the umask: the root helper trusts only an identity
    // no one else can write, and the deb installs files as root.
    const resources = mac ? join(app, 'Contents', 'Resources') : join(context.appOutDir, 'resources');
    if (existsSync(join(resources, identity))) chmodSync(join(resources, identity), 0o644);
    if (!mac) chmodSync(join(resources, helper), 0o755);
    // The signed deb never ships a setuid sandbox (the feed gate refuses one),
    // whatever mode the Electron download staged it with.
    const sandbox = join(context.appOutDir, 'chrome-sandbox');
    if (!mac && existsSync(sandbox)) chmodSync(sandbox, 0o755);
    await flipFuses(app, {
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: mac,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    });
    if (!mac) return;
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  },
};
