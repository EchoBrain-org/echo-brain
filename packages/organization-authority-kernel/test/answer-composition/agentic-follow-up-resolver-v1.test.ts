import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { validatePersonAnswerResponseV8, type PersonAnswerCitationV8, type PersonAnswerPreviousV1 } from "@echo-brain/organization-api";
import { describe, expect, it } from "vitest";
import {
  agenticClarifyResponseV1,
  agenticFollowUpStartingV1,
  FOLLOW_UP_RESOLVER_PROMPT,
  followUpResolutionSchema,
  parseFollowUpResolutionV1,
  resolveAgenticFollowUpOnceV1,
  resolveAgenticFollowUpV1,
} from "../../src/answer-composition/agentic-follow-up-resolver-v1.js";
import { createAgenticModelGateV1 } from "../../src/answer-composition/agentic-model-gate-v1.js";
import { AGENTIC_RESEARCH_LIVE_BUDGET_V1 } from "../../src/answer-composition/agentic-research-v1.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";
import type { StructuredGenerationInput } from "../../src/answer-composition/structured-generation-v1.js";
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "../../src/shared/core-runtime-observation-v1.js";
import { generation, scriptedGate } from "./fixtures/agentic-scenarios.js";

/**
 * The follow-up resolver (ADR-0047): its prompt and schema, how strictly it reads a reply, its one repair and its
 * fallback, where research starts for a resolved follow-up, and the answer that asks which one.
 */

const ticket = (key: string, id: string): PersonAnswerCitationV8 => ({
  citation: { kind: "ticket", tool_id: "jira", external_scope_id: "cloud-1", ticket_id: id, permalink: `https://example.atlassian.net/browse/${key}`, text_sha256: canonicalSha256(key) },
  kind: "ticket", label: `${key}: Thermal fixture fails at 45 °C`, visibility: "only_me",
});
const record = `sha256:${"a".repeat(64)}` as const;
const decision: PersonAnswerCitationV8 = {
  citation: { kind: "approved_record", atom_id: `sha256:${"b".repeat(64)}`, record_sha256: record, policy_id: "organization-member-readable-person-v2" },
  kind: "decision", label: "DVT gate review: hold until THERM-482 is fixed", visibility: "team", ref: `meeting:${record}`,
};
const followUp: PersonAnswerCitationV8 = { citation: { kind: "follow_up", item_id: "itm_launch-1" }, kind: "follow_up", label: "Send the gasket spec", visibility: "team", ref: "follow_up:itm_launch-1" };
const project: PersonAnswerCitationV8 = { citation: { kind: "project", project_id: "prj_00000000-0000-4000-8000-000000000001" }, kind: "project", label: "THERM", visibility: "project", ref: "project:prj_00000000-0000-4000-8000-000000000001" };
const PREVIOUS: PersonAnswerPreviousV1 = {
  purpose: "follow_up", question: "What's blocking the DVT gate?", asked_at: "2026-10-25T02:30:00.000Z",
  statements: [
    { text: "THERM-482 blocks the DVT gate: the thermal fixture fails at 45 °C.", citation_indexes: [0, 1] },
    { text: "The DVT gate review held the gate until it is fixed.", citation_indexes: [1] },
  ],
  citations: [ticket("THERM-482", "10482"), decision],
};
const RESOLVED = { resolution: "resolved", question: "What are the details on THERM-482?", about: [1] };

/** What a call ran under the request's observer: the corrections its span counted. */
async function observed<T>(operation: () => Promise<T>): Promise<{ readonly value: T; readonly corrections: Readonly<Record<string, number>>; readonly events: readonly CoreRuntimeObservationV1[] }> {
  const events: CoreRuntimeObservationV1[] = [];
  const value = await observeCoreRuntimeV1("research_run", operation, { observer: event => { events.push(event); } });
  return { value, events, corrections: events.find(event => event.phase === "research_run" && event.event !== "started")!.model_corrections ?? {} };
}
function resolver(replies: readonly unknown[], options: { readonly remaining?: number; readonly max_model_calls?: number } = {}) {
  const trace: string[] = [];
  const { gate, inputs } = scriptedGate(replies, AGENTIC_RESEARCH_LIVE_BUDGET_V1, trace);
  const run = () => resolveAgenticFollowUpV1({
    gate, previous: PREVIOUS, question: "what are the details on that ticket?", today: "2026-10-25", time_zone: "America/Los_Angeles",
    max_model_calls: options.max_model_calls ?? 24, remaining: () => options.remaining ?? 80_000, writer_reserve_ms: 25_000, signal: new AbortController().signal,
  });
  return { run, gate, inputs, trace };
}

describe("follow-up resolution: reading a reply (ADR-0047)", () => {
  it("reads same, resolved (sources as shown, from 1) and clarify", () => {
    expect(parseFollowUpResolutionV1({ resolution: "same" }, 2)).toEqual({ resolution: "same" });
    // A question that stands alone may come back with its own question and no source; neither matters.
    expect(parseFollowUpResolutionV1({ resolution: "same", question: "Who leads firmware?", about: [] }, 2)).toEqual({ resolution: "same" });
    expect(parseFollowUpResolutionV1(RESOLVED, 2)).toEqual({ resolution: "resolved", question: "What are the details on THERM-482?", about: [0] });
    expect(parseFollowUpResolutionV1({ resolution: "resolved", question: "Who approved the DVT gate hold?" }, 2)).toEqual({ resolution: "resolved", question: "Who approved the DVT gate hold?", about: [] });
    expect(parseFollowUpResolutionV1({ resolution: "clarify", choices: [
      { label: "THERM-482", question: "What are the details on THERM-482?" }, { label: "MECH-214", question: "What are the details on MECH-214?" },
    ] }, 2)).toEqual({ resolution: "clarify", choices: [
      { label: "THERM-482", question: "What are the details on THERM-482?" }, { label: "MECH-214", question: "What are the details on MECH-214?" },
    ] });
  });

  it("normalizes only what cannot change the meaning: a resolution's spelling, a source as a string, a repeated source, a long label", async () => {
    const { value, corrections } = await observed(async () => [
      parseFollowUpResolutionV1({ ...RESOLVED, resolution: " Resolved ", about: ["2", 2, "S1"] }, 2),
      parseFollowUpResolutionV1({ resolution: "clarify", choices: [{ label: "L".repeat(80), question: "What is A?" }, { label: "B", question: "What is B?" }] }, 0),
    ]);
    expect(value[0]).toEqual({ resolution: "resolved", question: "What are the details on THERM-482?", about: [1, 0] });
    expect(value[1]).toMatchObject({ choices: [{ label: `${"L".repeat(59)}…` }, { label: "B" }] });
    expect(corrections).toEqual({ model_enum_respelled: 1, model_id_respelled: 2, model_repeat_dropped: 1, model_text_truncated: 1 });
  });

  it.each([
    ["not an object", "same", /JSON object/u],
    ["another resolution", { resolution: "guess" }, /"same", "resolved" or "clarify"/u],
    ["same with choices", { resolution: "same", choices: [{ label: "A", question: "What is A?" }] }, /offers no choices/u],
    ["resolved with choices", { ...RESOLVED, choices: [{ label: "A", question: "What is A?" }, { label: "B", question: "What is B?" }] }, /offers no choices/u],
    ["resolved with no question", { resolution: "resolved", about: [1] }, /full question/u],
    ["resolved with a question too long", { ...RESOLVED, question: `What ${"x".repeat(240)}?` }, /at most 240/u],
    ["resolved with a question of too many words", { ...RESOLVED, question: Array.from({ length: 33 }, (_, index) => `w${index}`).join(" ") }, /1 to 32/u],
    ["resolved about a source not shown", { ...RESOLVED, about: [3] }, /from 1 to 2/u],
    ["resolved about no list", { ...RESOLVED, about: 1 }, /list of source numbers/u],
    ["clarify with one choice", { resolution: "clarify", choices: [{ label: "A", question: "What is A?" }] }, /2 to 4/u],
    ["clarify with five choices", { resolution: "clarify", choices: ["A", "B", "C", "D", "E"].map(name => ({ label: name, question: `What is ${name}?` })) }, /2 to 4/u],
    ["clarify with no label", { resolution: "clarify", choices: [{ label: " ", question: "What is A?" }, { label: "B", question: "What is B?" }] }, /needs a "label"/u],
    ["clarify asking one thing twice", { resolution: "clarify", choices: [{ label: "A", question: "What is A?" }, { label: "B", question: "what is a?" }] }, /different thing/u],
  ])("sends back %s for its one repair", (_name, reply, reason) => {
    expect(() => parseFollowUpResolutionV1(reply, 2)).toThrow(reason);
  });

  it("names `about` [] for an answer with no sources", () => {
    expect(() => parseFollowUpResolutionV1(RESOLVED, 0)).toThrow('"about" must be [] when the earlier answer cites no sources');
  });
});

describe("follow-up resolution: the call (ADR-0047)", () => {
  it("makes one answer call in the ask_resolve span, after the access check, showing the numbered turn and the new question", async () => {
    const run = resolver([RESOLVED]);
    const { value, events } = await observed(run.run);
    expect(value).toEqual({ resolution: { resolution: "resolved", question: "What are the details on THERM-482?", about: [0] }, fallback: false });
    expect(run.trace).toEqual(["revalidate", "generate"]);
    expect(events.filter(event => !event.root && event.event === "started").map(event => event.stage)).toEqual(["research_revalidation", "ask_resolve"]);
    const [input] = run.inputs as StructuredGenerationInput[];
    expect(input!.system_prompt).toBe(FOLLOW_UP_RESOLVER_PROMPT);
    expect(input!.schema).toBe(followUpResolutionSchema);
    expect(JSON.parse(input!.user_prompt)).toEqual({
      today: "2026-10-25",
      previous: {
        question: "What's blocking the DVT gate?",
        // 02:30 UTC on Oct 25 is Oct 24 in Los Angeles.
        asked_on: "2026-10-24",
        statements: [
          { n: 1, text: "THERM-482 blocks the DVT gate: the thermal fixture fails at 45 °C.", sources: [1, 2] },
          { n: 2, text: "The DVT gate review held the gate until it is fixed.", sources: [2] },
        ],
        sources: [{ n: 1, kind: "ticket", label: "THERM-482: Thermal fixture fails at 45 °C" }, { n: 2, kind: "decision", label: "DVT gate review: hold until THERM-482 is fixed" }],
      },
      question: "what are the details on that ticket?",
    });
    expect(run.gate.stats()).toMatchObject({ calls: 1, repairs: 0, generations: [{ role: "answer" }] });
  });

  it("asks once more with the reason, then leaves the question as asked and counts the fallback", async () => {
    const repaired = resolver([{ resolution: "resolved" }, RESOLVED]);
    expect((await repaired.run()).resolution).toEqual({ resolution: "resolved", question: "What are the details on THERM-482?", about: [0] });
    expect(JSON.parse(repaired.inputs[1]!.user_prompt).validation_error).toMatch(/"question" must be the full question/u);
    const failed = resolver([{ resolution: "guess" }, { resolution: "guess again" }]);
    const { value, corrections } = await observed(failed.run);
    expect(value).toEqual({ resolution: { resolution: "same" }, fallback: true });
    expect(corrections).toEqual({ model_repair_rejected: 1, resolver_fallback: 1 });
    expect(failed.gate.stats()).toMatchObject({ calls: 2, repairs: 1 });
  });

  it("makes no call, and leaves the question as asked, when research and the writer would lose their time or no call is left", async () => {
    for (const run of [resolver([RESOLVED], { remaining: 25_000 + 2_000 + 2_999 }), resolver([RESOLVED], { max_model_calls: 0 })]) {
      expect(await run.run()).toEqual({ resolution: { resolution: "same" }, fallback: true });
      expect(run.trace).toEqual([]);
    }
  });

  it("stops on a cancel, and on a failed access check, as any model call does", async () => {
    const run = (revalidate: (controller: AbortController) => Promise<{ readonly checked_at: string }>) => {
      const controller = new AbortController();
      let generated = 0;
      const gate = createAgenticModelGateV1({
        generation, model: { generate: async () => { generated += 1; return RESOLVED; } }, desk_revalidate: () => revalidate(controller), on_checked: () => undefined,
        budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1, now: () => 0, deadline: 90_000, signal: controller.signal, input_signal: controller.signal, is_deadline_expired: () => false,
      });
      const resolved = resolveAgenticFollowUpV1({ gate, previous: PREVIOUS, question: "who owns it?", today: "2026-10-25", time_zone: "UTC", max_model_calls: 24,
        remaining: () => 80_000, writer_reserve_ms: 25_000, signal: controller.signal });
      return { resolved, generated: () => generated };
    };
    const cancelled = run(async controller => { controller.abort(); return { checked_at: "2026-10-25T00:00:00.000Z" }; });
    await expect(cancelled.resolved).rejects.toMatchObject({ name: "AbortError" });
    const revoked = run(async () => { throw new AuthorityOperationError("stale_access_state", "Membership changed"); });
    await expect(revoked.resolved).rejects.toMatchObject({ code: "stale_access_state" });
    expect([cancelled.generated(), revoked.generated()]).toEqual([0, 0]);
  });

  it("runs the product's call on its own for the eval, with no desk", async () => {
    const inputs: StructuredGenerationInput[] = [];
    const resolved = await resolveAgenticFollowUpOnceV1({
      model: { generate: async (input: StructuredGenerationInput) => { inputs.push(input); return inputs.length === 1 ? { resolution: "resolved" } : RESOLVED; } },
      generation, previous: PREVIOUS, question: "what are the details on that ticket?", today: "2026-10-25",
    });
    expect(resolved).toEqual({ resolution: { resolution: "resolved", question: "What are the details on THERM-482?", about: [0] }, fallback: false, calls: 2, repairs: 1 });
    expect(inputs.map(input => input.system_prompt)).toEqual([FOLLOW_UP_RESOLVER_PROMPT, FOLLOW_UP_RESOLVER_PROMPT]);
    expect(JSON.parse(inputs[0]!.user_prompt).previous.asked_on).toBe("2026-10-25");
  });
});

describe("where a resolved follow-up starts, and the answer that asks which one (ADR-0047)", () => {
  const previous: PersonAnswerPreviousV1 = { ...PREVIOUS, citations: [ticket("THERM-482", "10482"), decision, followUp, project] };

  it("starts research from what research can open, reported when it cannot be read and skipped when its tool cannot be read for now; never a live tool item in Mine", () => {
    expect(agenticFollowUpStartingV1(previous, [0, 1, 2, 3], { kind: "global" })).toEqual([
      { citation: previous.citations[0]!.citation, if_unreadable: "skip" }, { citation: decision.citation, if_unreadable: "skip" },
    ]);
    expect(agenticFollowUpStartingV1(previous, [1], { kind: "project", project_id: "prj_00000000-0000-4000-8000-000000000001" })).toEqual([{ citation: decision.citation, if_unreadable: "skip" }]);
    expect(agenticFollowUpStartingV1(previous, [0, 1], { kind: "mine" })).toEqual([{ citation: decision.citation, if_unreadable: "skip" }]);
    expect(agenticFollowUpStartingV1(previous, [], { kind: "global" })).toEqual([]);
  });

  it("asks which one with no part and no citation", () => {
    const choices = [{ label: "THERM-482", question: "What are the details on THERM-482?" }, { label: "MECH-214", question: "What are the details on MECH-214?" }];
    const response = agenticClarifyResponseV1({ kind: "global" }, "what are the details on that ticket?", choices);
    expect(response).toEqual({ schema_version: 8, kind: "echo-clean-person-answer-v8", scope: { kind: "global" }, outcome: "clarify", citations: [], parts: [], question: "what are the details on that ticket?", choices });
    expect(validatePersonAnswerResponseV8(response)).toEqual(response);
  });
});
