/**
 * The one rule for an owner an approver confirms on a proposed action. The approval core's decide(), its owner
 * proposals and the approved-record codec all use these predicates, so no surface accepts an owner another refuses.
 */

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const RECORD_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/**
 * Owner text an approver may confirm: non-empty, trimmed, no control or format characters. It has no length of its own;
 * the request that carries it bounds it. NFC and single spacing are not required.
 */
export function isApprovalOwnerTextV1(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value === value.trim() && !CONTROL_OR_FORMAT.test(value);
}

/** A signal id that can appear in a record reference (the record identifier pattern). */
export function isApprovalSignalIdV1(value: unknown): value is string {
  return typeof value === 'string' && RECORD_IDENTIFIER.test(value);
}
