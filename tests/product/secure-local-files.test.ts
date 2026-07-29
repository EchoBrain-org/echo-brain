import { describe, expect, it } from 'vitest';
import { permissiveDarwinAclEntries } from '../../src/product/secure-local-files.js';

describe('macOS ACL inspection', () => {
  it('accepts ordinary metadata and deny-only ACL entries', () => {
    expect(
      permissiveDarwinAclEntries(
        [
          'drwx------@ 4 user staff 128 Jul 28 16:00 Downloads',
          ' 0: group:everyone deny delete',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('detects access granted outside POSIX mode bits', () => {
    expect(
      permissiveDarwinAclEntries(
        [
          '-rw-------+ 1 user staff 123 Jul 28 16:00 invitation.json',
          ' 0: group:everyone allow read',
          ' 1: user:someone allow read,write',
        ].join('\n'),
      ),
    ).toEqual([
      '0: group:everyone allow read',
      '1: user:someone allow read,write',
    ]);
  });
});
