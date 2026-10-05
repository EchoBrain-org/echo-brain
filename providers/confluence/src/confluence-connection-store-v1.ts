import type Database from 'better-sqlite3';
import { PersonConnectionStoreV1 } from '@echo-brain/provider-runtime/person-connection-store-v1';
import { CONFLUENCE_PERSON_PROVIDER_V1 } from './confluence-validation-v1.js';

export type {
  PersonConnectionAttemptStatusV1 as ConfluenceConnectionAttemptStatusV1,
  PersonConnectionAttemptFailureV1 as ConfluenceConnectionAttemptFailureV1,
  ConnectedPersonV1 as ConfluencePersonV1,
  StoredPersonConnectionV1 as ConfluenceStoredConnectionV1,
  PersonConnectionAttemptV1 as ConfluenceConnectionAttemptV1,
} from '@echo-brain/provider-runtime/person-connection-store-v1';

/** Keeps the existing Confluence tables and grant identities. */
export class ConfluenceConnectionStoreV1 extends PersonConnectionStoreV1 {
  constructor(database: Database.Database, now: () => number = Date.now) {
    super(database, CONFLUENCE_PERSON_PROVIDER_V1, now);
  }
}
