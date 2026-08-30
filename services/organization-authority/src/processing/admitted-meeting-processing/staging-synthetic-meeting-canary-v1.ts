import { canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  assertCanonicalMeetingDocument,
  type MeetingDocument,
} from "../core/index.js";

/**
 * A deliberately invented source identity. It must never be confused with a
 * connected meeting provider in a card, record, or audit trail.
 */
export const stagingSyntheticMeetingCanarySourceIdentityV1 = Object.freeze({
  kind: "meeting-source" as const,
  adapter_id: "synthetic-staging-canary",
  instance_id: "staging",
  version: "1.0.0",
});

const CURSOR_PREFIX = "synthetic-staging-canary:v1:";
const LABEL = "synthetic-staging-canary";

export interface StagingSyntheticMeetingCanaryInputV1 {
  /** A caller-selected stable name makes retries idempotent. */
  readonly canary_id: string;
  /** The real, already linked person who will receive the private DM. */
  readonly owner_email: string;
  /** A canonical time supplied by the staging operator. */
  readonly observed_at: string;
}

function assertCanaryId(value: string): void {
  // A release-bound canary must accept the longest canonical clean-v1 release
  // ID ("clean-v1-" plus the 64-character validated suffix).
  if (!/^[a-z][a-z0-9-]{0,72}$/.test(value)) {
    throw new Error("staging synthetic canary id is invalid");
  }
}

function assertCanonicalTimestamp(value: string): void {
  if (new Date(value).toISOString() !== value) {
    throw new Error("staging synthetic canary observed_at is invalid");
  }
}

export function stagingSyntheticMeetingCanaryCursorV1(
  canaryId: string,
): string {
  assertCanaryId(canaryId);
  return `${CURSOR_PREFIX}${canaryId}`;
}

/**
 * Builds the one compact meeting used to prove the live private-DM approval
 * path. The wording and provenance are intentionally conspicuous so an
 * approval can never be mistaken for a real meeting.
 */
export function createStagingSyntheticMeetingCanaryV1(
  input: StagingSyntheticMeetingCanaryInputV1,
): MeetingDocument {
  assertCanaryId(input.canary_id);
  assertCanonicalTimestamp(input.observed_at);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.owner_email)) {
    throw new Error("staging synthetic canary owner email is invalid");
  }
  const externalId = `synthetic-staging-canary:${input.canary_id}`;
  const title =
    `SYNTHETIC STAGING CANARY ${input.canary_id} - Private approval delivery`;
  const revision = canonicalSha256({
    schema_version: 1,
    kind: "echo-staging-synthetic-private-dm-canary-v1",
    canary_id: input.canary_id,
    owner_email: input.owner_email,
  });
  const meeting: MeetingDocument = {
    schema_version: 1,
    id: externalId,
    title,
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
  };
  assertCanonicalMeetingDocument(
    meeting,
    stagingSyntheticMeetingCanarySourceIdentityV1,
  );
  return Object.freeze(meeting);
}

/**
 * Rebuilds the one permitted document rather than accepting a lookalike.
 * A staging intake supplies its fixed inputs; reads infer them from the
 * immutable snapshot they are reproving.
 */
export function assertStagingSyntheticMeetingCanaryV1(
  meeting: MeetingDocument,
  expectedInput?: StagingSyntheticMeetingCanaryInputV1,
): void {
  try {
    assertCanonicalMeetingDocument(
      meeting,
      stagingSyntheticMeetingCanarySourceIdentityV1,
    );
    const canaryId = meeting.provenance.metadata?.["canary_id"];
    const ownerEmail = meeting.participants[0]?.identities?.[0]?.value;
    const inferredInput =
      typeof canaryId === "string" && ownerEmail !== undefined
        ? {
            canary_id: canaryId,
            owner_email: ownerEmail,
            observed_at: meeting.provenance.observed_at,
          }
        : undefined;
    const canaryInput = expectedInput ?? inferredInput;
    if (canaryInput === undefined) {
      throw new Error("invalid staging synthetic canary inputs");
    }
    if (
      canonicalSha256(meeting) !==
      canonicalSha256(createStagingSyntheticMeetingCanaryV1(canaryInput))
    ) {
      throw new Error("staging synthetic canary differs from its fixed envelope");
    }
  } catch {
    throw new Error("meeting is not the fixed staging synthetic canary");
  }
}

export function isStagingSyntheticMeetingCanaryV1(
  meeting: MeetingDocument,
  cursor: string,
): boolean {
  try {
    assertStagingSyntheticMeetingCanaryV1(meeting);
    return (
      cursor ===
      stagingSyntheticMeetingCanaryCursorV1(
        meeting.provenance.metadata?.["canary_id"] as string,
      )
    );
  } catch {
    return false;
  }
}
