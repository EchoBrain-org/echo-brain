import { Buffer } from 'node:buffer';
import { createHash, createPublicKey, verify } from 'node:crypto';

export const UPDATE_METADATA_LIMIT = 64 * 1024;
export const UPDATE_ARTIFACT_LIMIT = 256 * 1024 * 1024;
export const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
export type UpdateInstallation = 'cli-kit' | 'electron' | 'container';
export interface UpdatePlatform {
  platform: 'linux' | 'darwin' | 'win32';
  architecture: 'x64' | 'arm64';
  libc: 'glibc' | 'musl' | null;
  installation: UpdateInstallation;
}
export interface ClientUpdateConfig {
  schema_version: 1;
  kind: 'echo-client-update-config-v1';
  channel: string;
  feed_url: string;
  public_key_spki: string;
  minimum_sequence: number;
  automatic: boolean;
  installation: UpdateInstallation;
}
export interface ClientUpdateArtifact extends UpdatePlatform {
  url: string;
  sha256: string;
  bytes: number;
}
export interface ClientUpdateManifest {
  schema_version: 1;
  kind: 'echo-client-update-manifest-v1';
  channel: string;
  sequence: number;
  issued_at: string;
  expires_at: string;
  release_id: string;
  release_sha256: string;
  source_sha: string;
  product_version: string;
  artifacts: ClientUpdateArtifact[];
}
export interface UpdateCheckpoint { sequence: number; manifest_sha256: string }

export class ClientUpdateError extends Error {
  constructor(readonly code: string) { super(`ECHO update: ${code}`); }
}
export function rejectUpdate(code: string): never { throw new ClientUpdateError(code); }
export function updateObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) rejectUpdate('invalid_metadata');
  return value as Record<string, unknown>;
}
function matches(value: unknown, expression: RegExp): value is string {
  return typeof value === 'string' && expression.test(value);
}
export function updateHttpsUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) rejectUpdate('invalid_url');
  let url: URL;
  try { url = new URL(value); } catch { return rejectUpdate('invalid_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.href !== value) rejectUpdate('invalid_url');
  return value;
}
export function updateDigest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function installation(value: unknown): value is UpdateInstallation {
  return ['cli-kit', 'electron', 'container'].includes(String(value));
}
export function parseUpdateConfig(value: unknown): ClientUpdateConfig {
  const v = updateObject(value, ['schema_version', 'kind', 'channel', 'feed_url', 'public_key_spki', 'minimum_sequence', 'automatic', 'installation']);
  if (v.schema_version !== 1 || v.kind !== 'echo-client-update-config-v1' ||
      !matches(v.channel, /^[a-z0-9][a-z0-9-]{0,63}$/) || !positiveInteger(v.minimum_sequence) ||
      typeof v.automatic !== 'boolean' || !installation(v.installation) ||
      !matches(v.public_key_spki, /^[A-Za-z0-9+/]{59}=$/)) rejectUpdate('invalid_config');
  updateHttpsUrl(v.feed_url);
  try {
    const key = createPublicKey({ key: Buffer.from(v.public_key_spki, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') rejectUpdate('invalid_config');
  } catch { rejectUpdate('invalid_config'); }
  return { schema_version: 1, kind: 'echo-client-update-config-v1', channel: v.channel as string,
    feed_url: v.feed_url as string, public_key_spki: v.public_key_spki as string,
    minimum_sequence: v.minimum_sequence as number, automatic: v.automatic as boolean,
    installation: v.installation as UpdateInstallation };
}
export function parseUpdatePlatform(value: Record<string, unknown>): UpdatePlatform {
  if (!['linux', 'darwin', 'win32'].includes(String(value.platform)) ||
      !['x64', 'arm64'].includes(String(value.architecture)) || !installation(value.installation) ||
      (value.platform === 'linux' ? !['glibc', 'musl'].includes(String(value.libc)) : value.libc !== null) ||
      (value.installation === 'container' && value.platform !== 'linux')) rejectUpdate('invalid_platform');
  return value as unknown as UpdatePlatform;
}
export function platformKey(value: UpdatePlatform): string {
  return [value.platform, value.architecture, value.libc ?? 'native', value.installation].join('/');
}
export function parseUpdateManifest(value: unknown): ClientUpdateManifest {
  const v = updateObject(value, ['schema_version', 'kind', 'channel', 'sequence', 'issued_at', 'expires_at', 'release_id', 'release_sha256', 'source_sha', 'product_version', 'artifacts']);
  if (v.schema_version !== 1 || v.kind !== 'echo-client-update-manifest-v1' ||
      !matches(v.channel, /^[a-z0-9][a-z0-9-]{0,63}$/) || !positiveInteger(v.sequence) ||
      !matches(v.release_id, /^clean-v1-[a-z0-9][a-z0-9-]{2,63}$/) ||
      !matches(v.release_sha256, /^[a-f0-9]{64}$/) || !matches(v.source_sha, /^[a-f0-9]{40}$/) ||
      !matches(v.product_version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/) ||
      !Array.isArray(v.artifacts) || !v.artifacts.length || v.artifacts.length > 12) rejectUpdate('invalid_metadata');
  for (const key of ['issued_at', 'expires_at']) {
    if (!matches(v[key], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) ||
        !Number.isFinite(Date.parse(v[key] as string)) || new Date(v[key] as string).toISOString() !== v[key]) rejectUpdate('invalid_metadata');
  }
  const lifespan = Date.parse(v.expires_at as string) - Date.parse(v.issued_at as string);
  if (lifespan <= 0 || lifespan > 31 * 24 * 60 * 60 * 1000) rejectUpdate('invalid_metadata');
  const keys = new Set<string>();
  for (const raw of v.artifacts) {
    const a = updateObject(raw, ['platform', 'architecture', 'libc', 'installation', 'url', 'sha256', 'bytes']);
    const platform = parseUpdatePlatform(a);
    updateHttpsUrl(a.url);
    if (!matches(a.sha256, /^[a-f0-9]{64}$/) || !positiveInteger(a.bytes) || a.bytes > UPDATE_ARTIFACT_LIMIT || keys.has(platformKey(platform))) rejectUpdate('invalid_metadata');
    keys.add(platformKey(platform));
  }
  return v as unknown as ClientUpdateManifest;
}

// Sign exact UTF-8 payload bytes; never reserialize before signature verification.
export function verifyUpdateEnvelope(raw: Uint8Array, config: ClientUpdateConfig, now: number, checkpoint?: UpdateCheckpoint): { manifest: ClientUpdateManifest; checkpoint: UpdateCheckpoint } {
  if (raw.byteLength > UPDATE_METADATA_LIMIT) rejectUpdate('metadata_too_large');
  let envelope: Record<string, unknown>;
  try { envelope = updateObject(JSON.parse(Buffer.from(raw).toString('utf8')), ['payload', 'signature']); }
  catch { return rejectUpdate('invalid_metadata'); }
  if (!matches(envelope.payload, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) ||
      !matches(envelope.signature, /^[A-Za-z0-9+/]{86}==$/)) rejectUpdate('invalid_signature');
  const payload = Buffer.from(envelope.payload, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');
  const key = createPublicKey({ key: Buffer.from(config.public_key_spki, 'base64'), format: 'der', type: 'spki' });
  if (!verify(null, payload, key, signature)) rejectUpdate('invalid_signature');
  let manifest: ClientUpdateManifest;
  try { manifest = parseUpdateManifest(JSON.parse(payload.toString('utf8'))); }
  catch { return rejectUpdate('invalid_metadata'); }
  const digest = updateDigest(payload);
  if (manifest.channel !== config.channel) rejectUpdate('wrong_channel');
  if (Date.parse(manifest.issued_at) > now + 5 * 60 * 1000 || Date.parse(manifest.expires_at) <= now) rejectUpdate('expired_metadata');
  if (manifest.sequence < Math.max(config.minimum_sequence, checkpoint?.sequence ?? 0)) rejectUpdate('stale_metadata');
  if (checkpoint?.sequence === manifest.sequence && checkpoint.manifest_sha256 !== digest) rejectUpdate('changed_metadata');
  // A feed cannot redirect a client to a second artifact host.
  if (manifest.artifacts.some(a => new URL(a.url).origin !== new URL(config.feed_url).origin)) rejectUpdate('wrong_artifact_origin');
  return { manifest, checkpoint: { sequence: manifest.sequence, manifest_sha256: digest } };
}

export function selectUpdateArtifact(manifest: ClientUpdateManifest, platform: UpdatePlatform): ClientUpdateArtifact {
  const artifact = manifest.artifacts.find(a => platformKey(a) === platformKey(platform));
  if (!artifact) rejectUpdate('unsupported_platform');
  return artifact;
}
