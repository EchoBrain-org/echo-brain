/**
 * The one rule for an owner an approver confirms on a proposed action. The approval core's decide(), its owner
 * proposals and the approved-record codec all use these predicates, so no surface accepts an owner another refuses.
 */

/** Longest confirmed owner, in UTF-16 code units (String.length). */
export const APPROVAL_OWNER_MAX_CHARACTERS_V1 = 120;
/** At most this many confirmed owners in one decision (one per proposed action; no more than 40 are ever proposed). */
export const APPROVAL_OWNERS_MAX_V1 = 40;

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const RECORD_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** Owner text an approver may confirm: trimmed, 1..120 code units, no control or format characters. NFC and single spacing are not required. */
export function isApprovalOwnerTextV1(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= APPROVAL_OWNER_MAX_CHARACTERS_V1
    && value === value.trim() && !CONTROL_OR_FORMAT.test(value);
}

/** A signal id that can appear in a record reference (the record identifier pattern). */
export function isApprovalSignalIdV1(value: unknown): value is string {
  return typeof value === 'string' && RECORD_IDENTIFIER.test(value);
}
