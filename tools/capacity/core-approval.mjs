/**
 * Core-stage private approval wiring.
 *
 * The benchmark deliberately stops at the verified-action boundary.  A
 * deterministic driver supplies a normalized action receipt to the durable
 * control-plane queue; it never simulates Slack HTTP, Block Kit, or HMAC.
 * Everything after that boundary is the production private-approval path:
 * current-card checks, the stable Authority fence, terminal evidence, V4
 * record append, and the terminal presentation projection.
 */
import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  SqliteSlackDmApprovalPersistenceV1,
  validateOrganizationToolConnectionStateV2,
} from "@echo-brain/organization-control-plane/slack-approval-integration-v1";
import {
  buildExternalHumanIdentityLinkContractV2,
  buildOrganizationToolConnectionContractV2,
} from "../../packages/organization-control-plane/dist/application/person-slack-reaction-approval-contracts-v2.js";
import {
  PrivateSlackDmApprovalStagerV1,
} from "../../services/organization-authority/dist/composition/providers/slack/private-approval/private-slack-dm-approval-stager-v1.js";
import {
  PrivateSlackApprovalTerminalCoordinatorV1,
} from "../../services/organization-authority/dist/composition/providers/slack/private-approval/private-slack-approval-terminal-coordinator-v1.js";
import {
  resolveCurrentPrivateSlackConnectionV1,
} from "../../services/organization-authority/dist/composition/providers/slack/private-approval/resolve-current-private-slack-connection-v1.js";
import {
  resolveMeetingOwnerPrivateSlackApprovalReviewerV1,
} from "../../services/organization-authority/dist/composition/providers/slack/private-approval/resolve-meeting-owner-private-slack-approval-reviewer-v1.js";
import {
  SqlitePrivateSlackApprovalAssignmentStateV1,
} from "../../services/organization-authority/dist/composition/providers/slack/private-approval/sqlite-private-slack-approval-assignment-state-v1.js";
import {
  SqlitePrivateSlackApprovalTerminalAuthorityV1,
} from "../../services/organization-authority/dist/composition/providers/slack/private-approval/sqlite-private-slack-approval-terminal-authority-v1.js";
import {
  SqliteStablePrivateApprovalAuthorityFenceV1,
} from "../../services/organization-authority/dist/composition/providers/slack/private-approval/sqlite-stable-private-approval-authority-fence-v1.js";
import {
  createPrivateSlackBlockV4RecordWriterV1,
} from "../../services/organization-authority/dist/processing/adapters/approval-resolution/slack/private-slack-block-v4-record-writer-v1.js";

const SCOPES = Object.freeze([
  "channels:history", "channels:read", "chat:write", "im:history",
  "im:write", "reactions:read", "users:read",
]);
const CONNECTION_ID = "con_core_approval";
const WORKSPACE_ID = "TCOREAPPROVAL";
const APP_ID = "ACOREAPPROVAL";
const BOT_ID = "BCOREAPPROVAL";
const BOT_USER_ID = "UCOREAPPBOT";
const OWNER_LINK_ID = "clm_core_owner";
const EMPLOYEE_LINK_ID = "clm_core_employee";
const OWNER_SUBJECT = "UCOREOWNER";
const EMPLOYEE_SUBJECT = "UCOREEMPLOYEE";
const DM_CHANNEL = "DCOREAPPROVAL";

function requiredText(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new TypeError(`${label} must be a canonical identifier`);
  }
  return value;
}

function canonicalTime(value, label = "now") {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be canonical UTC`);
  }
  return value;
}

function nowSource(value) {
  const now = value ?? (() => new Date().toISOString());
  if (typeof now !== "function") throw new TypeError("context.now must be a function");
  return () => canonicalTime(now(), "context.now()");
}

function actor(input, role) {
  const value = input?.[role];
  if (value === undefined) {
    if (role === "employee") return undefined;
    throw new TypeError("owner is required");
  }
  return Object.freeze({
    principal_id: requiredText(value.principal_id, `${role}.principal_id`),
    membership_id: requiredText(value.membership_id, `${role}.membership_id`),
    provider_subject_id: requiredText(
      value.provider_subject_id ?? (role === "owner" ? OWNER_SUBJECT : EMPLOYEE_SUBJECT),
      `${role}.provider_subject_id`,
    ),
  });
}

function coordinates(input) {
  if (input === null || typeof input !== "object") throw new TypeError("coordinates are required");
  return Object.freeze({
    authority_id: requiredText(input.authority_id, "coordinates.authority_id"),
    organization_id: requiredText(input.organization_id, "coordinates.organization_id"),
    state_lineage_id: requiredText(input.state_lineage_id, "coordinates.state_lineage_id"),
  });
}

function insertOnce(database, sql, values) {
  database.prepare(sql).run(...values);
}

function linkContract({ coordinates: location, actor: person, link_id, membership_type, now }) {
  return buildExternalHumanIdentityLinkContractV2({
    ...location,
    external_identity_link_id: link_id,
    provider_issuer: "https://slack.com",
    provider_tenant_kind: "workspace",
    provider_tenant_id: WORKSPACE_ID,
    provider_enterprise_id: null,
    provider_subject_id: person.provider_subject_id,
    principal_id: person.principal_id,
    membership_id: person.membership_id,
    membership_type,
    verification_event_id: `verify_${link_id}`,
    verification_evidence_sha256: canonicalSha256({ kind: "echo-core-verified-action-identity-v1", link_id, person }),
    verified_at: now(),
  });
}

/**
 * Seed the admitted connection and verified Person-to-reviewer links before a
 * timed run. This writes only the existing control-plane contracts; it does
 * not issue an authorization decision or manufacture a fence witness.
 */
function setupCoreApproval({ control_plane_database, coordinates: rawCoordinates, owner, employee, now } = {}) {
  if (control_plane_database === null || typeof control_plane_database?.prepare !== "function") {
    throw new TypeError("control_plane_database is required");
  }
  const location = coordinates(rawCoordinates);
  const clock = nowSource(now);
  const ownerActor = actor({ owner }, "owner");
  const employeeActor = employee === undefined ? undefined : actor({ employee }, "employee");
  const connection = buildOrganizationToolConnectionContractV2({
    ...location,
    connection_id: CONNECTION_ID,
    provider_issuer: "https://slack.com",
    provider_tenant_kind: "workspace",
    provider_tenant_id: WORKSPACE_ID,
    provider_enterprise_id: null,
    tool_kind: "slack",
    provider_app_id: APP_ID,
    provider_bot_id: BOT_ID,
    provider_bot_user_id: BOT_USER_ID,
    required_provider_scopes: SCOPES,
    public_connection_configuration_sha256: canonicalSha256({ kind: "echo-core-approval-deterministic-poster-v1" }),
  });
  const connection_sha256 = canonicalSha256(connection);
  const state = validateOrganizationToolConnectionStateV2({
    schema_version: 2,
    kind: "echo-organization-tool-connection-state-v2",
    connection_id: CONNECTION_ID,
    connection_contract_sha256: connection_sha256,
    connection_status: "active",
    credential_reference_sha256: canonicalSha256({ kind: "echo-core-approval-no-network-poster-v1" }),
    observed_granted_scopes: SCOPES,
    verification_event_id: "verify_core_approval_connection",
    verification_evidence_sha256: canonicalSha256({ kind: "echo-core-approval-connection-v1" }),
    verification_revision: 1,
    verified_at: clock(),
  });
  const state_sha256 = canonicalSha256(state);
  const people = [
    [ownerActor, OWNER_LINK_ID, "owner"],
    ...(employeeActor === undefined ? [] : [[employeeActor, EMPLOYEE_LINK_ID, "employee"]]),
  ];

  control_plane_database.transaction(() => {
    insertOnce(control_plane_database,
      "INSERT INTO organization_tool_connection_contracts VALUES (?, ?, ?, ?)",
      [CONNECTION_ID, canonicalJson(connection), connection_sha256, clock()]);
    insertOnce(control_plane_database,
      "INSERT INTO organization_tool_connection_current_state VALUES (?, ?, ?, ?, 'active', ?)",
      [CONNECTION_ID, connection_sha256, canonicalJson(state), state_sha256, clock()]);
    for (const [person, link_id, membership_type] of people) {
      const link = linkContract({ coordinates: location, actor: person, link_id, membership_type, now: clock });
      const link_sha256 = canonicalSha256(link);
      insertOnce(control_plane_database,
        "INSERT INTO organization_external_human_link_contracts VALUES (?, ?, ?, ?)",
        [link_id, link_sha256, canonicalJson(link), clock()]);
      insertOnce(control_plane_database,
        "INSERT INTO organization_external_human_link_current VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
        [link_id, link_sha256, link.provider_issuer, link.provider_tenant_kind, link.provider_tenant_id,
          link.provider_enterprise_id, link.provider_subject_id, link.principal_id, link.membership_id, clock()]);
    }
  })();
  return Object.freeze({ connection_id: CONNECTION_ID, connection_sha256, state_sha256, owner: ownerActor, ...(employeeActor === undefined ? {} : { employee: employeeActor }) });
}

class DeterministicCoreApprovalPoster {
  #markers = 0;
  #published = new Map();
  async openDirectMessage(provider_subject_id) {
    return Object.freeze({ kind: "opened", channel_id: DM_CHANNEL, user_id: provider_subject_id });
  }
  async postMarker() {
    this.#markers += 1;
    return Object.freeze({ kind: "posted", provider_message_ts: `1767225600.${String(this.#markers).padStart(6, "0")}` });
  }
  async reconcileMarker() { return Object.freeze({ kind: "uncertain" }); }
  async publish(input) {
    if (input === null || typeof input !== "object" || typeof input.approval_id !== "string") {
      throw new TypeError("core approval presentation is invalid");
    }
    this.#published.set(input.approval_id, input);
    return Object.freeze({ kind: "done" });
  }
  async tombstone() { return Object.freeze({ kind: "done" }); }
  async renderTerminal() { return Object.freeze({ kind: "done" }); }
  readPresentation(approval_id) {
    return this.#published.get(requiredText(approval_id, "approval_id"));
  }
}

function receipt({ approval_id, actor: person, policy_id, offer_id, connection, presentation, now }) {
  const offered = requiredText(offer_id, "offer_id");
  const policy = policy_id === "restricted-reviewer-person-v2" || policy_id === "organization-member-readable-person-v2"
    ? policy_id : (() => { throw new TypeError("policy_id is unsupported"); })();
  const at = now();
  const transport = Object.freeze({
    kind: "echo-core-verified-action-transport-v1",
    offer_id: offered,
    approval_id,
    actor: person,
    policy_id: policy,
  });
  // These hashes identify the verified-action envelope after its transport
  // verification. They are commitments, not stand-ins for an HMAC or raw
  // Block Kit payload, which is intentionally outside the core benchmark.
  return Object.freeze({
    schema_version: 1,
    kind: "echo-private-approval-signed-block-action-receipt-v1",
    provider_action_key_sha256: canonicalSha256({ kind: "echo-core-verified-action-key-v1", transport }),
    request: Object.freeze({
      request_timestamp: String(Math.floor(new Date(at).getTime() / 1_000)),
      signature_version: "v0",
      signature_sha256: canonicalSha256({ kind: "echo-core-verified-action-attestation-v1", transport }),
      raw_body_sha256: canonicalSha256({ kind: "echo-core-verified-action-body-v1", transport }),
    }),
    approval_id,
    action_id: `act_${canonicalSha256({ offered, approval_id, actor: person.provider_subject_id }).slice(7, 39)}`,
    action: "approve",
    selected_policy_id: policy,
    comment: null,
    lookup: Object.freeze({
      api_app_id: connection.provider_app_id,
      workspace_id: connection.provider_tenant_id,
      enterprise_id: connection.provider_enterprise_id,
      slack_user_id: person.provider_subject_id,
      channel_id: presentation.assignment.dm_channel.channel_id,
      message_ts: presentation.provider_message_ts,
      message_user_id: connection.provider_bot_user_id,
      message_app_id: connection.provider_app_id,
      message_bot_id: connection.provider_bot_id,
    }),
    received_at: at,
    verified_at: at,
  });
}

/**
 * Build the core-only approval lane. The caller stages a real frozen candidate
 * with `stager.stage(...)`, then enqueues one already-verified action through
 * `offerApproval`, and drives the returned coordinator in the shared worker.
 */
export async function createCoreApproval({ context, owner, employee, sessions } = {}) {
  if (context === null || typeof context !== "object") throw new TypeError("context is required");
  if (typeof sessions?.authenticateAccess !== "function") throw new TypeError("real Person sessions are required");
  for (const field of ["authority_database", "control_plane_database", "state", "record_append", "signer", "next_envelope_id"]) {
    if (context[field] === undefined) throw new TypeError(`context.${field} is required`);
  }
  const location = coordinates(context.coordinates);
  const clock = nowSource(context.now);
  const ownerActor = actor({ owner }, "owner");
  const employeeActor = employee === undefined ? undefined : actor({ employee }, "employee");
  // This happens during child bootstrap, before the benchmark offer loop.
  setupCoreApproval({
    control_plane_database: context.control_plane_database,
    coordinates: location,
    owner: ownerActor,
    ...(employeeActor === undefined ? {} : { employee: employeeActor }),
    now: clock,
  });
  const connection = resolveCurrentPrivateSlackConnectionV1(context.control_plane_database, CONNECTION_ID, location);
  const poster = new DeterministicCoreApprovalPoster();
  const assignments = new SqlitePrivateSlackApprovalAssignmentStateV1(context.authority_database, clock);
  const control_plane = new SqliteSlackDmApprovalPersistenceV1({
    database: context.control_plane_database,
    authority_fence: new SqliteStablePrivateApprovalAuthorityFenceV1(context.authority_database),
    now: clock,
  });
  const stager = new PrivateSlackDmApprovalStagerV1({
    authority: context.state,
    authority_database: context.authority_database,
    control_plane_database: context.control_plane_database,
    coordinates: location,
    connection_id: connection.connection_id,
    assignments,
    control_plane,
    poster,
    resolve_reviewer_target: resolveMeetingOwnerPrivateSlackApprovalReviewerV1,
    now: clock,
  });
  const writer = await createPrivateSlackBlockV4RecordWriterV1({
    append: context.record_append,
    signer: context.signer,
    state_lineage_id: location.state_lineage_id,
    now: clock,
    next_envelope_id: context.next_envelope_id,
  });
  const processing = new PrivateSlackApprovalTerminalCoordinatorV1({
    control_plane,
    authority: new SqlitePrivateSlackApprovalTerminalAuthorityV1({ source: context.state, assignments, coordinates: location }),
    record_writer: writer,
    poster,
  });
  const offered = new Map();

  return Object.freeze({
    stager,
    processing,
    assignments,
    control_plane,
    poster,
    async offerApproval({ approval_id, actor: role = "owner", policy_id, offer_id } = {}) {
      requiredText(approval_id, "approval_id");
      const person = role === "owner" ? ownerActor : role === "employee" ? employeeActor : undefined;
      const sessionActor = role === "owner" ? owner : role === "employee" ? employee : undefined;
      if (person === undefined) throw new TypeError("actor must name a configured owner or employee");
      const authenticated = sessions.authenticateAccess({ access_token: sessionActor.access_token });
      if (authenticated.principal_id !== person.principal_id || authenticated.membership_id !== person.membership_id) {
        throw new Error("authenticated Person actor does not match the offered action");
      }
      const presentation = assignments.readForPresentation(approval_id);
      if (presentation === undefined || presentation.source_outbox_state !== "staged") {
        throw new Error("approval must be durably staged before a verified action is offered");
      }
      const offer = requiredText(offer_id, "offer_id");
      const semantic = canonicalJson({ approval_id, actor: role, policy_id });
      const prior = offered.get(offer);
      if (prior !== undefined && prior.semantic !== semantic) {
        throw new Error("offer_id was already bound to another verified action");
      }
      const normalized = prior?.receipt ?? receipt({
        approval_id, actor: person, policy_id, offer_id: offer, connection, presentation, now: clock,
      });
      if (prior === undefined) offered.set(offer, Object.freeze({ semantic, receipt: normalized }));
      // Replays enqueue the byte-for-byte original verified receipt. This map
      // caches ingress evidence only; it never caches an authorization allow,
      // terminal, record, or search result.
      return control_plane.enqueue({ disposition: "resolution", receipt: normalized });
    },
  });
}
