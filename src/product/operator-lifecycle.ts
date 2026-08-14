import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AdapterInstanceConfig } from '../core/index.js';
import type { AdapterDiagnostic } from './adapter-diagnostics.js';
import {
  validateProductRuntimeConfig,
  type ProductRuntimeConfig,
  type StateFilesystemClassification,
} from './config.js';
import {
  inspectLaunchdService,
  launchdTarget,
  renderLaunchAgentPlist,
  requireLaunchctlSuccess,
  runLaunchctl,
  type LaunchctlRunner,
  type LaunchdServiceState,
} from './launchd-service.js';
import {
  nodeOperatorFileSystem,
  type OperatorFileSystem,
} from './operator-io.js';
import { resolveProductStatePaths } from './paths.js';
import { parseJson } from '../util/json.js';
import {
  credentialPathIsWithin,
  createProductCredentialResolver,
  isServiceSafeCredentialReference,
  productFileCredentialPath,
  type ProductCredentialResolver,
} from './credentials.js';
import {
  assertNoPermissiveDarwinAcl,
  pathIsWithin,
} from './secure-local-files.js';
import { canonicalProductConfigSha256 } from './lifecycle-lock.js';
import type { PackagedBuildIdentityV1 } from './build-identity.js';
import { GRANOLA_API_KEY_RE } from '../adapters/meeting-sources/granola/granola-api-client.js';
import {
  DEFAULT_APPROVE_REACTION,
  DEFAULT_REJECT_REACTION,
} from '../adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import { assertConfiguredApprovalPublicationPreflight } from './default-adapters.js';

export type ProductServiceAction =
  | 'install'
  | 'start'
  | 'stop'
  | 'restart'
  | 'status'
  | 'uninstall';

export type OperatorFailureCode =
  | 'unsupported_platform'
  | 'invalid_operator_path'
  | 'not_initialized'
  | 'installation_conflict'
  | 'service_conflict'
  | 'service_command_failed'
  | 'adapter_unavailable';

export class ProductOperatorError extends Error {
  constructor(
    public readonly code: OperatorFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProductOperatorError';
  }
}

export interface ProductOperatorDependencies {
  fileSystem?: OperatorFileSystem;
  launchctl?: LaunchctlRunner;
  platform?: NodeJS.Platform;
  architecture?: string;
  uid?: number;
  homeDirectory?: string;
  nodePath?: string;
  nodeVersion?: string;
  cliPath: string;
  productVersion: string;
  buildIdentity: Pick<
    PackagedBuildIdentityV1,
    'source_sha' | 'source_kind'
  >;
  resolveCredential?: ProductCredentialResolver;
  /**
   * Offline package safety check reconfigure runs before rewriting the
   * installation record: every configured adapter factory must exist in the
   * installed package and must statically accept its own configuration. It
   * constructs no adapter and must not resolve a credential, open state, run
   * a health check, or contact a provider, so update and recovery never
   * depend on provider uptime. Re-pinning an exactly unchanged record skips
   * it. The CLI always supplies the default implementation; when absent the
   * operator fails closed rather than re-pinning an unverified package.
   */
  verifyConfiguredAdapters?: (config: ProductRuntimeConfig) => void | Promise<void>;
}

export interface ProductInstallationRecord {
  schema_version: 1;
  product: 'echo-brain';
  product_version: string;
  /** Added in-place so an existing V1 installation can be upgraded by reconfigure. */
  source_sha?: string;
  source_kind?: PackagedBuildIdentityV1['source_kind'];
  config_sha256: string;
  config_path: string;
  state_dir: string;
  node_path: string;
  cli_path: string;
  service: {
    platform: 'launchd';
    label: string;
    plist_path: string;
    stdout_path: string;
    stderr_path: string;
  };
}

export interface ProductOperatorStatus {
  initialized: boolean;
  package_identity: {
    product_version: string;
    source_sha: string;
    source_kind: PackagedBuildIdentityV1['source_kind'];
  };
  installation_path: string;
  config_path: string;
  state_dir: string;
  service: LaunchdServiceState & {
    supported: boolean;
    installed: boolean;
    label: string;
    plist_path: string;
    stdout_path: string;
    stderr_path: string;
  };
  issues: readonly string[];
}

export interface ProductDoctorCheck {
  id:
    | 'platform'
    | 'config'
    | 'state-filesystem'
    | 'state-directory'
    | 'installation-manifest'
    | 'node-runtime'
    | 'cli-entrypoint'
    | 'service-plist'
    | 'service-running'
    | 'service-credentials'
    | 'organization-state'
    | 'adapters';
  ok: boolean;
  detail: string;
}

export interface ProductDoctorReport {
  ok: boolean;
  checks: readonly ProductDoctorCheck[];
  adapters: readonly AdapterDiagnostic[];
}

interface OperatorContext {
  configPath: string;
  stateDirectory: string;
  installationPath: string;
  label: string;
  plistPath: string;
  stdoutPath: string;
  stderrPath: string;
  credentialsDirectory: string;
  nodePath: string;
  cliPath: string;
  uid: number;
}

const INSTALLATION_FILE = 'operator-installation.v1.json';
const EXPECTED_NODE_VERSION = 'v22.22.1';

function modeIsPrivate(mode: number, expected: number): boolean {
  return (mode & 0o777) === expected;
}

function isRecord(value: unknown): value is ProductInstallationRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  const service = record['service'];
  return (
    record['schema_version'] === 1 &&
    record['product'] === 'echo-brain' &&
    typeof record['product_version'] === 'string' &&
    ((record['source_sha'] === undefined &&
      record['source_kind'] === undefined) ||
      (typeof record['source_sha'] === 'string' &&
        /^[a-f0-9]{40}$/.test(record['source_sha']) &&
        (record['source_kind'] === 'materialized-commit' ||
          record['source_kind'] === 'worktree-head-unverified'))) &&
    typeof record['config_sha256'] === 'string' &&
    typeof record['config_path'] === 'string' &&
    typeof record['state_dir'] === 'string' &&
    typeof record['node_path'] === 'string' &&
    typeof record['cli_path'] === 'string' &&
    service !== null &&
    typeof service === 'object' &&
    !Array.isArray(service) &&
    (service as Record<string, unknown>)['platform'] === 'launchd' &&
    typeof (service as Record<string, unknown>)['label'] === 'string' &&
    typeof (service as Record<string, unknown>)['plist_path'] === 'string' &&
    typeof (service as Record<string, unknown>)['stdout_path'] === 'string' &&
    typeof (service as Record<string, unknown>)['stderr_path'] === 'string'
  );
}

function sameRecord(
  left: ProductInstallationRecord,
  right: ProductInstallationRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameInstallationIdentity(
  left: ProductInstallationRecord,
  right: ProductInstallationRecord,
): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.product === right.product &&
    left.config_path === right.config_path &&
    left.state_dir === right.state_dir &&
    left.node_path === right.node_path &&
    left.cli_path === right.cli_path &&
    JSON.stringify(left.service) === JSON.stringify(right.service)
  );
}

function check(
  id: ProductDoctorCheck['id'],
  ok: boolean,
  detail: string,
): ProductDoctorCheck {
  return { id, ok, detail };
}

export interface ServiceCredentialRecommendation {
  configured_ref: string;
  service_safe_ref: string;
}

export interface ProductOnboardResult {
  config_path: string;
  state_dir: string;
  credential_path: string;
  slack_credential_path: string;
  config: ProductRuntimeConfig;
}

export interface ProductSlackApprovalBootstrapProfile {
  channelId: string;
  reviewerUserId: string;
  reviewerName: string;
}

export type ProductBootstrapCredentialKind = 'granola' | 'slack';

const SLACK_BOT_TOKEN_RE = /^xoxb-[A-Za-z0-9-]{8,}$/;

export interface ProductOnboardOptions {
  fileSystem?: OperatorFileSystem;
  /** The canonical employee owner the created Granola source is bound to. */
  granolaOwnerEmail: string;
  slackApproval: ProductSlackApprovalBootstrapProfile;
}

function canonicalLowercaseEmail(value: string): boolean {
  if (value.length === 0 || value.length > 254 || /\s/u.test(value)) return false;
  const [local, domain, extra] = value.split('@');
  return (
    value === value.toLowerCase() &&
    value === value.trim() &&
    local !== undefined &&
    local.length > 0 &&
    domain !== undefined &&
    domain.length > 0 &&
    extra === undefined
  );
}

export function createProductOnboardConfig(
  stateDirectory: string,
  granolaOwnerEmail: string,
  slackApproval: ProductSlackApprovalBootstrapProfile,
): ProductRuntimeConfig {
  if (!canonicalLowercaseEmail(granolaOwnerEmail)) {
    throw new ProductOperatorError(
      'installation_conflict',
      'Granola owner must be a canonical lowercase email address',
    );
  }
  if (!/^C[A-Z0-9]{2,}$/.test(slackApproval.channelId)) {
    throw new ProductOperatorError(
      'installation_conflict',
      'Slack approval channel must be a canonical Slack channel ID',
    );
  }
  if (!/^[UW][A-Z0-9]{2,}$/.test(slackApproval.reviewerUserId)) {
    throw new ProductOperatorError(
      'installation_conflict',
      'Slack approval reviewer must be a canonical Slack user ID',
    );
  }
  if (
    slackApproval.reviewerName !== slackApproval.reviewerName.trim() ||
    slackApproval.reviewerName.length === 0 ||
    slackApproval.reviewerName.length > 256
  ) {
    throw new ProductOperatorError(
      'installation_conflict',
      'Slack approval reviewer name must be a trimmed non-empty name',
    );
  }
  const credentialPath = join(stateDirectory, 'credentials', 'granola-api-key');
  const slackCredentialPath = join(
    stateDirectory,
    'credentials',
    'slack-bot-token',
  );
  return validateProductRuntimeConfig({
    schema_version: 1,
    lane: 'team-product',
    state_dir: stateDirectory,
    meeting_sources: [
      {
        adapter_id: 'granola',
        instance_id: 'owner-bound-v1',
        credential_ref: `file:${credentialPath}`,
        settings: {
          owner_email: granolaOwnerEmail,
          page_size: 1,
        },
      },
    ],
    decision_processor: {
      adapter_id: 'structured-text',
      instance_id: 'primary',
      settings: {},
    },
    delivery_surfaces: [
      {
        adapter_id: 'jsonl-outbox',
        instance_id: 'local',
        settings: {
          path: join(stateDirectory, 'outbox.jsonl'),
          destination_id: 'local-outbox',
        },
      },
    ],
    approval_mode: 'adapter',
    approval_surface: {
      adapter_id: 'slack-reactions',
      instance_id: 'internal-approvals',
      credential_ref: `file:${slackCredentialPath}`,
      settings: {
        channel_id: slackApproval.channelId,
        reviewer: {
          slack_user_id: slackApproval.reviewerUserId,
          name: slackApproval.reviewerName,
        },
        approve_reaction: DEFAULT_APPROVE_REACTION,
        reject_reaction: DEFAULT_REJECT_REACTION,
      },
    },
  });
}

function slackChannelId(adapter: AdapterInstanceConfig): string | undefined {
  const value = adapter.settings['channel_id'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Pure configuration rule: the Slack approval surface and generic Slack
 * delivery may not share one channel, so review traffic stays in the review
 * channel and a delivery post can never be mistaken for an approval card. It
 * reads only the configuration -- it contacts no provider and discovers no
 * Slack channel.
 */
export function assertSeparateSlackChannels(config: ProductRuntimeConfig): void {
  if (
    config.approval_mode !== 'adapter' ||
    config.approval_surface.adapter_id !== 'slack-reactions'
  ) {
    return;
  }
  const approvalChannel = slackChannelId(config.approval_surface);
  if (approvalChannel === undefined) return;
  const conflicts = config.delivery_surfaces.filter(
    (surface) =>
      surface.adapter_id === 'slack' &&
      slackChannelId(surface) === approvalChannel,
  );
  if (conflicts.length === 0) return;
  throw new ProductOperatorError(
    'installation_conflict',
    `Slack approval channel ${approvalChannel} is also configured for Slack delivery (${conflicts
      .map((surface) => `delivery-surface '${surface.instance_id}'`)
      .join(', ')}); give generic Slack delivery its own channel`,
  );
}

function normalizedAbsolute(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path;
}

function closestExistingAncestor(
  path: string,
  fileSystem: OperatorFileSystem,
): string {
  let candidate = path;
  for (;;) {
    if (fileSystem.exists(candidate)) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
}

function assertCanonicalDirectoryPath(
  path: string,
  description: string,
  fileSystem: OperatorFileSystem,
): void {
  const ancestor = closestExistingAncestor(path, fileSystem);
  const info = fileSystem.lstat(ancestor);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ProductOperatorError(
      'installation_conflict',
      `${description} ancestor must be a direct directory: ${ancestor}`,
    );
  }
  if (fileSystem.realpath(ancestor) !== ancestor) {
    throw new ProductOperatorError(
      'invalid_operator_path',
      `${description} must use canonical paths without symbolic-link ancestors`,
    );
  }
  const currentUid = process.getuid?.();
  if (
    currentUid === undefined ||
    info.uid !== currentUid ||
    (info.mode & 0o022) !== 0
  ) {
    throw new ProductOperatorError(
      'installation_conflict',
      `${description} ancestor must be owned by the current user and not group- or world-writable: ${ancestor}`,
    );
  }
  assertNoPermissiveDarwinAcl(ancestor, `${description} ancestor`);
}

function assertBootstrapCredential(
  kind: ProductBootstrapCredentialKind,
  value: string,
): void {
  const valid =
    kind === 'granola'
      ? GRANOLA_API_KEY_RE.test(value)
      : SLACK_BOT_TOKEN_RE.test(value);
  if (!valid) {
    throw new ProductOperatorError(
      'installation_conflict',
      `${kind === 'granola' ? 'Granola' : 'Slack'} credential is not a valid API token`,
    );
  }
}

export function createProductBootstrapCredential(
  path: string,
  value: string,
  kind: ProductBootstrapCredentialKind,
  providedFileSystem?: OperatorFileSystem,
): void {
  assertBootstrapCredential(kind, value);
  const fileSystem = providedFileSystem ?? nodeOperatorFileSystem;
  const credentialsDirectory = dirname(path);
  fileSystem.mkdir(credentialsDirectory, { recursive: true, mode: 0o700 });
  fileSystem.chmod(credentialsDirectory, 0o700);
  assertNoPermissiveDarwinAcl(
    credentialsDirectory,
    'onboard credentials directory',
  );
  if (!fileSystem.createExclusive(path, value, 0o600)) {
    throw new ProductOperatorError(
      'installation_conflict',
      `refusing to replace existing credential: ${path}`,
    );
  }
  fileSystem.chmod(path, 0o600);
  assertNoPermissiveDarwinAcl(
    path,
    kind === 'granola' ? 'Granola credential' : 'Slack credential',
  );
}

/**
 * Create a secret-free first-run config. This is intentionally separate from
 * `init`: it owns only brand-new paths and never edits an existing config.
 */
export function onboardProduct(
  configPath: string,
  stateDirectory: string,
  options: ProductOnboardOptions,
): ProductOnboardResult {
  const fileSystem = options.fileSystem ?? nodeOperatorFileSystem;
  if (!normalizedAbsolute(configPath)) {
    throw new ProductOperatorError(
      'invalid_operator_path',
      'onboard --config must be a normalized absolute path',
    );
  }
  if (!normalizedAbsolute(stateDirectory)) {
    throw new ProductOperatorError(
      'invalid_operator_path',
      'onboard --state-dir must be a normalized absolute path',
    );
  }
  if (
    configPath === stateDirectory ||
    pathIsWithin(configPath, stateDirectory)
  ) {
    throw new ProductOperatorError(
      'invalid_operator_path',
      'onboard config must live outside state_dir so state restore cannot replace its own control file',
    );
  }
  if (fileSystem.exists(configPath)) {
    throw new ProductOperatorError(
      'installation_conflict',
      `refusing to replace existing config: ${configPath}`,
    );
  }
  assertCanonicalDirectoryPath(
    dirname(configPath),
    'onboard config path',
    fileSystem,
  );
  assertCanonicalDirectoryPath(
    stateDirectory,
    'onboard state path',
    fileSystem,
  );
  if (fileSystem.exists(stateDirectory)) {
    const info = fileSystem.lstat(stateDirectory);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      fileSystem.list(stateDirectory).length > 0
    ) {
      throw new ProductOperatorError(
        'installation_conflict',
        `onboard state target must be a new or empty direct directory: ${stateDirectory}`,
      );
    }
  }
  const credentialPath = join(stateDirectory, 'credentials', 'granola-api-key');
  const slackCredentialPath = join(
    stateDirectory,
    'credentials',
    'slack-bot-token',
  );
  const config = createProductOnboardConfig(
    stateDirectory,
    options.granolaOwnerEmail,
    options.slackApproval,
  );
  const configParent = dirname(configPath);
  if (!fileSystem.exists(configParent)) {
    fileSystem.mkdir(configParent, { recursive: true, mode: 0o700 });
  }
  const parentInfo = fileSystem.lstat(configParent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new ProductOperatorError(
      'installation_conflict',
      `config parent must be a direct directory: ${configParent}`,
    );
  }
  if (fileSystem.realpath(configParent) !== configParent) {
    throw new ProductOperatorError(
      'invalid_operator_path',
      'created config parent did not resolve canonically',
    );
  }
  fileSystem.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  if (fileSystem.realpath(stateDirectory) !== stateDirectory) {
    throw new ProductOperatorError(
      'invalid_operator_path',
      'created state directory did not resolve canonically',
    );
  }
  fileSystem.chmod(stateDirectory, 0o700);
  assertNoPermissiveDarwinAcl(stateDirectory, 'onboard state directory');
  const created = fileSystem.createExclusive(
    configPath,
    `${JSON.stringify(config, null, 2)}\n`,
    0o600,
  );
  if (!created) {
    throw new ProductOperatorError(
      'installation_conflict',
      `config appeared during onboarding; it was not replaced: ${configPath}`,
    );
  }
  fileSystem.chmod(configPath, 0o600);
  const credentialsDirectory = dirname(credentialPath);
  fileSystem.mkdir(credentialsDirectory, { recursive: true, mode: 0o700 });
  fileSystem.chmod(credentialsDirectory, 0o700);
  assertNoPermissiveDarwinAcl(
    credentialsDirectory,
    'onboard credentials directory',
  );
  const loaded = validateProductRuntimeConfig(
    parseJson(fileSystem.readText(configPath)),
  );
  return {
    config_path: configPath,
    state_dir: stateDirectory,
    credential_path: credentialPath,
    slack_credential_path: slackCredentialPath,
    config: loaded,
  };
}

export class ProductOperator {
  private readonly fileSystem: OperatorFileSystem;
  private readonly launchctl: LaunchctlRunner;
  private readonly platform: NodeJS.Platform;
  private readonly architecture: string;
  private readonly homeDirectory: string;
  private readonly nodeVersion: string;
  private readonly productVersion: string;
  private readonly buildIdentity: ProductOperatorDependencies['buildIdentity'];
  private readonly resolveCredential: ProductCredentialResolver;
  private readonly verifyConfiguredAdapters: (
    config: ProductRuntimeConfig,
  ) => void | Promise<void>;
  private readonly context: OperatorContext;

  constructor(
    configPath: string,
    private readonly config: ProductRuntimeConfig,
    dependencies: ProductOperatorDependencies,
  ) {
    this.fileSystem = dependencies.fileSystem ?? nodeOperatorFileSystem;
    this.launchctl = dependencies.launchctl ?? runLaunchctl;
    this.platform = dependencies.platform ?? process.platform;
    this.architecture = dependencies.architecture ?? process.arch;
    this.homeDirectory = dependencies.homeDirectory ?? homedir();
    this.nodeVersion = dependencies.nodeVersion ?? process.version;
    this.productVersion = dependencies.productVersion;
    this.buildIdentity = dependencies.buildIdentity;
    this.resolveCredential =
      dependencies.resolveCredential ?? createProductCredentialResolver();
    this.verifyConfiguredAdapters =
      dependencies.verifyConfiguredAdapters ??
      (() => {
        throw new Error(
          'no configured-adapter verifier is installed for this operator',
        );
      });
    this.context = this.createContext(
      configPath,
      dependencies.nodePath ?? process.execPath,
      dependencies.cliPath,
      dependencies.uid ?? process.getuid?.(),
    );
  }

  private createContext(
    configPath: string,
    nodePath: string,
    cliPath: string,
    uid: number | undefined,
  ): OperatorContext {
    for (const [name, path] of [
      ['config', configPath],
      ['state', this.config.state_dir],
      ['home', this.homeDirectory],
      ['node', nodePath],
      ['CLI', cliPath],
    ] as const) {
      if (!isAbsolute(path)) {
        throw new ProductOperatorError(
          'invalid_operator_path',
          `${name} path must be absolute`,
        );
      }
    }
    if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
      throw new ProductOperatorError(
        'unsupported_platform',
        'a numeric user id is required for a launchd user service',
      );
    }
    let canonicalConfig: string;
    try {
      const info = this.fileSystem.lstat(configPath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(
          'configuration must be a regular non-symbolic-link file',
        );
      }
      canonicalConfig = this.fileSystem.realpath(configPath);
    } catch (error) {
      throw new ProductOperatorError(
        'invalid_operator_path',
        `cannot resolve operator configuration: ${(error as Error).message}`,
      );
    }
    const canonicalNode = this.canonicalFile(nodePath, 'Node runtime');
    const canonicalCli = this.canonicalFile(cliPath, 'CLI entrypoint');
    const stateDirectory = resolve(this.config.state_dir);
    if (
      canonicalConfig === stateDirectory ||
      pathIsWithin(canonicalConfig, stateDirectory)
    ) {
      throw new ProductOperatorError(
        'invalid_operator_path',
        'operator configuration must live outside state_dir',
      );
    }
    const paths = resolveProductStatePaths(stateDirectory);
    const fingerprint = createHash('sha256')
      .update(`${canonicalConfig}\u0000${stateDirectory}`)
      .digest('hex')
      .slice(0, 12);
    const label = `com.echo.brain.team-product.${fingerprint}`;
    return {
      configPath: canonicalConfig,
      stateDirectory,
      installationPath: join(paths.manifests, INSTALLATION_FILE),
      label,
      plistPath: join(
        resolve(this.homeDirectory),
        'Library',
        'LaunchAgents',
        `${label}.plist`,
      ),
      stdoutPath: join(paths.logs, 'service.stdout.log'),
      stderrPath: join(paths.logs, 'service.stderr.log'),
      credentialsDirectory: join(paths.root, 'credentials'),
      nodePath: canonicalNode,
      cliPath: canonicalCli,
      uid,
    };
  }

  private canonicalFile(path: string, description: string): string {
    try {
      const canonical = this.fileSystem.realpath(path);
      const info = this.fileSystem.lstat(canonical);
      if (!info.isFile()) throw new Error('not a regular file');
      return canonical;
    } catch (error) {
      throw new ProductOperatorError(
        'invalid_operator_path',
        `${description} is unavailable: ${(error as Error).message}`,
      );
    }
  }

  private assertSupportedPlatform(): void {
    if (this.platform !== 'darwin' || this.architecture !== 'arm64') {
      throw new ProductOperatorError(
        'unsupported_platform',
        `launchd lifecycle requires darwin/arm64; observed ${this.platform}/${this.architecture}`,
      );
    }
  }

  private expectedRecord(): ProductInstallationRecord {
    const context = this.context;
    return {
      schema_version: 1,
      product: 'echo-brain',
      product_version: this.productVersion,
      source_sha: this.buildIdentity.source_sha,
      source_kind: this.buildIdentity.source_kind,
      config_sha256: canonicalProductConfigSha256(this.config),
      config_path: context.configPath,
      state_dir: context.stateDirectory,
      node_path: context.nodePath,
      cli_path: context.cliPath,
      service: {
        platform: 'launchd',
        label: context.label,
        plist_path: context.plistPath,
        stdout_path: context.stdoutPath,
        stderr_path: context.stderrPath,
      },
    };
  }

  private expectedPlist(): string {
    const context = this.context;
    return renderLaunchAgentPlist({
      label: context.label,
      nodePath: context.nodePath,
      cliPath: context.cliPath,
      configPath: context.configPath,
      stateDirectory: context.stateDirectory,
      stdoutPath: context.stdoutPath,
      stderrPath: context.stderrPath,
    });
  }

  private configuredCredentialReferences(): readonly string[] {
    return [
      ...this.config.meeting_sources,
      this.config.decision_processor,
      ...this.config.delivery_surfaces,
      ...(this.config.approval_mode === 'adapter'
        ? [this.config.approval_surface]
        : []),
    ].flatMap((adapter) =>
      adapter.credential_ref === undefined ? [] : [adapter.credential_ref],
    );
  }

  private serviceCredentialRecommendations(): readonly ServiceCredentialRecommendation[] {
    const candidates = this.configuredCredentialReferences().flatMap(
      (reference) => {
        if (
          isServiceSafeCredentialReference(
            reference,
            this.context.credentialsDirectory,
          )
        ) {
          return [];
        }
        const referenceName = reference.includes(':')
          ? reference.slice(reference.indexOf(':') + 1)
          : reference;
        const filename = referenceName
          .toLowerCase()
          .replaceAll('_', '-')
          .replace(/[^a-z0-9.-]/g, '-');
        return [{ reference, filename }];
      },
    );
    const counts = new Map<string, number>();
    for (const candidate of candidates) {
      counts.set(candidate.filename, (counts.get(candidate.filename) ?? 0) + 1);
    }
    return candidates.map(({ reference, filename }) => {
      const uniqueName =
        counts.get(filename) === 1
          ? filename
          : `${filename}-${createHash('sha256')
              .update(reference)
              .digest('hex')
              .slice(0, 8)}`;
      return {
        configured_ref: reference,
        service_safe_ref: `file:${join(
          this.context.credentialsDirectory,
          uniqueName,
        )}`,
      };
    });
  }

  private assertServiceSafeCredentials(): void {
    const recommendations = this.serviceCredentialRecommendations();
    if (recommendations.length === 0) return;
    throw new ProductOperatorError(
      'service_command_failed',
      `launchd cannot safely persist configured credential refs (${recommendations
        .map((entry) => entry.configured_ref)
        .join(
          ', ',
        )}); store each secret in its recommended mode-0600 file and update the config to ${recommendations
        .map((entry) => entry.service_safe_ref)
        .join(', ')}`,
    );
  }

  private assertServiceCredentialsReadable(): void {
    this.assertServiceSafeCredentials();
    for (const reference of this.configuredCredentialReferences()) {
      try {
        const path = productFileCredentialPath(reference);
        if (
          path === undefined ||
          !credentialPathIsWithin(path, this.context.credentialsDirectory)
        ) {
          throw new Error(
            'credential file must be contained by the managed credentials directory',
          );
        }
        const credentialsRoot = this.fileSystem.lstat(
          this.context.credentialsDirectory,
        );
        if (
          credentialsRoot.isSymbolicLink() ||
          !credentialsRoot.isDirectory() ||
          this.fileSystem.realpath(this.context.credentialsDirectory) !==
            this.context.credentialsDirectory ||
          credentialsRoot.uid !== this.context.uid ||
          (credentialsRoot.mode & 0o077) !== 0
        ) {
          throw new Error(
            'managed credentials directory must be canonical, owned by the service user, and private',
          );
        }
        assertNoPermissiveDarwinAcl(
          this.context.credentialsDirectory,
          'managed credentials directory',
        );
        let parent = dirname(path);
        while (parent !== this.context.credentialsDirectory) {
          if (
            !credentialPathIsWithin(parent, this.context.credentialsDirectory)
          ) {
            throw new Error('credential parent escapes the managed directory');
          }
          const parentInfo = this.fileSystem.lstat(parent);
          if (
            parentInfo.isSymbolicLink() ||
            !parentInfo.isDirectory() ||
            this.fileSystem.realpath(parent) !== parent ||
            parentInfo.uid !== this.context.uid ||
            (parentInfo.mode & 0o077) !== 0
          ) {
            throw new Error(
              'credential parent directories must be canonical, owned by the service user, and private',
            );
          }
          assertNoPermissiveDarwinAcl(parent, 'credential parent directory');
          parent = dirname(parent);
        }
        const credentialInfo = this.fileSystem.lstat(path);
        if (
          credentialInfo.isSymbolicLink() ||
          !credentialInfo.isFile() ||
          credentialInfo.uid !== this.context.uid ||
          (credentialInfo.mode & 0o077) !== 0
        ) {
          throw new Error(
            'credential file must be regular, owned by the service user, and private',
          );
        }
        assertNoPermissiveDarwinAcl(path, 'credential file');
        const value = this.resolveCredential(reference);
        if (value === undefined || value.length === 0) {
          throw new Error('credential resolved to an empty value');
        }
      } catch (error) {
        throw new ProductOperatorError(
          'service_command_failed',
          `service credential ${reference} is unavailable or insecure: ${(error as Error).message}`,
        );
      }
    }
  }

  preflightServiceStart(): void {
    this.assertSupportedPlatform();
    this.requireCurrentRecord();
    this.assertServiceCredentialsReadable();
  }

  /** Validate the immutable service identity again inside the launched child. */
  preflightServiceRun(): void {
    this.assertSupportedPlatform();
    this.requireCurrentRecord();
    if (!this.plistInstalled()) {
      throw new ProductOperatorError(
        'not_initialized',
        'LaunchAgent plist is missing for this service invocation',
      );
    }
    this.assertServiceCredentialsReadable();
  }

  private ensureDirectory(path: string, mode = 0o700): void {
    this.fileSystem.mkdir(path, { recursive: true, mode });
    const info = this.fileSystem.lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ProductOperatorError(
        'installation_conflict',
        `operator path is not a direct directory: ${path}`,
      );
    }
    this.fileSystem.chmod(path, mode);
  }

  private ensurePrivateFile(path: string): void {
    const created = this.fileSystem.createExclusive(path, '', 0o600);
    const info = this.fileSystem.lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ProductOperatorError(
        'installation_conflict',
        `operator path is not a direct regular file: ${path}`,
      );
    }
    if (!created || !modeIsPrivate(info.mode, 0o600)) {
      this.fileSystem.chmod(path, 0o600);
    }
  }

  private readRecord(): ProductInstallationRecord | null {
    if (!this.fileSystem.exists(this.context.installationPath)) return null;
    const info = this.fileSystem.lstat(this.context.installationPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ProductOperatorError(
        'installation_conflict',
        'operator installation manifest is not a regular file',
      );
    }
    let value: unknown;
    try {
      value = parseJson(
        this.fileSystem.readText(this.context.installationPath),
      );
    } catch (error) {
      throw new ProductOperatorError(
        'installation_conflict',
        `operator installation manifest is invalid: ${(error as Error).message}`,
      );
    }
    if (!isRecord(value)) {
      throw new ProductOperatorError(
        'installation_conflict',
        'operator installation manifest has an unsupported shape',
      );
    }
    return value;
  }

  private requireCurrentRecord(): ProductInstallationRecord {
    const record = this.readRecord();
    if (record === null) {
      throw new ProductOperatorError(
        'not_initialized',
        'run `echo-brain init --config <absolute-path>` first',
      );
    }
    if (!sameRecord(record, this.expectedRecord())) {
      throw new ProductOperatorError(
        'installation_conflict',
        'operator installation manifest does not match this config, package, or executable',
      );
    }
    return record;
  }

  private requireInstallationIdentity(): ProductInstallationRecord {
    const record = this.readRecord();
    if (record === null) {
      throw new ProductOperatorError(
        'not_initialized',
        'run `echo-brain init --config <absolute-path>` first',
      );
    }
    if (!sameInstallationIdentity(record, this.expectedRecord())) {
      throw new ProductOperatorError(
        'installation_conflict',
        'operator installation manifest belongs to a different config, state directory, or executable',
      );
    }
    return record;
  }

  private plistInstalled(): boolean {
    if (!this.fileSystem.exists(this.context.plistPath)) return false;
    const info = this.fileSystem.lstat(this.context.plistPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ProductOperatorError(
        'service_conflict',
        'LaunchAgent plist is not a regular file',
      );
    }
    if (
      this.fileSystem.readText(this.context.plistPath) !== this.expectedPlist()
    ) {
      throw new ProductOperatorError(
        'service_conflict',
        'LaunchAgent plist exists but is not owned by this installation',
      );
    }
    return true;
  }

  async init(): Promise<{
    created: boolean;
    installation: ProductInstallationRecord;
    credential_recommendations: readonly ServiceCredentialRecommendation[];
  }> {
    this.assertSupportedPlatform();
    const existing = this.readRecord();
    if (existing !== null && !sameRecord(existing, this.expectedRecord())) {
      throw new ProductOperatorError(
        'installation_conflict',
        'an incompatible operator installation already owns this state directory',
      );
    }
    if (existing === null) assertSeparateSlackChannels(this.config);
    const statePaths = resolveProductStatePaths(this.context.stateDirectory);
    for (const directory of [
      statePaths.root,
      statePaths.logs,
      statePaths.health,
      statePaths.checkpoints,
      statePaths.manifests,
      statePaths.drafts,
      statePaths.briefs,
      this.context.credentialsDirectory,
    ]) {
      this.ensureDirectory(directory);
    }
    this.ensurePrivateFile(this.context.stdoutPath);
    this.ensurePrivateFile(this.context.stderrPath);
    const expected = this.expectedRecord();
    const content = `${JSON.stringify(expected, null, 2)}\n`;
    const created = this.fileSystem.createExclusive(
      this.context.installationPath,
      content,
      0o600,
    );
    const record = this.readRecord();
    if (record === null || !sameRecord(record, expected)) {
      throw new ProductOperatorError(
        'installation_conflict',
        'an incompatible operator installation already owns this state directory',
      );
    }
    this.fileSystem.chmod(this.context.installationPath, 0o600);
    return {
      created,
      installation: record,
      credential_recommendations: this.serviceCredentialRecommendations(),
    };
  }

  async reconfigure(): Promise<{
    updated: boolean;
    installation: ProductInstallationRecord;
  }> {
    this.assertSupportedPlatform();
    const existing = this.readRecord();
    if (existing === null) {
      throw new ProductOperatorError(
        'not_initialized',
        'run `echo-brain init --config <absolute-path>` first',
      );
    }
    const expected = this.expectedRecord();
    if (!sameInstallationIdentity(existing, expected)) {
      throw new ProductOperatorError(
        'installation_conflict',
        'reconfigure may not change config path, state_dir, Node, CLI, or service identity',
      );
    }
    const service = await inspectLaunchdService(
      this.launchctl,
      launchdTarget(this.context.uid, this.context.label),
    );
    if (service.loaded) {
      throw new ProductOperatorError(
        'service_command_failed',
        'service is loaded; stop it before reconfiguring',
      );
    }
    this.assertServiceCredentialsReadable();
    const updated = !sameRecord(existing, expected);
    if (updated) {
      // A changed configuration must satisfy the pure channel-separation rule.
      // A package-only re-pin carries the configuration it already had, so an
      // installation grandfathered before the rule existed can still be
      // re-pinned onto a new package instead of being stranded.
      if (existing.config_sha256 !== expected.config_sha256) {
        assertSeparateSlackChannels(this.config);
      }
      // Any rewrite of the installation record — changed configuration content
      // or a package/build re-pin — first proves offline that this package can
      // run the recorded configuration. No health check runs and no provider
      // is contacted; an exactly unchanged record skips the check.
      try {
        await this.verifyConfiguredAdapters(this.config);
      } catch (error) {
        throw new ProductOperatorError(
          'adapter_unavailable',
          `reconfigure was refused before the installation manifest was updated: ${(error as Error).message}`,
        );
      }
      // Every manifest rewrite, including a package-only re-pin, must prove the
      // package can still resume each unresolved frozen publication. Adapter
      // version is part of that contract, so a config-equal package replacement
      // is not exempt from this stateful, provider-free compatibility check.
      try {
        assertConfiguredApprovalPublicationPreflight(
          this.config,
          this.resolveCredential,
        );
      } catch (error) {
        throw new ProductOperatorError(
          'installation_conflict',
          `reconfigure was refused before the installation manifest was updated: ${(error as Error).message}`,
        );
      }
      this.fileSystem.writePrivate(
        this.context.installationPath,
        `${JSON.stringify(expected, null, 2)}\n`,
      );
      this.fileSystem.chmod(this.context.installationPath, 0o600);
    }
    const current = this.readRecord();
    if (current === null || !sameRecord(current, expected)) {
      throw new ProductOperatorError(
        'installation_conflict',
        'operator installation manifest did not accept the new configuration',
      );
    }
    return { updated, installation: current };
  }

  async status(): Promise<ProductOperatorStatus> {
    const issues: string[] = [];
    const supported =
      this.platform === 'darwin' && this.architecture === 'arm64';
    if (!supported) {
      issues.push(
        `launchd lifecycle requires darwin/arm64; observed ${this.platform}/${this.architecture}`,
      );
    }
    let initialized = false;
    try {
      const record = this.readRecord();
      initialized =
        record !== null && sameRecord(record, this.expectedRecord());
      if (record !== null && !initialized)
        issues.push(
          'operator installation manifest does not match this package',
        );
    } catch (error) {
      issues.push((error as Error).message);
    }
    let installed = false;
    try {
      installed = this.plistInstalled();
    } catch (error) {
      issues.push((error as Error).message);
    }
    let serviceState: LaunchdServiceState = {
      loaded: false,
      running: false,
    };
    if (supported) {
      serviceState = await inspectLaunchdService(
        this.launchctl,
        launchdTarget(this.context.uid, this.context.label),
      );
    }
    return {
      initialized,
      package_identity: {
        product_version: this.productVersion,
        source_sha: this.buildIdentity.source_sha,
        source_kind: this.buildIdentity.source_kind,
      },
      installation_path: this.context.installationPath,
      config_path: this.context.configPath,
      state_dir: this.context.stateDirectory,
      service: {
        supported,
        installed,
        label: this.context.label,
        plist_path: this.context.plistPath,
        stdout_path: this.context.stdoutPath,
        stderr_path: this.context.stderrPath,
        ...serviceState,
      },
      issues,
    };
  }

  async doctor(input: {
    filesystem: StateFilesystemClassification;
    adapters: readonly AdapterDiagnostic[];
    adapterError?: string;
    includeAdapters?: boolean;
    organizationDiagnostic?: { ok: boolean; detail: string };
  }): Promise<ProductDoctorReport> {
    const checks: ProductDoctorCheck[] = [];
    const platformOk =
      this.platform === 'darwin' && this.architecture === 'arm64';
    checks.push(
      check(
        'platform',
        platformOk,
        platformOk
          ? 'darwin/arm64 launchd user services are supported'
          : `requires darwin/arm64; observed ${this.platform}/${this.architecture}`,
      ),
    );
    checks.push(check('config', true, `loaded ${this.context.configPath}`));
    checks.push(
      check(
        'state-filesystem',
        input.filesystem.kind === 'local',
        `${input.filesystem.kind}: ${input.filesystem.raw}`,
      ),
    );
    let stateOk = false;
    try {
      const info = this.fileSystem.lstat(this.context.stateDirectory);
      stateOk =
        info.isDirectory() &&
        !info.isSymbolicLink() &&
        modeIsPrivate(info.mode, 0o700);
      if (stateOk) {
        assertNoPermissiveDarwinAcl(
          this.context.stateDirectory,
          'state directory',
        );
      }
    } catch {
      stateOk = false;
    }
    checks.push(
      check(
        'state-directory',
        stateOk,
        stateOk
          ? 'private state directory is mode 0700'
          : 'state directory is missing, indirect, or not mode 0700',
      ),
    );
    let manifestOk = false;
    try {
      const record = this.readRecord();
      manifestOk =
        record !== null &&
        sameRecord(record, this.expectedRecord()) &&
        modeIsPrivate(
          this.fileSystem.lstat(this.context.installationPath).mode,
          0o600,
        );
    } catch {
      manifestOk = false;
    }
    checks.push(
      check(
        'installation-manifest',
        manifestOk,
        manifestOk
          ? 'installation manifest matches this config and package'
          : 'installation manifest is missing, stale, invalid, or not mode 0600',
      ),
    );
    const nodeOk =
      this.fileSystem.exists(this.context.nodePath) &&
      this.nodeVersion === EXPECTED_NODE_VERSION;
    checks.push(
      check(
        'node-runtime',
        nodeOk,
        nodeOk
          ? `${this.context.nodePath} (${this.nodeVersion})`
          : `requires ${EXPECTED_NODE_VERSION}; observed ${this.nodeVersion}`,
      ),
    );
    const cliOk = this.fileSystem.exists(this.context.cliPath);
    checks.push(
      check(
        'cli-entrypoint',
        cliOk,
        cliOk ? this.context.cliPath : 'CLI entrypoint is missing',
      ),
    );
    let plistOk = false;
    try {
      plistOk =
        this.plistInstalled() &&
        modeIsPrivate(
          this.fileSystem.lstat(this.context.plistPath).mode,
          0o600,
        );
    } catch {
      plistOk = false;
    }
    checks.push(
      check(
        'service-plist',
        plistOk,
        plistOk
          ? 'LaunchAgent plist matches this installation and is mode 0600'
          : 'LaunchAgent plist is missing, conflicting, or not mode 0600',
      ),
    );
    const serviceState = platformOk
      ? await inspectLaunchdService(
          this.launchctl,
          launchdTarget(this.context.uid, this.context.label),
        )
      : { loaded: false, running: false };
    checks.push(
      check(
        'service-running',
        serviceState.loaded && serviceState.running,
        serviceState.running
          ? `LaunchAgent is running${serviceState.pid === undefined ? '' : ` as pid ${serviceState.pid}`}`
          : serviceState.loaded
            ? 'LaunchAgent is loaded but stopped'
            : 'LaunchAgent is not loaded',
      ),
    );
    const credentialRecommendations = this.serviceCredentialRecommendations();
    let credentialsError: string | undefined;
    try {
      this.assertServiceCredentialsReadable();
    } catch (error) {
      credentialsError = (error as Error).message;
    }
    checks.push(
      check(
        'service-credentials',
        credentialsError === undefined,
        credentialsError === undefined
          ? 'credential files are managed, private, readable, and persistent-service compatible'
          : credentialRecommendations.length > 0
            ? `configured refs are not persistent in launchd; replace with ${credentialRecommendations
                .map((entry) => entry.service_safe_ref)
                .join(', ')}`
            : credentialsError,
      ),
    );
    if (input.organizationDiagnostic !== undefined) {
      checks.push(
        check(
          'organization-state',
          input.organizationDiagnostic.ok,
          input.organizationDiagnostic.detail,
        ),
      );
    }
    if (input.includeAdapters !== false) {
      const adaptersOk =
        input.adapterError === undefined &&
        input.adapters.length > 0 &&
        input.adapters.every((adapter) => adapter.status === 'healthy');
      checks.push(
        check(
          'adapters',
          adaptersOk,
          input.adapterError ??
            (adaptersOk
              ? `${input.adapters.length} configured adapters are healthy`
              : 'one or more configured adapters are not healthy'),
        ),
      );
    }
    return {
      ok: checks.every((entry) => entry.ok),
      checks,
      adapters: input.adapters,
    };
  }

  async service(action: ProductServiceAction): Promise<{
    action: ProductServiceAction;
    installed: boolean;
    service: LaunchdServiceState;
    changed: boolean;
  }> {
    this.assertSupportedPlatform();
    if (action === 'stop' || action === 'uninstall') {
      this.requireInstallationIdentity();
    } else {
      this.requireCurrentRecord();
    }
    if (
      action === 'install' ||
      action === 'start' ||
      action === 'restart'
    ) {
      this.assertServiceCredentialsReadable();
    }
    const context = this.context;
    const target = launchdTarget(context.uid, context.label);
    let installed = this.plistInstalled();
    let before = await inspectLaunchdService(this.launchctl, target);
    let changed = false;

    try {
      if (action === 'install') {
        if (!installed && before.loaded) {
          throw new ProductOperatorError(
            'service_conflict',
            'launchd label is already loaded without this installation plist',
          );
        }
        if (!installed) {
          const launchAgents = join(
            resolve(this.homeDirectory),
            'Library',
            'LaunchAgents',
          );
          this.ensureDirectory(launchAgents);
          this.fileSystem.writePrivate(context.plistPath, this.expectedPlist());
          this.fileSystem.chmod(context.plistPath, 0o600);
          installed = true;
          changed = true;
        } else if (
          !modeIsPrivate(this.fileSystem.lstat(context.plistPath).mode, 0o600)
        ) {
          this.fileSystem.chmod(context.plistPath, 0o600);
          changed = true;
        }
        if (!before.loaded) {
          await requireLaunchctlSuccess(
            this.launchctl,
            ['bootstrap', `gui/${context.uid}`, context.plistPath],
            'launchd bootstrap',
          );
          changed = true;
        }
      } else if (action === 'start') {
        if (!installed) {
          throw new ProductOperatorError(
            'not_initialized',
            'run `echo-brain service install --config <absolute-path>` first',
          );
        }
        if (!before.loaded) {
          await requireLaunchctlSuccess(
            this.launchctl,
            ['bootstrap', `gui/${context.uid}`, context.plistPath],
            'launchd bootstrap',
          );
          before = await inspectLaunchdService(this.launchctl, target);
          changed = true;
        }
        if (!before.running) {
          await requireLaunchctlSuccess(
            this.launchctl,
            ['kickstart', target],
            'launchd start',
          );
          changed = true;
        }
      } else if (action === 'restart') {
        if (!installed) {
          throw new ProductOperatorError(
            'not_initialized',
            'run `echo-brain service install --config <absolute-path>` first',
          );
        }
        if (before.loaded) {
          await requireLaunchctlSuccess(
            this.launchctl,
            ['bootout', target],
            'launchd restart bootout',
          );
        }
        await requireLaunchctlSuccess(
          this.launchctl,
          ['bootstrap', `gui/${context.uid}`, context.plistPath],
          'launchd restart bootstrap',
        );
        changed = true;
      } else if (action === 'stop') {
        if (!installed) {
          throw new ProductOperatorError(
            'not_initialized',
            'LaunchAgent is not installed',
          );
        }
        if (before.loaded) {
          await requireLaunchctlSuccess(
            this.launchctl,
            ['bootout', target],
            'launchd bootout',
          );
          changed = true;
        }
      } else if (action === 'uninstall') {
        if (!installed) {
          if (before.loaded) {
            throw new ProductOperatorError(
              'service_conflict',
              'refusing to unload a launchd label without the owned plist',
            );
          }
        } else {
          if (before.loaded) {
            await requireLaunchctlSuccess(
              this.launchctl,
              ['bootout', target],
              'launchd bootout',
            );
          }
          this.fileSystem.unlink(context.plistPath);
          installed = false;
          changed = true;
        }
      }
    } catch (error) {
      if (error instanceof ProductOperatorError) throw error;
      throw new ProductOperatorError(
        'service_command_failed',
        (error as Error).message,
      );
    }

    return {
      action,
      installed,
      service: await inspectLaunchdService(this.launchctl, target),
      changed,
    };
  }
}
