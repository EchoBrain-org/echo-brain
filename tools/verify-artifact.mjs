#!/usr/bin/env node
// AC5 — reproducible artifact identity.
//
// Usage: /usr/local/bin/node tools/verify-artifact.mjs --run-id <B0|B1|B2|R1> --out <absent-dir>
//
// Runs in an accepted echo-brain target. Compiles the product TypeScript closure
// to dist/ with the pinned toolchain (SOURCE_DATE_EPOCH-normalized), then builds a
// byte-deterministic npm-installable tarball whose SHA-256, ordered member manifest
// (path,mode,size,sha256), HEAD/tree, and lock hash are identical across B0/B1/B2/R1.
//
// Determinism strategy: a pure-JS ustar tar writer with fixed mtime=SOURCE_DATE_EPOCH,
// uid/gid=0, normalized modes, byte-sorted members, followed by zlib gzip (header
// mtime forced to 0). npm's own `pack` mtime behavior is NOT relied upon.
//
// Runtime assets are packaged at their canonical paths: the config schema at
// schemas/runtime-config.v1.schema.json and SQLite migrations under dist/storage/.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import process from 'node:process';

const REPO = process.cwd();
const SOURCE_DATE_EPOCH = 1000000000; // fixed, run-independent

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!out['run-id'] || !out.out) throw new Error('usage: --run-id <id> --out <absent-dir>');
  return out;
}
function git(...args) {
  const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'buffer', maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${r.stderr?.toString('utf8') ?? r.error?.message ?? 'unknown error'}`,
    );
  }
  return r.stdout;
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Minimal deterministic ustar writer.
function ustarHeader(name, size, mode) {
  const buf = Buffer.alloc(512, 0);
  const write = (str, off, len) => buf.write(str.slice(0, len).padEnd(len, '\0'), off, len, 'binary');
  write(name, 0, 100);
  write(mode.toString(8).padStart(7, '0') + '\0', 100, 8);
  write('0000000\0', 108, 8); // uid
  write('0000000\0', 116, 8); // gid
  write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  write(SOURCE_DATE_EPOCH.toString(8).padStart(11, '0') + '\0', 136, 12);
  buf.write('        ', 148, 8, 'binary'); // checksum placeholder (spaces)
  write('0', 156, 1); // typeflag = regular file
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  let sum = 0;
  for (const b of buf) sum += b;
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return buf;
}
function tarball(members) {
  const chunks = [];
  for (const { name, data, mode } of members) {
    chunks.push(ustarHeader(name, data.length, mode));
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0)); // two zero blocks terminate
  return Buffer.concat(chunks);
}

function compile(distDir) {
  // Resolve the pinned toolchain tsc: env override, then a provisioned node_modules.
  const tsc = process.env.ECHO_TSC
    || (existsSync(join(REPO, 'node_modules/.bin/tsc')) ? join(REPO, 'node_modules/.bin/tsc') : null);
  if (!tsc) {
    throw new Error('no toolchain tsc available (set ECHO_TSC or provision node_modules per provenance/dependency-toolchain.v1.json)');
  }
  const r = spawnSync(tsc, ['-p', join(REPO, 'tsconfig.build.json'), '--outDir', distDir], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, SOURCE_DATE_EPOCH: String(SOURCE_DATE_EPOCH) },
  });
  if (r.status !== 0) throw new Error(`tsc failed: ${r.stdout}\n${r.stderr}`);
  cpSync(join(REPO, 'src', 'storage', 'migrations'), join(distDir, 'storage', 'migrations'), {
    recursive: true,
  });
}
function collectDist(distDir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(distDir);
  return files.map((f) => ({ rel: 'dist/' + relative(distDir, f).split('\\').join('/'), full: f })).sort((a, b) => a.rel.localeCompare(b.rel));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (existsSync(args.out)) { process.stderr.write(`--out must be absent: ${args.out}\n`); process.exit(2); }
  const dirty = git('status', '--porcelain', '--untracked-files=all').toString().trim();
  if (dirty !== '') {
    process.stderr.write('refusing to build a release artifact from a dirty worktree\n');
    process.exit(2);
  }
  mkdirSync(args.out, { recursive: true });
  const head = git('rev-parse', 'HEAD').toString().trim();
  const treeOid = git('rev-parse', 'HEAD^{tree}').toString().trim();
  const lockHash = sha256(readFileSync(join(REPO, 'npm-shrinkwrap.json')));
  const packageJson = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));

  const distDir = join(args.out, 'dist');
  compile(distDir);

  // Staged package members (byte-sorted). package/ prefix is npm's tarball root.
  const members = [];
  const add = (name, data, mode = 0o644) => members.push({ name: 'package/' + name, data, mode });
  add('package.json', readFileSync(join(REPO, 'package.json')));
  add('npm-shrinkwrap.json', readFileSync(join(REPO, 'npm-shrinkwrap.json')));
  add('README.md', readFileSync(join(REPO, 'README.md')));
  add('LICENSE', readFileSync(join(REPO, 'LICENSE')));
  add('docs/architecture/core-and-adapters.md', readFileSync(join(REPO, 'docs/architecture/core-and-adapters.md')));
  add('schemas/runtime-config.v1.schema.json', readFileSync(join(REPO, 'schemas/runtime-config.v1.schema.json')));
  for (const { rel, full } of collectDist(distDir)) {
    add(rel, readFileSync(full), rel === 'dist/product/cli.js' ? 0o755 : 0o644);
  }
  members.sort((a, b) => a.name.localeCompare(b.name));

  const memberManifest = members.map((m) => ({
    path: m.name, mode: m.mode, size: m.data.length, sha256: sha256(m.data),
  }));
  const tar = tarball(members);
  const tgz = gzipSync(tar, { level: 9 });
  // zlib gzip header carries no filename; force mtime bytes (4..8) to 0 for determinism.
  tgz.writeUInt32LE(0, 4);

  const tgzSha = sha256(tgz);
  const tarPath = join(args.out, `${packageJson.name}-${packageJson.version}.tgz`);
  writeFileSync(tarPath, tgz);
  const identity = {
    run_id: args['run-id'],
    source_sha: head,
    extraction_source_sha: '2971310441b69735cbe759293abd8c4d044bf347',
    version: packageJson.version,
    head_commit: head,
    head_tree: treeOid,
    lock_sha256: lockHash,
    tarball_sha256: tgzSha,
    member_manifest: memberManifest,
  };
  writeFileSync(join(args.out, 'artifact-identity.json'), JSON.stringify(identity, null, 2) + '\n');
  writeFileSync(tarPath + '.sha256', tgzSha + '\n');
  process.stdout.write(JSON.stringify({ run_id: args['run-id'], tarball_sha256: tgzSha, members: members.length }, null, 2) + '\n');
}
main();
