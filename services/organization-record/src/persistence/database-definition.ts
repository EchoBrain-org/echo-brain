/**
 * The two organization-record databases.
 *
 * Charters are enforced at the database level. The log is truth and the
 * derived graph is disposable, so they never share a file, an application id,
 * or a migration series — and `authority.sqlite` stays free of decisions.
 */
export interface OrganizationRecordDatabaseDefinition {
  /** Used verbatim in every error message this database can raise. */
  readonly label: string;
  /** SQLite `application_id`, so a wrong file is refused before any statement runs. */
  readonly application_id: number;
  readonly migrations_directory: URL;
}

export const ORGANIZATION_RECORD_LOG_DATABASE: OrganizationRecordDatabaseDefinition = {
  label: 'organization record log',
  application_id: 0x4543524c, // "ECRL"
  migrations_directory: new URL('../../migrations/log/', import.meta.url),
};

export const ORGANIZATION_RECORD_DERIVED_DATABASE: OrganizationRecordDatabaseDefinition = {
  label: 'organization record derived',
  application_id: 0x45435244, // "ECRD"
  migrations_directory: new URL('../../migrations/derived/', import.meta.url),
};
