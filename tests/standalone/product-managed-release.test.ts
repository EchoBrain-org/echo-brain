import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MANAGED_PRODUCT_CURRENT_POINTER,
  MANAGED_PRODUCT_DEPLOYED_TREE_MANIFEST,
  ManagedProductReleaseSwitchError,
  managedProductCurrentExecutablePath,
  prepareManagedProductRelease,
  recoverManagedProductReleaseSwitch,
  switchManagedProductRelease,
  verifyManagedProductRelease,
  type ManagedProductReleasePin,
  type PreparedManagedProductRelease,
  type SwitchManagedProductReleaseOptions,
} from '../../src/product/artifact-rollback.js';

const SOURCE_SHA = '1'.repeat(40);
const SWITCHED_AT = '2026-07-18T03:04:05.000Z';
const roots: string[] = [];

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'echo-managed-release-'));
  roots.push(root);
  return root;
}

function makeWritable(path: string): void {
  const state = lstatSync(path, { throwIfNoEntry: false });
  if (state === undefined || state.isSymbolicLink()) return;
  if (state.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  } else if (state.isFile()) {
    chmodSync(path, 0o600);
  }
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    if (existsSync(root)) {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

interface StagedRelease {
  releaseId: string;
  releaseDirectory: string;
  version: string;
  artifactSha256: string;
  artifactManifestSha256: string;
  artifactPath: string;
}

function artifactManifest(
  version: string,
  artifactPath: string,
  artifactSize: number,
  artifactSha256: string,
  packagedShrinkwrapSha256: string,
  packageFiles: Array<{ path: string; size: number; sha256: string }>,
  schemaVersion = 1,
): string {
  return `${JSON.stringify(
    {
      schema_version: schemaVersion,
      package: 'echo-brain',
      version,
      source_sha: SOURCE_SHA,
      product_boundary_version: 1,
      declared_platform: {
        os: 'darwin',
        architecture: 'arm64',
        node: '22.22.1',
      },
      dependency_lock_sha256: '3'.repeat(64),
      packaged_shrinkwrap_sha256: packagedShrinkwrapSha256,
      build_command: ['node', 'tools/product/build-artifact.mjs'],
      artifact: {
        path: artifactPath,
        size: artifactSize,
        sha256: artifactSha256,
      },
      package_files: packageFiles,
    },
    null,
    2,
  )}\n`;
}

function sha512Integrity(value: Buffer): string {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

function packageContents(
  version: string,
): Array<{ path: string; bytes: Buffer; mode: number }> {
  const packageJson = `${JSON.stringify({
    name: 'echo-brain',
    version,
    bin: { 'echo-brain': 'dist/product/cli.js' },
  })}\n`;
  const shrinkwrap = `${JSON.stringify({
    name: 'echo-brain',
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'echo-brain',
        version,
        bin: { 'echo-brain': 'dist/product/cli.js' },
        engines: { node: '22.22.1' },
      },
    },
  })}\n`;
  return [
    {
      path: 'dist/product/cli.js',
      bytes: Buffer.from(
        '#!/usr/bin/env node\nprocess.stdout.write("echo-brain\\n");\n',
      ),
      mode: 0o755,
    },
    { path: 'npm-shrinkwrap.json', bytes: Buffer.from(shrinkwrap), mode: 0o600 },
    { path: 'package.json', bytes: Buffer.from(packageJson), mode: 0o600 },
  ];
}

function writePackageFiles(
  packageRoot: string,
  files: ReturnType<typeof packageContents>,
): void {
  for (const file of files) {
    const path = join(packageRoot, file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, file.bytes, { mode: file.mode });
  }
}

function stageRelease(
  managedRoot: string,
  releaseId: string,
  options: { artifactSchemaVersion?: number } = {},
): StagedRelease {
  const releaseDirectory = join(managedRoot, releaseId);
  const version = `1.0.0-${releaseId}`;
  const files = packageContents(version);
  mkdirSync(join(releaseDirectory, 'prefix/node_modules/.bin'), {
    recursive: true,
    mode: 0o700,
  });
  const installedPackageRoot = join(
    releaseDirectory,
    'prefix/node_modules/echo-brain',
  );
  writePackageFiles(installedPackageRoot, files);
  symlinkSync(
    '../echo-brain/dist/product/cli.js',
    join(releaseDirectory, 'prefix/node_modules/.bin/echo-brain'),
  );

  const tarStage = join(dirname(managedRoot), `.tar-stage-${releaseId}`);
  writePackageFiles(join(tarStage, 'package'), files);
  const artifactName = `echo-brain-${version}.tgz`;
  const artifactPath = join(releaseDirectory, artifactName);
  const packed = spawnSync(
    '/usr/bin/tar',
    ['-czf', artifactPath, '-C', tarStage, 'package'],
    { encoding: 'utf8' },
  );
  if (packed.status !== 0) {
    throw new Error(`fixture tar failed: ${packed.stderr}`);
  }
  rmSync(tarStage, { recursive: true, force: true });
  const artifactBytes = readFileSync(artifactPath);
  const artifactSha256 = sha256(artifactBytes);
  const productShrinkwrap = files.find(
    (file) => file.path === 'npm-shrinkwrap.json',
  )!;
  const packageFiles = files.map((file) => ({
    path: file.path,
    size: file.bytes.byteLength,
    sha256: sha256(file.bytes),
  }));

  const artifactDependency = `file:${artifactPath}`;
  writeFileSync(
    join(releaseDirectory, 'prefix/package.json'),
    `${JSON.stringify({
      name: 'echo-brain-offline-install',
      version: '0.0.0',
      private: true,
      dependencies: { 'echo-brain': artifactDependency },
    })}\n`,
    { mode: 0o600 },
  );
  const productLock = JSON.parse(productShrinkwrap.bytes.toString('utf8')) as {
    packages: Record<string, Record<string, unknown>>;
  };
  const productMetadata = productLock.packages['']!;
  writeFileSync(
    join(releaseDirectory, 'prefix/package-lock.json'),
    `${JSON.stringify({
      name: 'echo-brain-offline-install',
      version: '0.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'echo-brain-offline-install',
          version: '0.0.0',
          dependencies: { 'echo-brain': artifactDependency },
        },
        'node_modules/echo-brain': {
          version,
          resolved: artifactDependency,
          integrity: sha512Integrity(artifactBytes),
          bin: productMetadata['bin'],
          engines: productMetadata['engines'],
        },
      },
    })}\n`,
    { mode: 0o600 },
  );

  const artifactManifestBytes = artifactManifest(
    version,
    artifactName,
    artifactBytes.byteLength,
    artifactSha256,
    sha256(productShrinkwrap.bytes),
    packageFiles,
    options.artifactSchemaVersion,
  );
  writeFileSync(
    join(releaseDirectory, 'artifact-manifest.json'),
    artifactManifestBytes,
    { mode: 0o600 },
  );
  const artifactManifestSha256 = sha256(artifactManifestBytes);
  return {
    releaseId,
    releaseDirectory,
    version,
    artifactSha256,
    artifactManifestSha256,
    artifactPath,
  };
}

function prepare(
  managedRoot: string,
  staged: StagedRelease,
): PreparedManagedProductRelease {
  return prepareManagedProductRelease({
    managedReleasesRoot: managedRoot,
    releaseId: staged.releaseId,
    expectedSourceSha: SOURCE_SHA,
    expectedVersion: staged.version,
    expectedArtifactSha256: staged.artifactSha256,
    expectedArtifactManifestSha256: staged.artifactManifestSha256,
  });
}

function createManagedRoot(): { root: string; managedRoot: string } {
  const root = temporaryRoot();
  const managedRoot = join(root, 'releases');
  mkdirSync(managedRoot, { mode: 0o700 });
  return { root, managedRoot };
}

function switchOptions(
  managedRoot: string,
  releaseId: string,
  pin: ManagedProductReleasePin,
  operationId: string,
): SwitchManagedProductReleaseOptions {
  return {
    managedReleasesRoot: managedRoot,
    releaseId,
    expected: pin,
    operationId,
    switchedAt: SWITCHED_AT,
  };
}

describe('managed installed product releases', () => {
  it('seals and verifies a real installed-prefix shape including its internal npm bin symlink', () => {
    const { managedRoot } = createManagedRoot();
    const staged = stageRelease(managedRoot, 'candidate-one');
    const prepared = prepare(managedRoot, staged);

    expect(prepared.executablePath).toBe(
      join(prepared.releaseDirectory, 'prefix/node_modules/.bin/echo-brain'),
    );
    expect(relative(prepared.releaseDirectory, realpathSync(prepared.executablePath))).toBe(
      'prefix/node_modules/echo-brain/dist/product/cli.js',
    );
    expect(prepared.manifest.schema_version).toBe(1);
    expect(prepared.manifest).toMatchObject({
      artifact: {
        path: basename(staged.artifactPath),
        sha256: staged.artifactSha256,
      },
      qualification_report: null,
    });
    expect(prepared.manifest.deployed_tree.entries).toContainEqual(
      expect.objectContaining({
        path: basename(staged.artifactPath),
        type: 'file',
        sha256: staged.artifactSha256,
      }),
    );
    expect(prepared.manifest.deployed_tree.entries).toContainEqual({
      path: 'prefix/node_modules/.bin/echo-brain',
      type: 'symlink',
      target: '../echo-brain/dist/product/cli.js',
    });
    expect(lstatSync(staged.releaseDirectory).mode & 0o222).toBe(0);
    expect(
      lstatSync(
        join(staged.releaseDirectory, MANAGED_PRODUCT_DEPLOYED_TREE_MANIFEST),
      ).mode & 0o222,
    ).toBe(0);
    expect(
      verifyManagedProductRelease({
        managedReleasesRoot: managedRoot,
        releaseId: staged.releaseId,
        expected: prepared.pin,
      }).deployedTreeManifestSha256,
    ).toBe(prepared.pin.deployedTreeManifestSha256);
  });

  it('fails closed on schema drift, an escaping symlink, or a mismatched external pin', () => {
    const first = createManagedRoot();
    const schemaTwo = stageRelease(first.managedRoot, 'schema-two', {
      artifactSchemaVersion: 2,
    });
    expect(() => prepare(first.managedRoot, schemaTwo)).toThrow(
      /schema_version must be exactly 1/,
    );

    const second = createManagedRoot();
    const escaping = stageRelease(second.managedRoot, 'escaping-link');
    const outside = join(second.root, 'outside');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(escaping.releaseDirectory, 'prefix/outside-link'));
    expect(() => prepare(second.managedRoot, escaping)).toThrow(
      /symlink target must be a relative POSIX path/,
    );

    const third = createManagedRoot();
    const pinned = stageRelease(third.managedRoot, 'pinned-release');
    expect(() =>
      prepareManagedProductRelease({
        managedReleasesRoot: third.managedRoot,
        releaseId: pinned.releaseId,
        expectedSourceSha: '9'.repeat(40),
        expectedVersion: pinned.version,
        expectedArtifactSha256: pinned.artifactSha256,
        expectedArtifactManifestSha256: pinned.artifactManifestSha256,
      }),
    ).toThrow(/source\/version\/artifact identity mismatch/);
  });

  it('detects every deployed-tree addition or byte change after sealing', () => {
    const { managedRoot } = createManagedRoot();
    const staged = stageRelease(managedRoot, 'tamper-target');
    const prepared = prepare(managedRoot, staged);
    const cli = join(
      staged.releaseDirectory,
      'prefix/node_modules/echo-brain/dist/product/cli.js',
    );
    chmodSync(staged.releaseDirectory, 0o755);
    chmodSync(dirname(cli), 0o755);
    chmodSync(cli, 0o755);
    writeFileSync(cli, '#!/usr/bin/env node\nthrow new Error("tampered");\n');
    chmodSync(cli, 0o555);
    chmodSync(dirname(cli), 0o555);
    chmodSync(staged.releaseDirectory, 0o555);

    expect(() =>
      verifyManagedProductRelease({
        managedReleasesRoot: managedRoot,
        releaseId: staged.releaseId,
        expected: prepared.pin,
      }),
    ).toThrow(/installed product package byte mismatch/);

    const extra = stageRelease(managedRoot, 'extra-target');
    const extraPrepared = prepare(managedRoot, extra);
    chmodSync(extra.releaseDirectory, 0o755);
    writeFileSync(join(extra.releaseDirectory, 'unexpected.txt'), 'unexpected', {
      mode: 0o444,
    });
    chmodSync(extra.releaseDirectory, 0o555);
    expect(() =>
      verifyManagedProductRelease({
        managedReleasesRoot: managedRoot,
        releaseId: extra.releaseId,
        expected: extraPrepared.pin,
      }),
    ).toThrow(/unexpected top-level entries/);
  });

  it('rejects staged bytes, retained tarballs, or install locks that are not the pinned artifact', () => {
    const first = createManagedRoot();
    const changedPackage = stageRelease(first.managedRoot, 'changed-package');
    writeFileSync(
      join(
        changedPackage.releaseDirectory,
        'prefix/node_modules/echo-brain/dist/product/cli.js',
      ),
      '#!/usr/bin/env node\nthrow new Error("not from artifact");\n',
    );
    expect(() => prepare(first.managedRoot, changedPackage)).toThrow(
      /installed product package byte mismatch/,
    );

    const second = createManagedRoot();
    const changedTarball = stageRelease(second.managedRoot, 'changed-tarball');
    writeFileSync(changedTarball.artifactPath, 'not the pinned tarball');
    expect(() => prepare(second.managedRoot, changedTarball)).toThrow(
      /retained release artifact does not match/,
    );

    const third = createManagedRoot();
    const changedLock = stageRelease(third.managedRoot, 'changed-lock');
    writeFileSync(
      join(changedLock.releaseDirectory, 'prefix/package-lock.json'),
      `${JSON.stringify({ lockfileVersion: 3 })}\n`,
    );
    expect(() => prepare(third.managedRoot, changedLock)).toThrow(
      /installation lock does not match/,
    );

    const fourth = createManagedRoot();
    const unauthenticated = stageRelease(
      fourth.managedRoot,
      'unauthenticated-qualification',
    );
    writeFileSync(
      join(unauthenticated.releaseDirectory, 'qualification-report.json'),
      '{"result":"qualified"}\n',
    );
    expect(() => prepare(fourth.managedRoot, unauthenticated)).toThrow(
      /unexpected top-level entries/,
    );
  });

  it('atomically switches the stable current path and retains a committed durable marker', () => {
    const { managedRoot } = createManagedRoot();
    const previous = prepare(
      managedRoot,
      stageRelease(managedRoot, 'previous-release'),
    );
    const candidate = prepare(
      managedRoot,
      stageRelease(managedRoot, 'candidate-release'),
    );
    symlinkSync(
      'previous-release',
      join(managedRoot, MANAGED_PRODUCT_CURRENT_POINTER),
      'dir',
    );

    const switched = switchManagedProductRelease(
      switchOptions(
        managedRoot,
        'candidate-release',
        candidate.pin,
        'promote-candidate',
      ),
    );
    expect(previous.pin.version).toBe('1.0.0-previous-release');
    expect(readlinkSync(join(managedRoot, 'current'))).toBe('candidate-release');
    const stableExecutable = managedProductCurrentExecutablePath(managedRoot);
    expect(stableExecutable).toContain('/current/prefix/node_modules/.bin/echo-brain');
    expect(realpathSync(stableExecutable)).toBe(
      join(
        candidate.releaseDirectory,
        'prefix/node_modules/echo-brain/dist/product/cli.js',
      ),
    );
    expect(switched.marker).toMatchObject({
      schema_version: 1,
      phase: 'committed',
      previous_release_id: 'previous-release',
      release_id: 'candidate-release',
    });
    expect(JSON.parse(readFileSync(switched.markerPath!, 'utf8'))).toEqual(
      switched.marker,
    );
    expect(switched.evidence).toMatchObject({
      switched: true,
      previous_release_id: 'previous-release',
      release_id: 'candidate-release',
      marker_sha256: sha256(readFileSync(switched.markerPath!)),
    });

    const unchanged = switchManagedProductRelease(
      switchOptions(
        managedRoot,
        'candidate-release',
        candidate.pin,
        'already-current',
      ),
    );
    expect(unchanged.evidence.switched).toBe(false);
    expect(unchanged.markerPath).toBeNull();
  });

  it('reverts the pointer and durably reports every injected post-switch failure', () => {
    const { managedRoot } = createManagedRoot();
    prepare(managedRoot, stageRelease(managedRoot, 'stable-release'));
    const candidate = prepare(
      managedRoot,
      stageRelease(managedRoot, 'faulty-release'),
    );
    symlinkSync('stable-release', join(managedRoot, 'current'), 'dir');
    const options = switchOptions(
      managedRoot,
      'faulty-release',
      candidate.pin,
      'fail-after-commit',
    );
    options.faultInjector = (point) => {
      if (point === 'after_commit_marker') throw new Error('simulated post-switch failure');
    };

    let thrown: unknown;
    try {
      switchManagedProductRelease(options);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ManagedProductReleaseSwitchError);
    expect((thrown as ManagedProductReleaseSwitchError).revert).toMatchObject({
      attempted: true,
      status: 'reverted',
      previousReleaseId: 'stable-release',
      markerPhase: 'reverted',
      markerUpdated: true,
    });
    expect(readlinkSync(join(managedRoot, 'current'))).toBe('stable-release');
    expect(
      JSON.parse(
        readFileSync(
          join(managedRoot, '.release-switch-fail-after-commit.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      phase: 'reverted',
      failure_stage: 'commit-marker',
    });
  });

  it('reports a failed revert without hiding that the candidate remains selected', () => {
    const { managedRoot } = createManagedRoot();
    prepare(managedRoot, stageRelease(managedRoot, 'known-good'));
    const candidate = prepare(
      managedRoot,
      stageRelease(managedRoot, 'cannot-revert'),
    );
    symlinkSync('known-good', join(managedRoot, 'current'), 'dir');
    const options = switchOptions(
      managedRoot,
      'cannot-revert',
      candidate.pin,
      'reported-revert-failure',
    );
    options.faultInjector = (point) => {
      if (point === 'after_pointer_switch') throw new Error('primary failure');
      if (point === 'before_pointer_revert') throw new Error('simulated disk failure');
    };

    let thrown: unknown;
    try {
      switchManagedProductRelease(options);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ManagedProductReleaseSwitchError);
    expect((thrown as ManagedProductReleaseSwitchError).revert).toMatchObject({
      status: 'failed',
      markerPhase: 'revert-failed',
      markerUpdated: true,
      error: 'simulated disk failure',
    });
    expect(readlinkSync(join(managedRoot, 'current'))).toBe('cannot-revert');

    const recovered = recoverManagedProductReleaseSwitch({
      managedReleasesRoot: managedRoot,
      operationId: 'reported-revert-failure',
    });
    expect(recovered).toMatchObject({
      recovered: true,
      marker: { phase: 'reverted', failure_stage: 'journal-recovery' },
    });
    expect(readlinkSync(join(managedRoot, 'current'))).toBe('known-good');
  });
});
