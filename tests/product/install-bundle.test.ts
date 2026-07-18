import { createHash } from 'node:crypto';
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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- the shipped installer is an executable plain-ESM tool.
import { installProductBundle } from '../../tools/product/install-bundle.mjs';
// @ts-expect-error -- the shipped verifier is an executable plain-ESM tool.
import { verifyBundle } from '../../tools/product/verify-bundle.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const VERSION = '0.1.0-dev.install-test';
const NODE_VERSION = '22.22.1';
const FIXED_TIME = '2026-07-18T20:00:00.000Z';
const MANAGED_API_CONTENT = 'export const syntheticManagedReleaseApi = true;\n';
const roots: string[] = [];

interface BundleFixture {
  root: string;
  artifactPath: string;
  artifactSha256: string;
  sourceSha: string;
  version: string;
}

interface OfflineInstallInput {
  artifact: string;
  artifactManifest: string;
  supportDir: string;
  prefix: string;
}

interface PreparedReleaseInput {
  managedReleasesRoot: string;
  releaseId: string;
  expectedSourceSha: string;
  expectedVersion: string;
  expectedArtifactSha256: string;
  expectedArtifactManifestSha256: string;
}

interface VerifyReleaseInput {
  managedReleasesRoot: string;
  releaseId: string;
  expected: ReleasePin;
}

interface SwitchReleaseInput extends VerifyReleaseInput {
  operationId: string;
  switchedAt: string;
}

interface ReleasePin {
  sourceSha: string;
  version: string;
  artifactSha256: string;
  artifactManifestSha256: string;
  deployedTreeManifestSha256: string;
  qualificationReport: null;
}

function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'echo-install-bundle-test-')),
  );
  roots.push(root);
  return root;
}

function pathExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function makeBundle(
  parent: string,
  name: string,
  options: {
    version?: string;
    sourceSha?: string;
    artifactContent?: string;
  } = {},
): BundleFixture {
  const root = join(parent, name);
  const artifactDirectory = join(root, 'artifact');
  const supportDirectory = join(root, 'qualification-support');
  mkdirSync(artifactDirectory, { recursive: true });
  mkdirSync(supportDirectory, { recursive: true });

  const version = options.version ?? VERSION;
  const sourceSha = options.sourceSha ?? SOURCE_SHA;
  const artifactName = `echo-brain-${version}.tgz`;
  const artifactPath = join(artifactDirectory, artifactName);
  const artifactContent =
    options.artifactContent ?? `synthetic artifact for ${version}\n`;
  const packageJsonContent = `${JSON.stringify({ name: 'echo-brain', version, type: 'module' })}\n`;
  const cliContent = '#!/usr/bin/env node\n';
  writeFileSync(artifactPath, artifactContent);
  const artifactSha256 = sha256Bytes(artifactContent);
  const dependencyLockSha256 = 'b'.repeat(64);
  writeFileSync(
    join(artifactDirectory, 'artifact-manifest.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        package: 'echo-brain',
        version,
        source_sha: sourceSha,
        declared_platform: {
          os: 'darwin',
          architecture: 'arm64',
          node: NODE_VERSION,
        },
        dependency_lock_sha256: dependencyLockSha256,
        artifact: {
          path: artifactName,
          size: Buffer.byteLength(artifactContent),
          sha256: artifactSha256,
        },
        package_files: [
          {
            path: 'package.json',
            size: Buffer.byteLength(packageJsonContent),
            sha256: sha256Bytes(packageJsonContent),
          },
          {
            path: 'dist/product/cli.js',
            size: Buffer.byteLength(cliContent),
            sha256: sha256Bytes(cliContent),
          },
          {
            path: 'dist/product/artifact-rollback.js',
            size: Buffer.byteLength(MANAGED_API_CONTENT),
            sha256: sha256Bytes(MANAGED_API_CONTENT),
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    `${artifactPath}.sha256`,
    `${artifactSha256}  ${artifactName}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(supportDirectory, 'support-manifest.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        node: {
          version: NODE_VERSION,
          modules: '127',
          platform: 'darwin',
          architecture: 'arm64',
        },
        dependency_lock_sha256: dependencyLockSha256,
        entries: [],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { root, artifactPath, artifactSha256, sourceSha, version };
}

function fakeOfflineInstaller(
  calls: string[],
  behavior: 'pass' | 'fail' = 'pass',
): (input: OfflineInstallInput) => {
  ok: boolean;
  stage: string;
  npm_invoked: boolean;
  npm_status: number;
} {
  return (input) => {
    calls.push('install');
    const installedVersion = JSON.parse(
      readFileSync(input.artifactManifest, 'utf8'),
    ).version as string;
    const packageRoot = join(input.prefix, 'node_modules/echo-brain');
    const productRoot = join(packageRoot, 'dist/product');
    const binRoot = join(input.prefix, 'node_modules/.bin');
    mkdirSync(productRoot, { recursive: true });
    mkdirSync(binRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({ name: 'echo-brain', version: installedVersion, type: 'module' })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(join(productRoot, 'cli.js'), '#!/usr/bin/env node\n', {
      mode: 0o700,
    });
    writeFileSync(
      join(productRoot, 'artifact-rollback.js'),
      MANAGED_API_CONTENT,
      { mode: 0o600 },
    );
    symlinkSync(
      '../echo-brain/dist/product/cli.js',
      join(binRoot, 'echo-brain'),
    );
    if (behavior === 'fail') {
      writeFileSync(
        join(input.prefix, 'partial-install-sentinel'),
        'partial\n',
      );
      return {
        ok: false,
        stage: 'npm-ci',
        npm_invoked: true,
        npm_status: 1,
      };
    }
    return {
      ok: true,
      stage: 'npm-ci',
      npm_invoked: true,
      npm_status: 0,
    };
  };
}

function managedReleaseApi(calls: string[]) {
  function verified(input: VerifyReleaseInput) {
    return {
      releaseDirectory: join(input.managedReleasesRoot, input.releaseId),
      executablePath: join(
        input.managedReleasesRoot,
        input.releaseId,
        'prefix/node_modules/.bin/echo-brain',
      ),
      pin: input.expected,
    };
  }

  return {
    prepareManagedProductRelease: (input: PreparedReleaseInput) => {
      calls.push('prepare');
      const releaseDirectory = join(input.managedReleasesRoot, input.releaseId);
      const deployedManifestPath = join(
        releaseDirectory,
        'deployed-tree-manifest.json',
      );
      const manifest = {
        schema_version: 1,
        kind: 'echo-product-managed-release',
        release_id: input.releaseId,
        artifact: {
          source_sha: input.expectedSourceSha,
          version: input.expectedVersion,
          sha256: input.expectedArtifactSha256,
          manifest_sha256: input.expectedArtifactManifestSha256,
        },
      };
      writeFileSync(deployedManifestPath, `${JSON.stringify(manifest)}\n`, {
        mode: 0o400,
      });
      const pin: ReleasePin = {
        sourceSha: input.expectedSourceSha,
        version: input.expectedVersion,
        artifactSha256: input.expectedArtifactSha256,
        artifactManifestSha256: input.expectedArtifactManifestSha256,
        deployedTreeManifestSha256: sha256File(deployedManifestPath),
        qualificationReport: null,
      };
      return verified({
        managedReleasesRoot: input.managedReleasesRoot,
        releaseId: input.releaseId,
        expected: pin,
      });
    },
    verifyManagedProductRelease: (input: VerifyReleaseInput) => {
      calls.push('verify-release');
      return verified(input);
    },
    recoverManagedProductReleaseSwitch: (input: {
      managedReleasesRoot: string;
      operationId: string;
    }) => {
      calls.push('recover-switch');
      const markerPath = join(
        input.managedReleasesRoot,
        `.release-switch-${input.operationId}.json`,
      );
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
        previous_release_id: string | null;
        phase: string;
      };
      const current = join(input.managedReleasesRoot, 'current');
      if (pathExists(current)) unlinkSync(current);
      if (marker.previous_release_id !== null) {
        symlinkSync(marker.previous_release_id, current, 'dir');
      }
      writeFileSync(
        markerPath,
        `${JSON.stringify({ ...marker, phase: 'reverted', failure_stage: 'journal-recovery' })}\n`,
        { mode: 0o600 },
      );
      return {
        recovered: true,
        markerPath,
        marker: { ...marker, phase: 'reverted' },
      };
    },
    switchManagedProductRelease: (input: SwitchReleaseInput) => {
      calls.push('switch');
      const current = join(input.managedReleasesRoot, 'current');
      const previous = pathExists(current) ? readlinkSync(current) : null;
      if (previous !== input.releaseId) {
        if (pathExists(current)) unlinkSync(current);
        symlinkSync(input.releaseId, current, 'dir');
      }
      return {
        verifiedRelease: verified(input),
        evidence: { switched: previous !== input.releaseId },
      };
    },
  };
}

function successfulCli(
  calls: string[][],
): (args: string[]) => { status: number; stdout: string; stderr: string } {
  return (args) => {
    calls.push([...args]);
    if (args[0] === '--version') {
      return { status: 0, stdout: `${VERSION}\n`, stderr: '' };
    }
    if (args[0] === 'onboard') {
      const configPath = args[args.indexOf('--config') + 1]!;
      const stateDirectory = args[args.indexOf('--state-dir') + 1]!;
      const credentialsDirectory = join(stateDirectory, 'credentials');
      mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
      mkdirSync(credentialsDirectory, { recursive: true, mode: 0o700 });
      chmodSync(dirname(configPath), 0o700);
      chmodSync(stateDirectory, 0o700);
      chmodSync(credentialsDirectory, 0o700);
      writeFileSync(
        configPath,
        `${JSON.stringify({ schema_version: 1, state_dir: stateDirectory })}\n`,
        { mode: 0o600 },
      );
      chmodSync(configPath, 0o600);
      return {
        status: 0,
        stdout: `${JSON.stringify({
          ok: true,
          credential_path: join(credentialsDirectory, 'granola-api-key'),
        })}\n`,
        stderr: '',
      };
    }
    return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
  };
}

function verifiedBundle(input: { artifactDir: string; supportDir: string }) {
  return verifyBundle(input);
}

function baseDependencies(
  managedCalls: string[],
  cliCalls: string[][],
  install: ReturnType<typeof fakeOfflineInstaller>,
) {
  const api = managedReleaseApi(managedCalls);
  return {
    platform: 'darwin',
    architecture: 'arm64',
    nodeVersion: NODE_VERSION,
    nodePath: '/synthetic/native-arm64-node',
    now: () => FIXED_TIME,
    installOffline: install,
    loadManagedReleaseApi: async () => api,
    runCli: successfulCli(cliCalls),
  };
}

function fileSnapshot(root: string): Array<{
  path: string;
  kind: 'file' | 'symlink';
  content: string;
}> {
  const entries: Array<{
    path: string;
    kind: 'file' | 'symlink';
    content: string;
  }> = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isSymbolicLink()) {
        entries.push({
          path: relative(root, path).split(sep).join('/'),
          kind: 'symlink',
          content: readlinkSync(path),
        });
      } else if (entry.isFile()) {
        entries.push({
          path: relative(root, path).split(sep).join('/'),
          kind: 'file',
          content: sha256File(path),
        });
      }
    }
  }
  visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('extracted product-bundle installer', () => {
  it('requires an independently supplied artifact digest before creating install paths', async () => {
    const root = temporaryRoot();
    const bundle = makeBundle(root, 'missing-expected-digest-bundle');
    const installRoot = join(root, 'installed');

    await expect(
      installProductBundle(
        { bundleRoot: bundle.root, installRoot },
        baseDependencies([], [], fakeOfflineInstaller([])),
      ),
    ).rejects.toThrow('expected artifact SHA-256 is required');
    expect(pathExists(installRoot)).toBe(false);
  });

  it('retains the authenticated checksum sidecar for the offline installer contract', async () => {
    const root = temporaryRoot();
    const bundle = makeBundle(root, 'sidecar-contract-bundle');
    const installRoot = join(root, 'installed');
    const lifecycleCalls: string[] = [];
    const fakeInstall = fakeOfflineInstaller(lifecycleCalls);
    const dependencies = {
      ...baseDependencies(lifecycleCalls, [], fakeInstall),
      installOffline: (input: OfflineInstallInput) => {
        const retained = verifyBundle({
          artifactDir: dirname(input.artifactManifest),
          supportDir: input.supportDir,
        });
        expect(retained).toMatchObject({ ok: true, errors: [] });
        expect(readFileSync(`${input.artifact}.sha256`, 'utf8')).toBe(
          `${bundle.artifactSha256}  ${basename(input.artifact)}\n`,
        );
        return fakeInstall(input);
      },
    };

    const installed = await installProductBundle(
      {
        bundleRoot: bundle.root,
        installRoot,
        expectedArtifactSha256: bundle.artifactSha256,
      },
      dependencies,
    );

    expect(installed).toMatchObject({ ok: true, changed: true });
    expect(
      pathExists(
        join(
          installed.paths.release_dir,
          `${basename(bundle.artifactPath)}.sha256`,
        ),
      ),
    ).toBe(false);
  });

  it('verifies before writes, installs without onboarding by default, writes private evidence, and reruns exactly as a no-op', async () => {
    const root = temporaryRoot();
    const bundle = makeBundle(root, 'extracted-bundle');
    const installRoot = join(root, 'installed');
    const firstEvidence = join(installRoot, 'evidence', 'first.json');
    const secondEvidence = join(installRoot, 'evidence', 'second.json');
    const lifecycleCalls: string[] = [];
    const cliCalls: string[][] = [];
    const install = fakeOfflineInstaller(lifecycleCalls);
    const dependencies = {
      ...baseDependencies(lifecycleCalls, cliCalls, install),
      verifyBundle: (input: { artifactDir: string; supportDir: string }) => {
        expect(pathExists(installRoot)).toBe(false);
        expect(pathExists(firstEvidence)).toBe(false);
        lifecycleCalls.push('verify-bundle');
        return verifiedBundle(input);
      },
    };

    const first = await installProductBundle(
      {
        bundleRoot: bundle.root,
        installRoot,
        expectedArtifactSha256: bundle.artifactSha256,
        evidencePath: firstEvidence,
      },
      dependencies,
    );

    expect(lifecycleCalls.slice(0, 3)).toEqual([
      'verify-bundle',
      'install',
      'prepare',
    ]);
    expect(first).toMatchObject({
      ok: true,
      changed: true,
      artifact: {
        version: bundle.version,
        source_sha: bundle.sourceSha,
        sha256: bundle.artifactSha256,
      },
      onboard: { requested: false, changed: false },
      live_contact: false,
      service_installed: false,
    });
    expect(cliCalls.map((args) => args[0])).toEqual([
      '--version',
      'onboard',
      'selftest',
    ]);
    expect(lstatSync(firstEvidence).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(firstEvidence, 'utf8'))).toEqual(first);
    expect(readlinkSync(first.paths.current)).toBe(first.release_id);
    expect(existsSync(first.paths.cli)).toBe(true);
    const installedSnapshot = fileSnapshot(first.paths.release_dir);

    dependencies.verifyBundle = (input: {
      artifactDir: string;
      supportDir: string;
    }) => {
      lifecycleCalls.push('verify-bundle');
      return verifiedBundle(input);
    };
    const repeated = await installProductBundle(
      {
        bundleRoot: bundle.root,
        installRoot,
        expectedArtifactSha256: bundle.artifactSha256,
        evidencePath: secondEvidence,
      },
      dependencies,
    );

    expect(repeated).toMatchObject({
      ok: true,
      changed: false,
      release_id: first.release_id,
      onboard: { requested: false, changed: false },
    });
    expect(lifecycleCalls.filter((call) => call === 'install')).toHaveLength(1);
    expect(lifecycleCalls.filter((call) => call === 'prepare')).toHaveLength(1);
    expect(fileSnapshot(first.paths.release_dir)).toEqual(installedSnapshot);
    expect(lstatSync(secondEvidence).mode & 0o777).toBe(0o600);
  });

  it('runs only secret-free onboarding when explicitly requested and keeps an exact repeat idempotent', async () => {
    const root = temporaryRoot();
    const bundle = makeBundle(root, 'extracted-bundle');
    const installRoot = join(root, 'installed');
    const configPath = join(root, 'config', 'runtime.json');
    const stateDirectory = join(root, 'state');
    const lifecycleCalls: string[] = [];
    const cliCalls: string[][] = [];
    const dependencies = baseDependencies(
      lifecycleCalls,
      cliCalls,
      fakeOfflineInstaller(lifecycleCalls),
    );

    const first = await installProductBundle(
      {
        bundleRoot: bundle.root,
        installRoot,
        expectedArtifactSha256: bundle.artifactSha256,
        evidencePath: join(installRoot, 'evidence', 'first-onboard.json'),
        onboard: { configPath, stateDirectory },
      },
      dependencies,
    );

    expect(first.onboard).toMatchObject({
      requested: true,
      changed: true,
      config_path: configPath,
      state_dir: stateDirectory,
      credential_path: join(stateDirectory, 'credentials/granola-api-key'),
    });
    expect(cliCalls.map((args) => args[0])).toEqual([
      '--version',
      'onboard',
      'selftest',
      'onboard',
      'validate-config',
      'selftest',
    ]);
    expect(lstatSync(configPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(stateDirectory).mode & 0o777).toBe(0o700);
    expect(pathExists(first.onboard.credential_path)).toBe(false);

    cliCalls.length = 0;
    const repeated = await installProductBundle(
      {
        bundleRoot: bundle.root,
        installRoot,
        expectedArtifactSha256: bundle.artifactSha256,
        evidencePath: join(installRoot, 'evidence', 'second-onboard.json'),
        onboard: { configPath, stateDirectory },
      },
      dependencies,
    );

    expect(repeated).toMatchObject({
      changed: false,
      onboard: { requested: true, changed: false },
    });
    expect(cliCalls.map((args) => args[0])).toEqual([
      '--version',
      'onboard',
      'selftest',
      'validate-config',
      'selftest',
    ]);
  });

  it('reports a change when onboarding is added to an already selected exact release', async () => {
    const root = temporaryRoot();
    const bundle = makeBundle(root, 'deferred-onboard-bundle');
    const installRoot = join(root, 'installed');
    const lifecycleCalls: string[] = [];
    const dependencies = baseDependencies(
      lifecycleCalls,
      [],
      fakeOfflineInstaller(lifecycleCalls),
    );
    await installProductBundle(
      {
        bundleRoot: bundle.root,
        installRoot,
        expectedArtifactSha256: bundle.artifactSha256,
        evidencePath: join(installRoot, 'evidence', 'install.json'),
      },
      dependencies,
    );

    const onboarded = await installProductBundle(
      {
        bundleRoot: bundle.root,
        installRoot,
        expectedArtifactSha256: bundle.artifactSha256,
        evidencePath: join(installRoot, 'evidence', 'onboard.json'),
        onboard: {
          configPath: join(root, 'config', 'runtime.json'),
          stateDirectory: join(root, 'state'),
        },
      },
      dependencies,
    );

    expect(onboarded.changed).toBe(true);
    expect(onboarded.onboard).toMatchObject({ requested: true, changed: true });
  });

  it('rejects tampered artifact bytes before creating install or evidence paths', async () => {
    const root = temporaryRoot();
    const bundle = makeBundle(root, 'tampered-bundle');
    const installRoot = join(root, 'installed');
    const evidencePath = join(installRoot, 'evidence', 'tampered.json');
    const lifecycleCalls: string[] = [];
    const cliCalls: string[][] = [];
    writeFileSync(bundle.artifactPath, 'tampered\n', { flag: 'a' });

    await expect(
      installProductBundle(
        {
          bundleRoot: bundle.root,
          installRoot,
          expectedArtifactSha256: bundle.artifactSha256,
          evidencePath,
        },
        {
          ...baseDependencies(
            lifecycleCalls,
            cliCalls,
            fakeOfflineInstaller(lifecycleCalls),
          ),
          verifyBundle: verifiedBundle,
        },
      ),
    ).rejects.toThrow(
      /bundle verification failed.*artifact (?:size|SHA-256) mismatch/i,
    );

    expect(lifecycleCalls).not.toContain('install');
    expect(pathExists(installRoot)).toBe(false);
    expect(pathExists(evidencePath)).toBe(false);
    expect(cliCalls).toEqual([]);
  });

  it('refuses to adopt a nonempty unmarked install root without changing it', async () => {
    const root = temporaryRoot();
    const bundle = makeBundle(root, 'unmanaged-root-bundle');
    const installRoot = join(root, 'existing-directory');
    mkdirSync(installRoot, { mode: 0o755 });
    const sentinel = join(installRoot, 'user-file');
    writeFileSync(sentinel, 'keep me\n');
    const modeBefore = lstatSync(installRoot).mode & 0o777;
    const calls: string[] = [];

    await expect(
      installProductBundle(
        {
          bundleRoot: bundle.root,
          installRoot,
          expectedArtifactSha256: bundle.artifactSha256,
        },
        baseDependencies(calls, [], fakeOfflineInstaller(calls)),
      ),
    ).rejects.toThrow('install root must be absent or empty');

    expect(readFileSync(sentinel, 'utf8')).toBe('keep me\n');
    expect(lstatSync(installRoot).mode & 0o777).toBe(modeBefore);
    expect(calls).not.toContain('install');
  });

  it('rejects overlapping roots and evidence outside the managed evidence directory', async () => {
    const root = temporaryRoot();
    const bundle = makeBundle(root, 'topology-bundle');
    const calls: string[] = [];
    const dependencies = baseDependencies(
      calls,
      [],
      fakeOfflineInstaller(calls),
    );

    await expect(
      installProductBundle(
        {
          bundleRoot: bundle.root,
          installRoot: join(bundle.root, 'nested-install'),
          expectedArtifactSha256: bundle.artifactSha256,
        },
        dependencies,
      ),
    ).rejects.toThrow('must be disjoint');

    const installRoot = join(root, 'managed-install');
    const outsideEvidence = join(root, 'outside-evidence.json');
    await expect(
      installProductBundle(
        {
          bundleRoot: bundle.root,
          installRoot,
          expectedArtifactSha256: bundle.artifactSha256,
          evidencePath: outsideEvidence,
        },
        dependencies,
      ),
    ).rejects.toThrow('evidence path must be inside');
    expect(pathExists(outsideEvidence)).toBe(false);
    expect(calls).not.toContain('install');
  });

  it.each([
    {
      name: 'operating system',
      override: { platform: 'linux' },
      observed: 'linux/arm64 Node 22.22.1',
    },
    {
      name: 'architecture',
      override: { architecture: 'x64' },
      observed: 'darwin/x64 Node 22.22.1',
    },
    {
      name: 'Node version',
      override: { nodeVersion: '22.21.0' },
      observed: 'darwin/arm64 Node 22.21.0',
    },
  ])(
    'rejects the wrong $name before installation',
    async ({ override, observed }) => {
      const root = temporaryRoot();
      const bundle = makeBundle(root, 'wrong-platform-bundle');
      const installRoot = join(root, 'installed');
      const lifecycleCalls: string[] = [];
      const cliCalls: string[][] = [];

      await expect(
        installProductBundle(
          {
            bundleRoot: bundle.root,
            installRoot,
            expectedArtifactSha256: bundle.artifactSha256,
            evidencePath: join(installRoot, 'evidence', 'wrong-target.json'),
          },
          {
            ...baseDependencies(
              lifecycleCalls,
              cliCalls,
              fakeOfflineInstaller(lifecycleCalls),
            ),
            ...override,
            verifyBundle: verifiedBundle,
          },
        ),
      ).rejects.toThrow(
        `bundle requires darwin/arm64 Node ${NODE_VERSION}; observed ${observed}`,
      );
      expect(lifecycleCalls).not.toContain('install');
      expect(pathExists(installRoot)).toBe(false);
      expect(cliCalls).toEqual([]);
    },
  );

  it('recovers a stale lock and half-sealed read-only release before reinstalling', async () => {
    const root = temporaryRoot();
    const bundle = makeBundle(root, 'crash-bundle');
    const installRoot = join(root, 'installed');
    const failedCalls: string[] = [];
    await expect(
      installProductBundle(
        {
          bundleRoot: bundle.root,
          installRoot,
          expectedArtifactSha256: bundle.artifactSha256,
          evidencePath: join(installRoot, 'evidence', 'initial-failure.json'),
        },
        baseDependencies(
          failedCalls,
          [],
          fakeOfflineInstaller(failedCalls, 'fail'),
        ),
      ),
    ).rejects.toThrow('offline installation failed');

    const releaseId = `${bundle.version}-${bundle.sourceSha.slice(0, 12)}`;
    const partialRelease = join(installRoot, 'releases', releaseId);
    const partialPrefix = join(partialRelease, 'prefix', 'nested');
    mkdirSync(partialPrefix, { recursive: true, mode: 0o700 });
    writeFileSync(join(partialPrefix, 'partial'), 'crash residue\n');
    chmodSync(partialPrefix, 0o555);
    chmodSync(dirname(partialPrefix), 0o555);
    chmodSync(partialRelease, 0o555);
    writeFileSync(
      join(installRoot, '.install.lock'),
      `${JSON.stringify({
        schema_version: 1,
        pid: 999999,
        token: `999999-${'e'.repeat(32)}`,
      })}\n`,
      { mode: 0o600 },
    );

    const retryCalls: string[] = [];
    const result = await installProductBundle(
      {
        bundleRoot: bundle.root,
        installRoot,
        expectedArtifactSha256: bundle.artifactSha256,
        evidencePath: join(installRoot, 'evidence', 'retry.json'),
      },
      baseDependencies(retryCalls, [], fakeOfflineInstaller(retryCalls)),
    );

    expect(result.ok).toBe(true);
    expect(retryCalls).toContain('install');
    expect(pathExists(join(partialPrefix, 'partial'))).toBe(false);
    expect(pathExists(join(installRoot, '.install.lock'))).toBe(false);
  });

  it.each(['before-pointer', 'after-pointer'])(
    'recovers an exact prepared switch journal from a crash $0',
    async (point) => {
      const root = temporaryRoot();
      const bundle = makeBundle(root, `switch-crash-${point}`);
      const installRoot = join(root, 'installed');
      const lifecycleCalls: string[] = [];
      const dependencies = baseDependencies(
        lifecycleCalls,
        [],
        fakeOfflineInstaller(lifecycleCalls),
      );
      const first = await installProductBundle(
        {
          bundleRoot: bundle.root,
          installRoot,
          expectedArtifactSha256: bundle.artifactSha256,
          evidencePath: join(installRoot, 'evidence', 'first.json'),
        },
        dependencies,
      );
      const deployedManifestPath = join(
        first.paths.release_dir,
        'deployed-tree-manifest.json',
      );
      const retainedManifestPath = join(
        first.paths.release_dir,
        'artifact-manifest.json',
      );
      const operationId = `install-${bundle.version}-${bundle.sourceSha.slice(0, 12)}-crash-4242`;
      const markerPath = join(
        installRoot,
        'releases',
        `.release-switch-${operationId}.json`,
      );
      writeFileSync(
        markerPath,
        `${JSON.stringify({
          schema_version: 1,
          kind: 'echo-product-release-switch',
          operation_id: operationId,
          switched_at: FIXED_TIME,
          phase: 'prepared',
          previous_release_id: null,
          release_id: first.release_id,
          source_sha: bundle.sourceSha,
          version: bundle.version,
          artifact_sha256: bundle.artifactSha256,
          artifact_manifest_sha256: sha256File(retainedManifestPath),
          deployed_tree_manifest_sha256: sha256File(deployedManifestPath),
          qualification_report_sha256: null,
          failure_stage: null,
        })}\n`,
        { mode: 0o600 },
      );
      if (point === 'before-pointer') unlinkSync(first.paths.current);

      const repeated = await installProductBundle(
        {
          bundleRoot: bundle.root,
          installRoot,
          expectedArtifactSha256: bundle.artifactSha256,
          evidencePath: join(installRoot, 'evidence', `${point}.json`),
        },
        dependencies,
      );

      expect(repeated.ok).toBe(true);
      expect(lifecycleCalls).toContain('recover-switch');
      expect(readlinkSync(first.paths.current)).toBe(first.release_id);
      expect(JSON.parse(readFileSync(markerPath, 'utf8')).phase).toBe(
        'reverted',
      );
    },
  );

  it('refuses an inexact incomplete switch journal without changing it', async () => {
    const root = temporaryRoot();
    const bundle = makeBundle(root, 'foreign-switch');
    const installRoot = join(root, 'installed');
    const lifecycleCalls: string[] = [];
    const dependencies = baseDependencies(
      lifecycleCalls,
      [],
      fakeOfflineInstaller(lifecycleCalls),
    );
    const first = await installProductBundle(
      {
        bundleRoot: bundle.root,
        installRoot,
        expectedArtifactSha256: bundle.artifactSha256,
        evidencePath: join(installRoot, 'evidence', 'first.json'),
      },
      dependencies,
    );
    const operationId = 'foreign-operation-4242';
    const markerPath = join(
      installRoot,
      'releases',
      `.release-switch-${operationId}.json`,
    );
    const marker = `${JSON.stringify({
      schema_version: 1,
      kind: 'echo-product-release-switch',
      operation_id: operationId,
      phase: 'prepared',
      previous_release_id: null,
      release_id: first.release_id,
    })}\n`;
    writeFileSync(markerPath, marker, { mode: 0o600 });

    await expect(
      installProductBundle(
        {
          bundleRoot: bundle.root,
          installRoot,
          expectedArtifactSha256: bundle.artifactSha256,
          evidencePath: join(installRoot, 'evidence', 'foreign.json'),
        },
        dependencies,
      ),
    ).rejects.toThrow('is not owned by this exact first-install operation');
    expect(readFileSync(markerPath, 'utf8')).toBe(marker);
    expect(readlinkSync(first.paths.current)).toBe(first.release_id);
  });

  it('records activation failure, preserves the sealed candidate, and converges on retry', async () => {
    const root = temporaryRoot();
    const bundle = makeBundle(root, 'activation-failure');
    const installRoot = join(root, 'installed');
    const calls: string[] = [];
    const cliCalls: string[][] = [];
    const api = managedReleaseApi(calls);
    const failingDependencies = {
      ...baseDependencies(calls, cliCalls, fakeOfflineInstaller(calls)),
      loadManagedReleaseApi: async () => ({
        ...api,
        switchManagedProductRelease: () => {
          calls.push('switch-failure');
          throw new Error('synthetic pointer failure');
        },
      }),
    };
    const evidencePath = join(installRoot, 'evidence', 'failed-switch.json');

    await expect(
      installProductBundle(
        {
          bundleRoot: bundle.root,
          installRoot,
          expectedArtifactSha256: bundle.artifactSha256,
          evidencePath,
        },
        failingDependencies,
      ),
    ).rejects.toThrow('synthetic pointer failure');

    const releaseId = `${bundle.version}-${bundle.sourceSha.slice(0, 12)}`;
    expect(
      pathExists(
        join(installRoot, 'releases', releaseId, 'deployed-tree-manifest.json'),
      ),
    ).toBe(true);
    expect(pathExists(join(installRoot, 'releases', 'current'))).toBe(false);
    expect(pathExists(join(installRoot, 'bin', 'echo-brain'))).toBe(false);
    expect(JSON.parse(readFileSync(evidencePath, 'utf8'))).toMatchObject({
      ok: false,
      phase: 'activation-failed',
    });

    const retryCalls: string[] = [];
    const retried = await installProductBundle(
      {
        bundleRoot: bundle.root,
        installRoot,
        expectedArtifactSha256: bundle.artifactSha256,
        evidencePath: join(installRoot, 'evidence', 'retry-switch.json'),
      },
      baseDependencies(retryCalls, [], fakeOfflineInstaller(retryCalls)),
    );
    expect(retried.ok).toBe(true);
    expect(retryCalls).not.toContain('install');
  });

  it('records onboarding as a post-install partial failure and converges on retry', async () => {
    const root = temporaryRoot();
    const bundle = makeBundle(root, 'onboard-failure');
    const installRoot = join(root, 'installed');
    const configPath = join(root, 'config', 'runtime.json');
    const stateDirectory = join(root, 'state');
    const calls: string[] = [];
    const cliCalls: string[][] = [];
    const dependencies = baseDependencies(
      calls,
      cliCalls,
      fakeOfflineInstaller(calls),
    );
    const normalRunCli = dependencies.runCli;
    dependencies.runCli = (args: string[]) => {
      if (args[0] === 'onboard' && args.includes(configPath)) {
        return { status: 1, stdout: '', stderr: 'synthetic onboard failure' };
      }
      return normalRunCli(args);
    };
    const evidencePath = join(installRoot, 'evidence', 'failed-onboard.json');

    await expect(
      installProductBundle(
        {
          bundleRoot: bundle.root,
          installRoot,
          expectedArtifactSha256: bundle.artifactSha256,
          evidencePath,
          onboard: { configPath, stateDirectory },
        },
        dependencies,
      ),
    ).rejects.toThrow('synthetic onboard failure');

    expect(pathExists(join(installRoot, 'releases', 'current'))).toBe(true);
    expect(JSON.parse(readFileSync(evidencePath, 'utf8'))).toMatchObject({
      ok: false,
      install_ok: true,
      phase: 'onboarding-failed',
    });
    expect(pathExists(configPath)).toBe(false);

    const retryCalls: string[] = [];
    const retried = await installProductBundle(
      {
        bundleRoot: bundle.root,
        installRoot,
        expectedArtifactSha256: bundle.artifactSha256,
        evidencePath: join(installRoot, 'evidence', 'retry-onboard.json'),
        onboard: { configPath, stateDirectory },
      },
      baseDependencies(retryCalls, [], fakeOfflineInstaller(retryCalls)),
    );
    expect(retried).toMatchObject({
      ok: true,
      changed: true,
      onboard: { requested: true, changed: true },
    });
  });

  it('records a fresh-root npm failure, removes the unsealed release, and leaves no current launcher', async () => {
    const root = temporaryRoot();
    const bundle = makeBundle(root, 'failed-bundle');
    const installRoot = join(root, 'installed');
    const evidencePath = join(installRoot, 'evidence', 'failed.json');
    const lifecycleCalls: string[] = [];
    const cliCalls: string[][] = [];

    await expect(
      installProductBundle(
        {
          bundleRoot: bundle.root,
          installRoot,
          expectedArtifactSha256: bundle.artifactSha256,
          evidencePath,
          sourceArchive: {
            name: 'authenticated-download.zip',
            sha256: 'd'.repeat(64),
          },
        },
        baseDependencies(
          lifecycleCalls,
          cliCalls,
          fakeOfflineInstaller(lifecycleCalls, 'fail'),
        ),
      ),
    ).rejects.toThrow('offline installation failed at npm-ci');

    const failedReleaseId = `${bundle.version}-${bundle.sourceSha.slice(0, 12)}`;
    expect(lifecycleCalls).toContain('install');
    expect(lifecycleCalls).not.toContain('prepare');
    expect(pathExists(join(installRoot, 'releases', failedReleaseId))).toBe(
      false,
    );
    expect(pathExists(join(installRoot, 'releases', 'current'))).toBe(false);
    expect(pathExists(join(installRoot, 'bin', 'echo-brain'))).toBe(false);
    expect(cliCalls).toEqual([]);
    expect(JSON.parse(readFileSync(evidencePath, 'utf8'))).toMatchObject({
      ok: false,
      phase: 'release-preparation-failed',
      source_archive: {
        name: 'authenticated-download.zip',
        sha256: 'd'.repeat(64),
      },
    });
  });

  it('refuses a different-current upgrade and leaves the selected release byte-for-byte unchanged', async () => {
    const root = temporaryRoot();
    const stable = makeBundle(root, 'stable-bundle');
    const installRoot = join(root, 'installed');
    const stableCalls: string[] = [];
    const stableCliCalls: string[][] = [];
    const stableResult = await installProductBundle(
      {
        bundleRoot: stable.root,
        installRoot,
        expectedArtifactSha256: stable.artifactSha256,
        evidencePath: join(installRoot, 'evidence', 'stable.json'),
      },
      baseDependencies(
        stableCalls,
        stableCliCalls,
        fakeOfflineInstaller(stableCalls),
      ),
    );
    const stableSnapshot = fileSnapshot(stableResult.paths.release_dir);
    const launcherBefore = readFileSync(stableResult.paths.cli, 'utf8');

    const candidate = makeBundle(root, 'candidate-bundle', {
      version: '0.1.0-dev.install-failure',
      sourceSha: 'c'.repeat(40),
      artifactContent: 'candidate bytes\n',
    });
    const candidateCalls: string[] = [];
    const candidateCliCalls: string[][] = [];
    await expect(
      installProductBundle(
        {
          bundleRoot: candidate.root,
          installRoot,
          expectedArtifactSha256: candidate.artifactSha256,
          evidencePath: join(installRoot, 'evidence', 'candidate.json'),
        },
        baseDependencies(
          candidateCalls,
          candidateCliCalls,
          fakeOfflineInstaller(candidateCalls, 'fail'),
        ),
      ),
    ).rejects.toThrow('installer v1 refuses in-place upgrades');

    const failedReleaseId = `${candidate.version}-${candidate.sourceSha.slice(0, 12)}`;
    expect(candidateCalls).not.toContain('install');
    expect(candidateCalls).not.toContain('prepare');
    expect(pathExists(join(installRoot, 'releases', failedReleaseId))).toBe(
      false,
    );
    expect(readlinkSync(stableResult.paths.current)).toBe(
      stableResult.release_id,
    );
    expect(fileSnapshot(stableResult.paths.release_dir)).toEqual(
      stableSnapshot,
    );
    expect(readFileSync(stableResult.paths.cli, 'utf8')).toBe(launcherBefore);
    expect(candidateCliCalls).toEqual([]);
    expect(pathExists(join(installRoot, 'evidence', 'candidate.json'))).toBe(
      false,
    );
  });
});
