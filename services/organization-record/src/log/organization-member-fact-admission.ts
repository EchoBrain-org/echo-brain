import type Database from 'better-sqlite3';
import type { OrganizationRecordLogRow } from '../application/contracts.js';
import {
  isOrganizationMemberReadableEnvelopeDocument,
  organizationMemberPolicyFactSetSha256,
  projectOrganizationMemberPolicyFacts,
  readOrganizationMemberReadableEnvelope,
  type OrganizationMemberReadableEnvelopeValidator,
} from '../application/organization-member-policy-fact.js';
import { readCanonicalRecordEnvelope } from '../application/reviewer-policy-fact.js';
import { toOrganizationRecordLogRow, type RawOrganizationRecordLogRow } from '../application/log-row.js';
import { readOrganizationMemberPolicyFactsAtPosition } from './organization-member-policy-fact.js';

export interface OrganizationMemberFactAdmission {
  readonly admitted: boolean;
  readonly records_verified: number;
  readonly facts_verified: number;
  readonly failures: readonly { readonly position: number | null; readonly detail: string }[];
}

/**
 * Structural startup admission for the v3 fact family.  Authority performs
 * the separate exact-ID audit reproof above this port; record verifies only
 * canonical Layer 1 bytes, injected closed validation, and complete pure fact
 * reprojection.  It never repairs or backfills facts.
 */
export function verifyOrganizationMemberFactAdmission(
  database: Database.Database,
  input: { readonly organization_id: string; readonly validator?: OrganizationMemberReadableEnvelopeValidator },
): OrganizationMemberFactAdmission {
  const failures: { position: number | null; detail: string }[] = [];
  let records_verified = 0;
  let facts_verified = 0;
  const rows = database.prepare('SELECT * FROM organization_record_log ORDER BY position').all()
    .map((row) => toOrganizationRecordLogRow(row as RawOrganizationRecordLogRow));
  const orphans = database.prepare(
    `SELECT DISTINCT fact.log_position FROM organization_member_readable_policy_fact AS fact
     LEFT JOIN organization_record_log AS record ON record.position = fact.log_position AND record.record_hash = fact.record_hash
     WHERE record.position IS NULL`,
  ).all() as { log_position: number }[];
  for (const orphan of orphans) failures.push({ position: orphan.log_position, detail: 'organization-member facts reference no exact canonical record' });
  for (const row of rows as OrganizationRecordLogRow[]) {
    let document: ReturnType<typeof readCanonicalRecordEnvelope>;
    try { document = readCanonicalRecordEnvelope(row); } catch (error) {
      failures.push({ position: row.position, detail: error instanceof Error ? error.message : 'canonical record is unreadable' });
      continue;
    }
    const facts = readOrganizationMemberPolicyFactsAtPosition(database, row.position);
    if (!isOrganizationMemberReadableEnvelopeDocument(document)) {
      if (facts.length > 0) failures.push({ position: row.position, detail: 'non-v3 record carries organization-member facts' });
      continue;
    }
    records_verified += 1;
    try {
      const envelope = readOrganizationMemberReadableEnvelope(document, input.validator);
      const expected = projectOrganizationMemberPolicyFacts({
        organization_id: input.organization_id,
        log_position: row.position,
        record_hash: row.record_hash,
        envelope_sha256: row.envelope_sha256,
        envelope,
      });
      if (facts.length !== expected.length ||
        organizationMemberPolicyFactSetSha256(facts) !== organizationMemberPolicyFactSetSha256(expected)) {
        failures.push({ position: row.position, detail: 'organization-member facts do not reproject from canonical Layer 1' });
      } else {
        facts_verified += facts.length;
      }
    } catch (error) {
      failures.push({ position: row.position, detail: error instanceof Error ? error.message : 'organization-member record is unreadable' });
    }
  }
  return Object.freeze({
    admitted: failures.length === 0,
    records_verified,
    facts_verified,
    failures: Object.freeze(failures),
  });
}
