import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1,
  createAgenticResearchV1,
  type AgenticAskAuditEntryV1,
} from "../../src/answer-composition/agentic-ask-v1.js";
import { TASK_RULE_PROMPT } from "../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import { agenticStartingSlotV1, type AgenticBriefV1 } from "../../src/answer-composition/agentic-brief-v1.js";
import type { StructuredGenerationInput } from "../../src/answer-composition/structured-generation-v1.js";
import type { EvidenceDeskItemV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from "../../src/shared/evidence-desk-v2.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";

const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000 };
const checked = { checked_at: "2026-10-06T00:00:00.000Z" };

function record(id: string, text: string | undefined = `Approved: ${id} was decided.`): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `desk_${canonicalSha256({ id }).slice(7)}`,
    citation: { kind: "approved_record" as const, atom_id: canonicalSha256({ id }), record_sha256: canonicalSha256({ id, record: true }), policy_id: "organization-member-readable-person-v2" as const },
    kind: "decision" as const, ...(text === undefined ? {} : { text }), label: `Meeting ${id}`, visibility: "team" as const,
    occurred_at: "2026-10-05", receipt_sha256: canonicalSha256({ receipt: id }),
  });
}
function importedMeeting(id: string, text: string): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `desk_${canonicalSha256({ imported: id }).slice(7)}`,
    citation: {
      kind: "source_revision" as const,
      source_id: `source:${canonicalSha256({ imported: id }).slice(7)}` as const,
      revision_id: `revision-${id}`,
      source_sha256: canonicalSha256({ imported: id, source: true }),
      representation_sha256: canonicalSha256({ imported: id, representation: true }),
      anchor_sha256: canonicalSha256({ imported: id, anchor: true }),
    },
    kind: "imported_meeting" as const, text, label: `Imported meeting ${id}`,
    visibility: "only_me" as const, occurred_at: "2026-10-05",
    receipt_sha256: canonicalSha256({ imported: id, receipt: true }),
  });
}
const result = (items: readonly EvidenceDeskItemV2[]): EvidenceDeskResultV2 => ({ items, truncated: false, receipt_digests: [canonicalSha256({ desk: items.map(item => item.id) })] });
const step = (needs: readonly { need: string; status: string; evidence?: readonly string[] }[], actions: readonly { tool: string; args?: Record<string, string> }[], question = "Part") =>
  ({ parts: [{ question, notes: "", needs: needs.map(need => ({ evidence: [], ...need })) }], actions: actions.map(action => ({ args: {}, ...action })) });

function harness(replies: readonly unknown[] | ((input: StructuredGenerationInput, index: number) => unknown), desk: Partial<EvidenceDeskPortV2>) {
  const inputs: StructuredGenerationInput[] = [];
  const audit: AgenticAskAuditEntryV1[] = [];
  const generate = vi.fn(async (input: StructuredGenerationInput) => {
    inputs.push(input);
    const index = inputs.length - 1;
    const reply = typeof replies === "function" ? replies(input, index) : replies[index];
    if (reply === undefined) throw new Error(`unscripted call ${index + 1}`);
    return reply;
  });
  const port: EvidenceDeskPortV2 = {
    scope: { kind: "project", project_id: "prj_00000000-0000-4000-8000-000000000001" } as EvidenceDeskPortV2["scope"], live_sources: [],
    search: async () => result([]), open: async () => result([]), list: async () => result([]), revalidate: async () => checked, ...desk,
  };
  const research = createAgenticResearchV1({ desk: port, model: { generate }, generation, audit: { append: entry => { audit.push(entry); } }, today: () => "2026-10-06" });
  return { research, inputs, audit, generate, prompt: (index: number) => JSON.parse(inputs[index]!.user_prompt) as Record<string, unknown> };
}

describe("research result beside Ask", () => {
  it("returns rounds, item flags, stop, cost and the writer input without desk ids, refs or receipts", async () => {
    const listed = { ...record("dvt"), text: undefined } as EvidenceDeskItemV2;
    const { research } = harness([
      step([{ need: "DVT start", status: "open" }], [{ tool: "search", args: { query: "DVT start" } }]),
      step([{ need: "DVT start", status: "open" }], [{ tool: "open", args: { id: "E1" } }]),
      step([{ need: "DVT start", status: "found", evidence: ["E1"] }], [{ tool: "finish" }]),
      { sentences: [{ text: "DVT starts October 12.", evidence: ["E1"] }], not_found: [] },
    ], { search: async () => result([listed]), open: async () => result([record("dvt", "Approved: DVT starts October 12.")]) });
    const output = await research.answerWithResearch({ question: "When does DVT start?" });
    expect(output.response.outcome).toBe("answered");
    expect(output.writer_evidence).toEqual(["E1"]);
    const view = output.research;
    expect(view).toMatchObject({ kind: "echo-agentic-research-result-v1", trigger: "ask", goal: { kind: "question", question: "When does DVT start?" }, stop: { reason: "finished", completed: true } });
    expect(view.rounds.map(round => round.actions.map(action => action.tool))).toEqual([["search"], ["open"], ["finish"]]);
    expect(view.rounds[0]!.actions[0]!.result.items).toEqual(["E1"]);
    expect(view.rounds[1]!.actions[0]!.result.opened).toEqual(["E1"]);
    expect(view.items).toEqual([expect.objectContaining({ id: "E1", read_in_full: true, opened: true, preloaded: false, cited_by_plan: true, text: "Approved: DVT starts October 12." })]);
    expect(view.cost).toMatchObject({ rounds: 3, model_calls: 3, repairs: 0, fallbacks: 0 });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(listed.id);
    expect(view.items.every(item => !("ref" in item) && !("receipt_sha256" in item))).toBe(true);
    expect(serialized).not.toContain(listed.receipt_sha256);
  });

  it("records rejected replies on the round that follows them", async () => {
    const { research } = harness([
      { not: "a step" },
      step([{ need: "battery reserve", status: "open" }], [{ tool: "search", args: { query: "battery" } }]),
      step([{ need: "battery reserve", status: "found", evidence: ["E1"] }], [{ tool: "finish" }]),
      { sentences: [{ text: "A 20% reserve was approved.", evidence: ["E1"] }], not_found: [] },
    ], { search: async () => result([record("battery", "Approved: 20% reserve.")]) });
    const { research: view } = await research.answerWithResearch({ question: "What battery reserve was approved?" });
    expect(view.rounds[0]!.rejected).toEqual([expect.stringContaining('"parts" must be an array')]);
    expect(view.rounds[1]!.rejected).toEqual([]);
    expect(view.cost.repairs).toBe(1);
  });

  it("keeps a personal imported meeting distinct from approved decisions through Ask research and writing", async () => {
    const imported = importedMeeting("cohort", "Imported notes: ship the cohort on Friday.");
    const h = harness([
      step([{ need: "cohort ship date", status: "open" }], [{ tool: "search", args: { source: "meetings", query: "cohort ship" } }]),
      step([{ need: "cohort ship date", status: "found", evidence: ["E1"] }], [{ tool: "finish" }]),
      { sentences: [{ text: "The imported notes say the cohort ships Friday.", evidence: ["E1"] }], not_found: [] },
    ], { search: async () => result([imported]) });

    const output = await h.research.answerWithResearch({ question: "When does the cohort ship?" });

    expect(h.prompt(0).source_catalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "meetings", description: expect.stringContaining("Imported meeting notes (unapproved)") }),
    ]));
    expect(output.research.items).toEqual([expect.objectContaining({ kind: "imported_meeting", title: "Imported meeting cohort", text: imported.text })]);
    expect(output.response.citations).toEqual([expect.objectContaining({ kind: "imported_meeting", visibility: "only_me", citation: imported.citation })]);
  });
});

/** A research-only brief: a task naming its starting items, on the background budget. */
const taskBrief = (task: string, citations: readonly unknown[], ifUnreadable: "fail" | "report" = "fail"): AgenticBriefV1 => ({
  goal: { kind: "task", task }, starting: citations.map(citation => ({ citation, if_unreadable: ifUnreadable })),
  budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, options: { small_scope_preload: false },
});

describe("research-only triggers", () => {
  it("preloads the starting record as E1, sends the task under the shared rule, runs no writer and audits the trigger", async () => {
    const approved = record("two-decimals", "Approved on Oct 8: show 0.01 °C on the display for MRD-02.");
    const openCitation = vi.fn(async () => result([approved, record("rationale", "Rationale: the customer needs two decimals.")]));
    const h = harness([
      step([{ need: "PRD display precision", status: "open" }], [{ tool: "search", args: { query: "display precision" } }, { tool: "search", args: { query: "decimal places" } }], "Two-decimal display"),
      step([{ need: "PRD display precision", status: "not_found" }], [{ tool: "finish" }], "Two-decimal display"),
    ], { openCitation });
    const view = await h.research.research({ trigger: "check", brief: taskBrief(`Check the approved record ${agenticStartingSlotV1(1)}.`, [approved.citation]) });
    expect(openCitation).toHaveBeenCalledWith(expect.objectContaining({ citation: approved.citation }));
    expect(h.inputs[0]!.system_prompt.endsWith(`\n\n${TASK_RULE_PROMPT}`)).toBe(true);
    const first = h.prompt(0);
    expect(first).toMatchObject({ task: "Check the approved record E1." });
    expect(first).not.toHaveProperty("question");
    expect(view).toMatchObject({ trigger: "check", stop: { reason: "finished" }, budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1 });
    expect(view.items[0]).toMatchObject({ id: "E1", preloaded: true, opened: true, read_in_full: true });
    expect(view.items[1]).toMatchObject({ id: "E2", preloaded: true });
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(h.audit).toEqual([expect.objectContaining({ trigger: "check", outcome: "not_found", rounds: 2, model_calls: 2 })]);
    expect(h.audit[0]!.response_sha256).toBe(canonicalSha256(JSON.parse(JSON.stringify(view))));
  });

  it("reads each starting item fresh, in brief order, and names each by its current id", async () => {
    const ticketOne = record("sw-22b", "SW-22b now formats two decimals.");
    const ticketTwo = record("tc-d-06", "TC-D-06 still expects one decimal.");
    const openCitation = vi.fn(async (input: { readonly citation: unknown }) => result([JSON.stringify(input.citation) === JSON.stringify(ticketOne.citation) ? ticketOne : ticketTwo]));
    const h = harness([
      step([{ need: "SW-22b state", status: "found", evidence: ["E1"] }, { need: "TC-D-06 state", status: "found", evidence: ["E2"] }], [{ tool: "finish" }], "Two decimals landed?"),
    ], { openCitation });
    const view = await h.research.research({ trigger: "sweep", brief: taskBrief(
      `Recheck: firmware cited ${agenticStartingSlotV1(1)}; the test case cited ${agenticStartingSlotV1(2)} and ${agenticStartingSlotV1(1)}.`,
      [ticketOne.citation, ticketTwo.citation], "report") });
    expect(openCitation).toHaveBeenCalledTimes(2);
    expect(h.prompt(0)).toMatchObject({ task: "Recheck: firmware cited E1; the test case cited E2 and E1." });
    expect(view.stop.reason).toBe("finished");
    expect(h.audit[0]).toMatchObject({ trigger: "sweep", outcome: "answered" });
  });

  it("fails closed before any model call when starting evidence is not readable", async () => {
    const approved = record("gone");
    const h = harness([], { openCitation: async () => { throw new AuthorityOperationError("not_found", "Evidence item is not available"); } });
    await expect(h.research.research({ trigger: "check", brief: taskBrief(`Check ${agenticStartingSlotV1(1)}.`, [approved.citation]) })).rejects.toMatchObject({ code: "not_found" });
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("refuses starting evidence on a desk that cannot open citations", async () => {
    const h = harness([], {});
    await expect(h.research.research({ trigger: "check", brief: taskBrief(`Check ${agenticStartingSlotV1(1)}.`, [record("x").citation]) })).rejects.toMatchObject({ code: "unavailable" });
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("rejects a blank task or a malformed starting item before any read", async () => {
    const openCitation = vi.fn();
    const h = harness([], { openCitation });
    await expect(h.research.research({ trigger: "sweep", brief: taskBrief(" ", [record("x").citation]) })).rejects.toThrow("research goal is invalid");
    await expect(h.research.research({ trigger: "sweep", brief: taskBrief("Recheck.", ["not a citation"]) })).rejects.toThrow("research goal is invalid");
    await expect(h.research.research({ trigger: "sweep", brief: { ...taskBrief("Recheck.", [record("x").citation]), starting: [{ citation: record("x").citation, if_unreadable: "skip" as never }] } })).rejects.toThrow("research goal is invalid");
    expect(openCitation).not.toHaveBeenCalled();
  });

  it("runs up to the background round limit", async () => {
    const approved = record("anchor", "Approved: anchor.");
    let hit = 0;
    const h = harness((_input, index) => step([{ need: "everything", status: "open" }], [{ tool: "search", args: { query: `query ${index}` } }]), {
      openCitation: async () => result([approved]),
      search: async () => result([record(`hit-${hit += 1}`)]),
    });
    const view = await h.research.research({ trigger: "check", brief: taskBrief(`Check ${agenticStartingSlotV1(1)}.`, [approved.citation]) });
    expect(view.rounds).toHaveLength(AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1.max_rounds);
    expect(view.stop).toEqual({ reason: "step_limit", completed: false });
    expect(h.audit[0]).toMatchObject({ trigger: "check", rounds: 20, model_calls: 20, outcome: "partial" });
  });
});
