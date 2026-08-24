import { once } from "node:events";
import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCleanPersonAnswerCompositionAuditV1 } from "../src/adapters/persistence/sqlite/clean-person-answer-composition-audit-v1.js";
import { applyAuthorityBaselineV1 } from "../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-unmigrated-database.js";
import type { PersonAccessAuthorization } from "../src/application/person-identity-sessions.js";
import {
  createCleanPersonAnswerRouteV1,
  type CleanLayer4FailureEventV1,
} from "../src/composition/clean-person-answer-route.js";
import type {
  Layer4StructuredGenerationInput,
  Layer4StructuredOutputPort,
} from "../src/answer-composition/lean-answer-composition.js";
import type {
  CleanPersonRecordSearchBatchApplicationV1,
  CleanPersonRecordSearchBatchReleaseV1,
} from "../src/composition/clean-person-record-search-route.js";
import { AuthorityOperationError } from "../src/domain/errors.js";
import { createCleanPersonHttpServer } from "../src/presentation/clean-person-http-server.js";
import type {
  CleanPersonAnswerHttpApplicationV1,
  CleanPersonAnswerResponseV1,
} from "../src/presentation/clean-person-answer-http-application.js";

const digest = (value: string): Sha256Digest => canonicalSha256({ value });
const NOW = "2026-08-23T00:00:00.000Z";

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

function release(): CleanPersonRecordSearchBatchReleaseV1 {
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
  readonly model?: Layer4StructuredOutputPort;
  readonly revalidate?: () => PersonAccessAuthorization;
  readonly on_failure?: (event: CleanLayer4FailureEventV1) => void;
  readonly source_text?: string;
}) {
  const database = openAuthorityDatabase(":memory:");
  applyAuthorityBaselineV1(database);
  const events: string[] = [];
  const witness = release();
  const search: CleanPersonRecordSearchBatchApplicationV1 = {
    searchBatch: vi.fn((_value) => {
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
      });
    }),
    revalidateBatchRelease: vi.fn(() => {
      events.push("revalidate");
      return input.revalidate?.() ?? authorization();
    }),
  };
  const audit = new SqliteCleanPersonAnswerCompositionAuditV1(database);
  const append = vi.spyOn(audit, "append").mockImplementation((entry) => {
    events.push("audit");
    return digest(`answer-audit-${entry.checked_at}`);
  });
  const modelInputs: Layer4StructuredGenerationInput[] = [];
  const defaultModel: Layer4StructuredOutputPort = {
    generate: vi.fn(
      async (request: Layer4StructuredGenerationInput): Promise<unknown> => {
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
  const route = createCleanPersonAnswerRouteV1({
    authority_id: "oau_clean",
    organization_id: "org_clean",
    state_lineage_id: "lineage_clean",
    search,
    model,
    audit,
    ...(input.on_failure === undefined ? {} : { on_failure: input.on_failure }),
  });
  return { database, events, search, append, modelInputs, route };
}

afterEach(() => vi.restoreAllMocks());

describe("clean Person Layer 4 answer route", () => {
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

  it.each([
    {
      name: "the provider fails during planning and answering",
      model: { generate: vi.fn(async () => { throw new Error("provider timeout"); }) },
      searchCalls: 1,
      revalidationCalls: 0,
    },
    {
      name: "the planner and answerer both return malformed output",
      model: { generate: vi.fn(async () => ({ queries: ["   "] })) },
      searchCalls: 1,
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
      searchCalls: 1,
      revalidationCalls: 0,
    },
  ])("returns no answer or audit when $name", async ({ model, searchCalls, revalidationCalls }) => {
    const value = setup({ model });
    try {
      await expect(
        value.route.ask({
          access_token: "bearer-only-token",
          question: "When is the launch?",
        }),
      ).rejects.toMatchObject({ code: "unavailable" });
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
    const failures: CleanLayer4FailureEventV1[] = [];
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
        provider: null,
        finish_reason: null,
        provider_generation_id: null,
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

async function startServer(person_answer?: CleanPersonAnswerHttpApplicationV1) {
  const server = createCleanPersonHttpServer({
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
    throw new Error("clean HTTP server did not bind TCP");
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

describe("clean Person answer HTTP mount", () => {
  it("mounts POST /v1/person/ask as a bearer-only application call", async () => {
    const ask = vi.fn(
      async (): Promise<CleanPersonAnswerResponseV1> => ({
        schema_version: 1,
        kind: "echo-clean-person-answer-v1",
        generation_id: digest("generation"),
        record_head: { position: 7, record_sha256: digest("head") },
        answer: "Tuesday.",
        citations: [],
      }),
    );
    const application: CleanPersonAnswerHttpApplicationV1 = {
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
    } finally {
      await server.close();
    }
  });

  it("rejects malformed answer requests and reports an unconfigured answer app as a sanitized 503", async () => {
    const application: CleanPersonAnswerHttpApplicationV1 = {
      ask: vi.fn(async () => {
        throw new Error("must not be called");
      }),
    };
    const configured = await startServer(application);
    try {
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
