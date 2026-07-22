import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  GranolaApiClient,
  GranolaListParams,
} from "../../../src/adapters/meeting-sources/granola/index.js";
import { GranolaApiError } from "../../../src/adapters/meeting-sources/granola/index.js";
import {
  GranolaConnectionEvidenceError,
  LocalCredentialGuardError,
  assertLocalCredentialGuardMatches,
  createLocalCredentialGuard,
  matchesLocalCredentialGuard,
  observeGranolaConnection,
} from "../../../src/product/federation/index.js";

const OBSERVED_AT = "2026-07-19T20:12:00.000Z";

describe("Granola connection enrollment evidence", () => {
  it("observes exactly one list item without cursor, detail fetch, or meeting content", async () => {
    const listCalls: GranolaListParams[] = [];
    let detailCalls = 0;
    const client: GranolaApiClient = {
      async listNotes(params) {
        listCalls.push(params);
        return {
          notes: [
            {
              id: "not_secret_provider_id",
              title: "Sensitive meeting title",
              owner: { email: "private@example.com" },
            },
          ],
          hasMore: true,
          cursor: "provider-cursor-must-not-be-retained",
        };
      },
      async getNote() {
        detailCalls += 1;
        throw new Error("detail must not be called");
      },
    };

    const snapshot = await observeGranolaConnection(client, {
      observedAt: OBSERVED_AT,
      requestTimeoutMs: 1_000,
    });

    expect(listCalls).toEqual([{ page_size: 1 }]);
    expect(detailCalls).toBe(0);
    expect(snapshot).toMatchObject({
      provider: "granola",
      provider_identity: {
        tenant: null,
        subject: null,
        verification: {
          method: "provider_first_capture",
          assurance: "credential_observed",
          verified_at: OBSERVED_AT,
        },
      },
      evidence: {
        operation: "list_notes",
        requested_page_size: 1,
        notes_observed: 1,
        response_has_more: true,
        observed_at: OBSERVED_AT,
      },
    });
    expect(snapshot.evidence.observed_note_id_sha256).toBe(
      `sha256:${createHash("sha256").update("not_secret_provider_id").digest("hex")}`,
    );
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("Sensitive meeting title");
    expect(serialized).not.toContain("private@example.com");
    expect(serialized).not.toContain("not_secret_provider_id");
    expect(serialized).not.toContain("provider-cursor-must-not-be-retained");
  });

  it("records the clock after the bounded list response succeeds", async () => {
    let clock = "2026-07-19T20:11:00.000Z";
    const client: GranolaApiClient = {
      listNotes: async () => {
        clock = OBSERVED_AT;
        return {
          notes: [{ id: "not_observed_after_response" }],
          hasMore: false,
          cursor: null,
        };
      },
      getNote: async () => {
        throw new Error("not used");
      },
    };

    const snapshot = await observeGranolaConnection(client, {
      now: () => clock,
    });
    expect(snapshot.evidence.observed_at).toBe(OBSERVED_AT);
    expect(snapshot.provider_identity.verification.verified_at).toBe(
      OBSERVED_AT,
    );
  });

  it("validates credential usability and preserves the client auth taxonomy", async () => {
    const client: GranolaApiClient = {
      listNotes: async () => {
        throw new GranolaApiError(
          "Granola API authentication failed",
          "auth_failed",
          401,
        );
      },
      getNote: async () => {
        throw new Error("not used");
      },
    };

    await expect(
      observeGranolaConnection(client, { observedAt: OBSERVED_AT }),
    ).rejects.toMatchObject({ reason: "auth_failed", status: 401 });
  });

  it("refuses to claim first capture when no note exists or the bound is exceeded", async () => {
    const client = (notes: Array<{ id: string }>): GranolaApiClient => ({
      listNotes: async () => ({ notes, hasMore: false, cursor: null }),
      getNote: async () => {
        throw new Error("not used");
      },
    });

    await expect(
      observeGranolaConnection(client([]), { observedAt: OBSERVED_AT }),
    ).rejects.toMatchObject({ reason: "no_observable_note" });
    await expect(
      observeGranolaConnection(client([{ id: "one" }, { id: "two" }]), {
        observedAt: OBSERVED_AT,
      }),
    ).rejects.toMatchObject({ reason: "unbounded_response" });
  });

  it("has an independent deadline even when a client ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      const client: GranolaApiClient = {
        listNotes: async () => await new Promise(() => undefined),
        getNote: async () => {
          throw new Error("not used");
        },
      };
      const observation = observeGranolaConnection(client, {
        observedAt: OBSERVED_AT,
        requestTimeoutMs: 25,
      });
      const expectation = expect(observation).rejects.toEqual(
        expect.objectContaining<Partial<GranolaConnectionEvidenceError>>({
          reason: "timeout",
        }),
      );
      await vi.advanceTimersByTimeAsync(25);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards and independently observes caller cancellation", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const client: GranolaApiClient = {
      listNotes: async (_params, options) => {
        receivedSignal = options?.signal;
        return await new Promise(() => undefined);
      },
      getNote: async () => {
        throw new Error("not used");
      },
    };
    const observation = observeGranolaConnection(client, {
      observedAt: OBSERVED_AT,
      requestTimeoutMs: 1_000,
      signal: controller.signal,
    });
    const expectation = expect(observation).rejects.toMatchObject({
      reason: "cancelled",
    });

    controller.abort(new Error("host shutdown"));

    await expectation;
    expect(receivedSignal?.aborted).toBe(true);
  });
});

describe("local credential guards", () => {
  it("uses per-installation salt and detects secret or reference replacement", () => {
    const salt = Buffer.alloc(32, 7);
    const guard = createLocalCredentialGuard(
      "file:/private/local/granola-api-key",
      "grn_private_token",
      salt,
    );

    expect(guard).toEqual({
      reference: "file:/private/local/granola-api-key",
      algorithm: "sha256-salted",
      salt_base64: salt.toString("base64"),
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      exportable: false,
    });
    expect(JSON.stringify(guard)).not.toContain("grn_private_token");
    expect(
      matchesLocalCredentialGuard(
        guard,
        "file:/private/local/granola-api-key",
        "grn_private_token",
      ),
    ).toBe(true);
    expect(
      matchesLocalCredentialGuard(
        guard,
        "file:/private/local/granola-api-key",
        "grn_replacement_token",
      ),
    ).toBe(false);
    expect(
      matchesLocalCredentialGuard(
        guard,
        "file:/private/local/different-path",
        "grn_private_token",
      ),
    ).toBe(false);
  });

  it("never accepts malformed guards and does not echo secret material", () => {
    const guard = createLocalCredentialGuard(
      "env:GRANOLA_API_KEY",
      "grn_private_token",
      Buffer.alloc(32, 9),
    );
    const malformed = { ...guard, salt_base64: "not/base64?" };
    expect(() =>
      matchesLocalCredentialGuard(
        malformed,
        "env:GRANOLA_API_KEY",
        "grn_private_token",
      ),
    ).toThrow(LocalCredentialGuardError);
    expect(() =>
      assertLocalCredentialGuardMatches(
        guard,
        "env:GRANOLA_API_KEY",
        "grn_changed_secret",
      ),
    ).toThrow(
      "credential material or reference no longer matches the active connection generation",
    );
  });
});
