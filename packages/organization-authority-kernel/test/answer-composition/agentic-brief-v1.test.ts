import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1,
  AGENTIC_RESEARCH_LIVE_BUDGET_V1,
  createAgenticResearchV1,
  type AgenticAskAuditEntryV1,
} from "../../src/answer-composition/agentic-ask-v1.js";
import { STEP_PROMPT, TASK_RULE_PROMPT } from "../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import { agenticDataSlotV1, agenticStartingSlotV1, fillAgenticTaskV1, type AgenticBriefV1 } from "../../src/answer-composition/agentic-brief-v1.js";
import type { StructuredGenerationInput } from "../../src/answer-composition/structured-generation-v1.js";
import type { EvidenceDeskItemV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from "../../src/shared/evidence-desk-v2.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";

const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000 };

function record(id: string, text: string | null = `Approved: ${id} was decided.`): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `desk_${canonicalSha256({ id }).slice(7)}`,
    citation: { kind: "approved_record" as const, atom_id: canonicalSha256({ id }), record_sha256: canonicalSha256({ id, record: true }), policy_id: "organization-member-readable-person-v2" as const },
    kind: "decision" as const, ...(text === null ? {} : { text }), label: `Meeting ${id}`, visibility: "team" as const,
    occurred_at: "2026-10-05", receipt_sha256: canonicalSha256({ receipt: id }),
  });
}
const result = (items: readonly EvidenceDeskItemV2[]): EvidenceDeskResultV2 => ({ items, truncated: false, receipt_digests: [canonicalSha256({ desk: items.map(item => item.id) })] });
const finish = (evidence: readonly string[]) => ({ parts: [{ question: "Part", notes: "", needs: [{ need: "state", status: "found", evidence }] }], actions: [{ tool: "finish", args: {} }] });
const search = (query: string) => ({ parts: [{ question: "Part", notes: "", needs: [{ need: "state", status: "open", evidence: [] }] }], actions: [{ tool: "search", args: { query } }] });

function harness(replies: readonly unknown[], desk: Partial<EvidenceDeskPortV2>, core: { readonly small_scope_shortcut?: true } = {}) {
  const inputs: StructuredGenerationInput[] = [];
  const audit: AgenticAskAuditEntryV1[] = [];
  const generate = vi.fn(async (input: StructuredGenerationInput) => {
    inputs.push(input);
    const reply = replies[inputs.length - 1];
    if (reply === undefined) throw new Error(`unscripted call ${inputs.length}`);
    return reply;
  });
  const port: EvidenceDeskPortV2 = {
    scope: { kind: "project", project_id: "prj_00000000-0000-4000-8000-000000000001" } as EvidenceDeskPortV2["scope"], live_sources: [],
    search: vi.fn(async () => result([])), open: async () => result([]), list: async () => result([]), revalidate: async () => ({ checked_at: "2026-10-06T00:00:00.000Z" }), ...desk,
  };
  const research = createAgenticResearchV1({ desk: port, model: { generate }, generation, audit: { append: entry => { audit.push(entry); } }, today: () => "2026-10-06", ...core });
  return { research, port, inputs, audit, generate, prompt: (index: number) => JSON.parse(inputs[index]!.user_prompt) as Record<string, unknown> };
}

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
      [`Check ${agenticStartingSlotV1(0)}.`, []],
      [`Check ${agenticStartingSlotV1(1)}: ${agenticDataSlotV1(2)}.`, ["one"]],
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
    const bundle = await h.research.researchBundle({ trigger: "sweep", brief });
    expect(h.inputs[0]!.system_prompt).toBe(`${STEP_PROMPT}\n\n${TASK_RULE_PROMPT}`);
    expect(Object.keys(h.prompt(0))[0]).toBe("task");
    expect(h.prompt(0)).toMatchObject({ task: "Record E1 changed; recheck E2." });
    expect(h.prompt(0)).not.toHaveProperty("question");
    expect(bundle).toMatchObject({ trigger: "sweep", goal: { kind: "task", task: "Record E1 changed; recheck E2." }, budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, unreadable_starting: [] });
  });

  it("places the brief's data after its template is fixed, and records the goal without it", async () => {
    const approved = record("approved", "Approved: show two decimals.");
    const h = harness([finish(["E1"])], { openCitation: async () => result([approved]) });
    const brief = task(`Recheck ${agenticStartingSlotV1(1)}: ${agenticDataSlotV1(1)}.`, [{ citation: approved.citation, if_unreadable: "fail" }], undefined, [`"${agenticStartingSlotV1(1)} stays literal"`]);
    const bundle = await h.research.researchBundle({ trigger: "sweep", brief });
    expect(h.prompt(0)).toMatchObject({ task: 'Recheck E1: "{{starting:1}} stays literal".' });
    expect(bundle.goal).toEqual({ kind: "task", task: 'Recheck E1: "{{starting:1}} stays literal".' });
  });

  it("stops a task whose slot has no starting item before any model call", async () => {
    const approved = record("approved");
    const h = harness([], { openCitation: async () => result([approved]) });
    await expect(h.research.research({ trigger: "sweep", brief: task(`Compare ${agenticStartingSlotV1(1)} with ${agenticStartingSlotV1(2)}.`, [{ citation: approved.citation, if_unreadable: "fail" }]) }))
      .rejects.toThrow("has nothing to fill it");
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("sends a question goal exactly as Ask does: the step prompt alone and the question first", async () => {
    const h = harness([
      search("dashboard"),
      finish(["E1"]),
      { sentences: [{ text: "Due September 11.", evidence: ["E1"] }], not_found: [] },
    ], { search: vi.fn(async () => result([record("dashboard", "Approved: due September 11.")])) });
    const brief: AgenticBriefV1 = { goal: { kind: "question", question: "When is the dashboard due?" }, starting: [], budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1, options: { small_scope_preload: true } };
    const bundle = await h.research.researchBundle({ trigger: "ask", brief });
    expect(h.inputs[0]!.system_prompt).toBe(STEP_PROMPT);
    expect(Object.keys(h.prompt(0))[0]).toBe("question");
    expect(h.prompt(0)).not.toHaveProperty("task");
    expect(bundle).toMatchObject({ trigger: "ask", goal: brief.goal, budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1 });
    // A question goal is Ask's: its writer runs and its audit names no trigger.
    expect(h.audit).toEqual([expect.not.objectContaining({ trigger: expect.anything() })]);
    expect(h.generate).toHaveBeenCalledTimes(3);
  });

  it("preloads a small scope only when the brief asks for it and the core allows it", async () => {
    const approved = record("approved");
    const asked = harness([finish(["E1"])], { openCitation: async () => result([approved]) }, { small_scope_shortcut: true });
    await asked.research.research({ trigger: "sweep", brief: task(`Check ${agenticStartingSlotV1(1)}.`, [{ citation: approved.citation, if_unreadable: "fail" }], { small_scope_preload: true }) });
    expect(asked.port.search).toHaveBeenCalledWith(expect.objectContaining({ inventory_mode: "items" }));
    const notAsked = harness([finish(["E1"])], { openCitation: async () => result([approved]) }, { small_scope_shortcut: true });
    await notAsked.research.research({ trigger: "sweep", brief: task(`Check ${agenticStartingSlotV1(1)}.`, [{ citation: approved.citation, if_unreadable: "fail" }]) });
    expect(notAsked.port.search).not.toHaveBeenCalled();
    const notAllowed = harness([finish(["E1"])], { openCitation: async () => result([approved]) });
    await notAllowed.research.research({ trigger: "sweep", brief: task(`Check ${agenticStartingSlotV1(1)}.`, [{ citation: approved.citation, if_unreadable: "fail" }], { small_scope_preload: true }) });
    expect(notAllowed.port.search).not.toHaveBeenCalled();
  });
});

describe("brief: unreadable starting items", () => {
  const readable = record("readable", "SW-22b formats two decimals.");
  const deleted = record("deleted");
  const hidden = record("hidden", null);
  const openCitation = async (input: { readonly citation: unknown }): Promise<EvidenceDeskResultV2> => {
    const key = JSON.stringify(input.citation);
    if (key === JSON.stringify(deleted.citation)) throw new AuthorityOperationError("not_found", "Evidence item is not available");
    if (key === JSON.stringify(hidden.citation)) throw new AuthorityOperationError("unauthorized", "Live source is unavailable in this scope");
    return result([readable]);
  };

  it("lists 'report' items it cannot read in the bundle and keeps researching", async () => {
    const listedOnly = record("listed-only", null);
    const h = harness([finish(["E1"])], {
      openCitation: async input => JSON.stringify(input.citation) === JSON.stringify(listedOnly.citation) ? result([listedOnly]) : openCitation(input),
    });
    const brief = task(`Recheck ${agenticStartingSlotV1(1)}, ${agenticStartingSlotV1(2)}, ${agenticStartingSlotV1(3)} and ${agenticStartingSlotV1(4)}.`, [
      { citation: readable.citation, if_unreadable: "report" }, { citation: deleted.citation, if_unreadable: "report" },
      { citation: hidden.citation, if_unreadable: "report" }, { citation: listedOnly.citation, if_unreadable: "report" },
    ]);
    const bundle = await h.research.researchBundle({ trigger: "sweep", brief });
    expect(bundle.unreadable_starting).toEqual([deleted.citation, hidden.citation, listedOnly.citation]);
    expect(h.prompt(0).task).toBe("Recheck E1, an item that could not be read, an item that could not be read and an item that could not be read.");
    expect(bundle.stop).toEqual({ reason: "finished", completed: true });
    // Only what the desk released becomes an item: the readable record and the listed-only metadata, never the refused items.
    expect(bundle.items.map(entry => entry.item)).toEqual([readable, listedOnly]);
    expect(bundle.coverage.reads.filter(read => read.unavailable)).toHaveLength(2);
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
    for (const missing of [deleted, record("metadata-only", null)]) {
      const h = harness([], { openCitation: async input => JSON.stringify(input.citation) === JSON.stringify(missing.citation) && missing.text === undefined ? result([missing]) : openCitation(input) });
      await expect(h.research.research({ trigger: "sweep", brief: task(`Check ${agenticStartingSlotV1(1)}.`, [{ citation: missing.citation, if_unreadable: "fail" }]) })).rejects.toMatchObject({ code: "not_found" });
      expect(h.generate).not.toHaveBeenCalled();
    }
  });

  it("still stops a 'report' item on a failure that is not a refusal", async () => {
    const h = harness([], { openCitation: async () => { throw new AuthorityOperationError("unavailable", "Source is down"); } });
    await expect(h.research.research({ trigger: "sweep", brief: task(`Check ${agenticStartingSlotV1(1)}.`, [{ citation: readable.citation, if_unreadable: "report" }]) })).rejects.toMatchObject({ code: "unavailable" });
    expect(h.generate).not.toHaveBeenCalled();
  });
});
