/**
 * Product compatibility surface for the portable federation protocol.
 * Canonicalization and digest behavior are owned by federation-protocol.
 */
export {
  CanonicalJsonError,
  canonicalJson,
  canonicalJsonBytes,
  canonicalSha256,
  parseCanonicalJson,
  sha256Digest,
} from '@echo-brain/federation-protocol';
