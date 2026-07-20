import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  assertPrivateOwnedDirectory,
  ensureDirectory,
  fsyncDirectory,
  fsyncDirectoryTree,
  pathEntryExists,
  writeFileExclusive,
} from '../secure-local-files.js';
import { canonicalJson, sha256Digest } from './foundation/canonical-json.js';
import type {
  FederatedExportManifestV1,
  Sha256Digest,
} from './contracts.js';
import {
  assertVerifiedIdentityMaterial,
  type CreateFederatedExportBundleRequest,
  type CreatedFederatedExportBundle,
  type ExportArtifact,
  EXPORT_MANIFEST_FILENAME,
  IDENTITY_DIRECTORY,
  loadExportArtifacts,
  POLICY_DIRECTORY,
  publicKeyForManifest,
  RECORDS_FILENAME,
  type VerifiedFederatedExportBundle,
} from './export/export-bundle-material.js';
import {
  assertApprovalGroups,
  verifyFederatedExportBundleInternal,
} from './export/export-bundle-verification.js';
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
} from './foundation/identifiers.js';
import { verifyInstallationKeyDescriptor } from './foundation/installation-signer.js';
import type {
  StoredFederatedOutboxEvent,
  VerifiedFederatedChain,
} from './outbox-store.js';
import {
  assertFederationDocumentSize,
  validateFederationDocument,
} from './schema-validation.js';
import {
  createSignedDocument,
  signedPayload,
  verifySignedDocument,
} from './foundation/signed-document.js';

export type {
  CreateFederatedExportBundleRequest,
  CreatedFederatedExportBundle,
  FederatedExportIdentitySource,
  FederatedExportOutboxSource,
  VerifiedFederatedExportBundle,
} from './export/export-bundle-material.js';

export function verifyFederatedExportBundle(
  bundlePath: string,
): VerifiedFederatedExportBundle {
  return verifyFederatedExportBundleInternal(bundlePath);
}

function exactRange(
  chain: VerifiedFederatedChain,
  first: number,
  last: number,
): readonly StoredFederatedOutboxEvent[] {
  const events = chain.events.filter(
    (event) => event.sequence >= first && event.sequence <= last,
  );
  if (
    events.length !== last - first + 1 ||
    events[0]?.sequence !== first ||
    events.at(-1)?.sequence !== last
  ) {
    throw new Error('federated export range is not present contiguously');
  }
  return events;
}

function unsignedManifest(
  request: CreateFederatedExportBundleRequest,
  events: readonly StoredFederatedOutboxEvent[],
  artifacts: readonly ExportArtifact[],
  keyId: Sha256Digest,
): Omit<FederatedExportManifestV1, 'integrity'> {
  const first = events[0]!;
  const last = events.at(-1)!;
  const organizationIds = new Set(
    events.map((event) => event.envelope.organization_id),
  );
  if (organizationIds.size !== 1) {
    throw new Error('federated export range crosses organizations');
  }
  const recordsBytes = Buffer.concat(
    events.map((event) =>
      Buffer.concat([event.envelope_bytes, Buffer.from('\n')]),
    ),
  );
  return {
    schema_version: 1,
    kind: 'echo-federated-export',
    export_id: request.export_id,
    organization_id: first.envelope.organization_id,
    installation_id: request.installation_id,
    key_id: keyId,
    signing_identity_manifest_id: request.signing_identity_manifest_id,
    artifacts: artifacts.map(({ path, kind, sha256 }) => ({
      path,
      kind,
      sha256,
    })),
    sequence: {
      first: request.first_sequence,
      last: request.last_sequence,
      predecessor_hash: first.previous_event_hash,
      head_hash: last.event_hash,
    },
    records: {
      path: RECORDS_FILENAME,
      count: events.length,
      sha256: sha256Digest(recordsBytes),
    },
    generated_at: request.generated_at,
  };
}

function assertRequest(request: CreateFederatedExportBundleRequest): void {
  assertFederationId(request.installation_id, 'ins', 'export installation_id');
  assertFederationId(
    request.signing_identity_manifest_id,
    'idm',
    'export signing_identity_manifest_id',
  );
  assertFederationId(request.export_id, 'exp', 'export_id');
  assertUtcMillisecondTimestamp(request.generated_at, 'export generated_at');
  if (
    !Number.isSafeInteger(request.first_sequence) ||
    !Number.isSafeInteger(request.last_sequence) ||
    request.first_sequence < 1 ||
    request.last_sequence < request.first_sequence
  ) {
    throw new Error('federated export sequence range is invalid');
  }
}

function bundleName(request: CreateFederatedExportBundleRequest): string {
  return `echo-org-export-${request.installation_id}-${request.first_sequence}-${request.last_sequence}`;
}

function sameUnsignedManifest(
  existing: FederatedExportManifestV1,
  expected: Omit<FederatedExportManifestV1, 'integrity'>,
): boolean {
  return canonicalJson(signedPayload(existing)) === canonicalJson(expected);
}

export async function createFederatedExportBundle(
  request: CreateFederatedExportBundleRequest,
): Promise<CreatedFederatedExportBundle> {
  assertRequest(request);
  ensureDirectory(request.output_root, 0o700);
  assertPrivateOwnedDirectory(request.output_root, 'federated export root');

  const signingManifest = request.identity_source.loadVerifiedActiveManifest();
  assertVerifiedIdentityMaterial(signingManifest, 'active signing manifest');
  if (
    signingManifest.manifest.manifest_id !==
    request.signing_identity_manifest_id
  ) {
    throw new Error(
      'export signing_identity_manifest_id is not the verified active identity manifest',
    );
  }
  const signingInstallationId =
    signingManifest.manifest.installation.installation_id;
  const descriptor = await request.signer.inspect(signingInstallationId);
  if (descriptor === null) {
    throw new Error('installation signing key is unavailable');
  }
  if (descriptor.installation_id !== signingInstallationId) {
    throw new Error(
      'installation signing key descriptor belongs to a different installation',
    );
  }
  const publicKey = verifyInstallationKeyDescriptor(descriptor);
  const chain = await request.outbox.verifyInstallationChain(
    request.installation_id,
    (event) => {
      const verified = request.identity_source.loadVerifiedManifestBySha256(
        event.envelope.identity_manifest_sha256,
      );
      if (
        verified.sha256 !== event.envelope.identity_manifest_sha256 ||
        verified.manifest.organization.organization_id !==
          event.envelope.organization_id ||
        verified.manifest.principal.principal_id !==
          event.envelope.producer.principal_id ||
        verified.manifest.membership.membership_id !==
          event.envelope.producer.membership_id ||
        verified.manifest.installation.installation_id !==
          event.envelope.producer.installation_id ||
        verified.manifest.installation.signing_key.key_id !==
          event.envelope.producer.key_id
      ) {
        throw new Error(
          `event ${event.event_id} has an invalid identity-manifest reference`,
        );
      }
      return {
        key_id: verified.manifest.installation.signing_key.key_id,
        public_key_spki_der: publicKeyForManifest(verified.manifest),
      };
    },
  );
  const events = exactRange(
    chain,
    request.first_sequence,
    request.last_sequence,
  );
  if (
    events.some((event) => event.envelope.occurred_at > request.generated_at)
  ) {
    throw new Error('export generated_at precedes an exported event');
  }
  if (events.some((event) => event.created_at > request.generated_at)) {
    throw new Error(
      'export generated_at precedes an exported outbox event creation time',
    );
  }
  assertApprovalGroups(events.map((event) => event.envelope));
  const artifacts = loadExportArtifacts(
    events,
    request.signing_identity_manifest_id,
    request.identity_source,
  );
  if (
    signingManifest.manifest.organization.organization_id !==
      events[0]!.envelope.organization_id ||
    signingManifest.manifest.installation.signing_key.key_id !==
      descriptor.key_id ||
    signingManifest.manifest.created_at > request.generated_at
  ) {
    throw new Error(
      'export signing manifest does not bind the requested signer',
    );
  }
  const recordsBytes = Buffer.concat(
    events.map((event) =>
      Buffer.concat([event.envelope_bytes, Buffer.from('\n')]),
    ),
  );
  const payload = unsignedManifest(
    request,
    events,
    artifacts,
    descriptor.key_id,
  );
  validateFederationDocument<Omit<FederatedExportManifestV1, 'integrity'>>(
    'federated-export',
    {
      ...payload,
      integrity: {
        canonicalization: 'RFC8785',
        payload_sha256: sha256Digest('{}'),
        signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
        key_id: descriptor.key_id,
        signature_base64: 'AA==',
      },
    },
  );

  const finalPath = join(request.output_root, bundleName(request));
  if (pathEntryExists(finalPath)) {
    const verified = verifyFederatedExportBundle(finalPath);
    if (
      !sameUnsignedManifest(verified.manifest, payload) ||
      !verified.records_bytes.equals(recordsBytes)
    ) {
      throw new Error(
        'federated export already exists with different immutable bytes',
      );
    }
    return {
      created: false,
      path: finalPath,
      manifest: verified.manifest,
      manifest_json: verified.manifest_json,
      records_bytes: verified.records_bytes,
      events: verified.events,
    };
  }

  const manifest = await createSignedDocument(
    payload,
    request.signer,
    signingInstallationId,
    descriptor.key_id,
  );
  validateFederationDocument<FederatedExportManifestV1>(
    'federated-export',
    manifest,
  );
  verifySignedDocument(manifest, publicKey, descriptor.key_id);
  const manifestJson = canonicalJson(manifest);
  assertFederationDocumentSize(manifestJson, 'federated export manifest');

  let stagingPath: string | undefined;
  try {
    stagingPath = mkdtempSync(
      join(
        request.output_root,
        `.${bundleName(request)}.${request.export_id}.staging-`,
      ),
    );
    chmodSync(stagingPath, 0o700);
    const identityDirectory = join(stagingPath, IDENTITY_DIRECTORY);
    const policyDirectory = join(stagingPath, POLICY_DIRECTORY);
    mkdirSync(identityDirectory, { mode: 0o700 });
    mkdirSync(policyDirectory, { mode: 0o700 });
    chmodSync(identityDirectory, 0o700);
    chmodSync(policyDirectory, 0o700);

    writeFileExclusive(
      join(stagingPath, EXPORT_MANIFEST_FILENAME),
      manifestJson,
      0o600,
    );
    writeFileExclusive(
      join(stagingPath, RECORDS_FILENAME),
      recordsBytes,
      0o600,
    );
    for (const artifact of artifacts) {
      writeFileExclusive(
        join(stagingPath, artifact.path),
        artifact.canonical,
        0o600,
      );
    }
    const staged = verifyFederatedExportBundle(stagingPath);
    if (
      staged.manifest_json !== manifestJson ||
      !staged.records_bytes.equals(recordsBytes)
    ) {
      throw new Error(
        'staged federated export verification changed exact bytes',
      );
    }
    fsyncDirectoryTree(stagingPath);
    renameSync(stagingPath, finalPath);
    stagingPath = undefined;
    fsyncDirectory(request.output_root);
    const committed = verifyFederatedExportBundle(finalPath);
    return {
      created: true,
      path: finalPath,
      manifest: committed.manifest,
      manifest_json: committed.manifest_json,
      records_bytes: committed.records_bytes,
      events: committed.events,
    };
  } catch (error) {
    if (stagingPath !== undefined && pathEntryExists(stagingPath)) {
      rmSync(stagingPath, { recursive: true, force: true });
      fsyncDirectory(request.output_root);
    }
    throw error;
  }
}
