import { join, relative, sep } from 'node:path';
import { atomicCreate } from '../../infrastructure/filesystem/atomic-create.js';
import {
  assertPrivateOwnedDirectory,
  assertSafeRelativePath,
  ensureDirectory,
  fsyncDirectory,
  pathEntryExists,
  resolveContainedRelativePath,
} from '../secure-local-files.js';
import { canonicalJson } from './canonical-json.js';
import type {
  ChainSnapshot,
  IndependentCopyIntentV1,
  IndependentCopyTargetBindingV1,
} from './independent-copy-documents.js';
import {
  assertIntent,
  assertPrivateCanonicalFile,
  assertReceipt,
  assertTargetRecord,
  bundleDirectoryName,
  failIndependentCopy as fail,
  headKey,
  type IndependentCopyReceiptV1,
  type IndependentCopyTargetRecordV1,
  readCanonical,
  statePathDigest,
  TARGET_BINDING_FILENAME,
  TARGET_COPY_DIRECTORY,
  targetConfigurationDigest,
} from './independent-copy-documents.js';

export interface IndependentCopyLocalPaths {
  stateDirectory: string;
  localRoot: string;
  intentsDirectory: string;
  receiptsDirectory: string;
  targetPath: string;
}

export function prepareIndependentCopyLocalState(
  paths: IndependentCopyLocalPaths,
): void {
  assertPrivateOwnedDirectory(paths.stateDirectory, 'state directory');
  const federationRoot = join(paths.stateDirectory, 'federation');
  ensureDirectory(federationRoot, 0o700);
  ensureDirectory(paths.localRoot, 0o700);
  ensureDirectory(paths.intentsDirectory, 0o700);
  ensureDirectory(paths.receiptsDirectory, 0o700);
  assertPrivateOwnedDirectory(paths.localRoot, 'independent-copy state');
  assertPrivateOwnedDirectory(
    paths.intentsDirectory,
    'independent-copy intents',
  );
  assertPrivateOwnedDirectory(
    paths.receiptsDirectory,
    'independent-copy receipts',
  );
  fsyncDirectory(paths.receiptsDirectory);
  fsyncDirectory(paths.intentsDirectory);
  fsyncDirectory(paths.localRoot);
  fsyncDirectory(federationRoot);
  fsyncDirectory(paths.stateDirectory);
}

export function assertPreparedIndependentCopyLocalState(
  paths: IndependentCopyLocalPaths,
): void {
  assertPrivateOwnedDirectory(paths.stateDirectory, 'state directory');
  assertPrivateOwnedDirectory(paths.localRoot, 'independent-copy state');
  assertPrivateOwnedDirectory(
    paths.intentsDirectory,
    'independent-copy intents',
  );
  assertPrivateOwnedDirectory(
    paths.receiptsDirectory,
    'independent-copy receipts',
  );
}

export function readIndependentCopyTargetRecord(
  paths: IndependentCopyLocalPaths,
): IndependentCopyTargetRecordV1 | undefined {
  if (!pathEntryExists(paths.targetPath)) return undefined;
  const target = assertTargetRecord(
    readCanonical(paths.targetPath, 'independent-copy target record'),
  );
  if (target.state_path_sha256 !== statePathDigest(paths.stateDirectory)) {
    fail('independent-copy target belongs to a different state directory');
  }
  return target;
}

export function resolvedIndependentCopyOutputRoot(
  target: IndependentCopyTargetRecordV1,
): string {
  const stateIdentity = target.state_path_sha256.slice('sha256:'.length);
  const relativeRoot = `${TARGET_COPY_DIRECTORY}/${stateIdentity}`;
  return resolveContainedRelativePath(
    target.target_root,
    relativeRoot,
    'independent-copy output root',
  );
}

export function ensureIndependentCopyOutputRoot(
  target: IndependentCopyTargetRecordV1,
): string {
  const path = resolvedIndependentCopyOutputRoot(target);
  const managedTargetRoot = join(target.target_root, TARGET_COPY_DIRECTORY);
  ensureDirectory(managedTargetRoot, 0o700);
  assertPrivateOwnedDirectory(
    managedTargetRoot,
    'independent-copy managed target root',
  );
  ensureDirectory(path, 0o700);
  assertPrivateOwnedDirectory(path, 'independent-copy output root');
  fsyncDirectory(path);
  fsyncDirectory(managedTargetRoot);
  fsyncDirectory(target.target_root);
  return path;
}

export function assertIndependentCopyTargetBinding(
  target: IndependentCopyTargetRecordV1,
  create: boolean,
): void {
  const outputRoot = create
    ? ensureIndependentCopyOutputRoot(target)
    : resolvedIndependentCopyOutputRoot(target);
  if (!create) {
    assertPrivateOwnedDirectory(
      join(target.target_root, TARGET_COPY_DIRECTORY),
      'independent-copy managed target root',
    );
    assertPrivateOwnedDirectory(outputRoot, 'independent-copy output root');
  }
  const binding: IndependentCopyTargetBindingV1 = {
    schema_version: 1,
    kind: 'echo-founder-independent-copy-target-binding',
    state_path_sha256: target.state_path_sha256,
    target_configuration_sha256: targetConfigurationDigest(target),
    volume_id: target.volume_id,
  };
  const path = join(outputRoot, TARGET_BINDING_FILENAME);
  const expected = canonicalJson(binding);
  if (!pathEntryExists(path)) {
    if (!create) fail('independent-copy target binding is missing');
    atomicCreate({ filePath: path, content: expected, mode: 0o600 });
  }
  if (
    assertPrivateCanonicalFile(path, 'independent-copy target binding') !==
    expected
  ) {
    fail('independent-copy target binding does not match this state root');
  }
}

export function independentCopyIntentPath(
  paths: IndependentCopyLocalPaths,
  head: ChainSnapshot,
): string {
  return join(paths.intentsDirectory, `intent.${headKey(head)}.v1.json`);
}

export function independentCopyReceiptPath(
  paths: IndependentCopyLocalPaths,
  head: ChainSnapshot,
): string {
  return join(paths.receiptsDirectory, `receipt.${headKey(head)}.v1.json`);
}

export function readIndependentCopyIntent(
  paths: IndependentCopyLocalPaths,
  head: ChainSnapshot,
): IndependentCopyIntentV1 | undefined {
  const path = independentCopyIntentPath(paths, head);
  if (!pathEntryExists(path)) return undefined;
  return assertIntent(readCanonical(path, 'independent-copy intent'));
}

export function readIndependentCopyReceipt(
  paths: IndependentCopyLocalPaths,
  head: ChainSnapshot,
): IndependentCopyReceiptV1 | undefined {
  const path = independentCopyReceiptPath(paths, head);
  if (!pathEntryExists(path)) return undefined;
  return assertReceipt(readCanonical(path, 'independent-copy receipt'));
}

export function createOrReadIndependentCopyEvidence<T>(
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

export function expectedIndependentCopyBundleRelativePath(
  target: IndependentCopyTargetRecordV1,
  head: ChainSnapshot,
): string {
  const outputRoot = resolvedIndependentCopyOutputRoot(target);
  const bundlePath = join(outputRoot, bundleDirectoryName(head));
  const relativePath = relative(target.target_root, bundlePath)
    .split(sep)
    .join('/');
  assertSafeRelativePath(relativePath, 'independent-copy bundle path');
  return relativePath;
}
