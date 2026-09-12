import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { Sha256Digest } from '@echo-brain/federation-protocol';

/**
 * The one internal atom identity.
 *
 * Permission-fact projection and the retrieval-source snapshot share this
 * identity so the same record and signal produce byte-identical atom IDs.
 * It has no dependency on the retired derived-database materializer.
 */
export function derivedAtomIdentity(
  recordHash: string,
  signalId: string,
): Sha256Digest {
  return canonicalSha256({
    kind: 'echo-organization-record-atom',
    record_hash: recordHash,
    signal_id: signalId,
  });
}
