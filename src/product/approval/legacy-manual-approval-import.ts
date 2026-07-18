import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertCanonicalDecisionBrief,
  isCanonicalTimestamp,
  type DecisionBrief,
} from '../../core/index.js';
import { parseJson } from '../../util/json.js';
import { decisionApprovalId } from './decision-node.js';

/**
 * Pre-store manual approval record: one mutate-in-place JSON file per
 * approval under `<state>/approvals/`. Read-only here; the decision node
 * store imports these once and never writes the legacy format again.
 */
export interface LegacyManualApprovalRecord {
  schema_version: 1;
  approval_id: string;
  processing_key: string;
  status: 'pending' | 'approved' | 'rejected';
  requested_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  reason: string | null;
  brief: DecisionBrief;
}

const LEGACY_FILE_RE = /^[a-f0-9]{64}\.json$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertLegacyManualApprovalRecord(
  value: unknown,
  file: string,
): LegacyManualApprovalRecord {
  if (!isPlainObject(value)) {
    throw new Error(`invalid manual approval record: ${file}`);
  }
  const record = value as Partial<LegacyManualApprovalRecord>;
  if (
    record.schema_version !== 1 ||
    typeof record.approval_id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.approval_id) ||
    typeof record.processing_key !== 'string' ||
    !['pending', 'approved', 'rejected'].includes(record.status ?? '') ||
    !isCanonicalTimestamp(record.requested_at) ||
    record.brief === null ||
    typeof record.brief !== 'object'
  ) {
    throw new Error(`invalid manual approval record: ${file}`);
  }
  if (record.approval_id !== decisionApprovalId(record.processing_key)) {
    throw new Error(`manual approval identity mismatch: ${file}`);
  }
  if (record.status === 'pending') {
    if (
      record.reviewed_at !== null ||
      record.reviewed_by !== null ||
      record.reason !== null
    ) {
      throw new Error(`invalid pending manual approval record: ${file}`);
    }
  } else if (
    !isCanonicalTimestamp(record.reviewed_at) ||
    typeof record.reviewed_by !== 'string' ||
    record.reviewed_by.length === 0 ||
    !(record.reason === null || typeof record.reason === 'string')
  ) {
    throw new Error(`invalid resolved manual approval record: ${file}`);
  }
  try {
    assertCanonicalDecisionBrief(record.brief);
  } catch {
    throw new Error(`invalid decision brief in manual approval record: ${file}`);
  }
  return record as LegacyManualApprovalRecord;
}

export function readLegacyManualApprovalRecords(
  legacyDirectory: string,
): readonly LegacyManualApprovalRecord[] {
  let entries: string[];
  try {
    entries = readdirSync(legacyDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => LEGACY_FILE_RE.test(entry))
    .sort()
    .map((entry) => {
      const path = join(legacyDirectory, entry);
      const record = assertLegacyManualApprovalRecord(
        parseJson(readFileSync(path, 'utf8')),
        path,
      );
      if (`${record.approval_id}.json` !== entry) {
        throw new Error(`manual approval filename identity mismatch: ${entry}`);
      }
      return record;
    });
}
