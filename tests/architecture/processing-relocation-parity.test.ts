import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');

describe('processing relocation parity', () => {
  it('keeps the process-file-lock copies byte-identical', () => {
    const machineBytes = readFileSync(
      resolve(
        REPOSITORY_ROOT,
        'src/infrastructure/filesystem/process-file-lock.ts',
      ),
    );
    const authorityBytes = readFileSync(
      resolve(
        REPOSITORY_ROOT,
        'services/organization-authority/src/processing/infrastructure/process-file-lock.ts',
      ),
    );

    expect(
      authorityBytes.equals(machineBytes),
      'Authority process-file-lock copy diverged from the machine source',
    ).toBe(true);
  });
});
