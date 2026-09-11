import {
  privateAuthorityCredentialFailure as fail,
  readPrivateAuthorityCredential,
  readPrivateAuthorityVisibleAsciiCredential,
} from '../../../adapters/security/private-file-credentials.js';

export function readPrivateAuthorityGranolaOrganizationCredential(
  reference: string,
): string {
  const value = readPrivateAuthorityCredential(reference);
  if (!/^grn_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    fail('Granola organization credential has an invalid format');
  }
  return value;
}

export function readPrivateAuthorityGranolaOwnerEmail(
  reference: string,
): string {
  const value = readPrivateAuthorityVisibleAsciiCredential(reference, 3);
  const [local, domain, extra] = value.split('@');
  if (
    value !== value.trim().toLowerCase() ||
    value.length > 254 ||
    /\s/u.test(value) ||
    local === undefined ||
    local.length === 0 ||
    domain === undefined ||
    domain.length === 0 ||
    extra !== undefined
  ) {
    fail('Granola owner email must be canonical lowercase email');
  }
  return value;
}
