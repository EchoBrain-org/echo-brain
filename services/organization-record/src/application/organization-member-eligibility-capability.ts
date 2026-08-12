import type { Sha256Digest } from './contracts.js';
import {
  organizationMemberFactUnavailable,
  organizationMemberReadableEligibilityProofSha256,
  validateOrganizationMemberReadableEligibilityProofPreimage,
  type OrganizationMemberReadableEligibilityProofPreimage,
} from './organization-member-policy-fact.js';

const BRAND: unique symbol = Symbol('echo-organization-member-readable-eligibility');

/** Opaque, non-serializable, single-use Authority-to-log append authority. */
export interface OrganizationMemberReadableEligibilityCapabilityV1 {
  readonly [BRAND]: true;
}

export interface OrganizationMemberEligibilityExpectation {
  readonly organization_id: string;
  readonly envelope_id: string;
  readonly idempotency_key: string;
  readonly installation_id: string;
  readonly canonical_envelope_sha256: Sha256Digest;
}

export interface OrganizationMemberEligibilityCapabilityChannel {
  issue(
    preimage: OrganizationMemberReadableEligibilityProofPreimage,
  ): OrganizationMemberReadableEligibilityCapabilityV1;
  consume(
    capability: OrganizationMemberReadableEligibilityCapabilityV1,
    expected: OrganizationMemberEligibilityExpectation,
  ): Readonly<{
    preimage: OrganizationMemberReadableEligibilityProofPreimage;
    authorization_proof_sha256: Sha256Digest;
  }>;
}

export interface OrganizationMemberPolicyFactAppendInput {
  readonly capability: OrganizationMemberReadableEligibilityCapabilityV1;
  readonly channel: OrganizationMemberEligibilityCapabilityChannel;
}

interface Binding {
  readonly preimage: OrganizationMemberReadableEligibilityProofPreimage;
  readonly authorization_proof_sha256: Sha256Digest;
  readonly channel: object;
  spent: boolean;
}

/** A channel is intentionally process- and ingest-instance-local. */
export function createOrganizationMemberEligibilityCapabilityChannel(): OrganizationMemberEligibilityCapabilityChannel {
  const bindings = new WeakMap<object, Binding>();
  const channel = Object.freeze({});
  return Object.freeze({
    issue(preimage: OrganizationMemberReadableEligibilityProofPreimage) {
      const validated = validateOrganizationMemberReadableEligibilityProofPreimage(preimage);
      const token = Object.freeze({});
      bindings.set(token, {
        preimage: validated,
        authorization_proof_sha256:
          organizationMemberReadableEligibilityProofSha256(validated),
        channel,
        spent: false,
      });
      return token as OrganizationMemberReadableEligibilityCapabilityV1;
    },
    consume(
      capability: OrganizationMemberReadableEligibilityCapabilityV1,
      expected: OrganizationMemberEligibilityExpectation,
    ) {
      if (typeof capability !== 'object' || capability === null) {
        organizationMemberFactUnavailable('organization-member eligibility capability is not live');
      }
      const binding = bindings.get(capability as unknown as object);
      if (binding === undefined || binding.channel !== channel) {
        organizationMemberFactUnavailable('organization-member eligibility capability is forged or belongs to another channel');
      }
      if (binding.spent) {
        organizationMemberFactUnavailable('organization-member eligibility capability was already consumed');
      }
      binding.spent = true;
      const proof = binding.preimage;
      if (
        proof.organization_id !== expected.organization_id ||
        proof.envelope_id !== expected.envelope_id ||
        proof.idempotency_key !== expected.idempotency_key ||
        proof.installation_id !== expected.installation_id ||
        proof.canonical_envelope_sha256 !== expected.canonical_envelope_sha256
      ) {
        organizationMemberFactUnavailable('organization-member eligibility capability was minted for another append attempt');
      }
      const authorization_proof_sha256 =
        organizationMemberReadableEligibilityProofSha256(proof);
      if (authorization_proof_sha256 !== binding.authorization_proof_sha256) {
        organizationMemberFactUnavailable('organization-member eligibility capability proof digest is indeterminate');
      }
      return Object.freeze({ preimage: proof, authorization_proof_sha256 });
    },
  });
}
