import { describe, expect, it } from "vitest";
import {
  AgenticAskOutputErrorV1,
  answerSchema,
  cleanId,
  normalizeQuery,
  parseAnswer,
  parseStep,
  stepSchema,
} from "../../src/answer-composition/agentic-ask-v1-model-protocol.js";

type Schema = Readonly<Record<string, any>>;

/** Deterministic generator of values a JSON-schema-enforcing provider could legally return. */
function generator(seed: number) {
  let state = seed;
  const next = () => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state / 2_147_483_648; };
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  const strings = ["", " ", "x", " padded ", "trailing ", "line\nbreak", "tab\tinside", "Ünïcödé", "E1", "e2", "[E3]", "12", "日本語のテキスト", "a".repeat(40), " nbsp "];
  const value = (schema: Schema): unknown => {
    if (schema.enum !== undefined) return pick(schema.enum as unknown[]);
    if (schema.type === "string") {
      let text = pick(strings);
      if (schema.maxLength !== undefined) text = [...text].slice(0, schema.maxLength).join("");
      return text;
    }
    if (schema.type === "integer") return Math.floor((schema.minimum ?? 0) + next() * ((schema.maximum ?? 9) - (schema.minimum ?? 0) + 1));
    if (schema.type === "array") {
      const minimum = schema.minItems ?? 0; const maximum = Math.min(schema.maxItems ?? 4, 6);
      return Array.from({ length: minimum + Math.floor(next() * (maximum - minimum + 1)) }, () => value(schema.items));
    }
    if (schema.type === "object") {
      const required = (schema.required ?? []) as string[];
      const optional = Object.keys(schema.properties ?? {}).filter(key => !required.includes(key) && next() < 0.5);
      return Object.fromEntries([...required, ...optional].map(key => [key, value(schema.properties[key])]));
    }
    throw new Error("unsupported schema");
  };
  return value;
}

describe("agentic Ask model protocol parity", () => {
  it("never rejects a step the step schema permits, except an empty part question", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const value = generator(seed)(stepSchema) as { parts: { question: string }[] };
      const emptyQuestion = value.parts.some(part => part.question.trim().replace(/[\s\p{Cc}]+/gu, "").length === 0);
      if (emptyQuestion) expect(() => parseStep(value)).toThrow(AgenticAskOutputErrorV1);
      else expect(() => parseStep(value)).not.toThrow();
    }
  });

  it("never rejects an answer the answer schema permits", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const value = generator(seed)(answerSchema);
      expect(() => parseAnswer(value)).not.toThrow();
    }
  });

  it("names the actual keys when the root shape is wrong", () => {
    expect(() => parseStep({ answer_parts: [], actions: [] })).toThrow('"parts" must be an array (got keys "answer_parts", "actions")');
    expect(() => parseStep({ parts: [] })).toThrow('"actions" must be an array');
    expect(() => parseStep({ parts: [], actions: [{ tool: "delete", args: {} }] })).toThrow('unknown tool "delete"');
    expect(() => parseAnswer({ direct: { text: "x" }, parts: [] })).toThrow('"sentences" must be an array (got keys "direct", "parts")');
  });

  it("normalizes untidy but permitted forms", () => {
    expect(parseStep({ parts: [{ question: "Who owns it? ", needs: [{ need: " owner ", status: "open", evidence: [] }], notes: "" }], actions: [{ tool: "search", args: { query: "owner " } }] }))
      .toEqual({ parts: [{ question: "Who owns it?", needs: [{ need: "owner", status: "open", evidence: [] }], notes: "" }], actions: [{ tool: "search", args: { query: "owner" } }] });
    expect(parseAnswer({ sentences: [{ text: " Done. ", evidence: ["e2", "[E3]"] }, { text: "", evidence: [] }], not_found: ["", "owner"] }))
      .toEqual({ sentences: [{ text: "Done.", evidence: ["E2", "E3"] }], not_found: ["owner"] });
  });

  it("reads the A2 input field and bare strings as the tool's main argument, and browse as list", () => {
    const step = parseStep({ parts: [{ question: "q", needs: ["a fact"], notes: "" }], actions: [
      { tool: "search", input: "fixture owner" }, { tool: "open", args: "E4" }, { tool: "browse", input: "" }, { tool: "list", args: { source: "slack", channel: "#hw-dvt", since: 7 } },
    ] });
    expect(step.parts[0]!.needs).toEqual([{ need: "a fact", status: "open", evidence: [] }]);
    expect(step.actions).toEqual([
      { tool: "search", args: { query: "fixture owner" } }, { tool: "open", args: { id: "E4" } }, { tool: "list", args: {} }, { tool: "list", args: { source: "slack", channel: "#hw-dvt", since: "7" } },
    ]);
  });

  it("maps need status spellings and drops duplicate needs", () => {
    const step = parseStep({ parts: [{ question: "q", needs: [{ need: "A", status: "Answered", evidence: [] }, { need: "a", status: "open", evidence: [] }, { need: "B", status: "not found", evidence: [] }, { need: "C", status: "??", evidence: [] }], notes: "" }], actions: [{ tool: "finish", args: {} }] });
    expect(step.parts[0]!.needs.map(need => [need.need, need.status])).toEqual([["A", "found"], ["B", "not_found"], ["C", "open"]]);
  });

  it("truncates over-long text to its bound instead of rejecting it", () => {
    const step = parseStep({ parts: [{ question: "q".repeat(900), needs: [{ need: "n".repeat(900), status: "open", evidence: [] }], notes: "n".repeat(5_000) }], actions: [{ tool: "finish", args: {} }] });
    expect([...step.parts[0]!.question].length).toBeLessThanOrEqual(400);
    expect([...step.parts[0]!.needs[0]!.need].length).toBeLessThanOrEqual(200);
    expect([...step.parts[0]!.notes].length).toBeLessThanOrEqual(800);
  });

  it("accepts common id spellings and ignores the rest", () => {
    expect(["E4", "e4", "[E4]", " E4 ", "4", 4].map(cleanId)).toEqual(["E4", "E4", "E4", "E4", "E4", "E4"]);
    expect(["desk_abc", "E", "item 4", ""].map(cleanId)).toEqual([null, null, null, null]);
  });

  it("turns a sentence or quoted phrase into a valid keyword query", () => {
    expect(normalizeQuery("\"launch date\"")).toBe("launch date");
    expect(normalizeQuery("What is the launch date, and who owns it?")).toBe("What is the launch date and who owns it");
    expect(normalizeQuery(Array.from({ length: 40 }, (_, index) => `t${index}`).join(" "))!.split(" ")).toHaveLength(32);
    expect(normalizeQuery("?!")).toBeNull();
  });
});
