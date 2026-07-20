import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SecureFileRecord {
  absolutePath: string;
  relativePath: string;
  mode: number;
  size: number;
  sha256: string;
}

export interface SecureFileDigest {
  mode: number;
  size: number;
  sha256: string;
}

export function pathEntryExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function traversalSegmentPresent(path: string): boolean {
  return path.split(/[\\/]+/u).some((segment) => segment === '..');
}

export function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} must be a safe local identifier`);
  }
}

export function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

/**
 * Resolve a local absolute path through its nearest existing ancestor.
 *
 * Platform-owned aliases such as macOS /var -> /private/var are canonicalized,
 * while a symlink at the caller-owned leaf is always rejected.
 */
export function canonicalLocalPath(
  input: string,
  label: string,
  mustExist: boolean,
): string {
  if (
    input.includes('\0') ||
    !isAbsolute(input) ||
    traversalSegmentPresent(input)
  ) {
    throw new Error(`${label} must be an absolute non-traversing local path`);
  }

  const normalized = normalize(input);
  let existing = normalized;
  const missing: string[] = [];
  while (!pathEntryExists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      throw new Error(`${label} has no existing local ancestor`);
    }
    missing.unshift(
      existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)),
    );
    existing = parent;
  }

  if (mustExist && missing.length > 0) {
    throw new Error(`${label} does not exist`);
  }
  const state = lstatSync(existing);
  if (state.isSymbolicLink()) {
    const rootOwnedPlatformAlias =
      dirname(existing) === parse(existing).root && state.uid === 0;
    if (!rootOwnedPlatformAlias) {
      throw new Error(
        `${label} may not resolve through a caller-owned symlink`,
      );
    }
  }
  const canonicalAncestor = realpathSync(existing);
  return resolve(canonicalAncestor, ...missing);
}

export function assertDirectory(path: string, label: string): void {
  const state = lstatSync(path);
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symlink`);
  }
  if (realpathSync(path) !== path) {
    throw new Error(`${label} must have a canonical local path`);
  }
}

/**
 * Require a caller-owned directory that cannot be traversed by another local
 * user. Product backups can contain raw meeting and decision state, so merely
 * creating their root with a restrictive default is not enough: an existing
 * root must be checked before it is trusted.
 */
export function assertPrivateOwnedDirectory(path: string, label: string): void {
  assertDirectory(path, label);
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (currentUid === undefined || state.uid !== currentUid) {
    throw new Error(`${label} must be owned by the current user`);
  }
  const mode = state.mode & 0o777;
  if ((mode & 0o077) !== 0 || (mode & 0o700) !== 0o700) {
    throw new Error(`${label} must be private to its owner (mode 0700)`);
  }
}

export function assertPrivateOwnedRegularFile(
  path: string,
  mode: number,
  invalid: () => never,
): void {
  const state = lstatSync(path);
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    (state.mode & 0o777) !== mode ||
    state.uid !== process.getuid?.()
  ) {
    invalid();
  }
}

/** Require rename/entry creation in this directory to be controlled by us. */
export function assertOwnerControlledDirectory(
  path: string,
  label: string,
): void {
  assertDirectory(path, label);
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (currentUid === undefined || state.uid !== currentUid) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((state.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group- or world-writable`);
  }
}

export function ensureDirectory(path: string, mode = 0o700): void {
  const canonical = canonicalLocalPath(path, 'directory', false);
  let cursor = canonical;
  const missing: string[] = [];
  while (!pathEntryExists(cursor)) {
    missing.unshift(cursor);
    cursor = dirname(cursor);
  }
  assertDirectory(cursor, 'directory ancestor');
  for (const directory of missing) {
    mkdirSync(directory, { mode });
    assertDirectory(directory, 'created directory');
  }
}

export function pathIsWithin(
  candidate: string,
  root: string,
  allowEqual = false,
): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return allowEqual;
  return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

export function assertDisjointPaths(
  left: string,
  right: string,
  leftLabel: string,
  rightLabel: string,
): void {
  if (
    left === right ||
    pathIsWithin(left, right) ||
    pathIsWithin(right, left)
  ) {
    throw new Error(`${leftLabel} and ${rightLabel} must be disjoint`);
  }
}

export function sha256Bytes(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function readFileNoFollow(path: string, label: string): Buffer {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const value = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      value.byteLength !== after.size
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    return value;
  } finally {
    closeSync(descriptor);
  }
}

function assertUnchangedFile(
  before: ReturnType<typeof fstatSync>,
  after: ReturnType<typeof fstatSync>,
  bytesRead: number,
  label: string,
): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    bytesRead !== after.size
  ) {
    throw new Error(`${label} changed while it was being read`);
  }
}

export function digestFileNoFollow(
  path: string,
  label: string,
): SecureFileDigest {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
      bytesRead += count;
    }
    assertUnchangedFile(before, fstatSync(descriptor), bytesRead, label);
    return {
      mode: before.mode & 0o777,
      size: bytesRead,
      sha256: digest.digest('hex'),
    };
  } finally {
    closeSync(descriptor);
  }
}

export function copyFileNoFollow(
  source: string,
  destination: string,
  label: string,
  overrideMode?: number,
): SecureFileDigest {
  const sourceDescriptor = openSync(
    source,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let destinationDescriptor: number | undefined;
  try {
    const before = fstatSync(sourceDescriptor);
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const mode = overrideMode ?? before.mode & 0o777;
    destinationDescriptor = openSync(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      mode,
    );
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    for (;;) {
      const count = readSync(
        sourceDescriptor,
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
      let written = 0;
      while (written < count) {
        written += writeSync(
          destinationDescriptor,
          buffer,
          written,
          count - written,
        );
      }
      total += count;
    }
    assertUnchangedFile(before, fstatSync(sourceDescriptor), total, label);
    fchmodSync(destinationDescriptor, mode);
    fsyncSync(destinationDescriptor);
    return { mode, size: total, sha256: digest.digest('hex') };
  } finally {
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    closeSync(sourceDescriptor);
  }
}

export function writeFileExclusive(
  path: string,
  value: Buffer | string,
  mode: number,
): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    writeFileSync(descriptor, value);
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Flush every directory entry in a tree, children before parents. */
export function fsyncDirectoryTree(root: string): void {
  assertDirectory(root, 'directory tree root');
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const state = lstatSync(path);
    if (state.isSymbolicLink()) {
      throw new Error('directory tree contains a forbidden symlink');
    }
    if (state.isDirectory()) fsyncDirectoryTree(path);
  }
  fsyncDirectory(root);
}

function walkDirectory(
  root: string,
  current: string,
  records: SecureFileRecord[],
): void {
  assertDirectory(current, 'tree directory');
  const names = readdirSync(current).sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  for (const name of names) {
    if (name === '.' || name === '..' || name.includes('\0')) {
      throw new Error('tree contains an unsafe directory entry');
    }
    const absolutePath = join(current, name);
    const state = lstatSync(absolutePath);
    if (state.isSymbolicLink()) {
      throw new Error(
        `tree contains forbidden symlink: ${relative(root, absolutePath)}`,
      );
    }
    if (state.isDirectory()) {
      walkDirectory(root, absolutePath, records);
      continue;
    }
    if (!state.isFile()) {
      throw new Error(
        `tree contains unsupported file type: ${relative(root, absolutePath)}`,
      );
    }
    const digest = digestFileNoFollow(absolutePath, 'tree file');
    records.push({
      absolutePath,
      relativePath: relative(root, absolutePath).split(sep).join('/'),
      mode: digest.mode,
      size: digest.size,
      sha256: digest.sha256,
    });
  }
}

export function secureTreeFiles(root: string): SecureFileRecord[] {
  assertDirectory(root, 'tree root');
  const records: SecureFileRecord[] = [];
  walkDirectory(root, root, records);
  return records.sort((left, right) =>
    Buffer.from(left.relativePath).compare(Buffer.from(right.relativePath)),
  );
}

export function secureTreeFingerprint(root: string): string {
  const records = secureTreeFiles(root).map(
    ({ relativePath, mode, size, sha256 }) => ({
      path: relativePath,
      mode,
      size,
      sha256,
    }),
  );
  return sha256Bytes(`${JSON.stringify(records)}\n`);
}

export function assertSafeRelativePath(path: string, label: string): void {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    isAbsolute(path) ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`${label} must be a safe portable relative path`);
  }
}

export function resolveContainedRelativePath(
  root: string,
  path: string,
  label: string,
): string {
  assertSafeRelativePath(path, label);
  const absolute = resolve(root, ...path.split('/'));
  if (!pathIsWithin(absolute, root)) {
    throw new Error(`${label} escapes its managed root`);
  }
  return absolute;
}

export function rootPath(path: string): string {
  return parse(path).root;
}
