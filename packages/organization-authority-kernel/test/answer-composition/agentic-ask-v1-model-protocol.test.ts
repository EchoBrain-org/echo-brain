import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import {
  AgenticAskOutputErrorV1,
  ASK_SEARCH_ONLY_STEP_PROMPT,
  ASK_STEP_PROMPT,
  answerSchema,
  cleanId,
  createStepSchema,
  normalizeQuery,
  parseAnswer,
  parseStep,
  SEARCH_ONLY_STEP_PROMPT,
  STEP_PROMPT,
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
      if (schema.format === "date") return "2024-07-19";
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

  it("can withhold list for a search-only run, in the schema and in the prompt", () => {
    const schema = createStepSchema(["meetings", "tickets"], ["E1"], true, false);
    const variants = ((schema.properties as Schema).actions as Schema).items as Schema;
    expect((variants.anyOf as Schema[]).map(variant => ((variant.properties as Schema).tool as Schema).enum![0])).toEqual(["search", "open", "finish"]);
    // The search-only prompt names no list tool and no inventory rule; the full prompt keeps both. Only rule 1 ("list only
    // the facts") and rule 4, which says there is no list tool, still say "list".
    expect(SEARCH_ONLY_STEP_PROMPT.split("\n").filter(line => /\blist\b/u.test(line)).map(line => line.slice(0, 2))).toEqual(["1.", "4."]);
    expect(SEARCH_ONLY_STEP_PROMPT).not.toContain("inventor");
    expect(SEARCH_ONLY_STEP_PROMPT).toContain("4. There is no list tool in this run");
    expect(SEARCH_ONLY_STEP_PROMPT).toContain("\"tool\" is \"search\", \"open\" or \"finish\".");
    expect(STEP_PROMPT).toContain("list, args {\"source\"");
    expect(STEP_PROMPT.split("\n").length - SEARCH_ONLY_STEP_PROMPT.split("\n").length).toBe(8);
  });

  it("gives Ask its own rules 3 and 4, and keeps the task prompt byte for byte (ADR-0041)", () => {
    const rule = (prompt: string, number: number) => prompt.split("\n").find(line => line.startsWith(`${number}. `))!;
    const line = (prompt: string, start: string) => prompt.split("\n").find(value => value.startsWith(start))!;
    // Background task prompts stay byte-for-byte unchanged. Ask also explains its client-local date projection.
    expect([STEP_PROMPT, SEARCH_ONLY_STEP_PROMPT, ASK_SEARCH_ONLY_STEP_PROMPT].map(prompt => canonicalSha256(prompt))).toEqual([
      "sha256:8083e4e4f259bd9676bd3a685d30c3fb5b8a797ecd61727552488a31a5014d86", "sha256:d4d67ae7a306adbae70a9f5c2d5ebea59a9c9e69173657f82f7ccfac9e6bccaf", "sha256:92869f54b6f72de6f456267afbad8502ec212c306e0bf119cc1c7093632ffabe",
    ]);
    for (const prompt of [ASK_STEP_PROMPT, ASK_SEARCH_ONLY_STEP_PROMPT]) expect(prompt).toContain('already converted to the request time_zone');
    // Research declares each need's kind, with an example of each; a list's id supports only the list kinds. Its examples name
    // nothing the research-loop evaluation asks about (tests/architecture/ask-kind-examples-eval-independence.test.ts).
    const [rule3, rule4] = [rule(ASK_STEP_PROMPT, 3), rule(ASK_STEP_PROMPT, 4)];
    expect(rule3).toMatch(/^3\. Give each need a kind\. "which_items": which or how many items exist in a source, or in a set of its items picked by a date, owner, status, kind or channel/u);
    for (const text of [
      "picked by a date, owner, status, kind or channel (\"tickets updated since Monday\", \"my open follow-ups\", \"my open tasks due this week\")",
      "\"which_say\": which members of such a picked set say something (\"which of the tickets updated since Monday mention the recall\")",
      "which items say something when the question picks no set by a date, owner, status, kind or channel (\"which pages mention the recall\": search finds them)",
      "(\"is the beta on hold\", \"who owns OPS-17\", \"when was the onboarding guide created\")",
      "Mark a which_items need \"found\" with the id of the list that answers it (such as L1, from lists). Give a which_say need the id of the list whose members it checks, whatever its status, and mark it \"found\" with that id and ids whose full text you have seen. Mark a content need \"found\" only with ids whose full text you have seen",
    ]) expect(rule3).toContain(text);
    expect([rule3.includes("For which items exist, and each one's title, dates, status and owner, a list's id"), rule(STEP_PROMPT, 3).includes("kind")]).toEqual([false, false]);
    expect([ASK_STEP_PROMPT, STEP_PROMPT].map(prompt => prompt.split("\n")[0])).toEqual([expect.stringContaining("then your plan, lists, last_results"), expect.stringContaining("then your plan, inventories, last_results")]);
    // Addition 6: early stopping never applies to which items exist; a which_say need reads what its list has shown.
    expect(rule4).toContain("A which_items need is supported once each list it cites has more false: a complete list supports all its items, and one that cannot be read to its end (complete is false) supports \"at least\" its count. A list shows which items exist, never what an item says: open an item for its content, and for a which_say need open as many of the list's members as you can; it need not wait for the list's end.");
    expect(rule4).not.toContain("A question about which or how many items exist");
    expect(rule4.endsWith("Stop as soon as every requested fact is supported: for a which_items need, once each list it cites has more false; for a which_say need, once you have seen the full text of every member its list has shown, or no other member can be opened.")).toBe(true);
    // Ask's tools never send research to open list members only to show that they exist.
    expect(line(ASK_STEP_PROMPT, "  Returns: the ids of up to 8 items")).toContain("Open those items before relying on what they say; a list's members need no open to show which items exist.");
    expect(line(ASK_STEP_PROMPT, "  When to use: before relying on")).toContain("before relying on what metadata-only items or incomplete previews say, or on a fact about one item; never only to show that a list's members exist or match its filter;");
    expect(line(STEP_PROMPT, "  Returns: the ids of up to 8 items")).toContain("no body means metadata only. Open those items before relying on them.");
    expect(rule(ASK_SEARCH_ONLY_STEP_PROMPT, 4).endsWith("then open the candidates. Stop as soon as every requested fact is supported.")).toBe(true);
    // The reply shape names all three kinds and shows none, so a model copying it copies no default; the example has one need of each.
    const shape = line(ASK_STEP_PROMPT, "{\"parts\":[{\"question\":\"<one part of the question>\"");
    expect(JSON.parse(shape).parts[0].needs).toEqual([{ id: "N1", need: "<a fact needed>", kind: "<which_items, which_say or content>", status: "open", evidence: [] }]);
    expect(ASK_STEP_PROMPT).toContain("A need's \"status\" is \"open\", \"found\" or \"not_found\". A need's \"kind\" is \"which_items\", \"which_say\" or \"content\". \"tool\" is");
    const example = JSON.parse(ASK_STEP_PROMPT.split("\n").at(-1)!) as { parts: { needs: { kind: string; evidence: string[] }[] }[] };
    expect(example.parts.flatMap(part => part.needs.map(need => [need.kind, need.evidence]))).toEqual([["which_items", ["L1"]], ["which_say", ["L1", "E3"]], ["content", ["E2"]]]);
    for (const prompt of [STEP_PROMPT, SEARCH_ONLY_STEP_PROMPT, ASK_SEARCH_ONLY_STEP_PROMPT]) expect(prompt).not.toMatch(/which_items|which_say|A need's "kind"|for a which_say need/u);
    for (const prompt of [ASK_STEP_PROMPT, ASK_SEARCH_ONLY_STEP_PROMPT]) expect([prompt.includes("You may stop early"), prompt.includes("instead of paging through it")]).toEqual([false, false]);
    for (const prompt of [STEP_PROMPT, SEARCH_ONLY_STEP_PROMPT]) expect(prompt).toContain("You may stop early when the facts the question asks for are already supported.");
    // Ask's argument and recovery clarifications are covered by agentic-ask-tool-contracts.test.ts.
    // Background prompts above remain byte-for-byte pinned; Ask keeps the same discovery tools and evidence rules.
    for (const prompt of [ASK_STEP_PROMPT, STEP_PROMPT]) for (const tool of ['search', 'open', 'list', 'finish']) expect(prompt).toContain(`${tool}, args`);
  });

  it("requires a need kind in Ask's step schema only with the list tool (ADR-0041)", () => {
    const needOf = (schema: Schema) => (((((schema.properties as Schema).parts as Schema).items as Schema).properties as Schema).needs as Schema).items as Schema;
    const kinded = needOf(createStepSchema(["pages", "tickets"], ["E1", "E2"], true, true, true));
    expect([Object.keys(kinded.properties as Schema), (kinded.properties as Schema).kind, kinded.required])
      .toEqual([["id", "need", "kind", "status", "evidence"], { type: "string", enum: ["which_items", "which_say", "content"] }, ["need", "kind", "status", "evidence"]]);
    // Without it, the schema is the one built at 026f60d, byte for byte.
    expect([createStepSchema(["pages", "tickets"], ["E1", "E2"], true, true), createStepSchema(["pages", "tickets"], ["E1", "E2"], true, true, false), createStepSchema(["pages"], undefined, false, false), stepSchema].map(schema => canonicalSha256(schema))).toEqual([
      "sha256:89777c72b01f93f9335b2ec8165befe2c15d8fe1f067c8a50753f0e216cb968f", "sha256:89777c72b01f93f9335b2ec8165befe2c15d8fe1f067c8a50753f0e216cb968f",
      "sha256:172f427c99d87ed7a210eba5972be0abdfc6c23d7d96271388934c6753231c3f", "sha256:d2903b4093e32c204330b6e39010d09ca1c2517f5902f6cf7250edd6d345401a",
    ]);
    // Every step the kinded schema permits parses, as every step the plain one does.
    for (let seed = 1; seed <= 200; seed += 1) {
      const value = generator(seed)(createStepSchema(["meetings"], ["E1"], true, true, true)) as { parts: { question: string }[]; actions: { tool: string; args: Record<string, string> }[] };
      const empty = (text: string) => text.trim().replace(/[\s\p{Cc}]+/gu, "").length === 0;
      const primary: Record<string, string> = { search: "query", open: "id", list: "source" };
      const blank = value.parts.some(part => empty(part.question)) || value.actions.some(action => action.tool !== "finish" && empty(action.args[primary[action.tool]!]!));
      if (blank) expect(() => parseStep(value, { lists: true, kinds: true })).toThrow(AgenticAskOutputErrorV1);
      else expect(() => parseStep(value, { lists: true, kinds: true })).not.toThrow();
    }
  });

  it("reads a need's kind in common spellings and defaults to content (ADR-0041)", () => {
    const kinds = (values: readonly unknown[], options: Parameters<typeof parseStep>[1]) => parseStep({
      parts: [{ question: "q", needs: [...values.map((kind, index) => ({ need: `n${index}`, ...(kind === undefined ? {} : { kind }), status: "open", evidence: [] })), "bare need"], notes: "" }], actions: [{ tool: "finish", args: {} }],
    }, options).parts[0]!.needs.map(need => "kind" in need ? need.kind : "none");
    // At most 6 needs a part: two parts' worth.
    expect(kinds(["which_items", "Which Items", "which-items", " WHICH_ITEMS ", "which_say"], { lists: true, kinds: true })).toEqual(["which_items", "which_items", "which_items", "which_items", "which_say", "content"]);
    expect(kinds(["Which-Say", "content", "list", "", 3], { lists: true, kinds: true })).toEqual(["which_say", "content", "content", "content", "content", "content"]);
    // Without kinds (a task goal, or Ask without the list tool) no need has a kind, whatever the model wrote.
    for (const options of [{ lists: true }, {}]) expect(kinds(["which_items"], options)).toEqual(["none", "none"]);
  });

  it("keeps list ids in a need's evidence only for Ask, within the 12-id cap", () => {
    const items = (from: number, count: number) => Array.from({ length: count }, (_, index) => `E${from + index}`);
    const need = (evidence: readonly string[], options?: Parameters<typeof parseStep>[1]) =>
      parseStep({ parts: [{ question: "q", needs: [{ need: "which pages", status: "found", evidence }], notes: "" }], actions: [{ tool: "finish", args: {} }] }, options).parts[0]!.needs[0]!.evidence;
    // A task goal, and every caller before ADR-0041, drops them; a list id after 12 item ids is never the one cut: research
    // cited the rows, was asked for the list's id, and appended it.
    const mixed = ["L1", "[l2]", " L 3 ", "E4", "4", "L1", "N1", "L0"];
    expect([need(mixed, { lists: true }), need(mixed), need([...items(1, 11), "L1", "L2"], { lists: true }).length, need([...items(1, 15), "L1"], { lists: true })])
      .toEqual([["L1", "L2", "L3", "E4"], ["E4"], 12, [...items(1, 11), "L1"]]);
    // A sentence's list ids support nothing (W1), so a list id takes no item's slot: the first 12 item ids stay wherever its
    // list ids stand, and the list ids beside them, which the writer's repair and the renderer read.
    const sentence = (evidence: readonly string[]) => parseAnswer({ sentences: [{ text: "x", evidence }], not_found: [] }).sentences[0]!.evidence;
    for (const [evidence, kept] of [
      [[...items(1, 13), "L2"], [...items(1, 12), "L2"]], [[...items(1, 12), "L1"], [...items(1, 12), "L1"]], [["L1", ...items(1, 12)], ["L1", ...items(1, 12)]],
      [[...items(1, 6), "L1", ...items(7, 7)], [...items(1, 6), "L1", ...items(7, 6)]], [["L1", "E2"], ["L1", "E2"]],
    ]) expect(sentence(evidence!)).toEqual(kept);
    // The same twelve items whatever the list ids' positions.
    for (const evidence of [["L1", ...items(9, 11), "E1"], [...items(9, 11), "E1", "L1"], [...items(9, 5), "L1", ...items(14, 6), "E1"]]) {
      expect(sentence(evidence).filter(id => id.startsWith("E"))).toEqual([...items(9, 11), "E1"]);
    }
  });

  it("reads the lists Ask's answer uses: each once in full or by an owner or status selection, and once by members' ids", () => {
    const parsed = parseAnswer({
      lists: ["l2", { id: "L1" }, { id: "[L3]", where: { field: "Owner", value: " Dana  Lee " } }, { id: "L1", where: { field: "owner", value: "x" } },
        { id: "L4", where: { field: "title", value: "PRD" } }, { id: "L5", where: { field: "status", value: " " } }, { id: "E6" }, 7, { id: "L8" }, { id: "L9" }],
      sentences: [{ text: "Two pages mention BUG-412 (L1, E4).", evidence: ["L1", "E4"] }], not_found: [],
    });
    expect([parsed.lists, parsed.sentences, parseAnswer({ sentences: [], not_found: [] }).lists]).toEqual([
      [{ id: "L2" }, { id: "L1" }, { id: "L3", where: { field: "owner", value: "Dana Lee" } }, { id: "L4" }, { id: "L5" }], [{ text: "Two pages mention BUG-412.", evidence: ["L1", "E4"] }], [],
    ]);
    // Members selected by id take the place of a selection, each once and at most 25; none left keeps the plain use.
    const members = parseAnswer({ lists: [
      { id: "L1", members: ["e5", "E5", "[E7]", "L2", 9], where: { field: "owner", value: "Dana" } }, { id: "L2", members: ["x"], where: { field: "status", value: "open" } },
      { id: "L3", members: Array.from({ length: 30 }, (_, index) => `E${index + 1}`) },
    ], sentences: [], not_found: [] }).lists;
    expect(members).toEqual([{ id: "L1", members: ["E5", "E7", "E9"] }, { id: "L2", where: { field: "status", value: "open" } }, { id: "L3", members: Array.from({ length: 25 }, (_, index) => `E${index + 1}`) }]);
    // A list may be used once in full or by a selection and once by id, in the writer's order; still at most 5 lists.
    expect(parseAnswer({ lists: [
      { id: "L1", members: ["E5"] }, { id: "L1" }, { id: "L1", where: { field: "owner", value: "Dana" } }, { id: "L1", members: ["E6"] },
      { id: "L2" }, { id: "L3" }, { id: "L4" }, { id: "L5" }, { id: "L6" }, { id: "L5", members: ["E2"] },
    ], sentences: [], not_found: [] }).lists).toEqual([{ id: "L1", members: ["E5"] }, { id: "L1" }, { id: "L2" }, { id: "L3" }, { id: "L4" }, { id: "L5" }, { id: "L5", members: ["E2"] }]);
    // A list reference in prose is stripped only for Ask's answer; elsewhere "(L2)" stays prose.
    expect([stripEvidenceIds("Support tier (L2) owns it (E4)."), stripEvidenceIds("Support tier owns it (L2) [E4, L1].", true)]).toEqual(["Support tier (L2) owns it.", "Support tier owns it."]);
  });

  it.each([
    [{ field: "due", since: "2026-10-18", until: "2026-10-24" }, { field: "due", since: "2026-10-18", until: "2026-10-24" }], [{ field: "Updated", since: " 2026-10-11 " }, { field: "updated", since: "2026-10-11" }],
    [{ field: "created", until: "2026-10-04", value: "x" }, { field: "created", until: "2026-10-04" }], [{ field: "occurred", since: "2026-10-04", until: "2026-10-04" }, { field: "occurred", since: "2026-10-04", until: "2026-10-04" }],
    // A date field with no bound, a bound that is not a real day, or a reversed range: the list in full.
    [{ field: "due" }, undefined], [{ field: "due", value: "2026-10-18" }, undefined], [{ field: "received", since: "2026-02-30" }, undefined], [{ field: "due", since: "next week" }, undefined],
    [{ field: "due", until: "2026-10-18T00:00:00Z" }, undefined], [{ field: "due", since: "2026-10-24", until: "2026-10-18" }, undefined], [{ field: "due", since: "2026-10-18", until: "soon" }, undefined],
    // An owner or status reads its value, as before; an empty one is the list in full.
    [{ field: "status", value: " Open ", since: "2026-10-18" }, { field: "status", value: "Open" }], [{ field: "owner", value: "" }, undefined], [{ field: "title", value: "PRD" }, undefined],
  ])("reads a where selection %j as %j, anything else as the list in full (ADR-0041)", (value, where) => {
    expect(parseAnswer({ lists: [{ id: "L1", where: value }], sentences: [], not_found: [] }).lists[0]).toEqual({ id: "L1", ...(where === undefined ? {} : { where }) });
  });

  it("names each selection field, and either bound, in the answer schema (ADR-0041)", () => {
    const listUse = ((answerSchema.properties as Schema).lists as Schema).items as Schema;
    expect((listUse.properties as Schema).where).toEqual({ type: "object", additionalProperties: false, required: ["field"], properties: {
      field: { type: "string", enum: ["owner", "status", "due", "created", "updated", "received", "occurred"] }, value: { type: "string", maxLength: 120 }, since: { type: "string", maxLength: 10 }, until: { type: "string", maxLength: 10 },
    } });
  });

  it("binds each action's argument schema to the selected tool", () => {
    const argumentsByTool: Record<string, readonly string[]> = {
      search: ["query", "source", "since", "until", "date_field"], open: ["id"],
      list: ["source", "kind", "status", "owner", "channel", "since", "until", "date_field"], finish: [],
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
      .toEqual({ sentences: [{ text: "Done.", evidence: ["E2", "E3"] }], not_found: ["owner"], lists: [] });
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

  it("reads a need's id in common spellings, ignores the rest, and drops a second need with the same id", () => {
    const step = parseStep({ parts: [{ question: "q", needs: [
      { id: "N1", need: "A", status: "open", evidence: [] }, { id: " n2 ", need: "B", status: "open", evidence: [] }, { id: "[N3]", need: "C", status: "open", evidence: [] },
      { id: 4, need: "D", status: "open", evidence: [] }, { id: "E5", need: "E", status: "open", evidence: [] }, { id: "N1", need: "F", status: "found", evidence: [] },
    ], notes: "" }], actions: [{ tool: "finish", args: {} }] });
    expect(step.parts[0]!.needs.map(need => [need.id, need.need])).toEqual([["N1", "A"], ["N2", "B"], ["N3", "C"], ["N4", "D"], [undefined, "E"]]);
    expect(step.parts[0]!.needs[4]).not.toHaveProperty("id");
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

  it.each([
    // f6184afc and 1dab4548: the writer's markers that reached the answer.
    ["The release is proposed (evidence: E5).", "The release is proposed."],
    ["The gate is on hold (evidence).", "The gate is on hold."],
    ["Both tickets are open (evidence E2, E4), and the vendor slipped (Evidence: E7; E9).", "Both tickets are open, and the vendor slipped."],
    ["Mara owns it (ids E1).", "Mara owns it."],
    ["It was approved (see E3) on Oct 8 (E4, E5, and E6).", "It was approved on Oct 8."],
  ])("drops evidence references from %j", (text, expected) => {
    expect(stripEvidenceIds(text)).toBe(expected);
  });

  it("keeps brackets and words that are not evidence references", () => {
    for (const text of [
      "THERM-48 (THERM-48) still formats one decimal.",
      "The E2E tests (E2E) passed on Oct 8.",
      "The gate is pending (no evidence of approval).",
      "The badge shows the employee number (ID).",
      "Model E12 ships in October.",
    ]) expect(stripEvidenceIds(text), text).toBe(text);
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
