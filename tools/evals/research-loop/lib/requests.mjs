import { CaseNotStartableError, citationFor, meetingCitation } from "./bindings.mjs";

/**
 * The staging start request for one case (organization API
 * `PersonResearchEvalStartRequestV1`): the trigger's name and its input. An
 * approved record's run reads where its record is, so its request names no scope.
 */
export function startRequest(testCase, bindings, budget = testCase.budget) {
  const scope = testCase.scope?.kind === "project" ? { project_id: bindings.project_id } : {};
  if (testCase.scope?.kind === "project" && typeof bindings.project_id !== "string") throw new CaseNotStartableError("bindings need the THERM project id");
  return { schema_version: 1, trigger: testCase.trigger, input: triggerInput(testCase, bindings), budget, ...scope };
}

function triggerInput(testCase, bindings) {
  if (testCase.trigger === "ask") return { question: testCase.question };
  if (testCase.trigger === "approved_record") return { record: meetingCitation(bindings, testCase.record.meeting, "decision") };
  return { findings: testCase.findings.map(finding => ({
    finding: finding.finding, expected: finding.expected, citations: finding.citations.map(ref => citationFor(bindings, ref)),
  })) };
}

/** A start the client or the Authority refused as invalid, such as an overlong question: rejected at ingress, as in the product. */
export function rejectedAtIngress(error) {
  return error?.name === "PersonQueryInputError" || error?.name === "OrganizationApiValidationError" || error?.code === "invalid_request";
}

/** The trimmed bundle's fields (`AgenticResearchResultV1`); anything else in a read, such as server records, is never saved. */
const TRIMMED_BUNDLE = ["schema_version", "kind", "trigger", "goal", "budget", "plan", "items", "unreadable_starting", "rounds", "coverage", "stop", "cost"];

/** What a saved run keeps of a read: its status, the trimmed bundle, and Ask's answer or the rendered result. */
export function savedResult(read) {
  const research = read.research === undefined ? undefined : Object.fromEntries(TRIMMED_BUNDLE.filter(key => Object.hasOwn(read.research, key)).map(key => [key, read.research[key]]));
  return {
    status: read.status,
    ...(research === undefined ? {} : { research }),
    ...(read.ask === undefined ? {} : { ask: read.ask }),
    ...(read.rendered === undefined ? {} : { rendered: read.rendered }),
    ...(read.error === undefined ? {} : { error: read.error }),
  };
}

/** How long to keep polling: the run's own deadline plus margin for the read. */
export function pollDeadlineMs(budget) {
  return (budget === "live" ? 90_000 : 300_000) + 60_000;
}
