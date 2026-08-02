import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { ProductRuntimeConfig } from '../config.js';
import { canonicalProductConfigSha256 } from '../lifecycle-lock.js';
import {
  assertPrivateOwnedDirectory,
  assertPrivateOwnedRegularFile,
  digestFileNoFollow,
  ensureDirectory,
  fsyncDirectory,
  pathEntryExists,
} from '../secure-local-files.js';
import {
  publicNpmInstallConfigPaths,
  spawnPublicNpmInstallChild,
  spawnSanitizedChild,
} from '../spawn-sanitized-child.js';
import {
  createProductStateBackup,
  restoreProductStateBackup,
} from '../state-backup.js';
import {
  parsePackageArtifactEvidence,
  type InspectedInternalLivePackage,
  type InternalLiveReleaseManifestV1,
  type PackageArtifactEvidenceFileV1,
} from './internal-live-release.js';
import type {
  InternalLiveArtifactReference,
  InternalLiveDoctorSummary,
  InternalLiveInstalledIdentity,
  InternalLiveUpdateOperations,
} from './internal-live-update.js';

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PACKAGE_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_COMMAND_STDOUT_BYTES = 128 * 1024 * 1024;
const MAX_COMMAND_STDERR_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1_000;
const ARCHIVE_ENTRY_LIMIT = 4_097;
const EVIDENCE_ENTRY = 'package/dist/package-artifact-evidence.v1.json';
const BUILD_IDENTITY_ENTRY = 'package/dist/product/build-identity.v1.json';
const PACKAGE_MANIFEST_ENTRY = 'package/package.json';

export interface InternalLiveCommandResult {
  status: number;
  stdout: Buffer;
  stderr: string;
}

export type InternalLiveCommandRunner = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string; timeoutMs?: number; maxStdoutBytes?: number },
) => Promise<InternalLiveCommandResult>;

export interface NodeInternalLiveUpdateOptions {
  configPath: string;
  config: ProductRuntimeConfig;
  cliPath: string;
  productVersion: string;
  sourceSha: string;
  directive: {
    manifest_url: string;
    manifest_sha256: string;
  };
  npmPath: string;
  npmVersion: string;
  now: () => string;
  publicFetch?: typeof fetch;
  commandRunner?: InternalLiveCommandRunner;
}

interface LocalArtifactReference extends InternalLiveArtifactReference {
  reference: {
    kind: 'internal-live-local-artifact';
    path: string;
  };
}

function boundedAppend(
  chunks: Buffer[],
  chunk: Buffer,
  current: number,
  maximum: number,
  child: ReturnType<typeof spawnSanitizedChild>,
): number {
  const next = current + chunk.byteLength;
  if (next > maximum) {
    child.kill('SIGKILL');
    return next;
  }
  chunks.push(chunk);
  return next;
}

async function collectInternalLiveCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; maxStdoutBytes?: number },
  publicNpmInstall: boolean,
): Promise<InternalLiveCommandResult> {
  const maxStdoutBytes = options.maxStdoutBytes ?? MAX_COMMAND_STDOUT_BYTES;
  if (publicNpmInstall && options.cwd === undefined) {
    throw new Error('public npm installation requires a private working directory');
  }
  const child = publicNpmInstall
    ? spawnPublicNpmInstallChild(command, args, {
        cwd: options.cwd!,
        timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      })
    : spawnSanitizedChild(command, args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputExceeded = false;
  child.stdout.on('data', (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    stdoutBytes = boundedAppend(
      stdout,
      chunk,
      stdoutBytes,
      maxStdoutBytes,
      child,
    );
    if (stdoutBytes > maxStdoutBytes) outputExceeded = true;
  });
  child.stderr.on('data', (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    stderrBytes = boundedAppend(
      stderr,
      chunk,
      stderrBytes,
      MAX_COMMAND_STDERR_BYTES,
      child,
    );
    if (stderrBytes > MAX_COMMAND_STDERR_BYTES) outputExceeded = true;
  });
  const status = await new Promise<number>((resolveStatus) => {
    let settled = false;
    const finish = (value: number) => {
      if (settled) return;
      settled = true;
      resolveStatus(value);
    };
    child.once('error', () => finish(1));
    child.once('close', (code) => finish(code ?? 1));
  });
  if (outputExceeded) {
    throw new Error('internal-live child command exceeded its output limit');
  }
  return {
    status,
    stdout: Buffer.concat(stdout, stdoutBytes),
    stderr: Buffer.concat(stderr, Math.min(stderrBytes, MAX_COMMAND_STDERR_BYTES))
      .toString('utf8'),
  };
}

export async function runInternalLiveCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; maxStdoutBytes?: number } = {},
): Promise<InternalLiveCommandResult> {
  return await collectInternalLiveCommand(command, args, options, false);
}

export async function runPublicNpmInstallCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; maxStdoutBytes?: number } = {},
): Promise<InternalLiveCommandResult> {
  return await collectInternalLiveCommand(command, args, options, true);
}

function requireCommandSuccess(
  result: InternalLiveCommandResult,
  operation: string,
): Buffer {
  if (result.status !== 0) {
    throw new Error(`${operation} failed without accepted update evidence`);
  }
  return result.stdout;
}

function parseJsonBytes(
  bytes: Buffer,
  label: string,
  maximumBytes = MAX_MANIFEST_BYTES,
): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new Error(`${label} is empty or oversized`);
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON`);
  }
}

function assertPublicGithubResponse(response: Response): void {
  if (response.url === '') return;
  const url = new URL(response.url);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.hostname !== 'github.com' &&
      url.hostname !== 'objects.githubusercontent.com' &&
      url.hostname !== 'release-assets.githubusercontent.com')
  ) {
    throw new Error('public release fetch redirected outside trusted GitHub hosts');
  }
}

async function fetchPublicResponse(
  fetchImpl: typeof fetch,
  url: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/octet-stream, application/json' },
      redirect: 'follow',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error('public GitHub release fetch failed');
  }
  assertPublicGithubResponse(response);
  if (!response.ok || response.body === null) {
    throw new Error('public GitHub release fetch returned no accepted content');
  }
  return response;
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (
    length !== null &&
    (!/^\d+$/u.test(length) || Number(length) > maximumBytes)
  ) {
    throw new Error('public release response exceeds its size limit');
  }
  const reader = response.body!.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error('public release response exceeds its size limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function artifactPath(reference: InternalLiveArtifactReference): string {
  const value = reference.reference;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as { kind?: unknown }).kind !== 'internal-live-local-artifact' ||
    typeof (value as { path?: unknown }).path !== 'string'
  ) {
    throw new Error('internal-live artifact reference is invalid');
  }
  return (value as { path: string }).path;
}

function assertPrivateRegularFile(path: string, label: string): void {
  assertPrivateOwnedRegularFile(path, 0o600, () => {
    throw new Error(`${label} must be a current-user mode-0600 regular file`);
  });
}

async function writeResponseToFile(
  response: Response,
  destination: string,
  expectedBytes: number,
): Promise<void> {
  if (expectedBytes <= 0 || expectedBytes > MAX_ARTIFACT_BYTES) {
    throw new Error('internal-live artifact exceeds the local size limit');
  }
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) !== expectedBytes)
  ) {
    throw new Error('artifact Content-Length does not match its release manifest');
  }
  const directory = dirname(destination);
  const temporary = join(directory, `.download-${randomUUID()}.tmp`);
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let committed = false;
  const reader = response.body!.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expectedBytes) {
        await reader.cancel();
        throw new Error('downloaded artifact exceeds its declared size');
      }
      let offset = 0;
      while (offset < value.byteLength) {
        offset += writeSync(
          descriptor,
          value,
          offset,
          value.byteLength - offset,
        );
      }
    }
    if (total !== expectedBytes) {
      throw new Error('downloaded artifact is shorter than its declared size');
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    renameSync(temporary, destination);
    committed = true;
    fsyncDirectory(directory);
  } finally {
    reader.releaseLock();
    if (!committed) {
      try {
        closeSync(descriptor);
      } catch {
        // descriptor may already be closed
      }
      rmSync(temporary, { force: true });
    }
  }
  chmodSync(destination, 0o600);
  assertPrivateRegularFile(destination, 'downloaded internal-live artifact');
}

function safeArchiveName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 600 &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    value
      .replace(/\/$/u, '')
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

async function archiveEntry(
  runner: InternalLiveCommandRunner,
  archive: string,
  entry: string,
  maximum = MAX_COMMAND_STDOUT_BYTES,
): Promise<Buffer> {
  return requireCommandSuccess(
    await runner('/usr/bin/tar', ['-xOzf', archive, entry], {
      maxStdoutBytes: maximum,
    }),
    'internal-live archive inspection',
  );
}

async function inspectPackageArchive(
  runner: InternalLiveCommandRunner,
  archive: string,
): Promise<InspectedInternalLivePackage> {
  const listed = requireCommandSuccess(
    await runner('/usr/bin/tar', ['-tzf', archive], {
      maxStdoutBytes: 4 * 1024 * 1024,
    }),
    'internal-live archive listing',
  )
    .toString('utf8')
    .split('\n')
    .filter((name) => name.length > 0);
  const verbose = requireCommandSuccess(
    await runner('/usr/bin/tar', ['-tvzf', archive], {
      maxStdoutBytes: 8 * 1024 * 1024,
    }),
    'internal-live archive type inspection',
  )
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0);
  if (
    listed.length === 0 ||
    listed.length > ARCHIVE_ENTRY_LIMIT + 64 ||
    listed.length !== verbose.length ||
    new Set(listed).size !== listed.length
  ) {
    throw new Error('internal-live archive has an unsupported entry set');
  }
  const files: string[] = [];
  listed.forEach((name, index) => {
    if (
      !safeArchiveName(name) ||
      (name !== 'package' && !name.startsWith('package/'))
    ) {
      throw new Error('internal-live archive contains an unsafe entry');
    }
    const type = verbose[index]?.[0];
    if (name.endsWith('/')) {
      if (type !== 'd') {
        throw new Error('internal-live archive directory has an unsafe type');
      }
    } else {
      if (type !== '-') {
        throw new Error('internal-live archive contains a link or special file');
      }
      files.push(name);
    }
  });

  const evidenceValue = parseJsonBytes(
    await archiveEntry(
      runner,
      archive,
      EVIDENCE_ENTRY,
      MAX_PACKAGE_EVIDENCE_BYTES,
    ),
    'internal-live package evidence',
    MAX_PACKAGE_EVIDENCE_BYTES,
  );
  const evidence = parsePackageArtifactEvidence(evidenceValue);
  const expectedFiles = new Set([
    EVIDENCE_ENTRY,
    ...evidence.files.map((file) => `package/${file.path}`),
  ]);
  if (
    files.length !== expectedFiles.size ||
    files.some((file) => !expectedFiles.has(file))
  ) {
    throw new Error('archive entries do not exactly match package evidence');
  }

  const observedFiles: PackageArtifactEvidenceFileV1[] = [];
  for (const file of evidence.files) {
    const bytes = await archiveEntry(
      runner,
      archive,
      `package/${file.path}`,
      Math.min(Math.max(file.size + 1, 1), MAX_COMMAND_STDOUT_BYTES),
    );
    observedFiles.push({
      path: file.path,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }

  const packageManifest = parseJsonBytes(
    await archiveEntry(runner, archive, PACKAGE_MANIFEST_ENTRY),
    'internal-live package.json',
  );
  if (
    typeof packageManifest !== 'object' ||
    packageManifest === null ||
    Array.isArray(packageManifest) ||
    typeof (packageManifest as Record<string, unknown>)['name'] !== 'string' ||
    typeof (packageManifest as Record<string, unknown>)['version'] !== 'string'
  ) {
    throw new Error('internal-live package.json has an unsupported shape');
  }
  return {
    package_name: (packageManifest as Record<string, string>)['name']!,
    package_version: (packageManifest as Record<string, string>)['version']!,
    build_identity: parseJsonBytes(
      await archiveEntry(runner, archive, BUILD_IDENTITY_ENTRY),
      'internal-live build identity',
    ),
    artifact_evidence: evidence,
    package_files: observedFiles,
  };
}

function parseCliJson(stdout: Buffer, operation: string): Record<string, unknown> {
  const value = parseJsonBytes(stdout, operation);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${operation} returned an unsupported result`);
  }
  return value as Record<string, unknown>;
}

export async function internalLiveNpmVersion(
  npmPath: string,
  runner: InternalLiveCommandRunner = runInternalLiveCommand,
): Promise<string> {
  const output = requireCommandSuccess(
    await runner(npmPath, ['--version'], { maxStdoutBytes: 1024 }),
    'npm version inspection',
  )
    .toString('utf8')
    .trim();
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(output)) {
    throw new Error('npm returned an unsupported version');
  }
  return output;
}

export function defaultInternalLiveNpmPath(nodePath = process.execPath): string {
  const candidate = join(dirname(nodePath), 'npm');
  const resolved = realpathSync(candidate);
  if (!lstatSync(resolved).isFile()) {
    throw new Error('npm executable is unavailable beside Node');
  }
  return resolved;
}

export function internalLiveUpdateRoot(configPath: string): string {
  return join(dirname(resolve(configPath)), 'internal-live-updates');
}

export function internalLiveGlobalInstallLayout(cliPath: string): {
  packageRoot: string;
  prefix: string;
} {
  const packageRoot = dirname(dirname(dirname(resolve(cliPath))));
  const nodeModules = dirname(packageRoot);
  const lib = dirname(nodeModules);
  const prefix = dirname(lib);
  if (
    basename(packageRoot) !== 'echo-brain' ||
    basename(nodeModules) !== 'node_modules' ||
    basename(lib) !== 'lib' ||
    prefix === dirname(prefix)
  ) {
    throw new Error('installed CLI is outside a supported global npm prefix');
  }
  return { packageRoot, prefix };
}

export class NodeInternalLiveUpdateOperations
  implements InternalLiveUpdateOperations
{
  private readonly fetchImpl: typeof fetch;
  private readonly runner: InternalLiveCommandRunner;
  private readonly installRunner: InternalLiveCommandRunner;
  private readonly root: string;
  private readonly artifacts: string;
  private readonly retained: string;
  private readonly backups: string;
  private readonly rollbackBackups: string;
  private readonly packageRoot: string;
  private readonly installPrefix: string;

  constructor(private readonly options: NodeInternalLiveUpdateOptions) {
    this.fetchImpl = options.publicFetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('public GitHub release transport is unavailable');
    }
    this.runner = options.commandRunner ?? runInternalLiveCommand;
    this.installRunner = options.commandRunner ?? runPublicNpmInstallCommand;
    this.root = internalLiveUpdateRoot(options.configPath);
    this.artifacts = join(this.root, 'artifacts');
    this.retained = join(this.root, 'retained-packages');
    this.backups = join(this.root, 'state-backups');
    this.rollbackBackups = join(this.root, 'rollback-backups');
    const install = internalLiveGlobalInstallLayout(options.cliPath);
    this.packageRoot = install.packageRoot;
    this.installPrefix = install.prefix;
    for (const directory of [
      this.root,
      this.artifacts,
      this.retained,
      this.backups,
      this.rollbackBackups,
    ]) {
      ensureDirectory(directory);
      assertPrivateOwnedDirectory(directory, 'internal-live update directory');
    }
  }

  async obtainApprovedManifest(): Promise<unknown> {
    const response = await fetchPublicResponse(
      this.fetchImpl,
      this.options.directive.manifest_url,
    );
    return parseJsonBytes(
      await readBoundedResponse(response, MAX_MANIFEST_BYTES),
      'internal-live release manifest',
    );
  }

  async verifyManifestApproval(
    manifest: InternalLiveReleaseManifestV1,
    manifestSha256: string,
  ): Promise<void> {
    const expectedUrl =
      `https://github.com/${manifest.build.repository}/releases/download/` +
      `${encodeURIComponent(manifest.release_tag)}/internal-live-release-manifest.v1.json`;
    if (
      manifestSha256 !== this.options.directive.manifest_sha256 ||
      this.options.directive.manifest_url !== expectedUrl
    ) {
      throw new Error('manifest does not match the Authority-approved directive');
    }
  }

  runtime() {
    return {
      os: process.platform,
      arch: process.arch,
      node: process.version,
      npm: this.options.npmVersion,
    };
  }

  async obtainArtifact(
    manifest: InternalLiveReleaseManifestV1,
  ): Promise<LocalArtifactReference> {
    const path = join(this.artifacts, `${manifest.artifact.sha256}.tgz`);
    if (pathEntryExists(path)) {
      assertPrivateRegularFile(path, 'cached internal-live artifact');
      return {
        reference: { kind: 'internal-live-local-artifact', path },
      };
    }
    const response = await fetchPublicResponse(
      this.fetchImpl,
      manifest.artifact.download_url,
    );
    await writeResponseToFile(response, path, manifest.artifact.size_bytes);
    return { reference: { kind: 'internal-live-local-artifact', path } };
  }

  async digestArtifact(artifact: InternalLiveArtifactReference) {
    const digest = digestFileNoFollow(
      artifactPath(artifact),
      'internal-live artifact',
    );
    return { sha256: digest.sha256, size_bytes: digest.size };
  }

  async inspectArtifact(
    artifact: InternalLiveArtifactReference,
  ): Promise<InspectedInternalLivePackage> {
    return await inspectPackageArchive(this.runner, artifactPath(artifact));
  }

  async currentInstallation(): Promise<InternalLiveInstalledIdentity> {
    return {
      product_version: this.options.productVersion,
      source_sha: this.options.sourceSha,
    };
  }

  private async cli(
    args: readonly string[],
    operation: string,
  ): Promise<Record<string, unknown>> {
    const stdout = requireCommandSuccess(
      await this.runner(
        process.execPath,
        [this.options.cliPath, ...args, '--config', this.options.configPath],
        { maxStdoutBytes: 256 * 1024 },
      ),
      operation,
    );
    return parseCliJson(stdout, operation);
  }

  async serviceIsRunning(): Promise<boolean> {
    const result = await this.cli(['service', 'status'], 'service status');
    const service = result['service'];
    return (
      typeof service === 'object' &&
      service !== null &&
      !Array.isArray(service) &&
      (service as Record<string, unknown>)['loaded'] === true &&
      (service as Record<string, unknown>)['running'] === true
    );
  }

  async stopService(): Promise<void> {
    await this.cli(['service', 'stop'], 'service stop');
  }

  async createBackup(
    transactionId: string,
    stableTimestamp: string,
  ): Promise<{ backup_ref: string }> {
    const backupRef = `backup-${transactionId}`;
    await createProductStateBackup({
      stateDir: this.options.config.state_dir,
      backupRoot: this.backups,
      backupId: backupRef,
      createdAt: stableTimestamp,
      canonicalConfigSha256: canonicalProductConfigSha256(this.options.config),
    });
    return { backup_ref: backupRef };
  }

  async retainCurrentPackage(
    transactionId: string,
  ): Promise<{ package_ref: string }> {
    const packageRef = `previous-${transactionId}`;
    const destination = join(this.retained, `${packageRef}.tgz`);
    if (pathEntryExists(destination)) {
      assertPrivateRegularFile(destination, 'retained previous package');
      return { package_ref: packageRef };
    }
    const stage = join(this.retained, `.pack-${transactionId}`);
    if (pathEntryExists(stage)) rmSync(stage, { recursive: true });
    mkdirSync(stage, { mode: 0o700 });
    try {
      const stdout = requireCommandSuccess(
        await this.runner(
          this.options.npmPath,
          [
            'pack',
            '--ignore-scripts',
            '--json',
            '--pack-destination',
            stage,
            this.packageRoot,
          ],
          { maxStdoutBytes: 1024 * 1024 },
        ),
        'previous package retention',
      );
      const result = JSON.parse(stdout.toString('utf8')) as unknown;
      if (
        !Array.isArray(result) ||
        result.length !== 1 ||
        typeof (result[0] as { filename?: unknown })?.filename !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._+-]*\.tgz$/u.test(
          (result[0] as { filename: string }).filename,
        )
      ) {
        throw new Error('npm pack returned an unsupported retained package');
      }
      const source = join(stage, (result[0] as { filename: string }).filename);
      if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) {
        throw new Error('npm pack did not create a regular package');
      }
      chmodSync(source, 0o600);
      renameSync(source, destination);
      fsyncDirectory(this.retained);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    assertPrivateRegularFile(destination, 'retained previous package');
    return { package_ref: packageRef };
  }

  private async install(path: string, operation: string): Promise<void> {
    assertPrivateRegularFile(path, 'internal-live install package');
    const npmConfig = publicNpmInstallConfigPaths(this.root);
    requireCommandSuccess(
      await this.installRunner(
        this.options.npmPath,
        [
          'install',
          '--global',
          '--no-audit',
          '--no-fund',
          '--no-update-notifier',
          '--registry=https://registry.npmjs.org/',
          `--userconfig=${npmConfig.userconfig}`,
          `--globalconfig=${npmConfig.globalconfig}`,
          '--prefix',
          this.installPrefix,
          path,
        ],
        {
          cwd: this.root,
          timeoutMs: COMMAND_TIMEOUT_MS,
          maxStdoutBytes: 4 * 1024 * 1024,
        },
      ),
      operation,
    );
  }

  async installCandidate(
    artifact: InternalLiveArtifactReference,
    _transactionId: string,
  ): Promise<void> {
    await this.install(artifactPath(artifact), 'candidate package installation');
  }

  async reconfigureCandidate(): Promise<void> {
    await this.cli(['reconfigure'], 'candidate reconfigure');
  }

  async startService(): Promise<void> {
    await this.cli(['service', 'start'], 'service start');
  }

  async doctor(): Promise<InternalLiveDoctorSummary> {
    const result = await this.cli(
      ['doctor', '--local-only'],
      'local product doctor',
    );
    const checks = result['checks'];
    if (!Array.isArray(checks) || checks.length === 0) {
      throw new Error('product doctor returned no checks');
    }
    const passed = checks.filter(
      (check) =>
        typeof check === 'object' &&
        check !== null &&
        !Array.isArray(check) &&
        (check as Record<string, unknown>)['ok'] === true,
    ).length;
    return {
      ok: result['ok'] === true,
      passed,
      total: checks.length,
    };
  }

  async installPreviousPackage(
    packageRef: string,
    _transactionId: string,
  ): Promise<void> {
    await this.install(
      join(this.retained, `${packageRef}.tgz`),
      'previous package restoration',
    );
  }

  async restoreBackup(
    backupRef: string,
    transactionId: string,
    stableTimestamp: string,
  ): Promise<void> {
    await restoreProductStateBackup({
      stateDir: this.options.config.state_dir,
      backupDirectory: join(this.backups, backupRef),
      automaticBackupRoot: this.rollbackBackups,
      operationId: `rollback-${transactionId}`,
      restoredAt: stableTimestamp,
      preRestoreBackupId: `pre-rollback-${transactionId}`,
      preRestoreBackupCreatedAt: stableTimestamp,
      canonicalConfigSha256: canonicalProductConfigSha256(this.options.config),
    });
  }

  async reconfigurePrevious(): Promise<void> {
    await this.cli(['reconfigure'], 'previous package reconfigure');
  }

  now(): string {
    return this.options.now();
  }
}
