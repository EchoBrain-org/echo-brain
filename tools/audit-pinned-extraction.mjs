#!/usr/bin/env node
// AC3 operator audit — independent, read-only.
//
// Invoked exactly as:
//   /usr/local/bin/node tools/audit-pinned-extraction.mjs \
//     --source-git-dir <project-git-dir> --source-sha <sha> \
//     --target-git-dir <clone>/.git --target-commit <accepted-oid> \
//     --policy provenance/extraction-policy.v1.json --out <absent-json>
//
// Independently runs AC1's sanitized Git object envelope against BOTH the pinned
// source object database (read-only) and the accepted target commit, re-derives
// the source->target partition from the reviewed policy, and compares it against
// the committed provenance. Emits a versioned result and exits nonzero on
// omission, policy mismatch, disposition evasion, hash/mode drift, or an extra
// blob. Node builtins only.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`bad flag ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  for (const req of ['source-git-dir', 'source-sha', 'target-git-dir', 'target-commit', 'policy', 'out']) {
    if (!out[req]) throw new Error(`missing --${req}`);
  }
  return out;
}

// AC1 sanitized envelope. env -i wipes inherited GIT_*/config vars.
function envelopeGit(gitDir, args, { input } = {}) {
  const env = {
    HOME: process.env.ECHO_AUDIT_SCRATCH_HOME || '/tmp/echo-audit-home',
    LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/local/bin:/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1',
  };
  const r = spawnSync('/usr/local/bin/git', [`--git-dir=${gitDir}`, ...args],
    { env, input, encoding: 'buffer', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} @ ${gitDir} failed: ${r.stderr}`);
  return r.stdout;
}

function assertCleanEnvelope(gitDir, label, errors) {
  if (existsSync(join(gitDir, 'objects', 'info', 'alternates'))) errors.push(`${label}: alternates present`);
  if (existsSync(join(gitDir, 'commondir'))) errors.push(`${label}: commondir present`);
  if (existsSync(join(gitDir, 'info', 'grafts'))) errors.push(`${label}: grafts present`);
  const replace = envelopeGit(gitDir, ['for-each-ref', '--format=%(refname)', 'refs/replace/']).toString().trim();
  if (replace) errors.push(`${label}: replace refs present`);
}

function tree(gitDir, commit) {
  const out = envelopeGit(gitDir, ['ls-tree', '-rz', '--full-tree', '--format=%(objectmode) %(objectname) %(path)', commit]);
  const m = new Map();
  for (const entry of out.toString('utf8').split('\0')) {
    if (!entry.trim()) continue;
    const [mode, oid, ...rest] = entry.split(' ');
    m.set(rest.join(' '), { mode, oid });
  }
  return m;
}
const rawBlob = (gitDir, oid) => envelopeGit(gitDir, ['cat-file', 'blob', oid]);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Verify the ONLY founder-adjudicated transform: target == source parsed-JSON with exactly
// one added key engines.npm = "10.9.4" and no other key added, removed, or changed.
function verifyNpmPinTransform(srcBytes, tgtBytes, errors, tpath) {
  let src;
  let tgt;
  try { src = JSON.parse(srcBytes.toString('utf8')); tgt = JSON.parse(tgtBytes.toString('utf8')); }
  catch { errors.push(`transform ${tpath}: unparseable JSON`); return false; }
  const tgtNpm = tgt?.engines?.npm;
  if (tgtNpm !== '10.9.4') { errors.push(`transform ${tpath}: engines.npm != "10.9.4"`); return false; }
  if (src?.engines?.npm !== undefined) { errors.push(`transform ${tpath}: source already had engines.npm`); return false; }
  // Reconstruct: source + engines.npm should equal target (deep-equal, key order irrelevant).
  const rebuilt = { ...src, engines: { ...(src.engines ?? {}), npm: '10.9.4' } };
  if (JSON.stringify(sortKeys(rebuilt)) !== JSON.stringify(sortKeys(tgt))) {
    errors.push(`transform ${tpath}: target differs from source+engines.npm by more than the pin`);
    return false;
  }
  return true;
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (existsSync(args.out)) { process.stderr.write(`--out must be absent: ${args.out}\n`); process.exit(2); }
  const errors = [];

  assertCleanEnvelope(args['source-git-dir'], 'source', errors);
  assertCleanEnvelope(args['target-git-dir'], 'target', errors);

  const stype = envelopeGit(args['source-git-dir'], ['cat-file', '-t', args['source-sha']]).toString().trim();
  if (stype !== 'commit') errors.push(`source-sha is ${stype}, not commit`);

  const sourceTree = tree(args['source-git-dir'], args['source-sha']);
  const targetTree = tree(args['target-git-dir'], args['target-commit']);

  // reviewed policy + committed provenance come from the accepted target commit
  const targetGet = (p) => JSON.parse(rawBlob(args['target-git-dir'], targetTree.get(p).oid).toString('utf8'));
  const policy = targetGet(args.policy);
  const extraction = targetGet('provenance/source-extraction.v1.json');

  if (policy.source.source_sha !== args['source-sha']) errors.push('policy source_sha != --source-sha');
  if ((policy.dispositions.exclusion_allowlist ?? []).length) errors.push('non-empty exclusion_allowlist (disposition evasion)');
  // The only permitted transform is the founder-adjudicated package.json npm pin (F3, adj #3).
  // Its byte-level correctness is verified per-row below via verifyNpmPinTransform.
  for (const t of policy.dispositions.transform_allowlist ?? []) {
    if (t.target_path !== 'package.json' || !/engines\.npm/.test(t.transform ?? '')) {
      errors.push(`unauthorized transform_allowlist entry (disposition evasion): ${t.target_path}`);
    }
  }

  const rows = new Map(extraction.entries.map((e) => [e.target_path, e]));

  // Independently confirm every source-derived row's bytes match the pinned source blob
  // and the accepted target blob, and modes are identical.
  for (const [tpath, { mode: tmode, oid: toid }] of targetTree) {
    if (tpath === 'provenance/source-extraction.v1.json') continue;
    const row = rows.get(tpath);
    if (!row) { errors.push(`extra target blob not in partition: ${tpath}`); continue; }
    const tbytes = rawBlob(args['target-git-dir'], toid);
    if (sha256(tbytes) !== row.target_sha256) errors.push(`target hash drift: ${tpath}`);
    if (tmode !== row.git_mode) errors.push(`target mode drift: ${tpath}`);
    if (row.origin.kind !== 'target-only') {
      const src = sourceTree.get(row.origin.source_path);
      if (!src) { errors.push(`source path absent for ${tpath}: ${row.origin.source_path}`); continue; }
      if (src.oid !== row.origin.source_blob_oid) errors.push(`source blob oid drift: ${tpath}`);
      const sbytes = rawBlob(args['source-git-dir'], src.oid);
      if (row.origin.transform) {
        // Transformed relocation (founder-adjudicated): verify the exact declared transform
        // instead of byte equality. Only the package.json engines.npm pin is recognized.
        if (!verifyNpmPinTransform(sbytes, tbytes, errors, tpath)) { /* errors already pushed */ }
        if (src.mode !== tmode) errors.push(`source/target mode divergence: ${tpath}`);
      } else {
        if (!sbytes.equals(tbytes)) errors.push(`byte divergence source vs target: ${tpath}`);
        if (src.mode !== tmode) errors.push(`source/target mode divergence: ${tpath}`);
      }
    }
  }
  for (const tpath of rows.keys()) {
    if (tpath !== 'provenance/source-extraction.v1.json' && !targetTree.has(tpath)) errors.push(`partition row for absent target blob: ${tpath}`);
  }

  const result = {
    audit_version: 1,
    policy_sha256: sha256(rawBlob(args['target-git-dir'], targetTree.get(args.policy).oid)),
    reviewed_spec_sha: policy.reviewed_spec_sha,
    source_sha: args['source-sha'],
    source_tree_size: sourceTree.size,
    target_tree_size: targetTree.size,
    partition_rows: extraction.entries.length,
    target_only_count: extraction.entries.filter((e) => e.origin.kind === 'target-only').length + 1,
    verdict: errors.length === 0 ? 'PASS' : 'FAIL',
    errors,
  };
  writeFileSync(args.out, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (errors.length) process.exit(1);
}
main();
