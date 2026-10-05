import { CONFLUENCE_PERSON_PROVIDER_V1 } from './confluence-validation-v1.js';
import type Database from 'better-sqlite3';
import { PersonProjectMappingStoreV1 } from '@echo-brain/provider-runtime/person-project-mapping-v1';
import { validateConfluenceProjectMappingV1, type ConfluenceProjectMappingV1 } from '@echo-brain/provider-confluence-client/organization-api/confluence-project-mapping-v1';

export class ConfluenceProjectMappingStoreV1 extends PersonProjectMappingStoreV1<ConfluenceProjectMappingV1> {
  constructor(db: Database.Database) { super(db, CONFLUENCE_PERSON_PROVIDER_V1, validateConfluenceProjectMappingV1); }
}
