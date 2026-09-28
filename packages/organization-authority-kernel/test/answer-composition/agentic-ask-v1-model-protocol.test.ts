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
    if (schema.type === "object") return Object.fromEntries((schema.required as string[]).map(key => [key, value(schema.properties[key])]));
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
      expect(() => parseAnswer(value, 5)).not.toThrow();
    }
  });

  it("names the actual keys when the root shape is wrong", () => {
    expect(() => parseStep({ answer_parts: [], actions: [] })).toThrow('"parts" must be an array (got keys "answer_parts", "actions")');
    expect(() => parseStep({ parts: [] })).toThrow('"actions" must be an array');
    expect(() => parseStep({ parts: [], actions: [{ tool: "delete", input: "" }] })).toThrow('unknown tool "delete"');
    expect(() => parseAnswer({ restatement: "x" }, 1)).toThrow('"parts" must be an array');
  });

  it("normalizes the provider-permitted forms the last measured run rejected", () => {
    // Trailing spaces in planner questions and an empty optional gap were rejected before.
    expect(parseStep({ parts: [{ question: "Who owns it? ", status: "searching", notes: "", evidence: [] }], actions: [{ tool: "search", input: "owner " }] }))
      .toEqual({ parts: [{ question: "Who owns it?", status: "searching", notes: "", evidence: [] }], actions: [{ tool: "search", input: "owner" }] });
    expect(parseAnswer({ direct: { text: "", evidence: [] }, parts: [{ part: 1, statements: [], gap: "" }] }, 1))
      .toEqual({ direct: null, parts: [{ part: 1, statements: [], gap: "" }] });
  });

  it("truncates over-long text to its bound instead of rejecting it", () => {
    const step = parseStep({ parts: [{ question: "q".repeat(900), status: "answered", notes: "n".repeat(5_000), evidence: [] }], actions: [{ tool: "finish", input: "" }] });
    expect([...step.parts[0]!.question].length).toBeLessThanOrEqual(400);
    expect([...step.parts[0]!.notes].length).toBeLessThanOrEqual(600);
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
