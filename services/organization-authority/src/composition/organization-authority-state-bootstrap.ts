import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  assertFederationId,
  canonicalJson,
  federationId,
} from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import {
  organizationAuthorityPinSha256,
  type OrganizationAuthorityDescriptorV1,
} from "@echo-brain/organization-protocol";
import {
  applyOrganizationControlBaselineV2,
  openOrganizationControlDatabase,
  ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2,
  organizationControlBaselineSha256V2,
} from "@echo-brain/organization-control-plane/organization-control-database-v1";
import {
  applyOrganizationRecordDerivedBaselineV1,
  applyOrganizationRecordLogBaselineV2,
  openOrganizationRecordDatabase,
  ORGANIZATION_RECORD_DERIVED_BASELINE_SCHEMA_VERSION_V1,
  ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V2,
  organizationRecordDerivedBaselineSha256V1,
  organizationRecordLogBaselineSha256V2,
} from "@echo-brain/organization-record/organization-record-api-v1";
import {
  READABLE_SEARCH_CONTENT_BASELINE_V1,
  READABLE_SEARCH_FACTS_BASELINE_V2,
  READABLE_SEARCH_FACTS_BASELINE_SCHEMA_VERSION_V2,
  READABLE_SEARCH_LEXICAL_BASELINE_V1,
  READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
  readableSearchPlaneBaselineSha256,
  readableSearchPlaneBaselineSha256V1,
} from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import {
  applyAuthorityBaselineV4,
  AUTHORITY_BASELINE_SCHEMA_VERSION_V4,
  authorityBaselineSha256V4,
} from "../adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../adapters/persistence/sqlite/open-authority-database.js";
import { FileOrganizationAuthoritySigner } from "../adapters/security/file-organization-authority-signer.js";
import { assertDisplayName } from "../domain/rules.js";
import {
  initializeAuthorityStateLineageV1,
  type InitializedAuthorityStateLineageV1,
  type StagedAuthorityStateV1,
} from "../state-lineage/authority-state-lineage-initializer.js";
import {
  stateLineageDatabaseManifestSha256V1,
  stateLineageRootManifestSha256V1,
} from "../state-lineage/state-lineage-manifest-v1.js";

/**
 * Explicit, absent-state initializer. It creates fresh Authority state only;
 * not write operator configuration, credentials, listener state, provider
 * configuration, installation state, enrollment state, or leases.
 */
export interface BootstrapOrganizationAuthorityStateInput {
  readonly state_directory: string;
  readonly organization_display_name: string;
  readonly owner_display_name: string;
  readonly created_at: string;
  readonly creating_artifact_revision: string;
  /**
   * A caller may persist this non-secret identity seed before genesis so a
   * stopped setup can be resumed without allocating a second lineage.
   */
  readonly seed?: AuthorityStateSeedV1;
}

export interface AuthorityStateManifestEvidenceV1 {
  readonly root_manifest_sha256: Sha256Digest;
  readonly database_manifests: Readonly<Record<string, Sha256Digest>>;
  readonly retrieval_present: false;
}

export interface BootstrappedOrganizationAuthorityStateV1 {
  readonly schema_version: 1;
  readonly kind: "echo-organization-authority-clean-reset-state-v1";
  readonly state_directory: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly owner_principal_id: string;
  readonly owner_membership_id: string;
  readonly control_plane_id: string;
  readonly authority_descriptor_sha256: Sha256Digest;
  readonly manifests: AuthorityStateManifestEvidenceV1;
}

export interface AuthorityStateSeedV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly owner_principal_id: string;
  readonly owner_membership_id: string;
  readonly control_plane_id: string;
}

function generatedAuthorityStateSeed(): AuthorityStateSeedV1 {
  return Object.freeze({
    authority_id: federationId("oau"),
    organization_id: federationId("org"),
    state_lineage_id: `lineage-${randomUUID()}`,
    owner_principal_id: federationId("prn"),
    owner_membership_id: federationId("mem"),
    control_plane_id: `ocp_${randomUUID()}`,
  });
}

function validateAuthorityStateSeed(
  seed: AuthorityStateSeedV1,
): AuthorityStateSeedV1 {
  const value = seed as unknown as Record<string, unknown>;
  const fields = [
    "authority_id",
    "organization_id",
    "state_lineage_id",
    "owner_principal_id",
    "owner_membership_id",
    "control_plane_id",
  ];
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== fields.sort().join(",")
  ) {
    throw new Error("authority state seed has an invalid shape");
  }
  try {
    assertFederationId(seed.authority_id, "oau", "authority state seed authority_id");
    assertFederationId(
      seed.organization_id,
      "org",
      "authority state seed organization_id",
    );
    assertFederationId(
      seed.owner_principal_id,
      "prn",
      "authority state seed owner_principal_id",
    );
    assertFederationId(
      seed.owner_membership_id,
      "mem",
      "authority state seed owner_membership_id",
    );
  } catch {
    throw new Error("authority state seed has an invalid federation identifier");
  }
  const uuid =
    "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  if (
    !new RegExp(`^lineage-${uuid}$`).test(seed.state_lineage_id) ||
    !new RegExp(`^ocp_${uuid}$`).test(seed.control_plane_id)
  ) {
    throw new Error(
      "authority state seed has an invalid lineage or control-plane identifier",
    );
  }
  return Object.freeze({
    authority_id: seed.authority_id,
    organization_id: seed.organization_id,
    state_lineage_id: seed.state_lineage_id,
    owner_principal_id: seed.owner_principal_id,
    owner_membership_id: seed.owner_membership_id,
    control_plane_id: seed.control_plane_id,
  });
}

function seedAuthority(
  state: StagedAuthorityStateV1,
  input: BootstrapOrganizationAuthorityStateInput,
  seed: AuthorityStateSeedV1,
): {
  readonly descriptor: OrganizationAuthorityDescriptorV1;
  readonly descriptor_sha256: Sha256Digest;
} {
  const signer = FileOrganizationAuthoritySigner.initialize({
    directory: join(state.state_directory, "keys"),
    authority_id: seed.authority_id,
    organization_id: seed.organization_id,
  });
  const descriptor = signer.inspectSync();
  const descriptorSha256 = organizationAuthorityPinSha256(descriptor);
  const database = openAuthorityDatabase(
    join(state.state_directory, "authority.sqlite"),
    { fileMustExist: true },
  );
  try {
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare(
        `INSERT INTO authority_metadata
         (singleton, authority_id, organization_id, organization_display_name,
          descriptor_json, created_at, last_observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        1,
        seed.authority_id,
        seed.organization_id,
        input.organization_display_name,
        canonicalJson(descriptor),
        state.created_at,
        state.created_at,
      );
    database
      .prepare(
        `INSERT INTO authority_principals
         (principal_id, organization_id, display_name, provisioned_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        seed.owner_principal_id,
        seed.organization_id,
        input.owner_display_name,
        state.created_at,
      );
    database
      .prepare(
        `INSERT INTO authority_memberships
         (membership_id, organization_id, principal_id, membership_type,
          status, provisioned_at, revoked_at, revocation_reason)
         VALUES (?, ?, ?, 'owner', 'active', ?, NULL, NULL)`,
      )
      .run(
        seed.owner_membership_id,
        seed.organization_id,
        seed.owner_principal_id,
        state.created_at,
      );
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    database.close();
  }
  return { descriptor, descriptor_sha256: descriptorSha256 };
}

function prepareAuthorityState(
  state: StagedAuthorityStateV1,
  input: BootstrapOrganizationAuthorityStateInput,
  seed: AuthorityStateSeedV1,
  captured: { descriptor_sha256?: Sha256Digest },
): void {
  const authority = seedAuthority(state, input, seed);
  captured.descriptor_sha256 = authority.descriptor_sha256;

  const control = openOrganizationControlDatabase(
    join(state.state_directory, "integrations.sqlite"),
    { fileMustExist: true },
  );
  try {
    control
      .prepare(
        `INSERT INTO organization_control_plane_metadata
         (singleton, control_plane_id, organization_id, authority_id,
          authority_descriptor_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        1,
        seed.control_plane_id,
        seed.organization_id,
        seed.authority_id,
        authority.descriptor_sha256,
        state.created_at,
      );
  } finally {
    control.close();
  }

  const recordLog = openOrganizationRecordDatabase(
    join(state.state_directory, "record-log.sqlite"),
    { fileMustExist: true },
  );
  try {
    recordLog
      .prepare(
        `INSERT INTO organization_record_log_metadata
         (singleton, authority_id, organization_id, state_lineage_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        1,
        seed.authority_id,
        seed.organization_id,
        seed.state_lineage_id,
        state.created_at,
      );
  } finally {
    recordLog.close();
  }

  const derived = openOrganizationRecordDatabase(
    join(state.state_directory, "record-derived.sqlite"),
    { fileMustExist: true },
  );
  try {
    derived.exec("BEGIN IMMEDIATE");
    derived
      .prepare(
        `INSERT INTO organization_derived_metadata
         (singleton, organization_id, created_at) VALUES (?, ?, ?)`,
      )
      .run(1, seed.organization_id, state.created_at);
    derived
      .prepare(
        `INSERT INTO organization_derived_cursor
         (singleton, last_position, updated_at) VALUES (?, ?, ?)`,
      )
      .run(1, 0, state.created_at);
    derived.exec("COMMIT");
  } catch (error) {
    try {
      derived.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    derived.close();
  }
}

function manifestEvidence(
  initialized: InitializedAuthorityStateLineageV1,
): AuthorityStateManifestEvidenceV1 {
  const databaseManifests = Object.fromEntries(
    initialized.verification.databases.map((database) => [
      database.role,
      stateLineageDatabaseManifestSha256V1(database.manifest),
    ]),
  ) as Record<string, Sha256Digest>;
  if (initialized.verification.retrieval.present) {
    throw new Error(
      "authority state initialization unexpectedly published a retrieval generation",
    );
  }
  return Object.freeze({
    root_manifest_sha256: stateLineageRootManifestSha256V1(
      initialized.verification.root,
    ),
    database_manifests: Object.freeze(databaseManifests),
    retrieval_present: false,
  });
}

export function bootstrapOrganizationAuthorityState(
  input: BootstrapOrganizationAuthorityStateInput,
): BootstrappedOrganizationAuthorityStateV1 {
  assertDisplayName(input.organization_display_name);
  assertDisplayName(input.owner_display_name);
  const seed = validateAuthorityStateSeed(
    input.seed ?? generatedAuthorityStateSeed(),
  );
  const captured: { descriptor_sha256?: Sha256Digest } = {};
  const initialized = initializeAuthorityStateLineageV1({
    state_directory: input.state_directory,
    binding: {
      authority_id: seed.authority_id,
      organization_id: seed.organization_id,
      state_lineage_id: seed.state_lineage_id,
    },
    created_at: input.created_at,
    creating_artifact_revision: input.creating_artifact_revision,
    schemas: {
      authority: {
        database_schema_version: AUTHORITY_BASELINE_SCHEMA_VERSION_V4,
        schema_sha256: authorityBaselineSha256V4(),
      },
      "control-plane": {
        database_schema_version:
          ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2,
        schema_sha256: organizationControlBaselineSha256V2(),
      },
      "record-log": {
        database_schema_version:
          ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V2,
        schema_sha256: organizationRecordLogBaselineSha256V2(),
      },
      "record-derived": {
        database_schema_version:
          ORGANIZATION_RECORD_DERIVED_BASELINE_SCHEMA_VERSION_V1,
        schema_sha256: organizationRecordDerivedBaselineSha256V1(),
      },
      "retrieval-facts": {
        database_schema_version:
          READABLE_SEARCH_FACTS_BASELINE_SCHEMA_VERSION_V2,
        schema_sha256: readableSearchPlaneBaselineSha256(
          READABLE_SEARCH_FACTS_BASELINE_V2,
        ),
      },
      "retrieval-lexical": {
        database_schema_version:
          READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
        schema_sha256: readableSearchPlaneBaselineSha256V1(
          READABLE_SEARCH_LEXICAL_BASELINE_V1,
        ),
      },
      "retrieval-content": {
        database_schema_version:
          READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
        schema_sha256: readableSearchPlaneBaselineSha256V1(
          READABLE_SEARCH_CONTENT_BASELINE_V1,
        ),
      },
    },
    top_level_appliers: {
      authority: { apply: applyAuthorityBaselineV4 },
      "control-plane": { apply: applyOrganizationControlBaselineV2 },
      "record-log": { apply: applyOrganizationRecordLogBaselineV2 },
      "record-derived": { apply: applyOrganizationRecordDerivedBaselineV1 },
    },
    open_writable_database: (path, role) => {
      if (role === "authority") return openAuthorityDatabase(path);
      if (role === "control-plane")
        return openOrganizationControlDatabase(path);
      return openOrganizationRecordDatabase(path);
    },
    prepare_staged_state: (state) =>
      prepareAuthorityState(state, input, seed, captured),
  });
  if (captured.descriptor_sha256 === undefined) {
    throw new Error(
      "authority state initialization did not create an authority descriptor",
    );
  }
  return Object.freeze({
    schema_version: 1,
    kind: "echo-organization-authority-clean-reset-state-v1",
    state_directory: initialized.state_directory,
    authority_id: seed.authority_id,
    organization_id: seed.organization_id,
    state_lineage_id: seed.state_lineage_id,
    owner_principal_id: seed.owner_principal_id,
    owner_membership_id: seed.owner_membership_id,
    control_plane_id: seed.control_plane_id,
    authority_descriptor_sha256: captured.descriptor_sha256,
    manifests: manifestEvidence(initialized),
  });
}
