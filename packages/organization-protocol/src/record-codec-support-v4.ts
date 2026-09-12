/** Shared validation primitives for strict, provider-owned V4 input codecs. */
export { assertDigest, assertPositiveSafeInteger, canonicalSnapshot } from './validation-support.js';
export { organizationProtocolValidationFailure } from './validation-error.js';
export { approvedDecisionSnapshotV2Sha256, validateApprovedDecisionSnapshotV2, type ApprovedDecisionSnapshotV2 } from './human-act-record-input-v1.js';
