import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FounderIndependentCopyStore,
  MacOsEncryptedVolumeInspector,
  type FounderIndependentCopyStoreOptions,
  type IndependentCopyExportOperations,
  type IndependentCopyOutboxSource,
  type IndependentCopyPlatformInspector,
  type IndependentCopyTargetInspection,
} from "../../src/product/federation/independent-copy-store.js";
import {
  canonicalJson,
  sha256Digest,
} from "../../src/product/federation/canonical-json.js";
import type {
  CreatedFederatedExportBundle,
  FederatedExportIdentitySource,
  VerifiedFederatedExportBundle,
} from "../../src/product/federation/export-bundle.js";
import type {
  FederatedExportManifestV1,
  FederationId,
  Sha256Digest,
} from "../../src/product/federation/contracts.js";
import type { InstallationSigner } from "../../src/product/federation/installation-signer.js";
import type {
  FederatedChainHead,
  StoredFederatedOutboxEvent,
} from "../../src/product/federation/outbox-store.js";

const NOW = "2026-07-19T20:00:00.000Z";
const ORG_ID = "org_11111111-1111-4111-8111-111111111111";
const ACTIVE_INSTALLATION_ID = "ins_22222222-2222-4222-8222-222222222222";
const SECOND_INSTALLATION_ID = "ins_33333333-3333-4333-8333-333333333333";
const MANIFEST_ID = "idm_44444444-4444-4444-8444-444444444444";
const EXPORT_IDS = [
  "exp_55555555-5555-4555-8555-555555555555",
  "exp_66666666-6666-4666-8666-666666666666",
  "exp_77777777-7777-4777-8777-777777777777",
] as const;

function digest(character: string): Sha256Digest {
  return `sha256:${character.repeat(64)}`;
}

class FakeInspector implements IndependentCopyPlatformInspector {
  volumeId = "volume-echo-backup";
  stateDeviceId = "state-device";
  targetDeviceId = "target-device";
  statePhysicalDeviceIds = ["disk0"];
  targetPhysicalDeviceIds = ["disk4"];
  encrypted = true;
  mounted = true;
  calls = 0;

  async inspect(input: {
    state_directory: string;
    target_root: string;
  }): Promise<IndependentCopyTargetInspection> {
    this.calls += 1;
    return {
      canonical_root: input.target_root,
      canonical_mount_point: input.target_root,
      volume_id: this.volumeId,
      state_filesystem_device_id: this.stateDeviceId,
      target_filesystem_device_id: this.targetDeviceId,
      state_physical_device_ids: this.statePhysicalDeviceIds,
      target_physical_device_ids: this.targetPhysicalDeviceIds,
      target_media: "external-physical",
      mounted: this.mounted as true,
      encrypted: this.encrypted as true,
      assurance: "platform_verified",
    };
  }
}

class FakeOutbox implements IndependentCopyOutboxSource {
  readonly heads = new Map<FederationId, FederatedChainHead>();
  readonly eventHashes = new Map<
    FederationId,
    Map<number, Sha256Digest>
  >();
  readonly recordTags = new Map<FederationId, string>();

  setHead(
    installationId: FederationId,
    lastSequence: number,
    headHash: Sha256Digest,
  ): void {
    const hashes = this.eventHashes.get(installationId) ?? new Map();
    hashes.set(lastSequence, headHash);
    this.eventHashes.set(installationId, hashes);
    this.heads.set(installationId, {
      installation_id: installationId,
      last_sequence: lastSequence,
      last_event_hash: headHash,
      updated_at: NOW,
    });
  }

  async listInstallationIds(): Promise<readonly FederationId[]> {
    return [...this.heads.keys()].sort((left, right) =>
      Buffer.from(left).compare(Buffer.from(right)),
    );
  }

  async readChainHead(
    installationId: FederationId,
  ): Promise<FederatedChainHead | null> {
    return this.heads.get(installationId) ?? null;
  }

  setRecordTag(installationId: FederationId, tag: string): void {
    this.recordTags.set(installationId, tag);
  }

  recordBytes(installationId: FederationId, sequence: number): Buffer {
    const tag = this.recordTags.get(installationId);
    return Buffer.from(
      JSON.stringify({
        sequence,
        ...(tag === undefined ? {} : { tag }),
      }),
    );
  }

  async readSequenceRange(
    installationId: FederationId,
    firstSequence: number,
    lastSequence: number,
  ): Promise<readonly StoredFederatedOutboxEvent[]> {
    const head = this.heads.get(installationId);
    if (head === undefined || lastSequence > head.last_sequence) return [];
    return Array.from(
      { length: lastSequence - firstSequence + 1 },
      (_, index) => {
        const sequence = firstSequence + index;
        return {
          sequence,
          event_hash:
            this.eventHashes.get(installationId)?.get(sequence) ??
            digest(String(sequence % 10)),
          envelope_bytes: this.recordBytes(installationId, sequence),
        } as StoredFederatedOutboxEvent;
      },
    );
  }

  async verifyInstallationChain(): Promise<never> {
    throw new Error("fake exporter must not call the real outbox verifier");
  }
}

class FakeExports implements IndependentCopyExportOperations {
  readonly bundles = new Map<string, VerifiedFederatedExportBundle>();
  readonly requests: {
    export_id: FederationId;
    generated_at: string;
    installation_id: FederationId;
    last_sequence: number;
  }[] = [];
  readonly writes: string[] = [];
  readonly broken = new Set<string>();

  constructor(private readonly outbox: FakeOutbox) {}

  async create(
    request: Parameters<IndependentCopyExportOperations["create"]>[0],
  ): Promise<CreatedFederatedExportBundle> {
    this.requests.push({
      export_id: request.export_id,
      generated_at: request.generated_at,
      installation_id: request.installation_id,
      last_sequence: request.last_sequence,
    });
    const path = join(
      request.output_root,
      `echo-org-export-${request.installation_id}-1-${request.last_sequence}`,
    );
    const existing = this.bundles.get(path);
    if (existing !== undefined) {
      if (
        existing.manifest.export_id !== request.export_id ||
        existing.manifest.generated_at !== request.generated_at
      ) {
        throw new Error("fake export already exists with different bytes");
      }
      return {
        created: false,
        path,
        manifest: existing.manifest,
        manifest_json: existing.manifest_json,
        records_bytes: existing.records_bytes,
        events: existing.events,
      };
    }
    const head = await this.outbox.readChainHead(request.installation_id);
    if (
      head === null ||
      head.last_sequence !== request.last_sequence ||
      head.last_event_hash === null
    ) {
      throw new Error("fake export request does not match its outbox head");
    }
    mkdirSync(path, { mode: 0o700 });
    const recordsBytes = Buffer.concat(
      Array.from({ length: request.last_sequence }, (_, index) =>
        Buffer.concat([
          this.outbox.recordBytes(request.installation_id, index + 1),
          Buffer.from("\n"),
        ]),
      ),
    );
    const manifest: FederatedExportManifestV1 = {
      schema_version: 1,
      kind: "echo-federated-export",
      export_id: request.export_id,
      organization_id: ORG_ID,
      installation_id: request.installation_id,
      key_id: digest("8"),
      signing_identity_manifest_id: request.signing_identity_manifest_id,
      artifacts: [],
      sequence: {
        first: 1,
        last: request.last_sequence,
        predecessor_hash: null,
        head_hash: head.last_event_hash,
      },
      records: {
        path: "records.v1.jsonl",
        count: request.last_sequence,
        sha256: sha256Digest(recordsBytes),
      },
      generated_at: request.generated_at,
      integrity: {
        canonicalization: "RFC8785",
        payload_sha256: digest("9"),
        signature_algorithm: "ecdsa-p256-sha256-der-low-s",
        key_id: digest("8"),
        signature_base64: "AA==",
      },
    };
    const verified = {
      path,
      manifest,
      manifest_json: canonicalJson(manifest),
      records_bytes: recordsBytes,
      events: Array.from({ length: request.last_sequence }, () => ({})),
      event_hashes: [],
      identity_manifests: new Map(),
      publication_policies: new Map(),
    } as unknown as VerifiedFederatedExportBundle;
    this.bundles.set(path, verified);
    this.writes.push(path);
    return {
      created: true,
      path,
      manifest,
      manifest_json: verified.manifest_json,
      records_bytes: recordsBytes,
      events: verified.events,
    };
  }

  verify(path: string): VerifiedFederatedExportBundle {
    if (this.broken.has(path)) throw new Error("fake export is corrupted");
    const value = this.bundles.get(path);
    if (value === undefined) throw new Error("fake export is missing");
    return value;
  }
}

const identitySource = {
  loadVerifiedActiveManifest: () => ({
    manifest: {
      manifest_id: MANIFEST_ID,
      organization: { organization_id: ORG_ID },
      installation: { installation_id: ACTIVE_INSTALLATION_ID },
    },
    canonical: "{}",
    sha256: digest("a"),
  }),
  loadVerifiedManifest: () => {
    throw new Error("unused");
  },
  loadVerifiedManifestBySha256: () => {
    throw new Error("unused");
  },
  loadVerifiedPolicy: () => {
    throw new Error("unused");
  },
} as unknown as FederatedExportIdentitySource;

const signer = {} as InstallationSigner;
const temporaryRoots: string[] = [];

function privateDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(directory, 0o700);
  const canonical = realpathSync(directory);
  temporaryRoots.push(canonical);
  return canonical;
}

function fixture(
  overrides: {
    faultInjector?: FounderIndependentCopyStoreOptions["faultInjector"];
    createExportId?: FounderIndependentCopyStoreOptions["createExportId"];
  } = {},
) {
  const root = privateDirectory("echo-independent-copy-test-");
  const stateDirectory = join(root, "state");
  const targetRoot = join(root, "target");
  mkdirSync(stateDirectory, { mode: 0o700 });
  mkdirSync(targetRoot, { mode: 0o700 });
  const inspector = new FakeInspector();
  const outbox = new FakeOutbox();
  const exports = new FakeExports(outbox);
  let exportIndex = 0;
  const options: FounderIndependentCopyStoreOptions = {
    stateDirectory,
    outbox,
    identitySource,
    signer,
    inspector,
    exportOperations: exports,
    now: () => NOW,
    createExportId:
      overrides.createExportId ??
      (() => EXPORT_IDS[exportIndex++] as FederationId),
    ...(overrides.faultInjector === undefined
      ? {}
      : { faultInjector: overrides.faultInjector }),
  };
  return {
    root,
    stateDirectory,
    targetRoot,
    inspector,
    outbox,
    exports,
    options,
    store: new FounderIndependentCopyStore(options),
  };
}

function onlyFile(directory: string): string {
  const names = readdirSync(directory);
  expect(names).toHaveLength(1);
  return join(directory, names[0]!);
}

afterEach(() => {
  vi.restoreAllMocks();
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("FounderIndependentCopyStore", () => {
  it("stays read-only and red before a protected target is configured", async () => {
    const test = fixture();

    await expect(test.store.check()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining(
        "no protected independent-copy target is configured",
      ),
    });
    expect(
      readdirSync(test.stateDirectory, { withFileTypes: true }).map(
        (entry) => entry.name,
      ),
    ).toEqual([]);
  });

  it("persists one private target and treats a verified empty outbox as ready", async () => {
    const test = fixture();

    const first = await test.store.configure(test.targetRoot);
    const second = await test.store.configure(test.targetRoot);
    const readiness = await test.store.check();

    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, target: first.target });
    expect(readiness).toEqual({
      ok: true,
      detail:
        "protected independent-copy target verified; signed outbox is empty",
      copied_installations: 0,
      copied_events: 0,
    });
    const targetPath = join(
      test.stateDirectory,
      "federation",
      "independent-copy",
      "target.v1.json",
    );
    expect(statSync(targetPath).mode & 0o777).toBe(0o600);
    expect(canonicalJson(JSON.parse(readFileSync(targetPath, "utf8")))).toBe(
      readFileSync(targetPath, "utf8"),
    );
    const targetRecord = JSON.parse(readFileSync(targetPath, "utf8")) as {
      state_path_sha256: string;
    };
    const bindingPath = join(
      test.targetRoot,
      "echo-brain-independent-copies",
      targetRecord.state_path_sha256.slice("sha256:".length),
      "target-binding.v1.json",
    );
    expect(statSync(bindingPath).mode & 0o777).toBe(0o600);
    const bindingResidue = `${bindingPath}.123.12345678-1234-4123-8123-123456789abc.tmp`;
    writeFileSync(bindingResidue, "partial", { mode: 0o600 });
    await expect(test.store.check()).resolves.toMatchObject({ ok: true });
    expect(existsSync(bindingResidue)).toBe(false);
    rmSync(bindingPath);
    await expect(test.store.check()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("target binding is missing"),
    });
  });

  it("fails closed when the inspector cannot prove another encrypted device", async () => {
    const test = fixture();
    const nestedTarget = join(test.stateDirectory, "nested-target");
    mkdirSync(nestedTarget, { mode: 0o700 });
    await expect(test.store.configure(nestedTarget)).rejects.toThrow(
      /must be disjoint/,
    );

    test.inspector.targetDeviceId = test.inspector.stateDeviceId;
    await expect(test.store.configure(test.targetRoot)).rejects.toThrow(
      /different filesystem\/device/,
    );

    test.inspector.targetDeviceId = "target-device";
    test.inspector.targetPhysicalDeviceIds = ["disk0"];
    await expect(test.store.configure(test.targetRoot)).rejects.toThrow(
      /different physical storage device/,
    );

    test.inspector.targetPhysicalDeviceIds = ["disk4"];
    test.inspector.encrypted = false;
    await expect(test.store.configure(test.targetRoot)).rejects.toThrow(
      /mounted encrypted target/,
    );
  });

  it("creates and reverifies an exact full-prefix export before reporting ready", async () => {
    const test = fixture();
    await test.store.configure(test.targetRoot);
    test.outbox.setHead(ACTIVE_INSTALLATION_ID, 2, digest("b"));

    const ensured = await test.store.ensure();
    const repeated = await test.store.ensure();

    expect(ensured).toMatchObject({
      ok: true,
      copied_installations: 1,
      copied_events: 2,
    });
    expect(repeated.ok).toBe(true);
    expect(test.exports.writes).toHaveLength(1);
    expect(test.exports.requests).toHaveLength(1);
    expect(test.exports.requests[0]).toEqual({
      export_id: EXPORT_IDS[0],
      generated_at: NOW,
      installation_id: ACTIVE_INSTALLATION_ID,
      last_sequence: 2,
    });
    expect(test.exports.writes[0]!.startsWith(`${test.targetRoot}/`)).toBe(
      true,
    );
    const receipts = join(
      test.stateDirectory,
      "federation",
      "independent-copy",
      "receipts",
    );
    expect(statSync(onlyFile(receipts)).mode & 0o777).toBe(0o600);
  });

  it("reuses the exact intent after a crash before export creation", async () => {
    let faulted = false;
    const test = fixture({
      faultInjector: (point) => {
        if (point === "after_intent" && !faulted) {
          faulted = true;
          throw new Error("simulated intent crash");
        }
      },
    });
    await test.store.configure(test.targetRoot);
    test.outbox.setHead(ACTIVE_INSTALLATION_ID, 1, digest("c"));

    await expect(test.store.ensure()).rejects.toThrow(/simulated intent crash/);
    expect(test.exports.requests).toHaveLength(0);
    const intentsDirectory = join(
      test.stateDirectory,
      "federation",
      "independent-copy",
      "intents",
    );
    const intentPath = onlyFile(intentsDirectory);
    const intent = JSON.parse(readFileSync(intentPath, "utf8")) as {
      export_id: string;
      bundle_relative_path: string;
    };
    const stagingPath = join(
      test.targetRoot,
      dirname(intent.bundle_relative_path),
      `.${basename(intent.bundle_relative_path)}.${intent.export_id}.staging-ABC123`,
    );
    mkdirSync(stagingPath, { mode: 0o700 });
    writeFileSync(join(stagingPath, "partial"), "partial", { mode: 0o600 });
    const intentResidue = `${intentPath}.123.12345678-1234-4123-8123-123456789abc.tmp`;
    writeFileSync(intentResidue, "partial", { mode: 0o600 });
    const retry = new FounderIndependentCopyStore({
      ...test.options,
      faultInjector: undefined,
      createExportId: () => {
        throw new Error("retry must not allocate another export ID");
      },
    });
    await expect(retry.ensure()).resolves.toMatchObject({ ok: true });
    expect(existsSync(stagingPath)).toBe(false);
    expect(existsSync(intentResidue)).toBe(false);
    expect(test.exports.requests[0]!.export_id).toBe(EXPORT_IDS[0]);
  });

  it("reuses exact export bytes after a crash before the receipt commit", async () => {
    let faulted = false;
    const test = fixture({
      faultInjector: (point) => {
        if (point === "after_export_before_receipt" && !faulted) {
          faulted = true;
          throw new Error("simulated receipt crash");
        }
      },
    });
    await test.store.configure(test.targetRoot);
    test.outbox.setHead(ACTIVE_INSTALLATION_ID, 1, digest("d"));

    await expect(test.store.ensure()).rejects.toThrow(
      /simulated receipt crash/,
    );
    expect(test.exports.writes).toHaveLength(1);
    const firstRequest = test.exports.requests[0]!;
    const retry = new FounderIndependentCopyStore({
      ...test.options,
      faultInjector: undefined,
      createExportId: () => {
        throw new Error("retry must reuse its persisted intent");
      },
    });
    await expect(retry.ensure()).resolves.toMatchObject({ ok: true });
    expect(test.exports.writes).toHaveLength(1);
    expect(test.exports.requests).toHaveLength(2);
    expect(test.exports.requests[1]).toEqual(firstRequest);
  });

  it("reconstructs local evidence when a restored backup forgot an already protected head", async () => {
    const test = fixture();
    await test.store.configure(test.targetRoot);
    test.outbox.setHead(ACTIVE_INSTALLATION_ID, 2, digest("7"));
    await test.store.ensure();

    const localRoot = join(
      test.stateDirectory,
      "federation",
      "independent-copy",
    );
    for (const directory of ["intents", "receipts"]) {
      const path = join(localRoot, directory);
      for (const file of readdirSync(path)) rmSync(join(path, file));
    }
    const requestsBeforeRecovery = test.exports.requests.length;
    const writesBeforeRecovery = test.exports.writes.length;
    const restored = new FounderIndependentCopyStore({
      ...test.options,
      createExportId: () => {
        throw new Error("recovery must reuse the protected export identity");
      },
    });

    await expect(restored.ensure()).resolves.toMatchObject({
      ok: true,
      copied_installations: 1,
      copied_events: 2,
    });
    expect(test.exports.requests).toHaveLength(requestsBeforeRecovery);
    expect(test.exports.writes).toHaveLength(writesBeforeRecovery);
    expect(readdirSync(join(localRoot, "intents"))).toHaveLength(1);
    expect(readdirSync(join(localRoot, "receipts"))).toHaveLength(1);
  });

  it("fails readiness for a stale head, corrupted copy, or changed volume identity", async () => {
    const test = fixture();
    await test.store.configure(test.targetRoot);
    test.outbox.setHead(ACTIVE_INSTALLATION_ID, 1, digest("e"));
    await test.store.ensure();

    test.outbox.setHead(ACTIVE_INSTALLATION_ID, 2, digest("f"));
    await expect(test.store.check()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining(
        "protected target does not match every current local outbox head",
      ),
    });
    await test.store.ensure();
    const latestBundle = test.exports.writes.at(-1)!;
    test.exports.broken.add(latestBundle);
    await expect(test.store.check()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("fake export is corrupted"),
    });
    test.exports.broken.delete(latestBundle);
    test.inspector.volumeId = "different-volume";
    await expect(test.store.check()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("path or volume identity changed"),
    });
  });

  it("rejects a local rollback or fork behind the newest protected export", async () => {
    const test = fixture();
    await test.store.configure(test.targetRoot);
    test.outbox.setHead(ACTIVE_INSTALLATION_ID, 3, digest("4"));
    await test.store.ensure();

    test.outbox.setHead(ACTIVE_INSTALLATION_ID, 1, digest("5"));
    await expect(test.store.check()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("local outbox rolled back"),
    });
    await expect(test.store.ensure()).rejects.toThrow(
      /local outbox rolled back/,
    );

    test.outbox.setHead(ACTIVE_INSTALLATION_ID, 3, digest("6"));
    await expect(test.store.check()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("local outbox forked"),
    });
    await expect(test.store.ensure()).rejects.toThrow(/local outbox forked/);
  });

  it("rejects a longer local fork before mutating protected history", async () => {
    const test = fixture();
    await test.store.configure(test.targetRoot);
    test.outbox.setRecordTag(ACTIVE_INSTALLATION_ID, "protected-prefix");
    test.outbox.setHead(ACTIVE_INSTALLATION_ID, 2, digest("4"));
    await test.store.ensure();
    const writesBeforeFork = test.exports.writes.length;

    test.outbox.setRecordTag(ACTIVE_INSTALLATION_ID, "restored-fork");
    test.outbox.setHead(ACTIVE_INSTALLATION_ID, 3, digest("5"));
    await expect(test.store.ensure()).rejects.toThrow(
      /forked before protected installation/,
    );
    expect(test.exports.writes).toHaveLength(writesBeforeFork);
  });

  it("requires a matching reverified receipt for every installation head", async () => {
    const test = fixture();
    await test.store.configure(test.targetRoot);
    test.outbox.setHead(ACTIVE_INSTALLATION_ID, 2, digest("1"));
    test.outbox.setHead(SECOND_INSTALLATION_ID, 1, digest("2"));
    await expect(test.store.ensure()).resolves.toMatchObject({
      ok: true,
      copied_installations: 2,
      copied_events: 3,
    });

    const receipts = join(
      test.stateDirectory,
      "federation",
      "independent-copy",
      "receipts",
    );
    rmSync(join(receipts, readdirSync(receipts)[0]!));
    await expect(test.store.check()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("has no verified independent copy"),
    });
  });

  it("rejects canonical local intent tampering that tries to escape the target", async () => {
    let faulted = false;
    const test = fixture({
      faultInjector: (point) => {
        if (point === "after_intent" && !faulted) {
          faulted = true;
          throw new Error("pause after intent");
        }
      },
    });
    await test.store.configure(test.targetRoot);
    test.outbox.setHead(ACTIVE_INSTALLATION_ID, 1, digest("3"));
    await expect(test.store.ensure()).rejects.toThrow(/pause after intent/);

    const intents = join(
      test.stateDirectory,
      "federation",
      "independent-copy",
      "intents",
    );
    const path = onlyFile(intents);
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    value["bundle_relative_path"] = "../outside";
    writeFileSync(path, canonicalJson(value), { mode: 0o600 });

    const retry = new FounderIndependentCopyStore({
      ...test.options,
      faultInjector: undefined,
    });
    await expect(retry.ensure()).rejects.toThrow(/safe portable relative path/);
  });
});

describe("MacOsEncryptedVolumeInspector", () => {
  function diskInfoFixture(overrides: {
    targetPhysicalStore?: string;
    targetInternal?: boolean;
    targetEncrypted?: boolean;
    backing?: Record<string, unknown>;
  } = {}) {
    const root = privateDirectory("echo-macos-volume-inspector-");
    const stateDirectory = join(root, "state");
    const targetRoot = join(root, "target");
    mkdirSync(stateDirectory, { mode: 0o700 });
    mkdirSync(targetRoot, { mode: 0o700 });
    const targetPhysicalStore = overrides.targetPhysicalStore ?? "disk4s2";
    const targetWholeDisk = targetPhysicalStore.replace(/s[0-9]+$/, "");
    const values = new Map<string, Record<string, unknown>>([
      [
        stateDirectory,
        {
          DeviceIdentifier: "disk3s1",
          ParentWholeDisk: "disk3",
          Internal: true,
          MountPoint: stateDirectory,
          VolumeUUID: "STATE-VOLUME",
          APFSPhysicalStores: [{ APFSPhysicalStore: "disk0s2" }],
        },
      ],
      [
        targetRoot,
        {
          DeviceIdentifier: `${targetWholeDisk}s1`,
          ParentWholeDisk: targetWholeDisk,
          Internal: overrides.targetInternal ?? false,
          MountPoint: targetRoot,
          VolumeUUID: "TARGET-VOLUME",
          Encryption: overrides.targetEncrypted ?? true,
          APFSPhysicalStores: [
            { APFSPhysicalStore: targetPhysicalStore },
          ],
        },
      ],
      [
        targetWholeDisk,
        overrides.backing ?? {
          DeviceIdentifier: targetWholeDisk,
          ParentWholeDisk: targetWholeDisk,
          Internal: false,
          BusProtocol: "USB",
          VirtualOrPhysical: "Physical",
          IOKitSize: 1_000_000,
        },
      ],
    ]);
    const inspector = new MacOsEncryptedVolumeInspector({
      platform: "darwin",
      filesystemDeviceId: (path) =>
        path === stateDirectory ? "state-device" : "target-device",
      readDiskUtilityInfo: async (path) => {
        const value = values.get(path);
        if (value === undefined) throw new Error(`missing disk fixture ${path}`);
        return value;
      },
    });
    return { inspector, stateDirectory, targetRoot };
  }

  it("proves an encrypted external APFS volume with Mounted omitted", async () => {
    const test = diskInfoFixture();

    await expect(
      test.inspector.inspect({
        state_directory: test.stateDirectory,
        target_root: test.targetRoot,
      }),
    ).resolves.toMatchObject({
      mounted: true,
      encrypted: true,
      target_media: "external-physical",
      state_physical_device_ids: ["disk0"],
      target_physical_device_ids: ["disk4"],
    });
  });

  it("rejects same-disk APFS volumes, internal media, and disk images", async () => {
    const sameDisk = diskInfoFixture({
      targetPhysicalStore: "disk0s3",
      backing: {
        DeviceIdentifier: "disk0",
        ParentWholeDisk: "disk0",
        Internal: false,
        BusProtocol: "USB",
        VirtualOrPhysical: "Physical",
        IOKitSize: 1_000_000,
      },
    });
    await expect(
      sameDisk.inspector.inspect({
        state_directory: sameDisk.stateDirectory,
        target_root: sameDisk.targetRoot,
      }),
    ).rejects.toThrow(/different physical storage device/);

    const internal = diskInfoFixture({ targetInternal: true });
    await expect(
      internal.inspector.inspect({
        state_directory: internal.stateDirectory,
        target_root: internal.targetRoot,
      }),
    ).rejects.toThrow(/mounted encrypted external volume/);

    const diskImage = diskInfoFixture({
      targetPhysicalStore: "disk8s1",
      backing: {
        DeviceIdentifier: "disk8",
        ParentWholeDisk: "disk8",
        Internal: false,
        BusProtocol: "Disk Image",
        VirtualOrPhysical: "Virtual",
        DiskImage: true,
        IOKitSize: 1_000_000,
      },
    });
    await expect(
      diskImage.inspector.inspect({
        state_directory: diskImage.stateDirectory,
        target_root: diskImage.targetRoot,
      }),
    ).rejects.toThrow(/not proven external physical media/);

    const unknownMedia = diskInfoFixture({
      targetPhysicalStore: "disk9s1",
      backing: {
        DeviceIdentifier: "disk9",
        ParentWholeDisk: "disk9",
        Internal: false,
        BusProtocol: "USB",
        VirtualOrPhysical: "Unknown",
        IOKitSize: 1_000_000,
      },
    });
    await expect(
      unknownMedia.inspector.inspect({
        state_directory: unknownMedia.stateDirectory,
        target_root: unknownMedia.targetRoot,
      }),
    ).rejects.toThrow(/not proven external physical media/);
  });
});
