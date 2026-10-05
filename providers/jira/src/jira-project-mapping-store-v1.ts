import { JIRA_PERSON_PROVIDER_V1 } from './jira-validation-v1.js';
import type Database from 'better-sqlite3';
import { PersonProjectMappingStoreV1 } from '@echo-brain/provider-runtime/person-project-mapping-v1';
import { validateJiraProjectMappingV1, type JiraProjectMappingV1 } from '@echo-brain/provider-jira-client/organization-api/jira-project-mapping-v1';

export class JiraProjectMappingStoreV1 extends PersonProjectMappingStoreV1<JiraProjectMappingV1> {
  constructor(db: Database.Database) { super(db, JIRA_PERSON_PROVIDER_V1, validateJiraProjectMappingV1); }
}
