import { once } from "node:events";
import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqlitePersonAnswerCompositionAuditV1 } from "../src/adapters/persistence/sqlite/person-answer-composition-audit-v1.js";
import { applyAuthorityBaselineV1 } from "../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-authority-database.js";
import type { PersonAccessAuthorization } from "../src/application/person-identity-sessions.js";
import {
  createPersonAnswerRouteV1,
  type AnswerCompositionFailureEventV1,
} from "../src/composition/person-answer-route.js";
import type {
  StructuredGenerationInput,
  StructuredGenerationPort,
} from "../src/answer-composition/retrieval-grounded-answer-composition.js";
import type {
  PersonRecordSearchBatchApplicationV1,
  PersonRecordSearchBatchReleaseV1,
} from "../src/composition/person-record-search-route.js";
import {
  createAskJourneyTelemetryFactoryV1,
  type AskJourneyTelemetryFactoryV1,
} from "../src/composition/ask-journey-telemetry-v1.js";
import type { AnswerCompositionGenerationProfileV1 } from "../src/composition/answer-composition-generation-bundle-v1.js";
import { AuthorityOperationError } from "../src/domain/errors.js";
import type { JourneyTelemetryEventV1 } from "../src/shared/journey-telemetry-v1.js";
import { createOrganizationAuthorityHttpServer } from "../src/presentation/organization-authority-http-server.js";
import type {
  PersonAnswerHttpApplicationV1,
  PersonAnswerResponseV1,
} from "../src/presentation/person-answer-http-application.js";

const digest = (value: string): Sha256Digest => canonicalSha256({ value });
const NOW = "2026-08-23T00:00:00.000Z";
const GENERATION = Object.freeze({
  generation_adapter_id: "test-structured-output",
  planner_model: "test-planner",
  answer_model: "test-answer",
  timeout_ms: 60_000,
});
const STAGING_GENERATION = Object.freeze({
  generation_adapter_id: "openrouter",
  planner_model: "deepseek/deepseek-v3.2",
  answer_model: "deepseek/deepseek-v3.2",
  timeout_ms: 60_000,
});

function authorization(): PersonAccessAuthorization {
  return {
    organization_id: "org_clean",
    principal_id: "principal_reader",
    membership_id: "membership_reader",
    membership_type: "employee",
    identity_binding_id: "identity_reader",
    session_family_id: "session_reader",
    access_credential_sha256: digest("access"),
    access_expires_at: "2026-08-23T01:00:00.000Z",
    hard_reauthentication_at: "2026-08-23T02:00:00.000Z",
    person_state_sha256: digest("person"),
    session_state_sha256: digest("session"),
    checked_at: NOW,
  };
}

function release(): PersonRecordSearchBatchReleaseV1 {
  const current = authorization();
  return Object.freeze({
    initial_authorization: Object.freeze({ ...current }),
    current_authorization: Object.freeze({ ...current }),
    active_pointer: Object.freeze({
      generation_id: digest("generation"),
      manifest_sha256: digest("manifest"),
      retrieval_contract_sha256: digest("contract"),
      record_head: Object.freeze({ position: 7, record_sha256: digest("head") }),
    }),
    record_read_audit_row_sha256: digest("layer3-release"),
  });
}

function searchResponse() {
  return Object.freeze({
    schema_version: 1 as const,
    kind: "echo-clean-person-record-search-v1" as const,
    generation_id: digest("generation"),
    record_head: Object.freeze({ position: 7, record_sha256: digest("head") }),
    items: Object.freeze([
      Object.freeze({
        atom_id: digest("atom-one"),
        record_sha256: digest("record-one"),
        kind: "decision" as const,
        text: "The launch is Tuesday.",
        policy_id: "organization-member-readable-person-v2" as const,
      }),
      Object.freeze({
        atom_id: digest("atom-two"),
        record_sha256: digest("record-two"),
        kind: "rationale" as const,
        text: "The product team owns the launch.",
        policy_id: "restricted-reviewer-person-v2" as const,
      }),
    ]),
  });
}

function setup(input: {
  readonly model?: StructuredGenerationPort;
  readonly generation?: AnswerCompositionGenerationProfileV1;
  readonly ask_journey_telemetry?: AskJourneyTelemetryFactoryV1;
  readonly revalidate?: () => PersonAccessAuthorization;
  readonly on_failure?: (event: AnswerCompositionFailureEventV1) => void;
  readonly source_text?: string;
  readonly query_hit_counts?: readonly number[];
}) {
  const database = openAuthorityDatabase(":memory:");
  applyAuthorityBaselineV1(database);
  const events: string[] = [];
  const witness = release();
  const search: PersonRecordSearchBatchApplicationV1 = {
    searchBatch: vi.fn((_value) => {
      _value.on_authorized?.();
      events.push("batch");
      const response = searchResponse();
      const sourceText = input.source_text;
      return Object.freeze({
        response:
          sourceText === undefined
            ? response
            : Object.freeze({
                ...response,
                items: Object.freeze(
                  response.items.map((item) =>
                    Object.freeze({ ...item, text: sourceText }),
                  ),
                ),
              }),
        release: witness,
        query_hit_counts: Object.freeze(
          input.query_hit_counts ?? _value.queries.map(() => 2),
        ),
      });
    }),
    revalidateBatchRelease: vi.fn(() => {
      events.push("revalidate");
      return input.revalidate?.() ?? authorization();
    }),
  };
  const audit = new SqlitePersonAnswerCompositionAuditV1(database);
  const append = vi.spyOn(audit, "append").mockImplementation((entry) => {
    events.push("audit");
    return digest(`answer-audit-${entry.checked_at}`);
  });
  const modelInputs: StructuredGenerationInput[] = [];
  const defaultModel: StructuredGenerationPort = {
    generate: vi.fn(
      async (request: StructuredGenerationInput): Promise<unknown> => {
        modelInputs.push(request);
        return modelInputs.length === 1
          ? { queries: ["launch date", "launch owner"] }
          : {
              status: "answered",
              answer: "Tuesday, owned by the product team.",
              citations: ["a1", "a2"],
            };
      },
    ),
  };
  const model = input.model ?? defaultModel;
  const route = createPersonAnswerRouteV1({
    authority_id: "oau_clean",
    organization_id: "org_clean",
    state_lineage_id: "lineage_clean",
    search,
    model,
    generation: input.generation ?? GENERATION,
    audit,
    ...(input.ask_journey_telemetry === undefined
      ? {}
      : { ask_journey_telemetry: input.ask_journey_telemetry }),
    ...(input.on_failure === undefined ? {} : { on_failure: input.on_failure }),
  });
  return { database, events, search, append, modelInputs, route };
}

function stagingTelemetry(
  events: JourneyTelemetryEventV1[],
  uuid: string,
  buildNumber: number,
): AskJourneyTelemetryFactoryV1 {
  let monotonicNow = 3_000;
  return createAskJourneyTelemetryFactoryV1({
    observer: (event) => {
      events.push(event);
    },
    release_sha: "d".repeat(40),
    build_number: buildNumber,
    planner_model: "deepseek/deepseek-v3.2",
    answer_model: "deepseek/deepseek-v3.2",
    clock: {
      now: () => "2026-09-02T17:00:02.000Z",
      create_uuid: () => uuid,
    },
    now_ms: () => monotonicNow++,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("Person answer route", () => {
  it("uses the bearer as the only caller identity, makes one bounded Layer 3 batch, and returns only public bindings", async () => {
    const value = setup({});
    try {
      const response = await value.route.ask({
        access_token: "bearer-only-token",
        question: "When is the launch and who owns it?",
      });

      expect(value.search.searchBatch).toHaveBeenCalledOnce();
      expect(value.search.searchBatch).toHaveBeenCalledWith({
        access_token: "bearer-only-token",
        queries: [
          "When is the launch and who owns it?",
          "launch date",
          "launch owner",
        ],
        limit: 10,
        include_related_atom_packet: true,
      });
      expect(value.search.revalidateBatchRelease).toHaveBeenCalledWith({
        access_token: "bearer-only-token",
        release: expect.anything(),
      });
      expect(JSON.stringify(value.modelInputs)).not.toContain(
        "bearer-only-token",
      );
      expect(JSON.stringify(value.modelInputs)).not.toContain(
        "principal_reader",
      );
      expect(value.modelInputs.map((input) => input.timeout_ms)).toEqual([
        60_000,
        60_000,
      ]);
      expect(value.events).toEqual(["batch", "revalidate", "audit"]);
      expect(value.append).toHaveBeenCalledOnce();
      expect(response).toEqual({
        schema_version: 1,
        kind: "echo-clean-person-answer-v1",
        generation_id: digest("generation"),
        record_head: { position: 7, record_sha256: digest("head") },
        answer: "Tuesday, owned by the product team.",
        citations: [
          {
            atom_id: digest("atom-one"),
            record_sha256: digest("record-one"),
            policy_id: "organization-member-readable-person-v2",
          },
          {
            atom_id: digest("atom-two"),
            record_sha256: digest("record-two"),
            policy_id: "restricted-reviewer-person-v2",
          },
        ],
      });
      expect(response).not.toHaveProperty("status");
      expect(response.citations[0]).not.toHaveProperty("citation_id");
      expect(value.append.mock.calls[0]?.[0].response_sha256).toBe(
        canonicalSha256(response as never),
      );
    } finally {
      value.database.close();
    }
  });

  it("emits one content-free staging journey with stage latency and per-call token usage", async () => {
    const telemetry: JourneyTelemetryEventV1[] = [];
    let monotonicNow = 1_000;
    let observedCalls = 0;
    const model: StructuredGenerationPort = {
      generate: vi.fn(async () => {
        throw new Error("the value-only path must remain unused in staging");
      }),
      generate_with_observation: vi.fn(async () => {
        observedCalls += 1;
        return {
          value:
            observedCalls === 1
              ? { queries: ["launch date", "launch owner"] }
              : {
                  status: "answered",
                  answer: "Tuesday, owned by the product team.",
                  citations: ["a1", "a2"],
                },
          usage:
            observedCalls === 1
              ? {
                  input_tokens: 101,
                  output_tokens: 17,
                  total_tokens: 118,
                  cached_input_tokens: 41,
                  reasoning_tokens: 7,
                }
              : {
                  input_tokens: 211,
                  output_tokens: 29,
                  total_tokens: 240,
                  cached_input_tokens: 53,
                  reasoning_tokens: 11,
                },
          finish_reason: "stop" as const,
          provider_latency_ms: observedCalls === 1 ? 13 : 17,
        };
      }),
    };
    const journeyFactory = createAskJourneyTelemetryFactoryV1({
      observer: (event) => {
        telemetry.push(event);
      },
      release_sha: "a".repeat(40),
      build_number: 42,
      planner_model: "deepseek/deepseek-v3.2",
      answer_model: "deepseek/deepseek-v3.2",
      clock: {
        now: () => "2026-09-02T17:00:00.000Z",
        create_uuid: () => "123e4567-e89b-42d3-a456-426614174000",
      },
      now_ms: () => monotonicNow++,
    });
    const value = setup({
      model,
      generation: STAGING_GENERATION,
      ask_journey_telemetry: journeyFactory,
    });
    const question = "QUESTION-DO-NOT-LOG-journey-success";
    try {
      await expect(
        value.route.ask({
          access_token: "BEARER-DO-NOT-LOG-journey-success",
          question,
        }),
      ).resolves.toMatchObject({
        answer: "Tuesday, owned by the product team.",
      });

      await vi.waitFor(() => expect(telemetry).toHaveLength(10));
      expect(model.generate).not.toHaveBeenCalled();
      expect(model.generate_with_observation).toHaveBeenCalledTimes(2);
      expect(telemetry.map((event) => event.stage)).toEqual([
        "ask_validation",
        "ask_validation",
        "ask_planner",
        "ask_authorization",
        "ask_retrieval",
        "ask_context",
        "ask_answer",
        "ask_revalidation",
        "ask_audit",
        "ask_response",
      ]);
      expect(telemetry.map((event) => event.sequence)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);
      expect(telemetry[0]).toMatchObject({
        stage: "ask_validation",
        event: "started",
        sequence: 1,
        elapsed_ms: 0,
      });
      expect(telemetry[1]).toMatchObject({
        stage: "ask_validation",
        event: "succeeded",
        sequence: 2,
      });
      expect(
        telemetry.every(
          (event) =>
            Number.isSafeInteger(event.elapsed_ms) && event.elapsed_ms >= 0,
        ),
      ).toBe(true);
      expect(
        telemetry.every(
          (event) =>
            event.journey_id ===
              "123e4567-e89b-42d3-a456-426614174000" &&
            event.release_sha === "a".repeat(40) &&
            event.build_number === 42 &&
            event.environment === "staging" &&
            event.workflow === "ask",
        ),
      ).toBe(true);
      expect(
        telemetry.find((event) => event.stage === "ask_planner"),
      ).toMatchObject({
        event: "succeeded",
        elapsed_ms: expect.any(Number),
        retrieval: { planned_query_count: 3 },
        llm_usage: {
          usage_status: "reported",
          provider: "openrouter",
          model: "deepseek/deepseek-v3.2",
          provider_latency_ms: 13,
          input_tokens: 101,
          output_tokens: 17,
          total_tokens: 118,
          cached_input_tokens: 41,
          reasoning_tokens: 7,
          finish_reason: "stop",
        },
      });
      expect(
        telemetry.find((event) => event.stage === "ask_answer"),
      ).toMatchObject({
        event: "succeeded",
        retrieval: {
          planned_query_count: 3,
          query_hit_count: 6,
          released_atom_count: 2,
          context_atom_count: 2,
          citation_count: 2,
        },
        llm_usage: {
          input_tokens: 211,
          output_tokens: 29,
          total_tokens: 240,
          cached_input_tokens: 53,
          reasoning_tokens: 11,
        },
      });
      expect(
        telemetry.find((event) => event.stage === "ask_response"),
      ).toMatchObject({
        event: "succeeded",
        outcome: "answered",
        elapsed_ms: expect.any(Number),
        retrieval: {
          planned_query_count: 3,
          query_hit_count: 6,
          released_atom_count: 2,
          context_atom_count: 2,
          citation_count: 2,
        },
      });

      const serialized = JSON.stringify(telemetry);
      for (const forbidden of [
        question,
        "BEARER-DO-NOT-LOG-journey-success",
        "The launch is Tuesday.",
        "The product team owns the launch.",
        "Tuesday, owned by the product team.",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      value.database.close();
    }
  });

  it("closes the failed staging journey and skips every unattempted stage", async () => {
    const telemetry: JourneyTelemetryEventV1[] = [];
    let monotonicNow = 2_000;
    const providerSecret = "PROVIDER-SECRET-DO-NOT-LOG-journey-failure";
    const providerFailure = Object.assign(new Error(providerSecret), {
      diagnostic: {
        failure_class: "adapter_finish",
        http_status: 200,
        adapter_id: "openrouter",
        finish_reason: "length",
        adapter_request_id: null,
      },
      generation_observation: {
        usage: {
          input_tokens: 73,
          output_tokens: 9,
          total_tokens: 82,
          cached_input_tokens: 21,
          reasoning_tokens: 4,
        },
        provider_latency_ms: 19,
      },
    });
    const model: StructuredGenerationPort = {
      generate: vi.fn(),
      generate_with_observation: vi.fn(async () => {
        throw providerFailure;
      }),
    };
    const value = setup({
      model,
      generation: STAGING_GENERATION,
      ask_journey_telemetry: createAskJourneyTelemetryFactoryV1({
        observer: (event) => {
          telemetry.push(event);
        },
        release_sha: "b".repeat(40),
        build_number: 43,
        planner_model: "deepseek/deepseek-v3.2",
        answer_model: "deepseek/deepseek-v3.2",
        clock: {
          now: () => "2026-09-02T17:00:01.000Z",
          create_uuid: () => "223e4567-e89b-42d3-a456-426614174000",
        },
        now_ms: () => monotonicNow++,
      }),
    });
    try {
      await expect(
        value.route.ask({
          access_token: "BEARER-DO-NOT-LOG-journey-failure",
          question: "QUESTION-DO-NOT-LOG-journey-failure",
        }),
      ).rejects.toMatchObject({
        code: "unavailable",
        message: "answer composition is unavailable",
      });

      await vi.waitFor(() => expect(telemetry).toHaveLength(10));
      expect(telemetry.map(({ stage, event }) => [stage, event])).toEqual([
        ["ask_validation", "started"],
        ["ask_validation", "succeeded"],
        ["ask_planner", "failed"],
        ["ask_authorization", "skipped"],
        ["ask_retrieval", "skipped"],
        ["ask_context", "skipped"],
        ["ask_answer", "skipped"],
        ["ask_revalidation", "skipped"],
        ["ask_audit", "skipped"],
        ["ask_response", "failed"],
      ]);
      expect(telemetry[2]).toMatchObject({
        failure_class: "provider_rejected",
        retryable: false,
        llm_usage: {
          usage_status: "reported",
          provider: "openrouter",
          model: "deepseek/deepseek-v3.2",
          input_tokens: 73,
          output_tokens: 9,
          total_tokens: 82,
          cached_input_tokens: 21,
          reasoning_tokens: 4,
          provider_latency_ms: 19,
          finish_reason: "length",
        },
      });
      expect(telemetry.at(-1)).toMatchObject({
        stage: "ask_response",
        event: "failed",
        failure_class: "provider_rejected",
        retryable: false,
      });
      const serialized = JSON.stringify(telemetry);
      expect(serialized).not.toContain(providerSecret);
      expect(serialized).not.toContain("BEARER-DO-NOT-LOG-journey-failure");
      expect(serialized).not.toContain("QUESTION-DO-NOT-LOG-journey-failure");
    } finally {
      value.database.close();
    }
  });

  it("marks a malformed released retrieval as failed instead of successful", async () => {
    const telemetry: JourneyTelemetryEventV1[] = [];
    const value = setup({
      generation: STAGING_GENERATION,
      ask_journey_telemetry: stagingTelemetry(
        telemetry,
        "323e4567-e89b-42d3-a456-426614174000",
        45,
      ),
      query_hit_counts: [2],
    });
    try {
      await expect(
        value.route.ask({
          access_token: "bearer-only-token",
          question: "When is the launch?",
        }),
      ).rejects.toMatchObject({ code: "unavailable" });

      await vi.waitFor(() => expect(telemetry).toHaveLength(10));
      expect(
        telemetry.find((event) => event.stage === "ask_authorization"),
      ).toMatchObject({ event: "succeeded" });
      expect(
        telemetry.find((event) => event.stage === "ask_retrieval"),
      ).toMatchObject({
        event: "failed",
        failure_class: "invalid_contract",
        retryable: false,
      });
      expect(
        telemetry.find((event) => event.stage === "ask_context"),
      ).toMatchObject({ event: "skipped", outcome: "skipped" });
      expect(telemetry.at(-1)).toMatchObject({
        stage: "ask_response",
        event: "failed",
        failure_class: "invalid_contract",
      });
    } finally {
      value.database.close();
    }
  });

  it("marks malformed final revalidation as failed before audit", async () => {
    const telemetry: JourneyTelemetryEventV1[] = [];
    const value = setup({
      generation: STAGING_GENERATION,
      ask_journey_telemetry: stagingTelemetry(
        telemetry,
        "423e4567-e89b-42d3-a456-426614174000",
        46,
      ),
      revalidate: () => ({
        ...authorization(),
        checked_at: "not-a-timestamp",
      }),
    });
    try {
      await expect(
        value.route.ask({
          access_token: "bearer-only-token",
          question: "When is the launch?",
        }),
      ).rejects.toMatchObject({ code: "unavailable" });

      await vi.waitFor(() => expect(telemetry).toHaveLength(10));
      expect(
        telemetry.find((event) => event.stage === "ask_answer"),
      ).toMatchObject({ event: "succeeded" });
      expect(
        telemetry.find((event) => event.stage === "ask_revalidation"),
      ).toMatchObject({
        event: "failed",
        failure_class: "invalid_contract",
        retryable: false,
      });
      expect(
        telemetry.find((event) => event.stage === "ask_audit"),
      ).toMatchObject({ event: "skipped", outcome: "skipped" });
      expect(telemetry.at(-1)).toMatchObject({
        stage: "ask_response",
        event: "failed",
        failure_class: "invalid_contract",
      });
    } finally {
      value.database.close();
    }
  });

  it("keeps the answer path available when the staging observer throws", async () => {
    const observer = vi.fn(() => {
      throw new Error("telemetry transport unavailable");
    });
    const value = setup({
      ask_journey_telemetry: createAskJourneyTelemetryFactoryV1({
        observer,
        release_sha: "c".repeat(40),
        build_number: 44,
        planner_model: "deepseek/deepseek-v3.2",
        answer_model: "deepseek/deepseek-v3.2",
      }),
      generation: STAGING_GENERATION,
    });
    try {
      await expect(
        value.route.ask({
          access_token: "bearer-only-token",
          question: "When is the launch?",
        }),
      ).resolves.toMatchObject({
        answer: "Tuesday, owned by the product team.",
      });
      await vi.waitFor(() => expect(observer).toHaveBeenCalled());
    } finally {
      value.database.close();
    }
  });

  it("forwards an original-question selector through Layer 3", async () => {
    const releaseId = "clean-v1-staging-20260830-014";
    const value = setup({});
    try {
      await value.route.ask({
        access_token: "bearer-only-token",
        question: `What did we decide for ${releaseId}?`,
      });

      expect(value.search.searchBatch).toHaveBeenCalledWith({
        access_token: "bearer-only-token",
        queries: [
          `What did we decide for ${releaseId}?`,
          "launch date",
          "launch owner",
        ],
        exact_release_id: releaseId,
        limit: 10,
        include_related_atom_packet: true,
      });
    } finally {
      value.database.close();
    }
  });

  it.each([
    {
      name: "the provider fails during planning",
      model: { generate: vi.fn(async () => { throw new Error("provider timeout"); }) },
      modelCalls: 1,
      searchCalls: 0,
      revalidationCalls: 0,
    },
    {
      name: "the planner throws an authority-shaped error",
      model: {
        generate: vi.fn(async () => {
          throw new AuthorityOperationError(
            "unauthorized",
            "model error must not escape",
          );
        }),
      },
      modelCalls: 1,
      searchCalls: 0,
      revalidationCalls: 0,
    },
    {
      name: "the planner returns malformed output",
      model: { generate: vi.fn(async () => ({ queries: ["   "] })) },
      modelCalls: 1,
      searchCalls: 0,
      revalidationCalls: 0,
    },
    {
      name: "the answer cites an atom Layer 3 did not release",
      model: {
        generate: vi
          .fn()
          .mockResolvedValueOnce({ queries: [] })
          .mockResolvedValueOnce({
            status: "answered",
            answer: "Unsupported.",
            citations: ["a99"],
          }),
      },
      modelCalls: 2,
      searchCalls: 1,
      revalidationCalls: 0,
    },
    {
      name: "the answer provider fails after retrieval",
      model: {
        generate: vi
          .fn()
          .mockResolvedValueOnce({ queries: [] })
          .mockRejectedValueOnce(new Error("provider timeout")),
      },
      modelCalls: 2,
      searchCalls: 1,
      revalidationCalls: 0,
    },
  ])("returns no answer or audit when $name", async ({ model, modelCalls, searchCalls, revalidationCalls }) => {
    const value = setup({ model });
    try {
      await expect(
        value.route.ask({
          access_token: "bearer-only-token",
          question: "When is the launch?",
        }),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(model.generate).toHaveBeenCalledTimes(modelCalls);
      expect(value.search.searchBatch).toHaveBeenCalledTimes(searchCalls);
      expect(value.search.revalidateBatchRelease).toHaveBeenCalledTimes(
        revalidationCalls,
      );
      expect(value.append).not.toHaveBeenCalled();
    } finally {
      value.database.close();
    }
  });

  it("reports one redacted answer failure while keeping the public error generic", async () => {
    const question = "QUESTION-DO-NOT-LOG-79a3067";
    const source = "SOURCE-DO-NOT-LOG-79a3067";
    const providerSecret = "PROVIDER-SECRET-DO-NOT-LOG-79a3067";
    const prompt = "PROMPT-DO-NOT-LOG-79a3067";
    const reasoning = "REASONING-DO-NOT-LOG-79a3067";
    const failures: AnswerCompositionFailureEventV1[] = [];
    const value = setup({
      model: {
        generate: vi
          .fn()
          .mockResolvedValueOnce({ queries: [] })
          .mockResolvedValueOnce({
            status: "answered",
            answer: `${providerSecret} ${prompt} ${reasoning}`,
            citations: ["a99"],
          }),
      },
      on_failure: (event) => failures.push(event),
      source_text: source,
    });
    try {
      await expect(
        value.route.ask({
          access_token: "bearer-only-token",
          question,
        }),
      ).rejects.toMatchObject({
        code: "unavailable",
        message: "answer composition is unavailable",
      });

      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        schema_version: 1,
        kind: "echo-clean-layer4-failure-v1",
        failure_id: expect.stringMatching(/^l4f_[0-9a-f-]{36}$/),
        stage: "answer",
        failure_class: "core_validation",
        http_status: null,
        adapter_id: null,
        finish_reason: null,
        adapter_request_id: null,
        retrieval_generation_id: digest("generation"),
      });
      expect(failures[0]?.elapsed_ms).toEqual(expect.any(Number));
      expect(failures[0]?.elapsed_ms).toBeGreaterThanOrEqual(0);

      const diagnostic = JSON.stringify(failures[0]);
      for (const forbidden of [
        question,
        source,
        providerSecret,
        prompt,
        reasoning,
      ]) {
        expect(diagnostic).not.toContain(forbidden);
      }
      expect(value.search.revalidateBatchRelease).not.toHaveBeenCalled();
      expect(value.append).not.toHaveBeenCalled();
    } finally {
      value.database.close();
    }
  });

  it("does not audit or return an answer when the final Layer 3 revalidation fails", async () => {
    const value = setup({
      revalidate: () => {
        throw new AuthorityOperationError("unauthorized", "person authentication failed");
      },
    });
    try {
      await expect(
        value.route.ask({
          access_token: "bearer-only-token",
          question: "When is the launch?",
        }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      expect(value.events).toEqual(["batch", "revalidate"]);
      expect(value.append).not.toHaveBeenCalled();
    } finally {
      value.database.close();
    }
  });

  it("returns the fixed authorship outcome without calling either model, after Layer 3 release and revalidation", async () => {
    const model: StructuredGenerationPort = { generate: vi.fn() };
    const value = setup({ model });
    try {
      await expect(
        value.route.ask({
          access_token: "bearer-only-token",
          question: "Which decisions did I make?",
          accept_outcome_v2: true,
        }),
      ).resolves.toMatchObject({
        outcome: "authorship_unsupported",
        citations: [],
      });
      expect(model.generate).not.toHaveBeenCalled();
      expect(value.search.searchBatch).toHaveBeenCalledWith({
        access_token: "bearer-only-token",
        queries: ["Which decisions did I make?"],
        limit: 10,
        include_related_atom_packet: true,
      });
      expect(value.search.revalidateBatchRelease).toHaveBeenCalledOnce();
      expect(value.append).toHaveBeenCalledWith(expect.objectContaining({
        outcome: "authorship_unsupported",
        retrieval: {
          planned_query_count: 1,
          released_atom_count: 2,
          context_atom_count: 0,
          query_hit_counts: [2],
        },
      }));
    } finally {
      value.database.close();
    }
  });

  it("does not return an answer when the immutable answer audit append fails", async () => {
    const value = setup({});
    value.append.mockImplementation(() => {
      throw new Error("audit unavailable");
    });
    try {
      await expect(
        value.route.ask({
          access_token: "bearer-only-token",
          question: "When is the launch?",
        }),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(value.search.revalidateBatchRelease).toHaveBeenCalledOnce();
      expect(value.append).toHaveBeenCalledOnce();
      expect(
        value.database
          .prepare(
            "SELECT count(*) FROM authority_person_read_decision_audit_v2",
          )
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      value.database.close();
    }
  });
});

async function startServer(person_answer?: PersonAnswerHttpApplicationV1) {
  const server = createOrganizationAuthorityHttpServer({
    descriptor: {} as never,
    sessions: {} as never,
    oidc_provider: {} as never,
    expected_issuer: "https://issuer.example",
    ...(person_answer === undefined ? {} : { person_answer }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("test HTTP server did not bind TCP");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    async close() {
      const closed = once(server, "close");
      server.close();
      await closed;
    },
  };
}

describe("Person answer HTTP mount", () => {
  it("keeps legacy requests on the exact V1 shape and exposes outcomes only after V2 negotiation", async () => {
    const application: PersonAnswerHttpApplicationV1 = {
      ask: vi.fn(async (input) => Object.freeze({
        schema_version: 1 as const,
        kind: "echo-clean-person-answer-v1" as const,
        generation_id: digest("generation"),
        record_head: Object.freeze({ position: 7, record_sha256: digest("head") }),
        answer: "I can summarize decisions in accessible records, but cannot determine whether you personally made them.",
        citations: Object.freeze([]),
        ...(input.accept_outcome_v2 === true ? { outcome: "authorship_unsupported" as const } : {}),
      })),
    };
    const server = await startServer(application);
    try {
      const request = (headers: Record<string, string>) => fetch(`${server.url}/v1/person/ask`, {
        method: "POST",
        headers: { authorization: "Bearer bearer-only-token", "content-type": "application/json", ...headers },
        body: JSON.stringify({ question: "What did I decide?" }),
      });
      const legacy = await request({});
      expect(Object.keys(await legacy.json()).sort()).toEqual(["answer", "citations", "generation_id", "kind", "record_head", "schema_version"]);
      const v2 = await request({ "x-echo-person-answer-version": "2" });
      expect(await v2.json()).toMatchObject({ outcome: "authorship_unsupported" });
      expect(application.ask).toHaveBeenNthCalledWith(1, { access_token: "bearer-only-token", question: "What did I decide?" });
      expect(application.ask).toHaveBeenNthCalledWith(2, { access_token: "bearer-only-token", question: "What did I decide?", accept_outcome_v2: true });
    } finally {
      await server.close();
    }
  });

  it("mounts POST /v1/person/ask as a bearer-only application call", async () => {
    const ask = vi.fn(
      async (): Promise<PersonAnswerResponseV1> => ({
        schema_version: 1,
        kind: "echo-clean-person-answer-v1",
        generation_id: digest("generation"),
        record_head: { position: 7, record_sha256: digest("head") },
        answer: "Tuesday.",
        citations: [],
      }),
    );
    const application: PersonAnswerHttpApplicationV1 = {
      ask,
    };
    const server = await startServer(application);
    try {
      const response = await fetch(`${server.url}/v1/person/ask`, {
        method: "POST",
        headers: {
          authorization: "Bearer bearer-only-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ question: "When is the launch?" }),
      });
      expect(response.status).toBe(200);
      expect(ask).toHaveBeenCalledWith({
        access_token: "bearer-only-token",
        question: "When is the launch?",
      });
      expect(await response.json()).toMatchObject({
        kind: "echo-clean-person-answer-v1",
        generation_id: digest("generation"),
      });
      const maximumQuestion = Array.from(
        { length: 32 },
        (_, index) => `term${index}`,
      ).join(" ");
      const maximum = await fetch(`${server.url}/v1/person/ask`, {
        method: "POST",
        headers: {
          authorization: "Bearer bearer-only-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ question: maximumQuestion }),
      });
      expect(maximum.status).toBe(200);
      expect(ask).toHaveBeenLastCalledWith({
        access_token: "bearer-only-token",
        question: maximumQuestion,
      });
    } finally {
      await server.close();
    }
  });

  it("rejects malformed answer requests and reports an unconfigured answer app as a sanitized 503", async () => {
    const application: PersonAnswerHttpApplicationV1 = {
      ask: vi.fn(async () => {
        throw new Error("must not be called");
      }),
    };
    const configured = await startServer(application);
    try {
      const tooManyTerms = await fetch(`${configured.url}/v1/person/ask`, {
        method: "POST",
        headers: {
          authorization: "Bearer bearer-only-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          question: Array.from({ length: 33 }, (_, index) => `term${index}`).join(" "),
        }),
      });
      expect(tooManyTerms.status).toBe(400);
      const invalid = await fetch(`${configured.url}/v1/person/ask`, {
        method: "POST",
        headers: {
          authorization: "Bearer bearer-only-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ question: "When is the launch?", principal_id: "forged" }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        error: { code: "invalid_request", message: "request failed" },
      });
      expect(application.ask).not.toHaveBeenCalled();
    } finally {
      await configured.close();
    }

    const unavailable = await startServer();
    try {
      const response = await fetch(`${unavailable.url}/v1/person/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "When is the launch?" }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: "unavailable", message: "request failed" },
      });
    } finally {
      await unavailable.close();
    }
  });
});

it("routes the question and raw output to the staging content observer while stage telemetry stays content-free", async () => {
  const telemetry: JourneyTelemetryEventV1[] = [];
  const content: Array<{
    journey_id: string;
    content_kind: string;
    content: unknown;
  }> = [];
  let observedCalls = 0;
  const model: StructuredGenerationPort = {
    generate: vi.fn(async () => {
      throw new Error("the value-only path must remain unused in staging");
    }),
    generate_with_observation: vi.fn(async () => {
      observedCalls += 1;
      return {
        value:
          observedCalls === 1
            ? { queries: ["launch date"] }
            : {
                status: "answered",
                answer: "Tuesday, owned by the product team.",
                citations: ["a1", "a2"],
              },
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          cached_input_tokens: 0,
          reasoning_tokens: 0,
        },
        finish_reason: "stop" as const,
        provider_latency_ms: 1,
      };
    }),
  };
  const journeyFactory = createAskJourneyTelemetryFactoryV1({
    observer: (event) => {
      telemetry.push(event);
    },
    release_sha: "a".repeat(40),
    build_number: 42,
    planner_model: "deepseek/deepseek-v3.2",
    answer_model: "deepseek/deepseek-v3.2",
    clock: {
      now: () => "2026-09-02T17:00:00.000Z",
      create_uuid: () => "123e4567-e89b-42d3-a456-426614174000",
    },
    content_observer: (record) => {
      content.push(record);
    },
  });
  const value = setup({
    model,
    generation: STAGING_GENERATION,
    ask_journey_telemetry: journeyFactory,
  });
  const question = "QUESTION-CONTENT-ONLY-journey";
  try {
    await expect(
      value.route.ask({ access_token: "BEARER-DO-NOT-LOG-content", question }),
    ).resolves.toMatchObject({ answer: "Tuesday, owned by the product team." });
    await vi.waitFor(() => expect(telemetry).toHaveLength(10));
    expect(content.map((record) => record.content_kind)).toEqual([
      "question",
      "planner_prompt",
      "planner_output",
      "context_atoms",
      "answer_prompt",
      "answer_output",
    ]);
    expect(
      content.every(
        (record) => record.journey_id === "123e4567-e89b-42d3-a456-426614174000",
      ),
    ).toBe(true);
    expect(content[0]?.content).toEqual({ question });
    const serializedContent = JSON.stringify(content);
    expect(serializedContent).toContain(question);
    expect(serializedContent).not.toContain("BEARER-DO-NOT-LOG-content");
    expect(JSON.stringify(telemetry)).not.toContain(question);
  } finally {
    value.database.close();
  }
});
