import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import type { MeetingDocument } from '../core/contracts/meeting.js';
import type { AdmittedMeetingSourceCursorPolicyV1 } from './admitted-meeting-source-cursor-policy-v1.js';

export const PERSON_UPDATE_SOURCE_ADAPTER_V1 = 'person-update-inbox-v1';
export const personUpdateCursorPolicyV1: AdmittedMeetingSourceCursorPolicyV1 = Object.freeze({
  source_adapter_id: PERSON_UPDATE_SOURCE_ADAPTER_V1,
  assert_live_cursor(cursor: string) { if (cursor !== 'source-keyed-v1') throw new Error('Person inbox cursor is invalid'); },
});
export interface PersonUpdateSourceInputV1 extends AuthorityPersonMembershipBinding {
  readonly request_id: string;
  readonly received_at: string;
  readonly payload_sha256: string;
  readonly title: string;
  readonly text: string;
}

/** Signed V4 external_id carries the authenticated author tenure, not an inferred meeting owner. */
export function personUpdateExternalIdV1(input: AuthorityPersonMembershipBinding & { readonly request_id: string }): string {
  return canonicalJson({ organization_id: input.organization_id, principal_id: input.principal_id, membership_id: input.membership_id, membership_type: input.membership_type, request_id: input.request_id });
}

export function personUpdateSourceIdentityV1(organizationId: string) {
  return { kind: 'meeting-source' as const, adapter_id: PERSON_UPDATE_SOURCE_ADAPTER_V1, instance_id: `person-inbox-${canonicalSha256({ organization_id: organizationId }).slice(7)}`, version: '1' };
}

/** The legacy document container admits authored notes; no calendar/attendance/date facts are invented. */
export function normalizePersonUpdateV1(input: PersonUpdateSourceInputV1): MeetingDocument {
  const externalId = personUpdateExternalIdV1(input);
  return {
    schema_version: 1,
    id: `person-update-${canonicalSha256({ external_id: externalId }).slice(7)}`,
    title: input.title,
    provenance: {
      source: personUpdateSourceIdentityV1(input.organization_id), external_id: externalId,
      canonical_revision: input.payload_sha256, source_revision: input.payload_sha256,
      normalizer_version: 'person-update-note-v1', observed_at: input.received_at,
    },
    capture: { state: 'complete', components: [{ kind: 'notes', state: 'available' }] },
    context: { meeting_type: 'person-update' },
    participants: [], artifacts: [],
    content: [{ id: 'person-update-text', kind: 'note', text: input.text, origin: 'human', sequence: 0 }],
  };
}
