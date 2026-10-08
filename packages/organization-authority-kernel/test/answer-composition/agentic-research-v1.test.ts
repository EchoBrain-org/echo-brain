import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it, vi } from "vitest";
import { createAgenticResearchV1, type AgenticAskAuditEntryV1 } from "../../src/answer-composition/agentic-ask-v1.js";
import { TASK_RULE_PROMPT } from "../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import { agenticStartingSlotV1, type AgenticBriefV1 } from "../../src/answer-composition/agentic-brief-v1.js";
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1 } from "../../src/answer-composition/agentic-research-v1.js";
import type { StructuredGenerationInput } from "../../src/answer-composition/structured-generation-v1.js";
import type { EvidenceDeskItemV2, EvidenceDeskPortV2 } from "../../src/shared/evidence-desk-v2.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from "../../src/answer-composition/agentic-trigger-definitions-v1.js";
import type { PersonImpactCardV1 } from "@echo-brain/organization-api";
import { checked, generation, researchHarness as harness, listed, need, part, record, result, step } from "./fixtures/agentic-scenarios.js";

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

function liveTicket(key: string, text?: string): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `ticket_${key}`, source_id: "jira", kind: "ticket",
    citation: {
      kind: "ticket", tool_id: "jira", external_scope_id: "thermo-project", ticket_id: key,
      permalink: `https://tickets.example.test/browse/${key}`,
      text_sha256: sha256Digest(text ?? ""),
    },
    label: `${key}: Thermal fixture gate`,
    ...(text === undefined ? {} : { text }),
    visibility: "only_me", occurred_at: "2026-10-06", date_kind: "created",
    attributes: { status: "Open" }, receipt_sha256: canonicalSha256({ key, text: text ?? null }),
  } satisfies EvidenceDeskItemV2);
}

describe("research result beside Ask", () => {
  it("returns rounds, item flags, stop, cost and the writer input without desk ids, refs or receipts", async () => {
    const listedDvt = listed("dvt");
    const { research } = harness([
      step([part("Part", [need("DVT start", "open")])], [{ tool: "search", args: { query: "DVT start" } }]),
      step([part("Part", [need("DVT start", "open")])], [{ tool: "open", args: { id: "E1" } }]),
      step([part("Part", [need("DVT start", "found", ["E1"])])], [{ tool: "finish", args: {} }]),
      { sentences: [{ text: "DVT starts October 12.", evidence: ["E1"] }], not_found: [] },
    ], { search: async () => result([listedDvt]), open: async () => result([record("dvt", "Approved: DVT starts October 12.")]) });
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
    expect(serialized).not.toContain(listedDvt.id);
    expect(view.items.every(item => !("ref" in item) && !("receipt_sha256" in item))).toBe(true);
    expect(serialized).not.toContain(listedDvt.receipt_sha256);
  });

  it("records rejected replies on the round that follows them", async () => {
    const { research } = harness([
      { not: "a step" },
      step([part("Part", [need("battery reserve", "open")])], [{ tool: "search", args: { query: "battery" } }]),
      step([part("Part", [need("battery reserve", "found", ["E1"])])], [{ tool: "finish", args: {} }]),
      { sentences: [{ text: "A 20% reserve was approved.", evidence: ["E1"] }], not_found: [] },
    ], { search: async () => result([record("battery", "Approved: 20% reserve.")]) });
    const { research: view } = await research.answerWithResearch({ question: "What battery reserve was approved?" });
    expect(view.rounds[0]!.rejected).toEqual([expect.stringContaining('"parts" must be an array')]);
    expect(view.rounds[1]!.rejected).toEqual([]);
    expect(view.cost.repairs).toBe(1);
  });

  it("keeps an open representation notice in the next planner result and the evidence coverage", async () => {
    const discovered = listed("notice-open");
    const h = harness([
      step([part("DVT hold", [need("hold reason", "open")])], [{ tool: "search", args: { query: "DVT hold" } }]),
      step([part("DVT hold", [need("hold reason", "open")])], [{ tool: "open", args: { id: "E1" } }]),
      step([part("DVT hold", [need("hold reason", "found", ["E1"])])], [{ tool: "finish", args: {} }]),
      { sentences: [{ text: "The released record describes the DVT hold.", evidence: ["E1"] }], not_found: [] },
    ], {
      search: async () => result([discovered]),
      open: async () => result([record("notice-open", "DVT remains on hold pending review.")], { notice: "Some page sections could not be represented." }),
    });

    const output = await h.research.answerWithResearch({ question: "Why is DVT on hold?" });

    expect(output.research.rounds[1]!.actions[0]!.result.notice).toBe(true);
    expect(output.research.coverage.reads).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "open", notice: true, truncated: false }),
    ]));
    expect(output.research.coverage.notices).toEqual(["Some page sections could not be represented."]);
    expect(h.prompt(2).last_results).toEqual([expect.objectContaining({ tool: "open", notice: "Some page sections could not be represented." })]);
  });

  it("uses the same scoped search, list, and open rules for Ask and approved-record research", async () => {
    const anchorMetadata = liveTicket("THERM-100");
    const linkedMetadata = liveTicket("BUG-412");
    const anchorBody = liveTicket("THERM-100", "DVT remains on hold pending the linked fault.");
    const linkedBody = liveTicket("BUG-412", "The thermal fault needs disposition before PVT.");
    const approved = record("thermo-trigger", "Approved: assess the DVT hold.");
    const desk = () => {
      const calls: { tool: string; source?: string; kinds?: readonly string[]; item?: string }[] = [];
      const port: Partial<EvidenceDeskPortV2> = {
        scope: { kind: "project", project_id: "prj_00000000-0000-4000-8000-000000000001" },
        ticket_available: true,
        live_sources: [{ source_id: "jira", kind: "ticket", selector: "tickets", description: "Live work items.", metadata_only_list: true, tool_id: "jira" }],
        search: async input => {
          calls.push({ tool: "search", source: input.source, kinds: input.kinds });
          return result([]);
        },
        list: async input => {
          calls.push({ tool: "list", source: input.source, kinds: input.kinds });
          return result([anchorMetadata]);
        },
        open: async input => {
          calls.push({ tool: "open", item: input.item });
          return input.item === anchorMetadata.id
            ? result([anchorBody, linkedMetadata])
            : result([linkedBody]);
        },
        openCitation: async () => result([approved]),
      };
      return { port, calls };
    };
    const stepsFor = (anchor: string, linked: string) => [
      step([part("DVT hold", [need("hold cause", "open"), need("linked ticket", "open")])], [{ tool: "search", args: { source: "tickets", query: "DVT hold" } }]),
      step([part("DVT hold", [need("hold cause", "open"), need("linked ticket", "open")])], [{ tool: "list", args: { source: "tickets" } }]),
      step([part("DVT hold", [need("hold cause", "open"), need("linked ticket", "open")])], [{ tool: "open", args: { id: anchor } }]),
      // The linked result is metadata only here, so completion cannot cite it.
      step([part("DVT hold", [need("hold cause", "found", [anchor]), need("linked ticket", "found", [linked])])], [{ tool: "finish", args: {} }]),
      step([part("DVT hold", [need("hold cause", "open"), need("linked ticket", "open")])], [{ tool: "open", args: { id: linked } }]),
      step([part("DVT hold", [need("hold cause", "found", [anchor]), need("linked ticket", "found", [linked])])], [{ tool: "finish", args: {} }]),
    ];

    const askDesk = desk();
    const ask = harness([
      ...stepsFor("E1", "E2"),
      { sentences: [{ text: "The DVT hold and the linked fault both require follow-up.", evidence: ["E1", "E2"] }], not_found: [] },
    ], askDesk.port);
    const askOutput = await ask.research.answerWithResearch({ question: "Why is DVT on hold and what must happen before PVT?" });

    const taskDesk = desk();
    const task = harness(stepsFor("E2", "E3"), taskDesk.port);
    const taskOutput = await task.research.research({
      trigger: "approved_record",
      brief: taskBrief(`Assess what approved record ${agenticStartingSlotV1(1)} means for the DVT hold.`, [approved.citation]),
    });

    for (const calls of [askDesk.calls, taskDesk.calls]) {
      expect(calls.slice(0, 2)).toEqual([
        { tool: "search", source: "jira", kinds: ["ticket"] },
        { tool: "list", source: "jira", kinds: undefined },
      ]);
      expect(calls.filter(call => call.tool === "open").map(call => call.item)).toEqual([anchorMetadata.id, linkedMetadata.id]);
    }
    // The linked ticket delivered beside the anchor is discovery metadata, not
    // a full or citable passage until the following normal open admits its body.
    expect(ask.prompt(3)).toMatchObject({
      opened: [expect.objectContaining({ id: "E1", text: anchorBody.text })],
      seen: [expect.objectContaining({ id: "E2" })],
    });
    expect((ask.prompt(3).seen as readonly Record<string, unknown>[])[0]).not.toHaveProperty("text");
    expect(askOutput.research.rounds[3]!.rejected).toEqual([
      expect.stringContaining("found but cites no item whose full text you have read"),
    ]);
    expect(askOutput.research).toMatchObject({ stop: { reason: "finished", completed: true } });
    expect(taskOutput).toMatchObject({ trigger: "approved_record", stop: { reason: "finished", completed: true } });
    expect(askOutput.research.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "E1", opened: true, read_in_full: true, cited_by_plan: true }),
      expect.objectContaining({ id: "E2", opened: true, read_in_full: true, cited_by_plan: true }),
    ]));
    expect(taskOutput.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "E2", opened: true, read_in_full: true, cited_by_plan: true }),
      expect.objectContaining({ id: "E3", opened: true, read_in_full: true, cited_by_plan: true }),
    ]));
  });

  it("keeps preloaded evidence and records a budget stop when a required revalidation consumes the next planner step", async () => {
    let time = 0;
    let checks = 0;
    const full = record("budget-preload", "Approved: preserve the already released evidence.");
    const { research, generate } = harness([
      step([part("Current approved evidence", [need("current record", "open")])], [{ tool: "search", args: { query: "current record" } }]),
    ], {
      openCitation: async () => result([full]),
      revalidate: async () => {
        checks += 1;
        if (checks === 2) time = 86_001;
        return checked;
      },
    }, { now_ms: () => time });

    const view = await research.research({
      trigger: "sweep",
      brief: {
        goal: { kind: "task", task: "Find the current approved evidence." },
        starting: [{ citation: full.citation, if_unreadable: "fail" }],
        budget: { deadline_ms: 90_000, max_rounds: 10, max_model_calls: 24, writer_reserve_ms: 25_000 },
        options: { small_scope_preload: false },
      },
    });

    expect(view.stop).toEqual({ reason: "budget", completed: false, admission: "post_revalidation_no_time" });
    expect(view.items).toEqual([expect.objectContaining({ id: "E1", preloaded: true, read_in_full: true })]);
    expect(view.cost).toMatchObject({ model_calls: 1, repairs: 0, fallbacks: 0 });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("keeps a personal imported meeting distinct from approved decisions through Ask research and writing", async () => {
    const imported = importedMeeting("cohort", "Imported notes: ship the cohort on Friday.");
    const h = harness([
      step([part("Part", [need("cohort ship date", "open")])], [{ tool: "search", args: { source: "meetings", query: "cohort ship" } }]),
      step([part("Part", [need("cohort ship date", "found", ["E1"])])], [{ tool: "finish", args: {} }]),
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
      step([part("Two-decimal display", [need("PRD display precision", "open")])], [{ tool: "search", args: { query: "display precision" } }, { tool: "search", args: { query: "decimal places" } }]),
      step([part("Two-decimal display", [need("PRD display precision", "not_found")])], [{ tool: "finish", args: {} }]),
    ], { openCitation });
    const view = await h.research.research({ trigger: "approved_record", brief: taskBrief(`Find what approved record ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    expect(openCitation).toHaveBeenCalledWith(expect.objectContaining({ citation: approved.citation }));
    expect(h.inputs[0]!.system_prompt.endsWith(`\n\n${TASK_RULE_PROMPT}`)).toBe(true);
    const first = h.prompt(0);
    expect(first).toMatchObject({ task: "Find what approved record E1 affects." });
    expect(first).not.toHaveProperty("question");
    expect(view).toMatchObject({ trigger: "approved_record", stop: { reason: "finished" }, budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1 });
    expect(view.items[0]).toMatchObject({ id: "E1", preloaded: true, opened: true, read_in_full: true });
    expect(view.items[1]).toMatchObject({ id: "E2", preloaded: true });
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(h.audit).toEqual([expect.objectContaining({ trigger: "approved_record", outcome: "not_found", rounds: 2, model_calls: 2 })]);
    expect(h.audit[0]!.response_sha256).toBe(canonicalSha256(JSON.parse(JSON.stringify(view))));
    // A research-only answer is its checklist; the record binds the starting item it re-read.
    expect(h.audit[0]!.answer_sha256).toBe(canonicalSha256({ trigger: "approved_record", plan: view.plan }));
    expect(h.audit[0]!.receipt_digests).toContain(approved.receipt_sha256);
  });

  it("reads each starting item fresh, in brief order, and names each by its current id", async () => {
    const ticketOne = record("sw-22b", "SW-22b now formats two decimals.");
    const ticketTwo = record("tc-d-06", "TC-D-06 still expects one decimal.");
    const openCitation = vi.fn(async (input: { readonly citation: unknown }) => result([JSON.stringify(input.citation) === JSON.stringify(ticketOne.citation) ? ticketOne : ticketTwo]));
    const h = harness([
      step([part("Two decimals landed?", [need("SW-22b state", "found", ["E1"]), need("TC-D-06 state", "found", ["E2"])])], [{ tool: "finish", args: {} }]),
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
    await expect(h.research.research({ trigger: "approved_record", brief: taskBrief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) })).rejects.toMatchObject({ code: "not_found" });
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("refuses starting evidence on a desk that cannot open citations", async () => {
    const h = harness([], {});
    await expect(h.research.research({ trigger: "approved_record", brief: taskBrief(`Find what ${agenticStartingSlotV1(1)} affects.`, [record("x").citation]) })).rejects.toMatchObject({ code: "unavailable" });
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("rejects a blank task or a malformed starting item before any read", async () => {
    const openCitation = vi.fn();
    const h = harness([], { openCitation });
    await expect(h.research.research({ trigger: "sweep", brief: taskBrief(" ", [record("x").citation]) })).rejects.toThrow("research goal is invalid");
    await expect(h.research.research({ trigger: "sweep", brief: taskBrief("Recheck.", ["not a citation"]) })).rejects.toThrow("research goal is invalid");
    await expect(h.research.research({ trigger: "sweep", brief: { ...taskBrief("Recheck.", [record("x").citation]), starting: [{ citation: record("x").citation, if_unreadable: "skip" as never }] } })).rejects.toThrow("research goal is invalid");
    await expect(h.research.research({ trigger: "sweep", brief: { ...taskBrief("Recheck.", [record("x").citation]), goal: { kind: "task", task: "Recheck.", data: [1 as never] } } })).rejects.toThrow("research goal is invalid");
    expect(openCitation).not.toHaveBeenCalled();
  });

  it("runs up to the background round limit", async () => {
    const approved = record("anchor", "Approved: anchor.");
    let hit = 0;
    const h = harness((_input, index) => step([part("Part", [need("everything", "open")])], [{ tool: "search", args: { query: `query ${index}` } }]), {
      openCitation: async () => result([approved]),
      search: async () => result([record(`hit-${hit += 1}`)]),
    });
    const view = await h.research.research({ trigger: "approved_record", brief: taskBrief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    expect(view.rounds).toHaveLength(AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1.max_rounds);
    expect(view.stop).toEqual({ reason: "step_limit", completed: false });
    expect(h.audit[0]).toMatchObject({ trigger: "approved_record", rounds: 20, model_calls: 20, outcome: "partial" });
  });
});

describe("task briefs with a renderer", () => {
  const definition = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === "approved_record")!;

  it("renders the bundle with the trigger's renderer and releases its result through the shared release step", async () => {
    const decision = record("two-decimals", "Approved on Oct 8: show 0.01 °C on the display for MRD-02.");
    const ticket = { ...record("therm-46", "THERM-46: the firmware formats one decimal."), attributes: { status: "In Progress", owner: "Tobias Lund" } } as EvidenceDeskItemV2;
    const trace: string[] = [];
    const inputs: StructuredGenerationInput[] = [];
    const audit: AgenticAskAuditEntryV1[] = [];
    const replies = [
      step([part("Part", [need("affected tickets", "open")])], [{ tool: "search", args: { query: "display decimals" } }]),
      step([part("Part", [need("affected tickets", "found", ["E2"])])], [{ tool: "finish", args: {} }]),
      { decided: [{ id: "E1", text: "Show two decimals on the display." }], affected: [{ id: "E2", says_now: "The firmware formats one decimal.", relation: "conflicts", date_at_risk: "", milestone: "" }] },
    ];
    const port: EvidenceDeskPortV2 = {
      scope: { kind: "global" }, live_sources: [],
      search: async () => { trace.push("search"); return result([ticket]); }, open: async () => result([]), list: async () => result([]),
      openCitation: async () => { trace.push("openCitation"); return result([decision]); },
      revalidate: async () => { trace.push("revalidate"); return checked; },
    };
    const research = createAgenticResearchV1({
      desk: port, generation, today: () => "2026-10-06", audit: { append: entry => { trace.push("append"); audit.push(entry); } },
      model: { generate: async input => { trace.push(`generate:${inputs.length}`); inputs.push(input); return replies[inputs.length - 1]; } },
    });
    const event = definition.parseEvent({ record: decision.citation });
    const output = await research.renderWithResearch({ trigger: definition.name, brief: definition.brief(event), renderer: definition.renderer!, trigger_input: event });
    const card = output.rendered as PersonImpactCardV1;
    expect(card).toMatchObject({ status: "assessed", decided: [{ citation_index: 0 }], affected: [{ citation_index: 1, relation: "conflicts", owner: "Tobias Lund" }], people: [{ name: "Tobias Lund", items: [1] }] });
    expect(output.research).toMatchObject({ kind: "echo-agentic-research-result-v1", trigger: "approved_record", stop: { reason: "finished" } });
    // Research's two steps, the renderer's one call, then release: final check, audit, check after the audit.
    expect(trace).toEqual(["openCitation", "revalidate", "generate:0", "search", "revalidate", "generate:1", "revalidate", "generate:2", "revalidate", "append", "revalidate"]);
    expect(JSON.parse(inputs[2]!.user_prompt)).toMatchObject({ task: expect.stringContaining("A PM just approved record E1.") });
    expect(audit).toEqual([expect.objectContaining({
      trigger: "approved_record", budget: "background", outcome: "answered", rounds: 2, model_calls: 3, fallbacks: 0, citation_count: 2,
      answer_sha256: canonicalSha256({ decided: card.decided, affected: card.affected }), response_sha256: canonicalSha256(card),
    })]);
    expect(audit[0]!.generations.map(entry => entry.role)).toEqual(["step", "step", "answer"]);
  });

  it.each(["timed_out", "cancelled"] as const)("writes one %s witness and releases nothing when the card's model call is cut off", async outcome => {
    vi.useFakeTimers();
    try {
      const decision = record("two-decimals", "Approved on Oct 8: show 0.01 °C on the display for MRD-02.");
      const controller = new AbortController();
      let checks = 0;
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      // Research finishes at once; the card's call never replies.
      const h = harness((_input, index) => {
        if (index === 0) return step([part("Part", [need("affected tickets", "not_found")])], [{ tool: "finish", args: {} }]);
        entered(); return new Promise<never>(() => undefined);
      }, { openCitation: async () => result([decision]), revalidate: async () => ({ checked_at: `2026-10-06T00:00:0${checks += 1}.000Z` }) });
      const event = definition.parseEvent({ record: decision.citation });
      const pending = h.research.renderWithResearch({ trigger: definition.name, brief: definition.brief(event), renderer: definition.renderer!, trigger_input: event, signal: controller.signal });
      await started;
      const rejected = expect(pending).rejects.toMatchObject({ name: outcome === "timed_out" ? "AgenticAskDeadlineErrorV1" : "AbortError" });
      if (outcome === "timed_out") await vi.advanceTimersByTimeAsync(AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1.deadline_ms); else controller.abort();
      await rejected;
      // The witness binds the check before the card's call; no release check follows.
      expect(checks).toBe(2);
      expect(h.audit).toEqual([expect.objectContaining({
        trigger: "approved_record", budget: "background", outcome, model_calls: 2, checked_at: "2026-10-06T00:00:02.000Z", prompt_sha256: null, answer_sha256: null, response_sha256: null,
      })]);
    } finally { vi.useRealTimers(); }
  });

  it("refuses a renderer for a question brief before any read", async () => {
    const h = harness([], {});
    await expect(h.research.renderWithResearch({ trigger: "ask", brief: { goal: { kind: "question", question: "Why?" }, starting: [], budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, options: { small_scope_preload: false } }, renderer: definition.renderer!, trigger_input: {} }))
      .rejects.toThrow("research goal is invalid");
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.audit).toEqual([]);
  });
});
