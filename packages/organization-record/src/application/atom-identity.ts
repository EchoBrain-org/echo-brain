import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { Sha256Digest } from '@echo-brain/federation-protocol';

/**
 * The one internal atom identity.
 *
 * It lives in the pure application layer because two callers need it and
 * neither may import the other: `derive/identity.ts` builds derived rows with
 * it, and the reviewer fact plane stores it as an opaque, never-published
 * address. Reviewer V1 introduces no new atom-ID scheme, so both must produce
 * byte-identical digests — one implementation is the only way to guarantee it.
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
