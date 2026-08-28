import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createLeanAnswerComposition,
  LeanAnswerCompositionError,
  type Layer4BatchReadPort,
  type Layer4FailureDiagnosticV1,
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

  it.each([
    {
      name: "duplicate citations",
      response: {
        status: "answered",
        answer: "Unsupported",
        citations: ["a1", "a1"],
      },
    },
    {
      name: "an undeclared property",
      response: {
        status: "answered",
        answer: "Tuesday.",
        citations: ["a1"],
        unexpected: true,
      },
    },
  ])("rejects an answer with $name before final revalidation", async ({ response }) => {
    const layer3 = {
      retrieve: vi.fn(async () => release()),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const audit = { append: vi.fn() };
    const answer = createLeanAnswerComposition({
      planner: { generate: vi.fn(async () => ({ queries: [] })) },
      answerer: { generate: vi.fn(async () => response) },
      layer3,
      audit,
      provider: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });

    await expect(answer.answer({ question: "What is the launch date?" })).rejects.toBeInstanceOf(
      LeanAnswerCompositionError,
    );
    expect(layer3.revalidate).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
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

  it.each([
    {
      name: "contains an invalid Layer 2 query",
      response: { queries: ["   "] },
    },
    {
      name: "contains an undeclared property",
      response: { queries: [], unexpected: true },
    },
  ])("fails closed before retrieval when planner output $name", async ({ response }) => {
    const layer3 = {
      retrieve: vi.fn(async () => release(false)),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const answerer = { generate: vi.fn() };
    const audit = { append: vi.fn() };
    const answer = createLeanAnswerComposition({
      planner: { generate: vi.fn(async () => response) },
      answerer,
      layer3,
      audit,
      provider: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });
    await expect(
      answer.answer({ question: "What is the launch date?" }),
    ).rejects.toBeInstanceOf(LeanAnswerCompositionError);
    expect(layer3.retrieve).not.toHaveBeenCalled();
    expect(layer3.revalidate).not.toHaveBeenCalled();
    expect(answerer.generate).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("fails closed before retrieval when the planner is unavailable", async () => {
    const plannerFailure = new Error("provider unavailable");
    const layer3 = {
      retrieve: vi.fn(async () => release()),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const answerer = {
      generate: vi.fn(async () => ({
        status: "answered",
        answer: "Tuesday.",
        citations: ["a1"],
      })),
    };
    const audit = { append: vi.fn() };
    const answer = createLeanAnswerComposition({
      planner: {
        generate: vi.fn(async () => {
          throw plannerFailure;
        }),
      },
      answerer,
      layer3,
      audit,
      provider: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });

    await expect(
      answer.answer({ question: "What is the launch date?" }),
    ).rejects.toBe(plannerFailure);
    expect(layer3.retrieve).not.toHaveBeenCalled();
    expect(layer3.revalidate).not.toHaveBeenCalled();
    expect(answerer.generate).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("reports a redacted planner validation failure while releasing nothing", async () => {
    const diagnostics: Layer4FailureDiagnosticV1[] = [];
    const question = "Question that must not appear in the diagnostic";
    const layer3 = {
      retrieve: vi.fn(async () => ({
        ...release(false),
        released_atoms: [],
      })),
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
      on_failure: (event) => diagnostics.push(event),
      now_ms: vi.fn(() => 100),
    });

    await expect(answer.answer({ question })).rejects.toBeInstanceOf(
      LeanAnswerCompositionError,
    );

    expect(layer3.retrieve).not.toHaveBeenCalled();
    expect(layer3.revalidate).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([
      expect.objectContaining({
        schema_version: 1,
        kind: "echo-clean-layer4-failure-v1",
        stage: "planner",
        failure_class: "core_validation",
        elapsed_ms: 0,
        http_status: null,
        provider: null,
        finish_reason: null,
        provider_generation_id: null,
        retrieval_generation_id: null,
      }),
    ]);
    const serialized = JSON.stringify(diagnostics[0]);
    expect(serialized).not.toContain(question);
    expect(serialized).not.toContain("Insufficient accessible evidence");
  });

  it("reports answer validation failure against the exact released generation", async () => {
    const diagnostics: Layer4FailureDiagnosticV1[] = [];
    const released = release();
    const layer3 = {
      retrieve: vi.fn(async () => released),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const answer = createLeanAnswerComposition({
      planner: { generate: vi.fn(async () => ({ queries: [] })) },
      answerer: {
        generate: vi.fn(async () => ({
          status: "answered",
          answer: "Answer text that must not appear in the diagnostic",
          citations: ["a1", "a1"],
        })),
      },
      layer3,
      audit: { append: vi.fn() },
      provider: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
      on_failure: (event) => diagnostics.push(event),
      now_ms: vi.fn(() => 100),
    });

    await expect(answer.answer({ question: "Question that must remain redacted" })).rejects.toBeInstanceOf(
      LeanAnswerCompositionError,
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        schema_version: 1,
        kind: "echo-clean-layer4-failure-v1",
        stage: "answer",
        failure_class: "core_validation",
        elapsed_ms: 0,
        http_status: null,
        provider: null,
        finish_reason: null,
        provider_generation_id: null,
        retrieval_generation_id: released.generation_id,
      }),
    ]);
    const serialized = JSON.stringify(diagnostics[0]);
    expect(serialized).not.toContain("Question that must remain redacted");
    expect(serialized).not.toContain("Answer text that must not appear");
    expect(serialized).not.toContain(released.released_atoms[0]?.text ?? "");
  });

  it("propagates only safe structural adapter failure metadata into the answer diagnostic", async () => {
    const diagnostics: Layer4FailureDiagnosticV1[] = [];
    const question = "Question that must remain absent from adapter diagnostics";
    const released = release();
    const adapterFailure = Object.assign(new Error("Provider failure text is not diagnostic data"), {
      diagnostic: Object.freeze({
        failure_class: "adapter_finish",
        http_status: 200,
        provider: "novita",
        finish_reason: "length",
        provider_generation_id: "gen-abcdefgh12345678",
      }),
    });
    const answer = createLeanAnswerComposition({
      planner: { generate: vi.fn(async () => ({ queries: [] })) },
      answerer: { generate: vi.fn(async () => { throw adapterFailure; }) },
      layer3: {
        retrieve: vi.fn(async () => released),
        revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
      },
      audit: { append: vi.fn() },
      provider: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
      on_failure: (event) => diagnostics.push(event),
      now_ms: vi.fn(() => 100),
    });

    await expect(answer.answer({ question })).rejects.toBe(adapterFailure);

    expect(diagnostics).toEqual([
      expect.objectContaining({
        stage: "answer",
        failure_class: "adapter_finish",
        http_status: 200,
        provider: "novita",
        finish_reason: "length",
        provider_generation_id: "gen-abcdefgh12345678",
        retrieval_generation_id: released.generation_id,
      }),
    ]);
    const serialized = JSON.stringify(diagnostics[0]);
    expect(serialized).not.toContain(question);
    expect(serialized).not.toContain("Provider failure text");
    expect(serialized).not.toContain(released.released_atoms[0]?.text ?? "");
  });

  it("does not let a diagnostics observer failure mask planner rejection", async () => {
    const layer3 = {
      retrieve: vi.fn(async () => release()),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const answer = createLeanAnswerComposition({
      planner: { generate: vi.fn(async () => ({ queries: ["   "] })) },
      answerer: { generate: vi.fn(async () => ({ status: "answered", answer: "Tuesday.", citations: ["a1"] })) },
      layer3,
      audit: { append: vi.fn() },
      provider: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
      on_failure: () => {
        throw new Error("diagnostics sink unavailable");
      },
    });

    await expect(
      answer.answer({ question: "What is the launch date?" }),
    ).rejects.toBeInstanceOf(LeanAnswerCompositionError);
    expect(layer3.retrieve).not.toHaveBeenCalled();
    expect(layer3.revalidate).not.toHaveBeenCalled();
  });

  it("does not invoke the planner after caller cancellation", async () => {
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
