import { openSync, readSync, closeSync, fstatSync, constants } from 'node:fs';
import { Buffer } from 'node:buffer';
import { PERSON_UPDATE_TEXT_MAX_BYTES } from '@echo-brain/organization-api';

/** Reads one regular file of at most `maximumBytes` with a hard allocation and read bound, a growing file included; throws otherwise. */
export function readBoundedFile(path: string, maximumBytes: number): Uint8Array {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error();
    const bytes = Buffer.alloc(maximumBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(descriptor, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > maximumBytes) throw new Error();
    return bytes.subarray(0, size);
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Read one regular file with a hard allocation/read bound; never put its text in argv. */
export function readUpdateFile(path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readBoundedFile(path, PERSON_UPDATE_TEXT_MAX_BYTES));
  } catch { throw new Error('Update file must be a readable regular UTF-8 text file of at most 8 KiB.'); }
}
