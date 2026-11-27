import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import type { PersonAnswerCitationV8 } from "@echo-brain/organization-api";
import { vi } from "vitest";
import { createAgenticAskV5, createAgenticResearchV1, type AgenticAskAuditEntryV1 } from "../../../src/answer-composition/agentic-ask-v1.js";
import { ANSWER_PROMPT } from "../../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import type { AgenticEvidenceBundleV1 } from "../../../src/answer-composition/agentic-evidence-bundle-v1.js";
import { FOLLOW_UP_RESOLVER_PROMPT, THREAD_RESOLVER_PROMPT } from "../../../src/answer-composition/agentic-follow-up-resolver-v1.js";
import { createAgenticModelGateV1 } from "../../../src/answer-composition/agentic-model-gate-v1.js";
import { AGENTIC_RESEARCH_LIVE_BUDGET_V1 } from "../../../src/answer-composition/agentic-research-v1.js";
import type { StructuredGenerationInput, StructuredGenerationPort, StructuredGenerationUsageV1 } from "../../../src/answer-composition/structured-generation-v1.js";
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "../../../src/shared/core-runtime-observation-v1.js";
import type { EvidenceDeskItemV1, EvidenceDeskPortV1 } from "../../../src/shared/evidence-desk-v1.js";
import type { EvidenceDeskItemV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from "../../../src/shared/evidence-desk-v2.js";

/**
 * Shared fixtures for the agentic research tests: desk items, scripted model
 * replies, Ask scenarios and their replay, a research core over a
 * scripted desk, and a model gate over scripted replies for renderer tests.
 */
export const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 180_000, context_tokens: 131_072, max_output_tokens: 16_000 };
export const checked = { checked_at: "2026-10-06T00:00:00.000Z" };
/** The pinned wall clock: when a fixture's lists are read (ADR-0041). */
export const LIST_READ_AT = "2026-10-06T09:30:00.000Z";
const wall_ms = () => Date.parse(LIST_READ_AT);

export function record(id: string, text: string | undefined = `Approved record ${id}: the review decided ${id}.`, options: Partial<EvidenceDeskItemV1> = {}): EvidenceDeskItemV1 {
  return Object.freeze({
    id: `desk_${canonicalSha256({ id }).slice(7)}`,
    citation: { kind: "approved_record" as const, atom_id: canonicalSha256({ id }), record_sha256: canonicalSha256({ id, record: true }), policy_id: "project-members-readable-person-v1" as const },
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
export const result = <T extends EvidenceDeskItemV1 | EvidenceDeskItemV2>(items: readonly T[], extra: Partial<Omit<EvidenceDeskResultV2, "items">> = {}) =>
  ({ items, truncated: false, receipt_digests: [canonicalSha256({ desk: items.map(item => item.id) })], ...extra });

export type Scenario = {
  readonly question: string;
  readonly desk: () => EvidenceDeskPortV1 | EvidenceDeskPortV2;
  readonly replies: readonly unknown[];
  readonly asker?: string;
};

/** A sentence as the writer gives it: its text and the ids it cites. */
type Said = { readonly text: string; readonly evidence: readonly string[] };
/**
 * The Ask writer's reply (answer layout v2, ADR-0051) that says `sentences`: the first as its answer block, any others as
 * one text block after it, so the answer states them in the order given. Each list it uses ({ id, where?, members? })
 * is a list block (ADR-0054) right after the answer, where code stated a list before; beside them, what it did not find,
 * and for an Ask again what is different since (ADR-0047).
 */
export function writerReply(sentences: readonly Said[], fields: { readonly lists?: readonly unknown[]; readonly not_found?: readonly string[]; readonly since?: unknown } = {}) {
  const placed = (fields.lists ?? []).map(use => {
    const { id, ...narrowing } = use as { readonly id: unknown; readonly where?: unknown; readonly members?: unknown };
    return { block: "list", list: id, ...narrowing };
  });
  return {
    blocks: [...(sentences.length === 0 ? [] : [{ block: "answer", sentences: sentences.slice(0, 1) }]), ...placed, ...(sentences.length < 2 ? [] : [{ block: "text", sentences: sentences.slice(1) }])],
    not_found: fields.not_found ?? [],
    ...(fields.since === undefined ? {} : { since: fields.since }),
  };
}

export const need = (text: string, status: string, evidence: readonly string[] = []) => ({ need: text, status, evidence });
export const part = (question: string, needs: readonly ReturnType<typeof need>[], notes = "") => ({ question, needs, notes });
export const step = (parts: readonly ReturnType<typeof part>[], actions: readonly { tool: string; args: Record<string, string> }[]) => ({ parts, actions });

/** Ask scenarios the diagnostics and release tests replay end to end. */
export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  finish_after_search_and_open: {
    question: "When does DVT start?", asker: "Zhen Ye",
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
      writerReply([{ text: "DVT starts October 12, after the fixture arrives.", evidence: ["E1"] }]),
    ],
  },
  writer_fallback_to_records: {
    question: "What did the review decide about calibration?",
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
  live_ticket_and_page: {
    question: "Why is the DVT gate on hold?",
    desk: () => {
      const listedTicket = ticket("THERM-46", undefined, "In Progress");
      const openTicket = ticket("THERM-46", "THERM-46: BUG-412 observed 39.0 °C versus 37.2 °C expected under load.", "In Progress");
      const listedPage = page("1441793", undefined);
      const openPage = page("1441793", "DVT review: HOLD until TC-D-03 and BUG-412 are resolved.");
      const desk: EvidenceDeskPortV2 = {
        scope: { kind: "global" },
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
      writerReply([{ text: "DVT is on hold until TC-D-03 and BUG-412 are resolved; BUG-412 observed 39.0 °C versus 37.2 °C under load.", evidence: ["E3", "E4"] }]),
    ],
  },
};

/** A model call's input as tests compare it: the gate's per-call progress callback is left out. */
export function recorded(input: StructuredGenerationInput): StructuredGenerationInput {
  const { on_progress: _progress, ...rest } = input;
  return rest;
}

/** A desk item as an earlier answer cited it, for a previous turn (ADR-0047). */
export const cited = (item: EvidenceDeskItemV2, kind: PersonAnswerCitationV8["kind"]): PersonAnswerCitationV8 => ({
  citation: item.citation as PersonAnswerCitationV8["citation"], kind, label: item.label, visibility: item.visibility,
  ...(item.citation.kind === "approved_record" ? { ref: `meeting:${item.citation.record_sha256}` as const } : {}),
});
/** Replies by role: the resolver's (either prompt), research steps', and the writer's, each in order; an unscripted call fails the Ask. */
export function scripted(script: { readonly resolver?: readonly unknown[]; readonly steps?: readonly unknown[]; readonly writer?: readonly unknown[] }) {
  const inputs: StructuredGenerationInput[] = [];
  const queue = { resolver: [...(script.resolver ?? [])], step: [...(script.steps ?? [])], writer: [...(script.writer ?? [])] };
  const roleOf = (input: StructuredGenerationInput) => input.system_prompt.startsWith(THREAD_RESOLVER_PROMPT) || input.system_prompt === FOLLOW_UP_RESOLVER_PROMPT ? "resolver" as const
    : input.system_prompt.startsWith(ANSWER_PROMPT) ? "writer" as const : "step" as const;
  return {
    inputs, of: (role: "resolver" | "step" | "writer") => inputs.filter(input => roleOf(input) === role),
    model: { generate: async (input: StructuredGenerationInput) => {
      inputs.push(recorded(input));
      const reply = queue[roleOf(input)].shift();
      if (reply === undefined) throw new Error(`unscripted ${roleOf(input)} call`);
      if (typeof reply === "function") return (reply as () => unknown)();
      return reply;
    } },
  };
}
export const finishOn = (question: string, evidence: readonly string[]) => ({ parts: [{ question, notes: "", needs: [{ need: "what the question asks", status: "found", evidence }] }], actions: [{ tool: "finish", args: {} }] });
export const searchFor = (question: string, query: string) => ({ parts: [{ question, notes: "", needs: [{ need: "what the question asks", status: "open", evidence: [] }] }], actions: [{ tool: "search", args: { query } }] });
/** A run under the request's observer: the corrections every span of it counted, summed. */
export async function observed<T>(operation: () => Promise<T>): Promise<{ readonly value: T; readonly corrections: Readonly<Record<string, number>> }> {
  const events: CoreRuntimeObservationV1[] = [];
  const value = await observeCoreRuntimeV1("research_run", operation, { observer: event => { events.push(event); } });
  const corrections: Record<string, number> = {};
  for (const event of events) if (event.event !== "started") for (const [name, count] of Object.entries(event.model_corrections ?? {})) corrections[name] = (corrections[name] ?? 0) + count;
  return { value, corrections };
}

/** Replays one scenario through Ask, the V8 core: scripted replies in order, and a clock that stands still. */
export async function replay(name: string, scenario: Scenario, hooks: { readonly signal?: AbortSignal; readonly on_append?: (entry: AgenticAskAuditEntryV1) => void } = {}) {
  const inputs: StructuredGenerationInput[] = [];
  const audit: AgenticAskAuditEntryV1[] = [];
  let offset = 0;
  const model = {
    generate: async (input: StructuredGenerationInput) => {
      inputs.push(recorded(input));
      const reply = scenario.replies[offset++];
      if (reply === undefined) throw new Error(`${name}: unscripted model call ${offset}`);
      return reply;
    },
  };
  const options = {
    desk: scenario.desk(), model, generation, audit: { append: (entry: AgenticAskAuditEntryV1) => { audit.push(entry); hooks.on_append?.(entry); } },
    now_ms: () => 0, today: () => "2026-10-06", wall_ms,
    ...(scenario.asker === undefined ? {} : { asker: { display_name: scenario.asker } }),
  };
  const input = { question: scenario.question, ...(hooks.signal === undefined ? {} : { signal: hooks.signal }) };
  const response = await createAgenticAskV5(options as Parameters<typeof createAgenticAskV5>[0]).answer(input);
  return { response, inputs, audit };
}

/**
 * A research core over a project-scoped desk with empty defaults: scripted model replies in order, and every audit record kept.
 * With `usage`, the model also reports each call's token usage (call numbers start at 1).
 */
export function researchHarness(replies: readonly unknown[] | ((input: StructuredGenerationInput, index: number) => unknown), desk: Partial<EvidenceDeskPortV2> = {}, core: {
  readonly now_ms?: () => number; readonly usage?: (call: number) => StructuredGenerationUsageV1; readonly wall_ms?: () => number;
} = {}) {
  const inputs: StructuredGenerationInput[] = [];
  const audit: AgenticAskAuditEntryV1[] = [];
  const generate = vi.fn(async (input: StructuredGenerationInput) => {
    inputs.push(recorded(input));
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
  const research = createAgenticResearchV1({ desk: port, model, generation, audit: { append: entry => { audit.push(entry); } }, today: () => "2026-10-06", wall_ms, ...options });
  return { research, port, inputs, audit, generate, prompt: (index: number) => JSON.parse(inputs[index]!.user_prompt) as Record<string, unknown> };
}

/** A bundle with nothing gathered: renderer tests lay their items, plan and coverage over it. */
export const EMPTY_BUNDLE: AgenticEvidenceBundleV1 = {
  schema_version: 1, kind: "echo-agentic-evidence-bundle-v1", trigger: "ask", goal: { kind: "question", question: "What was decided?" }, budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1,
  plan: [], items: [], unreadable_starting: [], rounds: [], coverage: { reads: [], inventories: [], notices: [] }, stop: { reason: "finished", completed: true },
  cost: { rounds: 1, model_calls: 1, repairs: 0, fallbacks: 0, input_tokens: null, output_tokens: null, total_tokens: null, model_ms: 0, desk_ms: 0, elapsed_ms: 0 },
  gathered_for: { scope: { kind: "global" }, checked_at: null }, server: { receipts: [], invocation_digests: [], generations: [] },
};

/** A renderer's gate: scripted replies in order (an Error is thrown, as the provider's failure) and no desk; every access check and model call lands in `trace`. */
export function scriptedGate(replies: readonly unknown[], trace: string[]) {
  const inputs: StructuredGenerationInput[] = [];
  const gate = createAgenticModelGateV1({
    generation,
    model: {
      generate: async (input: StructuredGenerationInput) => {
        trace.push("generate"); inputs.push(recorded(input));
        const reply = replies[inputs.length - 1];
        if (reply === undefined) throw new Error(`unscripted call ${inputs.length}`);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
    desk_revalidate: async () => { trace.push("revalidate"); return checked; }, on_checked: () => undefined,
    now: () => 0, signal: new AbortController().signal,
  });
  return { gate, inputs };
}
