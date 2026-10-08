import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENTIC_ASK_DEADLINE_MS_V1 } from "@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { EvidenceDeskPortV1 } from "@echo-brain/organization-authority-kernel/shared/evidence-desk-v1";
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { TELEMETRY_FIXTURE_VOCABULARY_V1 } from "../../../tests/support/telemetry-fixture-vocabulary-v1.js";
import { createPersonAnswerV3Route } from "../src/composition/person-answer-v3-route.js";
import { createPersonEvidenceDeskV1 } from "../src/composition/person-evidence-desk-v1.js";

vi.mock("../src/composition/person-evidence-desk-v1.js", () => ({ createPersonEvidenceDeskV1: vi.fn() }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function fixture() {
  const revalidate = vi.fn<EvidenceDeskPortV1["revalidate"]>(() => new Promise(() => {}));
  vi.mocked(createPersonEvidenceDeskV1).mockReturnValue({
    scope: { kind: "global" }, search: vi.fn(), open: vi.fn(), list: vi.fn(), revalidate,
  } as unknown as ReturnType<typeof createPersonEvidenceDeskV1>);
  const events: CoreRuntimeObservationV1[] = [];
  const authenticateAccess = vi.fn(() => ({ principal_id: "person_fixture", membership_id: "member_fixture", session_family_id: "session_fixture" }));
  const append = vi.fn();
  const generate = vi.fn();
  const route = createPersonAnswerV3Route({
    authority_id: "authority_fixture", organization_id: "organization_fixture", state_lineage_id: "lineage_fixture",
    sessions: { authenticateAccess } as never, originals: {} as never, records: {} as never,
    model: { generate },
    generation: { generation_adapter_id: "fixture", planner_model: "deepseek/deepseek-v3.2", answer_model: "deepseek/deepseek-v3.2", timeout_ms: 25_000 },
    audit: { forRequest: () => ({ append }) } as never,
  });
  return {
    append, generate, revalidate, authenticateAccess, events,
    ask: (signal?: AbortSignal) => observeCoreRuntimeV1("http_request", () => route.ask({ access_token: "fixture", request: { schema_version: 3, question: "When is launch?" }, ...(signal === undefined ? {} : { signal }) }), { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1, observer: event => { events.push(event); } }),
  };
}

describe("Agentic Ask deadline at the Person route boundary", () => {
  it("exposes a hard deadline as unavailable while retaining timeout telemetry and one terminal audit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const f = fixture();
    // The real kernel's 90 s timer interrupts a stalled permission fence.
    const settled = f.ask().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(AGENTIC_ASK_DEADLINE_MS_V1);

    const error = await settled;
    expect(error).toBeInstanceOf(AuthorityOperationError);
    expect(error).toMatchObject({ code: "unavailable" });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.revalidate).toHaveBeenCalledTimes(1);
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.append).toHaveBeenCalledWith(expect.objectContaining({ outcome: "timed_out", model_calls: 0, repairs: 0, fallbacks: 0, prompt_sha256: null, answer_sha256: null, response_sha256: null }));
    expect(f.events.filter(event => event.stage === "research_run" && event.event !== "started")).toEqual([
      expect.objectContaining({ event: "failed", result: "timeout" }),
    ]);
  });

  it("keeps an unknown failure terminal without converting it to unavailable", async () => {
    const f = fixture();
    const error = new Error("unexpected permission fence failure");
    f.revalidate.mockRejectedValueOnce(error);

    await expect(f.ask()).rejects.toBe(error);

    expect(f.revalidate).toHaveBeenCalledTimes(1);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
  });

  it("keeps failed authentication terminal without starting the loop", async () => {
    const f = fixture();
    const error = new AuthorityOperationError("unauthorized", "session expired");
    f.authenticateAccess.mockImplementationOnce(() => { throw error; });

    await expect(f.ask()).rejects.toBe(error);

    expect(createPersonEvidenceDeskV1).not.toHaveBeenCalled();
    expect(f.revalidate).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
  });

  it("keeps cancellation non-retryable with only its cancelled audit", async () => {
    const f = fixture();
    const controller = new AbortController();
    const rejected = expect(f.ask(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;

    expect(f.generate).not.toHaveBeenCalled();
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.append).toHaveBeenCalledWith(expect.objectContaining({ outcome: "cancelled" }));
    expect(f.events.filter(event => event.stage === "research_run" && event.event !== "started")).toEqual([
      expect.objectContaining({ event: "failed", result: "cancelled" }),
    ]);
  });
});
