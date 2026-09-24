// Packages ECHO for macOS (arm64 zip). Release fuses are flipped after pack and
// the bundle is re-signed ad hoc, because flipping fuses breaks the signature
// and Apple silicon will not run an unsigned binary.
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
  async afterPack(context) {
    if (context.electronPlatformName !== 'darwin') return;
    const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
    const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    await flipFuses(app, {
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    });
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  },
};
