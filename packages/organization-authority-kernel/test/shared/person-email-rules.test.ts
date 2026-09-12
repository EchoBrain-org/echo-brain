import { describe, expect, it } from "vitest";
import {
  isCanonicalPersonEmail,
  isExpectedPersonEmail,
} from "../../src/shared/person-email-rules.js";

describe("canonical Person email", () => {
  it("retains the compatible durable identity-key rule", () => {
    for (const email of [
      "founder@example.com",
      "jane.doe+staging@example.co.uk",
      "a_b-c%tag@sub-domain.example.org",
      "user@localhost",
      "user@example",
    ]) {
      expect(isCanonicalPersonEmail(email)).toBe(true);
    }
  });

  it("uses the stricter mailbox shape only for expected-email boundaries", () => {
    const local64 = "a".repeat(64);
    const domain252 = [
      "a".repeat(63),
      "b".repeat(63),
      "c".repeat(63),
      "d".repeat(60),
    ].join(".");
    expect(isExpectedPersonEmail(`${local64}@example.com`)).toBe(true);
    expect(isExpectedPersonEmail(`a@${domain252}`)).toBe(true);
    expect(isExpectedPersonEmail("user@localhost")).toBe(false);
    expect(isExpectedPersonEmail("user@example")).toBe(false);
    expect(isExpectedPersonEmail(`${"a".repeat(65)}@example.com`)).toBe(
      false,
    );
    expect(isExpectedPersonEmail(`a@${"a".repeat(64)}.com`)).toBe(false);
    // The full mailbox has a 254-byte cap, so a 253-byte domain cannot coexist
    // with even the shortest local part.
    expect(
      isExpectedPersonEmail(
        `a@${["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".")}`,
      ),
    ).toBe(false);
  });

  it("rejects non-canonical and shell-shaped values at expected-email boundaries", () => {
    for (const email of [
      "Founder@example.com",
      " founder@example.com",
      "founder@example.com ",
      "founder;$(id)@example.com",
      "founder`id`@example.com",
      "founder\"quote@example.com",
      "founder name@example.com",
      ".founder@example.com",
      "founder.@example.com",
      "founder..name@example.com",
      "founder@example",
      "founder@example..com",
      "founder@-example.com",
      "founder@example-.com",
      "founder@example.c",
    ]) {
      expect(isExpectedPersonEmail(email)).toBe(false);
    }
  });
});
