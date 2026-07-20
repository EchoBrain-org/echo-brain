import { lstatSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { atomicCreate } from "../../infrastructure/filesystem/atomic-create.js";
import {
  assertDirectory,
  assertDisjointPaths,
  assertPrivateOwnedDirectory,
  assertPrivateOwnedRegularFile,
  assertSafeRelativePath,
  canonicalLocalPath,
  ensureDirectory,
  fsyncDirectory,
  pathEntryExists,
  pathIsWithin,
  readFileNoFollow,
  resolveContainedRelativePath,
} from "../secure-local-files.js";
import { spawnSanitizedChild } from "../spawn-sanitized-child.js";
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
  sha256Digest,
} from "./canonical-json.js";
import type { FederationId, Sha256Digest } from "./contracts.js";
import {
  createFederatedExportBundle,
  verifyFederatedExportBundle,
  type CreateFederatedExportBundleRequest,
  type CreatedFederatedExportBundle,
  type FederatedExportIdentitySource,
  type FederatedExportOutboxSource,
  type VerifiedFederatedExportBundle,
} from "./export-bundle.js";
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
  federationId,
} from "./identifiers.js";
import type { InstallationSigner } from "./installation-signer.js";
import type { FederatedOutboxStore } from "./outbox-store.js";

const LOCAL_DIRECTORY = "federation/independent-copy";
const TARGET_FILENAME = "target.v1.json";
const TARGET_COPY_DIRECTORY = "echo-brain-independent-copies";
const TARGET_BINDING_FILENAME = "target-binding.v1.json";
const MAX_PLATFORM_OUTPUT_BYTES = 1024 * 1024;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const NON_BLANK_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface IndependentCopyTargetInspection {
  canonical_root: string;
  canonical_mount_point: string;
  volume_id: string;
  state_filesystem_device_id: string;
  target_filesystem_device_id: string;
  state_physical_device_ids: readonly string[];
  target_physical_device_ids: readonly string[];
  target_media: "external-physical";
  mounted: true;
  encrypted: true;
  assurance: "platform_verified";
}

export interface IndependentCopyPlatformInspector {
  inspect(input: {
    state_directory: string;
    target_root: string;
  }): Promise<IndependentCopyTargetInspection>;
}

export interface IndependentCopyTargetRecordV1 {
  schema_version: 1;
  kind: "echo-founder-independent-copy-target";
  state_path_sha256: Sha256Digest;
  target_root: string;
  mount_point: string;
  volume_id: string;
  protection: {
    kind: "encrypted-volume";
    assurance: "platform_verified";
  };
  configured_at: string;
}

interface IndependentCopyIntentV1 {
  schema_version: 1;
  kind: "echo-founder-independent-copy-intent";
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

interface IndependentCopyTargetBindingV1 {
  schema_version: 1;
  kind: "echo-founder-independent-copy-target-binding";
  state_path_sha256: Sha256Digest;
  target_configuration_sha256: Sha256Digest;
  volume_id: string;
}

export interface IndependentCopyReceiptV1 {
  schema_version: 1;
  kind: "echo-founder-independent-copy-receipt";
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
  listInstallationIds: FederatedOutboxStore["listInstallationIds"];
  readChainHead: FederatedOutboxStore["readChainHead"];
  readSequenceRange: FederatedOutboxStore["readSequenceRange"];
}

export type IndependentCopyFaultPoint =
  "after_intent" | "after_export_before_receipt";

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

interface ChainSnapshot {
  installation_id: FederationId;
  last_sequence: number;
  head_hash: Sha256Digest;
}

interface ProtectedExportSnapshot extends ChainSnapshot {
  path: string;
  records_bytes: Buffer;
  export_id: FederationId;
  generated_at: string;
  signing_identity_manifest_id: FederationId;
  export_manifest_sha256: Sha256Digest;
  records_sha256: Sha256Digest;
}

function fail(message: string): never {
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
    fail(`${label} has unknown or missing fields`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertDigest(
  value: unknown,
  label: string,
): asserts value is Sha256Digest {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    fail(`${label} is not a canonical SHA-256 digest`);
  }
}

function assertPrivateCanonicalFile(path: string, label: string): string {
  assertPrivateOwnedRegularFile(path, 0o600, () => {
    fail(`${label} must be a current-user regular file with mode 0600`);
  });
  return readFileNoFollow(path, label).toString("utf8");
}

function readCanonical(path: string, label: string): unknown {
  try {
    return parseCanonicalJson(assertPrivateCanonicalFile(path, label));
  } catch (error) {
    fail(`${label} is invalid: ${(error as Error).message}`);
  }
}

function statePathDigest(path: string): Sha256Digest {
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
  if (!isRecord(value)) fail(`${label} must be an object`);
  exactKeys(value, fields, label);
  if (
    value["schema_version"] !== 1 ||
    value["kind"] !== kind ||
    stringFields.some((field) => typeof value[field] !== "string") ||
    recordFields.some((field) => !isRecord(value[field]))
  ) {
    fail(`${label} has invalid field types or version`);
  }
}

function assertCopyEvidence(
  value: IndependentCopyIntentV1 | IndependentCopyReceiptV1,
  label: "intent" | "receipt",
  timestamp: string,
): void {
  assertFederationId(value.organization_id, "org", `${label} organization_id`);
  assertFederationId(value.installation_id, "ins", `${label} installation_id`);
  if (label === "intent") {
    assertFederationId(
      (value as IndependentCopyIntentV1).signing_identity_manifest_id,
      "idm",
      "intent signing_identity_manifest_id",
    );
  }
  assertFederationId(value.export_id, "exp", `${label} export_id`);
  assertUtcMillisecondTimestamp(
    timestamp,
    `${label} ${label === "intent" ? "generated_at" : "verified_at"}`,
  );
  assertSafeRelativePath(
    value.bundle_relative_path,
    `${label} bundle_relative_path`,
  );
  const sequence = value.sequence as unknown as Record<string, unknown>;
  exactKeys(
    sequence,
    ["first", "last", "head_hash"],
    `independent-copy ${label} sequence`,
  );
  if (
    sequence["first"] !== 1 ||
    !Number.isSafeInteger(sequence["last"]) ||
    (sequence["last"] as number) < 1
  ) {
    fail(`independent-copy ${label} sequence is invalid`);
  }
  assertDigest(sequence["head_hash"], `${label} sequence head_hash`);
}

function assertTargetRecord(value: unknown): IndependentCopyTargetRecordV1 {
  assertDocumentRecord(
    value,
    "independent-copy target",
    "echo-founder-independent-copy-target",
    [
      "schema_version",
      "kind",
      "state_path_sha256",
      "target_root",
      "mount_point",
      "volume_id",
      "protection",
      "configured_at",
    ],
    ["target_root", "mount_point", "volume_id", "configured_at"],
    ["protection"],
  );
  const target = value as unknown as IndependentCopyTargetRecordV1;
  assertDigest(target.state_path_sha256, "target state_path_sha256");
  exactKeys(
    value["protection"] as Record<string, unknown>,
    ["kind", "assurance"],
    "independent-copy target protection",
  );
  if (
    target.protection.kind !== "encrypted-volume" ||
    target.protection.assurance !== "platform_verified"
  ) {
    fail(
      "independent-copy target protection is not platform-verified encryption",
    );
  }
  if (!NON_BLANK_IDENTITY.test(target.volume_id)) {
    fail("independent-copy target volume identity is invalid");
  }
  assertUtcMillisecondTimestamp(
    target.configured_at,
    "independent-copy target configured_at",
  );
  return target;
}

function assertIntent(value: unknown): IndependentCopyIntentV1 {
  assertDocumentRecord(
    value,
    "independent-copy intent",
    "echo-founder-independent-copy-intent",
    [
      "schema_version",
      "kind",
      "state_path_sha256",
      "target_record_sha256",
      "organization_id",
      "installation_id",
      "signing_identity_manifest_id",
      "sequence",
      "export_id",
      "generated_at",
      "bundle_relative_path",
    ],
    [
      "organization_id",
      "installation_id",
      "signing_identity_manifest_id",
      "export_id",
      "generated_at",
      "bundle_relative_path",
    ],
    ["sequence"],
  );
  const intent = value as unknown as IndependentCopyIntentV1;
  assertDigest(intent.state_path_sha256, "intent state_path_sha256");
  assertDigest(intent.target_record_sha256, "intent target_record_sha256");
  assertCopyEvidence(intent, "intent", intent.generated_at);
  return intent;
}

function assertReceipt(value: unknown): IndependentCopyReceiptV1 {
  assertDocumentRecord(
    value,
    "independent-copy receipt",
    "echo-founder-independent-copy-receipt",
    [
      "schema_version",
      "kind",
      "intent_sha256",
      "target_record_sha256",
      "organization_id",
      "installation_id",
      "sequence",
      "export_id",
      "bundle_relative_path",
      "export_manifest_sha256",
      "records_sha256",
      "verified_at",
    ],
    [
      "organization_id",
      "installation_id",
      "export_id",
      "bundle_relative_path",
      "verified_at",
    ],
    ["sequence"],
  );
  const receipt = value as unknown as IndependentCopyReceiptV1;
  assertDigest(receipt.intent_sha256, "receipt intent_sha256");
  assertDigest(receipt.target_record_sha256, "receipt target_record_sha256");
  assertDigest(
    receipt.export_manifest_sha256,
    "receipt export_manifest_sha256",
  );
  assertDigest(receipt.records_sha256, "receipt records_sha256");
  assertCopyEvidence(receipt, "receipt", receipt.verified_at);
  return receipt;
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function headKey(head: ChainSnapshot): string {
  return `${head.installation_id}.${head.last_sequence}.${head.head_hash.slice("sha256:".length)}`;
}

function bundleDirectoryName(head: ChainSnapshot): string {
  return `echo-org-export-${head.installation_id}-1-${head.last_sequence}`;
}

const BUNDLE_DIRECTORY_PATTERN =
  /^echo-org-export-(ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-1-([1-9][0-9]*)$/;
const BINDING_TEMP_PATTERN =
  /^target-binding\.v1\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const EXPORT_STAGING_PATTERN =
  /^\.(echo-org-export-(ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-1-([1-9][0-9]*))\.(exp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.staging-[A-Za-z0-9]{6}$/;
const LOCAL_INTENT_TEMP_PATTERN =
  /^intent\.ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[1-9][0-9]*\.[0-9a-f]{64}\.v1\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const LOCAL_RECEIPT_TEMP_PATTERN =
  /^receipt\.ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[1-9][0-9]*\.[0-9a-f]{64}\.v1\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

function sameHeads(
  left: readonly ChainSnapshot[],
  right: readonly ChainSnapshot[],
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameConfiguredTarget(
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

function targetConfigurationDigest(
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

function assertInspection(
  inspection: IndependentCopyTargetInspection,
  stateDirectory: string,
  targetRoot: string,
): void {
  if (
    inspection.canonical_root !== targetRoot ||
    inspection.mounted !== true ||
    inspection.encrypted !== true ||
    inspection.target_media !== "external-physical" ||
    inspection.assurance !== "platform_verified"
  ) {
    fail(
      "platform inspection did not verify the requested mounted encrypted target",
    );
  }
  if (
    !NON_BLANK_IDENTITY.test(inspection.volume_id) ||
    !NON_BLANK_IDENTITY.test(inspection.state_filesystem_device_id) ||
    !NON_BLANK_IDENTITY.test(inspection.target_filesystem_device_id) ||
    inspection.state_physical_device_ids.length === 0 ||
    inspection.target_physical_device_ids.length === 0 ||
    inspection.state_physical_device_ids.some(
      (identity) => !NON_BLANK_IDENTITY.test(identity),
    ) ||
    inspection.target_physical_device_ids.some(
      (identity) => !NON_BLANK_IDENTITY.test(identity),
    )
  ) {
    fail("platform inspection returned an invalid filesystem identity");
  }
  if (
    inspection.state_filesystem_device_id ===
    inspection.target_filesystem_device_id
  ) {
    fail("independent-copy target must use a different filesystem/device");
  }
  const statePhysicalDevices = new Set(inspection.state_physical_device_ids);
  if (
    inspection.target_physical_device_ids.some((identity) =>
      statePhysicalDevices.has(identity),
    )
  ) {
    fail(
      "independent-copy target must use a different physical storage device",
    );
  }
  const mountPoint = canonicalLocalPath(
    inspection.canonical_mount_point,
    "independent-copy mount point",
    true,
  );
  if (
    mountPoint !== inspection.canonical_mount_point ||
    !pathIsWithin(targetRoot, mountPoint, true)
  ) {
    fail(
      "independent-copy target is not contained by its inspected mount point",
    );
  }
  assertDisjointPaths(
    stateDirectory,
    targetRoot,
    "state directory",
    "independent-copy target",
  );
}

async function collectSpawnedChild(
  child: ReturnType<typeof spawnSanitizedChild>,
  label: string,
  input?: Buffer,
): Promise<Buffer> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) resolve(value ?? Buffer.alloc(0));
      else reject(error);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${label} timed out`));
    }, 10_000);
    child.on("error", (error) => finish(error));
    child.stdin.on("error", (error) => finish(error));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_PLATFORM_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error(`${label} produced excessive output`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_PLATFORM_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.on("close", (code, signal) => {
      if (code !== 0) {
        finish(
          new Error(
            `${label} failed (${signal ?? String(code)}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
        return;
      }
      finish(undefined, Buffer.concat(stdout));
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

function readDiskUtilityPlist(targetRoot: string): Promise<Buffer> {
  return collectSpawnedChild(
    spawnSanitizedChild("/usr/sbin/diskutil", ["info", "-plist", targetRoot]),
    "/usr/sbin/diskutil",
  );
}

function convertPropertyListToJson(plist: Buffer): Promise<Buffer> {
  return collectSpawnedChild(
    spawnSanitizedChild("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      "-",
    ]),
    "/usr/bin/plutil",
    plist,
  );
}

async function readDiskUtilityInfo(
  path: string,
): Promise<Record<string, unknown>> {
  const plist = await readDiskUtilityPlist(path);
  const json = await convertPropertyListToJson(plist);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.toString("utf8"));
  } catch {
    fail("macOS volume inspection returned invalid JSON");
  }
  if (!isRecord(parsed)) fail("macOS volume inspection returned no object");
  return parsed;
}

function wholeDiskIdentity(value: string): string {
  const normalized = value.startsWith("/dev/") ? value.slice(5) : value;
  const match = /^(disk[0-9]+)(?:s[0-9]+)*$/u.exec(normalized);
  if (match === null) {
    fail("macOS volume inspection returned an invalid disk identity");
  }
  return match[1]!;
}

function physicalDeviceIdentities(
  info: Record<string, unknown>,
): readonly string[] {
  const physicalStores = info["APFSPhysicalStores"];
  const identities: string[] = [];
  if (Array.isArray(physicalStores)) {
    for (const store of physicalStores) {
      if (!isRecord(store) || typeof store["APFSPhysicalStore"] !== "string") {
        fail("macOS volume inspection returned an invalid APFS physical store");
      }
      identities.push(wholeDiskIdentity(store["APFSPhysicalStore"]));
    }
  }
  if (identities.length === 0) {
    const fallback =
      typeof info["ParentWholeDisk"] === "string"
        ? info["ParentWholeDisk"]
        : info["DeviceIdentifier"];
    if (typeof fallback !== "string") {
      fail("macOS volume inspection returned no physical disk identity");
    }
    identities.push(wholeDiskIdentity(fallback));
  }
  return [...new Set(identities)].sort(bytewiseCompare);
}

function assertExternalPhysicalBackingStore(
  expectedWholeDisk: string,
  info: Record<string, unknown>,
): void {
  const deviceIdentifier = info["DeviceIdentifier"];
  const busProtocol = info["BusProtocol"];
  const virtualOrPhysical = info["VirtualOrPhysical"];
  if (
    typeof deviceIdentifier !== "string" ||
    wholeDiskIdentity(deviceIdentifier) !== expectedWholeDisk ||
    deviceIdentifier.replace(/^\/dev\//, "") !== expectedWholeDisk ||
    info["Internal"] !== false ||
    info["DiskImage"] === true ||
    typeof busProtocol !== "string" ||
    /disk[ -]?image|virtual|loop/i.test(busProtocol) ||
    virtualOrPhysical !== "Physical" ||
    (Array.isArray(info["APFSPhysicalStores"]) &&
      info["APFSPhysicalStores"].length > 0) ||
    typeof info["IOKitSize"] !== "number" ||
    !Number.isSafeInteger(info["IOKitSize"]) ||
    info["IOKitSize"] <= 0
  ) {
    fail(
      `target backing store ${expectedWholeDisk} is not proven external physical media`,
    );
  }
}

export interface MacOsEncryptedVolumeInspectorOptions {
  platform?: string;
  filesystemDeviceId?: (path: string) => string;
  readDiskUtilityInfo?: (
    path: string,
  ) => Promise<Record<string, unknown>>;
}

/** macOS-only verifier. Unknown plist shapes fail closed. */
export class MacOsEncryptedVolumeInspector implements IndependentCopyPlatformInspector {
  private readonly platform: string;
  private readonly filesystemDeviceId: (path: string) => string;
  private readonly diskUtilityInfo: (
    path: string,
  ) => Promise<Record<string, unknown>>;

  constructor(options: MacOsEncryptedVolumeInspectorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.filesystemDeviceId =
      options.filesystemDeviceId ?? ((path) => String(lstatSync(path).dev));
    this.diskUtilityInfo = options.readDiskUtilityInfo ?? readDiskUtilityInfo;
  }

  async inspect(input: {
    state_directory: string;
    target_root: string;
  }): Promise<IndependentCopyTargetInspection> {
    if (this.platform !== "darwin") {
      fail("protected independent copies require the macOS volume inspector");
    }
    const stateDirectory = canonicalLocalPath(
      input.state_directory,
      "state directory",
      true,
    );
    const targetRoot = canonicalLocalPath(
      input.target_root,
      "independent-copy target",
      true,
    );
    const stateDevice = this.filesystemDeviceId(stateDirectory);
    const targetDevice = this.filesystemDeviceId(targetRoot);
    if (stateDevice === targetDevice) {
      fail("independent-copy target is on the state filesystem/device");
    }
    const [stateInfo, parsed] = await Promise.all([
      this.diskUtilityInfo(stateDirectory),
      this.diskUtilityInfo(targetRoot),
    ]);
    const mountPoint = parsed["MountPoint"];
    const volumeId = parsed["VolumeUUID"];
    // `diskutil info -plist` omits `Mounted` for some mounted APFS volumes.
    // A canonical existing MountPoint proves the mount; an explicit false is
    // still rejected.
    const mounted = parsed["Mounted"] !== false;
    const encrypted =
      parsed["Encryption"] === true ||
      parsed["Encrypted"] === true ||
      parsed["FileVault"] === true;
    if (
      typeof mountPoint !== "string" ||
      typeof volumeId !== "string" ||
      mounted !== true ||
      !encrypted ||
      parsed["Internal"] !== false
    ) {
      fail(
        "target is not a mounted encrypted external volume with a stable VolumeUUID",
      );
    }
    const canonicalMountPoint = canonicalLocalPath(
      mountPoint,
      "independent-copy mount point",
      true,
    );
    const statePhysicalDeviceIds = physicalDeviceIdentities(stateInfo);
    const targetPhysicalDeviceIds = physicalDeviceIdentities(parsed);
    const targetBackingStores = await Promise.all(
      targetPhysicalDeviceIds.map((deviceId) =>
        this.diskUtilityInfo(deviceId),
      ),
    );
    targetBackingStores.forEach((info, index) =>
      assertExternalPhysicalBackingStore(targetPhysicalDeviceIds[index]!, info),
    );
    const inspection: IndependentCopyTargetInspection = {
      canonical_root: targetRoot,
      canonical_mount_point: canonicalMountPoint,
      volume_id: volumeId.toLowerCase(),
      state_filesystem_device_id: stateDevice,
      target_filesystem_device_id: targetDevice,
      state_physical_device_ids: statePhysicalDeviceIds,
      target_physical_device_ids: targetPhysicalDeviceIds,
      target_media: "external-physical",
      mounted: true,
      encrypted: true,
      assurance: "platform_verified",
    };
    assertInspection(inspection, stateDirectory, targetRoot);
    return inspection;
  }
}

export class FounderIndependentCopyStore {
  private readonly stateDirectory: string;
  private readonly localRoot: string;
  private readonly intentsDirectory: string;
  private readonly receiptsDirectory: string;
  private readonly targetPath: string;
  private readonly outbox: IndependentCopyOutboxSource;
  private readonly identitySource: FederatedExportIdentitySource;
  private readonly signer: InstallationSigner;
  private readonly inspector: IndependentCopyPlatformInspector;
  private readonly exports: IndependentCopyExportOperations;
  private readonly now: () => string;
  private readonly createExportId: () => FederationId;
  private readonly faultInjector?: (point: IndependentCopyFaultPoint) => void;

  constructor(options: FounderIndependentCopyStoreOptions) {
    this.stateDirectory = canonicalLocalPath(
      options.stateDirectory,
      "state directory",
      true,
    );
    this.localRoot = join(this.stateDirectory, ...LOCAL_DIRECTORY.split("/"));
    this.intentsDirectory = join(this.localRoot, "intents");
    this.receiptsDirectory = join(this.localRoot, "receipts");
    this.targetPath = join(this.localRoot, TARGET_FILENAME);
    this.outbox = options.outbox;
    this.identitySource = options.identitySource;
    this.signer = options.signer;
    this.inspector = options.inspector ?? new MacOsEncryptedVolumeInspector();
    this.exports = options.exportOperations ?? {
      create: createFederatedExportBundle,
      verify: verifyFederatedExportBundle,
    };
    this.now = options.now ?? (() => new Date().toISOString());
    this.createExportId = options.createExportId ?? (() => federationId("exp"));
    this.faultInjector = options.faultInjector;
  }

  private prepareLocalState(): void {
    assertPrivateOwnedDirectory(this.stateDirectory, "state directory");
    const federationRoot = join(this.stateDirectory, "federation");
    ensureDirectory(federationRoot, 0o700);
    ensureDirectory(this.localRoot, 0o700);
    ensureDirectory(this.intentsDirectory, 0o700);
    ensureDirectory(this.receiptsDirectory, 0o700);
    assertPrivateOwnedDirectory(this.localRoot, "independent-copy state");
    assertPrivateOwnedDirectory(
      this.intentsDirectory,
      "independent-copy intents",
    );
    assertPrivateOwnedDirectory(
      this.receiptsDirectory,
      "independent-copy receipts",
    );
    fsyncDirectory(this.receiptsDirectory);
    fsyncDirectory(this.intentsDirectory);
    fsyncDirectory(this.localRoot);
    fsyncDirectory(federationRoot);
    fsyncDirectory(this.stateDirectory);
  }

  private assertPreparedLocalState(): void {
    assertPrivateOwnedDirectory(this.stateDirectory, "state directory");
    assertPrivateOwnedDirectory(this.localRoot, "independent-copy state");
    assertPrivateOwnedDirectory(
      this.intentsDirectory,
      "independent-copy intents",
    );
    assertPrivateOwnedDirectory(
      this.receiptsDirectory,
      "independent-copy receipts",
    );
  }

  private readTargetRecord(): IndependentCopyTargetRecordV1 | undefined {
    if (!pathEntryExists(this.targetPath)) return undefined;
    const target = assertTargetRecord(
      readCanonical(this.targetPath, "independent-copy target record"),
    );
    if (target.state_path_sha256 !== statePathDigest(this.stateDirectory)) {
      fail("independent-copy target belongs to a different state directory");
    }
    return target;
  }

  private async inspectTarget(
    target: IndependentCopyTargetRecordV1,
  ): Promise<IndependentCopyTargetInspection> {
    const targetRoot = canonicalLocalPath(
      target.target_root,
      "independent-copy target",
      true,
    );
    assertDirectory(targetRoot, "independent-copy target");
    assertPrivateOwnedDirectory(targetRoot, "independent-copy target");
    const inspection = await this.inspector.inspect({
      state_directory: this.stateDirectory,
      target_root: targetRoot,
    });
    assertInspection(inspection, this.stateDirectory, targetRoot);
    if (
      targetRoot !== target.target_root ||
      inspection.canonical_mount_point !== target.mount_point ||
      inspection.volume_id !== target.volume_id
    ) {
      fail("independent-copy target path or volume identity changed");
    }
    return inspection;
  }

  async configure(
    targetRootInput: string,
  ): Promise<ConfigureIndependentCopyResult> {
    this.prepareLocalState();
    const targetRoot = canonicalLocalPath(
      targetRootInput,
      "independent-copy target",
      true,
    );
    assertPrivateOwnedDirectory(targetRoot, "independent-copy target");
    assertDisjointPaths(
      this.stateDirectory,
      targetRoot,
      "state directory",
      "independent-copy target",
    );
    const inspection = await this.inspector.inspect({
      state_directory: this.stateDirectory,
      target_root: targetRoot,
    });
    assertInspection(inspection, this.stateDirectory, targetRoot);
    const existing = this.readTargetRecord();
    if (existing !== undefined) {
      if (
        existing.target_root !== targetRoot ||
        existing.mount_point !== inspection.canonical_mount_point ||
        existing.volume_id !== inspection.volume_id
      ) {
        fail("an immutable independent-copy target is already configured");
      }
      await this.inspectTarget(existing);
      this.assertTargetBinding(existing, true);
      return { created: false, target: existing };
    }
    const configuredAt = this.now();
    assertUtcMillisecondTimestamp(
      configuredAt,
      "independent-copy target configured_at",
    );
    const target: IndependentCopyTargetRecordV1 = {
      schema_version: 1,
      kind: "echo-founder-independent-copy-target",
      state_path_sha256: statePathDigest(this.stateDirectory),
      target_root: targetRoot,
      mount_point: inspection.canonical_mount_point,
      volume_id: inspection.volume_id,
      protection: {
        kind: "encrypted-volume",
        assurance: "platform_verified",
      },
      configured_at: configuredAt,
    };
    // This exact read-back marker proves the protected target was writable
    // before the local configuration can make a zero-event cutover ready.
    this.assertTargetBinding(target, true);
    const created = atomicCreate({
      filePath: this.targetPath,
      content: canonicalJson(target),
      mode: 0o600,
    });
    if (!created) {
      const raced = this.readTargetRecord();
      if (raced === undefined || !sameConfiguredTarget(raced, target)) {
        fail("independent-copy target configuration raced with another value");
      }
      return { created: false, target: raced };
    }
    fsyncDirectory(this.localRoot);
    return { created: true, target };
  }

  private async snapshotHeads(): Promise<readonly ChainSnapshot[]> {
    const installationIds = await this.outbox.listInstallationIds();
    const sorted = [...installationIds].sort(bytewiseCompare);
    if (
      new Set(sorted).size !== sorted.length ||
      sorted.some((id, index) => id !== installationIds[index])
    ) {
      fail("outbox installation IDs are duplicated or not deterministic");
    }
    const heads: ChainSnapshot[] = [];
    for (const installationId of sorted) {
      assertFederationId(
        installationId,
        "ins",
        "independent-copy installation",
      );
      const head = await this.outbox.readChainHead(installationId);
      if (
        head === null ||
        head.last_sequence < 1 ||
        head.last_event_hash === null
      ) {
        fail(
          `installation ${installationId} has an invalid non-empty chain head`,
        );
      }
      heads.push({
        installation_id: installationId,
        last_sequence: head.last_sequence,
        head_hash: head.last_event_hash,
      });
    }
    return heads;
  }

  private resolvedOutputRoot(target: IndependentCopyTargetRecordV1): string {
    const stateIdentity = target.state_path_sha256.slice("sha256:".length);
    const relativeRoot = `${TARGET_COPY_DIRECTORY}/${stateIdentity}`;
    return resolveContainedRelativePath(
      target.target_root,
      relativeRoot,
      "independent-copy output root",
    );
  }

  private outputRoot(target: IndependentCopyTargetRecordV1): string {
    const path = this.resolvedOutputRoot(target);
    const managedTargetRoot = join(target.target_root, TARGET_COPY_DIRECTORY);
    ensureDirectory(managedTargetRoot, 0o700);
    assertPrivateOwnedDirectory(
      managedTargetRoot,
      "independent-copy managed target root",
    );
    ensureDirectory(path, 0o700);
    assertPrivateOwnedDirectory(path, "independent-copy output root");
    fsyncDirectory(path);
    fsyncDirectory(managedTargetRoot);
    fsyncDirectory(target.target_root);
    return path;
  }

  private assertTargetBinding(
    target: IndependentCopyTargetRecordV1,
    create: boolean,
  ): void {
    const outputRoot = create
      ? this.outputRoot(target)
      : this.resolvedOutputRoot(target);
    if (!create) {
      assertPrivateOwnedDirectory(
        join(target.target_root, TARGET_COPY_DIRECTORY),
        "independent-copy managed target root",
      );
      assertPrivateOwnedDirectory(outputRoot, "independent-copy output root");
    }
    const binding: IndependentCopyTargetBindingV1 = {
      schema_version: 1,
      kind: "echo-founder-independent-copy-target-binding",
      state_path_sha256: target.state_path_sha256,
      target_configuration_sha256: targetConfigurationDigest(target),
      volume_id: target.volume_id,
    };
    const path = join(outputRoot, TARGET_BINDING_FILENAME);
    const expected = canonicalJson(binding);
    if (!pathEntryExists(path)) {
      if (!create) fail("independent-copy target binding is missing");
      atomicCreate({ filePath: path, content: expected, mode: 0o600 });
    }
    if (
      assertPrivateCanonicalFile(path, "independent-copy target binding") !==
      expected
    ) {
      fail("independent-copy target binding does not match this state root");
    }
  }

  private protectedExportHeads(
    target: IndependentCopyTargetRecordV1,
    organizationId: FederationId,
  ): readonly ProtectedExportSnapshot[] {
    const outputRoot = this.resolvedOutputRoot(target);
    assertPrivateOwnedDirectory(outputRoot, "independent-copy output root");
    this.recoverTargetResidue(target, outputRoot);
    const exports: ProtectedExportSnapshot[] = [];
    for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
      if (entry.name === TARGET_BINDING_FILENAME && entry.isFile()) continue;
      const match = BUNDLE_DIRECTORY_PATTERN.exec(entry.name);
      if (match === null || !entry.isDirectory() || entry.isSymbolicLink()) {
        fail("protected target contains an unexpected copy artifact");
      }
      const installationId = match[1]!;
      const sequence = Number(match[2]!);
      assertFederationId(
        installationId,
        "ins",
        "protected export installation",
      );
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        fail("protected export directory has an invalid sequence");
      }
      const path = join(outputRoot, entry.name);
      const verified = this.exports.verify(path);
      const manifest = verified.manifest;
      if (
        canonicalLocalPath(verified.path, "protected export", true) !== path ||
        manifest.kind !== "echo-federated-export" ||
        manifest.organization_id !== organizationId ||
        manifest.installation_id !== installationId ||
        manifest.sequence.first !== 1 ||
        manifest.sequence.last !== sequence ||
        manifest.sequence.predecessor_hash !== null ||
        manifest.records.count !== sequence ||
        verified.events.length !== sequence
      ) {
        fail("protected target export identity or full-prefix shape is invalid");
      }
      exports.push({
        installation_id: installationId,
        last_sequence: sequence,
        head_hash: manifest.sequence.head_hash,
        path,
        records_bytes: verified.records_bytes,
        export_id: manifest.export_id,
        generated_at: manifest.generated_at,
        signing_identity_manifest_id:
          manifest.signing_identity_manifest_id,
        export_manifest_sha256: sha256Digest(verified.manifest_json),
        records_sha256: manifest.records.sha256,
      });
    }
    exports.sort(
      (left, right) =>
        bytewiseCompare(left.installation_id, right.installation_id) ||
        left.last_sequence - right.last_sequence,
    );
    const latest = new Map<FederationId, ProtectedExportSnapshot>();
    for (const current of exports) {
      const previous = latest.get(current.installation_id);
      if (previous !== undefined) {
        if (previous.last_sequence >= current.last_sequence) {
          fail("protected target contains duplicate or unordered exports");
        }
        if (
          current.records_bytes.length <= previous.records_bytes.length ||
          !current.records_bytes
            .subarray(0, previous.records_bytes.length)
            .equals(previous.records_bytes)
        ) {
          fail("protected target contains a forked export history");
        }
      }
      latest.set(current.installation_id, current);
    }
    return [...latest.values()].sort((left, right) =>
      bytewiseCompare(left.installation_id, right.installation_id),
    );
  }

  private recoverTargetResidue(
    target: IndependentCopyTargetRecordV1,
    outputRoot: string,
  ): void {
    this.removePrivateAtomicResidue(
      this.intentsDirectory,
      LOCAL_INTENT_TEMP_PATTERN,
      "independent-copy intent residue",
    );
    this.removePrivateAtomicResidue(
      this.receiptsDirectory,
      LOCAL_RECEIPT_TEMP_PATTERN,
      "independent-copy receipt residue",
    );
    const targetDigest = canonicalSha256(target);
    const intents = new Map<string, IndependentCopyIntentV1>();
    for (const name of readdirSync(this.intentsDirectory)) {
      const path = join(this.intentsDirectory, name);
      const intent = assertIntent(readCanonical(path, "independent-copy intent"));
      const expectedName = `intent.${headKey({
        installation_id: intent.installation_id,
        last_sequence: intent.sequence.last,
        head_hash: intent.sequence.head_hash,
      })}.v1.json`;
      if (
        name !== expectedName ||
        intent.state_path_sha256 !== target.state_path_sha256 ||
        intent.target_record_sha256 !== targetDigest
      ) {
        fail("independent-copy intent identity is invalid during recovery");
      }
      intents.set(
        `${basename(intent.bundle_relative_path)}\u0000${intent.export_id}`,
        intent,
      );
    }

    let changed = false;
    for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
      const path = join(outputRoot, entry.name);
      if (BINDING_TEMP_PATTERN.test(entry.name)) {
        assertPrivateOwnedRegularFile(path, 0o600, () => {
          fail("independent-copy binding residue is not a private regular file");
        });
        unlinkSync(path);
        changed = true;
        continue;
      }
      const staging = EXPORT_STAGING_PATTERN.exec(entry.name);
      if (staging === null) continue;
      const state = lstatSync(path);
      const currentUid = process.getuid?.();
      const intent = intents.get(`${staging[1]!}\u0000${staging[4]!}`);
      if (
        entry.isSymbolicLink() ||
        !entry.isDirectory() ||
        (state.mode & 0o777) !== 0o700 ||
        currentUid === undefined ||
        state.uid !== currentUid ||
        intent === undefined ||
        intent.installation_id !== staging[2] ||
        intent.sequence.last !== Number(staging[3])
      ) {
        fail("independent-copy staging residue is not tied to its intent");
      }
      rmSync(path, { recursive: true, force: false });
      changed = true;
    }
    if (changed) fsyncDirectory(outputRoot);
  }

  private removePrivateAtomicResidue(
    directory: string,
    pattern: RegExp,
    label: string,
  ): void {
    let changed = false;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!pattern.test(entry.name)) continue;
      const path = join(directory, entry.name);
      assertPrivateOwnedRegularFile(path, 0o600, () => {
        fail(`${label} is not a private regular file`);
      });
      unlinkSync(path);
      changed = true;
    }
    if (changed) fsyncDirectory(directory);
  }

  private assertLocalHeadsDoNotRollback(
    localHeads: readonly ChainSnapshot[],
    protectedHeads: readonly ProtectedExportSnapshot[],
  ): void {
    const local = new Map(
      localHeads.map((head) => [head.installation_id, head]),
    );
    for (const protectedHead of protectedHeads) {
      const localHead = local.get(protectedHead.installation_id);
      if (
        localHead === undefined ||
        localHead.last_sequence < protectedHead.last_sequence
      ) {
        fail(
          `local outbox rolled back behind protected installation ${protectedHead.installation_id}`,
        );
      }
      if (
        localHead.last_sequence === protectedHead.last_sequence &&
        localHead.head_hash !== protectedHead.head_hash
      ) {
        fail(
          `local outbox forked from protected installation ${protectedHead.installation_id}`,
        );
      }
    }
  }

  private async assertLocalHeadsCanExtendProtectedHistory(
    localHeads: readonly ChainSnapshot[],
    protectedHeads: readonly ProtectedExportSnapshot[],
  ): Promise<void> {
    this.assertLocalHeadsDoNotRollback(localHeads, protectedHeads);
    const local = new Map(
      localHeads.map((head) => [head.installation_id, head]),
    );
    for (const protectedHead of protectedHeads) {
      const localHead = local.get(protectedHead.installation_id)!;
      if (localHead.last_sequence === protectedHead.last_sequence) continue;
      const prefix = await this.outbox.readSequenceRange(
        protectedHead.installation_id,
        1,
        protectedHead.last_sequence,
      );
      const prefixBytes = Buffer.concat(
        prefix.map((event) =>
          Buffer.concat([event.envelope_bytes, Buffer.from("\n")]),
        ),
      );
      if (
        prefix.length !== protectedHead.last_sequence ||
        prefix[0]?.sequence !== 1 ||
        prefix.at(-1)?.sequence !== protectedHead.last_sequence ||
        prefix.at(-1)?.event_hash !== protectedHead.head_hash ||
        !prefixBytes.equals(protectedHead.records_bytes)
      ) {
        fail(
          `local outbox forked before protected installation ${protectedHead.installation_id} head ${protectedHead.last_sequence}`,
        );
      }
    }
  }

  private assertProtectedHeadsMatchLocal(
    localHeads: readonly ChainSnapshot[],
    protectedHeads: readonly ProtectedExportSnapshot[],
  ): void {
    this.assertLocalHeadsDoNotRollback(localHeads, protectedHeads);
    if (
      localHeads.length !== protectedHeads.length ||
      localHeads.some((head, index) => {
        const protectedHead = protectedHeads[index];
        return (
          protectedHead === undefined ||
          head.installation_id !== protectedHead.installation_id ||
          head.last_sequence !== protectedHead.last_sequence ||
          head.head_hash !== protectedHead.head_hash
        );
      })
    ) {
      fail("protected target does not match every current local outbox head");
    }
  }

  private intentPath(head: ChainSnapshot): string {
    return join(this.intentsDirectory, `intent.${headKey(head)}.v1.json`);
  }

  private receiptPath(head: ChainSnapshot): string {
    return join(this.receiptsDirectory, `receipt.${headKey(head)}.v1.json`);
  }

  private readIntent(head: ChainSnapshot): IndependentCopyIntentV1 | undefined {
    const path = this.intentPath(head);
    if (!pathEntryExists(path)) return undefined;
    return assertIntent(readCanonical(path, "independent-copy intent"));
  }

  private readReceipt(
    head: ChainSnapshot,
  ): IndependentCopyReceiptV1 | undefined {
    const path = this.receiptPath(head);
    if (!pathEntryExists(path)) return undefined;
    return assertReceipt(readCanonical(path, "independent-copy receipt"));
  }

  private createOrRead<T>(
    path: string,
    value: T,
    read: () => T | undefined,
    missing: string,
  ): T {
    const created = atomicCreate({
      filePath: path,
      content: canonicalJson(value),
      mode: 0o600,
    });
    const durable = created ? value : read();
    if (durable === undefined) fail(missing);
    return durable;
  }

  private expectedBundleRelativePath(
    target: IndependentCopyTargetRecordV1,
    head: ChainSnapshot,
  ): string {
    const outputRoot = this.resolvedOutputRoot(target);
    const bundlePath = join(outputRoot, bundleDirectoryName(head));
    const relativePath = relative(target.target_root, bundlePath)
      .split(sep)
      .join("/");
    assertSafeRelativePath(relativePath, "independent-copy bundle path");
    return relativePath;
  }

  private assertIntentMatches(
    intent: IndependentCopyIntentV1,
    target: IndependentCopyTargetRecordV1,
    targetDigest: Sha256Digest,
    head: ChainSnapshot,
    organizationId: FederationId,
  ): void {
    if (
      intent.state_path_sha256 !== target.state_path_sha256 ||
      intent.target_record_sha256 !== targetDigest ||
      intent.organization_id !== organizationId ||
      intent.installation_id !== head.installation_id ||
      intent.sequence.first !== 1 ||
      intent.sequence.last !== head.last_sequence ||
      intent.sequence.head_hash !== head.head_hash ||
      intent.bundle_relative_path !==
        this.expectedBundleRelativePath(target, head)
    ) {
      fail("independent-copy intent does not match its chain head and target");
    }
  }

  private verifiedReceipt(
    target: IndependentCopyTargetRecordV1,
    targetDigest: Sha256Digest,
    head: ChainSnapshot,
    intent: IndependentCopyIntentV1,
    receipt: IndependentCopyReceiptV1,
  ): IndependentCopyReceiptV1 {
    const intentDigest = canonicalSha256(intent);
    if (
      receipt.intent_sha256 !== intentDigest ||
      receipt.target_record_sha256 !== targetDigest ||
      receipt.organization_id !== intent.organization_id ||
      receipt.installation_id !== head.installation_id ||
      receipt.sequence.first !== 1 ||
      receipt.sequence.last !== head.last_sequence ||
      receipt.sequence.head_hash !== head.head_hash ||
      receipt.export_id !== intent.export_id ||
      receipt.bundle_relative_path !== intent.bundle_relative_path
    ) {
      fail("independent-copy receipt does not match its immutable intent");
    }
    const bundlePath = resolveContainedRelativePath(
      target.target_root,
      receipt.bundle_relative_path,
      "independent-copy bundle path",
    );
    if (!pathIsWithin(bundlePath, target.target_root)) {
      fail("independent-copy export escaped the protected target");
    }
    const verified = this.exports.verify(bundlePath);
    const manifest = verified.manifest;
    if (
      canonicalLocalPath(
        verified.path,
        "verified independent-copy export",
        true,
      ) !== bundlePath ||
      manifest.kind !== "echo-federated-export" ||
      manifest.export_id !== intent.export_id ||
      manifest.generated_at !== intent.generated_at ||
      manifest.organization_id !== intent.organization_id ||
      manifest.installation_id !== head.installation_id ||
      manifest.signing_identity_manifest_id !==
        intent.signing_identity_manifest_id ||
      manifest.sequence.first !== 1 ||
      manifest.sequence.last !== head.last_sequence ||
      manifest.sequence.predecessor_hash !== null ||
      manifest.sequence.head_hash !== head.head_hash ||
      manifest.records.count !== head.last_sequence ||
      verified.events.length !== head.last_sequence ||
      receipt.export_manifest_sha256 !== sha256Digest(verified.manifest_json) ||
      receipt.records_sha256 !== manifest.records.sha256
    ) {
      fail(
        "independent-copy export does not exactly cover the local full prefix",
      );
    }
    if (receipt.verified_at < intent.generated_at) {
      fail("independent-copy receipt predates its export intent");
    }
    return receipt;
  }

  private recoverHeadEvidenceFromProtectedExport(
    target: IndependentCopyTargetRecordV1,
    targetDigest: Sha256Digest,
    head: ChainSnapshot,
    organizationId: FederationId,
    protectedExport: ProtectedExportSnapshot,
  ): IndependentCopyReceiptV1 {
    if (
      protectedExport.installation_id !== head.installation_id ||
      protectedExport.last_sequence !== head.last_sequence ||
      protectedExport.head_hash !== head.head_hash
    ) {
      fail("protected export does not match the local head being recovered");
    }
    const bundleRelativePath = this.expectedBundleRelativePath(target, head);
    const expectedBundle = resolveContainedRelativePath(
      target.target_root,
      bundleRelativePath,
      "independent-copy bundle path",
    );
    if (
      canonicalLocalPath(
        protectedExport.path,
        "protected export recovery source",
        true,
      ) !== expectedBundle
    ) {
      fail("protected export recovery source is not the exact head bundle");
    }
    const intent: IndependentCopyIntentV1 = {
      schema_version: 1,
      kind: "echo-founder-independent-copy-intent",
      state_path_sha256: target.state_path_sha256,
      target_record_sha256: targetDigest,
      organization_id: organizationId,
      installation_id: head.installation_id,
      signing_identity_manifest_id:
        protectedExport.signing_identity_manifest_id,
      sequence: {
        first: 1,
        last: head.last_sequence,
        head_hash: head.head_hash,
      },
      export_id: protectedExport.export_id,
      generated_at: protectedExport.generated_at,
      bundle_relative_path: bundleRelativePath,
    };
    this.assertIntentMatches(
      intent,
      target,
      targetDigest,
      head,
      organizationId,
    );
    const durableIntent = this.createOrRead(
      this.intentPath(head),
      intent,
      () => this.readIntent(head),
      "recovered independent-copy intent conflicts with local evidence",
    );
    if (
      canonicalJson(durableIntent) !== canonicalJson(intent)
    ) {
      fail("recovered independent-copy intent conflicts with local evidence");
    }

    const verifiedAt = this.now();
    assertUtcMillisecondTimestamp(
      verifiedAt,
      "recovered independent-copy receipt verified_at",
    );
    const receipt: IndependentCopyReceiptV1 = {
      schema_version: 1,
      kind: "echo-founder-independent-copy-receipt",
      intent_sha256: canonicalSha256(durableIntent),
      target_record_sha256: targetDigest,
      organization_id: organizationId,
      installation_id: head.installation_id,
      sequence: durableIntent.sequence,
      export_id: protectedExport.export_id,
      bundle_relative_path: bundleRelativePath,
      export_manifest_sha256: protectedExport.export_manifest_sha256,
      records_sha256: protectedExport.records_sha256,
      verified_at: verifiedAt,
    };
    this.verifiedReceipt(
      target,
      targetDigest,
      head,
      durableIntent,
      receipt,
    );
    const durableReceipt = this.createOrRead(
      this.receiptPath(head),
      receipt,
      () => this.readReceipt(head),
      "recovered independent-copy receipt disappeared during commit",
    );
    return this.verifiedReceipt(
      target,
      targetDigest,
      head,
      durableIntent,
      durableReceipt,
    );
  }

  private async ensureHead(
    target: IndependentCopyTargetRecordV1,
    targetDigest: Sha256Digest,
    head: ChainSnapshot,
    organizationId: FederationId,
    protectedExport?: ProtectedExportSnapshot,
  ): Promise<IndependentCopyReceiptV1> {
    let intent = this.readIntent(head);
    const existingReceipt = this.readReceipt(head);
    if (intent !== undefined) {
      this.assertIntentMatches(
        intent,
        target,
        targetDigest,
        head,
        organizationId,
      );
      if (existingReceipt !== undefined) {
        return this.verifiedReceipt(
          target,
          targetDigest,
          head,
          intent,
          existingReceipt,
        );
      }
    } else if (existingReceipt !== undefined) {
      fail("independent-copy receipt exists without its immutable intent");
    }

    if (intent === undefined && protectedExport !== undefined) {
      return this.recoverHeadEvidenceFromProtectedExport(
        target,
        targetDigest,
        head,
        organizationId,
        protectedExport,
      );
    }

    if (intent === undefined) {
      const active = this.identitySource.loadVerifiedActiveManifest();
      if (active.manifest.organization.organization_id !== organizationId) {
        fail("active organization changed while independent copy was prepared");
      }
      const exportId = this.createExportId();
      assertFederationId(exportId, "exp", "independent-copy export_id");
      const generatedAt = this.now();
      assertUtcMillisecondTimestamp(
        generatedAt,
        "independent-copy generated_at",
      );
      intent = {
        schema_version: 1,
        kind: "echo-founder-independent-copy-intent",
        state_path_sha256: target.state_path_sha256,
        target_record_sha256: targetDigest,
        organization_id: active.manifest.organization.organization_id,
        installation_id: head.installation_id,
        signing_identity_manifest_id: active.manifest.manifest_id,
        sequence: {
          first: 1,
          last: head.last_sequence,
          head_hash: head.head_hash,
        },
        export_id: exportId,
        generated_at: generatedAt,
        bundle_relative_path: this.expectedBundleRelativePath(target, head),
      };
      const candidate = intent;
      intent = this.createOrRead(
        this.intentPath(head),
        candidate,
        () => this.readIntent(head),
        "independent-copy intent disappeared",
      );
      if (intent !== candidate) {
        this.assertIntentMatches(
          intent,
          target,
          targetDigest,
          head,
          organizationId,
        );
      }
      this.faultInjector?.("after_intent");
    }

    const outputRoot = this.outputRoot(target);
    const created = await this.exports.create({
      output_root: outputRoot,
      installation_id: intent.installation_id,
      signing_identity_manifest_id: intent.signing_identity_manifest_id,
      first_sequence: 1,
      last_sequence: intent.sequence.last,
      export_id: intent.export_id,
      generated_at: intent.generated_at,
      signer: this.signer,
      outbox: this.outbox,
      identity_source: this.identitySource,
    });
    const expectedBundle = resolveContainedRelativePath(
      target.target_root,
      intent.bundle_relative_path,
      "independent-copy bundle path",
    );
    if (
      canonicalLocalPath(
        created.path,
        "created independent-copy export",
        true,
      ) !== expectedBundle
    ) {
      fail("export creator returned a path outside its exact protected target");
    }
    const verified = this.exports.verify(expectedBundle);
    this.faultInjector?.("after_export_before_receipt");
    const receipt: IndependentCopyReceiptV1 = {
      schema_version: 1,
      kind: "echo-founder-independent-copy-receipt",
      intent_sha256: canonicalSha256(intent),
      target_record_sha256: targetDigest,
      organization_id: intent.organization_id,
      installation_id: intent.installation_id,
      sequence: intent.sequence,
      export_id: intent.export_id,
      bundle_relative_path: intent.bundle_relative_path,
      export_manifest_sha256: sha256Digest(verified.manifest_json),
      records_sha256: verified.manifest.records.sha256,
      verified_at: this.now(),
    };
    assertUtcMillisecondTimestamp(
      receipt.verified_at,
      "independent-copy receipt verified_at",
    );
    this.verifiedReceipt(target, targetDigest, head, intent, receipt);
    const durableReceipt = this.createOrRead(
      this.receiptPath(head),
      receipt,
      () => this.readReceipt(head),
      "independent-copy receipt disappeared during commit",
    );
    return this.verifiedReceipt(
      target,
      targetDigest,
      head,
      intent,
      durableReceipt,
    );
  }

  private async assertReady(): Promise<IndependentCopyReadiness> {
    if (!pathEntryExists(this.localRoot)) {
      fail("no protected independent-copy target is configured");
    }
    this.assertPreparedLocalState();
    const target = this.readTargetRecord();
    if (target === undefined)
      fail("no protected independent-copy target is configured");
    await this.inspectTarget(target);
    this.assertTargetBinding(target, false);
    const targetDigest = canonicalSha256(target);
    const active = this.identitySource.loadVerifiedActiveManifest();
    const organizationId = active.manifest.organization.organization_id;
    const before = await this.snapshotHeads();
    const protectedBefore = this.protectedExportHeads(target, organizationId);
    this.assertProtectedHeadsMatchLocal(before, protectedBefore);
    if (before.length === 0) {
      const after = await this.snapshotHeads();
      if (!sameHeads(before, after)) {
        fail("outbox advanced while independent-copy readiness was checked");
      }
      await this.inspectTarget(target);
      return {
        ok: true,
        detail:
          "protected independent-copy target verified; signed outbox is empty",
        copied_installations: 0,
        copied_events: 0,
      };
    }
    let copiedEvents = 0;
    for (const head of before) {
      const intent = this.readIntent(head);
      const receipt = this.readReceipt(head);
      if (intent === undefined || receipt === undefined) {
        fail(
          `installation ${head.installation_id} head ${head.last_sequence} has no verified independent copy`,
        );
      }
      this.assertIntentMatches(
        intent,
        target,
        targetDigest,
        head,
        organizationId,
      );
      this.verifiedReceipt(target, targetDigest, head, intent, receipt);
      copiedEvents += head.last_sequence;
    }
    const after = await this.snapshotHeads();
    if (!sameHeads(before, after)) {
      fail("outbox advanced while independent-copy readiness was checked");
    }
    await this.inspectTarget(target);
    return {
      ok: true,
      detail: `reverified ${before.length} protected full-prefix export${before.length === 1 ? "" : "s"} covering ${copiedEvents} signed event${copiedEvents === 1 ? "" : "s"}`,
      copied_installations: before.length,
      copied_events: copiedEvents,
    };
  }

  async ensure(): Promise<IndependentCopyReadiness> {
    this.prepareLocalState();
    const target = this.readTargetRecord();
    if (target === undefined)
      fail("no protected independent-copy target is configured");
    await this.inspectTarget(target);
    const targetDigest = canonicalSha256(target);
    const active = this.identitySource.loadVerifiedActiveManifest();
    const organizationId = active.manifest.organization.organization_id;
    const before = await this.snapshotHeads();
    const protectedBefore = this.protectedExportHeads(target, organizationId);
    await this.assertLocalHeadsCanExtendProtectedHistory(
      before,
      protectedBefore,
    );
    const protectedByInstallation = new Map(
      protectedBefore.map((head) => [head.installation_id, head]),
    );
    for (const head of before) {
      const protectedHead = protectedByInstallation.get(head.installation_id);
      await this.ensureHead(
        target,
        targetDigest,
        head,
        organizationId,
        protectedHead !== undefined &&
          protectedHead.last_sequence === head.last_sequence &&
          protectedHead.head_hash === head.head_hash
          ? protectedHead
          : undefined,
      );
    }
    const after = await this.snapshotHeads();
    if (!sameHeads(before, after)) {
      fail(
        "outbox advanced while independent copies were being committed; retry",
      );
    }
    return await this.assertReady();
  }

  async check(): Promise<IndependentCopyReadiness> {
    try {
      return await this.assertReady();
    } catch (error) {
      return {
        ok: false,
        detail: (error as Error).message,
        copied_installations: 0,
        copied_events: 0,
      };
    }
  }
}
