import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rejectUpdate } from './client-update-contract.js';

export function safeUpdateDirectory(path: string): void {
  const state = lstatSync(path);
  if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0) rejectUpdate('unsafe_installation');
}
export function assertUpdatePath(path: string): void {
  const absolute = resolve(path);
  if (absolute !== path) rejectUpdate('unsafe_installation');
  let cursor = absolute;
  while (true) {
    const state = lstatSync(cursor);
    if (!state.isDirectory() || state.isSymbolicLink()) rejectUpdate('unsafe_installation');
    if (dirname(cursor) === cursor) break;
    cursor = dirname(cursor);
  }
  safeUpdateDirectory(absolute);
}
export function readUpdateFile(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = fstatSync(fd);
    if (!state.isFile() || state.uid !== process.getuid?.() || (state.mode & 0o022) !== 0 || state.size <= 0 || state.size > limit) rejectUpdate('unsafe_update_file');
    const bytes = readFileSync(fd);
    if (bytes.length > limit) rejectUpdate('unsafe_update_file');
    return bytes;
  } finally { closeSync(fd); }
}
export function writeUpdateJson(path: string, value: unknown): void {
  safeUpdateDirectory(dirname(path));
  const temporary = join(dirname(path), `.pending-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    renameSync(temporary, path);
    // Persist the rename before an update may execute. fsync on the file alone
    // does not make the new freshness checkpoint durable across power loss.
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  finally { rmSync(temporary, { force: true }); }
}
export function updateDirectory(root: string): string {
  assertUpdatePath(root);
  const path = join(root, 'updater');
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  safeUpdateDirectory(path);
  return path;
}
