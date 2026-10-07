import {
  validatePersonEvidenceOpenRequestV1,
  validatePersonPageCitationV1,
  validatePersonQueryText,
  validatePersonTicketCitationV1,
} from "@echo-brain/organization-api";
import { AuthorityOperationError } from "../domain/errors.js";
import { agenticStartingSlotV1, type AgenticBriefV1 } from "./agentic-brief-v1.js";
import type { AgenticRendererV1 } from "./agentic-renderer-v1.js";
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, AGENTIC_RESEARCH_LIVE_BUDGET_V1 } from "./agentic-research-v1.js";

/**
 * Trigger definitions (research trigger contract v1, section 1). Adding a
 * trigger is one definition here (plus a renderer, or none for research-only
 * use) and its evaluation cases. The audit's and the staging API's lists of
 * allowed triggers come from this list; the loop never sees it.
 */
export interface AgenticTriggerDefinitionV1<Event, In = unknown> {
  /** A label for audit and evaluation; nothing branches on it. */
  readonly name: string;
  /** The trigger's event from its input, or an `invalid_request` error. */
  parseEvent(input: unknown): Event;
  /**
   * The event's brief. A task names its starting items by slot
   * (`agenticStartingSlotV1`) because their ids exist only once the loop has
   * read them; the loop fills them in.
   */
  brief(event: Event): AgenticBriefV1;
  /** The budget profile its brief runs on. */
  readonly budget: "live" | "background";
  /** Turns the bundle into the trigger's result. Ask's writer is composed by the runner, which holds its prompts and response version. */
  readonly renderer?: AgenticRendererV1<In, unknown>;
  /** Whose access the run uses. */
  readonly acts_as: "requester" | "approver";
  /** Who may receive the result: in this round only the person the run acted as. */
  readonly recipients: "actor_only";
}

const MAX_FINDINGS = 20;
const MAX_FINDING_CITATIONS = 12;

function invalid(message: string): never {
  throw new AuthorityOperationError("invalid_request", message);
}
/** A plain object with exactly these fields. */
function fields(input: unknown, keys: readonly string[], label: string): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) invalid(`${label} input must be an object`);
  const present = Object.keys(input);
  if (present.length !== keys.length || !keys.every(key => present.includes(key))) invalid(`${label} input must have exactly ${keys.join(", ")}`);
  return input as Readonly<Record<string, unknown>>;
}
/** One trimmed line of text, as the request gave it. */
function line(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim() || value !== value.normalize("NFC") ||
      Buffer.byteLength(value, "utf8") > 1_000 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) invalid(`${label} must be one line of text`);
  return value;
}
/** A citation released by an earlier request: a ticket, a page, or an ECHO record or document. */
function citation(value: unknown, label: string): unknown {
  try {
    const kind = typeof value === "object" && value !== null ? (value as { readonly kind?: unknown }).kind : undefined;
    if (kind === "ticket") return validatePersonTicketCitationV1(value);
    if (kind === "page") return validatePersonPageCitationV1(value);
    return validatePersonEvidenceOpenRequestV1({ schema_version: 1, citation: value }).citation;
  } catch { return invalid(`${label} is not a citation`); }
}

interface AskEventV1 { readonly question: string }
interface CheckEventV1 { readonly record: unknown }
interface SweepEventV1 { readonly findings: readonly { readonly finding: string; readonly expected: string; readonly citations: readonly unknown[] }[] }

const ask: AgenticTriggerDefinitionV1<AskEventV1> = Object.freeze({
  name: "ask", budget: "live", acts_as: "requester", recipients: "actor_only",
  parseEvent(input: unknown): AskEventV1 {
    const event = fields(input, ["question"], "Ask");
    // The product's question limits, so the evaluation sees what people see.
    try { return Object.freeze({ question: validatePersonQueryText(event.question) }); }
    catch (error) { return invalid(error instanceof Error ? error.message : "Ask question is invalid"); }
  },
  brief: (event: AskEventV1): AgenticBriefV1 => ({
    goal: { kind: "question", question: event.question }, starting: [], budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1, options: { small_scope_preload: true },
  }),
});

/** Check: research starts from an approved record, not a person's question (research loop evaluation v1). */
const CHECK_TASK = [
  `An approved record is already read: ${agenticStartingSlotV1(1)}. Split it into its decisions, requirements and actions, one part each. For each, find what in the project agrees with it, conflicts with it, or must change: other approved decisions, tickets, pages and documents. For each, find the owner and any date it puts at risk against a stated milestone.`,
  "Record what each source says with its ids and dates. Do not decide whether a conflict is acceptable.",
].join("\n");

const check: AgenticTriggerDefinitionV1<CheckEventV1> = Object.freeze({
  name: "check", budget: "background", acts_as: "requester", recipients: "actor_only",
  parseEvent(input: unknown): CheckEventV1 {
    const record = citation(fields(input, ["record"], "Check").record, "Check record");
    if ((record as { readonly kind: unknown }).kind !== "approved_record") invalid("A Check starts from an approved record citation");
    return Object.freeze({ record });
  },
  // The record is the whole point: research never runs without it.
  brief: (event: CheckEventV1): AgenticBriefV1 => ({
    goal: { kind: "task", task: CHECK_TASK }, starting: [{ citation: event.record, if_unreadable: "fail" }],
    budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, options: { small_scope_preload: false },
  }),
});

/** Sweep: research rechecks earlier findings against current evidence. */
const SWEEP_TASK = [
  "Recheck the earlier findings below. Each says what was expected to change and lists the items cited then, already re-read now. Make each finding one part. Re-read the current items and find their current state, and any newer item about the same change.",
  "Never treat a finding as resolved without reading the current item. An item that could not be read is not evidence that anything changed.",
  "Findings:",
].join("\n");

const sweep: AgenticTriggerDefinitionV1<SweepEventV1> = Object.freeze({
  name: "sweep", budget: "background", acts_as: "requester", recipients: "actor_only",
  parseEvent(input: unknown): SweepEventV1 {
    const findings = fields(input, ["findings"], "Sweep").findings;
    if (!Array.isArray(findings) || findings.length === 0 || findings.length > MAX_FINDINGS) invalid(`Sweep needs 1 to ${MAX_FINDINGS} findings`);
    return Object.freeze({ findings: Object.freeze(findings.map((raw: unknown, index: number) => {
      const finding = fields(raw, ["finding", "expected", "citations"], `Sweep finding ${index + 1}`);
      if (!Array.isArray(finding.citations) || finding.citations.length === 0 || finding.citations.length > MAX_FINDING_CITATIONS) invalid(`Sweep finding ${index + 1} needs 1 to ${MAX_FINDING_CITATIONS} citations`);
      return Object.freeze({
        finding: line(finding.finding, `Sweep finding ${index + 1}`), expected: line(finding.expected, `Sweep finding ${index + 1} expectation`),
        citations: Object.freeze(finding.citations.map((value: unknown) => citation(value, `Sweep finding ${index + 1} citation`))),
      });
    })) });
  },
  // A deleted or now-hidden item is news, so an unreadable one is reported, not fatal. Each cited item is read once.
  brief: (event: SweepEventV1): AgenticBriefV1 => {
    const starting: unknown[] = [];
    const positions = new Map<string, number>();
    const slot = (value: unknown): string => {
      const key = JSON.stringify(value);
      if (!positions.has(key)) { starting.push(value); positions.set(key, starting.length); }
      return agenticStartingSlotV1(positions.get(key)!);
    };
    const lines = event.findings.map((finding, index) =>
      `${index + 1}. ${JSON.stringify(finding.finding)} Expected: ${JSON.stringify(finding.expected)}. Cited then: ${finding.citations.map(slot).join(", ")}.`);
    return {
      goal: { kind: "task", task: [SWEEP_TASK, ...lines].join("\n") }, starting: starting.map(value => ({ citation: value, if_unreadable: "report" })),
      budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, options: { small_scope_preload: false },
    };
  },
});

export const AGENTIC_TRIGGER_DEFINITIONS_V1: readonly AgenticTriggerDefinitionV1<unknown>[] = Object.freeze([ask, check, sweep]);

/** The triggers an audit record may name: every definition but Ask, whose audit records carry no trigger. */
export const AGENTIC_TRIGGER_NAMES_V1: readonly string[] = Object.freeze(AGENTIC_TRIGGER_DEFINITIONS_V1.filter(definition => definition !== ask).map(definition => definition.name));
