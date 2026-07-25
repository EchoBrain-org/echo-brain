import { Buffer } from 'node:buffer';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';

export const ORGANIZATION_ADMIN_EDGE_CONFIG_KIND =
  'echo-organization-admin-edge-runtime-config';

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_CERTIFICATE_BUNDLE_BYTES = 256 * 1024;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const MIN_PROXY_TOKEN_BYTES = 32;
const MAX_PROXY_TOKEN_BYTES = 4096;
const MAX_ALLOWED_ADMIN_CLIENTS = 256;
const MAX_HTTPS_ORIGIN_CHARACTERS = 2048;

export interface OrganizationAdminEdgeRuntimeConfigV1 {
  readonly schema_version: 1;
  readonly kind: typeof ORGANIZATION_ADMIN_EDGE_CONFIG_KIND;
  readonly listener: {
    readonly host: string;
    readonly port: number;
  };
  readonly public_origin: string;
  readonly employee_authority_base_url: string;
  readonly authority_origin: string;
  readonly tls: {
    readonly certificate_chain_ref: string;
    readonly private_key_ref: string;
    readonly client_ca_bundle_ref: string;
  };
  readonly trusted_proxy_token_ref: string;
  readonly allowed_admin_client_spki_sha256: readonly `sha256:${string}`[];
}

export interface OrganizationAdminEdgeServeConfig {
  readonly listener: {
    readonly host: string;
    readonly port: number;
  };
  readonly public_origin: string;
  readonly employee_authority_base_url: string;
  readonly authority_origin: string;
  readonly tls: {
    readonly certificate_chain: Buffer;
    readonly private_key: Buffer;
    readonly client_ca_bundle: Buffer;
  };
  readonly trusted_proxy_token: string;
  readonly allowed_admin_client_spki_sha256: ReadonlySet<string>;
}

interface PrivateFileBounds {
  readonly minimum_bytes: number;
  readonly maximum_bytes: number;
  readonly label: string;
}

interface ReadPrivateFile {
  readonly bytes: Buffer;
  readonly device: number;
  readonly inode: number;
}

function fail(message: string): never {
  throw new Error(`organization admin edge config: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).sort().join('\u0000') !==
    [...expected].sort().join('\u0000')
  ) {
    fail(`${label} has an unexpected shape`);
  }
}

function normalizedAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === resolve('/')
  ) {
    fail(`${label} must be a normalized absolute path below root`);
  }
  return value;
}

export function organizationAdminEdgeFileReferencePath(
  reference: unknown,
  label: string,
): string {
  if (typeof reference !== 'string' || !reference.startsWith('file:')) {
    fail(`${label} must use a file: reference`);
  }
  return normalizedAbsolutePath(reference.slice('file:'.length), label);
}

function assertOwnerOnlyRegularFile(
  path: string,
  bounds: PrivateFileBounds,
): Stats {
  let state: Stats;
  try {
    state = lstatSync(path);
  } catch {
    fail(`${bounds.label} is unavailable`);
  }
  const currentUid = process.getuid?.();
  let canonical = false;
  try {
    canonical = realpathSync(path) === path;
  } catch {
    canonical = false;
  }
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    !canonical ||
    state.size < bounds.minimum_bytes ||
    state.size > bounds.maximum_bytes ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600
  ) {
    fail(
      `${bounds.label} must be a bounded current-user 0600 canonical regular file`,
    );
  }
  return state;
}

function sameOpenedFile(expected: Stats, actual: Stats): boolean {
  return (
    actual.isFile() &&
    !actual.isSymbolicLink() &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mtimeMs === expected.mtimeMs &&
    actual.ctimeMs === expected.ctimeMs &&
    (actual.mode & 0o777) === 0o600
  );
}

function readOwnerOnlyRegularFile(
  path: string,
  bounds: PrivateFileBounds,
): ReadPrivateFile {
  const state = assertOwnerOnlyRegularFile(path, bounds);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let file: number;
  try {
    file = openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch {
    fail(`${bounds.label} could not be opened safely`);
  }
  try {
    const opened = fstatSync(file);
    if (!sameOpenedFile(state, opened)) {
      fail(`${bounds.label} changed while opening`);
    }
    const bytes = readFileSync(file);
    const afterRead = fstatSync(file);
    if (
      !sameOpenedFile(opened, afterRead) ||
      bytes.length !== opened.size ||
      bytes.length < bounds.minimum_bytes ||
      bytes.length > bounds.maximum_bytes
    ) {
      fail(`${bounds.label} changed while reading`);
    }
    return {
      bytes,
      device: opened.dev,
      inode: opened.ino,
    };
  } finally {
    closeSync(file);
  }
}

function decodeUtf8(bytes: Buffer, label: string): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    fail(`${label} must contain valid UTF-8`);
  }
  return text;
}

function canonicalHttpsOrigin(
  value: unknown,
  label: string,
  requireDnsName: boolean,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_HTTPS_ORIGIN_CHARACTERS
  ) {
    fail(`${label} must be a bounded string`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} must be one canonical bare HTTPS origin`);
  }
  if (
    url.protocol !== 'https:' ||
    value !== url.origin ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.hostname.length === 0 ||
    url.hostname.endsWith('.')
  ) {
    fail(`${label} must be one canonical bare HTTPS origin`);
  }
  if (
    requireDnsName &&
    (isIP(url.hostname) !== 0 ||
      url.hostname !== url.hostname.toLowerCase() ||
      url.hostname.length > 253 ||
      !url.hostname
        .split('.')
        .every(
          (part) =>
            part.length > 0 &&
            part.length <= 63 &&
            /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part),
        ))
  ) {
    fail(`${label} must use one canonical DNS hostname`);
  }
  return url.origin;
}

function canonicalLoopbackHttpOrigin(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_HTTPS_ORIGIN_CHARACTERS
  ) {
    fail('authority_origin must be a bounded string');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail('authority_origin must be one bare loopback HTTP origin');
  }
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') ||
    value !== url.origin ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    fail('authority_origin must be one bare loopback HTTP origin');
  }
  return url.origin;
}

function listener(value: unknown): {
  readonly host: string;
  readonly port: number;
} {
  const input = record(value, 'listener');
  exactKeys(input, ['host', 'port'], 'listener');
  if (
    typeof input.host !== 'string' ||
    isIP(input.host) === 0 ||
    !Number.isSafeInteger(input.port) ||
    (input.port as number) < 1 ||
    (input.port as number) > 65_535
  ) {
    fail('listener must contain an IP address and a port from 1 through 65535');
  }
  return { host: input.host, port: input.port as number };
}

function tlsReferences(value: unknown): {
  readonly certificate_chain_ref: string;
  readonly private_key_ref: string;
  readonly client_ca_bundle_ref: string;
} {
  const input = record(value, 'tls');
  exactKeys(
    input,
    ['certificate_chain_ref', 'private_key_ref', 'client_ca_bundle_ref'],
    'tls',
  );
  const certificatePath = organizationAdminEdgeFileReferencePath(
    input.certificate_chain_ref,
    'TLS certificate chain reference',
  );
  const keyPath = organizationAdminEdgeFileReferencePath(
    input.private_key_ref,
    'TLS private key reference',
  );
  const clientCaPath = organizationAdminEdgeFileReferencePath(
    input.client_ca_bundle_ref,
    'TLS client CA bundle reference',
  );
  if (new Set([certificatePath, keyPath, clientCaPath]).size !== 3) {
    fail('TLS references must name three distinct files');
  }
  return {
    certificate_chain_ref: input.certificate_chain_ref as string,
    private_key_ref: input.private_key_ref as string,
    client_ca_bundle_ref: input.client_ca_bundle_ref as string,
  };
}

function clientPins(value: unknown): readonly `sha256:${string}`[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ALLOWED_ADMIN_CLIENTS
  ) {
    fail(
      `allowed_admin_client_spki_sha256 must contain 1-${MAX_ALLOWED_ADMIN_CLIENTS} pins`,
    );
  }
  const pins: `sha256:${string}`[] = [];
  for (const pin of value) {
    if (typeof pin !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(pin)) {
      fail('administrator client SPKI pins must be canonical SHA-256 digests');
    }
    pins.push(pin as `sha256:${string}`);
  }
  if (new Set(pins).size !== pins.length) {
    fail('administrator client SPKI pins must be unique');
  }
  return Object.freeze(pins);
}

export function validateOrganizationAdminEdgeRuntimeConfig(
  value: unknown,
): OrganizationAdminEdgeRuntimeConfigV1 {
  const root = record(value, 'runtime config');
  exactKeys(
    root,
    [
      'schema_version',
      'kind',
      'listener',
      'public_origin',
      'employee_authority_base_url',
      'authority_origin',
      'tls',
      'trusted_proxy_token_ref',
      'allowed_admin_client_spki_sha256',
    ],
    'runtime config',
  );
  if (
    root.schema_version !== 1 ||
    root.kind !== ORGANIZATION_ADMIN_EDGE_CONFIG_KIND
  ) {
    fail('runtime config identity is unsupported');
  }
  const tls = tlsReferences(root.tls);
  const proxyTokenRef = root.trusted_proxy_token_ref;
  const proxyTokenPath = organizationAdminEdgeFileReferencePath(
    proxyTokenRef,
    'trusted proxy token reference',
  );
  const referencedPaths = [
    tls.certificate_chain_ref,
    tls.private_key_ref,
    tls.client_ca_bundle_ref,
  ].map((reference) =>
    organizationAdminEdgeFileReferencePath(reference, 'TLS reference'),
  );
  if (referencedPaths.includes(proxyTokenPath)) {
    fail('trusted proxy token must use a file distinct from TLS material');
  }
  const publicOrigin = canonicalHttpsOrigin(
    root.public_origin,
    'public_origin',
    true,
  );
  const employeeAuthorityBaseUrl = canonicalHttpsOrigin(
    root.employee_authority_base_url,
    'employee_authority_base_url',
    false,
  );
  if (employeeAuthorityBaseUrl === publicOrigin) {
    fail(
      'employee_authority_base_url must be distinct from the administrator public_origin',
    );
  }
  return Object.freeze({
    schema_version: 1,
    kind: ORGANIZATION_ADMIN_EDGE_CONFIG_KIND,
    listener: listener(root.listener),
    public_origin: publicOrigin,
    employee_authority_base_url: employeeAuthorityBaseUrl,
    authority_origin: canonicalLoopbackHttpOrigin(root.authority_origin),
    tls,
    trusted_proxy_token_ref: proxyTokenRef as string,
    allowed_admin_client_spki_sha256: clientPins(
      root.allowed_admin_client_spki_sha256,
    ),
  });
}

export function readOrganizationAdminEdgeRuntimeConfig(
  configPath: string,
): OrganizationAdminEdgeRuntimeConfigV1 {
  const path = normalizedAbsolutePath(configPath, 'runtime config path');
  const configFile = readOwnerOnlyRegularFile(path, {
    minimum_bytes: 2,
    maximum_bytes: MAX_CONFIG_BYTES,
    label: 'runtime config',
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      decodeUtf8(configFile.bytes, 'runtime config'),
    ) as unknown;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('organization admin edge config:')
    ) {
      throw error;
    }
    fail('runtime config must contain valid JSON');
  }
  return validateOrganizationAdminEdgeRuntimeConfig(parsed);
}

export function resolveOrganizationAdminEdgeServeConfig(
  config: OrganizationAdminEdgeRuntimeConfigV1,
): OrganizationAdminEdgeServeConfig {
  const validated = validateOrganizationAdminEdgeRuntimeConfig(config);
  const certificateChain = readOwnerOnlyRegularFile(
    organizationAdminEdgeFileReferencePath(
      validated.tls.certificate_chain_ref,
      'TLS certificate chain reference',
    ),
    {
      minimum_bytes: 1,
      maximum_bytes: MAX_CERTIFICATE_BUNDLE_BYTES,
      label: 'TLS certificate chain',
    },
  );
  const privateKey = readOwnerOnlyRegularFile(
    organizationAdminEdgeFileReferencePath(
      validated.tls.private_key_ref,
      'TLS private key reference',
    ),
    {
      minimum_bytes: 1,
      maximum_bytes: MAX_PRIVATE_KEY_BYTES,
      label: 'TLS private key',
    },
  );
  const clientCaBundle = readOwnerOnlyRegularFile(
    organizationAdminEdgeFileReferencePath(
      validated.tls.client_ca_bundle_ref,
      'TLS client CA bundle reference',
    ),
    {
      minimum_bytes: 1,
      maximum_bytes: MAX_CERTIFICATE_BUNDLE_BYTES,
      label: 'TLS client CA bundle',
    },
  );
  const tokenFile = readOwnerOnlyRegularFile(
    organizationAdminEdgeFileReferencePath(
      validated.trusted_proxy_token_ref,
      'trusted proxy token reference',
    ),
    {
      minimum_bytes: MIN_PROXY_TOKEN_BYTES,
      maximum_bytes: MAX_PROXY_TOKEN_BYTES,
      label: 'trusted proxy token',
    },
  );
  const privateFiles = [
    certificateChain,
    privateKey,
    clientCaBundle,
    tokenFile,
  ];
  for (let index = 0; index < privateFiles.length; index += 1) {
    for (
      let candidate = index + 1;
      candidate < privateFiles.length;
      candidate += 1
    ) {
      if (
        privateFiles[index]!.device === privateFiles[candidate]!.device &&
        privateFiles[index]!.inode === privateFiles[candidate]!.inode
      ) {
        fail('TLS material and trusted proxy token must be distinct files');
      }
    }
  }
  const trustedProxyToken = decodeUtf8(
    tokenFile.bytes,
    'trusted proxy token',
  );
  if (!/^[\x21-\x7e]{32,4096}$/.test(trustedProxyToken)) {
    fail('trusted proxy token must contain 32-4096 visible ASCII bytes');
  }
  return Object.freeze({
    listener: Object.freeze({ ...validated.listener }),
    public_origin: validated.public_origin,
    employee_authority_base_url: validated.employee_authority_base_url,
    authority_origin: validated.authority_origin,
    tls: Object.freeze({
      certificate_chain: Buffer.from(certificateChain.bytes),
      private_key: Buffer.from(privateKey.bytes),
      client_ca_bundle: Buffer.from(clientCaBundle.bytes),
    }),
    trusted_proxy_token: trustedProxyToken,
    allowed_admin_client_spki_sha256: new Set(
      validated.allowed_admin_client_spki_sha256,
    ),
  });
}
