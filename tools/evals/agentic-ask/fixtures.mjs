import { createHash } from "node:crypto";
import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";

/**
 * Synthetic evidence only. Item ids are request-local opaque handles; the
 * evaluator records counts and source names rather than persisting handles or
 * model input/output.
 */
const hash = (value) => createHash("sha256").update(value).digest("hex");

function approvedCitation(id) {
  return Object.freeze({
    kind: "approved_record",
    atom_id: canonicalSha256({ fixture: "agentic-ask", id }),
    record_sha256: canonicalSha256({ fixture: "agentic-ask-record", id }),
    policy_id: "organization-member-readable-person-v2",
  });
}

function meeting(input) {
  const { id, label, text } = input;
  const occurredAt = Object.hasOwn(input, "occurredAt") ? input.occurredAt : "2026-10-04";
  return Object.freeze({
    id: `synthetic-handle-${hash(`meeting:${id}`).slice(0, 24)}`,
    kind: "decision",
    citation: approvedCitation(id),
    label,
    text,
    visibility: "team",
    ...(occurredAt === undefined ? {} : { occurred_at: occurredAt }),
    receipt_sha256: canonicalSha256({ fixture: "meeting-release", id, text }),
  });
}

function ticket({ id, key, toolId, label, text, status = "In progress" }) {
  return Object.freeze({
    id: `synthetic-handle-${hash(`ticket:${toolId}:${id}`).slice(0, 24)}`,
    kind: "ticket",
    citation: Object.freeze({
      kind: "ticket",
      tool_id: toolId,
      external_scope_id: "synthetic-workspace",
      ticket_id: id,
      permalink: `https://synthetic.example.test/browse/${key}`,
      text_sha256: sha256Digest(text ?? ""),
    }),
    label,
    ...(text === undefined ? {} : { text }),
    visibility: "team",
    attributes: Object.freeze({ status }),
    occurred_at: "2026-10-04",
    receipt_sha256: canonicalSha256({ fixture: "ticket-release", toolId, id, text: text ?? "" }),
  });
}

function metadata(item) {
  const { text: _text, ...listed } = item;
  return Object.freeze({
    ...listed,
    citation: item.kind === "ticket"
      ? Object.freeze({ ...item.citation, text_sha256: sha256Digest("") })
      : item.citation,
  });
}

const approvedCanary = meeting({
  id: "approved-canary",
  label: "Synthetic approval review",
  text: "The approved review decided that the synthetic launch canary may proceed after a cited Ask check.",
});

const jiraTicket = ticket({
  id: "jira-17",
  key: "ECHO-17",
  toolId: "jira",
  label: "ECHO-17: Pilot Delta launch gate",
  text: "ECHO-17 is In progress. The current work item reports that the Pilot Delta launch gate is waiting for the fixture verification.",
});

const linearTicket = ticket({
  id: "linear-17",
  key: "PM-17",
  toolId: "linear",
  label: "PM-17: Pilot Delta launch gate",
  text: "PM-17 is In progress. The current work item reports that the Pilot Delta launch gate is waiting for the fixture verification.",
});

const mixedMeeting = meeting({
  id: "pilot-delta-decision",
  label: "Pilot Delta review",
  text: "The approved Pilot Delta review decided to hold the launch gate until fixture verification is complete.",
});

const unavailableMeeting = meeting({
  id: "unavailable-ticket-meeting",
  label: "Pilot Delta review",
  text: "The approved Pilot Delta review decided that a current work-item update is needed before the launch gate can be assessed.",
});

const longIdentifierRelease = "clean-v1-20990101-ask-sources-f1c7e2d";
const longIdentifierDecision = meeting({
  id: "long-identifier-release-decision",
  label: `${longIdentifierRelease} approval review`,
  text: `The approved review decided that synthetic release ${longIdentifierRelease} may proceed after its cited Ask check.`,
});

const decisionWithoutDateOrOwner = meeting({
  id: "decision-without-date-or-owner",
  label: "Synthetic launch-gate review",
  text: "The approved review decided that the synthetic launch gate may proceed after fixture verification.",
  occurredAt: undefined,
});

const proposedPrerequisiteDecision = meeting({
  id: "proposed-prerequisite-decision",
  label: "Synthetic pilot prerequisite review",
  text: "The approved review recorded a proposal to begin the synthetic pilot after fixture verification and Manufacturing approval. The proposal is not yet an approved launch decision, and neither prerequisite is recorded as complete.",
});

const laterTickets = Array.from({ length: 52 }, (_, index) => {
  const number = index + 1;
  const isTarget = number === 52;
  return ticket({
    id: `later-${number}`,
    key: `PLAN-${number}`,
    toolId: "issue-tracker",
    label: isTarget ? "PLAN-52: Fixture verification remains" : `PLAN-${number}: Background work item`,
    text: isTarget
      ? "PLAN-52 reports that fixture verification remains the only open launch-gate task."
      : `PLAN-${number} is a synthetic background work item unrelated to the launch gate.`,
    status: isTarget ? "In progress" : "Done",
  });
});

/**
 * A case names observable requirements, not a prescribed model action path.
 * The branded ticket cases intentionally share data shape and expectations.
 */
export const CASES = Object.freeze([
  Object.freeze({
    id: "approved-meeting",
    question: "What did the synthetic approval review decide about the launch canary?",
    mode: "v1",
    items: Object.freeze([approvedCanary]),
    expected: Object.freeze({ sources: Object.freeze(["meeting"]), complete: true, discovery: true, open: true }),
  }),
  Object.freeze({
    id: "ticket-jira-label",
    question: "What does ECHO-17 report about the Pilot Delta launch gate?",
    mode: "v2",
    items: Object.freeze([jiraTicket]),
    ticket_available: true,
    expected: Object.freeze({ sources: Object.freeze(["ticket"]), complete: true, discovery: true, open: true }),
  }),
  Object.freeze({
    id: "ticket-linear-label",
    question: "What does PM-17 report about the Pilot Delta launch gate?",
    mode: "v2",
    items: Object.freeze([linearTicket]),
    ticket_available: true,
    expected: Object.freeze({ sources: Object.freeze(["ticket"]), complete: true, discovery: true, open: true }),
  }),
  Object.freeze({
    id: "mixed-meeting-and-ticket",
    question: "For Pilot Delta, what did the approved review decide and what does the current work item report?",
    mode: "v2",
    items: Object.freeze([mixedMeeting, jiraTicket]),
    ticket_available: true,
    expected: Object.freeze({ sources: Object.freeze(["meeting", "ticket"]), complete: true, discovery: true, open: true }),
  }),
  Object.freeze({
    id: "ticket-context-unavailable",
    question: "For Pilot Delta, what did the approved review decide and what does the current work item report?",
    mode: "v2",
    items: Object.freeze([unavailableMeeting]),
    ticket_available: false,
    expected: Object.freeze({ sources: Object.freeze(["meeting"]), complete: false, discovery: true, open: true }),
  }),
  Object.freeze({
    id: "empty-source",
    question: "What is the status of the synthetic launch gate?",
    mode: "v2",
    items: Object.freeze([]),
    ticket_available: true,
    ticket_tool_id: "synthetic-tracker",
    expected: Object.freeze({ sources: Object.freeze([]), complete: false, discovery: true, open: false, empty: true }),
  }),
  Object.freeze({
    id: "later-page-discovery",
    question: "What work remains for the staged program launch gate?",
    mode: "v2",
    items: Object.freeze(laterTickets),
    ticket_available: true,
    search_empty: true,
    expected: Object.freeze({ sources: Object.freeze(["ticket"]), complete: true, discovery: true, open: true, later_page: true }),
  }),
  Object.freeze({
    id: "held-out-long-release-decision",
    question: `What did we decide for synthetic staging release ${longIdentifierRelease}?`,
    mode: "v1",
    items: Object.freeze([longIdentifierDecision]),
    expected: Object.freeze({
      sources: Object.freeze(["meeting"]), complete: true, discovery: true, open: true,
      reader_visible: Object.freeze({ required_any: Object.freeze([Object.freeze(["may proceed", "approved", "proceed"])]), no_gap: true }),
    }),
  }),
  Object.freeze({
    id: "held-out-proposed-prerequisites",
    question: "What is required before the synthetic pilot can begin?",
    mode: "v1",
    items: Object.freeze([proposedPrerequisiteDecision]),
    expected: Object.freeze({
      sources: Object.freeze(["meeting"]), complete: true, discovery: true, open: true,
      reader_visible: Object.freeze({
        // Ground truth: this record describes an unapproved proposal, with two
        // explicit prerequisites. Both distinctions must remain reader-visible.
        required_any: Object.freeze([
          Object.freeze(["fixture verification"]),
          Object.freeze(["manufacturing approval", "manufacturing"]),
          Object.freeze(["proposal", "proposed", "not yet approved"]),
        ]),
        no_gap: true,
      }),
    }),
  }),
  Object.freeze({
    id: "held-out-multipart-missing-date-owner",
    question: "What did the synthetic launch-gate review decide, what date was approved, and who owns it?",
    mode: "v1",
    items: Object.freeze([decisionWithoutDateOrOwner]),
    expected: Object.freeze({
      sources: Object.freeze(["meeting"]), complete: false, discovery: true, open: true,
      reader_visible: Object.freeze({
        required_any: Object.freeze([Object.freeze(["may proceed", "approved", "proceed"])]),
        required_gap_any: Object.freeze([
          Object.freeze(["date", "approved date", "when"]),
          Object.freeze(["owner", "who owns", "responsible"]),
        ]),
        forbidden_gap_terms: Object.freeze(["rationale", "context", "slack", "ticket"]),
        outcome: "partial",
      }),
    }),
  }),
]);

export function fixtureSha256() {
  return `sha256:${hash(JSON.stringify(CASES))}`;
}

function sourceFor(item) {
  return item.kind === "ticket" ? "ticket" : "meeting";
}

function selectedSource(kinds) {
  if (!Array.isArray(kinds) || kinds.length === 0) return "all";
  if (kinds.every((kind) => kind === "ticket")) return "ticket";
  if (kinds.every((kind) => ["decision", "action", "rationale"].includes(kind))) return "meeting";
  if (kinds.every((kind) => ["note", "document_passage"].includes(kind))) return "document";
  if (kinds.every((kind) => kind === "slack_message")) return "slack";
  return "all";
}

function matches(item, query) {
  const normalized = String(query ?? "").toLocaleLowerCase();
  const terms = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}-]{1,}/gu) ?? [];
  const haystack = `${item.label}\n${item.text ?? ""}`.toLocaleLowerCase();
  return terms.some((term) => haystack.includes(term));
}

/** A V1/V2 evidence desk with synthetic records and non-sensitive trace data. */
export function createFixtureDesk(caseDefinition) {
  const items = caseDefinition.items;
  const handles = new Map(items.map((item, index) => [item.id, index]));
  const discovered = new Set();
  const trace = [];
  const release = (values, { truncated = false } = {}) => ({
    items: values,
    truncated,
    receipt_digests: values.map((item) => item.receipt_sha256),
  });
  const traceDiscovery = (tool, source, values, extra = {}) => {
    for (const item of values) discovered.add(item.id);
    trace.push(Object.freeze({ tool, source, result_count: values.length, discovered_count: discovered.size, ...extra }));
  };
  const toMetadata = (values) => values.map(metadata);
  const ticketToolId = items.find((item) => item.kind === "ticket")?.citation.tool_id ?? caseDefinition.ticket_tool_id;
  const liveSources = caseDefinition.mode === "v2" && caseDefinition.ticket_available !== false && ticketToolId !== undefined
    ? [{ source: "ticket", tool_id: ticketToolId }]
    : [];
  return Object.freeze({
    desk: Object.freeze({
      scope: Object.freeze({ kind: "global" }),
      ticket_available: caseDefinition.ticket_available,
      live_sources: Object.freeze(liveSources),
      async search(input) {
        const source = selectedSource(input.kinds);
        const kinds = input.kinds === undefined ? undefined : new Set(input.kinds);
        const candidates = caseDefinition.search_empty ? [] : items.filter((item) =>
          (kinds === undefined || kinds.has(item.kind)) && matches(item, input.query),
        );
        const limit = input.limit ?? 8;
        const result = toMetadata(candidates.slice(0, limit));
        traceDiscovery("search", source, result, { result_count: result.length });
        return release(result, { truncated: candidates.length > limit });
      },
      async list(input) {
        const source = input.source;
        const selected = items.filter((item) => sourceFor(item) === source);
        const limit = input.limit ?? 50;
        const cursorMatch = typeof input.cursor === "string" ? /^synthetic-page:(\d+)$/u.exec(input.cursor) : null;
        const offset = cursorMatch === null ? 0 : Number(cursorMatch[1]);
        const values = toMetadata(selected.slice(offset, offset + limit));
        traceDiscovery("list", source, values, { page: Math.floor(offset / limit) + 1, more: offset + values.length < selected.length });
        return Object.freeze({
          ...release(values),
          ...(offset + values.length < selected.length ? { next_cursor: `synthetic-page:${offset + values.length}` } : {}),
        });
      },
      async open(input) {
        const index = handles.get(input.item);
        const item = index === undefined ? undefined : items[index];
        const known_before_open = item !== undefined && discovered.has(item.id);
        trace.push(Object.freeze({ tool: "open", source: item === undefined ? "unknown" : sourceFor(item), known_before_open, result_count: item === undefined ? 0 : 1 }));
        return release(item === undefined ? [] : [item]);
      },
      async revalidate() {
        return Object.freeze({ checked_at: "2026-10-04T00:00:00.000Z" });
      },
    }),
    trace,
  });
}

export function sourceForCitation(citation) {
  return citation.kind === "ticket" ? "ticket" : citation.kind === "slack_message" ? "slack" : "meeting";
}
