import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { validatePersonImpactCardV1, type PersonAnswerCitationV6, type PersonImpactAffectedV1, type PersonImpactCardV1 } from "@echo-brain/organization-api";
import { describe, expect, it } from "vitest";
import { cleanLine } from "../../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import {
  refreshImpactCardV1,
  storableImpactCardV1,
  type FreshImpactItemV1,
  type StoredImpactCardV1,
} from "../../../src/answer-composition/renderers/impact-card-storage-v1.js";

/**
 * The pointer-only impact card (runs store and impact card v1, section 4,
 * and ADR-0032): a stored card keeps ECHO's own judgments and pointers, never
 * a word read from Slack, Jira or Confluence. Every view rebuilds the outside
 * parts from fresh reads. Distinctive fictional outside text makes a leak
 * findable in the stored JSON.
 */
const OUTSIDE = "Kestrel cooling fan drift 0xC0FFEE";
const OWNER = "Rafael Moreno";
const RECORD = canonicalSha256({ record: "gate-review" });

const recordCitation = (name: string): PersonAnswerCitationV6 => Object.freeze({
  citation: { kind: "approved_record" as const, atom_id: canonicalSha256({ atom: name }), record_sha256: RECORD, policy_id: "organization-member-readable-person-v2" as const },
  kind: "decision" as const, label: `Gate review: ${name}`, visibility: "team" as const,
});
const otherRecordCitation = (name: string): PersonAnswerCitationV6 => Object.freeze({
  citation: { kind: "approved_record" as const, atom_id: canonicalSha256({ atom: name }), record_sha256: canonicalSha256({ record: name }), policy_id: "organization-member-readable-person-v2" as const },
  kind: "action" as const, label: `Planning sync: ${name}`, visibility: "team" as const,
});
const ticketCitation = (key: string, label: string): PersonAnswerCitationV6 => Object.freeze({
  citation: { kind: "ticket" as const, tool_id: "jira", external_scope_id: "cloud-one", ticket_id: key.replace(/\D/gu, ""), permalink: `https://tickets.example.test/browse/${key}`, text_sha256: canonicalSha256({ ticket: key }) },
  kind: "ticket" as const, label, visibility: "only_me" as const,
});
const pageCitation = (id: string, label: string): PersonAnswerCitationV6 => Object.freeze({
  citation: { kind: "page" as const, tool_id: "knowledge", external_scope_id: "site-one", page_id: id, section_id: "s1", version: "3", permalink: `https://knowledge.example.test/wiki/pages/${id}`, text_sha256: canonicalSha256({ page: id }) },
  kind: "page" as const, label, visibility: "only_me" as const,
});

/** Builds a valid card: the record decided index 0, then each given row in order. */
interface Row { readonly citation: PersonAnswerCitationV6; readonly says_now: string; readonly relation?: "confirms" | "conflicts" | "needs_updating"; readonly owner?: string; readonly date_at_risk?: PersonImpactAffectedV1["date_at_risk"] }
function cardWith(input: { readonly rows: readonly Row[]; readonly unconfirmed?: readonly string[]; readonly status?: PersonImpactCardV1["status"] }): PersonImpactCardV1 {
  const status = input.status ?? "assessed";
  const rows = input.rows.map((row, at) => ({ ...row, index: status === "assessed" ? at + 1 : at }));
  const owners = new Map<string, number[]>();
  for (const row of rows) if (row.owner !== undefined) owners.set(row.owner, [...(owners.get(row.owner) ?? []), row.index]);
  return validatePersonImpactCardV1({
    decided: status === "assessed" ? [{ text: "Show two decimals on the display from DVT.", citation_index: 0 }] : [],
    affected: rows.map(({ index, citation: _citation, ...row }) => ({ citation_index: index, ...row })),
    unconfirmed: input.unconfirmed ?? [],
    people: [...owners].map(([name, items]) => ({ name, items })),
    status,
    citations: [...(status === "assessed" ? [recordCitation("display")] : []), ...rows.map(row => row.citation)],
  });
}

const fresh = (citation: PersonAnswerCitationV6, rest: Partial<FreshImpactItemV1> = {}): FreshImpactItemV1 => ({ citation, label: citation.label, ...rest });

describe("storable impact card", () => {
  it("stores no outside text, label or owner", () => {
    const card = cardWith({
      rows: [{ citation: ticketCitation("THERM-46", OUTSIDE), says_now: OUTSIDE, relation: "conflicts", owner: OWNER }],
      unconfirmed: [`${OUTSIDE} could not be read.`],
    });
    const stored = JSON.stringify(storableImpactCardV1(card, [OUTSIDE]));
    expect(stored).not.toContain("0xC0FFEE");
    expect(stored).not.toContain("Rafael Moreno");
    expect(JSON.parse(stored).unconfirmed).toContain("1 item could not be read.");
  });

  it("keeps ECHO-local text and the model relation and date", () => {
    const card = cardWith({
      rows: [
        { citation: ticketCitation("THERM-46", OUTSIDE), says_now: OUTSIDE, relation: "conflicts", owner: OWNER, date_at_risk: { date: "2026-10-15", milestone: "DVT gate" } },
        { citation: otherRecordCitation("display-plan"), says_now: "The display plan still shows one decimal.", relation: "needs_updating", owner: "Mara Quinn" },
      ],
      unconfirmed: ["Research stopped before it finished, so other items may be affected too."],
    });
    const stored = storableImpactCardV1(card, [OUTSIDE]);
    expect(stored).toEqual({
      schema_version: 1,
      status: "assessed",
      decided: [{ text: "Show two decimals on the display from DVT.", citation_index: 0 }],
      affected: [
        { citation_index: 1, relation: "conflicts", date_at_risk: { date: "2026-10-15", milestone: "DVT gate" } },
        { citation_index: 2, relation: "needs_updating", says_now: "The display plan still shows one decimal." },
      ],
      unconfirmed: ["Research stopped before it finished, so other items may be affected too."],
      citations: card.citations.map(entry => entry.citation),
    });
    // The pointers carry no label, visibility or ref: those are rebuilt for the viewer.
    expect(JSON.stringify(stored.citations)).not.toContain("Gate review");
    expect(JSON.stringify(stored.citations)).not.toContain("visibility");
  });

  it("keeps a not assessed card's local rows and drops its outside details", () => {
    const card = cardWith({
      status: "not_assessed",
      rows: [
        { citation: ticketCitation("THERM-46", OUTSIDE), says_now: `${OUTSIDE}; status In Progress; due 2026-10-15`, owner: OWNER },
        { citation: otherRecordCitation("display-plan"), says_now: "Planning sync action" },
      ],
    });
    const stored = storableImpactCardV1(card, [OUTSIDE]);
    expect(stored.status).toBe("not_assessed");
    expect(stored.affected).toEqual([{ citation_index: 0 }, { citation_index: 1, says_now: "Planning sync action" }]);
    expect(JSON.stringify(stored)).not.toContain("0xC0FFEE");
  });

  it("replaces every note that names an outside item with one count, and keeps the others", () => {
    const other = "THERM-47: Fan curve";
    const card = cardWith({
      rows: [{ citation: ticketCitation("THERM-46", "THERM-46: Display precision"), says_now: "x", relation: "confirms" }],
      unconfirmed: [
        "Research stopped before it finished, so other items may be affected too.",
        `${OUTSIDE} could not be read.`,
        "1 fact research looked for was not found.",
        `${other.toLowerCase()} could not be read.`,
        "The tickets source could not be read.",
      ],
    });
    // Labels match whatever their case or spacing, and a blank label matches nothing.
    expect(storableImpactCardV1(card, [OUTSIDE, other, "", "   "]).unconfirmed).toEqual([
      "Research stopped before it finished, so other items may be affected too.",
      "2 items could not be read.",
      "1 fact research looked for was not found.",
      "The tickets source could not be read.",
    ]);
    // With no outside label to name, nothing is counted.
    expect(storableImpactCardV1(card, []).unconfirmed).toEqual(card.unconfirmed);
  });

  it("also counts a note that names an outside item the card itself cites", () => {
    const card = cardWith({
      rows: [{ citation: ticketCitation("THERM-46", "THERM-46: Display precision"), says_now: "x", relation: "confirms" }],
      unconfirmed: ["THERM-46:  Display precision could not be read.", "The tickets list was cut short at 25 items."],
    });
    expect(storableImpactCardV1(card, []).unconfirmed).toEqual(["1 item could not be read.", "The tickets list was cut short at 25 items."]);
  });

  it("never stores a decided line that cites an outside item", () => {
    const outside = ticketCitation("THERM-46", OUTSIDE);
    const card = validatePersonImpactCardV1({
      decided: [{ text: "Show two decimals on the display from DVT.", citation_index: 0 }, { text: `${OUTSIDE} must change.`, citation_index: 1 }],
      affected: [{ citation_index: 2, says_now: "The display plan shows one decimal.", relation: "confirms" }],
      unconfirmed: [], people: [], status: "assessed",
      citations: [recordCitation("display"), outside, otherRecordCitation("display-plan")],
    });
    const stored = storableImpactCardV1(card, [OUTSIDE]);
    expect(JSON.stringify(stored)).not.toContain("0xC0FFEE");
    expect(stored.decided).toEqual([{ text: "Show two decimals on the display from DVT.", citation_index: 0 }]);
    expect(stored.affected).toEqual([{ citation_index: 1, relation: "confirms", says_now: "The display plan shows one decimal." }]);
    expect(stored.citations).toEqual([recordCitation("display").citation, otherRecordCitation("display-plan").citation]);
  });
});

describe("storable impact card: every line a model wrote is screened for outside titles", () => {
  const TITLE = "THERM-46: Display precision";

  it("replaces an outside title in a decided line with 'a cited item'", () => {
    const card = validatePersonImpactCardV1({
      decided: [{ text: `The display plan still matches ${TITLE}`, citation_index: 0 }, { text: `${TITLE.toLowerCase()} and ${TITLE} both change.`, citation_index: 0 }],
      affected: [{ citation_index: 1, says_now: "x", relation: "confirms" }],
      unconfirmed: [], people: [], status: "assessed", citations: [recordCitation("display"), ticketCitation("THERM-46", TITLE)],
    });
    expect(storableImpactCardV1(card, []).decided.map(entry => entry.text)).toEqual([
      "The display plan still matches a cited item",
      "a cited item and a cited item both change.",
    ]);
    // A title the caller names, though the card cites no such item, is screened the same way.
    expect(storableImpactCardV1(card, ["The display plan"]).decided[0]!.text).toBe("a cited item still matches a cited item");
  });

  it("does not scrub ordinary words that merely begin with a short outside title", () => {
    const card = validatePersonImpactCardV1({
      decided: [{ text: "Show two decimals on the displayed value from the homepage.", citation_index: 0 }],
      affected: [], unconfirmed: [], people: [], status: "assessed", citations: [recordCitation("display")],
    });
    expect(storableImpactCardV1(card, ["Display", "Home"]).decided[0]!.text).toBe("Show two decimals on the displayed value from the homepage.");
  });

  it("drops the date of a row whose milestone is an outside title, and keeps the row", () => {
    const card = cardWith({ rows: [
      { citation: ticketCitation("THERM-46", TITLE), says_now: "x", relation: "conflicts", date_at_risk: { date: "2026-10-15", milestone: TITLE } },
      { citation: pageCitation("1441793", "PRD: Display"), says_now: "y", relation: "needs_updating", date_at_risk: { date: "2026-10-20", milestone: "DVT gate" } },
    ] });
    const stored = storableImpactCardV1(card, []);
    expect(stored.affected[0]).toEqual({ citation_index: 1, relation: "conflicts" });
    expect(stored.affected[1]).toEqual({ citation_index: 2, relation: "needs_updating", date_at_risk: { date: "2026-10-20", milestone: "DVT gate" } });
    // A milestone that only contains the title loses its date too.
    const inside = cardWith({ rows: [{ citation: ticketCitation("THERM-46", TITLE), says_now: "x", relation: "conflicts", date_at_risk: { date: "2026-10-15", milestone: `before ${TITLE.toUpperCase()} ships` } }] });
    expect(storableImpactCardV1(inside, []).affected[0]).toEqual({ citation_index: 1, relation: "conflicts" });
  });

  it("scrubs an outside title out of an ECHO-local line", () => {
    const card = cardWith({ rows: [
      { citation: otherRecordCitation("display-plan"), says_now: `The plan restates ${TITLE} word for word.`, relation: "needs_updating" },
      { citation: ticketCitation("THERM-46", TITLE), says_now: TITLE, relation: "conflicts" },
    ] });
    const stored = storableImpactCardV1(card, []);
    expect(stored.affected[0]!.says_now).toBe("The plan restates a cited item word for word.");
    expect(JSON.stringify(stored)).not.toContain("Display precision");
  });

  it.each([290, 320])("still catches a %i-character title in a note that cleanLine cut short", length => {
    const title = (`${OUTSIDE} `).repeat(12).slice(0, length).trim();
    const note = cleanLine(`${title} could not be read.`, 300);
    // The renderer's note is cut at 300 characters: its tail, and for a very long title the title itself.
    expect(note.endsWith("…")).toBe(true);
    expect(note.includes(title)).toBe(length < 299);
    const card = cardWith({
      rows: [{ citation: ticketCitation("THERM-46", "THERM-46: Display precision"), says_now: "x", relation: "confirms" }],
      unconfirmed: [note, "The tickets list was cut short at 25 items."],
    });
    const stored = storableImpactCardV1(card, [title]);
    expect(stored.unconfirmed).toEqual(["1 item could not be read.", "The tickets list was cut short at 25 items."]);
    expect(JSON.stringify(stored)).not.toContain("0xC0FFEE");
  });

  it("keeps a line that names no outside title exactly as written", () => {
    const card = cardWith({ rows: [{ citation: otherRecordCitation("display-plan"), says_now: "The  display plan is unchanged.", relation: "confirms" }] });
    const stored = storableImpactCardV1(card, [TITLE, "Unrelated title"]);
    expect(stored.decided).toEqual(card.decided);
    expect(stored.affected[0]!.says_now).toBe("The  display plan is unchanged.");
  });
});

describe("refreshed impact card", () => {
  const record = recordCitation("display");
  const ticket = ticketCitation("THERM-46", "THERM-46: Display precision");
  const page = pageCitation("1441793", "PRD: Display");
  const base = cardWith({
    rows: [
      { citation: ticket, says_now: "THERM-46 formats one decimal.", relation: "conflicts", owner: OWNER, date_at_risk: { date: "2026-10-15", milestone: "DVT gate" } },
      { citation: page, says_now: "The PRD specifies one decimal.", relation: "needs_updating" },
    ],
    unconfirmed: ["Research stopped before it finished, so other items may be affected too."],
  });
  const stored = storableImpactCardV1(base, ["THERM-46: Display precision", "PRD: Display"]);

  it("rebuilds the card it was made from when every item reads as before", () => {
    const result = refreshImpactCardV1(stored, [
      fresh(record),
      fresh(ticket, { text: "THERM-46 formats one decimal.", attributes: { owner: OWNER, due_at: "2026-10-15" } }),
      fresh(page, { text: "The PRD specifies one decimal." }),
    ]);
    expect(result.hidden).toBe(0);
    expect(result.card).toEqual(base);
  });

  it("hides what the viewer can no longer open and re-indexes citations", () => {
    const result = refreshImpactCardV1(stored, [fresh(record), null, fresh(page, { text: "The PRD specifies one decimal." })]);
    expect(result.hidden).toBe(1);
    expect(result.card.citations).toEqual([record, page]);
    expect(result.card.affected).toEqual([{ citation_index: 1, says_now: "The PRD specifies one decimal.", relation: "needs_updating" }]);
    expect(result.card.decided).toEqual(base.decided);
    expect(result.card.people).toEqual([]);
    // The result is a valid card: every index points at a kept citation.
    expect(() => validatePersonImpactCardV1(result.card)).not.toThrow();
    expect(JSON.stringify(result.card)).not.toContain(OWNER);
  });

  it("hides the decided lines when the approved record itself can no longer be opened", () => {
    const result = refreshImpactCardV1(stored, [null, fresh(ticket, { text: "THERM-46 formats one decimal.", attributes: { owner: OWNER, due_at: "2026-10-15" } }), null]);
    expect(result.hidden).toBe(2);
    expect(result.card.decided).toEqual([]);
    expect(result.card.citations).toEqual([ticket]);
    expect(result.card.affected.map(entry => entry.citation_index)).toEqual([0]);
    expect(result.card.people).toEqual([{ name: OWNER, items: [0] }]);
  });

  it("shows an empty card, hiding everything, when nothing can be opened", () => {
    const result = refreshImpactCardV1(stored, [null, null, null]);
    expect(result.hidden).toBe(3);
    expect(result.card).toEqual({ decided: [], affected: [], unconfirmed: stored.unconfirmed, people: [], status: "assessed", citations: [] });
  });

  it("rebuilds outside text and owners from the fresh item and drops a date it no longer states", () => {
    const result = refreshImpactCardV1(stored, [
      fresh(record),
      fresh(ticket, { text: "THERM-46 now formats two decimals.\nOwner changed.", attributes: { owner: "Tobias Lund" } }),
      fresh(page, { text: "Display: the reading shows two decimals." }),
    ]);
    const [row] = result.card.affected;
    expect(row).toEqual({ citation_index: 1, says_now: "THERM-46 now formats two decimals. Owner changed.", relation: "conflicts", owner: "Tobias Lund" });
    expect(row).not.toHaveProperty("date_at_risk");
    expect(result.card.people).toEqual([{ name: "Tobias Lund", items: [1] }]);
    expect(JSON.stringify(result.card)).not.toContain(OWNER);
    expect(result.card.affected[1]!.says_now).toBe("Display: the reading shows two decimals.");
  });

  it("keeps a date the fresh item still states, in its due date, title or text", () => {
    const date = { date: "2026-10-15", milestone: "DVT gate" };
    const keeps = (item: Partial<FreshImpactItemV1>) => {
      const result = refreshImpactCardV1(stored, [fresh(record), fresh(ticket, item), fresh(page, { text: "x" })]);
      return result.card.affected[0]!.date_at_risk;
    };
    expect(keeps({ attributes: { due_at: "2026-10-15" } })).toEqual(date);
    expect(keeps({ label: "THERM-46 due 2026-10-15" })).toEqual(date);
    expect(keeps({ text: "Moved: ships 2026-10-15." })).toEqual(date);
    expect(keeps({ text: "Ships 2026-10-20.", attributes: { due_at: "2026-10-20" } })).toBeUndefined();
  });

  it("shows the first 300 characters of the current text on one line, else the item's details", () => {
    const long = `${"Fan curve ".repeat(40)}\n\ttail`;
    const result = refreshImpactCardV1(stored, [
      fresh(record),
      fresh(ticket, { text: long, attributes: { owner: OWNER } }),
      fresh(page, { label: "PRD: Display", attributes: { status: "Draft", due_at: "2026-11-01" } }),
    ]);
    const says = result.card.affected[0]!.says_now;
    expect([...says].length).toBe(300);
    expect(says).not.toMatch(/[\n\t]/u);
    expect(says.startsWith("Fan curve Fan curve")).toBe(true);
    expect(result.card.affected[1]!.says_now).toBe("PRD: Display; status Draft; due 2026-11-01");
    expect(refreshImpactCardV1(stored, [fresh(record), fresh(ticket, { text: "   \n " }), fresh(page)]).card.affected[0]!.says_now).toBe("THERM-46: Display precision");
  });

  it("takes owners from the current details only, and each person once with their items in card order", () => {
    const second = ticketCitation("THERM-47", "THERM-47: Fan curve");
    const card = cardWith({ rows: [
      { citation: ticket, says_now: "a", relation: "conflicts" },
      { citation: page, says_now: "b", relation: "confirms" },
      { citation: second, says_now: "c", relation: "needs_updating" },
    ] });
    const result = refreshImpactCardV1(storableImpactCardV1(card, []), [
      fresh(record),
      fresh(ticket, { text: "a", attributes: { owner: "Tobias Lund" } }),
      fresh(page, { text: "b" }),
      fresh(second, { text: "c", attributes: { owner: "Tobias Lund" } }),
    ]);
    expect(result.card.affected.map(entry => entry.owner)).toEqual(["Tobias Lund", undefined, "Tobias Lund"]);
    expect(result.card.people).toEqual([{ name: "Tobias Lund", items: [1, 3] }]);
  });

  it("keeps an ECHO-local row's stored line, and still takes its owner from the current details", () => {
    const local = otherRecordCitation("display-plan");
    const card = cardWith({ rows: [{ citation: local, says_now: "The display plan still shows one decimal.", relation: "needs_updating" }] });
    const result = refreshImpactCardV1(storableImpactCardV1(card, []), [
      fresh(record), fresh(local, { text: "A different current text.", attributes: { owner: "Mara Quinn" } }),
    ]);
    expect(result.card.affected).toEqual([{ citation_index: 1, says_now: "The display plan still shows one decimal.", relation: "needs_updating", owner: "Mara Quinn" }]);
  });

  it("shows the fresh citation as released to this viewer, not the stored pointer", () => {
    const moved = { ...ticket, citation: { ...ticket.citation, text_sha256: canonicalSha256({ ticket: "edited" }) }, visibility: "project" } as PersonAnswerCitationV6;
    const result = refreshImpactCardV1(stored, [fresh(record), fresh(moved, { text: "THERM-46 formats one decimal." }), fresh(page, { text: "x" })]);
    expect(result.card.citations[1]).toEqual(moved);
  });

  it("hides a row whose fresh read is a different item than its stored pointer names", () => {
    const other = ticketCitation("THERM-99", "THERM-99: Something else");
    const result = refreshImpactCardV1(stored, [fresh(record), fresh(other, { text: "Unrelated." }), fresh(page, { text: "The PRD specifies one decimal." })]);
    expect(result.hidden).toBe(1);
    expect(result.card.citations).toEqual([record, page]);
    expect(JSON.stringify(result.card)).not.toContain("THERM-99");
    // A different kind, a different page, a different tool and a different record atom are all different items.
    const pageElsewhere = { ...page, citation: { ...page.citation, page_id: "999" } } as PersonAnswerCitationV6;
    const pageOtherTool = { ...page, citation: { ...page.citation, tool_id: "other-knowledge" } } as PersonAnswerCitationV6;
    expect(refreshImpactCardV1(stored, [fresh(record), fresh(ticket, { text: "x" }), fresh(pageElsewhere)]).hidden).toBe(1);
    expect(refreshImpactCardV1(stored, [fresh(record), fresh(ticket, { text: "x" }), fresh(pageOtherTool)]).hidden).toBe(1);
    expect(refreshImpactCardV1(stored, [fresh(record), fresh(page), fresh(ticket)]).hidden).toBe(2);
    const otherAtom = recordCitation("another-atom");
    const lost = refreshImpactCardV1(stored, [fresh(otherAtom), fresh(ticket, { text: "x" }), fresh(page, { text: "x" })]);
    expect(lost.hidden).toBe(1);
    expect(lost.card.decided).toEqual([]);
  });

  it("accepts a fresh read whose section or version moved on, and shows its current pointer", () => {
    const moved = { ...page, citation: { ...page.citation, section_id: "s7", version: "4" } } as PersonAnswerCitationV6;
    const result = refreshImpactCardV1(stored, [fresh(record), fresh(ticket, { text: "x" }), fresh(moved, { text: "x" })]);
    expect(result.hidden).toBe(0);
    expect(result.card.citations[2]).toEqual(moved);
  });

  it("does not throw when two stored sections of one page re-open as the same pointer: one row stays, one is hidden", () => {
    const sectionOne = pageCitation("1441793", "PRD: Display, section one");
    const sectionTwo = { ...sectionOne, citation: { ...sectionOne.citation, section_id: "s2" }, label: "PRD: Display, section two" } as PersonAnswerCitationV6;
    const card = cardWith({ rows: [
      { citation: sectionOne, says_now: "Section one says one decimal.", relation: "needs_updating" },
      { citation: sectionTwo, says_now: "Section two says one decimal.", relation: "conflicts" },
    ] });
    const twoSections = storableImpactCardV1(card, []);
    // The page was edited: both stale sections re-open as the current page from the top.
    const current = { ...sectionOne, citation: { ...sectionOne.citation, section_id: "s1", version: "4" } } as PersonAnswerCitationV6;
    const result = refreshImpactCardV1(twoSections, [fresh(record), fresh(current, { text: "Display: two decimals." }), fresh(current, { text: "Display: two decimals." })]);
    expect(result.hidden).toBe(1);
    expect(result.card.citations).toEqual([record, current]);
    expect(result.card.affected).toEqual([{ citation_index: 1, says_now: "Display: two decimals.", relation: "needs_updating" }]);
    // A hidden duplicate hides the row that cited it, not the other way round.
    const reversed = refreshImpactCardV1(twoSections, [fresh(record), null, fresh(current, { text: "Display: two decimals." })]);
    expect(reversed.card.affected).toEqual([{ citation_index: 1, says_now: "Display: two decimals.", relation: "conflicts" }]);
  });

  it("decides what is ECHO's own from the citation kind, never from a stored line", () => {
    const tampered = { ...stored, affected: stored.affected.map(entry => ({ ...entry, says_now: "A stored line about an outside item." })) } as StoredImpactCardV1;
    const result = refreshImpactCardV1(tampered, [fresh(record), fresh(ticket, { text: "THERM-46 formats two decimals." }), fresh(page, { text: "Display: two decimals." })]);
    expect(result.card.affected.map(entry => entry.says_now)).toEqual(["THERM-46 formats two decimals.", "Display: two decimals."]);
    const localCard = cardWith({ rows: [{ citation: otherRecordCitation("display-plan"), says_now: "The display plan still shows one decimal.", relation: "needs_updating" }] });
    const local = refreshImpactCardV1(storableImpactCardV1(localCard, []), [fresh(record), fresh(otherRecordCitation("display-plan"), { text: "Something else now." })]);
    expect(local.card.affected[0]!.says_now).toBe("The display plan still shows one decimal.");
  });

  it("refuses fresh reads that do not match the stored citations", () => {
    expect(() => refreshImpactCardV1(stored, [fresh(record), null])).toThrow("one entry per stored citation");
    const broken = { ...stored, affected: [{ citation_index: 9, relation: "confirms" as const }] } as StoredImpactCardV1;
    expect(() => refreshImpactCardV1(broken, [fresh(record), fresh(ticket), fresh(page)])).toThrow("points at no stored citation");
  });
});
