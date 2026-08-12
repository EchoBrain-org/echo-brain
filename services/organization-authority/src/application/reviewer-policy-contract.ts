import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import {
  RESTRICTED_REVIEWER_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_POLICY_ID,
} from '@echo-brain/organization-protocol';

/**
 * The one fixed reviewer policy-contract digest.
 *
 * It lives alone in this module so both the read that stamps it into a decision
 * and the audit validator that refuses any other value can depend on the same
 * pure constant without importing each other.
 */
export function reviewerPolicyContractSha256(): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: 'restricted-reviewer-policy-contract-v1',
    policy_id: RESTRICTED_REVIEWER_POLICY_ID,
    consequence_version: 1,
    consequence_text: RESTRICTED_REVIEWER_CONSEQUENCE_TEXT,
    envelope_version: 2,
    action_request_version: 2,
    read_contract_version: 1,
  });
}
