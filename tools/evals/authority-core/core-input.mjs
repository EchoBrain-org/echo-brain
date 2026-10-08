/** Core-stage deterministic meeting input. Provider admission is fixture setup only. */
import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import { assertCanonicalDecisionSet, assertCanonicalMeetingDocument } from "../../../packages/organization-processing/dist/core/index.js";
import { SqlitePersonMeetingIntakeV1 } from "../../../services/organization-authority/dist/adapters/persistence/sqlite/person-meeting-intake-v1.js";
import { SqliteSourceAdmissionStoreV1 } from "../../../services/organization-authority/dist/adapters/persistence/sqlite/source-admission-v1.js";

const SOURCE = Object.freeze({ kind: "meeting-source", adapter_id: "core-input", instance_id: "core-input-v1", version: "1.0.0" });
const PROCESSOR = Object.freeze({ kind: "decision-processor", adapter_id: "core-input", instance_id: "core-processor-v1", version: "1.0.0" });
const CURSOR_PREFIX = "core-input:v1:";

function cursor(offset) {
  return `${CURSOR_PREFIX}${String(offset)}`;
}

function offset(value) {
  if (typeof value !== "string" || !value.startsWith(CURSOR_PREFIX)) throw new Error("core input cursor is invalid");
  const parsed = Number(value.slice(CURSOR_PREFIX.length));
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value.slice(CURSOR_PREFIX.length)) {
    throw new Error("core input cursor is invalid");
  }
  return parsed;
}

const source_cursor_policy = Object.freeze({
  source_adapter_id: SOURCE.adapter_id,
  assert_live_cursor(value) { offset(value); },
});

/**
 * The personal intake writes a checkpoint when it admits the source. This
 * benchmark never watches a folder or queues a manual import: meetings arrive
 * only through `offer`, and the processing cycle owns the cursor from then on.
 * So the codec accepts exactly the empty initial checkpoint and maps it to the
 * first offered position.
 */
const checkpoint_codec = Object.freeze({
  read(value) {
    offset(value);
    return Object.freeze({ folder: null, baseline: false, revisions: Object.freeze({}), manual: Object.freeze([]) });
  },
  write(value) {
    if (value?.folder !== null || value.baseline !== false || value.manual?.length !== 0 || Object.keys(value.revisions ?? {}).length !== 0) {
      throw new Error("core input admits only the empty initial checkpoint");
    }
    return cursor(0);
  },
});

function health() {
  return Object.freeze({ status: "healthy", checked_at: new Date().toISOString() });
}

function immutableSnapshot(value) {
  const freeze = (item) => {
    if (item !== null && typeof item === "object") {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(JSON.parse(canonicalJson(value)));
}

/**
 * Fixture-only stopped-time admission plus canonical source/processor ports.
 * The fictional owner admits a personal meeting source through the same intake
 * the product uses; the cursor stays unadvanced until the cycle pulls. During a
 * run the ports are read-only except for `offer`, which appends an immutable
 * tuple and never changes a previously-addressable cursor.
 */
export function createCoreInput({ authority, coordinates: { organization_id }, owner, sessions }) {
  const authorization = sessions.authenticateAccess({ access_token: owner.access_token });
  if (
    authorization.organization_id !== organization_id || authorization.principal_id !== owner.principal_id ||
    authorization.membership_id !== owner.membership_id || authorization.membership_type !== "owner"
  ) throw new Error("core input setup requires the authenticated active owner");

  const person = Object.freeze({ organization_id, principal_id: authorization.principal_id, membership_id: authorization.membership_id });
  const intake = new SqlitePersonMeetingIntakeV1(authority, checkpoint_codec);
  if (authority.prepare("SELECT count(*) FROM authority_live_source_admission_v2").pluck().get() !== 0) {
    throw new Error("core input setup requires an unadmitted Authority state");
  }
  const setting = intake.ensure({
    person,
    identity: SOURCE,
    normalizer_version: SOURCE.version,
    custodian: { kind: "echo-capacity-core-input-owner-v1", principal_id: person.principal_id, membership_id: person.membership_id },
    processor: {
      adapter_id: PROCESSOR.adapter_id,
      instance_id: PROCESSOR.instance_id,
      version: PROCESSOR.version,
      configuration_sha256: canonicalSha256({ kind: "echo-capacity-core-input-deterministic-processor-v1" }),
      credential_reference_sha256: canonicalSha256({ kind: "echo-capacity-core-input-no-provider-credential-v1" }),
    },
    current: () => { intake.currentPerson(person); },
    custodian_assurance: "fixture_owner_declared",
  });

  const offered = [];
  const source = Object.freeze({
    identity: SOURCE,
    validateConfig: () => Object.freeze({ ok: true, errors: [] }),
    healthCheck: async () => health(),
    async pull(request = {}) {
      const at = offset(request.cursor ?? cursor(0));
      const tuple = offered[at];
      return Object.freeze({
        meetings: tuple === undefined ? [] : [tuple.meeting],
        next_cursor: tuple === undefined ? cursor(at) : cursor(at + 1),
      });
    },
  });
  const processor = Object.freeze({
    identity: PROCESSOR,
    validateConfig: () => Object.freeze({ ok: true, errors: [] }),
    healthCheck: async () => health(),
    async extract(meeting) {
      assertCanonicalMeetingDocument(meeting, SOURCE);
      const tuple = offered.find((candidate) => candidate.meeting.id === meeting.id && candidate.meeting.provenance.canonical_revision === meeting.provenance.canonical_revision);
      // Admission may snapshot/deserialize the canonical evidence. Bind to all
      // offered bytes instead of relying on an in-process object reference.
      if (tuple === undefined || tuple.meeting_sha256 !== canonicalSha256(meeting)) throw new Error("core processor received an unoffered meeting revision");
      return tuple.decisions;
    },
  });
  return Object.freeze({
    source,
    processor,
    source_cursor_policy,
    /** The admitted personal source; the processing state and review are bound to this key. */
    source_key: setting.source_key,
    setting,
    /** The personal intake that admitted the source; the review uses it for the current-person fence. */
    intake,
    /** The personal intake's own fence: the owner is active and the source settings are unchanged. */
    requireCurrent() { intake.requireCurrent(setting); },
    offer({ meeting, decisions } = {}) {
      assertCanonicalMeetingDocument(meeting, SOURCE);
      assertCanonicalDecisionSet(decisions, meeting, PROCESSOR);
      if (offered.some((candidate) => candidate.meeting.id === meeting.id && candidate.meeting.provenance.canonical_revision === meeting.provenance.canonical_revision)) {
        throw new Error("core input meeting revision was already offered");
      }
      const meetingSnapshot = immutableSnapshot(meeting);
      offered.push(Object.freeze({ meeting: meetingSnapshot, decisions: immutableSnapshot(decisions), meeting_sha256: canonicalSha256(meetingSnapshot) }));
      return Object.freeze({ cursor: cursor(offered.length - 1), next_cursor: cursor(offered.length) });
    },
  });
}

/**
 * Bind the fixture source to the same current-admission fence used by the
 * Authority runtime, with the personal custody scope a person's own source
 * retains under. Keeping this beside the source avoids a core evaluator
 * silently processing a meeting that was never retained in source custody.
 */
export function createCoreSourceIngestion({ authority, setting, state, source }) {
  if (authority === null || typeof authority?.prepare !== "function") throw new TypeError("authority is required");
  if (typeof setting?.source_key !== "string" || typeof setting.organization_id !== "string" || typeof setting.membership_id !== "string") {
    throw new TypeError("setting must be the admitted personal source");
  }
  if (state === null || typeof state?.assertCurrentSourceAdmission !== "function") throw new TypeError("state must provide the current source-admission fence");
  if (source === null || typeof source?.identity !== "object") throw new TypeError("source identity is required");
  const identity = source.identity;
  return Object.freeze({
    store: new SqliteSourceAdmissionStoreV1(authority, () => state.assertCurrentSourceAdmission(identity)),
    scope: Object.freeze({
      organization_id: setting.organization_id,
      custody_ref: `person:${setting.membership_id}`,
      access_policy_ref: `personal-meeting:${setting.source_key}`,
      analysis_policy: "automatic",
    }),
  });
}

export const coreInputIdentities = Object.freeze({ source: SOURCE, processor: PROCESSOR, source_cursor_policy });
