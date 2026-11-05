/**
 * What the Ask writer evaluations (ask-wording and ask-blocks) share about running their synthetic cases: each item as
 * the desk releases it, and Ask over a case's desk as the kernel runs it, research scripted and every writer call passed
 * to the evaluation's own writer. What their graders share is in grading.mjs.
 */
import { createHash } from "node:crypto";
import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { validatePersonFollowUpEvidenceV1 } from "@echo-brain/organization-api";
import { createAgenticAskV5 } from "@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1";
import { FOLLOW_UPS_SOURCE_DESCRIPTOR_V1, followUpDeskFieldsV1 } from "@echo-brain/organization-authority-kernel/shared/follow-up-evidence-v1";

const RESEARCH_PROMPT = "You are Echo's research agent";
const WRITER_PROMPT = "You write Echo's final answer";
/** A connected Jira as the desk advertises it, so the writer is told what it is told for a person with Jira connected. */
const TICKETS_SOURCE = Object.freeze({
  source_id: "jira", kind: "ticket", selector: "tickets", description: "Jira issues the asker can read through their own connection.", metadata_only_list: true, tool_id: "jira",
});

// ---- the desk ------------------------------------------------------------------------------------------------------
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fields = (item, names) => Object.fromEntries(names.filter((name) => Object.hasOwn(item, name)).map((name) => [name, item[name]]));

/**
 * One case item as the desk releases it, its ids and fixtures named for the evaluation `fixture`: a follow-up through the
 * product's own projection, an approved decision record, or a Jira issue the asker reads through their own connection,
 * with its priority when it has one, created on its `created` day (2026-10-19 without one). Every value is synthetic.
 */
export function deskItem(fixture, caseId, index, item) {
  const key = `${caseId}:${index}`;
  const id = `${fixture}-${digest(key).slice(0, 24)}`;
  const receipt_sha256 = canonicalSha256({ fixture: `ask-${fixture}-release`, key });
  if (item.kind === "follow_up") {
    const evidence = validatePersonFollowUpEvidenceV1({
      item_id: `itm_${digest(key).slice(0, 24)}`, kind: item.on, title: item.title, owner: item.owner, status: item.status,
      ...fields(item, ["created_at", "sent_at", "reassigned_at", "due_at", "check", "expected"]),
      ...(item.decision === undefined ? {} : { decision: { ...item.decision, ref: `meeting:${canonicalSha256({ fixture: `ask-${fixture}-decision`, key })}` } }),
    });
    return Object.freeze({ id, ...followUpDeskFieldsV1(evidence), visibility: "team", receipt_sha256 });
  }
  if (item.kind === "decision") {
    return Object.freeze({
      id, kind: "decision", label: item.label, text: item.text, visibility: "team", occurred_at: item.occurred_at, receipt_sha256,
      citation: Object.freeze({ kind: "approved_record", atom_id: canonicalSha256({ fixture: `ask-${fixture}-atom`, key }), record_sha256: canonicalSha256({ fixture: `ask-${fixture}-record`, key }), policy_id: "project-members-readable-person-v1" }),
    });
  }
  return Object.freeze({
    id, kind: "ticket", label: `${item.key}: ${item.title}`, text: item.text, visibility: "only_me",
    attributes: Object.freeze({ status: item.status, owner: item.owner, ...(item.priority === undefined ? {} : { priority: item.priority }) }),
    occurred_at: item.created ?? "2026-10-19", date_kind: "created", receipt_sha256,
    citation: Object.freeze({ kind: "ticket", tool_id: "jira", external_scope_id: "synthetic-cloud", ticket_id: item.key.replace(/\D/gu, ""), permalink: `https://synthetic.example.test/browse/${item.key}`, text_sha256: sha256Digest(item.text) }),
  });
}

/** One case's items as the desk releases them (deskItem), in the case's order: the order search finds them and research opens them. */
export const caseItems = (fixture, caseDefinition) => caseDefinition.items.map((item, index) => deskItem(fixture, caseDefinition.id, index, item));

/** A desk over `items`, in a global Ask with Jira and follow-ups bound, checked at `askedAt`: any search finds them all, in order. */
function caseDesk(items, askedAt) {
  const result = (values) => Object.freeze({ items: Object.freeze(values), truncated: false, receipt_digests: Object.freeze(values.map((value) => value.receipt_sha256)) });
  return Object.freeze({
    scope: Object.freeze({ kind: "global" }),
    live_sources: Object.freeze([TICKETS_SOURCE, FOLLOW_UPS_SOURCE_DESCRIPTOR_V1]),
    async search() { return result(items); },
    async open(input) { return result(items.filter((item) => item.id === input.item)); },
    async list() { return result([]); },
    async revalidate() { return Object.freeze({ checked_at: askedAt }); },
  });
}

// ---- Ask -----------------------------------------------------------------------------------------------------------
/**
 * The scripted research step for `round` (from 1): search, then open every item found (E1 to En, in the desk's order),
 * then finish with the one need found on all of them. A later round finishes again.
 */
export function researchStep(caseDefinition, round) {
  const ids = Array.from({ length: caseDefinition.items.length }, (_, index) => `E${index + 1}`);
  const need = (status) => ({ ...(round === 1 ? {} : { id: "N1" }), need: caseDefinition.research.need, kind: "content", status, evidence: status === "found" ? ids : [] });
  const part = (status, notes) => [{ question: caseDefinition.question, needs: [need(status)], notes }];
  if (round === 1) return { parts: part("open", ""), actions: [{ tool: "search", args: { query: caseDefinition.research.query } }] };
  if (round === 2) return { parts: part("open", `${ids.join(", ")} match.`), actions: ids.map((id) => ({ tool: "open", args: { id } })) };
  return { parts: part("found", `${ids.join(", ")} read in full.`), actions: [{ tool: "finish", args: {} }] };
}

/**
 * The model one case's Ask is given: research answered from the script (researchStep), each writer call answered by
 * `writer(input)`, and any other call refused with the error `refusal`. `rounds()` is how many research steps it gave.
 */
export function scriptedModel(caseDefinition, writer, refusal) {
  let round = 0;
  const model = Object.freeze({
    async generate(input) { return (await this.generate_with_observation(input)).value; },
    async generate_with_observation(input) {
      if (input.system_prompt.startsWith(RESEARCH_PROMPT)) {
        round += 1;
        return { value: researchStep(caseDefinition, round), finish_reason: "stop", usage: null, provider_latency_ms: null };
      }
      if (!input.system_prompt.startsWith(WRITER_PROMPT)) throw new Error(refusal);
      return writer(input);
    },
  });
  return Object.freeze({ model, rounds: () => round });
}

/**
 * Ask over a desk of `items` (caseItems), as the kernel runs it: asked at `askedAt` by the cases document's asker, in its
 * time zone and on its today, with `model`.
 */
export function caseAsk(items, document, askedAt, model, generation) {
  return createAgenticAskV5({
    desk: caseDesk(items, askedAt), model, generation, audit: { append: () => undefined },
    asker: { display_name: document.asker }, time_context: { now: askedAt, time_zone: document.time_zone },
    today: () => document.today, wall_ms: () => Date.parse(askedAt),
  });
}
