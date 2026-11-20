import { describe, expect, it } from "vitest";
import {
  AGENTIC_RESEARCH_NOTES_ABOUT_V1, agenticNotShownNoticeV1, agenticResearchNotesV1,
} from "../../src/answer-composition/agentic-research-notes-v1.js";

/**
 * Research's notes for the writer (ADR-0054): research's plan reaches the writer as bounded advice, never as the
 * person's question and never as evidence, and never in place of evidence.
 */
describe("research notes for the writer (ADR-0054)", () => {
  it("gives each need as research worded it, whole, with the ids the writer was shown", () => {
    const plan = [{ part: 1, question: "Which tickets?", notes: "scratch", needs: [
      { need: "é".repeat(200), kind: "which_items" as const, status: "found" as const, evidence: ["E3", "L1", "L7", "E99"] },
      { need: "who approved it", status: "not_found" as const, evidence: [] }] }];
    const notes = agenticResearchNotesV1({ plan, shown: id => id === "L1" || id === "E3", not_shown: { lists: 1, list_rows: 24 }, max_bytes: 4096 });
    expect(notes.needs[0]!.need).toBe("é".repeat(200));
    expect(notes.needs[0]).toMatchObject({ part: 1, kind: "which_items", status: "found", on_desk: ["L1", "E3"], not_shown: 2 });
    expect(notes.needs[1]).toEqual({ part: 1, need: "who approved it", kind: "content", status: "not_found", on_desk: [] });
    expect(notes).toMatchObject({ about: AGENTIC_RESEARCH_NOTES_ABOUT_V1, not_shown: { lists: 1, list_rows: 24 } });
    expect(JSON.stringify(notes)).not.toContain("scratch");
  });

  it("leaves needs out from the end when the room is short, and is empty for an empty plan", () => {
    const plan = [{ part: 1, question: "q", notes: "", needs: Array.from({ length: 50 }, (_, n) => ({ need: `need ${n} ${"x".repeat(200)}`, status: "open" as const, evidence: [] })) }];
    const notes = agenticResearchNotesV1({ plan, shown: () => true, not_shown: { lists: 0, list_rows: 0 }, max_bytes: 2048 });
    expect(Buffer.byteLength(JSON.stringify(notes), "utf8")).toBeLessThanOrEqual(2048);
    expect(notes.needs.length + notes.needs_omitted!).toBe(50);
    expect(notes.needs.map(need => need.need.split(" ")[1])).toEqual(Array.from({ length: notes.needs.length }, (_, n) => String(n)));
    expect(agenticResearchNotesV1({ plan: [], shown: () => true, not_shown: { lists: 0, list_rows: 0 }, max_bytes: 2048 }).needs).toEqual([]);
    // With room, every need is given: the window, not a count of its own, bounds the notes.
    expect(agenticResearchNotesV1({ plan, shown: () => true, not_shown: { lists: 0, list_rows: 0 }, max_bytes: 1_000_000 }).needs).toHaveLength(50);
  });

  it("keeps a need's list ids and every item id the writer was shown", () => {
    const evidence = [...Array.from({ length: 60 }, (_, n) => `E${n + 1}`), "L1"];
    const notes = agenticResearchNotesV1({ plan: [{ part: 1, question: "q", notes: "", needs: [{ need: "every ticket", kind: "which_items", status: "found", evidence }] }],
      shown: () => true, not_shown: { lists: 0, list_rows: 0 }, max_bytes: 8192 });
    expect(notes.needs[0]!.on_desk).toHaveLength(61);
    expect(notes.needs[0]!.on_desk.slice(0, 2)).toEqual(["L1", "E1"]);
    expect(notes.needs[0]).not.toHaveProperty("not_shown");
  });

  it("says, per list shown, how many members research read in full of how many, as advice", () => {
    const lists = [{ list: "L1" as const, read: 4, count: 8 }];
    expect(agenticResearchNotesV1({ plan: [], shown: () => true, not_shown: { lists: 0, list_rows: 0 }, max_bytes: 2048, lists }).lists).toEqual(lists);
    expect(agenticResearchNotesV1({ plan: [], shown: () => true, not_shown: { lists: 0, list_rows: 0 }, max_bytes: 2048 })).not.toHaveProperty("lists");
  });

  it("says in the notice how many lists and rows the writer was not shown", () => {
    expect(agenticNotShownNoticeV1({ lists: 1, list_rows: 24 })).toBe("1 list research read was not shown to the answer's writer. 24 list rows were not shown to the answer's writer.");
    expect(agenticNotShownNoticeV1({ lists: 3, list_rows: 1 })).toBe("3 lists research read were not shown to the answer's writer. 1 list row was not shown to the answer's writer.");
    expect(agenticNotShownNoticeV1({ lists: 0, list_rows: 0 })).toBeUndefined();
  });
});
