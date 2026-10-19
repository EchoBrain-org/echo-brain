import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { validatePersonFollowUpEvidenceV1 } from "@echo-brain/organization-api";
import { vi } from "vitest";
import type { EvidenceDeskItemV2, EvidenceDeskListInputV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from "../../../src/shared/evidence-desk-v2.js";
import { followUpDeskFieldsV1 } from "../../../src/shared/follow-up-evidence-v1.js";
import { result } from "./agentic-scenarios.js";

/**
 * Shared fixtures for Ask's lists (ADR-0041): the October 4 pages the held release listed (trace ee2f0973), Jira
 * ticket rows and bodies, ECHO follow-ups, and a paged list port.
 */
export const CONFLUENCE: NonNullable<EvidenceDeskPortV2["live_sources"]>[number] = { source_id: "confluence", kind: "page", selector: "pages", description: "Live knowledge pages.", metadata_only_list: true, tool_id: "confluence" };
export const JIRA: NonNullable<EvidenceDeskPortV2["live_sources"]>[number] = { source_id: "jira", kind: "ticket", selector: "tickets", description: "Live work items.", metadata_only_list: true, tool_id: "jira" };
/** `count` item ids from E`from`. */
export const ids = (from: number, count: number) => Array.from({ length: count }, (_, index) => `E${from + index}`);

type PageFacts = readonly [id: string, title: string, created: string, updated: string, version: string];
/** The 8 pages the October 4 list returned on staging (release c15cd0f). */
export const OCTOBER_4: readonly PageFacts[] = [
  ["589865", "ECHO Product Pipeline — Start Here", "2026-10-04T08:24:06.602Z", "2026-10-05T22:11:30.875Z", "3"],
  ["1474561", "Assumptions and decisions — source facts versus proposals", "2026-10-04T23:20:34.011Z", "2026-10-04T23:38:56.950Z", "3"],
  ["1441793", "Gate reviews — EVT pass, DVT hold, PVT pending", "2026-10-04T23:20:32.966Z", "2026-10-04T23:38:56.091Z", "3"],
  ["1409042", "Traceability — requirement threads and BUG-412 walkthrough", "2026-10-04T23:20:33.469Z", "2026-10-04T23:38:56.546Z", "3"],
  ["1409025", "PRD — System and acceptance requirements", "2026-10-04T23:12:35.624Z", "2026-10-04T23:38:55.130Z", "3"],
  ["1212607", "Verification plan — EVT, DVT and PVT mock results", "2026-10-04T23:15:15.480Z", "2026-10-04T23:38:55.604Z", "3"],
  ["1212589", "MRD — Mock Digital Thermometer", "2026-10-04T23:12:34.763Z", "2026-10-04T23:38:19.907Z", "3"],
  ["1015989", "Mock Digital Thermometer Home", "2026-10-04T23:06:19.406Z", "2026-10-04T23:38:54.598Z", "5"],
];
export const OCT4_TITLES = OCTOBER_4.map(([, title]) => title);
/** A page as a list row: title, dates and status, no text (the reader cites the empty inventory section). */
export function pageRow([id, title, created, updated, version]: PageFacts): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `page_${id}_inventory`, source_id: "confluence", kind: "page" as const, label: title, visibility: "only_me" as const,
    citation: { kind: "page" as const, tool_id: "confluence", external_scope_id: "site-one", page_id: id, section_id: "inventory", version, permalink: `https://knowledge.example.test/wiki/pages/${id}`, text_sha256: sha256Digest("") },
    dates: { created, updated }, occurred_at: updated.slice(0, 10), date_kind: "version_created" as const, attributes: { status: "current" }, receipt_sha256: canonicalSha256({ page: id }),
  } satisfies EvidenceDeskItemV2);
}
export const PAGES = OCTOBER_4.map(pageRow);
/** What opening a page row releases: its section `n`, a new item with its own id. */
export const section = (row: EvidenceDeskItemV2, body: string, n = 1): EvidenceDeskItemV2 => Object.freeze({
  ...row, id: row.id.replace("inventory", `s${n}`), text: body,
  citation: { ...(row.citation as Extract<EvidenceDeskItemV2["citation"], { kind: "page" }>), section_id: `s${n}`, text_sha256: sha256Digest(body) },
});

/** A ticket as a list row: key and summary, status and assignee, no text. */
export function ticketRow(n: number, owner = "Dana Lee", status = "In Progress"): EvidenceDeskItemV2 {
  const key = `THERM-${n}`;
  return Object.freeze({
    id: `ticket_${key}`, source_id: "jira", kind: "ticket" as const, label: `${key}: Fixture work ${n}`, visibility: "only_me" as const,
    citation: { kind: "ticket" as const, tool_id: "jira", external_scope_id: "cloud-one", ticket_id: String(10_000 + n), permalink: `https://tickets.example.test/browse/${key}`, text_sha256: sha256Digest("") },
    dates: { created: "2026-10-04T18:00:00.000Z" }, occurred_at: "2026-10-04", date_kind: "created" as const, attributes: { status, owner }, receipt_sha256: canonicalSha256({ ticket: key }),
  } satisfies EvidenceDeskItemV2);
}
export const tickets = (from: number, count: number) => Array.from({ length: count }, (_, index) => ticketRow(from + index));
/** A ticket as an open returns it: its body, under the row's own id. */
export const ticketBody = (n: number, text: string): EvidenceDeskItemV2 =>
  Object.freeze({ ...ticketRow(n), text, citation: { ...(ticketRow(n).citation as Extract<EvidenceDeskItemV2["citation"], { kind: "ticket" }>), text_sha256: sha256Digest(text) } });

/** A follow-up as the desk releases it: its row carries its text (ADR-0040), and its due date when it has one. */
export function followUpItem(n: number, due_at?: string): EvidenceDeskItemV2 {
  const decision = { title: "THERM DVT recovery sync", first_line: "Ship fan curve v2 before DVT.", ref: `meeting:sha256:${"a".repeat(64)}` } as const;
  const fields = followUpDeskFieldsV1(validatePersonFollowUpEvidenceV1({ item_id: `itm_6b0f8a52-55a4-4f6e-9a39-${String(n).padStart(12, "0")}`, kind: "ticket", title: `THERM-${40 + n} follow-up`, owner: "Mara Lind", status: "open", ...(due_at === undefined ? {} : { due_at }), decision }));
  return Object.freeze({ id: `follow-up-${n}`, ...fields, visibility: "team" as const, receipt_sha256: canonicalSha256(`follow-up-${n}`) });
}

/** A list port over `items`, `size` a page: `more` is added to a page with a next page, `last` to the last page. */
export const pager = (items: readonly EvidenceDeskItemV2[], size = 50, more: object = {}, last: object = {}) => vi.fn(async (input: EvidenceDeskListInputV2) => {
  const start = Number(input.cursor ?? 0);
  return { ...result(items.slice(start, start + size)), ...(start + size < items.length ? { ...more, next_cursor: String(start + size) } : last) } as EvidenceDeskResultV2;
});
