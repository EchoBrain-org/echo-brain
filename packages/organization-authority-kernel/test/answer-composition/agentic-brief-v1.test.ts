import { describe, expect, it, vi } from "vitest";
import { STEP_PROMPT, TASK_RULE_PROMPT } from "../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import { agenticDataSlotV1, agenticStartingSlotV1, fillAgenticTaskV1, type AgenticBriefV1 } from "../../src/answer-composition/agentic-brief-v1.js";
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, AGENTIC_RESEARCH_LIVE_BUDGET_V1 } from "../../src/answer-composition/agentic-research-v1.js";
import type { EvidenceDeskResultV2 } from "../../src/shared/evidence-desk-v2.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";
import { researchHarness as harness, listed, need, part, record, result, step } from "./fixtures/agentic-scenarios.js";

const finish = (evidence: readonly string[]) => step([part("Part", [need("state", "found", evidence)])], [{ tool: "finish", args: {} }]);
const search = (query: string) => step([part("Part", [need("state", "open")])], [{ tool: "search", args: { query } }]);

const task = (text: string, starting: AgenticBriefV1["starting"], options: AgenticBriefV1["options"] = { small_scope_preload: false }, data?: readonly string[]): AgenticBriefV1 =>
  ({ goal: { kind: "task", task: text, ...(data === undefined ? {} : { data }) }, starting, budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, options });

describe("brief: task slots", () => {
  it("fills each starting slot with its item's id, or says the item could not be read", () => {
    const text = `Compare ${agenticStartingSlotV1(1)} with ${agenticStartingSlotV1(2)} and ${agenticStartingSlotV1(3)}.`;
    expect(fillAgenticTaskV1(text, ["E1", null, "E4"])).toBe("Compare E1 with an item that could not be read and E4.");
  });

  it("places event data in its slots without reading it as template", () => {
    const text = `Finding ${agenticDataSlotV1(1)} cites ${agenticStartingSlotV1(1)}; expected ${agenticDataSlotV1(2)}.`;
    expect(fillAgenticTaskV1(text, ["E1"], [`"Ship ${agenticStartingSlotV1(1)} first"`, `"${agenticDataSlotV1(1)}"`]))
      .toBe('Finding "Ship {{starting:1}} first" cites E1; expected "{{data:1}}".');
  });

  it("fails closed on a slot with nothing to fill it: a definition bug never reaches the model", () => {
    for (const [text, data] of [
      [`Compare ${agenticStartingSlotV1(1)} with ${agenticStartingSlotV1(2)}.`, []],
      [`Recheck ${agenticStartingSlotV1(0)}.`, []],
      [`Recheck ${agenticStartingSlotV1(1)}: ${agenticDataSlotV1(2)}.`, ["one"]],
    ] as const) expect(() => fillAgenticTaskV1(text, ["E1"], data), text).toThrow("has nothing to fill it");
  });
});

describe("brief: goals", () => {
  it("sends a task goal as its task, with starting ids filled in, under the one shared task rule", async () => {
    const approved = record("approved", "Approved: show two decimals.");
    const ticket = record("ticket", "SW-22b formats one decimal.");
    const h = harness([finish(["E1"])], {
      openCitation: async input => result([JSON.stringify(input.citation) === JSON.stringify(approved.citation) ? approved : ticket]),
    });
    const brief = task(`Record ${agenticStartingSlotV1(1)} changed; recheck ${agenticStartingSlotV1(2)}.`, [
      { citation: approved.citation, if_unreadable: "fail" }, { citation: ticket.citation, if_unreadable: "fail" },
    ]);
    const view = await h.research.research({ trigger: "sweep", brief });
    expect(h.inputs[0]!.system_prompt).toBe(`${STEP_PROMPT}\n\n${TASK_RULE_PROMPT}`);
    expect(Object.keys(h.prompt(0))[0]).toBe("task");
    expect(h.prompt(0)).toMatchObject({ task: "Record E1 changed; recheck E2." });
    expect(h.prompt(0)).not.toHaveProperty("question");
    expect(view).toMatchObject({ trigger: "sweep", goal: { kind: "task", task: "Record E1 changed; recheck E2." }, budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1 });
    expect(view).not.toHaveProperty("unreadable_starting");
  });

  it("places the brief's data after its template is fixed, and records the goal without it", async () => {
    const approved = record("approved", "Approved: show two decimals.");
    const h = harness([finish(["E1"])], { openCitation: async () => result([approved]) });
    const brief = task(`Recheck ${agenticStartingSlotV1(1)}: ${agenticDataSlotV1(1)}.`, [{ citation: approved.citation, if_unreadable: "fail" }], undefined, [`"${agenticStartingSlotV1(1)} stays literal"`]);
    const view = await h.research.research({ trigger: "sweep", brief });
    expect(h.prompt(0)).toMatchObject({ task: 'Recheck E1: "{{starting:1}} stays literal".' });
    expect(view.goal).toEqual({ kind: "task", task: 'Recheck E1: "{{starting:1}} stays literal".' });
  });

  it("refuses a task whose slot has nothing to fill it before any read: a definition bug never reaches the desk or the model", async () => {
    const approved = record("approved");
    const openCitation = vi.fn(async () => result([approved]));
    const h = harness([], { openCitation });
    const starting = [{ citation: approved.citation, if_unreadable: "fail" as const }];
    for (const [text, data] of [
      [`Compare ${agenticStartingSlotV1(1)} with ${agenticStartingSlotV1(2)}.`, undefined],
      [`Recheck ${agenticStartingSlotV1(0)}.`, undefined],
      [`Recheck ${agenticStartingSlotV1(1)}: ${agenticDataSlotV1(1)}.`, undefined],
      [`Recheck ${agenticStartingSlotV1(1)}: ${agenticDataSlotV1(2)}.`, ['"one"']],
    ] as const) await expect(h.research.research({ trigger: "sweep", brief: task(text, starting, undefined, data) }), text).rejects.toThrow("research goal is invalid");
    expect(openCitation).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("sends a question goal exactly as Ask does: the step prompt alone and the question first", async () => {
    const h = harness([
      search("dashboard"),
      finish(["E1"]),
      { sentences: [{ text: "Due September 11.", evidence: ["E1"] }], not_found: [] },
    ], { search: vi.fn(async () => result([record("dashboard", "Approved: due September 11.")])) });
    const brief: AgenticBriefV1 = { goal: { kind: "question", question: "When is the dashboard due?" }, starting: [], budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1, options: { small_scope_preload: true } };
    const view = await h.research.research({ trigger: "ask", brief });
    expect(h.inputs[0]!.system_prompt).toBe(STEP_PROMPT);
    expect(Object.keys(h.prompt(0))[0]).toBe("question");
    expect(h.prompt(0)).not.toHaveProperty("task");
    expect(view).toMatchObject({ trigger: "ask", goal: brief.goal, budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1 });
    // A question goal is Ask's: its writer runs and its audit names no trigger.
    expect(h.audit).toEqual([expect.not.objectContaining({ trigger: expect.anything() })]);
    expect(h.generate).toHaveBeenCalledTimes(3);
  });

  it("preloads a small scope only when the brief asks for it and the core allows it", async () => {
    const approved = record("approved");
    const asked = harness([finish(["E1"])], { openCitation: async () => result([approved]) }, { small_scope_shortcut: true });
    await asked.research.research({ trigger: "sweep", brief: task(`Recheck ${agenticStartingSlotV1(1)}.`, [{ citation: approved.citation, if_unreadable: "fail" }], { small_scope_preload: true }) });
    expect(asked.port.search).toHaveBeenCalledWith(expect.objectContaining({ inventory_mode: "items" }));
    const notAsked = harness([finish(["E1"])], { openCitation: async () => result([approved]) }, { small_scope_shortcut: true });
    await notAsked.research.research({ trigger: "sweep", brief: task(`Recheck ${agenticStartingSlotV1(1)}.`, [{ citation: approved.citation, if_unreadable: "fail" }]) });
    expect(notAsked.port.search).not.toHaveBeenCalled();
    const notAllowed = harness([finish(["E1"])], { openCitation: async () => result([approved]) });
    await notAllowed.research.research({ trigger: "sweep", brief: task(`Recheck ${agenticStartingSlotV1(1)}.`, [{ citation: approved.citation, if_unreadable: "fail" }], { small_scope_preload: true }) });
    expect(notAllowed.port.search).not.toHaveBeenCalled();
  });
});

describe("brief: unreadable starting items", () => {
  const readable = record("readable", "SW-22b formats two decimals.");
  const deleted = record("deleted");
  const hidden = listed("hidden");
  const openCitation = async (input: { readonly citation: unknown }): Promise<EvidenceDeskResultV2> => {
    const key = JSON.stringify(input.citation);
    if (key === JSON.stringify(deleted.citation)) throw new AuthorityOperationError("not_found", "Evidence item is not available");
    if (key === JSON.stringify(hidden.citation)) throw new AuthorityOperationError("unauthorized", "Live source is unavailable in this scope");
    return result([readable]);
  };

  it("lists 'report' items it cannot read in the bundle and keeps researching", async () => {
    const listedOnly = listed("listed-only");
    const h = harness([finish(["E1"])], {
      openCitation: async input => JSON.stringify(input.citation) === JSON.stringify(listedOnly.citation) ? result([listedOnly]) : openCitation(input),
    });
    const brief = task(`Recheck ${agenticStartingSlotV1(1)}, ${agenticStartingSlotV1(2)}, ${agenticStartingSlotV1(3)} and ${agenticStartingSlotV1(4)}.`, [
      { citation: readable.citation, if_unreadable: "report" }, { citation: deleted.citation, if_unreadable: "report" },
      { citation: hidden.citation, if_unreadable: "report" }, { citation: listedOnly.citation, if_unreadable: "report" },
    ]);
    const view = await h.research.research({ trigger: "sweep", brief });
    expect(view.unreadable_starting).toEqual([deleted.citation, hidden.citation, listedOnly.citation]);
    expect(h.prompt(0).task).toBe("Recheck E1, an item that could not be read, an item that could not be read and an item that could not be read.");
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    // Only what the desk released becomes an item: the readable record and the listed-only metadata, never the refused items.
    expect(view.items.map(item => item.citation)).toEqual([readable.citation, listedOnly.citation]);
    expect(view.coverage.reads.filter(read => read.unavailable)).toHaveLength(2);
    const prompts = JSON.stringify(h.inputs);
    for (const refused of [deleted, hidden]) {
      expect(prompts).not.toContain((refused.citation as { readonly atom_id: string }).atom_id);
      expect(prompts).not.toContain(refused.label);
    }
    const trimmed = await harness([finish(["E1"])], { openCitation }).research.research({ trigger: "sweep", brief: task(`Recheck ${agenticStartingSlotV1(1)}.`, [
      { citation: readable.citation, if_unreadable: "report" }, { citation: deleted.citation, if_unreadable: "report" },
    ]) });
    expect(trimmed.unreadable_starting).toEqual([deleted.citation]);
  });

  it("stops a 'fail' item it cannot read with not_found before any model call", async () => {
    for (const missing of [deleted, listed("metadata-only")]) {
      const h = harness([], { openCitation: async input => JSON.stringify(input.citation) === JSON.stringify(missing.citation) && missing.text === undefined ? result([missing]) : openCitation(input) });
      await expect(h.research.research({ trigger: "sweep", brief: task(`Recheck ${agenticStartingSlotV1(1)}.`, [{ citation: missing.citation, if_unreadable: "fail" }]) })).rejects.toMatchObject({ code: "not_found" });
      expect(h.generate).not.toHaveBeenCalled();
    }
  });

  it("still stops a 'report' item on a failure that is not a refusal", async () => {
    const h = harness([], { openCitation: async () => { throw new AuthorityOperationError("unavailable", "Source is down"); } });
    await expect(h.research.research({ trigger: "sweep", brief: task(`Recheck ${agenticStartingSlotV1(1)}.`, [{ citation: readable.citation, if_unreadable: "report" }]) })).rejects.toMatchObject({ code: "unavailable" });
    expect(h.generate).not.toHaveBeenCalled();
  });
});
