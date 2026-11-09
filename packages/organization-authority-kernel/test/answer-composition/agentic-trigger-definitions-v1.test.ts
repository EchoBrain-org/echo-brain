import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { STEP_PROMPT, TASK_RULE_PROMPT } from "../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import { fillAgenticTaskV1, type AgenticBriefV1 } from "../../src/answer-composition/agentic-brief-v1.js";
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, AGENTIC_RESEARCH_BUDGETS_V1, AGENTIC_RESEARCH_LIVE_BUDGET_V1 } from "../../src/answer-composition/agentic-research-v1.js";
import { AGENTIC_TRIGGER_DEFINITIONS_V1, AGENTIC_TRIGGER_NAMES_V1 } from "../../src/answer-composition/agentic-trigger-definitions-v1.js";
import { IMPACT_CARD_RENDERER_V1 } from "../../src/answer-composition/renderers/impact-card-renderer-v1.js";

const record = { kind: "approved_record", atom_id: canonicalSha256("atom"), record_sha256: canonicalSha256("record"), policy_id: "project-members-readable-person-v1" };
const ticket = { kind: "ticket", tool_id: "jira", external_scope_id: "cloud-1", ticket_id: "10046", permalink: "https://therm.example.test/browse/THERM-46", text_sha256: canonicalSha256("ticket") };
const page = { kind: "page", tool_id: "confluence", external_scope_id: "cloud-1", page_id: "1441793", section_id: "s1", version: "3", permalink: "https://therm.example.test/wiki/pages/viewpage.action?pageId=1441793", text_sha256: canonicalSha256("page") };

const definition = (name: string) => {
  const found = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === name);
  if (found === undefined) throw new Error(`no ${name} definition`);
  return found;
};
const PROJECT = { kind: "project", project_id: "prj_00000000-0000-4000-8000-000000000001" } as const;
const brief = (name: string, input: unknown, scope: { readonly kind: "global" | "project" } = PROJECT) => { const value = definition(name); return value.brief(value.parseEvent(input), scope); };
/** A task brief's goal as the model sees it, with its starting ids. */
const filled = (value: AgenticBriefV1, ids: readonly (string | null)[]) => value.goal.kind === "task" ? fillAgenticTaskV1(value.goal.task, ids, value.goal.data) : "";
const refused = (name: string, input: unknown) => {
  expect(() => definition(name).parseEvent(input), JSON.stringify(input)).toThrow(expect.objectContaining({ name: "AuthorityOperationError", code: "invalid_request" }));
};

describe("trigger definitions", () => {
  it("defines Ask and the approved record (which replaced Check; Sweep is retired); audit records name every one but Ask", () => {
    expect(AGENTIC_TRIGGER_DEFINITIONS_V1.map(value => value.name)).toEqual(["ask", "approved_record"]);
    expect(AGENTIC_TRIGGER_NAMES_V1).toEqual(["approved_record"]);
    for (const value of AGENTIC_TRIGGER_DEFINITIONS_V1) expect(value.name).toMatch(/^[a-z_]{1,64}$/u);
    expect(definition("ask")).toMatchObject({ scope: "requested" });
    expect(definition("approved_record")).toMatchObject({ scope: "record_project" });
    // The approved record renders an impact card; Ask's writer is composed by the runner.
    expect(definition("approved_record").renderer).toBe(IMPACT_CARD_RENDERER_V1);
    expect(definition("ask").renderer).toBeUndefined();
  });

  it("runs each brief on its definition's budget profile, from one label-to-budget table", () => {
    expect(AGENTIC_RESEARCH_BUDGETS_V1).toEqual({ live: AGENTIC_RESEARCH_LIVE_BUDGET_V1, background: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1 });
    const events: Record<string, unknown> = { ask: { question: "Why is DVT on hold?" }, approved_record: { record } };
    for (const value of AGENTIC_TRIGGER_DEFINITIONS_V1) expect(brief(value.name, events[value.name]).budget, value.name).toBe(AGENTIC_RESEARCH_BUDGETS_V1[value.budget]);
    expect(definition("ask").budget).toBe("live");
    expect(definition("approved_record").budget).toBe("background");
  });
});

describe("Ask definition", () => {
  it("passes the question through as asked, with no starting evidence", () => {
    expect(brief("ask", { question: "Why is the DVT gate on hold?" })).toEqual({
      goal: { kind: "question", question: "Why is the DVT gate on hold?" }, starting: [], budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1, options: {},
    });
  });

  it("applies the product question limits", () => {
    for (const input of [{ question: "x ".repeat(130).trim() }, { question: " padded" }, { question: "q", extra: true }, {}, "Why?", null]) refused("ask", input);
  });
});

describe("Approved record definition", () => {
  it("starts from the approved record, fails closed, and gives a research-only task with the record's id in its slot", () => {
    const value = brief("approved_record", { record });
    expect(value).toEqual({
      goal: { kind: "task", task: expect.any(String) }, starting: [{ citation: record, if_unreadable: "fail" }],
      budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, options: {},
    });
    expect(filled(value, ["E1"])).toBe("A PM just approved record E1. Find the tickets, PRD sections and documents in this project whose current text its decisions confirm, contradict or make out of date. Search the record's distinctive terms and identifiers, then open the candidates and note what each says now. Finishing with nothing affected is a valid result after those searches.");
    // The impact card adds owners and dates from each item's own details: research never looks for them.
    for (const phrase of ["who owns", "date it affects"]) expect(filled(value, ["E1"])).not.toContain(phrase);
  });

  it("searches a record in no project, never lists, and never says \"in this project\" (decision 2)", () => {
    const value = brief("approved_record", { record }, { kind: "global" });
    expect(value.options).toEqual({ list: false });
    expect(filled(value, ["E1"])).toBe("A PM just approved record E1. Find the tickets, PRD sections and documents whose current text its decisions confirm, contradict or make out of date. Search the record's distinctive terms and identifiers, then open the candidates and note what each says now. Finishing with nothing affected is a valid result after those searches.");
  });

  it("refuses anything but one approved record citation", () => {
    for (const input of [{ record: ticket }, { record: page }, { record: { ...record, atom_id: "nope" } }, { record, extra: 1 }, {}, [record], null]) refused("approved_record", input);
  });
});

describe("task-form goals share one rule", () => {
  it("adds one paragraph to the step prompt, whatever the trigger", () => {
    expect(TASK_RULE_PROMPT).toBe("There is no question from a person; the task below replaces it.");
    expect(STEP_PROMPT).not.toContain(TASK_RULE_PROMPT);
  });
});
