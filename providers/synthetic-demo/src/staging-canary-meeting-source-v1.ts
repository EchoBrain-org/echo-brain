import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { STAGING_AUTHORITY_ORIGIN_V1 } from '@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1';
import type { DecisionProcessorAdmissionCommitmentV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/decision-processor-admission-commitment';
import type { MeetingSourceBundleV1 } from '@echo-brain/organization-processing/ports/meeting-source-bundle-v1';
import { admitSyntheticMeetingSourceV1 } from './synthetic-demo-meeting-source-admission.js';

export const stagingCanaryMeetingSourceIdentityV1 = Object.freeze({
  kind: 'meeting-source' as const,
  adapter_id: 'staging-canary-source',
  instance_id: 'release-canary',
  version: '1.0.0',
});
export const STAGING_CANARY_IDLE_CURSOR_V1 = 'staging-canary-source:release-canary:v1:idle';
const infrastructureDigest = canonicalSha256({ kind: 'echo-staging-canary-infrastructure-v1' });

function staging(authorityUrl: string): void {
  if (authorityUrl !== STAGING_AUTHORITY_ORIGIN_V1) {
    throw new Error('synthetic canary infrastructure is allowed only on the staging Authority');
  }
}

/** Admits infrastructure only; release-bound content still requires the canary request. */
export async function admitStagingCanaryMeetingSourceV1(input: {
  readonly state_directory: string;
  readonly authority_url: string;
  readonly processor: DecisionProcessorAdmissionCommitmentV1;
  readonly now?: () => string;
}): Promise<void> {
  staging(input.authority_url);
  await admitSyntheticMeetingSourceV1({
    ...input,
    corpus: { meetings: [], corpus_digest: infrastructureDigest },
    source: stagingCanaryMeetingSourceIdentityV1,
    initial_cursor: STAGING_CANARY_IDLE_CURSOR_V1,
    semantic_kind: 'echo-staging-canary-infrastructure-admission-v1',
  });
}

/** This source never discovers data. The existing private canary control supplies content. */
export function createStagingCanaryMeetingSourceBundleV1(authorityUrl: string): MeetingSourceBundleV1 {
  staging(authorityUrl);
  let checked = false;
  const assertCursor = (cursor: string): void => {
    if (cursor !== STAGING_CANARY_IDLE_CURSOR_V1) throw new Error('staging canary cursor is invalid');
  };
  return Object.freeze({
    assert_admission_commitments(commitments) {
      const source = commitments.source;
      if (source.adapter_id !== stagingCanaryMeetingSourceIdentityV1.adapter_id ||
          source.instance_id !== stagingCanaryMeetingSourceIdentityV1.instance_id ||
          source.version !== stagingCanaryMeetingSourceIdentityV1.version ||
          source.credential_reference_sha256 !== infrastructureDigest) {
        throw new Error('staging canary infrastructure differs from its admission');
      }
      checked = true;
    },
    source_cursor_policy: {
      source_adapter_id: stagingCanaryMeetingSourceIdentityV1.adapter_id,
      assert_live_cursor: assertCursor,
    },
    create_source(admission) {
      if (!checked || admission.source.adapter_id !== stagingCanaryMeetingSourceIdentityV1.adapter_id ||
          admission.source.instance_id !== stagingCanaryMeetingSourceIdentityV1.instance_id ||
          admission.source.version !== stagingCanaryMeetingSourceIdentityV1.version) {
        throw new Error('staging canary infrastructure was not admitted');
      }
      return {
        identity: stagingCanaryMeetingSourceIdentityV1,
        validateConfig: () => ({ ok: true, errors: [] }),
        healthCheck: async () => ({ status: 'healthy', checked_at: new Date().toISOString() }),
        async pull(request) {
          if (request.cursor !== undefined) assertCursor(request.cursor);
          return { meetings: [], next_cursor: request.cursor ?? STAGING_CANARY_IDLE_CURSOR_V1 };
        },
      };
    },
  } satisfies MeetingSourceBundleV1);
}
