import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, normalize, parse, resolve, sep } from 'node:path';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { AdapterInstanceConfig } from '../core/index.js';
import { parseJson } from '../util/json.js';
import {
  type OrganizationIngestExclusionConfig,
} from './organization/record/index.js';
import { spawnSanitizedChild } from './spawn-sanitized-child.js';

export interface OrganizationIngestConfig {
  exclude: OrganizationIngestExclusionConfig;
}

interface ProductRuntimeConfigBase {
  schema_version: 1;
  lane: 'team-product';
  state_dir: string;
  meeting_sources: readonly AdapterInstanceConfig[];
  decision_processor: AdapterInstanceConfig;
  delivery_surfaces: readonly AdapterInstanceConfig[];
  cycle_interval_ms?: number;
  extraction_timeout_ms?: number;
  organization_ingest?: OrganizationIngestConfig;
}

export type ProductRuntimeConfig = ProductRuntimeConfigBase &
  (
    | { approval_mode: 'manual'; approval_surface?: undefined }
    | { approval_mode: 'adapter'; approval_surface: AdapterInstanceConfig }
  );

export interface StateFilesystemClassification {
  kind: 'local' | 'network' | 'unknown';
  raw: string;
}

export type ClassifyStateFilesystem = (
  path: string,
) => Promise<StateFilesystemClassification>;

export class ProductConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ProductConfigError';
  }
}

interface MountRecord {
  mountPoint: string;
  type: string;
  raw: string;
}

interface FilesystemProbeDependencies {
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  mountTable?: () => Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

const runtimeSchema = parseJson(
  readFileSync(
    new URL('../../schemas/runtime-config.v1.schema.json', import.meta.url),
    'utf8',
  ),
);
const ajv = new Ajv({ allErrors: true, strict: false });
const validateRuntimeSchema = ajv.compile<ProductRuntimeConfig>(
  runtimeSchema as object,
);
const MAX_RUNTIME_CONFIG_BYTES = 1024 * 1024;

function formatSchemaErrors(errors: ValidateFunction['errors']): string[] {
  return (errors ?? []).map((error: ErrorObject) => {
    const location = error.instancePath === '' ? '/' : error.instancePath;
    return `${location} ${error.message ?? error.keyword}`;
  });
}

function containsTraversal(path: string): boolean {
  return path.split(/[\\/]+/).includes('..');
}

function freezeAdapterConfig(
  config: AdapterInstanceConfig,
): AdapterInstanceConfig {
  return Object.freeze({
    ...config,
    settings: deepFreeze({ ...config.settings }),
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function duplicateAdapterInstances(
  configs: readonly AdapterInstanceConfig[],
): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const config of configs) {
    const key = `${config.adapter_id}/${config.instance_id}`;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

function credentialReferenceIssues(
  configs: ReadonlyArray<{
    path: string;
    config: AdapterInstanceConfig;
  }>,
): string[] {
  const issues: string[] = [];
  for (const { path, config } of configs) {
    const reference = config.credential_ref;
    if (reference === undefined || !reference.startsWith('file:')) continue;
    const credentialPath = reference.slice('file:'.length);
    if (
      !isAbsolute(credentialPath) ||
      containsTraversal(credentialPath) ||
      normalize(credentialPath) === parse(normalize(credentialPath)).root
    ) {
      issues.push(
        `${path}/credential_ref file reference must name an absolute non-traversing file below the filesystem root`,
      );
    }
  }
  return issues;
}

export function validateProductRuntimeConfig(
  value: unknown,
): ProductRuntimeConfig {
  if (!validateRuntimeSchema(value)) {
    throw new ProductConfigError(
      'invalid product runtime configuration',
      formatSchemaErrors(validateRuntimeSchema.errors),
    );
  }
  if (!isAbsolute(value.state_dir) || containsTraversal(value.state_dir)) {
    throw new ProductConfigError('invalid product runtime configuration', [
      '/state_dir must be an absolute non-traversing path',
    ]);
  }
  const normalized = normalize(value.state_dir);
  if (
    normalized === parse(normalized).root ||
    normalized.split(sep).length < 3
  ) {
    throw new ProductConfigError('invalid product runtime configuration', [
      '/state_dir must name an installation-local directory below the filesystem root',
    ]);
  }
  const duplicateSources = duplicateAdapterInstances(value.meeting_sources);
  const duplicateSurfaces = duplicateAdapterInstances(
    value.delivery_surfaces,
  );
  if (duplicateSources.length > 0 || duplicateSurfaces.length > 0) {
    throw new ProductConfigError('invalid product runtime configuration', [
      ...duplicateSources.map(
        (key) =>
          `/meeting_sources contains duplicate adapter instance '${key}'`,
      ),
      ...duplicateSurfaces.map(
        (key) =>
          `/delivery_surfaces contains duplicate adapter instance '${key}'`,
      ),
    ]);
  }
  const credentialIssues = credentialReferenceIssues([
    ...value.meeting_sources.map((config, index) => ({
      path: `/meeting_sources/${index}`,
      config,
    })),
    { path: '/decision_processor', config: value.decision_processor },
    ...value.delivery_surfaces.map((config, index) => ({
      path: `/delivery_surfaces/${index}`,
      config,
    })),
    ...(value.approval_surface === undefined
      ? []
      : [{ path: '/approval_surface', config: value.approval_surface }]),
  ]);
  if (credentialIssues.length > 0) {
    throw new ProductConfigError(
      'invalid product runtime configuration',
      credentialIssues,
    );
  }
  let organizationIngest: OrganizationIngestConfig | undefined;
  if (value.organization_ingest !== undefined) {
    const exclude = value.organization_ingest
      .exclude as Partial<OrganizationIngestExclusionConfig>;
    organizationIngest = deepFreeze({
      exclude: {
        sources: (exclude.sources ?? []).map((source) => ({ ...source })),
        meetings: (exclude.meetings ?? []).map((meeting) => ({
          ...meeting,
          source: { ...meeting.source },
        })),
      },
    });
  }
  // The schema's if/then pairing guarantees approval_mode and
  // approval_surface agree, which the spread cannot express structurally.
  return Object.freeze({
    ...value,
    state_dir: resolve(value.state_dir),
    meeting_sources: Object.freeze(
      value.meeting_sources.map(freezeAdapterConfig),
    ),
    decision_processor: freezeAdapterConfig(value.decision_processor),
    delivery_surfaces: Object.freeze(
      value.delivery_surfaces.map(freezeAdapterConfig),
    ),
    ...(value.approval_surface === undefined
      ? {}
      : { approval_surface: freezeAdapterConfig(value.approval_surface) }),
    ...(organizationIngest === undefined
      ? {}
      : { organization_ingest: organizationIngest }),
  } as ProductRuntimeConfig);
}

export function loadProductRuntimeConfig(
  filePath: string,
): ProductRuntimeConfig {
  let raw: string;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const before = fstatSync(descriptor);
    const currentUid = process.getuid?.();
    if (!before.isFile()) {
      throw new Error('configuration path is not a regular file');
    }
    if (currentUid === undefined || before.uid !== currentUid) {
      throw new Error('configuration file must be owned by the current user');
    }
    if ((before.mode & 0o022) !== 0) {
      throw new Error(
        'configuration file must not be group- or world-writable',
      );
    }
    if (before.size === 0 || before.size > MAX_RUNTIME_CONFIG_BYTES) {
      throw new Error(
        `configuration file size must be between 1 and ${MAX_RUNTIME_CONFIG_BYTES} bytes`,
      );
    }
    raw = readFileSync(descriptor, 'utf8');
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      Buffer.byteLength(raw) !== after.size
    ) {
      throw new Error('configuration file changed while it was being read');
    }
  } catch (error) {
    throw new ProductConfigError(
      `cannot read product runtime configuration: ${(error as Error).message}`,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch (error) {
    throw new ProductConfigError(
      `invalid product runtime configuration JSON: ${(error as Error).message}`,
    );
  }
  return validateProductRuntimeConfig(parsed);
}

function decodeMountEscapes(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function parseMountTable(stdout: string): MountRecord[] | null {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return null;
  const records: MountRecord[] = [];
  for (const line of lines) {
    const match = /^.+ on (.+) \(([^,\s)]+)(?:,|\))/.exec(line);
    if (match === null) return null;
    const mountPoint = normalize(decodeMountEscapes(match[1]!));
    if (!isAbsolute(mountPoint)) return null;
    records.push({ mountPoint, type: match[2]!.toLowerCase(), raw: line });
  }
  return records;
}

function isExactOrDescendant(path: string, mountPoint: string): boolean {
  if (mountPoint === parse(mountPoint).root) return path.startsWith(mountPoint);
  return path === mountPoint || path.startsWith(`${mountPoint}${sep}`);
}

function componentDepth(path: string): number {
  return path.split(sep).filter((component) => component !== '').length;
}

export function classifyMountTable(
  resolvedPath: string,
  stdout: string,
): StateFilesystemClassification {
  const records = parseMountTable(stdout);
  if (records === null) return { kind: 'unknown', raw: stdout };
  const normalizedPath = normalize(resolvedPath);
  const matches = records.filter((record) =>
    isExactOrDescendant(normalizedPath, record.mountPoint),
  );
  if (matches.length === 0) return { kind: 'unknown', raw: stdout };
  const deepest = Math.max(
    ...matches.map((record) => componentDepth(record.mountPoint)),
  );
  const candidates = matches.filter(
    (record) => componentDepth(record.mountPoint) === deepest,
  );
  const identities = new Set(
    candidates.map((record) => `${record.mountPoint}\u0000${record.type}`),
  );
  if (identities.size !== 1) {
    return {
      kind: 'unknown',
      raw: candidates.map((record) => record.raw).join('\n'),
    };
  }
  const selected = candidates[0]!;
  if (['nfs', 'smbfs', 'afpfs', 'webdav'].includes(selected.type)) {
    return { kind: 'network', raw: selected.type };
  }
  if (selected.type === 'apfs' || selected.type === 'hfs') {
    return { kind: 'local', raw: selected.type };
  }
  return { kind: 'unknown', raw: selected.type };
}

async function readMountTable(): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
}> {
  const child = spawnSanitizedChild('/sbin/mount', [], {
    env: { LC_ALL: 'C' },
    timeout: 2_000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  return await new Promise((resolveResult) => {
    child.once('error', (error) =>
      resolveResult({ ok: false, stdout, stderr: error.message }),
    );
    child.once('close', (code) =>
      resolveResult({ ok: code === 0, stdout, stderr }),
    );
  });
}

function closestExistingAncestor(
  path: string,
  exists: (candidate: string) => boolean,
): string | null {
  let candidate = resolve(path);
  for (;;) {
    if (exists(candidate)) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

export function createStateFilesystemClassifier(
  dependencies: FilesystemProbeDependencies = {},
): ClassifyStateFilesystem {
  const exists = dependencies.exists ?? existsSync;
  const realpath = dependencies.realpath ?? realpathSync;
  const mountTable = dependencies.mountTable ?? readMountTable;
  return async (path) => {
    try {
      const ancestor = closestExistingAncestor(path, exists);
      if (ancestor === null)
        return { kind: 'unknown', raw: 'no existing ancestor' };
      const resolvedPath = realpath(ancestor);
      const result = await mountTable();
      if (!result.ok) {
        return {
          kind: 'unknown',
          raw: result.stderr || 'mount command failed',
        };
      }
      return classifyMountTable(resolvedPath, result.stdout);
    } catch (error) {
      return { kind: 'unknown', raw: (error as Error).message };
    }
  };
}

export const classifyStateFilesystem = createStateFilesystemClassifier();
