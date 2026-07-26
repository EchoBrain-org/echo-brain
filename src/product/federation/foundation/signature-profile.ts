/**
 * Product compatibility surface for the portable P-256 signature profile.
 * Key-provider lifecycle remains in the product foundation.
 */
export {
  assertP256LowS,
  decodeStrictP256DerSignature,
  encodeP256DerSignature,
  normalizeP256LowS,
  p256KeyId,
  verifyP256LowSSignature,
} from '@echo-brain/federation-protocol';
export type { DecodedEcdsaSignature } from '@echo-brain/federation-protocol';
