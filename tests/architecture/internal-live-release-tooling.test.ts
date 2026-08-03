import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const TOOL = join(REPO, 'tools', 'internal-live-release.mjs');
const WORKFLOW = join(REPO, '.github', 'workflows', 'internal-live-release.yml');
const CI_WORKFLOW = join(REPO, '.github', 'workflows', 'ci.yml');
const VERSION = '0.1.0-internal.4';
const SOURCE_SHA = 'a'.repeat(40);
const REPOSITORY = 'EchoBrain-org/echo-brain';
const RUN_ID = '12345678901234567890';
const RUN_ATTEMPT = '2';

type Fixture = {
  readonly root: string;
  readonly bundle: string;
  readonly artifact: string;
};

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function createFixture(options?: {
  readonly version?: string;
  readonly identitySourceSha?: string;
  readonly emptyEvidence?: boolean;
  readonly nodeVersion?: string;
}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'echo-internal-live-release-'));
  const packageRoot = join(root, 'fixture', 'package');
  const dist = join(packageRoot, 'dist', 'product');
  const bundle = join(root, 'bundle');
  mkdirSync(dist, { recursive: true });
  mkdirSync(bundle);
  const version = options?.version ?? VERSION;
  const identitySourceSha = options?.identitySourceSha ?? SOURCE_SHA;
  const packageJsonPath = join(packageRoot, 'package.json');
  const buildIdentityPath = join(dist, 'build-identity.v1.json');
  writeJson(packageJsonPath, {
    name: 'echo-brain',
    version,
    engines: {
      node: options?.nodeVersion ?? '22.22.1',
      npm: '10.9.4',
    },
  });
  writeJson(buildIdentityPath, {
    schema_version: 1,
    kind: 'echo-packaged-build-identity',
    product_version: version,
    source_sha: identitySourceSha,
    source_kind: 'materialized-commit',
  });
  const evidenceFiles = [
    { path: 'package.json', absolutePath: packageJsonPath },
    {
      path: 'dist/product/build-identity.v1.json',
      absolutePath: buildIdentityPath,
    },
  ]
    .map(({ path, absolutePath }) => ({
      path,
      size: statSync(absolutePath).size,
      sha256: createHash('sha256')
        .update(readFileSync(absolutePath))
        .digest('hex'),
    }))
    .sort((left, right) =>
      Buffer.from(left.path).compare(Buffer.from(right.path)),
    );
  writeJson(join(packageRoot, 'dist', 'package-artifact-evidence.v1.json'), {
    schema_version: 1,
    kind: 'echo-package-artifact-evidence',
    package: 'echo-brain',
    version,
    source_sha: identitySourceSha,
    files: options?.emptyEvidence === true ? [] : evidenceFiles,
  });
  const artifact = join(bundle, `echo-brain-${version}.tgz`);
  const packed = spawnSync(
    'tar',
    ['-czf', artifact, '-C', join(root, 'fixture'), 'package'],
    { encoding: 'utf8' },
  );
  if (packed.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`fixture tar failed: ${packed.stderr}`);
  }
  return { root, bundle, artifact };
}

function tool(
  command: 'create' | 'verify',
  fixture: Fixture,
  overrides?: { readonly releaseVersion?: string },
) {
  const common = [
    '--release-version',
    overrides?.releaseVersion ?? VERSION,
    '--source-sha',
    SOURCE_SHA,
    '--repository',
    REPOSITORY,
    '--workflow-run-id',
    RUN_ID,
    '--workflow-run-attempt',
    RUN_ATTEMPT,
  ];
  const specific =
    command === 'create'
      ? ['--artifact', fixture.artifact, '--output-dir', fixture.bundle]
      : ['--bundle-dir', fixture.bundle];
  return spawnSync(process.execPath, [TOOL, command, ...common, ...specific], {
    encoding: 'utf8',
  });
}

function monotonic(releaseVersion: string, existingTags: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'echo-internal-live-versions-'));
  const tags = join(root, 'existing-tags.txt');
  writeFileSync(tags, existingTags.length === 0 ? '' : `${existingTags.join('\n')}\n`);
  try {
    return spawnSync(
      process.execPath,
      [
        TOOL,
        'assert-monotonic',
        '--release-version',
        releaseVersion,
        '--existing-tags-file',
        tags,
      ],
      { encoding: 'utf8' },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('INTERNAL LIVE release tooling', () => {
  it('shares the stronger macOS package smoke with the regular CI gate', () => {
    const workflow = readFileSync(CI_WORKFLOW, 'utf8');
    const jobStart = workflow.indexOf('  macos-launchagent:');
    const nextJob = workflow.indexOf('  authority-container:', jobStart);
    const job = workflow.slice(jobStart, nextJob);

    expect(jobStart).toBeGreaterThan(0);
    expect(nextJob).toBeGreaterThan(jobStart);
    expect(job).toContain('runs-on: macos-15');
    expect(job).toContain('npm pack --pack-destination "$pack_dir"');
    expect(job).toContain(
      'bash .github/scripts/internal-live-macos-smoke.sh \\\n' +
        '            "$archive" \\\n' +
        '            "$package_version"',
    );
    expect(job).not.toContain('"$cli" onboard');
    expect(job).not.toContain('"$cli" service install');
  });

  it('keeps one lean publication behind approval and exact-bundle verification', () => {
    const workflow = readFileSync(WORKFLOW, 'utf8');
    expect(workflow).toContain('name: internal-live');
    expect(workflow).toContain('assert-monotonic');
    expect(workflow).not.toContain('gh api');
    expect(workflow).not.toContain('--draft');
    expect(workflow.match(/gh release create/g)).toHaveLength(1);
    const reverify = workflow.indexOf('Reverify release identity after approval');
    const publish = workflow.indexOf('gh release create "$RELEASE_TAG"');
    expect(reverify).toBeGreaterThan(0);
    expect(publish).toBeGreaterThan(reverify);
  });

  it('requires every new INTERNAL LIVE version to increase the numeric tuple', () => {
    const first = monotonic('0.1.0-internal.1', []);
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      ok: true,
      command: 'assert-monotonic',
      release_version: '0.1.0-internal.1',
      compared_versions: 0,
    });

    const increasing = monotonic('0.1.0-internal.10', [
      'internal-v0.1.0-internal.2',
      'internal-v0.1.0-internal.9',
    ]);
    expect(increasing.status, increasing.stderr).toBe(0);

    for (const candidate of [
      '0.1.0-internal.2',
      '0.1.0-internal.1',
    ]) {
      const rejected = monotonic(candidate, [
        'internal-v0.1.0-internal.2',
      ]);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('must be greater than');
    }

    const nextPatch = monotonic('0.1.1-internal.0', [
      'internal-v0.1.0-internal.999',
    ]);
    expect(nextPatch.status, nextPatch.stderr).toBe(0);
  });

  it('creates and verifies one exact-shape build-once release bundle', () => {
    const fixture = createFixture();
    try {
      const created = tool('create', fixture);
      expect(created.status, created.stderr).toBe(0);

      const digest = createHash('sha256')
        .update(readFileSync(fixture.artifact))
        .digest('hex');
      const manifest = JSON.parse(
        readFileSync(
          join(fixture.bundle, 'internal-live-release-manifest.v1.json'),
          'utf8',
        ),
      );
      expect(manifest).toEqual({
        schema_version: 1,
        kind: 'echo-internal-live-release',
        channel: 'internal-live',
        release_version: VERSION,
        release_tag: `internal-v${VERSION}`,
        source: {
          sha: SOURCE_SHA,
          kind: 'materialized-commit',
        },
        artifact: {
          package: 'echo-brain',
          filename: basename(fixture.artifact),
          download_url:
            `https://github.com/${REPOSITORY}/releases/download/` +
            `internal-v${VERSION}/${basename(fixture.artifact)}`,
          size_bytes: statSync(fixture.artifact).size,
          sha256: digest,
        },
        compatibility: {
          os: 'darwin',
          arch: 'arm64',
          node: '22.22.1',
          npm: '10.9.4',
        },
        build: {
          repository: REPOSITORY,
          workflow: 'internal-live-release.yml',
          run_id: RUN_ID,
          run_attempt: 2,
        },
      });
      expect(readFileSync(join(fixture.bundle, 'SHA256SUMS'), 'utf8')).toBe(
        `${digest}  ${basename(fixture.artifact)}\n`,
      );

      const verified = tool('verify', fixture);
      expect(verified.status, verified.stderr).toBe(0);
      expect(JSON.parse(verified.stdout)).toMatchObject({
        ok: true,
        command: 'verify',
        release_version: VERSION,
        release_tag: `internal-v${VERSION}`,
        source_sha: SOURCE_SHA,
        artifact_sha256: digest,
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('accepts only exact numeric MAJOR.MINOR.PATCH-internal.SEQUENCE versions', () => {
    const fixture = createFixture();
    try {
      for (const version of [
        'v0.1.0-internal.1',
        '0.1.0-dev.1',
        '0.1.0-internal',
        '0.1.0-internal.alpha',
        '0.1.0-internal.01',
        '0.1.0-internal.1+build.2',
      ]) {
        const rejected = tool('create', fixture, { releaseVersion: version });
        expect(rejected.status).not.toBe(0);
        expect(rejected.stderr).toContain(
          'exact MAJOR.MINOR.PATCH-internal.SEQUENCE',
        );
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a package whose embedded source is not the requested commit', () => {
    const fixture = createFixture({ identitySourceSha: 'b'.repeat(40) });
    try {
      const created = tool('create', fixture);
      expect(created.status).not.toBe(0);
      expect(created.stderr).toContain(
        'embedded build identity does not match the materialized release source',
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects empty embedded file evidence', () => {
    const fixture = createFixture({ emptyEvidence: true });
    try {
      const created = tool('create', fixture);
      expect(created.status).not.toBe(0);
      expect(created.stderr).toContain('bounded non-empty file set');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a runtime version range that installed Macs cannot match exactly', () => {
    const fixture = createFixture({ nodeVersion: '>=22' });
    try {
      const created = tool('create', fixture);
      expect(created.status).not.toBe(0);
      expect(created.stderr).toContain('one exact X.Y.Z version');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects modified artifact bytes after the bundle is sealed', () => {
    const fixture = createFixture();
    try {
      const created = tool('create', fixture);
      expect(created.status, created.stderr).toBe(0);
      appendFileSync(fixture.artifact, 'tamper');

      const verified = tool('verify', fixture);
      expect(verified.status).not.toBe(0);
      expect(verified.stderr).toContain(
        'artifact bytes do not match the release manifest',
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects undeclared release-manifest fields', () => {
    const fixture = createFixture();
    try {
      const created = tool('create', fixture);
      expect(created.status, created.stderr).toBe(0);
      const manifestPath = join(
        fixture.bundle,
        'internal-live-release-manifest.v1.json',
      );
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.command = 'run arbitrary shell';
      writeJson(manifestPath, manifest);

      const verified = tool('verify', fixture);
      expect(verified.status).not.toBe(0);
      expect(verified.stderr).toContain('release manifest has unexpected fields');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
