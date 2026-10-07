import { readFileSync, writeFileSync } from "node:fs";
import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { createAgenticResearchV1, type AgenticAskAuditEntryV1 } from "../../src/answer-composition/agentic-ask-v1.js";
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from "../../src/answer-composition/agentic-trigger-definitions-v1.js";
import type { StructuredGenerationInput } from "../../src/answer-composition/structured-generation-v1.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";
import type { EvidenceDeskItemV2, EvidenceDeskListInputV2, EvidenceDeskPortV2 } from "../../src/shared/evidence-desk-v2.js";
import { checked, generation, result } from "./fixtures/agentic-scenarios.js";

/**
 * Impact card replay (research trigger contract v1, section 5). Scripted desk
 * replies, scripted model replies and a pinned clock drive the approved-record
 * trigger end to end: its definition's brief, the research loop, the impact
 * card renderer and the shared release step. The fixture holds each card and
 * the fingerprints of every model input and audit record.
 *
 * Recorded once, from the reviewed implementation, with IMPACT_GOLDEN_WRITE=1.
 * That switch writes only this fixture; GOLDEN_WRITE never touches it, and
 * this switch never touches the Ask fixtures.
 */
const FIXTURE = new URL("./agentic-impact-card-golden.v1.json", import.meta.url);
const definition = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === "approved_record")!;

const RECORD = canonicalSha256({ record: "display-review" });
function recordItem(atom: string, text: string, extra: Partial<EvidenceDeskItemV2> = {}): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `desk_${atom}`, citation: { kind: "approved_record" as const, atom_id: canonicalSha256({ atom }), record_sha256: RECORD, policy_id: "organization-member-readable-person-v2" as const },
    kind: "decision" as const, text, label: "Display review", visibility: "team" as const, occurred_at: "2026-10-05", receipt_sha256: canonicalSha256({ receipt: atom }), ...extra,
  });
}
const DECISION = recordItem("decision", "Approved: the display shows two decimals (0.01 °C) from DVT, for MRD-02.");
const ACTION = recordItem("action", "Mara will update the PRD display section by Oct 10.", { kind: "action", attributes: { owner: "Mara Quinn", due_at: "2026-10-10" } });
function ticket(key: string, text: string | undefined, attributes: EvidenceDeskItemV2["attributes"]): EvidenceDeskItemV2 {
  return Object.freeze({
    // Listed and opened, the same desk item: opening it adds its text.
    id: `ticket_${key}`,
    citation: { kind: "ticket" as const, tool_id: "jira", external_scope_id: "cloud-one", ticket_id: key.replace(/\D/gu, ""), permalink: `https://tickets.example.test/browse/${key}`, text_sha256: sha256Digest(text ?? "") },
    kind: "ticket" as const, label: `${key}: Display firmware`, ...(text === undefined ? {} : { text }), visibility: "only_me" as const, ...(attributes === undefined ? {} : { attributes }),
    occurred_at: "2026-09-30", date_kind: "created" as const, receipt_sha256: canonicalSha256({ ticket: key, text: text ?? null }),
  });
}
function page(id: string, label: string, text: string | undefined): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `page_${id}_${text === undefined ? "listed" : "open"}`,
    citation: { kind: "page" as const, tool_id: "knowledge", external_scope_id: "site-one", page_id: id, section_id: "s1", version: "4", permalink: `https://knowledge.example.test/wiki/pages/${id}`, text_sha256: sha256Digest(text ?? "") },
    kind: "page" as const, label, ...(text === undefined ? {} : { text }), visibility: "only_me" as const, occurred_at: "2026-10-04", date_kind: "version_created" as const,
    receipt_sha256: canonicalSha256({ page: id, text: text ?? null }),
  });
}
const TICKET_LISTED = ticket("THERM-46", undefined, { status: "In Progress", owner: "Tobias Lund", due_at: "2026-10-15" });
const TICKET = ticket("THERM-46", "THERM-46: firmware formats the reading with one decimal. Target: DVT build on Oct 15.", { status: "In Progress", owner: "Tobias Lund", due_at: "2026-10-15" });
const TICKET_DONE = ticket("THERM-31", undefined, { status: "Done", owner: "Ana Ruiz" });
const PRD = page("1441793", "PRD: Display", "Display: the reading shows one decimal (0.1 °C).");
const TEST_PLAN = page("2001", "DVT test plan", "TC-D-06: check the display shows two decimals.");
const GATE = page("99", "Gate review notes", undefined);

const LIVE_SOURCES: EvidenceDeskPortV2["live_sources"] = [
  { source_id: "jira", kind: "ticket", selector: "tickets", description: "Live work items.", metadata_only_list: true, tool_id: "jira" },
  { source_id: "confluence", kind: "page", selector: "pages", description: "Live knowledge pages.", metadata_only_list: true, tool_id: "confluence" },
];
/** The record opens to its decision and action; tickets list, pages search, and opens read what was listed. */
function desk(options: { readonly list_more?: boolean; readonly gate_unreadable?: boolean } = {}): EvidenceDeskPortV2 {
  return {
    scope: { kind: "project", project_id: "prj_00000000-0000-4000-8000-000000000001" }, ticket_available: true, live_sources: LIVE_SOURCES,
    openCitation: async () => result([DECISION, ACTION]),
    list: async (_input: EvidenceDeskListInputV2) => result([TICKET_LISTED, TICKET_DONE], options.list_more === true ? { next_cursor: "page-2" } : {}),
    search: async () => result([PRD, TEST_PLAN, ...(options.gate_unreadable === true ? [GATE] : [])]),
    open: async (input) => {
      if (input.item === TICKET_LISTED.id) return result([TICKET]);
      if (input.item === GATE.id) throw new AuthorityOperationError("not_found", "Evidence item is not available");
      return result([]);
    },
    revalidate: async () => checked,
  };
}

const need = (text: string, status: string, evidence: readonly string[] = []) => ({ need: text, status, evidence });
const step = (needs: readonly ReturnType<typeof need>[], actions: readonly { tool: string; args: Record<string, string> }[]) => ({ parts: [{ question: "What does E1 affect?", needs, notes: "" }], actions });
const affected = (id: string, says_now: string, relation: string, date_at_risk = "", milestone = "") => ({ id, says_now, relation, date_at_risk, milestone });

/** Research ids: E1 decision, E2 action (the record), E3 THERM-46, E4 THERM-31, E5 PRD, E6 test plan, E7 gate notes (when listed). */
const RESEARCH = [
  step([need("tickets the display decision affects", "open"), need("PRD display section", "open")], [{ tool: "list", args: { source: "tickets" } }, { tool: "search", args: { source: "pages", query: "display decimals" } }]),
  step([need("tickets the display decision affects", "open"), need("PRD display section", "found", ["E5"])], [{ tool: "open", args: { id: "E3" } }]),
  step([need("tickets the display decision affects", "found", ["E3"]), need("PRD display section", "found", ["E5", "E6"])], [{ tool: "finish", args: {} }]),
];
const CARD = {
  decided: [{ id: "E1", text: "The display shows two decimals (0.01 °C) from DVT." }, { id: "E2", text: "Mara updates the PRD display section by Oct 10." }],
  affected: [
    affected("E5", "The PRD display section specifies one decimal (0.1 °C).", "needs_updating"),
    affected("E3", "THERM-46 formats the reading with one decimal for the Oct 15 DVT build.", "conflicts", "2026-10-15", "DVT build"),
    affected("E6", "TC-D-06 already checks for two decimals.", "confirms"),
    affected("E2", "The record's own action.", "confirms"), affected("E9", "An invented ticket.", "conflicts"),
  ],
};

/** The pinned clock moves only when the model is called: by `model_call_ms`, or by its entry for that call. */
type Scenario = { readonly desk: () => EvidenceDeskPortV2; readonly replies: readonly unknown[]; readonly model_call_ms?: number | readonly number[] };
const SCENARIOS: Readonly<Record<string, Scenario>> = {
  // Research finishes; the card relates three items, drops an invented one and the record's own action, and names one owner.
  assessed_card: { desk: () => desk(), replies: [...RESEARCH, CARD] },
  // A ticket list research did not page through and a page it could not read: the card says so.
  coverage_notes: {
    desk: () => desk({ list_more: true, gate_unreadable: true }),
    replies: [
      RESEARCH[0],
      step([need("tickets the display decision affects", "open"), need("PRD display section", "found", ["E5"])], [{ tool: "open", args: { id: "E3" } }, { tool: "open", args: { id: "E7" } }]),
      RESEARCH[2], CARD,
    ],
  },
  // Two unusable card replies: the cited items, not yet assessed, with their details and owners.
  fallback_after_two_bad_replies: { desk: () => desk(), replies: [...RESEARCH, { relations: "all fine" }, { still: "no card" }] },
  // A line telling someone to edit Jira is sent back once; the second reply is used.
  edit_instruction_repaired: {
    desk: () => desk(),
    replies: [...RESEARCH, { ...CARD, affected: [affected("E3", "Change THERM-46 in Jira to format two decimals.", "needs_updating")] }, CARD],
  },
  // Research runs out of time with a need still open; the card is still written, and says research stopped early.
  research_stopped_on_budget: {
    desk: () => desk(), model_call_ms: [140_000, 140_000, 1_000],
    replies: [RESEARCH[0], RESEARCH[1], { decided: CARD.decided, affected: [CARD.affected[1]] }],
  },
};

async function run(name: string, scenario: Scenario) {
  const inputs: StructuredGenerationInput[] = [];
  const audit: AgenticAskAuditEntryV1[] = [];
  let offset = 0;
  let time = 0;
  const model = {
    generate: async (input: StructuredGenerationInput) => {
      inputs.push(input);
      const elapsed = scenario.model_call_ms;
      time += typeof elapsed === "number" ? elapsed : elapsed?.[offset] ?? 0;
      const reply = scenario.replies[offset++];
      if (reply === undefined) throw new Error(`${name}: unscripted model call ${offset}`);
      return reply;
    },
  };
  const research = createAgenticResearchV1({ desk: scenario.desk(), model, generation, audit: { append: entry => { audit.push(entry); } }, now_ms: () => time, today: () => "2026-10-06" });
  const event = definition.parseEvent({ record: DECISION.citation });
  const output = await research.renderWithResearch({ trigger: definition.name, brief: definition.brief(event), renderer: definition.renderer!, trigger_input: event });
  const entry = audit.at(-1)!;
  return {
    calls: inputs.length,
    prompt_sha256: entry.prompt_sha256,
    answer_sha256: entry.answer_sha256,
    response_sha256: entry.response_sha256,
    model_inputs_sha256: canonicalSha256(inputs.map(({ signal: _signal, ...input }) => input)),
    outcome: entry.outcome,
    audit_sha256: canonicalSha256(JSON.parse(JSON.stringify(entry))),
    card: JSON.parse(JSON.stringify(output.rendered)) as unknown,
  };
}

describe("impact card golden replay", () => {
  it("reproduces every recorded card, model input and audit fingerprint", async () => {
    const observed: Record<string, Awaited<ReturnType<typeof run>>> = {};
    for (const [name, scenario] of Object.entries(SCENARIOS)) observed[name] = await run(name, scenario);
    if (process.env.IMPACT_GOLDEN_WRITE === "1") writeFileSync(FIXTURE, `${JSON.stringify(observed, null, 2)}\n`);
    const recorded = JSON.parse(readFileSync(FIXTURE, "utf8")) as typeof observed;
    expect(observed).toEqual(recorded);
  });
});
