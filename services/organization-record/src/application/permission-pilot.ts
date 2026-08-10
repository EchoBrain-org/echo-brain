import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
  canonicalJson,
  canonicalSha256,
  type JsonObject,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';
import { OrganizationRecordError } from './errors.js';

export const ORGANIZATION_PERMISSION_PILOT_POLICY_ID =
  'pilot-member-readable-v1' as const;
export const ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID =
  'pilot-two-person-audience-v1' as const;
export const ORGANIZATION_PERMISSION_PILOT_PRESENTATION_KIND =
  'echo-organization-permission-pilot-presentation' as const;
export const ORGANIZATION_PERMISSION_PILOT_ACTIVATION_COMMAND_KIND =
  'echo-organization-permission-pilot-activation-command' as const;
export const ORGANIZATION_PERMISSION_PILOT_NOTICE_REASON_CODE =
  'active_membership_direct_grant_pilot_notice_v1' as const;
export const ORGANIZATION_PERMISSION_PILOT_RECORD_SCAN_LIMIT = 20 as const;

const PPA_ID =
  /^ppa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const LABEL_CHARACTERS = /^[\p{L}\p{M}\p{N} .'-]+$/u;

export interface OrganizationPermissionPilotAudienceMemberV1 {
  readonly membership_id: string;
  readonly label: string;
}

export type OrganizationPermissionPilotAudienceV1 = readonly [
  OrganizationPermissionPilotAudienceMemberV1,
  OrganizationPermissionPilotAudienceMemberV1,
];

export interface OrganizationPermissionPilotPresentationV1 {
  readonly schema_version: 1;
  readonly kind: typeof ORGANIZATION_PERMISSION_PILOT_PRESENTATION_KIND;
  readonly policy_id: typeof ORGANIZATION_PERMISSION_PILOT_POLICY_ID;
  readonly presentation_policy_id: typeof ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID;
  readonly audience: OrganizationPermissionPilotAudienceV1;
  readonly notice_text: string;
  readonly fallback_text: string;
}

export interface OrganizationPermissionPilotActivationCommandV1 {
  readonly schema_version: 1;
  readonly kind: typeof ORGANIZATION_PERMISSION_PILOT_ACTIVATION_COMMAND_KIND;
  readonly command_id: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly policy_id: typeof ORGANIZATION_PERMISSION_PILOT_POLICY_ID;
  readonly presentation_policy_id: typeof ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID;
  readonly audience: OrganizationPermissionPilotAudienceV1;
  readonly requested_at: string;
  readonly reason: string;
}

export interface OrganizationPermissionPilotEligibilityProofV1 {
  readonly policy_id: typeof ORGANIZATION_PERMISSION_PILOT_POLICY_ID;
  readonly presentation_policy_id: typeof ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID;
  readonly audience_notice_sha256: Sha256Digest;
  readonly message_presentation_sha256: Sha256Digest;
}

export interface OrganizationPermissionPilotActivationMarkerV1 {
  readonly organization_id: string;
  readonly command_id: string;
  readonly command_sha256: Sha256Digest;
  readonly policy_id: typeof ORGANIZATION_PERMISSION_PILOT_POLICY_ID;
  readonly presentation_policy_id: typeof ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID;
  readonly audience: OrganizationPermissionPilotAudienceV1;
  readonly presentation_descriptor: OrganizationPermissionPilotPresentationV1;
  readonly audience_notice_sha256: Sha256Digest;
  readonly activated_at: string;
  readonly effective_after_position: number;
  readonly effective_after_record_hash: Sha256Digest | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(`${label} has an unexpected shape`);
  }
}

function digest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value as Sha256Digest;
}

function label(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value !== value.normalize('NFC') ||
    value.trim() !== value ||
    [...value].length < 1 ||
    [...value].length > 80 ||
    !LABEL_CHARACTERS.test(value)
  ) {
    throw new Error(
      `${name} must be a trimmed NFC human name of 1 through 80 allowed characters`,
    );
  }
  return value;
}

export function validateOrganizationPermissionPilotAudience(
  value: unknown,
): OrganizationPermissionPilotAudienceV1 {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('organization permission pilot audience must contain exactly two members');
  }
  const audience = value.map((entry, index) => {
    const member = record(entry, `organization permission pilot audience[${index}]`);
    exactKeys(
      member,
      ['membership_id', 'label'],
      `organization permission pilot audience[${index}]`,
    );
    if (typeof member.membership_id !== 'string') {
      throw new Error('organization permission pilot audience membership_id is invalid');
    }
    assertFederationId(
      member.membership_id,
      'mem',
      `organization permission pilot audience[${index}].membership_id`,
    );
    return Object.freeze({
      membership_id: member.membership_id,
      label: label(
        member.label,
        `organization permission pilot audience[${index}].label`,
      ),
    });
  }) as unknown as OrganizationPermissionPilotAudienceV1;
  if (
    audience[0].membership_id === audience[1].membership_id ||
    audience[0].label === audience[1].label
  ) {
    throw new Error('organization permission pilot audience members and labels must be distinct');
  }
  if (audience[0].membership_id > audience[1].membership_id) {
    throw new Error('organization permission pilot audience must be sorted by membership_id');
  }
  return Object.freeze(audience);
}

export function organizationPermissionPilotPresentation(
  audienceValue: unknown,
): OrganizationPermissionPilotPresentationV1 {
  const audience = validateOrganizationPermissionPilotAudience(audienceValue);
  const noticeText =
    "Approving publishes this organization record's decisions, actions, and " +
    `rationales to ${audience[0].label} and ${audience[1].label}.`;
  return Object.freeze({
    schema_version: 1,
    kind: ORGANIZATION_PERMISSION_PILOT_PRESENTATION_KIND,
    policy_id: ORGANIZATION_PERMISSION_PILOT_POLICY_ID,
    presentation_policy_id: ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID,
    audience,
    notice_text: noticeText,
    fallback_text: `Decision brief awaiting approval. ${noticeText}`,
  });
}

export function organizationPermissionPilotAudienceNoticeSha256(
  presentation: OrganizationPermissionPilotPresentationV1,
): Sha256Digest {
  return canonicalSha256(presentation);
}

export function validateOrganizationPermissionPilotActivationCommand(
  value: unknown,
  binding?: { readonly authority_id: string; readonly organization_id: string },
): OrganizationPermissionPilotActivationCommandV1 {
  const command = record(value, 'organization permission pilot activation command');
  exactKeys(
    command,
    [
      'schema_version',
      'kind',
      'command_id',
      'authority_id',
      'organization_id',
      'policy_id',
      'presentation_policy_id',
      'audience',
      'requested_at',
      'reason',
    ],
    'organization permission pilot activation command',
  );
  if (
    command.schema_version !== 1 ||
    command.kind !== ORGANIZATION_PERMISSION_PILOT_ACTIVATION_COMMAND_KIND ||
    command.policy_id !== ORGANIZATION_PERMISSION_PILOT_POLICY_ID ||
    command.presentation_policy_id !==
      ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID
  ) {
    throw new Error('organization permission pilot activation identity is unsupported');
  }
  if (typeof command.command_id !== 'string' || !PPA_ID.test(command.command_id)) {
    throw new Error('organization permission pilot command_id is invalid');
  }
  if (typeof command.authority_id !== 'string') {
    throw new Error('organization permission pilot authority_id is invalid');
  }
  if (typeof command.organization_id !== 'string') {
    throw new Error('organization permission pilot organization_id is invalid');
  }
  assertFederationId(command.authority_id, 'oau', 'organization permission pilot authority_id');
  assertFederationId(
    command.organization_id,
    'org',
    'organization permission pilot organization_id',
  );
  if (
    binding !== undefined &&
    (command.authority_id !== binding.authority_id ||
      command.organization_id !== binding.organization_id)
  ) {
    throw new Error('organization permission pilot command differs from configured authority');
  }
  if (typeof command.requested_at !== 'string') {
    throw new Error('organization permission pilot requested_at is invalid');
  }
  assertUtcMillisecondTimestamp(
    command.requested_at,
    'organization permission pilot requested_at',
  );
  if (
    typeof command.reason !== 'string' ||
    command.reason.trim() !== command.reason ||
    new TextEncoder().encode(command.reason).byteLength < 1 ||
    new TextEncoder().encode(command.reason).byteLength > 500 ||
    /\p{Cc}/u.test(command.reason)
  ) {
    throw new Error('organization permission pilot reason is invalid');
  }
  return Object.freeze({
    schema_version: 1,
    kind: ORGANIZATION_PERMISSION_PILOT_ACTIVATION_COMMAND_KIND,
    command_id: command.command_id,
    authority_id: command.authority_id,
    organization_id: command.organization_id,
    policy_id: ORGANIZATION_PERMISSION_PILOT_POLICY_ID,
    presentation_policy_id: ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID,
    audience: validateOrganizationPermissionPilotAudience(command.audience),
    requested_at: command.requested_at,
    reason: command.reason,
  });
}

export function organizationPermissionPilotCommandSha256(
  command: OrganizationPermissionPilotActivationCommandV1,
): Sha256Digest {
  return canonicalSha256(command);
}

export function assertOrganizationPermissionPilotActivationFresh(
  command: OrganizationPermissionPilotActivationCommandV1,
  now: string,
): void {
  assertUtcMillisecondTimestamp(now, 'organization permission pilot activation time');
  if (Math.abs(Date.parse(now) - Date.parse(command.requested_at)) > 5 * 60_000) {
    throw new Error('organization permission pilot activation request is outside five minutes');
  }
}

export function validateOrganizationPermissionPilotEligibilityProof(
  value: unknown,
): OrganizationPermissionPilotEligibilityProofV1 {
  const proof = record(value, 'organization permission pilot eligibility proof');
  exactKeys(
    proof,
    [
      'policy_id',
      'presentation_policy_id',
      'audience_notice_sha256',
      'message_presentation_sha256',
    ],
    'organization permission pilot eligibility proof',
  );
  if (
    proof.policy_id !== ORGANIZATION_PERMISSION_PILOT_POLICY_ID ||
    proof.presentation_policy_id !==
      ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID
  ) {
    throw new Error('organization permission pilot eligibility policy is invalid');
  }
  return Object.freeze({
    policy_id: ORGANIZATION_PERMISSION_PILOT_POLICY_ID,
    presentation_policy_id: ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID,
    audience_notice_sha256: digest(
      proof.audience_notice_sha256,
      'organization permission pilot audience notice',
    ),
    message_presentation_sha256: digest(
      proof.message_presentation_sha256,
      'organization permission pilot message presentation',
    ),
  });
}

function envelopeNoticeReason(envelope: JsonObject): unknown {
  const reviewer = envelope['reviewer'];
  if (reviewer === null || typeof reviewer !== 'object' || Array.isArray(reviewer)) {
    return undefined;
  }
  const authorization = (reviewer as JsonObject)['authorization'];
  if (
    authorization === null ||
    typeof authorization !== 'object' ||
    Array.isArray(authorization)
  ) {
    return undefined;
  }
  return (authorization as JsonObject)['reason_code'];
}

/** Binds the adapter's eligibility claim to the exact canonical envelope. */
export function assertOrganizationPermissionPilotProofBinding(
  envelope: JsonObject,
  proof: OrganizationPermissionPilotEligibilityProofV1 | undefined,
): void {
  const noticeQualified =
    envelope['event_type'] === 'approval' &&
    envelopeNoticeReason(envelope) ===
      ORGANIZATION_PERMISSION_PILOT_NOTICE_REASON_CODE;
  if (noticeQualified !== (proof !== undefined)) {
    throw new OrganizationRecordError(
      'log_invariant_violated',
      'verified organization record pilot eligibility does not match its canonical envelope',
    );
  }
  if (proof !== undefined) validateOrganizationPermissionPilotEligibilityProof(proof);
}

export function assertOrganizationPermissionPilotPresentation(
  value: unknown,
  expectedAudience?: OrganizationPermissionPilotAudienceV1,
): OrganizationPermissionPilotPresentationV1 {
  const presentation = record(value, 'organization permission pilot presentation');
  exactKeys(
    presentation,
    [
      'schema_version',
      'kind',
      'policy_id',
      'presentation_policy_id',
      'audience',
      'notice_text',
      'fallback_text',
    ],
    'organization permission pilot presentation',
  );
  const rebuilt = organizationPermissionPilotPresentation(presentation.audience);
  if (
    canonicalJson(presentation) !== canonicalJson(rebuilt) ||
    (expectedAudience !== undefined &&
      canonicalJson(rebuilt.audience) !== canonicalJson(expectedAudience))
  ) {
    throw new Error('organization permission pilot presentation is not canonical');
  }
  return rebuilt;
}
