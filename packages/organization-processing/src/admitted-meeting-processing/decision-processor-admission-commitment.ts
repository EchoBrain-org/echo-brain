import type { Sha256Digest } from "@echo-brain/federation-protocol";

/**
 * Provider-neutral processor fact bundle frozen with a source admission.
 * The preflight is intentionally capability-shaped: it may prove local
 * credentials/configuration are usable, but never exposes credential bytes to
 * the source-admission flow.
 */
export interface DecisionProcessorAdmissionCommitmentV1 {
  readonly adapter_id: string;
  readonly instance_id: string;
  readonly version: string;
  readonly configuration_sha256: Sha256Digest;
  readonly credential_reference_sha256: Sha256Digest;
  preflight(): void | Promise<void>;
}
