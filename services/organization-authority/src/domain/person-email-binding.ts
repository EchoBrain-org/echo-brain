import {
  canonicalSha256,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';

export function personLoginGrantExpectedEmailDigestInput(
  expectedEmail: string,
) {
  return Object.freeze({
    schema_version: 1,
    kind: 'authority-person-login-grant-expected-email-v1',
    expected_email: expectedEmail,
  } as const);
}

export function personLoginGrantExpectedEmailSha256(
  expectedEmail: string,
): Sha256Digest {
  return canonicalSha256(
    personLoginGrantExpectedEmailDigestInput(expectedEmail),
  );
}
