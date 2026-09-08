import { describe, expect, it } from "vitest";
import { assertStagingSyntheticMeetingSourceSelectionV1 } from "../../../src/composition/staging/staging-synthetic-meeting-source-selection-v1.js";

describe("staging synthetic meeting-source selection", () => {
  it("accepts one canonical staging directory and rejects production or ambiguous paths", () => {
    expect(
      assertStagingSyntheticMeetingSourceSelectionV1({
        authority_url: "https://authority-staging.echobrain.org",
        meetings_directory: "/echo-clean/meetings",
      }),
    ).toBe("/echo-clean/meetings");
    expect(() =>
      assertStagingSyntheticMeetingSourceSelectionV1({
        authority_url: "https://authority.echobrain.org",
        meetings_directory: "/echo-clean/meetings",
      }),
    ).toThrow("only on the staging Authority");
    expect(() =>
      assertStagingSyntheticMeetingSourceSelectionV1({
        authority_url: "https://authority-staging.echobrain.org",
        meetings_directory: "/echo-clean/meetings/../meetings",
      }),
    ).toThrow("absolute canonical path");
  });
});
