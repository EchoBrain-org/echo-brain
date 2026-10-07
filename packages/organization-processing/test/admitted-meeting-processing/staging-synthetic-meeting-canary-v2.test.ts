import { describe, expect, it } from "vitest";
import {
  assertStagingSyntheticMeetingCanary,
  assertStagingSyntheticMeetingCanaryV1,
  assertStagingSyntheticMeetingCanaryV2,
  createStagingSyntheticMeetingCanaryV1,
  createStagingSyntheticMeetingCanaryV2,
  isStagingSyntheticMeetingCanary,
  isStagingSyntheticMeetingCanaryV1,
  stagingSyntheticMeetingCanaryCursor,
} from "../../src/admitted-meeting-processing/staging-synthetic-meeting-canary-v1.js";

const input = Object.freeze({
  canary_id: "private-dm",
  owner_email: "founder@example.com",
  observed_at: "2026-09-26T12:00:00.000Z",
});

describe("staging synthetic meeting canary V2", () => {
  it("keeps the V1 validator strict while the versioned reader recognizes both exact envelopes", () => {
    const v1 = createStagingSyntheticMeetingCanaryV1(input);
    const v2 = createStagingSyntheticMeetingCanaryV2(input);

    assertStagingSyntheticMeetingCanaryV1(v1, input);
    assertStagingSyntheticMeetingCanaryV2(v2, input);
    expect(() => assertStagingSyntheticMeetingCanaryV1(v2, input)).toThrow(
      "fixed staging synthetic canary",
    );
    expect(() => assertStagingSyntheticMeetingCanaryV2(v1, input)).toThrow(
      "fixed staging synthetic canary V2",
    );

    assertStagingSyntheticMeetingCanary(v1, input);
    assertStagingSyntheticMeetingCanary(v2, input);
    expect(stagingSyntheticMeetingCanaryCursor(v1, input)).toBe(
      "synthetic-staging-canary:v1:private-dm",
    );
    expect(stagingSyntheticMeetingCanaryCursor(v2, input)).toBe(
      "synthetic-staging-canary:v2:private-dm",
    );
    expect(
      isStagingSyntheticMeetingCanary(v2, "synthetic-staging-canary:v1:private-dm"),
    ).toBe(false);
    expect(
      isStagingSyntheticMeetingCanary(v2, "synthetic-staging-canary:v2:private-dm"),
    ).toBe(true);
    expect(isStagingSyntheticMeetingCanaryV1(v1, "synthetic-staging-canary:v1:private-dm")).toBe(true);
  });

  it("rejects any transcript or provenance change from the V2 fixed envelope", () => {
    const transcript = structuredClone(createStagingSyntheticMeetingCanaryV2(input));
    transcript.content.find((block) => block.id === "synthetic-transcript")!.text =
      "changed synthetic transcript";
    const provenance = structuredClone(createStagingSyntheticMeetingCanaryV2(input));
    provenance.provenance.canonical_revision = `sha256:${"a".repeat(64)}`;

    for (const tampered of [transcript, provenance]) {
      expect(() => assertStagingSyntheticMeetingCanaryV2(tampered, input)).toThrow(
        "fixed staging synthetic canary V2",
      );
      expect(() => assertStagingSyntheticMeetingCanary(tampered, input)).toThrow(
        "fixed staging synthetic canary",
      );
      expect(
        isStagingSyntheticMeetingCanary(tampered, "synthetic-staging-canary:v2:private-dm"),
      ).toBe(false);
    }
  });

  it("contains an actual, bounded synthetic transcript only in V2", () => {
    const v1 = createStagingSyntheticMeetingCanaryV1(input);
    const v2 = createStagingSyntheticMeetingCanaryV2(input);

    expect(v1.capture.components.some((component) => component.kind === "transcript")).toBe(false);
    expect(v1.content.some((block) => block.kind === "transcript")).toBe(false);
    expect(v2.capture.components).toContainEqual({ kind: "transcript", state: "available" });
    expect(v2.content).toContainEqual({
      id: "synthetic-transcript",
      kind: "transcript",
      text:
        "Synthetic staging canary transcript. The staging owner confirms release private-dm " +
        "requires private approval delivery. This is synthetic and not a real meeting.",
      speaker_participant_id: "staging-owner",
      origin: "unknown",
    });
  });
});
