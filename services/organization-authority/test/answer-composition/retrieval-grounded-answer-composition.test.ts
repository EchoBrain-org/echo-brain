import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createRetrievalGroundedAnswerComposition,
  RetrievalGroundedAnswerCompositionError,
  type AnswerCompositionFailureDiagnosticV1,
  type ReleasedRetrievalBatch,
  type ReleasedRetrievalPort,
  type StructuredGenerationInput,
} from "../../src/answer-composition/retrieval-grounded-answer-composition.js";

const digest = (value: string): Sha256Digest => canonicalSha256({ value });

function release(atoms = true): ReleasedRetrievalBatch {
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

describe("retrieval-grounded answer composition", () => {
  it("plans once, reads one released retrieval batch, verifies citations, revalidates, and audits hashes", async () => {
    const events: string[] = [];
    let plannerRequest: StructuredGenerationInput | undefined;
    let answerRequest: StructuredGenerationInput | undefined;
    const planner = {
      generate: vi.fn(async (input: StructuredGenerationInput) => {
        plannerRequest = input;
        return { queries: ["launch date", "product owner"] };
      }),
    };
    const answerer = {
      generate: vi.fn(async (input: StructuredGenerationInput) => {
        answerRequest = input;
        events.push("answer");
        return { status: "answered", answer: "Tuesday, owned by the product team.", citations: ["a1", "a2"] };
      }),
    };
    let retrieveCount = 0;
    let retrievedQueries: readonly string[] | undefined;
    const releasedRetrieval: ReleasedRetrievalPort = {
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
    const answer = createRetrievalGroundedAnswerComposition({
      planner,
      answerer,
      released_retrieval: releasedRetrieval,
      audit: { append: (entry) => void auditEntries.push(entry) },
      generation_adapter_id: "openrouter",
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
      request: StructuredGenerationInput,
    ): Omit<StructuredGenerationInput, "signal"> => {
      const { signal: _signal, ...audited } = request;
      return audited;
    };
    expect(auditEntry.prompt_sha256).toBe(
      canonicalSha256({
        generation_adapter_id: "openrouter",
        planner: withoutSignal(plannerRequest as StructuredGenerationInput),
        answer: withoutSignal(answerRequest as StructuredGenerationInput),
      }),
    );
    expect(JSON.stringify(auditEntries[0])).not.toContain("When is the launch");
    expect(JSON.stringify(auditEntries[0])).not.toContain("Tuesday, owned");
  });

  it("accepts a non-OpenRouter adapter identifier and model form through the same core path", async () => {
    const audit = { append: vi.fn() };
    const answer = createRetrievalGroundedAnswerComposition({
      planner: { generate: vi.fn(async () => ({ queries: [] })) },
      answerer: {
        generate: vi.fn(async () => ({
          status: "answered",
          answer: "Tuesday.",
          citations: ["a1"],
        })),
      },
      released_retrieval: {
        retrieve: vi.fn(async () => release()),
        revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
      },
      audit,
      generation_adapter_id: "local-structured-output",
      planner_model: "qwen3:4b",
      answer_model: "qwen3:4b",
    });

    await expect(answer.answer({ question: "What is the launch date?" })).resolves.toMatchObject({
      answer: "Tuesday.",
      citations: [expect.objectContaining({ atom_id: release().released_atoms[0]?.atom_id })],
    });
    expect(audit.append).toHaveBeenCalledOnce();
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
    const releasedRetrieval = {
      retrieve: vi.fn(async () => release()),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const audit = { append: vi.fn() };
    const answer = createRetrievalGroundedAnswerComposition({
      planner: { generate: vi.fn(async () => ({ queries: [] })) },
      answerer: { generate: vi.fn(async () => response) },
      released_retrieval: releasedRetrieval,
      audit,
      generation_adapter_id: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });

    await expect(answer.answer({ question: "What is the launch date?" })).rejects.toBeInstanceOf(
      RetrievalGroundedAnswerCompositionError,
    );
    expect(releasedRetrieval.revalidate).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("does not call the answer model when released retrieval has no usable atoms, but revalidates and audits", async () => {
    const answerer = { generate: vi.fn(async () => ({ status: "answered", answer: "wrong", citations: ["a1"] })) };
    const releasedRetrieval = {
      retrieve: vi.fn(async () => release(false)),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const audit = { append: vi.fn() };
    const answer = createRetrievalGroundedAnswerComposition({
      planner: { generate: vi.fn(async () => ({ queries: [] })) },
      answerer,
      released_retrieval: releasedRetrieval,
      audit,
      generation_adapter_id: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });

    await expect(answer.answer({ question: "What is the launch date?" })).resolves.toMatchObject({
      answer: "Insufficient accessible evidence to answer this question.",
      citations: [],
    });
    expect(answerer.generate).not.toHaveBeenCalled();
    expect(releasedRetrieval.revalidate).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledTimes(1);
  });

  it("does not ask a model to attribute a first-person decision, while preserving Layer 3 release and audit", async () => {
    const planner = { generate: vi.fn() };
    const answerer = { generate: vi.fn() };
    const retrieved: string[][] = [];
    const releasedRetrieval = {
      retrieve: vi.fn(async (input: { readonly queries: readonly string[] }) => {
        retrieved.push([...input.queries]);
        return release();
      }),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const audit = { append: vi.fn() };
    const answer = createRetrievalGroundedAnswerComposition({
      planner,
      answerer,
      released_retrieval: releasedRetrieval,
      audit,
      generation_adapter_id: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });

    await expect(answer.answer({ question: "Which decisions did I make?" })).resolves.toMatchObject({
      outcome: "authorship_unsupported",
      answer: "I can summarize decisions in accessible records, but cannot determine whether you personally made them.",
      citations: [],
    });
    expect(planner.generate).not.toHaveBeenCalled();
    expect(answerer.generate).not.toHaveBeenCalled();
    expect(retrieved).toEqual([["Which decisions did I make?"]]);
    expect(releasedRetrieval.revalidate).toHaveBeenCalledOnce();
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "authorship_unsupported",
      retrieval: {
        planned_query_count: 1,
        released_atom_count: 2,
        context_atom_count: 0,
      },
    }));
  });

  it.each([
    {
      name: "contains an invalid retrieval query",
      response: { queries: ["   "] },
    },
    {
      name: "contains an undeclared property",
      response: { queries: [], unexpected: true },
    },
  ])("fails closed before retrieval when planner output $name", async ({ response }) => {
    const releasedRetrieval = {
      retrieve: vi.fn(async () => release(false)),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const answerer = { generate: vi.fn() };
    const audit = { append: vi.fn() };
    const answer = createRetrievalGroundedAnswerComposition({
      planner: { generate: vi.fn(async () => response) },
      answerer,
      released_retrieval: releasedRetrieval,
      audit,
      generation_adapter_id: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });
    await expect(
      answer.answer({ question: "What is the launch date?" }),
    ).rejects.toBeInstanceOf(RetrievalGroundedAnswerCompositionError);
    expect(releasedRetrieval.retrieve).not.toHaveBeenCalled();
    expect(releasedRetrieval.revalidate).not.toHaveBeenCalled();
    expect(answerer.generate).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("fails closed before retrieval when the planner is unavailable", async () => {
    const plannerFailure = new Error("provider unavailable");
    const releasedRetrieval = {
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
    const answer = createRetrievalGroundedAnswerComposition({
      planner: {
        generate: vi.fn(async () => {
          throw plannerFailure;
        }),
      },
      answerer,
      released_retrieval: releasedRetrieval,
      audit,
      generation_adapter_id: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });

    await expect(
      answer.answer({ question: "What is the launch date?" }),
    ).rejects.toBe(plannerFailure);
    expect(releasedRetrieval.retrieve).not.toHaveBeenCalled();
    expect(releasedRetrieval.revalidate).not.toHaveBeenCalled();
    expect(answerer.generate).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("reports a redacted planner validation failure while releasing nothing", async () => {
    const diagnostics: AnswerCompositionFailureDiagnosticV1[] = [];
    const question = "Question that must not appear in the diagnostic";
    const releasedRetrieval = {
      retrieve: vi.fn(async () => ({
        ...release(false),
        released_atoms: [],
      })),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const answer = createRetrievalGroundedAnswerComposition({
      planner: { generate: vi.fn(async () => ({ queries: ["   "] })) },
      answerer: { generate: vi.fn() },
      released_retrieval: releasedRetrieval,
      audit: { append: vi.fn() },
      generation_adapter_id: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
      on_failure: (event) => diagnostics.push(event),
      now_ms: vi.fn(() => 100),
    });

    await expect(answer.answer({ question })).rejects.toBeInstanceOf(
      RetrievalGroundedAnswerCompositionError,
    );

    expect(releasedRetrieval.retrieve).not.toHaveBeenCalled();
    expect(releasedRetrieval.revalidate).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([
      expect.objectContaining({
        schema_version: 1,
        kind: "echo-clean-layer4-failure-v1",
        stage: "planner",
        failure_class: "core_validation",
        elapsed_ms: 0,
        http_status: null,
        adapter_id: null,
        finish_reason: null,
        adapter_request_id: null,
        retrieval_generation_id: null,
      }),
    ]);
    const serialized = JSON.stringify(diagnostics[0]);
    expect(serialized).not.toContain(question);
    expect(serialized).not.toContain("Insufficient accessible evidence");
  });

  it("reports answer validation failure against the exact released generation", async () => {
    const diagnostics: AnswerCompositionFailureDiagnosticV1[] = [];
    const released = release();
    const releasedRetrieval = {
      retrieve: vi.fn(async () => released),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const answer = createRetrievalGroundedAnswerComposition({
      planner: { generate: vi.fn(async () => ({ queries: [] })) },
      answerer: {
        generate: vi.fn(async () => ({
          status: "answered",
          answer: "Answer text that must not appear in the diagnostic",
          citations: ["a1", "a1"],
        })),
      },
      released_retrieval: releasedRetrieval,
      audit: { append: vi.fn() },
      generation_adapter_id: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
      on_failure: (event) => diagnostics.push(event),
      now_ms: vi.fn(() => 100),
    });

    await expect(answer.answer({ question: "Question that must remain redacted" })).rejects.toBeInstanceOf(
      RetrievalGroundedAnswerCompositionError,
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        schema_version: 1,
        kind: "echo-clean-layer4-failure-v1",
        stage: "answer",
        failure_class: "core_validation",
        elapsed_ms: 0,
        http_status: null,
        adapter_id: null,
        finish_reason: null,
        adapter_request_id: null,
        retrieval_generation_id: released.generation_id,
      }),
    ]);
    const serialized = JSON.stringify(diagnostics[0]);
    expect(serialized).not.toContain("Question that must remain redacted");
    expect(serialized).not.toContain("Answer text that must not appear");
    expect(serialized).not.toContain(released.released_atoms[0]?.text ?? "");
  });

  it("propagates only safe structural adapter failure metadata into the answer diagnostic", async () => {
    const diagnostics: AnswerCompositionFailureDiagnosticV1[] = [];
    const question = "Question that must remain absent from adapter diagnostics";
    const released = release();
    const adapterFailure = Object.assign(new Error("Provider failure text is not diagnostic data"), {
      diagnostic: Object.freeze({
        failure_class: "adapter_finish",
        http_status: 200,
        adapter_id: "non-openrouter-adapter",
        finish_reason: "length",
        adapter_request_id: "request-abcdefgh12345678",
      }),
    });
    const answer = createRetrievalGroundedAnswerComposition({
      planner: { generate: vi.fn(async () => ({ queries: [] })) },
      answerer: { generate: vi.fn(async () => { throw adapterFailure; }) },
      released_retrieval: {
        retrieve: vi.fn(async () => released),
        revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
      },
      audit: { append: vi.fn() },
      generation_adapter_id: "openrouter",
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
        adapter_id: "non-openrouter-adapter",
        finish_reason: "length",
        adapter_request_id: "request-abcdefgh12345678",
        retrieval_generation_id: released.generation_id,
      }),
    ]);
    const serialized = JSON.stringify(diagnostics[0]);
    expect(serialized).not.toContain(question);
    expect(serialized).not.toContain("Provider failure text");
    expect(serialized).not.toContain(released.released_atoms[0]?.text ?? "");
  });

  it("does not let a diagnostics observer failure mask planner rejection", async () => {
    const releasedRetrieval = {
      retrieve: vi.fn(async () => release()),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const answer = createRetrievalGroundedAnswerComposition({
      planner: { generate: vi.fn(async () => ({ queries: ["   "] })) },
      answerer: { generate: vi.fn(async () => ({ status: "answered", answer: "Tuesday.", citations: ["a1"] })) },
      released_retrieval: releasedRetrieval,
      audit: { append: vi.fn() },
      generation_adapter_id: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
      on_failure: () => {
        throw new Error("diagnostics sink unavailable");
      },
    });

    await expect(
      answer.answer({ question: "What is the launch date?" }),
    ).rejects.toBeInstanceOf(RetrievalGroundedAnswerCompositionError);
    expect(releasedRetrieval.retrieve).not.toHaveBeenCalled();
    expect(releasedRetrieval.revalidate).not.toHaveBeenCalled();
  });

  it("does not invoke the planner after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    const planner = { generate: vi.fn() };
    const releasedRetrieval = {
      retrieve: vi.fn(async () => release()),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const answer = createRetrievalGroundedAnswerComposition({
      planner,
      answerer: { generate: vi.fn() },
      released_retrieval: releasedRetrieval,
      audit: { append: vi.fn() },
      generation_adapter_id: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });

    await expect(
      answer.answer({ question: "What is the launch date?", signal: controller.signal }),
    ).rejects.toThrow("caller cancelled");
    expect(planner.generate).not.toHaveBeenCalled();
    expect(releasedRetrieval.retrieve).not.toHaveBeenCalled();
  });

  it("keeps the original query first and drops exact planner duplicates", async () => {
    const releasedRetrieval = {
      retrieve: vi.fn(async () => release(false)),
      revalidate: vi.fn(async () => ({ checked_at: "2026-08-23T00:00:01.000Z" })),
    };
    const question = "What is the launch date?";
    const answer = createRetrievalGroundedAnswerComposition({
      planner: {
        generate: vi.fn(async () => ({
          queries: [question, "launch date", "launch date"],
        })),
      },
      answerer: { generate: vi.fn() },
      released_retrieval: releasedRetrieval,
      audit: { append: vi.fn() },
      generation_adapter_id: "openrouter",
      planner_model: "openai/gpt-4.1-mini",
      answer_model: "openai/gpt-4.1-mini",
    });

    await answer.answer({ question });

    expect(releasedRetrieval.retrieve).toHaveBeenCalledWith({
      queries: [question, "launch date"],
    });
  });
});
