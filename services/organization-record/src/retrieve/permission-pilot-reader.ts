import type Database from 'better-sqlite3';
import type { OrganizationRecordLogRow } from '../application/contracts.js';
import {
  ORGANIZATION_PERMISSION_PILOT_RECORD_SCAN_LIMIT,
  assertOrganizationPermissionPilotProofBinding,
  validateOrganizationPermissionPilotEligibilityProof,
  type OrganizationPermissionPilotActivationMarkerV1,
  type OrganizationPermissionPilotEligibilityProofV1,
} from '../application/permission-pilot.js';
import {
  toOrganizationRecordLogRow,
  type RawOrganizationRecordLogRow,
} from '../application/log-row.js';
import { parseOrganizationRecordEnvelope } from '../application/record-frame.js';
import { readOrganizationPermissionPilotActivation } from '../log/permission-pilot.js';

interface JoinedEligibilityRow extends RawOrganizationRecordLogRow {
  eligibility_record_hash: string;
  eligibility_policy_id: string;
  eligibility_presentation_policy_id: string;
  eligibility_audience_notice_sha256: string;
  eligibility_message_presentation_sha256: string;
}

export interface OrganizationPermissionPilotEligibleRecord {
  readonly row: OrganizationRecordLogRow;
  readonly eligibility: OrganizationPermissionPilotEligibilityProofV1;
}

export interface OrganizationPermissionPilotValidatedState {
  readonly activation: OrganizationPermissionPilotActivationMarkerV1 | null;
  readonly eligible_records: readonly OrganizationPermissionPilotEligibleRecord[];
}

const JOINED_COLUMNS = `
  record.position,
  record.envelope_id,
  record.event_type,
  record.installation_id,
  record.idempotency_key,
  record.canonical_envelope,
  record.envelope_sha256,
  record.receipt_payload,
  record.previous_record_hash,
  record.record_hash,
  record.recorded_at,
  eligibility.record_hash AS eligibility_record_hash,
  eligibility.policy_id AS eligibility_policy_id,
  eligibility.presentation_policy_id AS eligibility_presentation_policy_id,
  eligibility.audience_notice_sha256 AS eligibility_audience_notice_sha256,
  eligibility.message_presentation_sha256 AS eligibility_message_presentation_sha256`;

/**
 * The pilot's bounded read side over the canonical log.
 *
 * It never calls append or trusts the disposable derived database. Startup
 * validates the complete tiny eligibility index once; each later bounded read
 * still rechecks the selected immutable row/proof binding before returning it.
 */
export class OrganizationPermissionPilotReader {
  private validatedActivation:
    | OrganizationPermissionPilotActivationMarkerV1
    | null
    | undefined;

  constructor(
    private readonly database: Database.Database,
    private readonly options: { readonly organization_id: string },
  ) {}

  validateState(): OrganizationPermissionPilotValidatedState {
    // A failed revalidation always leaves the public reader inactive.
    this.validatedActivation = null;
    const activation = readOrganizationPermissionPilotActivation(
      this.database,
      this.options.organization_id,
    );
    const rows = this.database
      .prepare(
        `SELECT ${JOINED_COLUMNS}
         FROM organization_record_permission_pilot_eligibility AS eligibility
         LEFT JOIN organization_record_log AS record
           ON record.position = eligibility.position
         ORDER BY eligibility.position`,
      )
      .all() as JoinedEligibilityRow[];
    if (activation === null) {
      if (rows.length > 0) {
        throw new Error(
          'organization permission pilot eligibility exists without activation',
        );
      }
      return Object.freeze({ activation: null, eligible_records: Object.freeze([]) });
    }
    const eligibleRecords = rows.map((row) =>
      this.validateEligibleRecord(row, activation),
    );
    this.validatedActivation = activation;
    return Object.freeze({
      activation,
      eligible_records: Object.freeze(eligibleRecords),
    });
  }

  get activation(): OrganizationPermissionPilotActivationMarkerV1 | null {
    return this.validatedActivation ?? null;
  }

  readEligibleRecordsDescending(): readonly OrganizationPermissionPilotEligibleRecord[] {
    const activation = this.validatedActivation;
    if (activation === undefined) {
      throw new Error('organization permission pilot reader has not passed startup validation');
    }
    if (activation === null) return Object.freeze([]);
    const rows = this.database
      .prepare(
        `SELECT ${JOINED_COLUMNS}
         FROM organization_record_permission_pilot_eligibility AS eligibility
         JOIN organization_record_log AS record
           ON record.position = eligibility.position
          AND record.record_hash = eligibility.record_hash
         WHERE eligibility.position > ?
           AND eligibility.policy_id = ?
           AND eligibility.presentation_policy_id = ?
           AND eligibility.audience_notice_sha256 = ?
         ORDER BY eligibility.position DESC
         LIMIT ?`,
      )
      .all(
        activation.effective_after_position,
        activation.policy_id,
        activation.presentation_policy_id,
        activation.audience_notice_sha256,
        ORGANIZATION_PERMISSION_PILOT_RECORD_SCAN_LIMIT,
      ) as JoinedEligibilityRow[];
    return Object.freeze(
      rows.map((row) => this.validateEligibleRecord(row, activation)),
    );
  }

  private validateEligibleRecord(
    raw: JoinedEligibilityRow,
    activation: OrganizationPermissionPilotActivationMarkerV1,
  ): OrganizationPermissionPilotEligibleRecord {
    if (
      !Number.isSafeInteger(raw.position) ||
      raw.position <= activation.effective_after_position ||
      raw.event_type !== 'approval' ||
      raw.record_hash !== raw.eligibility_record_hash
    ) {
      throw new Error('organization permission pilot eligibility record binding is invalid');
    }
    const eligibility = validateOrganizationPermissionPilotEligibilityProof({
      policy_id: raw.eligibility_policy_id,
      presentation_policy_id: raw.eligibility_presentation_policy_id,
      audience_notice_sha256: raw.eligibility_audience_notice_sha256,
      message_presentation_sha256:
        raw.eligibility_message_presentation_sha256,
    });
    if (
      eligibility.policy_id !== activation.policy_id ||
      eligibility.presentation_policy_id !== activation.presentation_policy_id ||
      eligibility.audience_notice_sha256 !== activation.audience_notice_sha256
    ) {
      throw new Error('organization permission pilot eligibility differs from activation');
    }
    const row = toOrganizationRecordLogRow(raw);
    assertOrganizationPermissionPilotProofBinding(
      parseOrganizationRecordEnvelope(row.canonical_envelope),
      eligibility,
    );
    return Object.freeze({ row, eligibility });
  }
}
