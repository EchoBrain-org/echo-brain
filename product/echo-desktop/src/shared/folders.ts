// Node only: main and the person host share this; the renderer never imports it.
import { statSync } from 'node:fs';

/** The same folder by identity, not spelling: case and /System/Volumes/Data name one many ways. A missing one is never the same. */
export function sameFolder(a: string, b: string): boolean {
  try {
    const [left, right] = [statSync(a, { bigint: true }), statSync(b, { bigint: true })];
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}
