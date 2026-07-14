#!/usr/bin/env node
// AC3 — target-local provenance check.
//
// Validates: reviewed policy SHA; empty transform/exclusion allowlists; that
// source-extraction.v1.json partitions every regular tracked target HEAD blob
// (other than itself) exactly once with matching git mode and SHA-256; that the
// declared target-only set equals the actual target-only partition; and that the
// eight pinned tests + relocations/copies carry the recorded source provenance.
// Structural schema conformance is enforced here; full JSON-Schema validation is
// additionally exercised by tests/migration/provenance.test.ts (ajv).
//
// Node builtins only; safe to run before `npm ci`.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const REPO = process.cwd();
const EXPECTED_SPEC_SHA = '832be81341f2c523fd42918206774ec8a51f54de653a323ad56d612e0ea47748';
const EXPECTED_SOURCE_SHA = '2971310441b69735cbe759293abd8c4d044bf347';
const SELF = 'provenance/source-extraction.v1.json';

function git(...args) {
  const r = spawnSync('/usr/local/bin/git', ['-C', REPO, ...args], { encoding: 'buffer', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
function headTree() {
  const out = git('ls-tree', '-rz', '--format=%(objectmode) %(objectname) %(path)', 'HEAD');
  const tree = new Map();
  for (const entry of out.toString('utf8').split('\0')) {
    if (!entry.trim()) continue;
    const [mode, oid, ...rest] = entry.split(' ');
    tree.set(rest.join(' '), { mode, oid });
  }
  return tree;
}
const rawBlob = (t, p) => git('cat-file', 'blob', t.get(p).oid);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function main() {
  const tree = headTree();
  const errors = [];
  const get = (p) => JSON.parse(rawBlob(tree, p).toString('utf8'));

  const policy = get('provenance/extraction-policy.v1.json');
  if (policy.policy_version !== 1) errors.push('policy_version != 1');
  if (policy.reviewed_spec_sha !== EXPECTED_SPEC_SHA) errors.push(`reviewed_spec_sha mismatch: ${policy.reviewed_spec_sha}`);
  if (policy.source.source_sha !== EXPECTED_SOURCE_SHA) errors.push(`policy source_sha mismatch: ${policy.source.source_sha}`);
  if ((policy.dispositions.exclusion_allowlist ?? []).length !== 0) errors.push('exclusion_allowlist not empty');
  // Only the founder-adjudicated package.json npm-pin transform is permitted (F3, adj #3).
  const transformAllow = policy.dispositions.transform_allowlist ?? [];
  const allowByPath = new Map(transformAllow.map((t) => [t.target_path, t]));
  for (const t of transformAllow) {
    if (t.target_path !== 'package.json' || !/engines\.npm/.test(t.transform)) {
      errors.push(`unexpected transform_allowlist entry: ${t.target_path} (${t.transform})`);
    }
  }
  const declaredTargetOnly = new Set(policy.target_only_paths);
  if (declaredTargetOnly.size !== 21) errors.push(`target_only_paths size ${declaredTargetOnly.size} != 21`);

  const extraction = get(SELF);
  if (extraction.reviewed_spec_sha !== EXPECTED_SPEC_SHA) errors.push('source-extraction reviewed_spec_sha mismatch');
  if (extraction.source_sha !== EXPECTED_SOURCE_SHA) errors.push('source-extraction source_sha mismatch');

  // every regular tracked blob other than SELF must appear exactly once
  const partitioned = new Map();
  for (const e of extraction.entries) {
    if (partitioned.has(e.target_path)) errors.push(`duplicate partition entry: ${e.target_path}`);
    partitioned.set(e.target_path, e);
  }
  const actualTargetOnly = new Set();
  for (const [path, { mode }] of [...tree].sort()) {
    if (path === SELF) continue;
    const e = partitioned.get(path);
    if (!e) { errors.push(`unpartitioned target blob: ${path}`); continue; }
    if (e.git_mode !== mode) errors.push(`mode drift ${path}: ${e.git_mode} != ${mode}`);
    const h = sha256(rawBlob(tree, path));
    if (e.target_sha256 !== h) errors.push(`sha256 drift ${path}`);
    if (e.origin.kind === 'target-only') actualTargetOnly.add(path);
    partitioned.delete(path);
  }
  for (const extra of partitioned.keys()) errors.push(`partition entry for absent/self blob: ${extra}`);

  // declared target-only set == actual target-only partition (SELF is target-only but excluded from entries)
  actualTargetOnly.add(SELF);
  for (const p of declaredTargetOnly) if (!actualTargetOnly.has(p)) errors.push(`declared target-only not partitioned as target-only: ${p}`);
  for (const p of actualTargetOnly) if (!declaredTargetOnly.has(p)) errors.push(`partitioned target-only not declared: ${p}`);

  // source rows carry source provenance; transformed rows must match the allowlist exactly
  const transformedInExtraction = new Set();
  for (const e of extraction.entries) {
    if (e.origin.kind === 'copied' && e.origin.source_path !== e.target_path) errors.push(`copied path mismatch ${e.target_path}`);
    if (e.origin.kind !== 'target-only' && !e.origin.source_blob_oid) errors.push(`missing source_blob_oid ${e.target_path}`);
    if (e.origin.transform) {
      transformedInExtraction.add(e.target_path);
      if (!allowByPath.has(e.target_path)) errors.push(`transformed origin ${e.target_path} absent from transform_allowlist`);
    }
  }
  for (const p of allowByPath.keys()) {
    if (!transformedInExtraction.has(p)) errors.push(`transform_allowlist entry ${p} has no transformed source-extraction origin`);
  }

  const result = { ok: errors.length === 0, partition_count: extraction.entries.length, target_only: [...actualTargetOnly].sort(), errors };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exit(1);
}
main();
