import { citationFor, meetingCitation } from "./bindings.mjs";

/** The staging start request for one case (organization API `PersonResearchEvalStartRequestV1`). */
export function startRequest(testCase, bindings, budget = testCase.budget) {
  const scope = testCase.scope?.kind === "project" ? { project_id: bindings.project_id } : {};
  if (testCase.scope?.kind === "project" && typeof bindings.project_id !== "string") throw new Error("bindings need the THERM project id");
  const base = { schema_version: 1, budget, ...scope };
  if (testCase.trigger === "ask") return { ...base, trigger: "ask", question: testCase.question };
  if (testCase.trigger === "check") return { ...base, trigger: "check", record: meetingCitation(bindings, testCase.record.meeting, "decision") };
  return { ...base, trigger: "sweep", findings: testCase.findings.map(finding => ({
    finding: finding.finding, expected: finding.expected, citations: finding.citations.map(ref => citationFor(bindings, ref)),
  })) };
}

/** How long to keep polling: the run's own deadline plus margin for the read. */
export function pollDeadlineMs(budget) {
  return (budget === "live" ? 90_000 : 300_000) + 60_000;
}
