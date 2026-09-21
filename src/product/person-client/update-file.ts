import { openSync, readSync, closeSync, fstatSync, constants } from 'node:fs';
import { Buffer } from 'node:buffer';
import { PERSON_UPDATE_TEXT_MAX_BYTES } from '@echo-brain/organization-api';

/** Read one regular file with a hard allocation/read bound; never put its text in argv. */
export function readUpdateFile(path: string): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > PERSON_UPDATE_TEXT_MAX_BYTES) throw new Error();
    const bytes = Buffer.alloc(PERSON_UPDATE_TEXT_MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(descriptor, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > PERSON_UPDATE_TEXT_MAX_BYTES) throw new Error();
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
  } catch { throw new Error('Update file must be a readable regular UTF-8 text file of at most 8 KiB.'); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
