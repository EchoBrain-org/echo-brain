import { validatePersonAnswerLayoutV1 } from "@echo-brain/organization-api";
import { describe, expect, it } from "vitest";
import { buildAskLayoutV1, orderAskLayoutV1, type AskLayoutShapeV1, type AskLayoutStatementV1 } from "../../../src/answer-composition/renderers/ask-layout-v1.js";

/**
 * Answer layout v1 (ADR-0045): the blocks a laid-out answer's kept statements
 * read as. Every layout here also passes the contract's own validator.
 */
const at = (shape: AskLayoutShapeV1, ...citation_indexes: readonly number[]): AskLayoutStatementV1 => ({ citation_indexes: citation_indexes.length === 0 ? [0] : citation_indexes, shape });
const LEAD = { kind: "lead" } as const;
const TEXT = { kind: "text" } as const;
const BULLET = { kind: "bullet" } as const;
const ACTIONS = ["Action", "Owner", "Due", "Status"] as const;
const row = (section: string, cells: readonly string[]) => ({ kind: "row", section, columns: ACTIONS, cells }) as const;
/** The layout, checked against the contract: every statement once, in order, each table's rows citing what its statements cite. */
function laid(statements: readonly AskLayoutStatementV1[]) {
  const layout = buildAskLayoutV1(statements);
  const citations = Math.max(0, ...statements.flatMap(statement => statement.citation_indexes)) + 1;
  expect(validatePersonAnswerLayoutV1(layout, statements, citations)).toEqual(layout);
  return layout;
}

describe("Ask answer layout v1 (ADR-0045)", () => {
  it("lays the THERM answer out: the conclusion, the decisions as bullets, and what has to happen first as a table", () => {
    const first = "What has to happen first";
    expect(laid([
      at(LEAD, 1),
      at({ kind: "bullet", section: "Decisions" }, 2), at({ kind: "bullet", section: "Decisions" }, 0), at({ kind: "bullet", section: "Decisions" }, 2),
      at(row(first, ["Confirm TC-D-03 traces to MRD-01", "You", "2026-10-14", "Overdue"]), 3),
      at(row(first, ["Send the regression-scope proposal to the PM", "Rafael Moreno", "2026-10-09", "Open"]), 2),
      at(row(first, ["Fix BUG-412 on the board", "Tomas Okafor", "2026-10-28", "In progress"]), 3, 1),
      at(row(first, ["Run DVT-R2 and publish the report", "QA", "", "To do"]), 3),
    ])).toEqual([
      { kind: "lead", statements: [0] },
      { kind: "heading", text: "Decisions" },
      { kind: "bullets", statements: [1, 2, 3] },
      { kind: "heading", text: first },
      { kind: "table", statements: [4, 5, 6, 7], columns: ACTIONS, rows: [
        { cells: ["Confirm TC-D-03 traces to MRD-01", "You", "2026-10-14", "Overdue"], citation_indexes: [3] },
        { cells: ["Send the regression-scope proposal to the PM", "Rafael Moreno", "2026-10-09", "Open"], citation_indexes: [2] },
        { cells: ["Fix BUG-412 on the board", "Tomas Okafor", "2026-10-28", "In progress"], citation_indexes: [3, 1] },
        { cells: ["Run DVT-R2 and publish the report", "QA", "", "To do"], citation_indexes: [3] },
      ] },
    ]);
  });

  it("opens with at most two leads; a later lead reads as prose", () => {
    expect(laid([at(LEAD), at(LEAD), at(LEAD), at(TEXT)])).toEqual([{ kind: "lead", statements: [0, 1] }, { kind: "paragraph", statements: [2, 3] }]);
    // A lead after another block is prose too: a lead only opens a layout.
    expect(laid([at(TEXT), at(LEAD)])).toEqual([{ kind: "paragraph", statements: [0, 1] }]);
  });

  it("reads consecutive prose as one paragraph, two or more bullets as bullets, and one bullet as prose beside its neighbours", () => {
    expect(laid([at(LEAD), at(TEXT), at(TEXT), at(BULLET), at(BULLET), at(TEXT)]))
      .toEqual([{ kind: "lead", statements: [0] }, { kind: "paragraph", statements: [1, 2] }, { kind: "bullets", statements: [3, 4] }, { kind: "paragraph", statements: [5] }]);
    expect(laid([at(LEAD), at(TEXT), at(BULLET), at(TEXT)])).toEqual([{ kind: "lead", statements: [0] }, { kind: "paragraph", statements: [1, 2, 3] }]);
    expect(laid([at(BULLET)])).toEqual([{ kind: "paragraph", statements: [0] }]);
  });

  it("starts each section with its heading, however many sections the statements hold, never folding one into another", () => {
    const sections = Array.from({ length: 8 }, (_, index) => `Topic ${index + 1}`);
    const layout = laid([at(LEAD), ...sections.map(section => at({ kind: "text", section })), at({ kind: "bullet", section: "Topic 8" })]);
    expect(layout.filter(block => block.kind === "heading").map(block => block.text)).toEqual(sections);
    // Topic 8 holds its prose and the bullet beside it; Topic 7 stays its own section.
    expect(layout.slice(-4)).toEqual([{ kind: "heading", text: "Topic 7" }, { kind: "paragraph", statements: [7] }, { kind: "heading", text: "Topic 8" }, { kind: "paragraph", statements: [8, 9] }]);
    // A section that repeats is still one section, and prose before any section has no heading.
    expect(laid([at(LEAD), at(TEXT), at({ kind: "text", section: "A" }), at({ kind: "text", section: "A" })]))
      .toEqual([{ kind: "lead", statements: [0] }, { kind: "paragraph", statements: [1] }, { kind: "heading", text: "A" }, { kind: "paragraph", statements: [2, 3] }]);
  });

  it("makes each section's rows one table, and each list its own table with its caption", () => {
    const list = (caption: string, names: readonly string[], first: number): AskLayoutShapeV1 => ({
      kind: "list", caption, columns: ["Item", "Status"], rows: names.map((name, index) => ({ cells: [name, "Open"], citation_indexes: [first + index] })),
    });
    expect(laid([
      at(list("2 tickets", ["THERM-1", "THERM-2"], 0), 0, 1), at(list("2 pages", ["PRD", "MRD"], 2), 2, 3),
      at(row("A", ["One", "", "", ""]), 4), at(row("B", ["Two", "", "", ""]), 4), at(row("B", ["Three", "", "", ""]), 4),
    ])).toEqual([
      { kind: "table", statements: [0], columns: ["Item", "Status"], rows: [{ cells: ["THERM-1", "Open"], citation_indexes: [0] }, { cells: ["THERM-2", "Open"], citation_indexes: [1] }], caption: "2 tickets" },
      { kind: "table", statements: [1], columns: ["Item", "Status"], rows: [{ cells: ["PRD", "Open"], citation_indexes: [2] }, { cells: ["MRD", "Open"], citation_indexes: [3] }], caption: "2 pages" },
      { kind: "heading", text: "A" },
      { kind: "table", statements: [2], columns: ACTIONS, rows: [{ cells: ["One", "", "", ""], citation_indexes: [4] }] },
      { kind: "heading", text: "B" },
      { kind: "table", statements: [3, 4], columns: ACTIONS, rows: [{ cells: ["Two", "", "", ""], citation_indexes: [4] }, { cells: ["Three", "", "", ""], citation_indexes: [4] }] },
    ]);
  });

  it("keeps every text within the contract's bytes, and a cell per column", () => {
    const wide = "𝔸".repeat(120);
    const layout = laid([
      at({ kind: "text", section: wide }),
      at({ kind: "row", section: "S", columns: ["𝔸".repeat(40), "B"], cells: [wide] }),
      at({ kind: "list", caption: "𝔸".repeat(200), columns: ["Item", "Owner"], rows: [{ cells: [wide, "Dana"], citation_indexes: [0] }, { cells: ["x", ""], citation_indexes: [0] }] }),
    ]);
    const bytes = (value: string) => Buffer.byteLength(value, "utf8");
    expect(layout.map(block => block.kind === "heading" ? bytes(block.text) <= 200 : block.kind === "table"
      ? block.columns.every(column => bytes(column) <= 100) && block.rows.every(value => value.cells.length === block.columns.length && value.cells.every(cell => bytes(cell) <= 300)) && bytes(block.caption ?? "") <= 600
      : true)).toEqual(layout.map(() => true));
  });
});

describe("Ask answer order (ADR-0045)", () => {
  type Entry = { readonly id: string; readonly shape: AskLayoutShapeV1 };
  const entry = (id: string, shape: AskLayoutShapeV1): Entry => ({ id, shape });
  /** The order, with `marked` when the writer's reply marked a lead (kept or not). */
  const ordered = (lists: readonly Entry[], sentences: readonly Entry[], marked = sentences.some(value => value.shape.kind === "lead")) =>
    orderAskLayoutV1(lists, sentences, marked).map(value => [value.id, value.shape.kind, "section" in value.shape ? value.shape.section : undefined]);
  const LIST: AskLayoutShapeV1 = { kind: "list", caption: "2 tickets", columns: ["Item", "Status"], rows: [] };

  it("puts the writer's first two leads first, then the lists, then its other sentences by section in order of first appearance", () => {
    expect(ordered([entry("L1", LIST), entry("L2", TEXT)], [
      entry("a", { kind: "bullet", section: "B" }), entry("b", LEAD), entry("c", TEXT), entry("d", { kind: "lead", section: "A" }),
      entry("e", { kind: "text", section: "A" }), entry("f", LEAD), entry("g", { kind: "bullet", section: "B" }), entry("h", BULLET),
    ])).toEqual([
      ["b", "lead", undefined], ["d", "lead", undefined], ["L1", "list", undefined], ["L2", "text", undefined],
      ["c", "text", undefined], ["f", "text", undefined], ["h", "bullet", undefined],
      ["a", "bullet", "B"], ["g", "bullet", "B"], ["e", "text", "A"],
    ]);
  });

  it("makes the writer's first kept sentence the lead only when it marked none and that sentence is prose with no section", () => {
    expect(ordered([entry("L1", LIST)], [entry("c", TEXT), entry("a", { kind: "text", section: "A" }), entry("b", BULLET), entry("d", TEXT)]))
      .toEqual([["c", "lead", undefined], ["L1", "list", undefined], ["b", "bullet", undefined], ["d", "text", undefined], ["a", "text", "A"]]);
    // A first sentence with a section, or a bullet, is no lead, however much prose follows.
    for (const first of [entry("a", { kind: "text", section: "A" }), entry("b", BULLET)]) {
      expect(ordered([entry("L1", LIST)], [first, entry("c", TEXT)]).map(([, kind]) => kind)).not.toContain("lead");
    }
    // A lead the writer marked and code left out (W1, a repeat) leaves no lead, not one the writer never chose.
    expect(ordered([entry("L1", LIST)], [entry("c", TEXT), entry("d", TEXT)], true)).toEqual([["L1", "list", undefined], ["c", "text", undefined], ["d", "text", undefined]]);
  });
});
