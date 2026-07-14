import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize, parse, resolve, sep } from 'node:path';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { parseJson } from '../util/json.js';
import { spawnSanitizedChild } from './spawn-sanitized-child.js';

export interface ProductRuntimeConfig {
  schema_version: 1;
  lane: 'team-product';
  state_dir: string;
  granola: {
    workspace_id: string;
    input: 'api';
    credential_ref: string;
  };
  brain_adapter: {
    id: string;
    credential_ref: string;
  };
  approval_mode: 'manual';
}

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
  readFileSync(new URL('../../schemas/product/runtime-config.v1.schema.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv({ allErrors: true, strict: false });
const validateRuntimeSchema = ajv.compile<ProductRuntimeConfig>(runtimeSchema as object);

function formatSchemaErrors(errors: ValidateFunction['errors']): string[] {
  return (errors ?? []).map((error: ErrorObject) => {
    const location = error.instancePath === '' ? '/' : error.instancePath;
    return `${location} ${error.message ?? error.keyword}`;
  });
}

function containsTraversal(path: string): boolean {
  return path.split(/[\\/]+/).includes('..');
}

export function validateProductRuntimeConfig(value: unknown): ProductRuntimeConfig {
  if (!validateRuntimeSchema(value)) {
    throw new ProductConfigError('invalid product runtime configuration', formatSchemaErrors(validateRuntimeSchema.errors));
  }
  if (!isAbsolute(value.state_dir) || containsTraversal(value.state_dir)) {
    throw new ProductConfigError('invalid product runtime configuration', [
      '/state_dir must be an absolute non-traversing path',
    ]);
  }
  const normalized = normalize(value.state_dir);
  if (normalized === parse(normalized).root || normalized.split(sep).length < 3) {
    throw new ProductConfigError('invalid product runtime configuration', [
      '/state_dir must name an installation-local directory below the filesystem root',
    ]);
  }
  return Object.freeze({
    ...value,
    state_dir: resolve(value.state_dir),
    granola: Object.freeze({ ...value.granola }),
    brain_adapter: Object.freeze({ ...value.brain_adapter }),
  });
}

export function loadProductRuntimeConfig(filePath: string): ProductRuntimeConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ProductConfigError(`cannot read product runtime configuration: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch (error) {
    throw new ProductConfigError(`invalid product runtime configuration JSON: ${(error as Error).message}`);
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
  const matches = records.filter((record) => isExactOrDescendant(normalizedPath, record.mountPoint));
  if (matches.length === 0) return { kind: 'unknown', raw: stdout };
  const deepest = Math.max(...matches.map((record) => componentDepth(record.mountPoint)));
  const candidates = matches.filter((record) => componentDepth(record.mountPoint) === deepest);
  const identities = new Set(candidates.map((record) => `${record.mountPoint}\u0000${record.type}`));
  if (identities.size !== 1) {
    return { kind: 'unknown', raw: candidates.map((record) => record.raw).join('\n') };
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

async function readMountTable(): Promise<{ ok: boolean; stdout: string; stderr: string }> {
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
    child.once('error', (error) => resolveResult({ ok: false, stdout, stderr: error.message }));
    child.once('close', (code) => resolveResult({ ok: code === 0, stdout, stderr }));
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
      if (ancestor === null) return { kind: 'unknown', raw: 'no existing ancestor' };
      const resolvedPath = realpath(ancestor);
      const result = await mountTable();
      if (!result.ok) {
        return { kind: 'unknown', raw: result.stderr || 'mount command failed' };
      }
      return classifyMountTable(resolvedPath, result.stdout);
    } catch (error) {
      return { kind: 'unknown', raw: (error as Error).message };
    }
  };
}

export const classifyStateFilesystem = createStateFilesystemClassifier();
