import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { STEP_PROMPT, TASK_RULE_PROMPT } from "../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import { agenticStartingSlotV1, fillAgenticTaskV1, type AgenticBriefV1 } from "../../src/answer-composition/agentic-brief-v1.js";
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, AGENTIC_RESEARCH_BUDGETS_V1, AGENTIC_RESEARCH_LIVE_BUDGET_V1 } from "../../src/answer-composition/agentic-research-v1.js";
import { AGENTIC_TRIGGER_DEFINITIONS_V1, AGENTIC_TRIGGER_NAMES_V1 } from "../../src/answer-composition/agentic-trigger-definitions-v1.js";
import { IMPACT_CARD_RENDERER_V1 } from "../../src/answer-composition/renderers/impact-card-renderer-v1.js";

const record = { kind: "approved_record", atom_id: canonicalSha256("atom"), record_sha256: canonicalSha256("record"), policy_id: "organization-member-readable-person-v2" };
const ticket = { kind: "ticket", tool_id: "jira", external_scope_id: "cloud-1", ticket_id: "10046", permalink: "https://therm.example.test/browse/THERM-46", text_sha256: canonicalSha256("ticket") };
const page = { kind: "page", tool_id: "confluence", external_scope_id: "cloud-1", page_id: "1441793", section_id: "s1", version: "3", permalink: "https://therm.example.test/wiki/pages/viewpage.action?pageId=1441793", text_sha256: canonicalSha256("page") };

const definition = (name: string) => {
  const found = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === name);
  if (found === undefined) throw new Error(`no ${name} definition`);
  return found;
};
const brief = (name: string, input: unknown) => { const value = definition(name); return value.brief(value.parseEvent(input)); };
/** A task brief's goal as the model sees it, with its starting ids. */
const filled = (value: AgenticBriefV1, ids: readonly (string | null)[]) => value.goal.kind === "task" ? fillAgenticTaskV1(value.goal.task, ids, value.goal.data) : "";
const refused = (name: string, input: unknown) => {
  expect(() => definition(name).parseEvent(input), JSON.stringify(input)).toThrow(expect.objectContaining({ name: "AuthorityOperationError", code: "invalid_request" }));
};

describe("trigger definitions", () => {
  it("defines Ask, the approved record (which replaced Check) and Sweep; audit records name every one but Ask", () => {
    expect(AGENTIC_TRIGGER_DEFINITIONS_V1.map(value => value.name)).toEqual(["ask", "approved_record", "sweep"]);
    expect(AGENTIC_TRIGGER_NAMES_V1).toEqual(["approved_record", "sweep"]);
    for (const value of AGENTIC_TRIGGER_DEFINITIONS_V1) {
      expect(value.name).toMatch(/^[a-z_]{1,64}$/u);
      expect(value.recipients).toBe("actor_only");
    }
    expect(definition("ask")).toMatchObject({ acts_as: "requester", scope: "requested" });
    expect(definition("sweep")).toMatchObject({ acts_as: "requester", scope: "requested" });
    expect(definition("approved_record")).toMatchObject({ acts_as: "approver", scope: "record_project" });
    // The approved record renders an impact card; Ask's writer is composed by the runner, and Sweep is research only.
    expect(definition("approved_record").renderer).toBe(IMPACT_CARD_RENDERER_V1);
    expect(definition("ask").renderer).toBeUndefined();
    expect(definition("sweep").renderer).toBeUndefined();
  });

  it("runs each brief on its definition's budget profile, from one label-to-budget table", () => {
    expect(AGENTIC_RESEARCH_BUDGETS_V1).toEqual({ live: AGENTIC_RESEARCH_LIVE_BUDGET_V1, background: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1 });
    const events: Record<string, unknown> = { ask: { question: "Why is DVT on hold?" }, approved_record: { record }, sweep: { findings: [{ finding: "f", expected: "e", citations: [ticket] }] } };
    for (const value of AGENTIC_TRIGGER_DEFINITIONS_V1) expect(brief(value.name, events[value.name]).budget, value.name).toBe(AGENTIC_RESEARCH_BUDGETS_V1[value.budget]);
    expect(definition("ask").budget).toBe("live");
    expect(definition("approved_record").budget).toBe("background");
    expect(definition("sweep").budget).toBe("background");
  });
});

describe("Ask definition", () => {
  it("passes the question through as asked, with no starting evidence and the small-scope preload", () => {
    expect(brief("ask", { question: "Why is the DVT gate on hold?" })).toEqual({
      goal: { kind: "question", question: "Why is the DVT gate on hold?" }, starting: [], budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1, options: { small_scope_preload: true },
    });
  });

  it("applies the product question limits", () => {
    for (const input of [{ question: "x ".repeat(130).trim() }, { question: " padded" }, { question: "q", extra: true }, {}, "Why?", null]) refused("ask", input);
  });
});

describe("Approved record definition", () => {
  it("starts from the approved record, fails closed, and gives the spec's task with the record's id in its slot", () => {
    const value = brief("approved_record", { record });
    expect(value).toEqual({
      goal: { kind: "task", task: expect.any(String) }, starting: [{ citation: record, if_unreadable: "fail" }],
      budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, options: { small_scope_preload: false },
    });
    expect(filled(value, ["E1"])).toBe("A PM just approved record E1. Find every ticket, PRD section and document in this project that it confirms, conflicts with or changes. For each, record what it says now, who owns it, and any date it affects.");
  });

  it("refuses anything but one approved record citation", () => {
    for (const input of [{ record: ticket }, { record: page }, { record: { ...record, atom_id: "nope" } }, { record, extra: 1 }, {}, [record], null]) refused("approved_record", input);
  });
});

describe("Sweep definition", () => {
  const findings = [
    { finding: "Firmware formats two decimals", expected: "SW-22b updated", citations: [ticket] },
    { finding: "Test case expects \"two\" decimals", expected: "TC-D-06 updated", citations: [page, ticket, record] },
  ];

  it("reports unreadable starting items, reads each cited item once, and lists each finding with its items' ids", () => {
    const value = brief("sweep", { findings });
    expect(value.starting).toEqual([{ citation: ticket, if_unreadable: "report" }, { citation: page, if_unreadable: "report" }, { citation: record, if_unreadable: "report" }]);
    expect(value).toMatchObject({ budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, options: { small_scope_preload: false } });
    const task = filled(value, ["E1", null, "E3"]);
    expect(task).toContain('1. "Firmware formats two decimals" Expected: "SW-22b updated". Cited then: E1.');
    expect(task).toContain('2. "Test case expects \\"two\\" decimals" Expected: "TC-D-06 updated". Cited then: an item that could not be read, E1, E3.');
    // What the removed Sweep paragraph said.
    for (const phrase of ["Make each finding one part", "current state, and any newer item about the same change", "Never treat a finding as resolved without reading the current item", "An item that could not be read is not evidence that anything changed"]) expect(task).toContain(phrase);
  });

  it("never reads a finding's own text as template: a slot written in it reaches the model as typed", () => {
    const value = brief("sweep", { findings: [{ finding: `Ship ${agenticStartingSlotV1(1)} first`, expected: `${agenticStartingSlotV1(2)} done`, citations: [ticket] }] });
    expect(value.starting).toEqual([{ citation: ticket, if_unreadable: "report" }]);
    expect(value.goal.kind === "task" && value.goal.task).not.toContain("Ship");
    expect(filled(value, ["E7"])).toContain('1. "Ship {{starting:1}} first" Expected: "{{starting:2}} done". Cited then: E7.');
  });

  it("refuses empty, unbounded or malformed findings", () => {
    const one = findings[0]!;
    for (const input of [
      { findings: [] }, { findings: Array.from({ length: 21 }, () => one) }, { findings: [{ ...one, citations: [] }] },
      { findings: [{ ...one, citations: Array.from({ length: 13 }, () => ticket) }] }, { findings: [{ ...one, note: "x" }] },
      { findings: [{ ...one, finding: " " }] }, { findings: [{ ...one, expected: "two\nlines" }] }, { findings: [{ ...one, citations: [{ kind: "ticket" }] }] },
      { findings: [one], extra: true }, {},
    ]) refused("sweep", input);
  });
});

describe("task-form goals share one rule", () => {
  it("adds one paragraph to the step prompt, whatever the trigger", () => {
    expect(TASK_RULE_PROMPT).toBe("There is no question from a person; the task below replaces it.");
    expect(STEP_PROMPT).not.toContain(TASK_RULE_PROMPT);
  });
});
