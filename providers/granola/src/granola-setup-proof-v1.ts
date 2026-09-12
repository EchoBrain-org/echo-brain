import { readPrivateAuthorityGranolaOrganizationCredential, readPrivateAuthorityGranolaOwnerEmail } from './granola-private-credentials-v1.js';

export function readGranolaSetupCredentialsV1(input: { readonly credential_file: string; readonly owner_email_file: string; readonly expected_owner_email: string }) {
  const credential = readPrivateAuthorityGranolaOrganizationCredential(`file:${input.credential_file}`);
  const owner_email = readPrivateAuthorityGranolaOwnerEmail(`file:${input.owner_email_file}`);
  if (owner_email !== input.expected_owner_email) throw new Error('Granola owner email does not match the initial-owner setup email');
  return { credential, owner_email };
}
export function granolaSetupAdmissionProofV1(value: { readonly source_adapter_id: unknown; readonly source_adapter_instance_id: unknown; readonly source_custodian_assurance: unknown; readonly source_custodian_observed_at: unknown } | undefined, instanceId: string) {
  if (value?.source_adapter_id !== 'granola' || value.source_adapter_instance_id !== instanceId ||
      value.source_custodian_assurance !== 'provider_record_owner_observed' || typeof value.source_custodian_observed_at !== 'string') return undefined;
  return Object.freeze({ owner_observation_assurance: 'provider_record_owner_observed' as const, owner_observed_at: value.source_custodian_observed_at });
}
