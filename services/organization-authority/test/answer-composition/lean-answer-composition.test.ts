import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createLeanAnswerComposition,
  LeanAnswerCompositionError,
  type Layer4BatchReadPort,
  type Layer4ReleasedBatch,
  type Layer4StructuredGenerationInput,
} from "../../src/answer-composition/lean-answer-composition.js";

const digest = (value: string): Sha256Digest => canonicalSha256({ value });

function release(atoms = true): Layer4ReleasedBatch {
  return {
    release_id: digest("release"),
    authority_id: "oau_clean",
    organization_id: "org_clean",
    state_lineage_id: "lineage_clean",
    principal_id: "person_1",
    membership_id: "membership_1",
    session_family_id: "session_1",
    generation_id: digest("generation"),
    record_head: { position: 4, record_sha256: digest("head") },
    released_atoms: atoms
      ? [
          {
            atom_id: digest("atom-one"),
            record_sha256: digest("record-one"),
            policy_id: "organization-member-readable-person-v2",
            text: "The approved launch date is Tuesday.",
          },
          {
            atom_id: digest("atom-two"),
            record_sha256: digest("record-two"),
            policy_id: "organization-member-readable-person-v2",
            text: "The owner is the product team.",
          },
        ]
      : [],
    checked_at: "2026-08-23T00:00:00.000Z",
  };
}

describe("lean Layer 4 answer composition", () => {
  it("plans once, reads one Layer 3 batch, verifies citations, revalidates, and audits hashes", async () => {
    const events: string[] = [];
    let plannerRequest: Layer4StructuredGenerationInput | undefined;
    let answerRequest: Layer4StructuredGenerationInput | undefined;
    const planner = {
      generate: vi.fn(async (input: Layer4StructuredGenerationInput) => {
        plannerRequest = input;
        return { queries: ["launch date", "product owner"] };
      }),
    };
    const answerer = {
      generate: vi.fn(async (input: Layer4StructuredGenerationInput) => {
        answerRequest = input;
        events.push("answer");
        return { status: "answered", answer: "Tuesday, owned by the product team.", citations: ["a1", "a2"] };
      }),
    };
    let retrieveCount = 0;
    let retrievedQueries: readonly string[] | undefined;
    const layer3: Layer4BatchReadPort = {
      retrieve: async (input) => {
        retrieveCount += 1;
        retrievedQueries = input.queries;
        events.push("retrieve");
        return release();
      },
      revalidate: async () => {
        events.push("revalidate");
        return { checked_at: "2026-08-23T00:00:01.000Z" };
      },
    };
    const auditEntries: unknown[] = [];
    const answer = createLeanAnswerComposition({
      planner,
      answerer,
      layer3,
      audit: { append: (entry) => void auditEntries.push(entry) },
      provider: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });

    const result = await answer.answer({ question: "When is the launch and who owns it?" });

    expect(planner.generate).toHaveBeenCalledTimes(1);
    expect(retrieveCount).toBe(1);
    expect(retrievedQueries).toEqual([
      "When is the launch and who owns it?",
      "launch date",
      "product owner",
    ]);
    expect(answerer.generate).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["retrieve", "answer", "revalidate"]);
    expect(result).toMatchObject({
      schema_version: 1,
      kind: "echo-clean-person-answer-v1",
      generation_id: release().generation_id,
    });
    expect(result.citations).toEqual([
      expect.objectContaining({ atom_id: release().released_atoms[0]?.atom_id }),
      expect.objectContaining({ atom_id: release().released_atoms[1]?.atom_id }),
    ]);
    expect(auditEntries).toHaveLength(1);
    const auditEntry = auditEntries[0] as {
      checked_at: string;
      prompt_sha256: Sha256Digest;
    };
    expect(auditEntry.checked_at).toBe("2026-08-23T00:00:01.000Z");
    expect(plannerRequest).toBeDefined();
    expect(answerRequest).toBeDefined();
    const withoutSignal = (
      request: Layer4StructuredGenerationInput,
    ): Omit<Layer4StructuredGenerationInput, "signal"> => {
      const { signal: _signal, ...audited } = request;
      return audited;
    };
    expect(auditEntry.prompt_sha256).toBe(
      canonicalSha256({
        provider: "openrouter",
        planner: withoutSignal(plannerRequest as Layer4StructuredGenerationInput),
        answer: withoutSignal(answerRequest as Layer4StructuredGenerationInput),
      }),
    );
    expect(JSON.stringify(auditEntries[0])).not.toContain("When is the launch");
    expect(JSON.stringify(auditEntries[0])).not.toContain("Tuesday, owned");
  });

  it("rejects duplicate or unreleased citations before final revalidation", async () => {
    const layer3 = {
      retrieve: vi.fn(async () => release()),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const answer = createLeanAnswerComposition({
      planner: { generate: vi.fn(async () => ({ queries: [] })) },
      answerer: { generate: vi.fn(async () => ({ status: "answered", answer: "Unsupported", citations: ["a1", "a1"] })) },
      layer3,
      audit: { append: vi.fn() },
      provider: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });

    await expect(answer.answer({ question: "What is the launch date?" })).rejects.toBeInstanceOf(
      LeanAnswerCompositionError,
    );
    expect(layer3.revalidate).not.toHaveBeenCalled();
  });

  it("does not call the answer model when Layer 3 releases no usable atoms, but revalidates and audits", async () => {
    const answerer = { generate: vi.fn(async () => ({ status: "answered", answer: "wrong", citations: ["a1"] })) };
    const layer3 = {
      retrieve: vi.fn(async () => release(false)),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const audit = { append: vi.fn() };
    const answer = createLeanAnswerComposition({
      planner: { generate: vi.fn(async () => ({ queries: [] })) },
      answerer,
      layer3,
      audit,
      provider: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });

    await expect(answer.answer({ question: "What is the launch date?" })).resolves.toMatchObject({
      answer: "Insufficient accessible evidence to answer this question.",
      citations: [],
    });
    expect(answerer.generate).not.toHaveBeenCalled();
    expect(layer3.revalidate).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledTimes(1);
  });

  it("falls back to the original query when planner output violates the Layer 2 grammar", async () => {
    const layer3 = {
      retrieve: vi.fn(async () => release(false)),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const answer = createLeanAnswerComposition({
      planner: { generate: vi.fn(async () => ({ queries: ["   "] })) },
      answerer: { generate: vi.fn() },
      layer3,
      audit: { append: vi.fn() },
      provider: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });
    await expect(answer.answer({ question: "What is the launch date?" })).resolves.toMatchObject({
      answer: "Insufficient accessible evidence to answer this question.",
    });
    expect(layer3.retrieve).toHaveBeenCalledWith({
      queries: ["What is the launch date?"],
    });
  });

  it("falls back once when the optional planner is unavailable", async () => {
    const layer3 = {
      retrieve: vi.fn(async () => release()),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const answer = createLeanAnswerComposition({
      planner: { generate: vi.fn(async () => { throw new Error("provider unavailable"); }) },
      answerer: { generate: vi.fn(async () => ({ status: "answered", answer: "Tuesday.", citations: ["a1"] })) },
      layer3,
      audit: { append: vi.fn() },
      provider: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });

    await expect(answer.answer({ question: "What is the launch date?" })).resolves.toMatchObject({
      answer: "Tuesday.",
    });
    expect(layer3.retrieve).toHaveBeenCalledOnce();
    expect(layer3.retrieve).toHaveBeenCalledWith({
      queries: ["What is the launch date?"],
    });
  });

  it("does not turn caller cancellation into planner fallback", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    const planner = { generate: vi.fn() };
    const layer3 = {
      retrieve: vi.fn(async () => release()),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const answer = createLeanAnswerComposition({
      planner,
      answerer: { generate: vi.fn() },
      layer3,
      audit: { append: vi.fn() },
      provider: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });

    await expect(
      answer.answer({ question: "What is the launch date?", signal: controller.signal }),
    ).rejects.toThrow("caller cancelled");
    expect(planner.generate).not.toHaveBeenCalled();
    expect(layer3.retrieve).not.toHaveBeenCalled();
  });

  it("keeps the original query first and drops exact planner duplicates", async () => {
    const layer3 = {
      retrieve: vi.fn(async () => release(false)),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const question = "What is the launch date?";
    const answer = createLeanAnswerComposition({
      planner: {
        generate: vi.fn(async () => ({
          queries: [question, "launch date", "launch date"],
        })),
      },
      answerer: { generate: vi.fn() },
      layer3,
      audit: { append: vi.fn() },
      provider: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });

    await answer.answer({ question });

    expect(layer3.retrieve).toHaveBeenCalledWith({
      queries: [question, "launch date"],
    });
  });
});
