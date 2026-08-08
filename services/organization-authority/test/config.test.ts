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
  integrations_database_path: join(
    STATE_DIRECTORY,
    'integrations.sqlite',
  ),
  record_log_database_path: join(STATE_DIRECTORY, 'record-log.sqlite'),
  record_derived_database_path: join(
    STATE_DIRECTORY,
    'record-derived.sqlite',
  ),
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
    expect(() =>
      assertAuthorityServeStateBoundary({
        ...VALID_BOUNDARY,
        integrations_database_path: join(
          STATE_DIRECTORY,
          'other-integrations.sqlite',
        ),
      }),
    ).toThrow('integrations database');
    expect(() =>
      assertAuthorityServeStateBoundary({
        ...VALID_BOUNDARY,
        record_log_database_path: join(STATE_DIRECTORY, 'other-log.sqlite'),
      }),
    ).toThrow('record log database');
    // The log and the derived graph never share a file: the charter split is
    // enforced at the path, not only by convention.
    expect(() =>
      assertAuthorityServeStateBoundary({
        ...VALID_BOUNDARY,
        record_derived_database_path: VALID_BOUNDARY.record_log_database_path,
      }),
    ).toThrow('record derived database');
    expect(() =>
      assertAuthorityServeStateBoundary({
        ...VALID_BOUNDARY,
        record_log_database_path: '/tmp/record-log.sqlite',
      }),
    ).toThrow('record log database');
  });
});
