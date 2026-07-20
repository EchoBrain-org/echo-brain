import { join } from "node:path";
import { atomicCreate } from "../../infrastructure/filesystem/atomic-create.js";
import {
  assertDirectory,
  assertDisjointPaths,
  assertPrivateOwnedDirectory,
  canonicalLocalPath,
  fsyncDirectory,
  pathEntryExists,
  pathIsWithin,
  resolveContainedRelativePath,
} from "../secure-local-files.js";
import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
} from "./canonical-json.js";
import type { FederationId, Sha256Digest } from "./contracts.js";
import {
  createFederatedExportBundle,
  verifyFederatedExportBundle,
} from "./export-bundle.js";
import {
  bytewiseCompare,
  type ChainSnapshot,
  type ConfigureIndependentCopyResult,
  failIndependentCopy as fail,
  type FounderIndependentCopyStoreOptions,
  type IndependentCopyExportOperations,
  type IndependentCopyFaultPoint,
  type IndependentCopyIntentV1,
  type IndependentCopyOutboxSource,
  type IndependentCopyPlatformInspector,
  type IndependentCopyReadiness,
  type IndependentCopyReceiptV1,
  type IndependentCopyTargetInspection,
  type IndependentCopyTargetRecordV1,
  LOCAL_DIRECTORY,
  type ProtectedExportSnapshot,
  sameConfiguredTarget,
  sameHeads,
  statePathDigest,
  TARGET_FILENAME,
} from "./independent-copy-documents.js";
import {
  assertLocalHeadsCanExtendProtectedHistory,
  assertProtectedHeadsMatchLocal,
  protectedIndependentCopyExportHeads,
} from "./independent-copy-history.js";
import {
  assertIndependentCopyTargetBinding,
  assertPreparedIndependentCopyLocalState,
  createOrReadIndependentCopyEvidence,
  ensureIndependentCopyOutputRoot,
  expectedIndependentCopyBundleRelativePath,
  independentCopyIntentPath,
  type IndependentCopyLocalPaths,
  independentCopyReceiptPath,
  prepareIndependentCopyLocalState,
  readIndependentCopyIntent,
  readIndependentCopyReceipt,
  readIndependentCopyTargetRecord,
} from "./independent-copy-local-state.js";
import {
  assertIndependentCopyInspection,
  MacOsEncryptedVolumeInspector,
} from "./independent-copy-macos-inspector.js";
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
  federationId,
} from "./identifiers.js";

export type {
  ConfigureIndependentCopyResult,
  FounderIndependentCopyStoreOptions,
  IndependentCopyExportOperations,
  IndependentCopyFaultPoint,
  IndependentCopyOutboxSource,
  IndependentCopyPlatformInspector,
  IndependentCopyReadiness,
  IndependentCopyReceiptV1,
  IndependentCopyTargetInspection,
  IndependentCopyTargetRecordV1,
  MacOsEncryptedVolumeInspectorOptions,
} from "./independent-copy-documents.js";

export { MacOsEncryptedVolumeInspector };

export class FounderIndependentCopyStore {
  private readonly stateDirectory: string;
  private readonly localRoot: string;
  private readonly intentsDirectory: string;
  private readonly receiptsDirectory: string;
  private readonly targetPath: string;
  private readonly outbox: IndependentCopyOutboxSource;
  private readonly identitySource: FounderIndependentCopyStoreOptions["identitySource"];
  private readonly signer: FounderIndependentCopyStoreOptions["signer"];
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

  private paths(): IndependentCopyLocalPaths {
    return {
      stateDirectory: this.stateDirectory,
      localRoot: this.localRoot,
      intentsDirectory: this.intentsDirectory,
      receiptsDirectory: this.receiptsDirectory,
      targetPath: this.targetPath,
    };
  }

  private prepareLocalState(): void {
    prepareIndependentCopyLocalState(this.paths());
  }

  private assertPreparedLocalState(): void {
    assertPreparedIndependentCopyLocalState(this.paths());
  }

  private readTargetRecord(): IndependentCopyTargetRecordV1 | undefined {
    return readIndependentCopyTargetRecord(this.paths());
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
    assertIndependentCopyInspection(
      inspection,
      this.stateDirectory,
      targetRoot,
    );
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
    assertIndependentCopyInspection(
      inspection,
      this.stateDirectory,
      targetRoot,
    );
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

  private outputRoot(target: IndependentCopyTargetRecordV1): string {
    return ensureIndependentCopyOutputRoot(target);
  }

  private assertTargetBinding(
    target: IndependentCopyTargetRecordV1,
    create: boolean,
  ): void {
    assertIndependentCopyTargetBinding(target, create);
  }

  private protectedExportHeads(
    target: IndependentCopyTargetRecordV1,
    organizationId: FederationId,
  ): readonly ProtectedExportSnapshot[] {
    return protectedIndependentCopyExportHeads(
      target,
      organizationId,
      this.paths(),
      this.exports,
    );
  }

  private async assertLocalHeadsCanExtendProtectedHistory(
    localHeads: readonly ChainSnapshot[],
    protectedHeads: readonly ProtectedExportSnapshot[],
  ): Promise<void> {
    await assertLocalHeadsCanExtendProtectedHistory(
      this.outbox,
      localHeads,
      protectedHeads,
    );
  }

  private assertProtectedHeadsMatchLocal(
    localHeads: readonly ChainSnapshot[],
    protectedHeads: readonly ProtectedExportSnapshot[],
  ): void {
    assertProtectedHeadsMatchLocal(localHeads, protectedHeads);
  }

  private intentPath(head: ChainSnapshot): string {
    return independentCopyIntentPath(this.paths(), head);
  }

  private receiptPath(head: ChainSnapshot): string {
    return independentCopyReceiptPath(this.paths(), head);
  }

  private readIntent(head: ChainSnapshot): IndependentCopyIntentV1 | undefined {
    return readIndependentCopyIntent(this.paths(), head);
  }

  private readReceipt(
    head: ChainSnapshot,
  ): IndependentCopyReceiptV1 | undefined {
    return readIndependentCopyReceipt(this.paths(), head);
  }

  private createOrRead<T>(
    path: string,
    value: T,
    read: () => T | undefined,
    missing: string,
  ): T {
    return createOrReadIndependentCopyEvidence(path, value, read, missing);
  }

  private expectedBundleRelativePath(
    target: IndependentCopyTargetRecordV1,
    head: ChainSnapshot,
  ): string {
    return expectedIndependentCopyBundleRelativePath(target, head);
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
    if (canonicalJson(durableIntent) !== canonicalJson(intent)) {
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
    this.verifiedReceipt(target, targetDigest, head, durableIntent, receipt);
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
