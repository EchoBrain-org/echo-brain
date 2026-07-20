import { basename, join } from 'node:path';
import { atomicCreate } from '../../infrastructure/filesystem/atomic-create.js';
import {
  assertPrivateOwnedDirectory,
  assertPrivateOwnedRegularFile,
  ensureDirectory,
  pathEntryExists,
  readFileNoFollow,
} from '../secure-local-files.js';
import { assertFederationDocumentSize } from './schema-validation.js';

export class ImmutableFederationDocumentStore {
  constructor(
    private readonly directory: string,
    private readonly label: string,
  ) {}

  prepare(): void {
    ensureDirectory(this.directory, 0o700);
    assertPrivateOwnedDirectory(this.directory, this.label);
  }

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

  create(filename: string, raw: string): { created: boolean; path: string } {
    this.prepare();
    assertFederationDocumentSize(raw, this.label);
    const path = this.pathFor(filename);
    const created = atomicCreate({ filePath: path, content: raw, mode: 0o600 });
    if (!created && this.read(filename) !== raw) {
      throw new Error(`${this.label} already exists with different immutable bytes`);
    }
    return { created, path };
  }

  exists(filename: string): boolean {
    return pathEntryExists(this.pathFor(filename));
  }
}
