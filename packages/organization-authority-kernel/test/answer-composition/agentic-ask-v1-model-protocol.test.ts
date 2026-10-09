import { describe, expect, it } from "vitest";
import {
  AgenticAskOutputErrorV1,
  answerSchema,
  cleanId,
  createStepSchema,
  normalizeQuery,
  parseAnswer,
  parseStep,
  stepSchema,
  stripEvidenceIds,
} from "../../src/answer-composition/agentic-ask-v1-model-protocol.js";

type Schema = Readonly<Record<string, any>>;

/** Deterministic generator of values a JSON-schema-enforcing provider could legally return. */
function generator(seed: number) {
  let state = seed;
  const next = () => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state / 2_147_483_648; };
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  const strings = ["", " ", "x", " padded ", "trailing ", "line\nbreak", "tab\tinside", "Ünïcödé", "E1", "e2", "[E3]", "12", "日本語のテキスト", "a".repeat(40), " nbsp "];
  const value = (schema: Schema): unknown => {
    if (schema.anyOf !== undefined) return value(pick(schema.anyOf as Schema[]));
    if (schema.enum !== undefined) return pick(schema.enum as unknown[]);
    if (schema.type === "string") {
      let text = pick(strings.filter(value => value.length >= (schema.minLength ?? 0)));
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
  it("uses portable closed strings for request-scoped action choices", () => {
    const schema = createStepSchema(["meetings", "tickets"], ["E3", "E17"]);
    const variants = ((schema.properties as Schema).actions as Schema).items as Schema;
    const enumSchemas: Schema[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value !== null && typeof value === "object") {
        const schemaValue = value as Schema;
        if (schemaValue.enum !== undefined) enumSchemas.push(schemaValue);
        Object.values(schemaValue).forEach(visit);
      }
    };
    visit(schema);
    const byTool = Object.fromEntries((variants.anyOf as Schema[]).map(variant => {
      const properties = variant.properties as Schema;
      const tool = (properties.tool as Schema).enum![0] as string;
      return [tool, properties.args as Schema];
    }));
    const closed = (value: Schema, expected: readonly string[]) => {
      expect(value).toEqual({ type: "string", enum: expected });
    };

    expect(Object.keys(byTool).sort()).toEqual(["finish", "list", "open", "search"]);
    expect(enumSchemas).toHaveLength(8);
    for (const enumSchema of enumSchemas) expect(Object.keys(enumSchema).sort()).toEqual(["enum", "type"]);
    closed(((byTool.search.properties as Schema).source as Schema), ["meetings", "tickets"]);
    closed(((byTool.list.properties as Schema).source as Schema), ["meetings", "tickets"]);
    closed(((byTool.open.properties as Schema).id as Schema), ["E3", "E17"]);
    expect(((byTool.search.properties as Schema).query as Schema)).toEqual({ type: "string", minLength: 1, maxLength: 240 });
    expect(JSON.stringify(schema)).not.toContain("E99");
  });

  it("can withhold finish without widening the discovery action set", () => {
    const schema = createStepSchema(["meetings"], [], false);
    const variants = ((schema.properties as Schema).actions as Schema).items as Schema;
    const tools = (variants.anyOf as Schema[]).map(variant => ((variant.properties as Schema).tool as Schema).enum![0]);
    expect(tools).toEqual(["search", "list"]);
  });

  it("binds each action's argument schema to the selected tool", () => {
    const argumentsByTool: Record<string, readonly string[]> = {
      search: ["query", "source"], open: ["id"],
      list: ["source", "kind", "status", "owner", "channel", "since", "until"], finish: [],
    };
    for (let seed = 1; seed <= 400; seed += 1) {
      const value = generator(seed)(stepSchema) as { actions: { tool: string; args: Record<string, unknown> }[] };
      for (const action of value.actions) {
        const allowed = argumentsByTool[action.tool]!;
        if (allowed.length > 0) expect(action.args).toHaveProperty(allowed[0]!);
        expect(Object.keys(action.args).every(name => allowed.includes(name))).toBe(true);
      }
    }
  });

  it.each([
    ["open", { query: "E1" }, "id"],
    ["search", { id: "E1" }, "query"],
    ["list", { query: "documents" }, "source"],
  ])("repairs a %s action that supplies another tool's argument", (tool, args, required) => {
    expect(() => parseStep({ parts: [{ question: "q", needs: [], notes: "" }], actions: [{ tool, args }] }))
      .toThrow(`${tool} requires args.${required}`);
  });

  it("never rejects a step the step schema permits, except blank required text", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const value = generator(seed)(stepSchema) as { parts: { question: string }[]; actions: { tool: string; args: Record<string, string> }[] };
      const empty = (text: string) => text.trim().replace(/[\s\p{Cc}]+/gu, "").length === 0;
      const primary: Record<string, string> = { search: "query", open: "id", list: "source" };
      const blankRequiredText = value.parts.some(part => empty(part.question)) || value.actions.some(action => action.tool !== "finish" && empty(action.args[primary[action.tool]!]!));
      if (blankRequiredText) expect(() => parseStep(value)).toThrow(AgenticAskOutputErrorV1);
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
      { tool: "search", input: "fixture owner" }, { tool: "open", args: "E4" }, { tool: "browse", input: "meetings" }, { tool: "list", args: { source: "slack", channel: "#hw-dvt", since: 7 } },
    ] });
    expect(step.parts[0]!.needs).toEqual([{ need: "a fact", status: "open", evidence: [] }]);
    expect(step.actions).toEqual([
      { tool: "search", args: { query: "fixture owner" } }, { tool: "open", args: { id: "E4" } }, { tool: "list", args: { source: "meetings" } }, { tool: "list", args: { source: "slack", channel: "#hw-dvt", since: "7" } },
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

  it("keeps evidence ids out of the prose and allows ten sentences", () => {
    expect(stripEvidenceIds("The contact was verified on Sep 8 (E25), and the addendum is unsigned [E27, E3].")).toBe("The contact was verified on Sep 8, and the addendum is unsigned.");
    expect(stripEvidenceIds("Model E12 ships in October (e4 and E5).")).toBe("Model E12 ships in October.");
    const many = parseAnswer({ sentences: Array.from({ length: 12 }, (_, index) => ({ text: `Fact ${index}.`, evidence: ["E1"] })), not_found: [] });
    expect(many.sentences).toHaveLength(10);
  });

  it("accepts common id spellings and ignores the rest", () => {
    expect(["E4", "e4", "[E4]", " E4 ", "4", 4].map(cleanId)).toEqual(["E4", "E4", "E4", "E4", "E4", "E4"]);
    expect(["desk_abc", "E", "item 4", ""].map(cleanId)).toEqual([null, null, null, null]);
  });

  it("validates bounded queries without rewriting their meaning", () => {
    expect(normalizeQuery("\"launch date\"")).toBe("launch date");
    expect(normalizeQuery("What is the launch date, and who owns it?")).toBe("What is the launch date, and who owns it?");
    expect(normalizeQuery(Array.from({ length: 40 }, (_, index) => `t${index}`).join(" "))).toBeNull();
    expect(normalizeQuery("?!")).toBeNull();
  });

  it("preserves identifiers and punctuation for each provider to interpret", () => {
    expect(normalizeQuery('"KAN-8"')).toBe('KAN-8');
    for (const query of ['echo-123', 'HW_DVT-27 status', 'USB-C readiness', 'org/repo#123', 'person@example.test', 'C++ readiness', 'KAN-8 kan-8']) {
      expect(normalizeQuery(query), query).toBe(query);
    }
    expect(normalizeQuery(Array.from({ length: 20 }, (_, i) => `HW${i}-${i}`).join(' '))).toBeNull();
  });
});
