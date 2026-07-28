import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertAuthorityServeStateBoundary,
  assertIndependentAuthorityTokens,
  assertPersistentAuthorityDatabasePath,
} from '../src/composition/config.js';

const STATE_DIRECTORY = '/tmp/echo-authority-state';
const VALID_BOUNDARY = {
  state_directory: STATE_DIRECTORY,
  database_path: join(STATE_DIRECTORY, 'authority.sqlite'),
  key_directory: join(STATE_DIRECTORY, 'keys'),
};

describe('organization authority serve configuration guards', () => {
  it('requires independent administrator and trusted-proxy credentials', () => {
    expect(() =>
      assertIndependentAuthorityTokens('same-token', 'same-token'),
    ).toThrow('must be distinct credentials');
    expect(() =>
      assertIndependentAuthorityTokens('admin-token', 'proxy-token'),
    ).not.toThrow();
  });

  it('requires persistent serving storage', () => {
    expect(() => assertPersistentAuthorityDatabasePath(':memory:')).toThrow(
      'must use persistent storage when serving',
    );
    expect(() =>
      assertPersistentAuthorityDatabasePath(VALID_BOUNDARY.database_path),
    ).not.toThrow();
  });

  it('keeps the database and key directory inside canonical state paths', () => {
    expect(() =>
      assertAuthorityServeStateBoundary(VALID_BOUNDARY),
    ).not.toThrow();
    expect(() =>
      assertAuthorityServeStateBoundary({
        ...VALID_BOUNDARY,
        state_directory: 'relative/state',
      }),
    ).toThrow('normalized absolute path');
    expect(() =>
      assertAuthorityServeStateBoundary({
        ...VALID_BOUNDARY,
        database_path: '/tmp/authority.sqlite',
      }),
    ).toThrow('canonical state-directory path');
    expect(() =>
      assertAuthorityServeStateBoundary({
        ...VALID_BOUNDARY,
        key_directory: '/tmp/keys',
      }),
    ).toThrow('canonical state-directory path');
  });
});
