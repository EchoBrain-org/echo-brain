import {
  assertPrivateOwnedRegularFile,
  assertSafeRelativePath,
  readFileNoFollow,
} from '../../secure-local-files.js';
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
  sha256Digest,
} from '../foundation/canonical-json.js';
import type { FederationId, Sha256Digest } from '../contracts.js';
import type {
  CreateFederatedExportBundleRequest,
  CreatedFederatedExportBundle,
  FederatedExportIdentitySource,
  FederatedExportOutboxSource,
  VerifiedFederatedExportBundle,
} from '../export/export-bundle-material.js';
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
} from '../foundation/identifiers.js';
import type { InstallationSigner } from '../foundation/installation-signer.js';
import type { FederatedOutboxStore } from '../outbox-store.js';

export const LOCAL_DIRECTORY = 'federation/independent-copy';
export const TARGET_FILENAME = 'target.v1.json';
export const TARGET_COPY_DIRECTORY = 'echo-brain-independent-copies';
export const TARGET_BINDING_FILENAME = 'target-binding.v1.json';
export const NON_BLANK_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface IndependentCopyTargetInspection {
  canonical_root: string;
  canonical_mount_point: string;
  volume_id: string;
  state_filesystem_device_id: string;
  target_filesystem_device_id: string;
  state_physical_device_ids: readonly string[];
  target_physical_device_ids: readonly string[];
  target_media: 'external-physical';
  mounted: true;
  encrypted: true;
  assurance: 'platform_verified';
}

export interface IndependentCopyPlatformInspector {
  inspect(input: {
    state_directory: string;
    target_root: string;
  }): Promise<IndependentCopyTargetInspection>;
}

export interface IndependentCopyTargetRecordV1 {
  schema_version: 1;
  kind: 'echo-founder-independent-copy-target';
  state_path_sha256: Sha256Digest;
  target_root: string;
  mount_point: string;
  volume_id: string;
  protection: {
    kind: 'encrypted-volume';
    assurance: 'platform_verified';
  };
  configured_at: string;
}

export interface IndependentCopyReceiptV1 {
  schema_version: 1;
  kind: 'echo-founder-independent-copy-receipt';
  intent_sha256: Sha256Digest;
  target_record_sha256: Sha256Digest;
  organization_id: FederationId;
  installation_id: FederationId;
  sequence: {
    first: 1;
    last: number;
    head_hash: Sha256Digest;
  };
  export_id: FederationId;
  bundle_relative_path: string;
  export_manifest_sha256: Sha256Digest;
  records_sha256: Sha256Digest;
  verified_at: string;
}

export interface IndependentCopyReadiness {
  ok: boolean;
  detail: string;
  copied_installations: number;
  copied_events: number;
}

export interface IndependentCopyExportOperations {
  create(
    request: CreateFederatedExportBundleRequest,
  ): Promise<CreatedFederatedExportBundle>;
  verify(path: string): VerifiedFederatedExportBundle;
}

export interface IndependentCopyOutboxSource extends FederatedExportOutboxSource {
  listInstallationIds: FederatedOutboxStore['listInstallationIds'];
  readChainHead: FederatedOutboxStore['readChainHead'];
  readSequenceRange: FederatedOutboxStore['readSequenceRange'];
}

export type IndependentCopyFaultPoint =
  | 'after_intent'
  | 'after_export_before_receipt';

export interface FounderIndependentCopyStoreOptions {
  stateDirectory: string;
  outbox: IndependentCopyOutboxSource;
  identitySource: FederatedExportIdentitySource;
  signer: InstallationSigner;
  inspector?: IndependentCopyPlatformInspector;
  exportOperations?: IndependentCopyExportOperations;
  now?: () => string;
  createExportId?: () => FederationId;
  faultInjector?: (point: IndependentCopyFaultPoint) => void;
}

export interface ConfigureIndependentCopyResult {
  created: boolean;
  target: IndependentCopyTargetRecordV1;
}

export interface MacOsEncryptedVolumeInspectorOptions {
  platform?: string;
  filesystemDeviceId?: (path: string) => string;
  readDiskUtilityInfo?: (
    path: string,
  ) => Promise<Record<string, unknown>>;
}

export interface IndependentCopyIntentV1 {
  schema_version: 1;
  kind: 'echo-founder-independent-copy-intent';
  state_path_sha256: Sha256Digest;
  target_record_sha256: Sha256Digest;
  organization_id: FederationId;
  installation_id: FederationId;
  signing_identity_manifest_id: FederationId;
  sequence: {
    first: 1;
    last: number;
    head_hash: Sha256Digest;
  };
  export_id: FederationId;
  generated_at: string;
  bundle_relative_path: string;
}

export interface IndependentCopyTargetBindingV1 {
  schema_version: 1;
  kind: 'echo-founder-independent-copy-target-binding';
  state_path_sha256: Sha256Digest;
  target_configuration_sha256: Sha256Digest;
  volume_id: string;
}

export interface ChainSnapshot {
  installation_id: FederationId;
  last_sequence: number;
  head_hash: Sha256Digest;
}

export interface ProtectedExportSnapshot extends ChainSnapshot {
  path: string;
  records_bytes: Buffer;
  export_id: FederationId;
  generated_at: string;
  signing_identity_manifest_id: FederationId;
  export_manifest_sha256: Sha256Digest;
  records_sha256: Sha256Digest;
}

export function failIndependentCopy(message: string): never {
  throw new Error(`founder independent copy failed: ${message}`);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    failIndependentCopy(`${label} has unknown or missing fields`);
  }
}

export function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertDigest(
  value: unknown,
  label: string,
): asserts value is Sha256Digest {
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) {
    failIndependentCopy(`${label} is not a canonical SHA-256 digest`);
  }
}

export function assertPrivateCanonicalFile(
  path: string,
  label: string,
): string {
  assertPrivateOwnedRegularFile(path, 0o600, () => {
    failIndependentCopy(
      `${label} must be a current-user regular file with mode 0600`,
    );
  });
  return readFileNoFollow(path, label).toString('utf8');
}

export function readCanonical(path: string, label: string): unknown {
  try {
    return parseCanonicalJson(assertPrivateCanonicalFile(path, label));
  } catch (error) {
    failIndependentCopy(`${label} is invalid: ${(error as Error).message}`);
  }
}

export function statePathDigest(path: string): Sha256Digest {
  return sha256Digest(`${path}\n`);
}

function assertDocumentRecord(
  value: unknown,
  label: string,
  kind: string,
  fields: readonly string[],
  stringFields: readonly string[],
  recordFields: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) failIndependentCopy(`${label} must be an object`);
  exactKeys(value, fields, label);
  if (
    value['schema_version'] !== 1 ||
    value['kind'] !== kind ||
    stringFields.some((field) => typeof value[field] !== 'string') ||
    recordFields.some((field) => !isRecord(value[field]))
  ) {
    failIndependentCopy(`${label} has invalid field types or version`);
  }
}

function assertCopyEvidence(
  value: IndependentCopyIntentV1 | IndependentCopyReceiptV1,
  label: 'intent' | 'receipt',
  timestamp: string,
): void {
  assertFederationId(value.organization_id, 'org', `${label} organization_id`);
  assertFederationId(value.installation_id, 'ins', `${label} installation_id`);
  if (label === 'intent') {
    assertFederationId(
      (value as IndependentCopyIntentV1).signing_identity_manifest_id,
      'idm',
      'intent signing_identity_manifest_id',
    );
  }
  assertFederationId(value.export_id, 'exp', `${label} export_id`);
  assertUtcMillisecondTimestamp(
    timestamp,
    `${label} ${label === 'intent' ? 'generated_at' : 'verified_at'}`,
  );
  assertSafeRelativePath(
    value.bundle_relative_path,
    `${label} bundle_relative_path`,
  );
  const sequence = value.sequence as unknown as Record<string, unknown>;
  exactKeys(
    sequence,
    ['first', 'last', 'head_hash'],
    `independent-copy ${label} sequence`,
  );
  if (
    sequence['first'] !== 1 ||
    !Number.isSafeInteger(sequence['last']) ||
    (sequence['last'] as number) < 1
  ) {
    failIndependentCopy(`independent-copy ${label} sequence is invalid`);
  }
  assertDigest(sequence['head_hash'], `${label} sequence head_hash`);
}

export function assertTargetRecord(
  value: unknown,
): IndependentCopyTargetRecordV1 {
  assertDocumentRecord(
    value,
    'independent-copy target',
    'echo-founder-independent-copy-target',
    [
      'schema_version',
      'kind',
      'state_path_sha256',
      'target_root',
      'mount_point',
      'volume_id',
      'protection',
      'configured_at',
    ],
    ['target_root', 'mount_point', 'volume_id', 'configured_at'],
    ['protection'],
  );
  const target = value as unknown as IndependentCopyTargetRecordV1;
  assertDigest(target.state_path_sha256, 'target state_path_sha256');
  exactKeys(
    value['protection'] as Record<string, unknown>,
    ['kind', 'assurance'],
    'independent-copy target protection',
  );
  if (
    target.protection.kind !== 'encrypted-volume' ||
    target.protection.assurance !== 'platform_verified'
  ) {
    failIndependentCopy(
      'independent-copy target protection is not platform-verified encryption',
    );
  }
  if (!NON_BLANK_IDENTITY.test(target.volume_id)) {
    failIndependentCopy('independent-copy target volume identity is invalid');
  }
  assertUtcMillisecondTimestamp(
    target.configured_at,
    'independent-copy target configured_at',
  );
  return target;
}

export function assertIntent(value: unknown): IndependentCopyIntentV1 {
  assertDocumentRecord(
    value,
    'independent-copy intent',
    'echo-founder-independent-copy-intent',
    [
      'schema_version',
      'kind',
      'state_path_sha256',
      'target_record_sha256',
      'organization_id',
      'installation_id',
      'signing_identity_manifest_id',
      'sequence',
      'export_id',
      'generated_at',
      'bundle_relative_path',
    ],
    [
      'organization_id',
      'installation_id',
      'signing_identity_manifest_id',
      'export_id',
      'generated_at',
      'bundle_relative_path',
    ],
    ['sequence'],
  );
  const intent = value as unknown as IndependentCopyIntentV1;
  assertDigest(intent.state_path_sha256, 'intent state_path_sha256');
  assertDigest(intent.target_record_sha256, 'intent target_record_sha256');
  assertCopyEvidence(intent, 'intent', intent.generated_at);
  return intent;
}

export function assertReceipt(value: unknown): IndependentCopyReceiptV1 {
  assertDocumentRecord(
    value,
    'independent-copy receipt',
    'echo-founder-independent-copy-receipt',
    [
      'schema_version',
      'kind',
      'intent_sha256',
      'target_record_sha256',
      'organization_id',
      'installation_id',
      'sequence',
      'export_id',
      'bundle_relative_path',
      'export_manifest_sha256',
      'records_sha256',
      'verified_at',
    ],
    [
      'organization_id',
      'installation_id',
      'export_id',
      'bundle_relative_path',
      'verified_at',
    ],
    ['sequence'],
  );
  const receipt = value as unknown as IndependentCopyReceiptV1;
  assertDigest(receipt.intent_sha256, 'receipt intent_sha256');
  assertDigest(receipt.target_record_sha256, 'receipt target_record_sha256');
  assertDigest(
    receipt.export_manifest_sha256,
    'receipt export_manifest_sha256',
  );
  assertDigest(receipt.records_sha256, 'receipt records_sha256');
  assertCopyEvidence(receipt, 'receipt', receipt.verified_at);
  return receipt;
}

export function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

export function headKey(head: ChainSnapshot): string {
  return `${head.installation_id}.${head.last_sequence}.${head.head_hash.slice('sha256:'.length)}`;
}

export function bundleDirectoryName(head: ChainSnapshot): string {
  return `echo-org-export-${head.installation_id}-1-${head.last_sequence}`;
}

export const BUNDLE_DIRECTORY_PATTERN =
  /^echo-org-export-(ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-1-([1-9][0-9]*)$/;
export const BINDING_TEMP_PATTERN =
  /^target-binding\.v1\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
export const EXPORT_STAGING_PATTERN =
  /^\.(echo-org-export-(ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-1-([1-9][0-9]*))\.(exp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.staging-[A-Za-z0-9]{6}$/;
export const LOCAL_INTENT_TEMP_PATTERN =
  /^intent\.ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[1-9][0-9]*\.[0-9a-f]{64}\.v1\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
export const LOCAL_RECEIPT_TEMP_PATTERN =
  /^receipt\.ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[1-9][0-9]*\.[0-9a-f]{64}\.v1\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

export function sameHeads(
  left: readonly ChainSnapshot[],
  right: readonly ChainSnapshot[],
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function sameConfiguredTarget(
  left: IndependentCopyTargetRecordV1,
  right: IndependentCopyTargetRecordV1,
): boolean {
  return (
    left.state_path_sha256 === right.state_path_sha256 &&
    left.target_root === right.target_root &&
    left.mount_point === right.mount_point &&
    left.volume_id === right.volume_id &&
    canonicalJson(left.protection) === canonicalJson(right.protection)
  );
}

export function targetConfigurationDigest(
  target: IndependentCopyTargetRecordV1,
): Sha256Digest {
  return canonicalSha256({
    state_path_sha256: target.state_path_sha256,
    target_root: target.target_root,
    mount_point: target.mount_point,
    volume_id: target.volume_id,
    protection: target.protection,
  });
}
