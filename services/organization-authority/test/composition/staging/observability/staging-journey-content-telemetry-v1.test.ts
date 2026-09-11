import { describe, expect, it } from "vitest";
import {
  formatStagingJourneyContentRecordsV2,
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
  it.each([
    { journey_id: "not-a-journey" },
    { sequence: 0 },
    { observed_at: "2026-09-03T21:13:42Z" },
    { release_sha: "not-a-release" },
    { build_number: 0 },
    { stage: "meeting_extraction" },
    { content_kind: "raw_provider_body" },
    { span_id: "not-a-span" },
  ])("rejects malformed V2 capture metadata %j", (invalid) => {
    expect(formatStagingJourneyContentRecordsV2({
      ...BASE, content: "fixture", ...invalid,
    } as never)).toEqual([]);
  });
});
