import {
  sha256Digest,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';

const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const CANONICAL_32_BYTE_BASE64URL_PATTERN =
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function isCanonicalOrganizationSlackLinkChallengeCode(
  value: unknown,
): value is string {
  return (
    typeof value === 'string' &&
    CANONICAL_32_BYTE_BASE64URL_PATTERN.test(value)
  );
}

function decodeChallengeCode(code: string): Uint8Array {
  const output = new Uint8Array(32);
  let accumulator = 0;
  let bitCount = 0;
  let outputIndex = 0;
  for (const character of code) {
    accumulator = (accumulator << 6) | BASE64URL_ALPHABET.indexOf(character);
    bitCount += 6;
    while (bitCount >= 8) {
      bitCount -= 8;
      output[outputIndex] = (accumulator >>> bitCount) & 0xff;
      outputIndex += 1;
    }
  }
  if (outputIndex !== output.byteLength) {
    output.fill(0);
    throw new Error(
      'organization API: Slack link challenge code must be canonical unpadded base64url for exactly 32 bytes',
    );
  }
  return output;
}

/** Hashes the decoded 32-byte challenge, never its transport encoding. */
export function organizationSlackLinkChallengeCodeSha256(
  code: string,
): Sha256Digest {
  if (!isCanonicalOrganizationSlackLinkChallengeCode(code)) {
    throw new Error(
      'organization API: Slack link challenge code must be canonical unpadded base64url for exactly 32 bytes',
    );
  }
  const decoded = decodeChallengeCode(code);
  try {
    // federation-protocol's runtime accepts every Uint8Array that Node's hash
    // accepts; its declaration currently names the Buffer subtype.
    return sha256Digest(
      decoded as unknown as Parameters<typeof sha256Digest>[0],
    );
  } finally {
    decoded.fill(0);
  }
}
