import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, normalize, relative, sep } from 'node:path';
import { AdapterError } from '../core/index.js';

const ENV_REFERENCE = /^env:([A-Za-z][A-Za-z0-9_.-]*)$/;
const FILE_PREFIX = 'file:';
const MAX_CREDENTIAL_BYTES = 64 * 1024;

export type ProductCredentialResolver = (
  reference: string,
) => string | undefined;

export class ProductCredentialError extends AdapterError {
  constructor(message: string) {
    super('unauthorized', message, false);
    this.name = 'ProductCredentialError';
  }
}

function fileReferencePath(reference: string): string | undefined {
  if (!reference.startsWith(FILE_PREFIX)) return undefined;
  const path = reference.slice(FILE_PREFIX.length);
  if (
    path.includes('\0') ||
    !isAbsolute(path) ||
    path.split(/[\\/]+/u).includes('..')
  ) {
    throw new ProductCredentialError(
      'file credential reference must contain an absolute non-traversing path',
    );
  }
  return normalize(path);
}

export function isServiceSafeCredentialReference(
  reference: string,
  credentialsDirectory?: string,
): boolean {
  try {
    const path = fileReferencePath(reference);
    return (
      path !== undefined &&
      (credentialsDirectory === undefined ||
        credentialPathIsWithin(path, credentialsDirectory))
    );
  } catch {
    return false;
  }
}

export function productFileCredentialPath(reference: string): string | undefined {
  return fileReferencePath(reference);
}

export function credentialPathIsWithin(
  credentialPath: string,
  credentialsDirectory: string,
): boolean {
  const path = normalize(credentialPath);
  const root = normalize(credentialsDirectory);
  const fromRoot = relative(root, path);
  return (
    fromRoot !== '' &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

export function readPrivateCredentialFile(
  path: string,
  uid: number | undefined = process.getuid?.(),
): string {
  const descriptor = openSync(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) {
      throw new ProductCredentialError('credential path is not a regular file');
    }
    if (uid !== undefined && before.uid !== uid) {
      throw new ProductCredentialError(
        'credential file must be owned by the service user',
      );
    }
    if ((before.mode & 0o077) !== 0) {
      throw new ProductCredentialError(
        'credential file permissions must not grant group or world access',
      );
    }
    if (before.size === 0 || before.size > MAX_CREDENTIAL_BYTES) {
      throw new ProductCredentialError(
        `credential file size must be between 1 and ${MAX_CREDENTIAL_BYTES} bytes`,
      );
    }
    if (realpathSync(path) !== path) {
      throw new ProductCredentialError(
        'credential file path must be canonical and may not use symlinks',
      );
    }
    const parent = dirname(path);
    if (realpathSync(parent) !== parent) {
      throw new ProductCredentialError(
        'credential file parent path must be canonical and may not use symlinks',
      );
    }
    const value = readFileSync(descriptor, 'utf8');
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      Buffer.byteLength(value) !== after.size
    ) {
      throw new ProductCredentialError(
        'credential file changed while it was being read',
      );
    }
    const withoutFinalNewline = value.replace(/\r?\n$/u, '');
    if (withoutFinalNewline.trim() === '') {
      throw new ProductCredentialError('credential file is empty');
    }
    return withoutFinalNewline;
  } finally {
    closeSync(descriptor);
  }
}

export function createProductCredentialResolver(
  environment: NodeJS.ProcessEnv = process.env,
): ProductCredentialResolver {
  return (reference) => {
    const environmentMatch = ENV_REFERENCE.exec(reference);
    if (environmentMatch !== null) return environment[environmentMatch[1]!];
    const path = fileReferencePath(reference);
    if (path !== undefined) return readPrivateCredentialFile(path);
    throw new ProductCredentialError(
      'credential reference is unsupported by the bundled product resolver',
    );
  };
}
