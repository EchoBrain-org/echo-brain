import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyInternalLiveUpdate,
  type InternalLiveDoctorSummary,
  type InternalLiveUpdateOperations,
  type InternalLiveUpdateReceiptV1,
  type InternalLiveUpdateStore,
  type InternalLiveUpdateTransactionV1,
} from '../../src/product/update/internal-live-update.js';
import {
  internalLiveManifestSha256,
  parseInternalLiveReleaseManifest,
  verifyInspectedInternalLivePackage,
  type InspectedInternalLivePackage,
} from '../../src/product/update/internal-live-release.js';
import { FileInternalLiveUpdateStore } from '../../src/product/update/internal-live-update-store.js';
import {
  internalLiveGlobalInstallLayout,
  internalLiveUpdateRoot,
  NodeInternalLiveUpdateOperations,
  type InternalLiveCommandRunner,
  type InternalLiveCommandResult,
} from '../../src/product/update/internal-live-node-operations.js';
import { acquireInternalLiveUpdateLock } from '../../src/product/update/internal-live-runner.js';
import type { ProductRuntimeConfig } from '../../src/product/config.js';

const SOURCE_SHA = '1'.repeat(40);
const OLD_SOURCE_SHA = '2'.repeat(40);
const ARTIFACT_SHA = 'a'.repeat(64);
const FILE_SHA = 'b'.repeat(64);
const temporaryRoots: string[] = [];
const MANIFEST = {
  schema_version: 1,
  kind: 'echo-internal-live-release',
  channel: 'internal-live',
  release_version: '0.1.0-internal.2',
  release_tag: 'internal-v0.1.0-internal.2',
  source: { sha: SOURCE_SHA, kind: 'materialized-commit' },
  artifact: {
    package: 'echo-brain',
    filename: 'echo-brain-0.1.0-internal.2.tgz',
    download_url:
      'https://github.com/EchoBrain-org/echo-brain/releases/download/internal-v0.1.0-internal.2/echo-brain-0.1.0-internal.2.tgz',
    size_bytes: 1234,
    sha256: ARTIFACT_SHA,
  },
  compatibility: {
    os: 'darwin',
    arch: 'arm64',
    node: '22.22.1',
    npm: '10.9.4',
  },
  build: {
    repository: 'EchoBrain-org/echo-brain',
    workflow: 'internal-live-release.yml',
    run_id: '12345678901234567890',
    run_attempt: 1,
  },
} as const;

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

const PACKAGE_FILE = {
  path: 'package.json',
  size: 17,
  sha256: FILE_SHA,
};

function packageInspection(
  changes: Partial<InspectedInternalLivePackage> = {},
): InspectedInternalLivePackage {
  return {
    package_name: 'echo-brain',
    package_version: MANIFEST.release_version,
    build_identity: {
      schema_version: 1,
      kind: 'echo-packaged-build-identity',
      product_version: MANIFEST.release_version,
      source_sha: SOURCE_SHA,
      source_kind: 'materialized-commit',
    },
    artifact_evidence: {
      schema_version: 1,
      kind: 'echo-package-artifact-evidence',
      package: 'echo-brain',
      version: MANIFEST.release_version,
      source_sha: SOURCE_SHA,
      files: [PACKAGE_FILE],
    },
    package_files: [PACKAGE_FILE],
    ...changes,
  };
}

class MemoryStore implements InternalLiveUpdateStore {
  active: InternalLiveUpdateTransactionV1 | null = null;
  receipts: InternalLiveUpdateReceiptV1[] = [];
  phases: InternalLiveUpdateTransactionV1['phase'][] = [];

  async loadActive(): Promise<InternalLiveUpdateTransactionV1 | null> {
    return this.active === null ? null : structuredClone(this.active);
  }

  async saveActive(
    transaction: InternalLiveUpdateTransactionV1,
  ): Promise<void> {
    this.active = structuredClone(transaction);
    this.phases.push(transaction.phase);
  }

  async saveReceipt(receipt: InternalLiveUpdateReceiptV1): Promise<void> {
    const copy = structuredClone(receipt);
    const existing = this.receipts.find(
      (candidate) => candidate.transaction_id === copy.transaction_id,
    );
    if (existing === undefined) this.receipts.push(copy);
    else expect(existing).toEqual(copy);
  }
}

interface OperationFixture {
  operations: InternalLiveUpdateOperations;
  events: string[];
  backupTimestamps: string[];
  restoreTimestamps: string[];
}

function operationFixture(options: {
  fail?: 'backup' | 'install' | 'reconfigure';
  doctors?: readonly InternalLiveDoctorSummary[];
  inspection?: InspectedInternalLivePackage;
  artifactSha?: string;
} = {}): OperationFixture {
  const events: string[] = [];
  const backupTimestamps: string[] = [];
  const restoreTimestamps: string[] = [];
  let instant = Date.UTC(2026, 7, 2, 20, 0, 0);
  const doctors = [...(options.doctors ?? [{ ok: true, passed: 11, total: 11 }])];
  const operations: InternalLiveUpdateOperations = {
    obtainApprovedManifest: async () => {
      events.push('manifest');
      return MANIFEST;
    },
    verifyManifestApproval: async () => {
      events.push('approval');
    },
    runtime: () => ({
      os: 'darwin',
      arch: 'arm64',
      node: 'v22.22.1',
      npm: '10.9.4',
    }),
    obtainArtifact: async () => {
      events.push('download');
      return { reference: '/private/tmp/secret-looking-artifact-path.tgz' };
    },
    digestArtifact: async () => {
      events.push('digest');
      return {
        sha256: options.artifactSha ?? ARTIFACT_SHA,
        size_bytes: 1234,
      };
    },
    inspectArtifact: async () => {
      events.push('inspect');
      return options.inspection ?? packageInspection();
    },
    currentInstallation: async () => {
      events.push('current');
      return {
        product_version: '0.1.0-internal.1',
        source_sha: OLD_SOURCE_SHA,
      };
    },
    serviceIsRunning: async () => {
      events.push('service-status');
      return true;
    },
    stopService: async () => {
      events.push('stop');
    },
    createBackup: async (_transactionId, stableTimestamp) => {
      events.push('backup');
      backupTimestamps.push(stableTimestamp);
      if (options.fail === 'backup') throw new Error('state path is secret');
      return { backup_ref: 'backup-transaction-1' };
    },
    retainCurrentPackage: async () => {
      events.push('retain');
      return { package_ref: 'previous-package-transaction-1' };
    },
    installCandidate: async () => {
      events.push('install-candidate');
      if (options.fail === 'install') throw new Error('npm output is secret');
    },
    reconfigureCandidate: async () => {
      events.push('reconfigure-candidate');
      if (options.fail === 'reconfigure') {
        throw new Error('configuration path is secret');
      }
    },
    startService: async () => {
      events.push('start');
    },
    doctor: async () => {
      events.push('doctor');
      const next = doctors.shift();
      if (next === undefined) throw new Error('unexpected doctor call');
      return next;
    },
    installPreviousPackage: async () => {
      events.push('install-previous');
    },
    restoreBackup: async (_backupRef, _transactionId, stableTimestamp) => {
      events.push('restore-state');
      restoreTimestamps.push(stableTimestamp);
    },
    reconfigurePrevious: async () => {
      events.push('reconfigure-previous');
    },
    now: () => {
      const value = new Date(instant).toISOString();
      instant += 1_000;
      return value;
    },
  };
  return { operations, events, backupTimestamps, restoreTimestamps };
}

function activeTransaction(
  phase: InternalLiveUpdateTransactionV1['phase'],
): InternalLiveUpdateTransactionV1 {
  const manifest = parseInternalLiveReleaseManifest(MANIFEST);
  return {
    schema_version: 1,
    kind: 'echo-internal-live-update-transaction',
    channel: 'internal-live',
    transaction_id: 'transaction-1',
    release_version: manifest.release_version,
    manifest_sha256: internalLiveManifestSha256(manifest),
    artifact_sha256: manifest.artifact.sha256,
    source_sha: manifest.source.sha,
    previous: {
      product_version: '0.1.0-internal.1',
      source_sha: OLD_SOURCE_SHA,
    },
    phase,
    backup_ref: 'backup-transaction-1',
    previous_package_ref: 'previous-package-transaction-1',
    package_may_have_changed: true,
    state_may_have_changed: false,
    doctor: null,
    failure: null,
    started_at: '2026-08-02T19:59:00.000Z',
    updated_at: '2026-08-02T19:59:01.000Z',
    finished_at: null,
  };
}

describe('internal-live release manifest', () => {
  it('accepts only the single typed channel and deterministic GitHub asset', () => {
    const manifest = parseInternalLiveReleaseManifest(MANIFEST);
    expect(manifest.channel).toBe('internal-live');
    expect(manifest.release_tag).toBe(
      `internal-v${manifest.release_version}`,
    );
    expect(internalLiveManifestSha256(manifest)).toMatch(/^[a-f0-9]{64}$/u);

    expect(() =>
      parseInternalLiveReleaseManifest({ ...MANIFEST, command: 'npm install' }),
    ).toThrow(/unexpected shape/u);
    expect(() =>
      parseInternalLiveReleaseManifest({
        ...MANIFEST,
        source: { ...MANIFEST.source, kind: 'worktree-head-unverified' },
      }),
    ).toThrow(/source kind/u);
    expect(() =>
      parseInternalLiveReleaseManifest({
        ...MANIFEST,
        artifact: {
          ...MANIFEST.artifact,
          download_url: 'https://example.com/payload.tgz',
        },
      }),
    ).toThrow(/artifact URL/u);
    expect(() =>
      parseInternalLiveReleaseManifest({
        ...MANIFEST,
        build: { ...MANIFEST.build, repository: 'attacker/echo-brain' },
        artifact: {
          ...MANIFEST.artifact,
          download_url:
            'https://github.com/attacker/echo-brain/releases/download/internal-v0.1.0-internal.2/echo-brain-0.1.0-internal.2.tgz',
        },
      }),
    ).toThrow(/repository/u);
    for (const releaseVersion of [
      '0.1.0-dev.1',
      '0.1.0-internal-alpha.1',
      '0.1.0-internal.1+build.7',
    ]) {
      expect(() =>
        parseInternalLiveReleaseManifest({
          ...MANIFEST,
          release_version: releaseVersion,
          release_tag: `internal-v${releaseVersion}`,
        }),
      ).toThrow(/release_version/u);
    }
  });

  it('pins archive digest, embedded identity, and every evidence file', () => {
    const manifest = parseInternalLiveReleaseManifest(MANIFEST);
    expect(
      verifyInspectedInternalLivePackage(manifest, packageInspection(), {
        sha256: ARTIFACT_SHA,
        size_bytes: 1234,
      }),
    ).toEqual({
      artifact_sha256: ARTIFACT_SHA,
      artifact_size_bytes: 1234,
      product_version: MANIFEST.release_version,
      source_sha: SOURCE_SHA,
      evidence_file_count: 1,
    });

    expect(() =>
      verifyInspectedInternalLivePackage(
        manifest,
        packageInspection({
          package_files: [{ ...PACKAGE_FILE, sha256: 'c'.repeat(64) }],
        }),
        { sha256: ARTIFACT_SHA, size_bytes: 1234 },
      ),
    ).toThrow(/contents do not match/u);
    expect(() =>
      verifyInspectedInternalLivePackage(
        manifest,
        packageInspection({
          build_identity: {
            ...(packageInspection().build_identity as Record<string, unknown>),
            source_kind: 'worktree-head-unverified',
          },
        }),
        { sha256: ARTIFACT_SHA, size_bytes: 1234 },
      ),
    ).toThrow(/not release-grade/u);
  });
});

describe('internal-live update transaction', () => {
  it('verifies completely before stopping, then backs up and reaches healthy', async () => {
    const { operations, events, backupTimestamps } = operationFixture();
    const store = new MemoryStore();
    const receipt = await applyInternalLiveUpdate(
      { transactionId: 'transaction-1' },
      operations,
      store,
    );

    expect(receipt.outcome).toBe('healthy');
    expect(receipt.doctor).toEqual({ ok: true, passed: 11, total: 11 });
    expect(events.indexOf('inspect')).toBeLessThan(events.indexOf('stop'));
    expect(events).toEqual([
      'manifest',
      'approval',
      'download',
      'digest',
      'inspect',
      'service-status',
      'current',
      'stop',
      'backup',
      'retain',
      'install-candidate',
      'reconfigure-candidate',
      'start',
      'doctor',
    ]);
    expect(store.active?.phase).toBe('completed');
    expect(store.phases).toEqual([
      'verified',
      'stopping_service',
      'creating_backup',
      'retaining_previous_package',
      'installing_candidate',
      'reconfiguring_candidate',
      'starting_candidate',
      'checking_candidate',
      'completed',
    ]);
    expect(store.receipts).toEqual([receipt]);
    expect(backupTimestamps).toEqual([receipt.started_at]);
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('secret-looking-artifact-path');
    expect(serialized).not.toContain('backup-transaction');
    expect(serialized).not.toContain('previous-package');
  });

  it('returns an existing terminal receipt without downloading again', async () => {
    const { operations, events } = operationFixture();
    const store = new MemoryStore();
    const first = await applyInternalLiveUpdate(
      { transactionId: 'transaction-1' },
      operations,
      store,
    );
    events.length = 0;

    const second = await applyInternalLiveUpdate(
      { transactionId: 'transaction-2' },
      operations,
      store,
    );

    expect(second).toEqual(first);
    expect(events).toEqual(['manifest', 'approval']);
  });

  it('reinstalls the old package and restores state after candidate mutation', async () => {
    const { operations, events, restoreTimestamps } = operationFixture({
      fail: 'reconfigure',
      doctors: [{ ok: true, passed: 11, total: 11 }],
    });
    const store = new MemoryStore();
    const receipt = await applyInternalLiveUpdate(
      { transactionId: 'transaction-1' },
      operations,
      store,
    );

    expect(receipt).toMatchObject({
      outcome: 'rolled_back',
      failure: { phase: 'reconfiguring_candidate', code: 'reconfigure_failed' },
      doctor: { ok: true, passed: 11, total: 11 },
    });
    expect(events).toContain('install-previous');
    expect(events).toContain('restore-state');
    expect(events.indexOf('install-previous')).toBeLessThan(
      events.indexOf('restore-state'),
    );
    expect(events.indexOf('restore-state')).toBeLessThan(
      events.indexOf('reconfigure-previous'),
    );
    expect(restoreTimestamps).toEqual([receipt.started_at]);
    expect(JSON.stringify(receipt)).not.toContain('configuration path is secret');
  });

  it('does not restore state when candidate installation fails before state mutation', async () => {
    const { operations, events } = operationFixture({ fail: 'install' });
    const receipt = await applyInternalLiveUpdate(
      { transactionId: 'transaction-1' },
      operations,
      new MemoryStore(),
    );

    expect(receipt.outcome).toBe('rolled_back');
    expect(receipt.failure?.code).toBe('install_failed');
    expect(events).toContain('install-previous');
    expect(events).not.toContain('restore-state');
  });

  it('only restarts the old service when backup fails before package mutation', async () => {
    const { operations, events } = operationFixture({ fail: 'backup' });
    const receipt = await applyInternalLiveUpdate(
      { transactionId: 'transaction-1' },
      operations,
      new MemoryStore(),
    );

    expect(receipt.outcome).toBe('rolled_back');
    expect(receipt.failure?.code).toBe('backup_failed');
    expect(events).not.toContain('install-previous');
    expect(events).not.toContain('restore-state');
    expect(events.filter((event) => event === 'start')).toHaveLength(1);
  });

  it('resumes an interrupted intent phase without recapturing previous identity', async () => {
    const { operations, events } = operationFixture();
    const store = new MemoryStore();
    store.active = activeTransaction('installing_candidate');

    const receipt = await applyInternalLiveUpdate(
      { transactionId: 'ignored-new-id' },
      operations,
      store,
    );

    expect(receipt.outcome).toBe('healthy');
    expect(receipt.transaction_id).toBe('transaction-1');
    expect(events).not.toContain('current');
    expect(events).not.toContain('backup');
    expect(events).toContain('install-candidate');
  });

  it('replays the complete idempotent rollback from its single durable intent', async () => {
    const run = async () => {
      const { operations, events, restoreTimestamps } = operationFixture();
      const store = new MemoryStore();
      store.active = {
        ...activeTransaction('rolling_back'),
        state_may_have_changed: true,
        failure: {
          phase: 'reconfiguring_candidate',
          code: 'reconfigure_failed',
        },
      };
      const receipt = await applyInternalLiveUpdate(
        { transactionId: 'ignored-new-id' },
        operations,
        store,
      );
      return { events, receipt, restoreTimestamps, phases: store.phases };
    };

    const first = await run();
    const replay = await run();
    for (const result of [first, replay]) {
      expect(result.receipt).toMatchObject({
        outcome: 'rolled_back',
        failure: {
          phase: 'reconfiguring_candidate',
          code: 'reconfigure_failed',
        },
      });
      expect(result.events.slice(-6)).toEqual([
        'install-previous',
        'stop',
        'restore-state',
        'reconfigure-previous',
        'start',
        'doctor',
      ]);
      expect(result.restoreTimestamps).toEqual([
        '2026-08-02T19:59:00.000Z',
      ]);
      expect(result.phases).toEqual(['rolled_back']);
    }
  });

  it('fails closed on an artifact mismatch without touching the service', async () => {
    const { operations, events } = operationFixture({
      artifactSha: 'f'.repeat(64),
    });
    await expect(
      applyInternalLiveUpdate(
        { transactionId: 'transaction-1' },
        operations,
        new MemoryStore(),
      ),
    ).rejects.toMatchObject({ code: 'release_verification_failed' });
    expect(events).not.toContain('service-status');
    expect(events).not.toContain('stop');
  });
});

describe('internal-live node operations', () => {
  function runtimeConfig(stateDir: string): ProductRuntimeConfig {
    return {
      schema_version: 1,
      lane: 'team-product',
      state_dir: stateDir,
      meeting_sources: [],
      decision_processor: {
        adapter_id: 'structured-text',
        instance_id: 'primary',
        settings: {},
      },
      delivery_surfaces: [],
      approval_mode: 'manual',
    };
  }

  it('inspects package evidence larger than the manifest limit', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-internal-live-evidence-')),
    );
    temporaryRoots.push(root);
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    const packageManifest = Buffer.from(
      JSON.stringify({ name: 'echo-brain', version: MANIFEST.release_version }),
    );
    const buildIdentity = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        kind: 'echo-packaged-build-identity',
        product_version: MANIFEST.release_version,
        source_sha: SOURCE_SHA,
        source_kind: 'materialized-commit',
      }),
    );
    const generatedBytes = Buffer.from('x');
    const sha256 = (bytes: Buffer) =>
      createHash('sha256').update(bytes).digest('hex');
    // Match the live .2 archive's 604-record, 92,771-byte evidence without
    // checking release bytes into the test suite.
    const generatedDirectory = `dist/generated/${'x'.repeat(27)}`;
    const files = [
      {
        path: 'dist/product/build-identity.v1.json',
        bytes: buildIdentity,
      },
      ...Array.from({ length: 602 }, (_, index) => ({
        path: `${generatedDirectory}/file-${String(index).padStart(4, '0')}${
          index === 0 ? 'y'.repeat(243) : ''
        }.txt`,
        bytes: generatedBytes,
      })),
      { path: 'package.json', bytes: packageManifest },
    ].sort((left, right) =>
      Buffer.from(left.path).compare(Buffer.from(right.path)),
    );
    const evidence = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        kind: 'echo-package-artifact-evidence',
        package: 'echo-brain',
        version: MANIFEST.release_version,
        source_sha: SOURCE_SHA,
        files: files.map((file) => ({
          path: file.path,
          size: file.bytes.byteLength,
          sha256: sha256(file.bytes),
        })),
      }),
    );
    expect(files).toHaveLength(604);
    expect(evidence.byteLength).toBe(92_771);
    const evidenceEntry = 'package/dist/package-artifact-evidence.v1.json';
    const entries = [
      evidenceEntry,
      ...files.map((file) => `package/${file.path}`),
    ];
    const entryBytes = new Map<string, Buffer>([
      [evidenceEntry, evidence],
      ...files.map((file) => [`package/${file.path}`, file.bytes] as const),
    ]);
    let evidenceOutputLimit: number | undefined;
    const runner: InternalLiveCommandRunner = async (_command, args, options) => {
      if (args[0] === '-tzf') {
        return {
          status: 0,
          stdout: Buffer.from(`${entries.join('\n')}\n`),
          stderr: '',
        };
      }
      if (args[0] === '-tvzf') {
        return {
          status: 0,
          stdout: Buffer.from(`${entries.map(() => '-').join('\n')}\n`),
          stderr: '',
        };
      }
      if (args[0] === '-xOzf') {
        const entry = args[2]!;
        if (entry === evidenceEntry) {
          evidenceOutputLimit = options?.maxStdoutBytes;
        }
        const bytes = entryBytes.get(entry);
        return bytes === undefined
          ? { status: 1, stdout: Buffer.alloc(0), stderr: 'missing' }
          : { status: 0, stdout: bytes, stderr: '' };
      }
      return { status: 1, stdout: Buffer.alloc(0), stderr: 'unsupported' };
    };

    const prefix = join(root, '.npm-global');
    const operations = new NodeInternalLiveUpdateOperations({
      configPath: join(root, 'config', 'runtime.json'),
      config: runtimeConfig(stateDir),
      cliPath: join(prefix, 'lib/node_modules/echo-brain/dist/product/cli.js'),
      productVersion: '0.1.0-internal.1',
      sourceSha: OLD_SOURCE_SHA,
      directive: {
        manifest_url:
          'https://github.com/EchoBrain-org/echo-brain/releases/download/internal-v0.1.0-internal.2/internal-live-release-manifest.v1.json',
        manifest_sha256: 'c'.repeat(64),
      },
      npmPath: join(prefix, 'bin/npm'),
      npmVersion: '10.9.4',
      now: () => '2026-08-02T20:00:00.000Z',
      commandRunner: runner,
    });

    const inspected = await operations.inspectArtifact({
      reference: {
        kind: 'internal-live-local-artifact',
        path: join(root, 'candidate.tgz'),
      },
    });
    expect(inspected.artifact_evidence).toMatchObject({
      version: MANIFEST.release_version,
      files: expect.any(Array),
    });
    expect(inspected.package_files).toHaveLength(files.length);
    expect(evidenceOutputLimit).toBe(4 * 1024 * 1024);
  });

  it('uses the existing user prefix and enables install scripts', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-internal-live-node-')),
    );
    temporaryRoots.push(root);
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    const prefix = join(root, '.npm-global');
    const cliPath = join(
      prefix,
      'lib/node_modules/echo-brain/dist/product/cli.js',
    );
    const artifactPath = join(root, 'candidate.tgz');
    writeFileSync(artifactPath, 'candidate', { mode: 0o600 });
    const commands: Array<{
      command: string;
      args: readonly string[];
      options: Parameters<InternalLiveCommandRunner>[2];
    }> = [];
    const runner: InternalLiveCommandRunner = async (
      command,
      args,
      options,
    ): Promise<InternalLiveCommandResult> => {
      commands.push({ command, args: [...args], options });
      return { status: 0, stdout: Buffer.alloc(0), stderr: '' };
    };
    const configPath = join(root, 'config', 'runtime.json');
    const operations = new NodeInternalLiveUpdateOperations({
      configPath,
      config: runtimeConfig(stateDir),
      cliPath,
      productVersion: '0.1.0-internal.1',
      sourceSha: OLD_SOURCE_SHA,
      directive: {
        manifest_url:
          'https://github.com/EchoBrain-org/echo-brain/releases/download/internal-v0.1.0-internal.2/internal-live-release-manifest.v1.json',
        manifest_sha256: 'c'.repeat(64),
      },
      npmPath: join(prefix, 'bin/npm'),
      npmVersion: '10.9.4',
      now: () => '2026-08-02T20:00:00.000Z',
      commandRunner: runner,
    });

    await operations.installCandidate(
      { reference: { kind: 'internal-live-local-artifact', path: artifactPath } },
      'transaction-1',
    );
    expect(internalLiveGlobalInstallLayout(cliPath)).toEqual({
      packageRoot: join(prefix, 'lib/node_modules/echo-brain'),
      prefix,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.args).toContain('--prefix');
    expect(commands[0]?.args).toContain(prefix);
    expect(commands[0]?.args).toContain(
      `--userconfig=${join(internalLiveUpdateRoot(configPath), 'npm-no-config/user.npmrc')}`,
    );
    expect(commands[0]?.args).toContain(
      `--globalconfig=${join(internalLiveUpdateRoot(configPath), 'npm-no-config/global.npmrc')}`,
    );
    expect(commands[0]?.args).not.toContain('--userconfig=/dev/null');
    expect(commands[0]?.args).not.toContain('--globalconfig=/dev/null');
    expect(commands[0]?.args).not.toContain('--offline');
    expect(commands[0]?.args).not.toContain('--ignore-scripts');
    expect(commands[0]?.options?.cwd).toBe(internalLiveUpdateRoot(configPath));
  });

  it('uses local doctor so an update never probes live adapters', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-internal-live-doctor-')),
    );
    temporaryRoots.push(root);
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    const prefix = join(root, '.npm-global');
    const cliPath = join(
      prefix,
      'lib/node_modules/echo-brain/dist/product/cli.js',
    );
    const calls: string[][] = [];
    const runner: InternalLiveCommandRunner = async (_command, args) => {
      calls.push([...args]);
      return {
        status: 0,
        stdout: Buffer.from(
          JSON.stringify({
            ok: true,
            checks: Array.from({ length: 10 }, (_, index) => ({
              id: `local-${index}`,
              ok: true,
            })),
          }),
        ),
        stderr: '',
      };
    };
    const operations = new NodeInternalLiveUpdateOperations({
      configPath: join(root, 'config', 'runtime.json'),
      config: runtimeConfig(stateDir),
      cliPath,
      productVersion: '0.1.0-internal.1',
      sourceSha: OLD_SOURCE_SHA,
      directive: {
        manifest_url:
          'https://github.com/EchoBrain-org/echo-brain/releases/download/internal-v0.1.0-internal.2/internal-live-release-manifest.v1.json',
        manifest_sha256: 'c'.repeat(64),
      },
      npmPath: join(prefix, 'bin/npm'),
      npmVersion: '10.9.4',
      now: () => '2026-08-02T20:00:00.000Z',
      commandRunner: runner,
    });

    await expect(operations.doctor()).resolves.toEqual({
      ok: true,
      passed: 10,
      total: 10,
    });
    expect(calls).toEqual([
      [
        cliPath,
        'doctor',
        '--local-only',
        '--config',
        join(root, 'config', 'runtime.json'),
      ],
    ]);
  });

  it('reuses the transaction timestamp when backup creation is replayed', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-internal-live-backup-')),
    );
    temporaryRoots.push(root);
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    const prefix = join(root, '.npm-global');
    const operations = new NodeInternalLiveUpdateOperations({
      configPath: join(root, 'config', 'runtime.json'),
      config: runtimeConfig(stateDir),
      cliPath: join(
        prefix,
        'lib/node_modules/echo-brain/dist/product/cli.js',
      ),
      productVersion: '0.1.0-internal.1',
      sourceSha: OLD_SOURCE_SHA,
      directive: {
        manifest_url:
          'https://github.com/EchoBrain-org/echo-brain/releases/download/internal-v0.1.0-internal.2/internal-live-release-manifest.v1.json',
        manifest_sha256: 'c'.repeat(64),
      },
      npmPath: join(prefix, 'bin/npm'),
      npmVersion: '10.9.4',
      now: () => '2099-01-01T00:00:00.000Z',
      commandRunner: async () => ({
        status: 0,
        stdout: Buffer.alloc(0),
        stderr: '',
      }),
    });
    const stable = '2026-08-02T20:00:00.000Z';
    await expect(
      operations.createBackup('transaction-1', stable),
    ).resolves.toEqual({ backup_ref: 'backup-transaction-1' });
    await expect(
      operations.createBackup('transaction-1', stable),
    ).resolves.toEqual({ backup_ref: 'backup-transaction-1' });
  });

  it('serializes update runs with one bounded cross-process lock', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-internal-live-lock-')),
    );
    temporaryRoots.push(root);
    const configPath = join(root, 'config', 'runtime.json');
    const release = await acquireInternalLiveUpdateLock(configPath);
    await expect(
      acquireInternalLiveUpdateLock(configPath, {
        timeoutMs: 5,
        staleMs: 30_000,
        retryMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'busy' });
    await release();
    const releaseNext = await acquireInternalLiveUpdateLock(configPath);
    await releaseNext();
  });
});

describe('file internal-live update store', () => {
  it('keeps strict resumable state outside the rollback tree and receipts immutable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-internal-live-store-'));
    temporaryRoots.push(root);
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    const directory = join(root, 'update-control');
    const store = new FileInternalLiveUpdateStore({ directory, stateDir });
    const transaction = activeTransaction('installing_candidate');
    await store.saveActive(transaction);

    expect(await store.loadActive()).toEqual(transaction);
    expect(
      lstatSync(join(directory, 'active-transaction.v1.json')).mode & 0o777,
    ).toBe(0o600);

    const receipt: InternalLiveUpdateReceiptV1 = {
      schema_version: 1,
      kind: 'echo-internal-live-update-receipt',
      channel: 'internal-live',
      transaction_id: transaction.transaction_id,
      release_version: transaction.release_version,
      manifest_sha256: transaction.manifest_sha256,
      artifact_sha256: transaction.artifact_sha256,
      source_sha: transaction.source_sha,
      previous: transaction.previous,
      outcome: 'healthy',
      doctor: { ok: true, passed: 11, total: 11 },
      failure: null,
      started_at: transaction.started_at,
      finished_at: '2026-08-02T20:01:00.000Z',
    };
    await store.saveReceipt(receipt);
    await store.saveReceipt(receipt);
    await expect(
      store.saveReceipt({ ...receipt, outcome: 'failed' }),
    ).rejects.toMatchObject({ code: 'invalid_transaction' });

    await store.saveActive({
      ...transaction,
      phase: 'rolled_back',
      doctor: { ok: true, passed: 10, total: 10 },
      failure: {
        phase: 'checking_candidate',
        code: 'doctor_failed',
      },
      finished_at: '2026-08-02T20:01:00.000Z',
    });
    await store.clearReportedRollback(transaction.transaction_id);
    expect(await store.loadActive()).toBeNull();
  });

  it('rejects tampered transaction fields before replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-internal-live-store-'));
    temporaryRoots.push(root);
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    const directory = join(root, 'update-control');
    const store = new FileInternalLiveUpdateStore({ directory, stateDir });
    await store.saveActive(activeTransaction('installing_candidate'));
    const activePath = join(directory, 'active-transaction.v1.json');
    const tampered = JSON.parse(readFileSync(activePath, 'utf8')) as Record<
      string,
      unknown
    >;
    tampered['command'] = 'arbitrary shell';
    writeFileSync(activePath, `${JSON.stringify(tampered)}\n`);
    chmodSync(activePath, 0o600);

    await expect(store.loadActive()).rejects.toMatchObject({
      code: 'invalid_transaction',
    });
  });

  it('refuses a transaction store inside product state', () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-internal-live-store-'));
    temporaryRoots.push(root);
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    expect(
      () =>
        new FileInternalLiveUpdateStore({
          directory: join(stateDir, 'updates'),
          stateDir,
        }),
    ).toThrow(/must be disjoint/u);
  });
});
