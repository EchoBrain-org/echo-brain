import {
  canonicalJson,
  canonicalSha256,
  createSignedDocumentWithKey,
  sha256Digest,
  verifyP256SigningKeyDescriptor,
  verifySignedDocument,
} from '@echo-brain/federation-protocol';
import type {
  P256SigningKeyDescriptor,
  Sha256Digest,
  SignedIntegrity,
} from '@echo-brain/federation-protocol';
import type { CanonicalPayloadSigner } from '@echo-brain/organization-protocol';
import { OrganizationApiValidationError } from './validation.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INTERNAL_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-internal\.(0|[1-9]\d*)$/;
const RUNTIME_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const INTERNAL_LIVE_REPOSITORY = 'EchoBrain-org/echo-brain';
const PACKAGE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}\.tgz$/;
const DECIMAL_ID_PATTERN = /^[1-9]\d{0,39}$/;
const FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

export interface OrganizationInternalLiveReleaseManifestV1 {
  schema_version: 1;
  kind: 'echo-internal-live-release';
  channel: 'internal-live';
  release_version: string;
  release_tag: string;
  source: {
    sha: string;
    kind: 'materialized-commit';
  };
  artifact: {
    package: 'echo-brain';
    filename: string;
    download_url: string;
    size_bytes: number;
    sha256: string;
  };
  compatibility: {
    os: 'darwin';
    arch: 'arm64';
    node: string;
    npm: string;
  };
  build: {
    repository: string;
    workflow: 'internal-live-release.yml';
    run_id: string;
    run_attempt: number;
  };
}

export interface ApproveOrganizationInternalLiveReleaseRequestV1 {
  schema_version: 1;
  kind: 'echo-internal-live-release-approval-request';
  command_id: string;
  manifest_url: string;
  manifest_sha256: string;
  manifest: OrganizationInternalLiveReleaseManifestV1;
}

interface OrganizationInternalLiveInstallationCoordinatesV1 {
  authority_id: string;
  authority_key_id: Sha256Digest;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  installation_key_id: Sha256Digest;
}

export interface OrganizationInternalLiveDirectiveRequestPayloadV1
  extends OrganizationInternalLiveInstallationCoordinatesV1 {
  schema_version: 1;
  kind: 'echo-internal-live-directive-request';
  request_id: string;
  channel: 'internal-live';
  requested_at: string;
}

export interface OrganizationInternalLiveDirectiveRequestV1
  extends OrganizationInternalLiveDirectiveRequestPayloadV1 {
  integrity: SignedIntegrity;
}

export interface OrganizationInternalLiveUpdateDirectiveV1 {
  schema_version: 1;
  kind: 'echo-internal-live-update-directive';
  channel: 'internal-live';
  directive_sequence: number;
  manifest_url: string;
  manifest_sha256: string;
  approved_at: string;
  evaluated_at: string;
}

export type OrganizationInternalLiveUpdateOutcomeV1 =
  | 'healthy'
  | 'rolled_back'
  | 'failed';

export type OrganizationInternalLiveUpdateFailurePhaseV1 =
  | 'backup'
  | 'service_stop'
  | 'install'
  | 'service_start'
  | 'doctor'
  | 'rollback';

export interface OrganizationInternalLiveUpdateReceiptPayloadV1
  extends OrganizationInternalLiveInstallationCoordinatesV1 {
  schema_version: 1;
  kind: 'echo-internal-live-update-receipt';
  channel: 'internal-live';
  transaction_id: string;
  directive_sequence: number;
  release_version: string;
  manifest_sha256: string;
  artifact_sha256: string;
  source_sha: string;
  outcome: OrganizationInternalLiveUpdateOutcomeV1;
  doctor: {
    ok: boolean;
    passed: number;
    total: number;
  } | null;
  failure: {
    phase: OrganizationInternalLiveUpdateFailurePhaseV1;
    code: string;
  } | null;
  finished_at: string;
}

export interface OrganizationInternalLiveUpdateReceiptV1
  extends OrganizationInternalLiveUpdateReceiptPayloadV1 {
  integrity: SignedIntegrity;
}

export interface OrganizationInternalLiveRolloutReceiptSummaryV1 {
  release_version: string;
  outcome: OrganizationInternalLiveUpdateOutcomeV1;
  doctor: OrganizationInternalLiveUpdateReceiptPayloadV1['doctor'];
  failure: OrganizationInternalLiveUpdateReceiptPayloadV1['failure'];
  finished_at: string;
}

export interface OrganizationInternalLiveRolloutStatusV1 {
  schema_version: 1;
  kind: 'echo-internal-live-rollout-status';
  channel: 'internal-live';
  evaluated_at: string;
  approved_release: {
    directive_sequence: number;
    release_version: string;
    manifest_url: string;
    manifest_sha256: string;
    approved_at: string;
  } | null;
  installations: Array<{
    installation_id: string;
    rollout_state: 'no_release' | 'pending' | OrganizationInternalLiveUpdateOutcomeV1;
    receipt: OrganizationInternalLiveRolloutReceiptSummaryV1 | null;
  }>;
}

function fail(message: string): never {
  throw new OrganizationApiValidationError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${label} must be a plain object`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) fail(`${label} must not contain accessors`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail(`${label} must not contain symbol properties`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} has an unexpected shape`);
  }
}

function pattern(
  value: unknown,
  expression: RegExp,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !expression.test(value)) {
    fail(`${label} is invalid`);
  }
}

function internalVersionParts(
  value: unknown,
  label: string,
): readonly [bigint, bigint, bigint, bigint] {
  pattern(value, INTERNAL_VERSION_PATTERN, label);
  const match = INTERNAL_VERSION_PATTERN.exec(value);
  if (match === null) fail(`${label} is invalid`);
  return [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!), BigInt(match[4]!)];
}

function internalVersion(value: unknown, label: string): asserts value is string {
  internalVersionParts(value, label);
}

export function compareOrganizationInternalLiveReleaseVersions(
  left: string,
  right: string,
): -1 | 0 | 1 {
  const leftParts = internalVersionParts(left, 'left internal-live release version');
  const rightParts = internalVersionParts(right, 'right internal-live release version');
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index]! < rightParts[index]!) return -1;
    if (leftParts[index]! > rightParts[index]!) return 1;
  }
  return 0;
}

function id(value: unknown, prefix: string, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.startsWith(`${prefix}_`) ||
    !UUID_V4_PATTERN.test(value.slice(prefix.length + 1))
  ) {
    fail(`${label} is invalid`);
  }
}

function timestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail(`${label} is invalid`);
  }
}

function positive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
}

function nonnegative(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
}

function integrity(value: unknown, keyId: string, label: string): SignedIntegrity {
  const parsed = record(value, `${label} integrity`);
  exactKeys(
    parsed,
    [
      'canonicalization',
      'payload_sha256',
      'signature_algorithm',
      'key_id',
      'signature_base64',
    ],
    `${label} integrity`,
  );
  if (
    parsed['canonicalization'] !== 'RFC8785' ||
    parsed['signature_algorithm'] !== 'ecdsa-p256-sha256-der-low-s'
  ) {
    fail(`${label} signature profile is unsupported`);
  }
  pattern(parsed['payload_sha256'], /^sha256:[0-9a-f]{64}$/, `${label} payload digest`);
  pattern(parsed['key_id'], /^sha256:[0-9a-f]{64}$/, `${label} integrity key`);
  pattern(parsed['signature_base64'], /^[A-Za-z0-9+/]{8,256}={0,2}$/, `${label} signature`);
  if (parsed['key_id'] !== keyId) fail(`${label} signature key does not match installation key`);
  return parsed as unknown as SignedIntegrity;
}

function validateCoordinates(
  value: Record<string, unknown>,
  label: string,
): void {
  id(value['authority_id'], 'oau', `${label} authority_id`);
  pattern(value['authority_key_id'], /^sha256:[0-9a-f]{64}$/, `${label} authority_key_id`);
  id(value['organization_id'], 'org', `${label} organization_id`);
  id(value['enrollment_id'], 'enr', `${label} enrollment_id`);
  id(value['installation_id'], 'ins', `${label} installation_id`);
  pattern(value['installation_key_id'], /^sha256:[0-9a-f]{64}$/, `${label} installation_key_id`);
}

export function validateOrganizationInternalLiveReleaseManifest(
  value: unknown,
): OrganizationInternalLiveReleaseManifestV1 {
  const label = 'internal-live release manifest';
  const parsed = record(value, label);
  exactKeys(
    parsed,
    [
      'schema_version',
      'kind',
      'channel',
      'release_version',
      'release_tag',
      'source',
      'artifact',
      'compatibility',
      'build',
    ],
    label,
  );
  if (
    parsed['schema_version'] !== 1 ||
    parsed['kind'] !== 'echo-internal-live-release' ||
    parsed['channel'] !== 'internal-live'
  ) {
    fail(`${label} identity is unsupported`);
  }
  internalVersion(parsed['release_version'], `${label} release_version`);
  const releaseTag = `internal-v${parsed['release_version']}`;
  if (parsed['release_tag'] !== releaseTag) fail(`${label} tag does not match version`);

  const source = record(parsed['source'], `${label} source`);
  exactKeys(source, ['sha', 'kind'], `${label} source`);
  pattern(source['sha'], SOURCE_SHA_PATTERN, `${label} source SHA`);
  if (source['kind'] !== 'materialized-commit') fail(`${label} source kind is unsupported`);

  const compatibility = record(parsed['compatibility'], `${label} compatibility`);
  exactKeys(compatibility, ['os', 'arch', 'node', 'npm'], `${label} compatibility`);
  if (compatibility['os'] !== 'darwin' || compatibility['arch'] !== 'arm64') {
    fail(`${label} compatibility is unsupported`);
  }
  pattern(compatibility['node'], RUNTIME_VERSION_PATTERN, `${label} Node version`);
  pattern(compatibility['npm'], RUNTIME_VERSION_PATTERN, `${label} npm version`);

  const build = record(parsed['build'], `${label} build`);
  exactKeys(build, ['repository', 'workflow', 'run_id', 'run_attempt'], `${label} build`);
  if (build['repository'] !== INTERNAL_LIVE_REPOSITORY) {
    fail(`${label} repository is unsupported`);
  }
  if (build['workflow'] !== 'internal-live-release.yml') fail(`${label} workflow is unsupported`);
  pattern(build['run_id'], DECIMAL_ID_PATTERN, `${label} run_id`);
  positive(build['run_attempt'], `${label} run_attempt`);

  const artifact = record(parsed['artifact'], `${label} artifact`);
  exactKeys(
    artifact,
    ['package', 'filename', 'download_url', 'size_bytes', 'sha256'],
    `${label} artifact`,
  );
  if (artifact['package'] !== 'echo-brain') fail(`${label} package is unsupported`);
  pattern(artifact['filename'], PACKAGE_FILENAME_PATTERN, `${label} artifact filename`);
  positive(artifact['size_bytes'], `${label} artifact size_bytes`);
  pattern(artifact['sha256'], SHA256_PATTERN, `${label} artifact SHA-256`);
  const artifactUrl = `https://github.com/${build['repository']}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(artifact['filename'] as string)}`;
  if (artifact['download_url'] !== artifactUrl) fail(`${label} artifact URL is not deterministic`);

  return JSON.parse(canonicalJson(parsed)) as OrganizationInternalLiveReleaseManifestV1;
}

export function organizationInternalLiveManifestSha256(value: unknown): string {
  const manifest = validateOrganizationInternalLiveReleaseManifest(value);
  return sha256Digest(canonicalJson(manifest)).slice('sha256:'.length);
}

function expectedManifestUrl(manifest: OrganizationInternalLiveReleaseManifestV1): string {
  return `https://github.com/${manifest.build.repository}/releases/download/${encodeURIComponent(manifest.release_tag)}/internal-live-release-manifest.v1.json`;
}

export function validateApproveOrganizationInternalLiveReleaseRequest(
  value: unknown,
): ApproveOrganizationInternalLiveReleaseRequestV1 {
  const label = 'internal-live release approval request';
  const parsed = record(value, label);
  exactKeys(
    parsed,
    ['schema_version', 'kind', 'command_id', 'manifest_url', 'manifest_sha256', 'manifest'],
    label,
  );
  if (
    parsed['schema_version'] !== 1 ||
    parsed['kind'] !== 'echo-internal-live-release-approval-request'
  ) {
    fail(`${label} identity is unsupported`);
  }
  id(parsed['command_id'], 'adm', `${label} command_id`);
  pattern(parsed['manifest_sha256'], SHA256_PATTERN, `${label} manifest_sha256`);
  const manifest = validateOrganizationInternalLiveReleaseManifest(parsed['manifest']);
  if (parsed['manifest_sha256'] !== organizationInternalLiveManifestSha256(manifest)) {
    fail(`${label} manifest digest does not match the manifest`);
  }
  const manifestUrl = expectedManifestUrl(manifest);
  if (parsed['manifest_url'] !== manifestUrl) fail(`${label} manifest URL is not deterministic`);
  return {
    schema_version: 1,
    kind: 'echo-internal-live-release-approval-request',
    command_id: parsed['command_id'] as string,
    manifest_url: manifestUrl,
    manifest_sha256: parsed['manifest_sha256'] as string,
    manifest,
  };
}

export function validateOrganizationInternalLiveDirectiveRequest(
  value: unknown,
): OrganizationInternalLiveDirectiveRequestV1 {
  const label = 'internal-live directive request';
  const parsed = record(value, label);
  exactKeys(
    parsed,
    [
      'schema_version', 'kind', 'request_id', 'channel', 'authority_id',
      'authority_key_id', 'organization_id', 'enrollment_id', 'installation_id',
      'installation_key_id', 'requested_at', 'integrity',
    ],
    label,
  );
  if (
    parsed['schema_version'] !== 1 ||
    parsed['kind'] !== 'echo-internal-live-directive-request' ||
    parsed['channel'] !== 'internal-live'
  ) {
    fail(`${label} identity is unsupported`);
  }
  id(parsed['request_id'], 'udr', `${label} request_id`);
  validateCoordinates(parsed, label);
  timestamp(parsed['requested_at'], `${label} requested_at`);
  const parsedIntegrity = integrity(
    parsed['integrity'],
    parsed['installation_key_id'] as string,
    label,
  );
  return { ...parsed, integrity: parsedIntegrity } as unknown as OrganizationInternalLiveDirectiveRequestV1;
}

export function validateOrganizationInternalLiveUpdateDirective(
  value: unknown,
): OrganizationInternalLiveUpdateDirectiveV1 {
  const label = 'internal-live update directive';
  const parsed = record(value, label);
  exactKeys(
    parsed,
    [
      'schema_version',
      'kind',
      'channel',
      'directive_sequence',
      'manifest_url',
      'manifest_sha256',
      'approved_at',
      'evaluated_at',
    ],
    label,
  );
  if (
    parsed['schema_version'] !== 1 ||
    parsed['kind'] !== 'echo-internal-live-update-directive' ||
    parsed['channel'] !== 'internal-live'
  ) {
    fail(`${label} identity is unsupported`);
  }
  positive(parsed['directive_sequence'], `${label} directive_sequence`);
  pattern(
    parsed['manifest_url'],
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[^/?#]+\/internal-live-release-manifest\.v1\.json$/,
    `${label} manifest_url`,
  );
  pattern(parsed['manifest_sha256'], SHA256_PATTERN, `${label} manifest_sha256`);
  timestamp(parsed['approved_at'], `${label} approved_at`);
  timestamp(parsed['evaluated_at'], `${label} evaluated_at`);
  if (Date.parse(parsed['evaluated_at'] as string) < Date.parse(parsed['approved_at'] as string)) {
    fail(`${label} evaluated_at predates approval`);
  }
  return parsed as unknown as OrganizationInternalLiveUpdateDirectiveV1;
}

function validateDoctor(value: unknown): OrganizationInternalLiveUpdateReceiptPayloadV1['doctor'] {
  if (value === null) return null;
  const parsed = record(value, 'internal-live update receipt doctor');
  exactKeys(parsed, ['ok', 'passed', 'total'], 'internal-live update receipt doctor');
  if (typeof parsed['ok'] !== 'boolean') fail('internal-live update receipt doctor ok is invalid');
  nonnegative(parsed['passed'], 'internal-live update receipt doctor passed');
  positive(parsed['total'], 'internal-live update receipt doctor total');
  if (
    (parsed['passed'] as number) > (parsed['total'] as number) ||
    parsed['ok'] !== (parsed['passed'] === parsed['total'])
  ) {
    fail('internal-live update receipt doctor counts are inconsistent');
  }
  return parsed as unknown as NonNullable<OrganizationInternalLiveUpdateReceiptPayloadV1['doctor']>;
}

function validateFailure(value: unknown): OrganizationInternalLiveUpdateReceiptPayloadV1['failure'] {
  if (value === null) return null;
  const parsed = record(value, 'internal-live update receipt failure');
  exactKeys(parsed, ['phase', 'code'], 'internal-live update receipt failure');
  if (
    ![
      'backup', 'service_stop', 'install', 'service_start', 'doctor',
      'rollback',
    ].includes(parsed['phase'] as string)
  ) {
    fail('internal-live update receipt failure phase is unsupported');
  }
  pattern(parsed['code'], FAILURE_CODE_PATTERN, 'internal-live update receipt failure code');
  return parsed as unknown as NonNullable<OrganizationInternalLiveUpdateReceiptPayloadV1['failure']>;
}

export function validateOrganizationInternalLiveUpdateReceipt(
  value: unknown,
): OrganizationInternalLiveUpdateReceiptV1 {
  const label = 'internal-live update receipt';
  const parsed = record(value, label);
  exactKeys(
    parsed,
    [
      'schema_version', 'kind', 'channel', 'transaction_id', 'authority_id',
      'authority_key_id', 'organization_id', 'enrollment_id', 'installation_id',
      'installation_key_id', 'directive_sequence', 'release_version',
      'manifest_sha256', 'artifact_sha256', 'source_sha', 'outcome', 'doctor',
      'failure', 'finished_at', 'integrity',
    ],
    label,
  );
  if (
    parsed['schema_version'] !== 1 ||
    parsed['kind'] !== 'echo-internal-live-update-receipt' ||
    parsed['channel'] !== 'internal-live'
  ) {
    fail(`${label} identity is unsupported`);
  }
  id(parsed['transaction_id'], 'upd', `${label} transaction_id`);
  validateCoordinates(parsed, label);
  positive(parsed['directive_sequence'], `${label} directive_sequence`);
  internalVersion(parsed['release_version'], `${label} release_version`);
  pattern(parsed['manifest_sha256'], SHA256_PATTERN, `${label} manifest_sha256`);
  pattern(parsed['artifact_sha256'], SHA256_PATTERN, `${label} artifact_sha256`);
  pattern(parsed['source_sha'], SOURCE_SHA_PATTERN, `${label} source_sha`);
  if (!['healthy', 'rolled_back', 'failed'].includes(parsed['outcome'] as string)) {
    fail(`${label} outcome is unsupported`);
  }
  const doctor = validateDoctor(parsed['doctor']);
  const failure = validateFailure(parsed['failure']);
  if (
    (parsed['outcome'] === 'healthy' && (doctor?.ok !== true || failure !== null)) ||
    (parsed['outcome'] === 'rolled_back' && (doctor?.ok !== true || failure === null)) ||
    (parsed['outcome'] === 'failed' && failure === null)
  ) {
    fail(`${label} outcome evidence is inconsistent`);
  }
  timestamp(parsed['finished_at'], `${label} finished_at`);
  const parsedIntegrity = integrity(
    parsed['integrity'],
    parsed['installation_key_id'] as string,
    label,
  );
  return {
    ...parsed,
    doctor,
    failure,
    integrity: parsedIntegrity,
  } as unknown as OrganizationInternalLiveUpdateReceiptV1;
}

function validateRolloutReceiptSummary(
  value: unknown,
): OrganizationInternalLiveRolloutReceiptSummaryV1 {
  const label = 'internal-live rollout receipt summary';
  const parsed = record(value, label);
  exactKeys(
    parsed,
    ['release_version', 'outcome', 'doctor', 'failure', 'finished_at'],
    label,
  );
  internalVersion(parsed['release_version'], `${label} release_version`);
  if (!['healthy', 'rolled_back', 'failed'].includes(parsed['outcome'] as string)) {
    fail(`${label} outcome is unsupported`);
  }
  const doctor = validateDoctor(parsed['doctor']);
  const failure = validateFailure(parsed['failure']);
  if (
    (parsed['outcome'] === 'healthy' && (doctor?.ok !== true || failure !== null)) ||
    (parsed['outcome'] === 'rolled_back' && (doctor?.ok !== true || failure === null)) ||
    (parsed['outcome'] === 'failed' && failure === null)
  ) {
    fail(`${label} outcome evidence is inconsistent`);
  }
  timestamp(parsed['finished_at'], `${label} finished_at`);
  return {
    ...parsed,
    doctor,
    failure,
  } as unknown as OrganizationInternalLiveRolloutReceiptSummaryV1;
}

export function validateOrganizationInternalLiveRolloutStatus(
  value: unknown,
): OrganizationInternalLiveRolloutStatusV1 {
  const label = 'internal-live rollout status';
  const parsed = record(value, label);
  exactKeys(
    parsed,
    ['schema_version', 'kind', 'channel', 'evaluated_at', 'approved_release', 'installations'],
    label,
  );
  if (
    parsed['schema_version'] !== 1 ||
    parsed['kind'] !== 'echo-internal-live-rollout-status' ||
    parsed['channel'] !== 'internal-live'
  ) {
    fail(`${label} identity is unsupported`);
  }
  timestamp(parsed['evaluated_at'], `${label} evaluated_at`);
  let approvedRelease: OrganizationInternalLiveRolloutStatusV1['approved_release'] = null;
  if (parsed['approved_release'] !== null) {
    const approved = record(parsed['approved_release'], `${label} approved_release`);
    exactKeys(
      approved,
      [
        'directive_sequence',
        'release_version',
        'manifest_url',
        'manifest_sha256',
        'approved_at',
      ],
      `${label} approved_release`,
    );
    positive(approved['directive_sequence'], `${label} approved directive_sequence`);
    internalVersion(
      approved['release_version'],
      `${label} approved release_version`,
    );
    pattern(
      approved['manifest_url'],
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[^/?#]+\/internal-live-release-manifest\.v1\.json$/,
      `${label} approved manifest_url`,
    );
    pattern(approved['manifest_sha256'], SHA256_PATTERN, `${label} approved manifest_sha256`);
    timestamp(approved['approved_at'], `${label} approved_at`);
    approvedRelease = approved as unknown as NonNullable<OrganizationInternalLiveRolloutStatusV1['approved_release']>;
  }
  if (!Array.isArray(parsed['installations']) || parsed['installations'].length > 100) {
    fail(`${label} installations are invalid`);
  }
  const installations = parsed['installations'].map((item, index) => {
    const installation = record(item, `${label} installation ${index}`);
    exactKeys(
      installation,
      ['installation_id', 'rollout_state', 'receipt'],
      `${label} installation ${index}`,
    );
    id(installation['installation_id'], 'ins', `${label} installation_id`);
    if (!['no_release', 'pending', 'healthy', 'rolled_back', 'failed'].includes(installation['rollout_state'] as string)) {
      fail(`${label} rollout_state is unsupported`);
    }
    const receipt =
      installation['receipt'] === null
        ? null
        : validateRolloutReceiptSummary(installation['receipt']);
    if (
      (approvedRelease === null &&
        (installation['rollout_state'] !== 'no_release' || receipt !== null)) ||
      (approvedRelease !== null && installation['rollout_state'] === 'no_release') ||
      (installation['rollout_state'] === 'pending' && receipt !== null) ||
      (['healthy', 'rolled_back', 'failed'].includes(installation['rollout_state'] as string) &&
        (receipt === null || receipt.outcome !== installation['rollout_state']))
    ) {
      fail(`${label} installation state is inconsistent`);
    }
    return { ...installation, receipt } as OrganizationInternalLiveRolloutStatusV1['installations'][number];
  });
  if (new Set(installations.map((item) => item.installation_id)).size !== installations.length) {
    fail(`${label} repeats an installation`);
  }
  return {
    schema_version: 1,
    kind: 'echo-internal-live-rollout-status',
    channel: 'internal-live',
    evaluated_at: parsed['evaluated_at'] as string,
    approved_release: approvedRelease,
    installations,
  };
}

export function verifyOrganizationInternalLiveDirectiveRequest(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): OrganizationInternalLiveDirectiveRequestV1 {
  const request = validateOrganizationInternalLiveDirectiveRequest(value);
  const publicKey = verifyP256SigningKeyDescriptor(installationSigningKey);
  if (request.installation_key_id !== installationSigningKey.key_id) {
    fail('internal-live directive request does not match the installation key');
  }
  verifySignedDocument(request, publicKey, installationSigningKey.key_id);
  return request;
}

export function verifyOrganizationInternalLiveUpdateReceipt(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): OrganizationInternalLiveUpdateReceiptV1 {
  const receipt = validateOrganizationInternalLiveUpdateReceipt(value);
  const publicKey = verifyP256SigningKeyDescriptor(installationSigningKey);
  if (receipt.installation_key_id !== installationSigningKey.key_id) {
    fail('internal-live update receipt does not match the installation key');
  }
  verifySignedDocument(receipt, publicKey, installationSigningKey.key_id);
  return receipt;
}

export async function createOrganizationInternalLiveDirectiveRequest(
  input: Omit<OrganizationInternalLiveDirectiveRequestPayloadV1, 'schema_version' | 'kind' | 'channel' | 'installation_key_id'> & {
    installation_signing_key: P256SigningKeyDescriptor;
  },
  sign: CanonicalPayloadSigner,
): Promise<OrganizationInternalLiveDirectiveRequestV1> {
  verifyP256SigningKeyDescriptor(input.installation_signing_key);
  const payload: OrganizationInternalLiveDirectiveRequestPayloadV1 = {
    schema_version: 1,
    kind: 'echo-internal-live-directive-request',
    channel: 'internal-live',
    request_id: input.request_id,
    authority_id: input.authority_id,
    authority_key_id: input.authority_key_id,
    organization_id: input.organization_id,
    enrollment_id: input.enrollment_id,
    installation_id: input.installation_id,
    installation_key_id: input.installation_signing_key.key_id,
    requested_at: input.requested_at,
  };
  return verifyOrganizationInternalLiveDirectiveRequest(
    await createSignedDocumentWithKey(payload, payload.installation_key_id, sign),
    input.installation_signing_key,
  );
}

export async function createOrganizationInternalLiveUpdateReceipt(
  input: Omit<OrganizationInternalLiveUpdateReceiptPayloadV1, 'schema_version' | 'kind' | 'channel' | 'installation_key_id'> & {
    installation_signing_key: P256SigningKeyDescriptor;
  },
  sign: CanonicalPayloadSigner,
): Promise<OrganizationInternalLiveUpdateReceiptV1> {
  verifyP256SigningKeyDescriptor(input.installation_signing_key);
  const payload: OrganizationInternalLiveUpdateReceiptPayloadV1 = {
    ...input,
    schema_version: 1,
    kind: 'echo-internal-live-update-receipt',
    channel: 'internal-live',
    installation_key_id: input.installation_signing_key.key_id,
  };
  delete (payload as unknown as { installation_signing_key?: unknown }).installation_signing_key;
  return verifyOrganizationInternalLiveUpdateReceipt(
    await createSignedDocumentWithKey(payload, payload.installation_key_id, sign),
    input.installation_signing_key,
  );
}

export function organizationInternalLiveDirectiveRequestSha256(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): Sha256Digest {
  return canonicalSha256(
    verifyOrganizationInternalLiveDirectiveRequest(value, installationSigningKey),
  );
}

export function organizationInternalLiveUpdateReceiptSha256(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): Sha256Digest {
  return canonicalSha256(
    verifyOrganizationInternalLiveUpdateReceipt(value, installationSigningKey),
  );
}
