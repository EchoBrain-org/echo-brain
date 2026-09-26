import { canonicalSha256 } from "@echo-brain/federation-protocol";

export const stagingSyntheticMeetingCanarySourceIdentityV1 = Object.freeze({
  kind: "meeting-source" as const,
  adapter_id: "synthetic-staging-canary",
  instance_id: "staging",
  version: "1.0.0",
});

const CURSOR_PREFIX = "synthetic-staging-canary:v1:";
const LABEL = "synthetic-staging-canary";

export interface StagingSyntheticMeetingCanaryInputV1 {
  readonly canary_id: string;
  readonly owner_email: string;
  readonly observed_at: string;
}

function assertCanaryId(value: string): void {
  if (!/^[a-z][a-z0-9-]{0,72}$/.test(value)) {
    throw new Error("staging synthetic canary id is invalid");
  }
}

function assertCanonicalTimestamp(value: string): void {
  if (new Date(value).toISOString() !== value) {
    throw new Error("staging synthetic canary observed_at is invalid");
  }
}

function assertOwnerEmail(value: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error("staging synthetic canary owner email is invalid");
  }
}

export function assertStagingSyntheticMeetingCanaryInputV1(
  input: StagingSyntheticMeetingCanaryInputV1,
): void {
  assertCanaryId(input.canary_id);
  assertOwnerEmail(input.owner_email);
  assertCanonicalTimestamp(input.observed_at);
}

export function stagingSyntheticMeetingCanaryCursorV1(
  canaryId: string,
): string {
  assertCanaryId(canaryId);
  return `${CURSOR_PREFIX}${canaryId}`;
}

/**
 * The fixed JSON-compatible source envelope. This deliberately lives outside
 * processing so setup-status can reconstruct and verify persisted evidence
 * without importing a processing implementation.
 */
export function createStagingSyntheticMeetingCanaryEnvelopeV1(
  input: StagingSyntheticMeetingCanaryInputV1,
): Readonly<Record<string, unknown>> {
  assertStagingSyntheticMeetingCanaryInputV1(input);
  const externalId = `synthetic-staging-canary:${input.canary_id}`;
  const revision = canonicalSha256({
    schema_version: 1,
    kind: "echo-staging-synthetic-private-dm-canary-v1",
    canary_id: input.canary_id,
    owner_email: input.owner_email,
  });
  return Object.freeze({
    schema_version: 1,
    id: externalId,
    title: `SYNTHETIC STAGING CANARY ${input.canary_id} - Private approval delivery`,
    lifecycle: "completed",
    capture: {
      state: "complete",
      components: [
        { kind: "metadata", state: "available" },
        { kind: "notes", state: "available" },
      ],
    },
    participants: [
      {
        id: "staging-owner",
        display_name: "Staging canary owner",
        identities: [{ kind: "email", value: input.owner_email }],
        roles: ["organizer"],
      },
    ],
    content: [
      {
        id: "synthetic-decision",
        kind: "note",
        text:
          `Synthetic staging canary only. Decision: release ${input.canary_id} ` +
          "must verify private owner approval delivery.",
        origin: "unknown",
      },
      {
        id: "synthetic-action",
        kind: "note",
        text:
          `Synthetic staging canary only. Action: approve release ${input.canary_id} ` +
          "and select its visibility policy.",
        origin: "unknown",
      },
      {
        id: "synthetic-rationale",
        kind: "note",
        text:
          `Synthetic staging canary only. Rationale: exercise release ${input.canary_id} ` +
          "without creating a real meeting.",
        origin: "unknown",
      },
    ],
    artifacts: [],
    context: {
      owner_participant_id: "staging-owner",
      labels: [LABEL, "synthetic", "not-a-real-meeting"],
      metadata: {
        synthetic: true,
        purpose: "private-dm-approval-delivery-rehearsal",
      },
    },
    provenance: {
      source: stagingSyntheticMeetingCanarySourceIdentityV1,
      external_id: externalId,
      canonical_revision: revision,
      observed_at: input.observed_at,
      normalizer_version: "synthetic-staging-canary-v1",
      metadata: {
        synthetic: true,
        environment: "staging",
        canary_id: input.canary_id,
      },
    },
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** Extracts the reconstruction inputs without trusting the surrounding envelope. */
export function stagingSyntheticMeetingCanaryInputFromEnvelopeV1(
  value: unknown,
): StagingSyntheticMeetingCanaryInputV1 | undefined {
  const meeting = record(value);
  const provenance = record(meeting?.provenance);
  const metadata = record(provenance?.metadata);
  const participants = meeting?.participants;
  const participant = Array.isArray(participants)
    ? record(participants[0])
    : undefined;
  const identities = participant?.identities;
  const identity = Array.isArray(identities)
    ? record(identities[0])
    : undefined;
  const canaryId = metadata?.canary_id;
  const observedAt = provenance?.observed_at;
  const ownerEmail = identity?.value;
  if (
    typeof canaryId !== "string" ||
    typeof observedAt !== "string" ||
    typeof ownerEmail !== "string"
  ) {
    return undefined;
  }
  try {
    const input = Object.freeze({
      canary_id: canaryId,
      owner_email: ownerEmail,
      observed_at: observedAt,
    });
    assertStagingSyntheticMeetingCanaryInputV1(input);
    return input;
  } catch {
    return undefined;
  }
}

/** Fails closed unless the whole persisted value equals the reconstructed envelope. */
export function isStagingSyntheticMeetingCanaryEnvelopeV1(
  value: unknown,
  expectedInput?: StagingSyntheticMeetingCanaryInputV1,
): boolean {
  try {
    const input =
      expectedInput ?? stagingSyntheticMeetingCanaryInputFromEnvelopeV1(value);
    if (input === undefined) return false;
    assertStagingSyntheticMeetingCanaryInputV1(input);
    return (
      canonicalSha256(value as never) ===
      canonicalSha256(createStagingSyntheticMeetingCanaryEnvelopeV1(input))
    );
  } catch {
    return false;
  }
}

/**
 * V2 is a separate, fixed envelope for the transcript-release rehearsal.
 * It deliberately does not change the V1 reconstruction or its historical
 * bytes: the revision, normalizer version, and exact transcript payload are
 * all part of this new immutable envelope.
 */
const CURSOR_PREFIX_V2 = "synthetic-staging-canary:v2:";

export type StagingSyntheticMeetingCanaryInputV2 =
  StagingSyntheticMeetingCanaryInputV1;

export function stagingSyntheticMeetingCanaryCursorV2(
  canaryId: string,
): string {
  assertCanaryId(canaryId);
  return `${CURSOR_PREFIX_V2}${canaryId}`;
}

export function createStagingSyntheticMeetingCanaryEnvelopeV2(
  input: StagingSyntheticMeetingCanaryInputV2,
): Readonly<Record<string, unknown>> {
  assertStagingSyntheticMeetingCanaryInputV1(input);
  const externalId = `synthetic-staging-canary:${input.canary_id}`;
  const revision = canonicalSha256({
    schema_version: 2,
    kind: "echo-staging-synthetic-private-dm-canary-v2",
    canary_id: input.canary_id,
    owner_email: input.owner_email,
  });
  return Object.freeze({
    schema_version: 1,
    id: externalId,
    title: `SYNTHETIC STAGING CANARY ${input.canary_id} - Private approval delivery`,
    lifecycle: "completed",
    capture: {
      state: "complete",
      components: [
        { kind: "metadata", state: "available" },
        { kind: "notes", state: "available" },
        { kind: "transcript", state: "available" },
      ],
    },
    participants: [
      {
        id: "staging-owner",
        display_name: "Staging canary owner",
        identities: [{ kind: "email", value: input.owner_email }],
        roles: ["organizer"],
      },
    ],
    content: [
      {
        id: "synthetic-decision",
        kind: "note",
        text:
          `Synthetic staging canary only. Decision: release ${input.canary_id} ` +
          "must verify private owner approval delivery.",
        origin: "unknown",
      },
      {
        id: "synthetic-action",
        kind: "note",
        text:
          `Synthetic staging canary only. Action: approve release ${input.canary_id} ` +
          "and select its visibility policy.",
        origin: "unknown",
      },
      {
        id: "synthetic-rationale",
        kind: "note",
        text:
          `Synthetic staging canary only. Rationale: exercise release ${input.canary_id} ` +
          "without creating a real meeting.",
        origin: "unknown",
      },
      {
        id: "synthetic-transcript",
        kind: "transcript",
        text:
          `Synthetic staging canary transcript. The staging owner confirms release ${input.canary_id} ` +
          "requires private approval delivery. This is synthetic and not a real meeting.",
        speaker_participant_id: "staging-owner",
        origin: "unknown",
      },
    ],
    artifacts: [],
    context: {
      owner_participant_id: "staging-owner",
      labels: [LABEL, "synthetic", "not-a-real-meeting"],
      metadata: {
        synthetic: true,
        purpose: "private-dm-approval-delivery-rehearsal",
      },
    },
    provenance: {
      source: stagingSyntheticMeetingCanarySourceIdentityV1,
      external_id: externalId,
      canonical_revision: revision,
      observed_at: input.observed_at,
      normalizer_version: "synthetic-staging-canary-v2",
      metadata: {
        synthetic: true,
        environment: "staging",
        canary_id: input.canary_id,
        canary_envelope_version: 2,
      },
    },
  });
}

export function stagingSyntheticMeetingCanaryInputFromEnvelopeV2(
  value: unknown,
): StagingSyntheticMeetingCanaryInputV2 | undefined {
  const input = stagingSyntheticMeetingCanaryInputFromEnvelopeV1(value);
  return input !== undefined && isStagingSyntheticMeetingCanaryEnvelopeV2(value, input)
    ? input
    : undefined;
}

export function isStagingSyntheticMeetingCanaryEnvelopeV2(
  value: unknown,
  expectedInput?: StagingSyntheticMeetingCanaryInputV2,
): boolean {
  try {
    const input =
      expectedInput ?? stagingSyntheticMeetingCanaryInputFromEnvelopeV1(value);
    if (input === undefined) return false;
    assertStagingSyntheticMeetingCanaryInputV1(input);
    return (
      canonicalSha256(value as never) ===
      canonicalSha256(createStagingSyntheticMeetingCanaryEnvelopeV2(input))
    );
  } catch {
    return false;
  }
}

export type StagingSyntheticMeetingCanaryEnvelopeVersion = 1 | 2;

export interface StagingSyntheticMeetingCanaryEnvelopeDescriptorV1 {
  readonly version: StagingSyntheticMeetingCanaryEnvelopeVersion;
  readonly input: StagingSyntheticMeetingCanaryInputV1;
  readonly cursor: string;
}

/**
 * The durable-reader dispatch: it recognizes only complete, reconstructed V1
 * or V2 envelopes and derives the versioned cursor from those exact bytes.
 */
export function describeStagingSyntheticMeetingCanaryEnvelope(
  value: unknown,
  expectedInput?: StagingSyntheticMeetingCanaryInputV1,
): StagingSyntheticMeetingCanaryEnvelopeDescriptorV1 | undefined {
  try {
    const input =
      expectedInput ?? stagingSyntheticMeetingCanaryInputFromEnvelopeV1(value);
    if (input === undefined) return undefined;
    if (isStagingSyntheticMeetingCanaryEnvelopeV1(value, input)) {
      return Object.freeze({
        version: 1,
        input,
        cursor: stagingSyntheticMeetingCanaryCursorV1(input.canary_id),
      });
    }
    if (isStagingSyntheticMeetingCanaryEnvelopeV2(value, input)) {
      return Object.freeze({
        version: 2,
        input,
        cursor: stagingSyntheticMeetingCanaryCursorV2(input.canary_id),
      });
    }
  } catch {
    // An incomplete or lookalike persisted document is not a canary.
  }
  return undefined;
}

export function stagingSyntheticMeetingCanaryInputFromEnvelope(
  value: unknown,
): StagingSyntheticMeetingCanaryInputV1 | undefined {
  return describeStagingSyntheticMeetingCanaryEnvelope(value)?.input;
}

export function stagingSyntheticMeetingCanaryCursorFromEnvelope(
  value: unknown,
  expectedInput?: StagingSyntheticMeetingCanaryInputV1,
): string | undefined {
  return describeStagingSyntheticMeetingCanaryEnvelope(value, expectedInput)?.cursor;
}

export function isStagingSyntheticMeetingCanaryEnvelope(
  value: unknown,
  expectedInput?: StagingSyntheticMeetingCanaryInputV1,
): boolean {
  return describeStagingSyntheticMeetingCanaryEnvelope(value, expectedInput) !== undefined;
}
