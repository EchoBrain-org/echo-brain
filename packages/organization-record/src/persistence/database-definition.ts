/** The canonical organization record log database; the old derived role is retired. */
export interface OrganizationRecordDatabaseDefinition {
  /** Used verbatim in every error message this database can raise. */
  readonly label: string;
  /** SQLite `application_id`, so a wrong file is refused before any statement runs. */
  readonly application_id: number;
}

export const ORGANIZATION_RECORD_LOG_DATABASE: OrganizationRecordDatabaseDefinition = {
  label: 'organization record log',
  application_id: 0x4543524c, // "ECRL"
};
