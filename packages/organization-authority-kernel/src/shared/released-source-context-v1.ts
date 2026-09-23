import type { Sha256Digest } from "@echo-brain/federation-protocol";

/**
 * Model-free Layer-3 evidence packet for one immutable Person source
 * representation anchor. It deliberately has no answer-composition imports.
 */
export interface ReleasedSourceContextAtomV1 {
  readonly kind: "source_revision";
  readonly source_id: string;
  readonly revision_id: string;
  readonly source_sha256: Sha256Digest;
  readonly representation_sha256: Sha256Digest;
  readonly anchor_sha256: Sha256Digest;
  readonly document_id?: string;
  readonly label?: string;
  readonly text: string;
}
