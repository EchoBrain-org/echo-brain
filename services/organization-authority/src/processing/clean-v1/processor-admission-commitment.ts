import type { Sha256Digest } from "@echo-brain/federation-protocol";

const INSTANCE_ID = /^[a-z][a-z0-9-]{0,127}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

/**
 * Provider-neutral processor fact bundle frozen with a live source admission.
 * The preflight is intentionally capability-shaped: it may prove local
 * credentials/configuration are usable, but never exposes credential bytes to
 * the source-admission flow.
 */
export interface CleanProcessorAdmissionCommitmentV1 {
  readonly adapter_id: string;
  readonly instance_id: string;
  readonly version: string;
  readonly configuration_sha256: Sha256Digest;
  readonly credential_reference_sha256: Sha256Digest;
  preflight(): void | Promise<void>;
}

export function assertCleanProcessorAdmissionCommitmentV1(
  commitment: CleanProcessorAdmissionCommitmentV1,
): void {
  if (
    commitment.adapter_id.trim().length === 0 ||
    commitment.adapter_id.length > 128 ||
    !INSTANCE_ID.test(commitment.instance_id) ||
    commitment.version.trim().length === 0 ||
    commitment.version.length > 128 ||
    !SHA256.test(commitment.configuration_sha256) ||
    !SHA256.test(commitment.credential_reference_sha256)
  ) {
    throw new Error("clean processor admission commitment is invalid");
  }
}
