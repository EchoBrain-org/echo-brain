import type Database from 'better-sqlite3';
import { PersonConnectionStoreV1 } from '@echo-brain/provider-runtime/person-connection-store-v1';
import { JIRA_PERSON_PROVIDER_V1 } from './jira-validation-v1.js';

export type {
  PersonConnectionAttemptStatusV1 as JiraConnectionAttemptStatusV1,
  PersonConnectionAttemptFailureV1 as JiraConnectionAttemptFailureV1,
  ConnectedPersonV1 as JiraPersonV1,
  StoredPersonConnectionV1 as JiraStoredConnectionV1,
  PersonConnectionAttemptV1 as JiraConnectionAttemptV1,
} from '@echo-brain/provider-runtime/person-connection-store-v1';

/** Keeps the existing Jira tables and grant identities. */
export class JiraConnectionStoreV1 extends PersonConnectionStoreV1 {
  constructor(database: Database.Database, now: () => number = Date.now) {
    super(database, JIRA_PERSON_PROVIDER_V1, now);
  }
}
