// macOS arm64 zip and Linux x64 deb/tar.gz. Both carry the same client and
// release fuses. macOS is re-signed after flipping its fuses.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

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
  },
  async afterPack(context) {
    if (!['darwin', 'linux'].includes(context.electronPlatformName)) return;
    const mac = context.electronPlatformName === 'darwin';
    const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
    const app = join(context.appOutDir, mac ? `${context.packager.appInfo.productFilename}.app` : context.packager.executableName);
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
