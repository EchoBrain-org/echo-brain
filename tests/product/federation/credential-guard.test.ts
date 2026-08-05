import { describe, expect, it } from "vitest";
import {
  LocalCredentialGuardError,
  assertLocalCredentialGuard,
  assertLocalCredentialGuardMatches,
  matchesLocalCredentialGuard,
} from "../../../src/product/federation/identity/credential-guard.js";
import {
  GOLDEN_DUMMY_CREDENTIALS,
  goldenCredentialGuard,
} from "./fixtures/retired-founder-state.js";

/**
 * The guard authoring API is deleted; these use the pinned guards frozen in
 * the golden connection registry, whose salted digests were computed once over
 * dummy credentials. The digest algorithm itself is never reimplemented here.
 */

const GRANOLA_REFERENCE = "file:/private/granola-token";
const GRANOLA_CREDENTIAL = GOLDEN_DUMMY_CREDENTIALS[GRANOLA_REFERENCE];

describe("local credential guards", () => {
  it("matches the enrolled credential and detects secret or reference replacement", () => {
    const guard = goldenCredentialGuard("granola");
    expect(() => assertLocalCredentialGuard(guard)).not.toThrow();
    expect(JSON.stringify(guard)).not.toContain(GRANOLA_CREDENTIAL);
    expect(
      matchesLocalCredentialGuard(guard, GRANOLA_REFERENCE, GRANOLA_CREDENTIAL),
    ).toBe(true);
    expect(
      matchesLocalCredentialGuard(
        guard,
        GRANOLA_REFERENCE,
        "grn_replacement_token",
      ),
    ).toBe(false);
    expect(
      matchesLocalCredentialGuard(
        guard,
        "file:/private/local/different-path",
        GRANOLA_CREDENTIAL,
      ),
    ).toBe(false);
  });

  it("never accepts malformed guards and does not echo secret material", () => {
    const guard = goldenCredentialGuard("slack");
    const malformed = { ...guard, salt_base64: "not/base64?" };
    expect(() =>
      matchesLocalCredentialGuard(
        malformed,
        guard.reference,
        GOLDEN_DUMMY_CREDENTIALS["file:/private/slack-token"],
      ),
    ).toThrow(LocalCredentialGuardError);
    expect(() => assertLocalCredentialGuard(malformed)).toThrow(
      LocalCredentialGuardError,
    );
    expect(() =>
      assertLocalCredentialGuardMatches(
        guard,
        guard.reference,
        "changed-secret",
      ),
    ).toThrow(
      "credential material or reference no longer matches the active connection generation",
    );
  });
});
