#!/usr/bin/env node
// Builds main, preload, the person host and the renderer into build/.
// `--release` compiles the test hook out of every bundle.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');
const release = process.argv.includes('--release');
const define = { __ECHO_TEST_HOOK__: release ? 'false' : 'true' };

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'renderer'), { recursive: true });

const node = { bundle: true, platform: 'node', target: 'node24', external: ['electron'], define, logLevel: 'warning', sourcemap: !release };
await Promise.all([
  build({ ...node, entryPoints: [join(root, 'src/main/main.ts')], outfile: join(out, 'main.cjs'), format: 'cjs' }),
  build({ ...node, entryPoints: [join(root, 'src/preload/preload.ts')], outfile: join(out, 'preload.cjs'), format: 'cjs' }),
  build({ ...node, entryPoints: [join(root, 'src/host/host.ts')], outfile: join(out, 'host.mjs'), format: 'esm' }),
  build({
    bundle: true, platform: 'browser', target: 'chrome140', format: 'esm', define, logLevel: 'warning', sourcemap: !release,
    entryPoints: [join(root, 'src/renderer/main.tsx')], outfile: join(out, 'renderer/app.js'),
    jsx: 'automatic', jsxImportSource: 'preact',
  }),
]);
for (const file of ['index.html', 'styles.css']) copyFileSync(join(root, 'src/renderer', file), join(out, 'renderer', file));

// The commit this was built from, shown in the tray.
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
writeFileSync(join(out, 'build-info.json'), JSON.stringify({
  source_sha: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain', '--', '.']) !== '',
}));

// Tray icons: a ring drawn here, so no binary asset lives in the repository.
// macOS uses a black template image; other systems a light one.
writeFileSync(join(out, 'trayTemplate.png'), ring(32, [0, 0, 0]));
writeFileSync(join(out, 'tray.png'), ring(32, [240, 236, 230]));
console.log(`built ${release ? 'release' : 'dev'} bundles into build/`);

function ring(size, [r, g, b]) {
  const rows = [];
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    const row = [0];
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      const alpha = Math.max(0, Math.min(1, 1.5 - Math.abs(distance - size * 0.34) / 1.2));
      row.push(r, g, b, Math.round(alpha * 255));
    }
    rows.push(Buffer.from(row));
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
