/**
 * Core-stage approval wiring on the first-party in-app review.
 *
 * The benchmark stops at the authenticated-action boundary. A real Person
 * session authenticates the reviewer, then the production in-app review
 * (`createPersonMeetingReviewV1`) does everything after it: the stable
 * reviewer and frozen-snapshot checks, the durable action, the signed V4
 * record append and the policy-fact projection. No HTTP route, OIDC client or
 * provider runs, and nothing here simulates a card, a transport signature or a
 * delivery.
 */
import { randomUUID } from "node:crypto";
import { bindApprovalWorkflowStateV1 } from "../../../packages/organization-processing/dist/admitted-meeting-processing/approval-workflow-state-v1.js";
import { SqliteProjectContextRepositoryV1 } from "../../../services/organization-authority/dist/adapters/persistence/sqlite/project-context-v1.js";
import { createProjectContextApplicationV1 } from "../../../services/organization-authority/dist/application/project-context-application-v1.js";
import { createPersonMeetingReviewV1, personMeetingReviewTextV1 } from "../../../services/organization-authority/dist/composition/person-meeting-review-v1.js";
import { personToolAuthenticationV1 } from "../../../services/organization-authority/dist/composition/person-tool-authentication-v1.js";

/** The two audiences an approving person can choose: only themselves, or the members of one project. */
export const CORE_APPROVAL_POLICIES = Object.freeze({
  restricted: "restricted-reviewer-person-v2",
  project: "project-members-readable-person-v1",
});

function identifier(value, label) {
  // The review's command id is 1-128 characters.
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError(`${label} must be a canonical identifier`);
  }
  return value;
}

function nonEmptyText(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function person(value, role) {
  if (value === undefined) {
    if (role === "employee") return undefined;
    throw new TypeError("owner is required");
  }
  return Object.freeze({
    access_token: nonEmptyText(value.access_token, `${role}.access_token`),
    principal_id: identifier(value.principal_id, `${role}.principal_id`),
    membership_id: identifier(value.membership_id, `${role}.membership_id`),
  });
}

/**
 * Seed the shared audience before the offer loop: one project the owner leads
 * and the employee belongs to, created through the real project application.
 */
function createAudienceProject({ database, sessions, owner, employee }) {
  const projects = createProjectContextApplicationV1({
    authenticate: (access_token) => sessions.authenticateAccess({ access_token }),
    repository: new SqliteProjectContextRepositoryV1(database),
  });
  const { project_id } = projects.createProject(owner.access_token, {
    schema_version: 1, kind: "echo-project-create-v1", request_id: randomUUID(), name: "Core audience",
  });
  if (employee !== undefined) {
    projects.addMember(owner.access_token, {
      schema_version: 1, kind: "echo-project-member-add-v1", request_id: randomUUID(), project_id, membership_id: employee.membership_id,
    });
  }
  return project_id;
}

/**
 * Build the core-only approval lane over the admitted personal source in
 * `input`. The caller stages a real frozen candidate through `stager`, then
 * hands one authenticated action to `offerApproval`. The review's post-commit
 * wake (`context.on_terminal_action_queued`) requests publication after the
 * durable action exists; the shared worker drives `processing`.
 */
export async function createCoreApproval({ context, input, owner, employee, sessions } = {}) {
  if (context === null || typeof context !== "object") throw new TypeError("context is required");
  if (typeof input?.source_key !== "string" || typeof input.intake?.currentPerson !== "function") {
    throw new TypeError("input must be the admitted core personal source");
  }
  if (typeof sessions?.authenticateAccess !== "function") throw new TypeError("real Person sessions are required");
  for (const field of ["authority_database", "state", "record_append", "signer", "next_envelope_id"]) {
    if (context[field] === undefined) throw new TypeError(`context.${field} is required`);
  }
  const ownerActor = person(owner, "owner");
  const employeeActor = employee === undefined ? undefined : person(employee, "employee");
  const database = context.authority_database;
  const authenticate = personToolAuthenticationV1(sessions);
  const audience_project_id = createAudienceProject({ database, sessions, owner: ownerActor, employee: employeeActor });
  const projectOf = (policy_id) => {
    if (policy_id === CORE_APPROVAL_POLICIES.restricted) return null;
    if (policy_id === CORE_APPROVAL_POLICIES.project) return audience_project_id;
    throw new TypeError("policy_id is unsupported");
  };

  const review = await createPersonMeetingReviewV1(database, {
    state: bindApprovalWorkflowStateV1(context.state, () => {
      if (database.inTransaction) throw new Error("Meeting review state transaction must be idle");
    }),
    record_append: context.record_append,
    signer: context.signer,
    coordinates: context.coordinates,
    next_envelope_id: context.next_envelope_id,
    ...(context.on_terminal_action_queued === undefined ? {} : { on_terminal_action_queued: context.on_terminal_action_queued }),
  }, input.source_key);

  return Object.freeze({
    stager: review.stager,
    processing: review.processing,
    audience_project_id,
    /** What the person is shown for a staged proposal, or undefined until it is staged. */
    readPresentation(approval_id) {
      const outbox = context.state.readCandidateByApprovalId(identifier(approval_id, "approval_id"));
      if (outbox === undefined || outbox.state !== "staged" || outbox.approved_snapshot_json === null) return undefined;
      return personMeetingReviewTextV1(outbox.approved_snapshot_json);
    },
    /**
     * One reviewer's approve action, with the audience their policy names.
     * `offer_id` is the idempotency key: replaying it returns the original
     * outcome, and reusing it for another action is refused by the review.
     */
    async offerApproval({ approval_id, actor: role = "owner", policy_id, offer_id } = {}) {
      identifier(approval_id, "approval_id");
      const command_id = identifier(offer_id, "offer_id");
      const project_id = projectOf(policy_id);
      const reviewer = role === "owner" ? ownerActor : role === "employee" ? employeeActor : undefined;
      if (reviewer === undefined) throw new TypeError("actor must name a configured owner or employee");
      const frozen = context.state.readFrozenCandidateForApproval(approval_id);
      if (frozen?.approved_snapshot_sha256 == null) throw new Error("approval must be durably staged before an action is offered");
      // The same re-check the HTTP route runs at each fence: a current session,
      // an active membership and a current grant on the chosen project.
      const authorize = () => {
        const authorization = authenticate(reviewer.access_token);
        input.intake.currentPerson({
          organization_id: authorization.organization_id, principal_id: authorization.principal_id, membership_id: authorization.membership_id,
        }, project_id);
        return authorization;
      };
      const authorization = authorize();
      if (authorization.principal_id !== reviewer.principal_id || authorization.membership_id !== reviewer.membership_id) {
        throw new Error("authenticated Person actor does not match the offered action");
      }
      const replayed = database.prepare("SELECT count(*) FROM authority_person_meeting_approval_actions_v1 WHERE approval_id = ? OR command_id = ?")
        .pluck().get(approval_id, command_id) > 0;
      const result = review.resolve({
        command_id, approval_id, snapshot_sha256: frozen.approved_snapshot_sha256, action: "approve", project_id, share_transcript: false,
      }, authorize);
      return Object.freeze({ ...result, idempotent: replayed });
    },
  });
}
