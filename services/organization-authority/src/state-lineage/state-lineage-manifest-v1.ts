import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
  canonicalJson,
  canonicalJsonBytes,
  canonicalSha256,
} from '@echo-brain/federation-protocol';
import type {
  FederationIdPrefix,
  JsonValue,
  Sha256Digest,
} from '@echo-brain/federation-protocol';

/**
 * State-lineage manifests: the closed bodies that bind one state directory and
 * each database inside it to exactly one Authority, organization, and lineage.
 *
 * These are contract bodies only. This module opens no file or database, reads
 * no directory, and performs no coherence check across manifests; the separate
 * read-only pre-open guard owns that. The manifest table named here does not
 * exist in any current schema: no migration in this repository creates it, and
 * this module deliberately adds none. Like the Authority initialization
 * manifest, these contracts are composition-owned migration mechanics, not
 * Authority protocol surface, so they live here rather than in a package
 * export.
 */

export class StateLineageContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateLineageContractError';
  }
}

export const STATE_LINEAGE_ROOT_MANIFEST_V1_KIND =
  'echo-state-lineage-root-manifest-v1' as const;
export const STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND =
  'echo-state-lineage-database-manifest-v1' as const;

/** Root manifest filename inside a state directory. */
export const STATE_LINEAGE_ROOT_MANIFEST_FILENAME =
  'state-lineage-root.v1.json' as const;

/**
 * Expected location of a per-database lineage manifest: one single-row table
 * holding the canonical body and its digest. No migration creates it yet.
 */
export const STATE_LINEAGE_MANIFEST_TABLE =
  'echo_state_lineage_manifest' as const;
export const STATE_LINEAGE_MANIFEST_ROW_KEYS = [
  'singleton',
  'manifest_json',
  'manifest_sha256',
] as const;

export type StateLineageRoleV1 =
  | 'authority'
  | 'control-plane'
  | 'record-log'
  | 'record-derived'
  | 'retrieval-facts'
  | 'retrieval-lexical'
  | 'retrieval-content';

/** Canonical role order. Every seven-slot array is compared against it. */
export const STATE_LINEAGE_ROLES_V1 = Object.freeze([
  'authority',
  'control-plane',
  'record-log',
  'record-derived',
  'retrieval-facts',
  'retrieval-lexical',
  'retrieval-content',
] as const);

/**
 * SQLite header `application_id` per role. The IDs are role-stable: they
 * discriminate which role's file this is, while lineage, Authority, and
 * organization identity is carried only by the manifests.
 *
 * Six values are the shipped constants and must not be reassigned:
 * control-plane from services/organization-control-plane/src/persistence/
 * migrate.ts, record-log and record-derived from services/organization-record/
 * src/persistence/database-definition.ts, and the three retrieval planes from
 * services/organization-retrieval/src/persistence/database-definition.ts. Only
 * `authority` is newly assigned here: no authority database written by the
 * current migrator carries any header application_id, so this value can be
 * satisfied only by a future initializer that writes it.
 */
export const STATE_LINEAGE_ROLE_APPLICATION_IDS_V1: Readonly<
  Record<StateLineageRoleV1, number>
> = Object.freeze({
  authority: 0x45434155,
  'control-plane': 0x45434f50,
  'record-log': 0x4543524c,
  'record-derived': 0x45435244,
  'retrieval-facts': 0x45524654,
  'retrieval-lexical': 0x45524c58,
  'retrieval-content': 0x45524354,
});

export interface StateFileLocationV1 {
  readonly kind: 'state_file';
  readonly filename: string;
}

/**
 * The three retrieval planes are not state-directory peers: each generation
 * segment holds its own triple, so one role names many files.
 */
export interface RetrievalSegmentTreeLocationV1 {
  readonly kind: 'retrieval_segment_tree';
  readonly directory: string;
  readonly filename: string;
}

export type StateLineageLocationV1 =
  | StateFileLocationV1
  | RetrievalSegmentTreeLocationV1;

export const STATE_LINEAGE_RETRIEVAL_DIRECTORY = 'record-retrieval' as const;

const ROLE_LOCATIONS: Readonly<
  Record<StateLineageRoleV1, StateLineageLocationV1>
> = Object.freeze({
  authority: Object.freeze({
    kind: 'state_file' as const,
    filename: 'authority.sqlite',
  }),
  'control-plane': Object.freeze({
    kind: 'state_file' as const,
    filename: 'integrations.sqlite',
  }),
  'record-log': Object.freeze({
    kind: 'state_file' as const,
    filename: 'record-log.sqlite',
  }),
  'record-derived': Object.freeze({
    kind: 'state_file' as const,
    filename: 'record-derived.sqlite',
  }),
  'retrieval-facts': Object.freeze({
    kind: 'retrieval_segment_tree' as const,
    directory: STATE_LINEAGE_RETRIEVAL_DIRECTORY,
    filename: 'facts.sqlite',
  }),
  'retrieval-lexical': Object.freeze({
    kind: 'retrieval_segment_tree' as const,
    directory: STATE_LINEAGE_RETRIEVAL_DIRECTORY,
    filename: 'lexical.sqlite',
  }),
  'retrieval-content': Object.freeze({
    kind: 'retrieval_segment_tree' as const,
    directory: STATE_LINEAGE_RETRIEVAL_DIRECTORY,
    filename: 'content.sqlite',
  }),
});

export interface StateLineageDatabaseSlotV1 {
  readonly role: StateLineageRoleV1;
  readonly location: StateLineageLocationV1;
  readonly application_id: number;
}

export interface StateLineageRootManifestV1 {
  readonly schema_version: 1;
  readonly kind: typeof STATE_LINEAGE_ROOT_MANIFEST_V1_KIND;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly databases: readonly StateLineageDatabaseSlotV1[];
  readonly created_at: string;
  readonly creating_artifact_revision: string;
}

export interface StateLineageDatabaseManifestV1 {
  readonly schema_version: 1;
  readonly kind: typeof STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND;
  readonly role: StateLineageRoleV1;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly database_schema_version: number;
  readonly schema_sha256: Sha256Digest;
  readonly created_at: string;
  readonly creating_artifact_revision: string;
}

export interface StoredStateLineageDatabaseManifestV1 {
  readonly body: StateLineageDatabaseManifestV1;
  readonly manifest_sha256: Sha256Digest;
}

const ROOT_MANIFEST_KEYS = [
  'schema_version',
  'kind',
  'authority_id',
  'organization_id',
  'state_lineage_id',
  'databases',
  'created_at',
  'creating_artifact_revision',
] as const;
const DATABASE_MANIFEST_KEYS = [
  'schema_version',
  'kind',
  'role',
  'authority_id',
  'organization_id',
  'state_lineage_id',
  'database_schema_version',
  'schema_sha256',
  'created_at',
  'creating_artifact_revision',
] as const;
const SLOT_KEYS = ['role', 'location', 'application_id'] as const;
const STATE_FILE_LOCATION_KEYS = ['kind', 'filename'] as const;
const RETRIEVAL_LOCATION_KEYS = ['kind', 'directory', 'filename'] as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_STATE_LINEAGE_MANIFEST_BYTES = 16 * 1024;

function fail(message: string): never {
  throw new StateLineageContractError(message);
}

/** Reject every value that could not have arrived as inert canonical JSON. */
function assertPlainJsonData(value: unknown, label: string): void {
  if (value === null || typeof value !== 'object') {
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      (typeof value !== 'number' || !Number.isFinite(value))
    ) {
      fail(`${label} must contain only finite JSON data`);
    }
    return;
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail(`${label} must not contain symbol properties`);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail(`${label} must be a plain array`);
    }
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== value.length + 1 || !names.includes('length')) {
      fail(`${label} must be a dense plain array`);
    }
  } else if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (Array.isArray(value) && key === 'length') continue;
    if (
      !('value' in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      fail(`${label} must contain only enumerable data properties`);
    }
    assertPlainJsonData(descriptor.value, label);
  }
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  assertPlainJsonData(value, label);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} has an unexpected shape`);
  }
  return record;
}

function assertDigest(
  value: unknown,
  label: string,
): asserts value is Sha256Digest {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertId(
  value: unknown,
  prefix: FederationIdPrefix,
  label: string,
): asserts value is string {
  if (typeof value !== 'string') {
    fail(`${label} must be a canonical ${prefix} identifier`);
  }
  try {
    assertFederationId(value, prefix, label);
  } catch {
    fail(`${label} must be a canonical ${prefix} identifier`);
  }
}

function assertTimestamp(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string') {
    fail(`${label} must be a UTC millisecond timestamp`);
  }
  try {
    assertUtcMillisecondTimestamp(value, label);
  } catch {
    fail(`${label} must be a UTC millisecond timestamp`);
  }
}

function assertNonnegativeSafeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a nonnegative safe integer`);
  }
}

function assertBoundedText(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${label} must be bounded canonical text`);
  }
}

function assertRole(
  value: unknown,
  label: string,
): asserts value is StateLineageRoleV1 {
  if (
    typeof value !== 'string' ||
    !STATE_LINEAGE_ROLES_V1.includes(value as StateLineageRoleV1)
  ) {
    fail(`${label} is not a supported state-lineage role`);
  }
}

function boundedDocument<T>(value: T, label: string): T {
  let bytes;
  try {
    bytes = canonicalJsonBytes(value as unknown as JsonValue);
  } catch {
    fail(`${label} must be an I-JSON document`);
  }
  if (bytes.length === 0 || bytes.length > MAX_STATE_LINEAGE_MANIFEST_BYTES) {
    fail(
      `${label} must be between 1 and ${MAX_STATE_LINEAGE_MANIFEST_BYTES} canonical bytes`,
    );
  }
  return JSON.parse(bytes.toString('utf8')) as T;
}

/** The canonical seven slots, in role order, with their pinned identities. */
export function stateLineageDatabaseSlotsV1(): readonly StateLineageDatabaseSlotV1[] {
  return Object.freeze(
    STATE_LINEAGE_ROLES_V1.map((role) =>
      Object.freeze({
        role,
        location: ROLE_LOCATIONS[role],
        application_id: STATE_LINEAGE_ROLE_APPLICATION_IDS_V1[role],
      }),
    ),
  );
}

function validateLocation(
  value: unknown,
  role: StateLineageRoleV1,
  label: string,
): StateLineageLocationV1 {
  const expected = ROLE_LOCATIONS[role];
  const record = exactObject(
    value,
    expected.kind === 'state_file'
      ? STATE_FILE_LOCATION_KEYS
      : RETRIEVAL_LOCATION_KEYS,
    label,
  );
  if (
    canonicalJson(record as unknown as JsonValue) !==
    canonicalJson(expected as unknown as JsonValue)
  ) {
    fail(`${label} does not match the canonical location for ${role}`);
  }
  return expected;
}

function validateSlot(
  value: unknown,
  expectedRole: StateLineageRoleV1,
  label: string,
): StateLineageDatabaseSlotV1 {
  const record = exactObject(value, SLOT_KEYS, label);
  assertRole(record.role, `${label} role`);
  if (record.role !== expectedRole) {
    fail(`${label} role is out of canonical order`);
  }
  validateLocation(record.location, expectedRole, `${label} location`);
  if (
    record.application_id !==
    STATE_LINEAGE_ROLE_APPLICATION_IDS_V1[expectedRole]
  ) {
    fail(`${label} application_id does not match the ${expectedRole} role`);
  }
  return Object.freeze({
    role: expectedRole,
    location: ROLE_LOCATIONS[expectedRole],
    application_id: STATE_LINEAGE_ROLE_APPLICATION_IDS_V1[expectedRole],
  });
}

function validateSlots(
  value: unknown,
  label: string,
): readonly StateLineageDatabaseSlotV1[] {
  assertPlainJsonData(value, label);
  if (!Array.isArray(value)) fail(`${label} must be a plain array`);
  if (value.length !== STATE_LINEAGE_ROLES_V1.length) {
    fail(`${label} must contain every state-lineage role exactly once`);
  }
  return Object.freeze(
    STATE_LINEAGE_ROLES_V1.map((role, index) =>
      validateSlot(value[index], role, `${label}[${String(index)}]`),
    ),
  );
}

export function validateStateLineageRootManifestV1(
  value: unknown,
): StateLineageRootManifestV1 {
  const label = 'State lineage root manifest v1';
  const record = exactObject(value, ROOT_MANIFEST_KEYS, label);
  if (record.schema_version !== 1) {
    fail(`${label} schema_version is unsupported`);
  }
  if (record.kind !== STATE_LINEAGE_ROOT_MANIFEST_V1_KIND) {
    fail(`${label} kind is unsupported`);
  }
  assertId(record.authority_id, 'oau', `${label} authority_id`);
  assertId(record.organization_id, 'org', `${label} organization_id`);
  assertBoundedText(record.state_lineage_id, `${label} state_lineage_id`, 128);
  const databases = validateSlots(record.databases, `${label} databases`);
  assertTimestamp(record.created_at, `${label} created_at`);
  assertBoundedText(
    record.creating_artifact_revision,
    `${label} creating_artifact_revision`,
    256,
  );
  return Object.freeze(
    boundedDocument(
      {
        schema_version: 1 as const,
        kind: STATE_LINEAGE_ROOT_MANIFEST_V1_KIND,
        authority_id: record.authority_id,
        organization_id: record.organization_id,
        state_lineage_id: record.state_lineage_id,
        databases,
        created_at: record.created_at,
        creating_artifact_revision: record.creating_artifact_revision,
      },
      label,
    ),
  );
}

export function stateLineageRootManifestSha256V1(value: unknown): Sha256Digest {
  return canonicalSha256(
    validateStateLineageRootManifestV1(value) as unknown as JsonValue,
  );
}

export function validateStateLineageDatabaseManifestV1(
  value: unknown,
): StateLineageDatabaseManifestV1 {
  const label = 'State lineage database manifest v1';
  const record = exactObject(value, DATABASE_MANIFEST_KEYS, label);
  if (record.schema_version !== 1) {
    fail(`${label} schema_version is unsupported`);
  }
  if (record.kind !== STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND) {
    fail(`${label} kind is unsupported`);
  }
  assertRole(record.role, `${label} role`);
  assertId(record.authority_id, 'oau', `${label} authority_id`);
  assertId(record.organization_id, 'org', `${label} organization_id`);
  assertBoundedText(record.state_lineage_id, `${label} state_lineage_id`, 128);
  assertNonnegativeSafeInteger(
    record.database_schema_version,
    `${label} database_schema_version`,
  );
  assertDigest(record.schema_sha256, `${label} schema_sha256`);
  assertTimestamp(record.created_at, `${label} created_at`);
  assertBoundedText(
    record.creating_artifact_revision,
    `${label} creating_artifact_revision`,
    256,
  );
  return Object.freeze(
    boundedDocument(
      {
        schema_version: 1 as const,
        kind: STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
        role: record.role,
        authority_id: record.authority_id,
        organization_id: record.organization_id,
        state_lineage_id: record.state_lineage_id,
        database_schema_version: record.database_schema_version,
        schema_sha256: record.schema_sha256,
        created_at: record.created_at,
        creating_artifact_revision: record.creating_artifact_revision,
      },
      label,
    ),
  );
}

export function stateLineageDatabaseManifestSha256V1(
  value: unknown,
): Sha256Digest {
  return canonicalSha256(
    validateStateLineageDatabaseManifestV1(value) as unknown as JsonValue,
  );
}

/**
 * Validate one stored manifest row. The stored text must be the exact
 * canonical bytes of the body it claims, and the stored digest must be the
 * digest of that same body: neither is trusted from the row.
 */
export function validateStoredStateLineageDatabaseManifestV1(
  value: unknown,
): StoredStateLineageDatabaseManifestV1 {
  const label = 'State lineage database manifest row v1';
  const record = exactObject(value, STATE_LINEAGE_MANIFEST_ROW_KEYS, label);
  if (record.singleton !== 1) {
    fail(`${label} singleton must be 1`);
  }
  if (
    typeof record.manifest_json !== 'string' ||
    record.manifest_json.length === 0 ||
    record.manifest_json.length > MAX_STATE_LINEAGE_MANIFEST_BYTES
  ) {
    fail(`${label} manifest_json must be bounded canonical text`);
  }
  assertDigest(record.manifest_sha256, `${label} manifest_sha256`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.manifest_json) as unknown;
  } catch {
    fail(`${label} manifest_json is not JSON`);
  }
  const body = validateStateLineageDatabaseManifestV1(parsed);
  if (record.manifest_json !== canonicalJson(body as unknown as JsonValue)) {
    fail(`${label} manifest_json is not canonical`);
  }
  const digest = canonicalSha256(body as unknown as JsonValue);
  if (record.manifest_sha256 !== digest) {
    fail(`${label} manifest_sha256 does not match its body`);
  }
  return Object.freeze({ body, manifest_sha256: digest });
}
