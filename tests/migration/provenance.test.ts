// AC3 — provenance: schema conformance, raw-object partition, exact dispositions,
// full target partition, and evasion failure.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Ajv } from 'ajv';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const ajv = new Ajv({ allErrors: true, strict: false });

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
}

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('provenance records', () => {
  it('each provenance doc validates against its committed schema', () => {
    const pairs: Array<[string, string]> = [
      ['provenance/extraction-policy.v1.json', 'provenance/schemas/extraction-policy.v1.schema.json'],
      ['provenance/source-plan.v1.json', 'provenance/schemas/source-plan.v1.schema.json'],
      ['provenance/source-extraction.v1.json', 'provenance/schemas/source-extraction.v1.schema.json'],
      ['provenance/test-parity.v1.json', 'provenance/schemas/test-parity.v1.schema.json'],
      ['provenance/dependency-toolchain.v1.json', 'provenance/schemas/dependency-toolchain.v1.schema.json'],
    ];
    for (const [doc, schema] of pairs) {
      const validate = ajv.compile(readJson(schema) as object);
      const ok = validate(readJson(doc));
      expect(validate.errors ?? [], `${doc}: ${JSON.stringify(validate.errors)}`).toEqual(expect.anything());
      expect(ok, `${doc} failed schema ${schema}`).toBe(true);
    }
  });

  it('reviewed policy has empty exclusion allowlist, only the adjudicated package.json transform, and the 21-path target-only set', () => {
    const policy = readJson('provenance/extraction-policy.v1.json') as {
      dispositions: { transform_allowlist: Array<{ target_path: string; transform: string }>; exclusion_allowlist: unknown[] };
      target_only_paths: string[];
    };
    expect(policy.dispositions.exclusion_allowlist).toEqual([]);
    // F3 (founder adjudication #3): the sole permitted transform is the package.json npm pin.
    expect(policy.dispositions.transform_allowlist).toHaveLength(1);
    expect(policy.dispositions.transform_allowlist[0].target_path).toBe('package.json');
    expect(policy.dispositions.transform_allowlist[0].transform).toMatch(/engines\.npm/);
    expect(new Set(policy.target_only_paths).size).toBe(21);
  });

  it('check-provenance passes against the immutable extraction baseline', () => {
    const r = spawnSync(process.execPath, [join(REPO, 'tools/check-provenance.mjs')], { cwd: REPO, encoding: 'utf8' });
    expect(r.stdout + r.stderr).toContain('"ok": true');
    expect(r.status).toBe(0);
  });

  it('detects disposition evasion (tampered target blob) in a working copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-brain-prov-'));
    tmpDirs.push(dir);
    const clone = join(dir, 'echo-brain');
    // clone the committed repo so HEAD is intact, then mutate a tracked file + commit
    expect(spawnSync('/usr/local/bin/git', ['clone', '--quiet', REPO, clone], { encoding: 'utf8' }).status).toBe(0);
    const victim = join(clone, 'src/guards.ts');
    writeFileSync(victim, readFileSync(victim, 'utf8') + '\n// tamper\n');
    spawnSync('/usr/local/bin/git', ['-C', clone, 'commit', '-am', 'tamper', '--no-gpg-sign'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
    const r = spawnSync(
      process.execPath,
      [join(clone, 'tools/check-provenance.mjs'), '--commit', 'HEAD'],
      { cwd: clone, encoding: 'utf8' },
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/sha256 drift|unpartitioned/);
  });
});
