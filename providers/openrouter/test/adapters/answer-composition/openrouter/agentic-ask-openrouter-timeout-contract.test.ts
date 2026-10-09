import { canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  createAgenticAskV1,
  type AgenticAskAuditEntryV1,
} from "@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1";
import type {
  EvidenceDeskItemV1,
  EvidenceDeskPortV1,
  EvidenceDeskResultV1,
} from "@echo-brain/organization-authority-kernel/shared/evidence-desk-v1";
import { describe, expect, it, vi } from "vitest";
import {
  createOpenRouterStructuredGenerationAdapter,
  OpenRouterStructuredGenerationError,
} from "../../../../src/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js";

const checkedAt = "2026-09-29T00:00:00.000Z";

function result(items: readonly EvidenceDeskItemV1[] = []): EvidenceDeskResultV1 {
  return Object.freeze({
    items: Object.freeze(items),
    truncated: false,
    receipt_digests: Object.freeze([canonicalSha256({ receipt: items.length })]),
  });
}

function launchEvidence(): EvidenceDeskItemV1 {
  const atom = canonicalSha256({ atom: "launch" });
  return Object.freeze({
    id: "desk_launch",
    citation: Object.freeze({
      kind: "approved_record" as const,
      atom_id: atom,
      record_sha256: canonicalSha256({ record: "launch" }),
      policy_id: "organization-member-readable-person-v2" as const,
    }),
    kind: "decision" as const,
    text: "Launch is Tuesday.",
    label: "Launch decision",
    visibility: "team" as const,
    receipt_sha256: canonicalSha256({ receipt: "launch" }),
  });
}

function desk(item: EvidenceDeskItemV1): EvidenceDeskPortV1 {
  return Object.freeze({
    scope: Object.freeze({ kind: "global" as const }),
    search: async () => result([item]),
    open: async () => result([item]),
    list: async () => result(),
    revalidate: async () => Object.freeze({ checked_at: checkedAt }),
  });
}

function response(value: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("Agentic Ask and OpenRouter timeout contract", () => {
  it("rejects a fractional timeout before any provider request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = createOpenRouterStructuredGenerationAdapter({
      credential_ref: "test-openrouter",
      credential_resolver: () => "test-credential",
      fetch_impl: fetch,
    });

    await expect(adapter.generate({
      model: "openai/gpt-4.1-mini",
      system_prompt: "system",
      user_prompt: "user",
      schema: { type: "object" },
      max_output_tokens: 1,
      timeout_ms: 10.5,
    })).rejects.toBeInstanceOf(OpenRouterStructuredGenerationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes fractional shrinking planner and answer budgets before the real adapter", async () => {
    const startedAt = 100.125;
    let clock = startedAt;
    const elapsed = [20_000.25, 20_000.125, 21_000.25, 0];
    const replies = [
      {
        parts: [{ question: "When is launch?", notes: "", needs: [{ need: "launch date", status: "open", evidence: [] }] }],
        actions: [{ tool: "search", args: { query: "launch" } }],
      },
      {
        parts: [{ question: "When is launch?", notes: "", needs: [{ need: "launch date", status: "open", evidence: [] }] }],
        actions: [{ tool: "search", args: { query: "approval" } }],
      },
      {
        parts: [{ question: "When is launch?", notes: "", needs: [{ need: "launch date", status: "found", evidence: ["E1"] }] }],
        actions: [{ tool: "finish", args: {} }],
      },
      { sentences: [{ text: "Launch is Tuesday.", evidence: ["E1"] }], not_found: [] },
    ];
    const timeouts: number[] = [];
    const nativeTimeout = AbortSignal.timeout;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      timeouts.push(milliseconds);
      return nativeTimeout(milliseconds);
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => {
      const index = fetch.mock.calls.length - 1;
      clock += elapsed[index]!;
      return response(replies[index]);
    });
    const adapter = createOpenRouterStructuredGenerationAdapter({
      credential_ref: "test-openrouter",
      credential_resolver: () => "test-credential",
      fetch_impl: fetch,
      now_ms: () => clock,
    });
    const audit: AgenticAskAuditEntryV1[] = [];

    try {
      const answer = await createAgenticAskV1({
        desk: desk(launchEvidence()),
        model: adapter,
        generation: {
          generation_adapter_id: "openrouter",
          planner_model: "openai/gpt-4.1-mini",
          answer_model: "openai/gpt-4.1-mini",
          timeout_ms: 30_000,
        },
        audit: { append: entry => { audit.push(entry); } },
        now_ms: () => clock,
        today: () => "2026-09-29",
      }).answer({ question: "When is launch?" });

      expect(answer).toMatchObject({ outcome: "answered", citations: [{ citation: launchEvidence().citation }] });
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(timeouts).toEqual([25_000, 25_000, 22_999, 26_999]);
      expect(audit).toEqual([expect.objectContaining({ outcome: "answered", model_calls: 4, repairs: 0, fallbacks: 0, citation_count: 1 })]);
      expect(audit[0]!.checked_at).toBe(checkedAt);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
