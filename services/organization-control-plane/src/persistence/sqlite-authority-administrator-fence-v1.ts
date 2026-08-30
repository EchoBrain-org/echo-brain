import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CurrentAuthorityMembershipV2,
  PersonSlackReactionApprovalActivationFenceV2,
} from "../application/person-slack-reaction-approval-activation-v2.js";
import { canonicalJson, canonicalSha256 } from "../canonical/canonical-json.js";
import type { StableAuthorityAdministratorFenceV2 } from "./sqlite-person-slack-reaction-approval-activation-v2.js";
import Database from "better-sqlite3";

const AUTHORITY_APPLICATION_ID_V1 = 0x45434155;
const AUTHORITY_SCHEMA_VERSION_V1 = 1;
const AUTHORITY_BASELINE_SHA256_V1 =
  "sha256:007a1498dd1db87d03ba2876086c5ec6b6c655f77e5c25691abafd18451465d6";

export interface OrganizationAuthorityCoordinatesV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
}

export interface SqliteAuthorityAdministratorFenceV1Input extends OrganizationAuthorityCoordinatesV1 {
  readonly authority_database_path: string;
}

type AdministratorFence = Omit<
  PersonSlackReactionApprovalActivationFenceV2,
  "transaction"
>;

function verifyAuthorityLineageManifest(
  database: Database.Database,
  expected: OrganizationAuthorityCoordinatesV1,
): void {
  const row = database
    .prepare(
      `SELECT manifest_json, manifest_sha256 FROM echo_state_lineage_manifest
       WHERE singleton = 1`,
    )
    .get() as
    | { readonly manifest_json: string; readonly manifest_sha256: string }
    | undefined;
  if (row === undefined) {
    throw new Error("clean Authority database has no lineage manifest");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(row.manifest_json) as unknown;
  } catch {
    throw new Error("clean Authority lineage manifest is not JSON");
  }
  if (
    canonicalJson(manifest) !== row.manifest_json ||
    canonicalSha256(manifest) !== row.manifest_sha256 ||
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    throw new Error("clean Authority lineage manifest is invalid");
  }
  const record = manifest as Record<string, unknown>;
  if (
    record.schema_version !== 1 ||
    record.kind !== "echo-state-lineage-database-manifest-v1" ||
    record.role !== "authority" ||
    record.authority_id !== expected.authority_id ||
    record.organization_id !== expected.organization_id ||
    record.state_lineage_id !== expected.state_lineage_id ||
    record.database_schema_version !== AUTHORITY_SCHEMA_VERSION_V1 ||
    record.schema_sha256 !== AUTHORITY_BASELINE_SHA256_V1
  ) {
    throw new Error("clean Authority lineage manifest does not match state");
  }
}

function assertPrivateAuthorityDatabase(path: string): void {
  if (!existsSync(path)) {
    throw new Error("clean Authority database is unavailable");
  }
  const directory = lstatSync(dirname(path));
  const file = lstatSync(path);
  const uid = process.getuid?.();
  if (
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    realpathSync(dirname(path)) !== dirname(path) ||
    (uid !== undefined && directory.uid !== uid) ||
    (directory.mode & 0o777) !== 0o700 ||
    file.isSymbolicLink() ||
    !file.isFile() ||
    realpathSync(path) !== path ||
    (uid !== undefined && file.uid !== uid) ||
    (file.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      "clean Authority database must be a current-user canonical private file",
    );
  }
}

function readExactActiveOwner(
  database: Database.Database,
  expected: OrganizationAuthorityCoordinatesV1,
): AdministratorFence {
  if (
    database.pragma("application_id", { simple: true }) !==
      AUTHORITY_APPLICATION_ID_V1 ||
    database.pragma("user_version", { simple: true }) !==
      AUTHORITY_SCHEMA_VERSION_V1
  ) {
    throw new Error("clean Authority database has the wrong baseline identity");
  }
  verifyAuthorityLineageManifest(database, expected);
  const metadata = database
    .prepare(
      `SELECT authority_id, organization_id
       FROM authority_metadata WHERE singleton = 1`,
    )
    .get() as
    | { readonly authority_id: string; readonly organization_id: string }
    | undefined;
  if (
    metadata === undefined ||
    metadata.authority_id !== expected.authority_id ||
    metadata.organization_id !== expected.organization_id
  ) {
    throw new Error(
      "clean Authority metadata does not match the verified lineage",
    );
  }
  const owners = database
    .prepare(
      `SELECT membership.principal_id, membership.membership_id
       FROM authority_memberships AS membership
       JOIN authority_principals AS principal
         ON principal.principal_id = membership.principal_id
        AND principal.organization_id = membership.organization_id
       WHERE membership.organization_id = ?
         AND membership.membership_type = 'owner'
         AND membership.status = 'active'
         AND membership.revoked_at IS NULL
         AND membership.revocation_reason IS NULL
       ORDER BY membership.membership_id ASC`,
    )
    .all(expected.organization_id) as Array<{
    readonly principal_id: string;
    readonly membership_id: string;
  }>;
  if (owners.length !== 1 || owners[0] === undefined) {
    throw new Error(
      "clean stopped-state approval activation requires one active owner",
    );
  }
  const owner = owners[0];
  const membership = Object.freeze({
    principal_id: owner.principal_id,
    membership_id: owner.membership_id,
    membership_type: "owner" as const,
  });
  const currentMembership = (input: {
    readonly principal_id: string;
    readonly membership_id: string;
  }): CurrentAuthorityMembershipV2 | undefined => {
    if (
      input.principal_id !== membership.principal_id ||
      input.membership_id !== membership.membership_id
    ) {
      return undefined;
    }
    return membership;
  };
  return Object.freeze({
    administrator: Object.freeze({
      actor_kind: "authority-administrator-credential" as const,
      authority_id: expected.authority_id,
      organization_id: expected.organization_id,
      state_lineage_id: expected.state_lineage_id,
      ...membership,
    }),
    currentMembership,
  });
}

/**
 * Supplies the one fresh-lineage owner directly from Authority state. This is
 * a local stopped-state fence, not an administrator bearer credential or a
 * cross-database transaction.
 */
export class SqliteAuthorityAdministratorFenceV1 implements StableAuthorityAdministratorFenceV2 {
  constructor(
    private readonly input: SqliteAuthorityAdministratorFenceV1Input,
  ) {}

  async withStableAdministratorFence<T>(
    _credential: unknown,
    commit: (fence: AdministratorFence) => T,
  ): Promise<T> {
    assertPrivateAuthorityDatabase(this.input.authority_database_path);
    const database = new Database(this.input.authority_database_path, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      database.pragma("trusted_schema = OFF");
      database.pragma("query_only = ON");
      database.pragma("busy_timeout = 5000");
      database.exec("BEGIN");
      try {
        const result = commit(readExactActiveOwner(database, this.input));
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    } finally {
      database.close();
    }
  }
}
