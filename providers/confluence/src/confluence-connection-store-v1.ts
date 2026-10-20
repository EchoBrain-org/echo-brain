import type Database from 'better-sqlite3';
import { PersonConnectionStoreV1 } from '@echo-brain/provider-runtime/person-connection-store-v1';
import { CONFLUENCE_PERSON_PROVIDER_V1 } from './confluence-validation-v1.js';

/** Keeps the existing Confluence tables and grant identities. */
export class ConfluenceConnectionStoreV1 extends PersonConnectionStoreV1 {
  constructor(database: Database.Database, now: () => number = Date.now) {
    super(database, CONFLUENCE_PERSON_PROVIDER_V1, now);
  }
}
