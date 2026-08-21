import {
  assertUtcMillisecondTimestamp,
  canonicalJson,
  parseCanonicalJson,
  type JsonValue,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';
import type Database from 'better-sqlite3';
import type { OrganizationRecordLogRow } from '../application/contracts.js';
import {
  ORGANIZATION_PERMISSION_PILOT_POLICY_ID,
  ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID,
  assertOrganizationPermissionPilotPresentation,
  organizationPermissionPilotAudienceNoticeSha256,
  organizationPermissionPilotCommandSha256,
  organizationPermissionPilotPresentation,
  validateOrganizationPermissionPilotActivationCommand,
  validateOrganizationPermissionPilotAudience,
  type OrganizationPermissionPilotActivationCommandV1,
  type OrganizationPermissionPilotActivationMarkerV1,
  type OrganizationPermissionPilotEligibilityProofV1,
} from '../application/permission-pilot.js';
import {
  toOrganizationRecordLogRow,
  type RawOrganizationRecordLogRow,
} from '../application/log-row.js';
import { verifyOrganizationRecordChain } from './chain-verification.js';
import { ORGANIZATION_RECORD_LOG_DATABASE } from '../persistence/database-definition.js';
import { openAndMigrateOrganizationRecordDatabase } from '../persistence/open-database.js';

interface StoredActivationRow {
  organization_id: string;
  command_id: string;
  command_sha256: string;
  policy_id: string;
  presentation_policy_id: string;
  audience_json: string;
  presentation_descriptor_json: string;
  audience_notice_sha256: string;
  activated_at: string;
  effective_after_position: number;
  effective_after_record_hash: string | null;
}

export interface OrganizationPermissionPilotActivationResult {
  readonly created: boolean;
  readonly marker: OrganizationPermissionPilotActivationMarkerV1;
}

function readRows(database: Database.Database): OrganizationRecordLogRow[] {
  return (
    database
      .prepare('SELECT * FROM organization_record_log ORDER BY position')
      .all() as RawOrganizationRecordLogRow[]
  ).map(toOrganizationRecordLogRow);
}

function storedActivation(database: Database.Database): StoredActivationRow | undefined {
  return database
    .prepare(
      `SELECT organization_id, command_id, command_sha256, policy_id,
              presentation_policy_id, audience_json,
              presentation_descriptor_json, audience_notice_sha256,
              activated_at, effective_after_position,
              effective_after_record_hash
       FROM organization_record_permission_pilot_activation
       WHERE singleton = 1`,
    )
    .get() as StoredActivationRow | undefined;
}

export function readOrganizationPermissionPilotActivation(
  database: Database.Database,
  organizationId: string,
): OrganizationPermissionPilotActivationMarkerV1 | null {
  const row = storedActivation(database);
  return row === undefined
    ? null
    : organizationPermissionPilotMarkerFromStored(
        database,
        organizationId,
        row,
      );
}

export function organizationPermissionPilotMarkerFromStored(
  database: Database.Database,
  organizationId: string,
  row: StoredActivationRow,
): OrganizationPermissionPilotActivationMarkerV1 {
  if (
    row.organization_id !== organizationId ||
    !/^ppa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      row.command_id,
    ) ||
    !/^sha256:[0-9a-f]{64}$/.test(row.command_sha256) ||
    row.policy_id !== ORGANIZATION_PERMISSION_PILOT_POLICY_ID ||
    row.presentation_policy_id !==
      ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID ||
    !/^sha256:[0-9a-f]{64}$/.test(row.audience_notice_sha256) ||
    !Number.isSafeInteger(row.effective_after_position) ||
    row.effective_after_position < 0
  ) {
    throw new Error('organization permission pilot activation marker is invalid');
  }
  assertUtcMillisecondTimestamp(
    row.activated_at,
    'organization permission pilot activated_at',
  );
  const audience = validateOrganizationPermissionPilotAudience(
    parseCanonicalJson<JsonValue>(row.audience_json),
  );
  if (canonicalJson(audience) !== row.audience_json) {
    throw new Error('organization permission pilot activation audience is not canonical');
  }
  const presentationValue = parseCanonicalJson<JsonValue>(
    row.presentation_descriptor_json,
  );
  const presentation = assertOrganizationPermissionPilotPresentation(
    presentationValue,
    audience,
  );
  if (canonicalJson(presentation) !== row.presentation_descriptor_json) {
    throw new Error('organization permission pilot presentation bytes are not canonical');
  }
  if (
    organizationPermissionPilotAudienceNoticeSha256(presentation) !==
    row.audience_notice_sha256
  ) {
    throw new Error('organization permission pilot audience notice digest is invalid');
  }
  if (row.effective_after_position === 0) {
    if (row.effective_after_record_hash !== null) {
      throw new Error('organization permission pilot empty-log boundary is invalid');
    }
  } else {
    const boundary = database
      .prepare(
        `SELECT record_hash FROM organization_record_log WHERE position = ?`,
      )
      .get(row.effective_after_position) as { record_hash: string } | undefined;
    if (
      boundary === undefined ||
      !/^sha256:[0-9a-f]{64}$/.test(row.effective_after_record_hash ?? '') ||
      boundary.record_hash !== row.effective_after_record_hash
    ) {
      throw new Error('organization permission pilot activation boundary is invalid');
    }
  }
  return Object.freeze({
    organization_id: row.organization_id,
    command_id: row.command_id,
    command_sha256: row.command_sha256 as Sha256Digest,
    policy_id: ORGANIZATION_PERMISSION_PILOT_POLICY_ID,
    presentation_policy_id: ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID,
    audience,
    presentation_descriptor: presentation,
    audience_notice_sha256: row.audience_notice_sha256 as Sha256Digest,
    activated_at: row.activated_at,
    effective_after_position: row.effective_after_position,
    effective_after_record_hash:
      row.effective_after_record_hash as Sha256Digest | null,
  });
}

/**
 * The stopped-state writer for the one pilot activation.
 *
 * It owns no Authority state. The operator composition verifies the two live
 * memberships first, then this class serializes activation against the record
 * head in the same database transaction that inserts the immutable marker.
 */
export class OrganizationPermissionPilotLog {
  private closed = false;

  private constructor(
    readonly database: Database.Database,
    readonly organization_id: string,
    readonly authority_id: string,
  ) {}

  static open(
    databasePath: string,
    options: { readonly organization_id: string; readonly authority_id: string },
  ): OrganizationPermissionPilotLog {
    const database = openAndMigrateOrganizationRecordDatabase(
      databasePath,
      ORGANIZATION_RECORD_LOG_DATABASE,
      { fileMustExist: true },
    );
    try {
      const metadata = database
        .prepare(
          `SELECT organization_id, authority_id
           FROM organization_record_log_metadata WHERE singleton = 1`,
        )
        .get() as
        | { organization_id: string; authority_id: string }
        | undefined;
      if (
        metadata === undefined ||
        metadata.organization_id !== options.organization_id ||
        metadata.authority_id !== options.authority_id
      ) {
        throw new Error(
          'organization permission pilot log belongs to a different organization or authority',
        );
      }
      return new OrganizationPermissionPilotLog(
        database,
        options.organization_id,
        options.authority_id,
      );
    } catch (error) {
      database.close();
      throw error;
    }
  }

  activation(): OrganizationPermissionPilotActivationMarkerV1 | null {
    this.assertOpen();
    return readOrganizationPermissionPilotActivation(
      this.database,
      this.organization_id,
    );
  }

  activate(input: {
    readonly command: OrganizationPermissionPilotActivationCommandV1;
    readonly command_sha256: Sha256Digest;
    readonly activated_at: string;
  }): OrganizationPermissionPilotActivationResult {
    this.assertOpen();
    const command = validateOrganizationPermissionPilotActivationCommand(
      input.command,
      {
        organization_id: this.organization_id,
        authority_id: this.authority_id,
      },
    );
    if (organizationPermissionPilotCommandSha256(command) !== input.command_sha256) {
      throw new Error('organization permission pilot command digest is invalid');
    }
    assertUtcMillisecondTimestamp(
      input.activated_at,
      'organization permission pilot activated_at',
    );

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = storedActivation(this.database);
      if (existing !== undefined) {
        const marker = organizationPermissionPilotMarkerFromStored(
          this.database,
          this.organization_id,
          existing,
        );
        if (
          marker.command_id !== command.command_id ||
          marker.command_sha256 !== input.command_sha256
        ) {
          throw new Error(
            'organization permission pilot is already activated by a different command',
          );
        }
        this.database.exec('COMMIT');
        return Object.freeze({ created: false, marker });
      }

      const verification = verifyOrganizationRecordChain({
        organization_id: this.organization_id,
        authority_id: this.authority_id,
        rows: () => readRows(this.database),
      });
      if (verification.failures.length > 0) {
        throw new Error(
          `organization record log chain verification failed before permission pilot activation: ${verification.failures
            .map(
              (failure) =>
                `${failure.position}:${failure.kind}:${failure.detail}`,
            )
            .join('; ')}`,
        );
      }
      const presentation = organizationPermissionPilotPresentation(
        command.audience,
      );
      const audienceNoticeSha256 =
        organizationPermissionPilotAudienceNoticeSha256(presentation);
      const effectiveAfterPosition = verification.head_position ?? 0;
      const effectiveAfterRecordHash = verification.head_record_hash;
      this.database
        .prepare(
          `INSERT INTO organization_record_permission_pilot_activation (
             singleton, organization_id, command_id, command_sha256,
             policy_id, presentation_policy_id, audience_json,
             presentation_descriptor_json, audience_notice_sha256,
             activated_at, effective_after_position,
             effective_after_record_hash
           ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.organization_id,
          command.command_id,
          input.command_sha256,
          command.policy_id,
          command.presentation_policy_id,
          canonicalJson(command.audience),
          canonicalJson(presentation),
          audienceNoticeSha256,
          input.activated_at,
          effectiveAfterPosition,
          effectiveAfterRecordHash,
        );
      const marker = this.activation();
      if (marker === null) {
        throw new Error('organization permission pilot activation was not stored');
      }
      this.database.exec('COMMIT');
      return Object.freeze({ created: true, marker });
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('organization permission pilot log is closed');
  }
}

/** Inserts the notice-qualified pointer inside the caller's append transaction. */
export function appendOrganizationPermissionPilotEligibility(
  database: Database.Database,
  row: Pick<OrganizationRecordLogRow, 'position' | 'record_hash'>,
  proof: OrganizationPermissionPilotEligibilityProofV1 | undefined,
): void {
  if (proof === undefined) return;
  const activation = storedActivation(database);
  if (
    activation === undefined ||
    row.position <= activation.effective_after_position ||
    proof.policy_id !== activation.policy_id ||
    proof.presentation_policy_id !== activation.presentation_policy_id ||
    proof.audience_notice_sha256 !== activation.audience_notice_sha256
  ) {
    throw new Error(
      'verified organization permission pilot eligibility does not match the active post-boundary policy',
    );
  }
  database
    .prepare(
      `INSERT INTO organization_record_permission_pilot_eligibility (
         position, record_hash, policy_id, presentation_policy_id,
         audience_notice_sha256, message_presentation_sha256
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.position,
      row.record_hash,
      proof.policy_id,
      proof.presentation_policy_id,
      proof.audience_notice_sha256,
      proof.message_presentation_sha256,
    );
}
