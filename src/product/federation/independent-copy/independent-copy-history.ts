import {
  lstatSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  assertPrivateOwnedDirectory,
  assertPrivateOwnedRegularFile,
  canonicalLocalPath,
  fsyncDirectory,
} from '../../secure-local-files.js';
import { canonicalSha256, sha256Digest } from '../foundation/canonical-json.js';
import type { FederationId } from '../contracts.js';
import {
  assertIntent,
  BINDING_TEMP_PATTERN,
  BUNDLE_DIRECTORY_PATTERN,
  bytewiseCompare,
  type ChainSnapshot,
  EXPORT_STAGING_PATTERN,
  failIndependentCopy as fail,
  headKey,
  type IndependentCopyExportOperations,
  type IndependentCopyOutboxSource,
  type IndependentCopyTargetRecordV1,
  LOCAL_INTENT_TEMP_PATTERN,
  LOCAL_RECEIPT_TEMP_PATTERN,
  type ProtectedExportSnapshot,
  readCanonical,
  TARGET_BINDING_FILENAME,
} from './independent-copy-documents.js';
import {
  resolvedIndependentCopyOutputRoot,
  type IndependentCopyLocalPaths,
} from './independent-copy-local-state.js';
import { assertFederationId } from '../foundation/identifiers.js';

function removePrivateAtomicResidue(
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

function recoverTargetResidue(
  target: IndependentCopyTargetRecordV1,
  outputRoot: string,
  paths: IndependentCopyLocalPaths,
): void {
  removePrivateAtomicResidue(
    paths.intentsDirectory,
    LOCAL_INTENT_TEMP_PATTERN,
    'independent-copy intent residue',
  );
  removePrivateAtomicResidue(
    paths.receiptsDirectory,
    LOCAL_RECEIPT_TEMP_PATTERN,
    'independent-copy receipt residue',
  );
  const targetDigest = canonicalSha256(target);
  const intents = new Map<string, ReturnType<typeof assertIntent>>();
  for (const name of readdirSync(paths.intentsDirectory)) {
    const path = join(paths.intentsDirectory, name);
    const intent = assertIntent(readCanonical(path, 'independent-copy intent'));
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
      fail('independent-copy intent identity is invalid during recovery');
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
        fail('independent-copy binding residue is not a private regular file');
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
      fail('independent-copy staging residue is not tied to its intent');
    }
    rmSync(path, { recursive: true, force: false });
    changed = true;
  }
  if (changed) fsyncDirectory(outputRoot);
}

export function protectedIndependentCopyExportHeads(
  target: IndependentCopyTargetRecordV1,
  organizationId: FederationId,
  paths: IndependentCopyLocalPaths,
  exports: IndependentCopyExportOperations,
): readonly ProtectedExportSnapshot[] {
  const outputRoot = resolvedIndependentCopyOutputRoot(target);
  assertPrivateOwnedDirectory(outputRoot, 'independent-copy output root');
  recoverTargetResidue(target, outputRoot, paths);
  const protectedExports: ProtectedExportSnapshot[] = [];
  for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
    if (entry.name === TARGET_BINDING_FILENAME && entry.isFile()) continue;
    const match = BUNDLE_DIRECTORY_PATTERN.exec(entry.name);
    if (match === null || !entry.isDirectory() || entry.isSymbolicLink()) {
      fail('protected target contains an unexpected copy artifact');
    }
    const installationId = match[1]!;
    const sequence = Number(match[2]!);
    assertFederationId(
      installationId,
      'ins',
      'protected export installation',
    );
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      fail('protected export directory has an invalid sequence');
    }
    const path = join(outputRoot, entry.name);
    const verified = exports.verify(path);
    const manifest = verified.manifest;
    if (
      canonicalLocalPath(verified.path, 'protected export', true) !== path ||
      manifest.kind !== 'echo-federated-export' ||
      manifest.organization_id !== organizationId ||
      manifest.installation_id !== installationId ||
      manifest.sequence.first !== 1 ||
      manifest.sequence.last !== sequence ||
      manifest.sequence.predecessor_hash !== null ||
      manifest.records.count !== sequence ||
      verified.events.length !== sequence
    ) {
      fail('protected target export identity or full-prefix shape is invalid');
    }
    protectedExports.push({
      installation_id: installationId,
      last_sequence: sequence,
      head_hash: manifest.sequence.head_hash,
      path,
      records_bytes: verified.records_bytes,
      export_id: manifest.export_id,
      generated_at: manifest.generated_at,
      signing_identity_manifest_id: manifest.signing_identity_manifest_id,
      export_manifest_sha256: sha256Digest(verified.manifest_json),
      records_sha256: manifest.records.sha256,
    });
  }
  protectedExports.sort(
    (left, right) =>
      bytewiseCompare(left.installation_id, right.installation_id) ||
      left.last_sequence - right.last_sequence,
  );
  const latest = new Map<FederationId, ProtectedExportSnapshot>();
  for (const current of protectedExports) {
    const previous = latest.get(current.installation_id);
    if (previous !== undefined) {
      if (previous.last_sequence >= current.last_sequence) {
        fail('protected target contains duplicate or unordered exports');
      }
      if (
        current.records_bytes.length <= previous.records_bytes.length ||
        !current.records_bytes
          .subarray(0, previous.records_bytes.length)
          .equals(previous.records_bytes)
      ) {
        fail('protected target contains a forked export history');
      }
    }
    latest.set(current.installation_id, current);
  }
  return [...latest.values()].sort((left, right) =>
    bytewiseCompare(left.installation_id, right.installation_id),
  );
}

export function assertLocalHeadsDoNotRollback(
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

export async function assertLocalHeadsCanExtendProtectedHistory(
  outbox: IndependentCopyOutboxSource,
  localHeads: readonly ChainSnapshot[],
  protectedHeads: readonly ProtectedExportSnapshot[],
): Promise<void> {
  assertLocalHeadsDoNotRollback(localHeads, protectedHeads);
  const local = new Map(
    localHeads.map((head) => [head.installation_id, head]),
  );
  for (const protectedHead of protectedHeads) {
    const localHead = local.get(protectedHead.installation_id)!;
    if (localHead.last_sequence === protectedHead.last_sequence) continue;
    const prefix = await outbox.readSequenceRange(
      protectedHead.installation_id,
      1,
      protectedHead.last_sequence,
    );
    const prefixBytes = Buffer.concat(
      prefix.map((event) =>
        Buffer.concat([event.envelope_bytes, Buffer.from('\n')]),
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

export function assertProtectedHeadsMatchLocal(
  localHeads: readonly ChainSnapshot[],
  protectedHeads: readonly ProtectedExportSnapshot[],
): void {
  assertLocalHeadsDoNotRollback(localHeads, protectedHeads);
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
    fail('protected target does not match every current local outbox head');
  }
}
