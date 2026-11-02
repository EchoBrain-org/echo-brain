import { validatePersonAnswerBlocksV2 } from "@echo-brain/organization-api";
import { describe, expect, it } from "vitest";
import type { AnswerItem } from "../../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import {
  buildAskBlocksV2, daysWrittenV2, orderAskBlocksV2, quoteIsWordForWordV2, type AskBlockShapeV2, type AskBlockStatementV2,
} from "../../../src/answer-composition/renderers/ask-layout-v2.js";

/**
 * Answer layout v2 (ADR-0051): the order a v2 answer's kept statements read in, the blocks they read as, and the checks
 * code makes of what a block shows. Every set of blocks here also passes the contract's own validator.
 */
const at = (shape: AskBlockShapeV2, ...citation_indexes: readonly number[]): AskBlockStatementV2 => ({ citation_indexes: citation_indexes.length === 0 ? [0] : citation_indexes, shape });
const ANSWER = (block = 0) => ({ block, kind: "answer" }) as const;
const point = (block: number, ordered = false, title?: string) => ({ block, kind: "point", ordered, ...(title === undefined ? {} : { title }) }) as const;
const event = (block: number, date: string, text: string, who?: string) => ({ block, kind: "event", title: "This week", date, text, ...(who === undefined ? {} : { who }) }) as const;
const fact = (block: number, label: string, value: string) => ({ block, kind: "fact", title: "THERM-48", entity: "ticket", label, value }) as const;
const row = (block: number, cells: readonly string[]) => ({ block, kind: "row", title: "Open actions", columns: ["Action", "Owner"], cells }) as const;
/** The blocks, checked against the contract: every statement once, in order, each block's items its statements. */
function arranged(statements: readonly AskBlockStatementV2[]) {
  const blocks = buildAskBlocksV2(statements);
  const citations = Math.max(0, ...statements.flatMap(statement => statement.citation_indexes)) + 1;
  expect(validatePersonAnswerBlocksV2(blocks, statements, citations)).toEqual(blocks);
  return blocks;
}

describe("Ask answer layout v2 (ADR-0051)", () => {
  it("reads every block the writer can arrange: the answer, text, points, a table, a timeline, a card and a quote", () => {
    const list = { kind: "list", caption: "2 actions are open", columns: ["Item", "Due"], rows: [{ cells: ["TRACE-01", "2026-10-14"], citation_indexes: [1] }, { cells: ["DVT-R2", ""], citation_indexes: [2] }] } as const;
    expect(arranged([
      at(ANSWER()), at(list, 1, 2),
      at(event(1, "2026-10-20", "Started the soak.", "Noor Haddad"), 1), at(event(1, "2026-10-23", "The soak passed."), 2),
      at(fact(2, "Status", "In review"), 1), at(fact(2, "Owner", "Tomas Okafor"), 1),
      at(point(3, true, "Before PVT"), 2), at(point(3, true, "Before PVT"), 2),
      at(row(4, ["Fix BUG-412", "Tomas Okafor"]), 1), at(row(4, ["Run DVT-R2", "QA"]), 2),
      at({ block: 5, kind: "quote", text: "Start PVT once the soak passes.", from: "Noor Haddad, Oct 23 review" }, 0),
    ])).toEqual([
      { kind: "answer", statements: [0] },
      { kind: "table", statements: [1], columns: ["Item", "Due"], caption: "2 actions are open", rows: list.rows },
      { kind: "timeline", title: "This week", statements: [2, 3], events: [{ date: "2026-10-20", text: "Started the soak.", who: "Noor Haddad" }, { date: "2026-10-23", text: "The soak passed." }] },
      { kind: "card", title: "THERM-48", entity: "ticket", statements: [4, 5], facts: [{ label: "Status", value: "In review" }, { label: "Owner", value: "Tomas Okafor" }] },
      { kind: "points", title: "Before PVT", ordered: true, statements: [6, 7] },
      { kind: "table", title: "Open actions", statements: [8, 9], columns: ["Action", "Owner"], rows: [{ cells: ["Fix BUG-412", "Tomas Okafor"], citation_indexes: [1] }, { cells: ["Run DVT-R2", "QA"], citation_indexes: [2] }] },
      { kind: "quote", statements: [10], text: "Start PVT once the soak passes.", from: "Noor Haddad, Oct 23 review" },
    ]);
  });

  it("reads a points, table, timeline or card block left with one item as text, keeping its title", () => {
    expect(arranged([at(ANSWER()), at(point(1, false, "Blockers"))])).toEqual([{ kind: "answer", statements: [0] }, { kind: "text", title: "Blockers", statements: [1] }]);
    expect(arranged([at(row(1, ["Fix BUG-412", "Tomas Okafor"]))])).toEqual([{ kind: "text", title: "Open actions", statements: [0] }]);
    expect(arranged([at(event(1, "2026-10-20", "Started the soak."))])).toEqual([{ kind: "text", title: "This week", statements: [0] }]);
    expect(arranged([at(fact(1, "Status", "In review"))])).toEqual([{ kind: "text", title: "THERM-48", statements: [0] }]);
  });

  it("reads consecutive untitled text as one block, and gives a block's title to its first run only", () => {
    expect(arranged([
      at(ANSWER()), at({ block: 1, kind: "text" }), at({ kind: "text" }), at({ block: 2, kind: "text", title: "Why" }), at({ block: 2, kind: "text", title: "Why" }),
      at(event(3, "2026-10-20", "Started the soak.")), at(event(3, "2026-10-23", "Passed.")), at({ block: 3, kind: "text", title: "This week" }), at({ block: 4, kind: "text" }),
    ])).toEqual([
      { kind: "answer", statements: [0] }, { kind: "text", statements: [1, 2] }, { kind: "text", title: "Why", statements: [3, 4] },
      { kind: "timeline", title: "This week", statements: [5, 6], events: [{ date: "2026-10-20", text: "Started the soak." }, { date: "2026-10-23", text: "Passed." }] },
      { kind: "text", statements: [7, 8] },
    ]);
  });

  it("keeps two writer blocks of one kind apart, and each quote a block of its own", () => {
    expect(arranged([at(point(1)), at(point(1)), at(point(2)), at(point(2))]).map(block => block.kind)).toEqual(["points", "points"]);
    const quote = (block: number) => at({ block, kind: "quote", text: "Ship it." });
    expect(arranged([quote(1), quote(2)]).map(block => block.kind)).toEqual(["quote", "quote"]);
  });

  describe("reading order", () => {
    type Sentence = { readonly id: string; readonly item: AnswerItem };
    const sentence = (id: string, item: AnswerItem): Sentence => ({ id, item });
    const ids = (order: readonly (string | Sentence)[]) => order.map(entry => typeof entry === "string" ? entry : `${entry.id}:${entry.item.kind}`);

    it("puts the answer first, then the lists, then each block's own items before those read as text, a timeline's oldest first", () => {
      const order = orderAskBlocksV2(["L1"], [
        sentence("a", ANSWER()),
        sentence("e1", event(1, "2026-10-23", "Passed.")), sentence("x", { block: 1, kind: "text", title: "This week" }), sentence("e2", event(1, "2026-10-20", "Started.")),
        sentence("e3", event(1, "2026-10-23", "Logged.")), sentence("p", point(2)),
      ], true);
      expect(ids(order)).toEqual(["a:answer", "L1", "e2:event", "e1:event", "e3:event", "x:text", "p:point"]);
    });

    it("reads the first kept item as the answer only when the writer gave none, and it is untitled text", () => {
      expect(ids(orderAskBlocksV2([], [sentence("t", { block: 1, kind: "text" }), sentence("p", point(2))], false))).toEqual(["t:answer", "p:point"]);
      expect(ids(orderAskBlocksV2([], [sentence("t", { block: 1, kind: "text", title: "Why" }), sentence("p", point(2))], false))).toEqual(["t:text", "p:point"]);
      expect(ids(orderAskBlocksV2([], [sentence("p", point(2)), sentence("t", { block: 3, kind: "text" })], false))).toEqual(["p:point", "t:text"]);
      // An answer the writer gave and code left out leaves none, rather than one the writer never chose.
      expect(ids(orderAskBlocksV2([], [sentence("t", { block: 1, kind: "text" })], true))).toEqual(["t:text"]);
    });
  });

  describe("checks", () => {
    it("finds a quote word for word, ignoring case, punctuation and a curly apostrophe, and nothing it only paraphrases", () => {
      const source = "Decision: Start PVT once the 72-hour soak passes, and don’t ship before QA signs off.";
      for (const quote of ["Start PVT once the 72-hour soak passes", "start pvt, once the 72-hour soak passes!", "don't ship before QA signs off"]) expect(quoteIsWordForWordV2(quote, ["Title", source])).toBe(true);
      for (const quote of ["Start PVT when the soak passes", "soak pass", "", "..."]) expect(quoteIsWordForWordV2(quote, ["Title", source])).toBe(false);
      expect(quoteIsWordForWordV2("PVT review", ["PVT review (2026-10-23)", ""])).toBe(true);
    });

    it("reads every day a text writes: ISO days, and a month's name with a day in the year given unless it names one", () => {
      expect([...daysWrittenV2("Moved from 2026-10-12 to Oct 16, then to October 20th, 2025, and Sept. 3.", 2026)]).toEqual(["2026-10-12", "2026-10-16", "2025-10-20", "2026-09-03"]);
      expect([...daysWrittenV2("Room 12, may be late; DVT-R2 runs 3 times.", 2026)]).toEqual([]);
    });
  });
});
