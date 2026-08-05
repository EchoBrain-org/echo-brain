import { basename, join } from 'node:path';
import {
  assertPrivateOwnedRegularFile,
  readFileNoFollow,
} from '../../secure-local-files.js';
import { assertFederationDocumentSize } from '../schema-validation.js';

/** Read-only access to immutable signed documents left by the retired mode. */
export class ImmutableFederationDocumentStore {
  constructor(
    private readonly directory: string,
    private readonly label: string,
  ) {}

  pathFor(filename: string): string {
    if (basename(filename) !== filename || !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(filename)) {
      throw new Error(`${this.label} filename is unsafe`);
    }
    return join(this.directory, filename);
  }

  read(filename: string): string {
    const path = this.pathFor(filename);
    assertPrivateOwnedRegularFile(path, 0o600, () => {
      throw new Error(`${this.label} must be a current-user regular file with mode 0600`);
    });
    const raw = readFileNoFollow(path, this.label);
    assertFederationDocumentSize(raw, this.label);
    return raw.toString('utf8');
  }
}
