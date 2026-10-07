import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { vi } from "vitest";
import { createAgenticAskV1, createAgenticAskV3, createAgenticResearchV1, type AgenticAskAuditEntryV1 } from "../../../src/answer-composition/agentic-ask-v1.js";
import type { AgenticEvidenceBundleV1 } from "../../../src/answer-composition/agentic-evidence-bundle-v1.js";
import { createAgenticModelGateV1 } from "../../../src/answer-composition/agentic-model-gate-v1.js";
import { AGENTIC_RESEARCH_LIVE_BUDGET_V1, type AgenticResearchBudgetV1 } from "../../../src/answer-composition/agentic-research-v1.js";
import type { StructuredGenerationInput, StructuredGenerationPort, StructuredGenerationUsageV1 } from "../../../src/answer-composition/structured-generation-v1.js";
import type { EvidenceDeskItemV1, EvidenceDeskListInputV1, EvidenceDeskPortV1, EvidenceDeskResultV1 } from "../../../src/shared/evidence-desk-v1.js";
import type { EvidenceDeskItemV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from "../../../src/shared/evidence-desk-v2.js";

/**
 * Shared fixtures for the agentic research tests: desk items, scripted model
 * replies, the Ask golden scenarios and their replay, a research core over a
 * scripted desk, and a model gate over scripted replies for renderer tests.
 */
export const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000 };
export const checked = { checked_at: "2026-10-06T00:00:00.000Z" };

export function record(id: string, text: string | undefined = `Approved record ${id}: the review decided ${id}.`, options: Partial<EvidenceDeskItemV1> = {}): EvidenceDeskItemV1 {
  return Object.freeze({
    id: `desk_${canonicalSha256({ id }).slice(7)}`,
    citation: { kind: "approved_record" as const, atom_id: canonicalSha256({ id }), record_sha256: canonicalSha256({ id, record: true }), policy_id: "organization-member-readable-person-v2" as const },
    kind: "decision" as const, ...(text === undefined ? {} : { text }), label: `Meeting ${id}`, visibility: "team" as const,
    occurred_at: "2026-10-01", receipt_sha256: canonicalSha256({ receipt: id }), ...options,
  });
}
export function listed(id: string, options: Partial<EvidenceDeskItemV1> = {}): EvidenceDeskItemV1 {
  const { text: _text, ...item } = record(id, "unused", options);
  return Object.freeze(item);
}
function ticket(key: string, body: string | undefined, status: string): EvidenceDeskItemV2 {
  const citation = { kind: "ticket" as const, tool_id: "jira", external_scope_id: "cloud-one", ticket_id: key.replace(/\D/gu, ""), permalink: `https://tickets.example.test/browse/${key}`, text_sha256: sha256Digest(body ?? "") };
  return Object.freeze({
    id: `ticket_${key}_${body === undefined ? "listed" : "open"}`, citation, kind: "ticket" as const, label: `${key}: Fixture work item`,
    ...(body === undefined ? {} : { text: body }), visibility: "only_me" as const, attributes: { status, owner: "Mara Quinn" },
    occurred_at: "2026-09-30", date_kind: "created" as const, receipt_sha256: canonicalSha256({ ticket: key, body: body ?? null }),
  });
}
function page(id: string, body: string | undefined): EvidenceDeskItemV2 {
  const citation = { kind: "page" as const, tool_id: "knowledge", external_scope_id: "site-one", page_id: id, section_id: "s1", version: "3", permalink: `https://knowledge.example.test/wiki/pages/${id}`, text_sha256: sha256Digest(body ?? "") };
  return Object.freeze({
    id: `page_${id}_${body === undefined ? "listed" : "open"}`, citation, kind: "page" as const, label: `Gate review ${id}`,
    ...(body === undefined ? {} : { text: body }), visibility: "only_me" as const, occurred_at: "2026-10-04", date_kind: "version_created" as const,
    receipt_sha256: canonicalSha256({ page: id, body: body ?? null }),
  });
}
export const result = <T extends EvidenceDeskItemV1 | EvidenceDeskItemV2>(items: readonly T[], extra: Partial<EvidenceDeskResultV1> = {}) =>
  ({ items, truncated: false, receipt_digests: [canonicalSha256({ desk: items.map(item => item.id) })], ...extra });

export type Scenario = {
  readonly version: 4 | 6;
  readonly question: string;
  readonly desk: () => EvidenceDeskPortV1 | EvidenceDeskPortV2;
  readonly replies: readonly unknown[];
  /** Pinned clock advances only when the model is called, so the stop is deterministic. */
  readonly model_call_ms?: number;
  readonly shortcut?: boolean;
  readonly asker?: string;
};

export const need = (text: string, status: string, evidence: readonly string[] = []) => ({ need: text, status, evidence });
export const part = (question: string, needs: readonly ReturnType<typeof need>[], notes = "") => ({ question, needs, notes });
export const step = (parts: readonly ReturnType<typeof part>[], actions: readonly { tool: string; args: Record<string, string> }[]) => ({ parts, actions });

/** The Ask golden scenarios. Both golden fixtures pin every one byte for byte: change one only by recording a reviewed baseline. */
export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  finish_after_search_and_open: {
    version: 4, question: "When does DVT start?", asker: "Zhen Ye",
    desk: () => ({
      scope: { kind: "global" }, live_sources: [],
      search: async () => result([listed("dvt-start")]),
      open: async () => result([record("dvt-start", "Approved: DVT starts October 12 after the fixture arrives.")]),
      list: async () => result([]), revalidate: async () => checked,
    }),
    replies: [
      step([part("When does DVT start?", [need("approved DVT start date", "open")])], [{ tool: "search", args: { query: "DVT start" } }]),
      step([part("When does DVT start?", [need("approved DVT start date", "open")], "E1 looks relevant")], [{ tool: "open", args: { id: "E1" } }]),
      step([part("When does DVT start?", [need("approved DVT start date", "found", ["E1"])], "E1: Oct 12")], [{ tool: "finish", args: {} }]),
      { sentences: [{ text: "DVT starts October 12, after the fixture arrives.", evidence: ["E1"] }], not_found: [] },
    ],
  },
  not_found_after_two_searches: {
    version: 4, question: "Who owns the enclosure supplier follow-up?",
    desk: () => ({
      scope: { kind: "project", project_id: "prj_00000000-0000-4000-8000-000000000001" }, live_sources: [],
      search: async () => result([]), open: async () => result([]), list: async () => result([]), revalidate: async () => checked,
    }),
    replies: [
      step([part("Who owns it?", [need("owner of enclosure supplier follow-up", "open")])], [{ tool: "search", args: { query: "enclosure supplier" } }, { tool: "search", args: { query: "supplier follow-up owner" } }]),
      step([part("Who owns it?", [need("owner of enclosure supplier follow-up", "not_found")])], [{ tool: "finish", args: {} }]),
      { sentences: [], not_found: ["owner of the enclosure supplier follow-up"] },
    ],
  },
  repair_after_invalid_step: {
    version: 4, question: "What was decided about the battery reserve?",
    desk: () => ({
      scope: { kind: "global" }, live_sources: [],
      search: async () => result([record("battery", "Approved: keep a 20% battery reserve for transport mode.")]),
      open: async () => result([]), list: async () => result([]), revalidate: async () => checked,
    }),
    replies: [
      { thoughts: "search first" },
      step([part("Battery reserve decision?", [need("battery reserve decision", "open")])], [{ tool: "search", args: { query: "battery reserve" } }]),
      step([part("Battery reserve decision?", [need("battery reserve decision", "found", ["E1"])])], [{ tool: "finish", args: {} }]),
      { sentences: [{ text: "The review approved a 20% battery reserve for transport mode.", evidence: ["E1"] }], not_found: [] },
    ],
  },
  writer_fallback_to_records: {
    version: 4, question: "What did the review decide about calibration?",
    desk: () => ({
      scope: { kind: "global" }, live_sources: [],
      search: async () => result([record("calibration", "Approved: calibrate every unit on the line at 37 °C.")]),
      open: async () => result([]), list: async () => result([]), revalidate: async () => checked,
    }),
    replies: [
      step([part("Calibration decision?", [need("calibration decision", "open")])], [{ tool: "search", args: { query: "calibration" } }]),
      step([part("Calibration decision?", [need("calibration decision", "found", ["E1"])])], [{ tool: "finish", args: {} }]),
      { wrong: true },
      { still: "wrong" },
    ],
  },
  no_progress_stop: {
    version: 4, question: "What is the latest on the fixture vendor?",
    desk: () => ({
      scope: { kind: "global" }, live_sources: [],
      search: async (input: { readonly query?: string }) => result(input.query === "fixture vendor" ? [listed("vendor")] : []),
      open: async () => result([record("vendor", "Approved: the fixture vendor ships October 20.")]),
      list: async () => result([]), revalidate: async () => checked,
    }),
    replies: [
      step([part("Fixture vendor?", [need("latest fixture vendor status", "open")])], [{ tool: "search", args: { query: "fixture vendor" } }]),
      step([part("Fixture vendor?", [need("latest fixture vendor status", "open")])], [{ tool: "search", args: { query: "fixture vendor" } }]),
      step([part("Fixture vendor?", [need("latest fixture vendor status", "open")])], [{ tool: "search", args: { query: "fixture vendor" } }]),
      { sentences: [], not_found: ["latest fixture vendor status"] },
    ],
  },
  list_pages_and_owner_filter: {
    version: 4, question: "What actions does Mara own?",
    desk: () => ({
      scope: { kind: "global" }, live_sources: [],
      search: async () => result([]), open: async () => result([]),
      list: async (input: EvidenceDeskListInputV1) => input.cursor === undefined
        ? result([record("a1", "Mara will publish the dashboard.", { kind: "action", attributes: { owner: "Mara Quinn", due_at: "2026-10-09" } }), record("a2", "Tobias will order samples.", { kind: "action", attributes: { owner: "Tobias Lund" } })], { next_cursor: "page-2" })
        : result([record("a3", "Mara will review the PRD.", { kind: "action", attributes: { owner: "Mara Quinn" } })]),
      revalidate: async () => checked,
    }),
    replies: [
      step([part("Mara's actions?", [need("actions owned by Mara", "open")])], [{ tool: "list", args: { source: "meetings", owner: "Mara" } }]),
      step([part("Mara's actions?", [need("actions owned by Mara", "found", ["E1", "E2"])])], [{ tool: "finish", args: {} }]),
      { sentences: [{ text: "Mara owns publishing the dashboard by October 9 and reviewing the PRD.", evidence: ["E1", "E2"] }], not_found: [] },
    ],
  },
  budget_stop_with_slow_clock: {
    version: 4, question: "Is the DVT build on track?",
    model_call_ms: 20_000,
    desk: () => ({
      scope: { kind: "global" }, live_sources: [],
      search: async (input: { readonly query?: string }) => result([record(`hit-${input.query ?? "none"}`)]),
      open: async () => result([]), list: async () => result([]), revalidate: async () => checked,
    }),
    replies: [
      step([part("On track?", [need("DVT status", "open")])], [{ tool: "search", args: { query: "DVT status" } }]),
      step([part("On track?", [need("DVT status", "open")])], [{ tool: "search", args: { query: "DVT schedule" } }]),
      step([part("On track?", [need("DVT status", "open")])], [{ tool: "search", args: { query: "DVT risk" } }]),
      { sentences: [{ text: "The review decided hit-DVT status.", evidence: ["E1"] }], not_found: ["whether DVT is on track"] },
    ],
  },
  small_scope_preload: {
    version: 4, question: "Summarize what was approved.", shortcut: true,
    desk: () => ({
      scope: { kind: "mine" }, live_sources: [],
      search: async (input: { readonly query?: string }) => input.query === undefined ? result([listed("p1"), listed("p2")]) : result([]),
      open: async (input: { readonly item: string }) => result([record(input.item.endsWith(canonicalSha256({ id: "p1" }).slice(7)) ? "p1" : "p2")]),
      list: async () => result([]), revalidate: async () => checked,
    }),
    replies: [
      step([part("What was approved?", [need("approved decisions", "found", ["E1", "E2"])])], [{ tool: "finish", args: {} }]),
      { sentences: [{ text: "Two decisions were approved.", evidence: ["E1", "E2"] }], not_found: [] },
    ],
  },
  unusable_step_stop: {
    version: 4, question: "What did the review decide?",
    desk: () => ({
      scope: { kind: "global" }, live_sources: [],
      search: async () => result([]), open: async () => result([]), list: async () => result([]), revalidate: async () => checked,
    }),
    replies: [{ thoughts: "no parts" }, { still: "no parts" }],
  },
  step_limit_stop: {
    version: 4, question: "List every DVT decision.",
    desk: () => ({
      scope: { kind: "global" }, live_sources: [],
      search: async (input: { readonly query?: string }) => result([record(`decision-${input.query ?? "none"}`)]),
      open: async () => result([]), list: async () => result([]), revalidate: async () => checked,
    }),
    replies: [
      ...Array.from({ length: 10 }, (_, index) => step([part("Every DVT decision?", [need("all DVT decisions", "open")])], [{ tool: "search", args: { query: `DVT decision ${index + 1}` } }])),
      { sentences: [{ text: "The review decided decision-DVT decision 1.", evidence: ["E1"] }], not_found: ["any further DVT decisions"] },
    ],
  },
  empty_catalog_stop: {
    version: 4, question: "What is open this week?",
    desk: () => ({
      scope: { kind: "global" }, live_sources: [],
      search: async () => result([]), open: async () => result([]), list: async () => result([]), revalidate: async () => checked,
    }),
    replies: [
      step([part("Open this week?", [need("open items this week", "open")])], [{ tool: "list", args: { source: "meetings" } }, { tool: "list", args: { source: "documents" } }]),
    ],
  },
  live_ticket_and_page: {
    version: 6, question: "Why is the DVT gate on hold?",
    desk: () => {
      const listedTicket = ticket("THERM-46", undefined, "In Progress");
      const openTicket = ticket("THERM-46", "THERM-46: BUG-412 observed 39.0 °C versus 37.2 °C expected under load.", "In Progress");
      const listedPage = page("1441793", undefined);
      const openPage = page("1441793", "DVT review: HOLD until TC-D-03 and BUG-412 are resolved.");
      const desk: EvidenceDeskPortV2 = {
        scope: { kind: "global" }, ticket_available: true,
        live_sources: [
          { source_id: "jira", kind: "ticket", selector: "tickets", description: "Live work items.", metadata_only_list: true, tool_id: "jira" },
          { source_id: "confluence", kind: "page", selector: "pages", description: "Live knowledge pages.", metadata_only_list: true, tool_id: "confluence" },
        ],
        search: async () => result([listedPage]) as EvidenceDeskResultV2,
        list: async () => result([listedTicket]) as EvidenceDeskResultV2,
        open: async (input) => result([input.item === listedTicket.id ? openTicket : openPage]) as EvidenceDeskResultV2,
        revalidate: async () => checked,
      };
      return desk;
    },
    replies: [
      step([part("Why on hold?", [need("reason for DVT hold", "open")])], [{ tool: "list", args: { source: "tickets" } }, { tool: "search", args: { source: "pages", query: "DVT review hold" } }]),
      step([part("Why on hold?", [need("reason for DVT hold", "open")])], [{ tool: "open", args: { id: "E1" } }, { tool: "open", args: { id: "E2" } }]),
      step([part("Why on hold?", [need("reason for DVT hold", "found", ["E3", "E4"])])], [{ tool: "finish", args: {} }]),
      { sentences: [{ text: "DVT is on hold until TC-D-03 and BUG-412 are resolved; BUG-412 observed 39.0 °C versus 37.2 °C under load.", evidence: ["E3", "E4"] }], not_found: [] },
    ],
  },
};

/** Replays one scenario through Ask: scripted replies in order, and a clock that moves only when the model is called. */
export async function replay(name: string, scenario: Scenario, hooks: { readonly signal?: AbortSignal; readonly on_append?: (entry: AgenticAskAuditEntryV1) => void } = {}) {
  const inputs: StructuredGenerationInput[] = [];
  const audit: AgenticAskAuditEntryV1[] = [];
  let offset = 0;
  let time = 0;
  const model = {
    generate: async (input: StructuredGenerationInput) => {
      inputs.push(input);
      time += scenario.model_call_ms ?? 0;
      const reply = scenario.replies[offset++];
      if (reply === undefined) throw new Error(`${name}: unscripted model call ${offset}`);
      return reply;
    },
  };
  const options = {
    desk: scenario.desk(), model, generation, audit: { append: (entry: AgenticAskAuditEntryV1) => { audit.push(entry); hooks.on_append?.(entry); } },
    now_ms: () => time, today: () => "2026-10-06",
    ...(scenario.asker === undefined ? {} : { asker: { display_name: scenario.asker } }),
    ...(scenario.shortcut === true ? { small_scope_shortcut: true } : {}),
  };
  const input = { question: scenario.question, ...(hooks.signal === undefined ? {} : { signal: hooks.signal }) };
  const response = scenario.version === 6
    ? await createAgenticAskV3(options as Parameters<typeof createAgenticAskV3>[0]).answer(input)
    : await createAgenticAskV1(options as Parameters<typeof createAgenticAskV1>[0]).answer(input);
  return { response, inputs, audit };
}

/**
 * A research core over a project-scoped desk with empty defaults: scripted model replies in order, and every audit record kept.
 * With `usage`, the model also reports each call's token usage (call numbers start at 1).
 */
export function researchHarness(replies: readonly unknown[] | ((input: StructuredGenerationInput, index: number) => unknown), desk: Partial<EvidenceDeskPortV2> = {}, core: {
  readonly small_scope_shortcut?: true; readonly now_ms?: () => number; readonly usage?: (call: number) => StructuredGenerationUsageV1;
} = {}) {
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
    scope: { kind: "project", project_id: "prj_00000000-0000-4000-8000-000000000001" }, live_sources: [],
    search: vi.fn(async () => result([])), open: async () => result([]), list: async () => result([]), revalidate: async () => checked, ...desk,
  };
  const { usage, ...options } = core;
  const model: StructuredGenerationPort = usage === undefined ? { generate } : {
    generate, generate_with_observation: async input => ({ value: await generate(input), finish_reason: "stop", provider_latency_ms: null, usage: usage(inputs.length) }),
  };
  const research = createAgenticResearchV1({ desk: port, model, generation, audit: { append: entry => { audit.push(entry); } }, today: () => "2026-10-06", ...options });
  return { research, port, inputs, audit, generate, prompt: (index: number) => JSON.parse(inputs[index]!.user_prompt) as Record<string, unknown> };
}

/** A bundle with nothing gathered: renderer tests lay their items, plan and coverage over it. */
export const EMPTY_BUNDLE: AgenticEvidenceBundleV1 = {
  schema_version: 1, kind: "echo-agentic-evidence-bundle-v1", trigger: "ask", goal: { kind: "question", question: "What was decided?" }, budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1,
  plan: [], items: [], unreadable_starting: [], rounds: [], coverage: { reads: [], inventories: [], notices: [] }, stop: { reason: "finished", completed: true },
  cost: { rounds: 1, model_calls: 1, repairs: 0, fallbacks: 0, input_tokens: null, output_tokens: null, total_tokens: null, model_ms: 0, desk_ms: 0, elapsed_ms: 0 },
  gathered_for: { scope: { kind: "global" }, checked_at: null }, server: { receipts: [], invocation_digests: [], generations: [] },
};

/** A renderer's gate: scripted replies in order and no desk; every access check and model call lands in `trace`. */
export function scriptedGate(replies: readonly unknown[], budget: AgenticResearchBudgetV1, trace: string[]) {
  const inputs: StructuredGenerationInput[] = [];
  const gate = createAgenticModelGateV1({
    generation,
    model: {
      generate: async (input: StructuredGenerationInput) => {
        trace.push("generate"); inputs.push(input);
        const reply = replies[inputs.length - 1];
        if (reply === undefined) throw new Error(`unscripted call ${inputs.length}`);
        return reply;
      },
    },
    desk_revalidate: async () => { trace.push("revalidate"); return checked; }, on_checked: () => undefined,
    budget, now: () => 0, deadline: budget.deadline_ms,
    signal: new AbortController().signal, is_deadline_expired: () => false, content_sensitive: () => false,
  });
  return { gate, inputs };
}
