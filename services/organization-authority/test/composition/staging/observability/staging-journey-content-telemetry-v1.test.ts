import { canonicalJson } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import {
  formatStagingJourneyContentRecordV1,
  STAGING_JOURNEY_CONTENT_KIND_V1,
  STAGING_JOURNEY_CONTENT_MAX_STRING_CHARACTERS_V1,
  STAGING_JOURNEY_CONTENT_MAX_RECORD_BYTES_V1,
} from "../../../../src/composition/staging/observability/staging-journey-content-telemetry-v1.js";

const BASE = Object.freeze({
  journey_id: "123e4567-e89b-42d3-a456-426614174000",
  sequence: 3,
  observed_at: "2026-09-03T21:13:42.149Z",
  release_sha: "a".repeat(40),
  build_number: 42,
  stage: "ask_answer" as const,
  content_kind: "answer_output" as const,
});

describe("staging journey content telemetry formatter", () => {
  it("projects a validated, frozen, staging-only ask content record", () => {
    const record = formatStagingJourneyContentRecordV1({
      ...BASE,
      content: { status: "answered", answer: "Tuesday.", citations: ["a1"] },
    });
    expect(record).toEqual({
      schema_version: 1,
      kind: STAGING_JOURNEY_CONTENT_KIND_V1,
      environment: "staging",
      workflow: "ask",
      journey_id: BASE.journey_id,
      sequence: 3,
      observed_at: BASE.observed_at,
      release_sha: BASE.release_sha,
      build_number: 42,
      stage: "ask_answer",
      content_kind: "answer_output",
      truncated: false,
      content: { status: "answered", answer: "Tuesday.", citations: ["a1"] },
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record?.content)).toBe(true);
  });

  it("rejects malformed identity, timestamps, stages, and content kinds", () => {
    expect(
      formatStagingJourneyContentRecordV1({ ...BASE, journey_id: "nope", content: {} }),
    ).toBeNull();
    expect(
      formatStagingJourneyContentRecordV1({
        ...BASE,
        observed_at: "2026-09-03T21:13:42Z",
        content: {},
      }),
    ).toBeNull();
    expect(
      formatStagingJourneyContentRecordV1({ ...BASE, release_sha: "abc", content: {} }),
    ).toBeNull();
    expect(
      formatStagingJourneyContentRecordV1({ ...BASE, build_number: 0, content: {} }),
    ).toBeNull();
    expect(
      formatStagingJourneyContentRecordV1({ ...BASE, sequence: -1, content: {} }),
    ).toBeNull();
    expect(
      formatStagingJourneyContentRecordV1({
        ...BASE,
        stage: "meeting_extraction" as never,
        content: {},
      }),
    ).toBeNull();
    expect(
      formatStagingJourneyContentRecordV1({
        ...BASE,
        content_kind: "raw_provider_body" as never,
        content: {},
      }),
    ).toBeNull();
  });

  it("bounds every string, drops non-JSON values, and flags truncation", () => {
    const long = "x".repeat(STAGING_JOURNEY_CONTENT_MAX_STRING_CHARACTERS_V1 + 5);
    const record = formatStagingJourneyContentRecordV1({
      ...BASE,
      content_kind: "context_atoms",
      stage: "ask_context",
      content: {
        atoms: [{ citation_id: "a1", text: long, skip: () => undefined }],
        nested: { deep: { value: 1n } },
      },
    });
    expect(record?.truncated).toBe(true);
    const content = record?.content as {
      atoms: Array<{ citation_id: string; text: string; skip: unknown }>;
      nested: { deep: { value: unknown } };
    };
    expect(content.atoms[0]?.text).toHaveLength(
      STAGING_JOURNEY_CONTENT_MAX_STRING_CHARACTERS_V1,
    );
    expect(content.atoms[0]?.skip).toBeNull();
    expect(content.nested.deep.value).toBeNull();
    expect(() => canonicalJson(record as never)).not.toThrow();
  });

  it("replaces content that still exceeds the record byte bound after string bounding", () => {
    const atoms = Array.from({ length: 12 }, (_, index) => ({
      citation_id: `a${index + 1}`,
      text: "y".repeat(STAGING_JOURNEY_CONTENT_MAX_STRING_CHARACTERS_V1),
    }));
    const record = formatStagingJourneyContentRecordV1({
      ...BASE,
      content_kind: "context_atoms",
      stage: "ask_context",
      content: { atoms },
    });
    expect(record?.truncated).toBe(true);
    expect(record?.content).toEqual({ omitted: "content exceeds record bound" });
    expect(
      Buffer.byteLength(canonicalJson(record as never), "utf8"),
    ).toBeLessThan(STAGING_JOURNEY_CONTENT_MAX_RECORD_BYTES_V1);
  });
});
