import type { JsonObject } from "@echo-brain/federation-protocol";

/** Derived identity only; never a new signed record or an authorization grant. */
export interface RecordApproverV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
}

/**
 * Projects an already permission-filtered record using its exact resolution
 * protocol. Unknown/unsupported records have no optional approver metadata.
 * Implementations do not resolve names or authorize reads.
 */
export type RecordApproverProjectorV1 = (
  envelope: JsonObject,
) => RecordApproverV1 | undefined;

/** Retain historical protocols alongside current ones; ambiguous matches omit metadata. */
export function composeRecordApproverProjectorsV1(
  projectors: readonly RecordApproverProjectorV1[],
): RecordApproverProjectorV1 {
  const retained = Object.freeze([...new Set(projectors)]);
  return (envelope) => {
    let result: RecordApproverV1 | undefined;
    for (const project of retained) {
      const candidate = project(envelope);
      if (candidate === undefined) continue;
      if (result !== undefined) return undefined;
      result = candidate;
    }
    return result;
  };
}
