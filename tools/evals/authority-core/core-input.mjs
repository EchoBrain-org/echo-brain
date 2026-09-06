/** Core-stage deterministic meeting input. Provider admission is fixture setup only. */
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { assertCanonicalDecisionSet, assertCanonicalMeetingDocument } from "../../../services/organization-authority/dist/processing/core/index.js";

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

function health() {
  return Object.freeze({ status: "healthy", checked_at: new Date().toISOString() });
}

/**
 * Fixture-only stopped-time admission plus canonical source/processor ports.
 * During a run the ports are read-only except for `offer`, which appends an
 * immutable tuple and never changes a previously-addressable cursor.
 */
export function createCoreInput({ authority, coordinates: { organization_id }, owner, sessions }) {
  const authorization = sessions.authenticateAccess({ access_token: owner.access_token });
  if (
    authorization.organization_id !== organization_id || authorization.principal_id !== owner.principal_id ||
    authorization.membership_id !== owner.membership_id || authorization.membership_type !== "owner"
  ) throw new Error("core input setup requires the authenticated active owner");

  const admitted_at = new Date().toISOString();
  const admission_semantic_input_sha256 = canonicalSha256({
    schema_version: 1,
    kind: "echo-capacity-core-input-static-admission-v1",
    organization_id,
    principal_id: authorization.principal_id,
    membership_id: authorization.membership_id,
    source: SOURCE,
    processor: PROCESSOR,
  });
  const source_custodian_sha256 = canonicalSha256({ kind: "echo-capacity-core-input-owner-v1", principal_id: authorization.principal_id, membership_id: authorization.membership_id });
  const source_credential_reference_sha256 = canonicalSha256({ kind: "echo-capacity-core-input-no-provider-credential-v1" });
  const processor_configuration_sha256 = canonicalSha256({ kind: "echo-capacity-core-input-deterministic-processor-v1" });
  const processor_credential_reference_sha256 = canonicalSha256({ kind: "echo-capacity-core-input-no-provider-credential-v1" });
  authority.transaction(() => {
    const existing = authority.prepare("SELECT semantic_input_sha256 FROM authority_live_source_admission_v2 WHERE singleton = 1").get();
    if (existing !== undefined) throw new Error("core input setup requires an unadmitted Authority state");
    authority.prepare(
      `INSERT INTO authority_live_source_admission_v2 (
        singleton, organization_id, principal_id, membership_id, membership_type,
        source_adapter_id, source_adapter_version, source_adapter_instance_id,
        normalizer_version, source_custodian_sha256, source_custodian_assurance,
        source_custodian_observed_at, source_credential_reference_sha256,
        initial_cursor, cutoff_at, processor_adapter_id, processor_instance_id,
        processor_adapter_version, processor_configuration_sha256,
        processor_credential_reference_sha256, semantic_input_sha256, admitted_at
      ) VALUES (1, ?, ?, ?, 'owner', ?, ?, ?, ?, ?, 'fixture_owner_declared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      organization_id, authorization.principal_id, authorization.membership_id,
      SOURCE.adapter_id, SOURCE.version, SOURCE.instance_id, SOURCE.version,
      source_custodian_sha256, admitted_at, source_credential_reference_sha256,
      cursor(0), admitted_at, PROCESSOR.adapter_id, PROCESSOR.instance_id,
      PROCESSOR.version, processor_configuration_sha256,
      processor_credential_reference_sha256, admission_semantic_input_sha256, admitted_at,
    );
  }).immediate();

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
      if (tuple === undefined || tuple.meeting !== meeting) throw new Error("core processor received an unoffered meeting revision");
      return tuple.decisions;
    },
  });
  return Object.freeze({
    source,
    processor,
    source_cursor_policy,
    offer({ meeting, decisions } = {}) {
      assertCanonicalMeetingDocument(meeting, SOURCE);
      assertCanonicalDecisionSet(decisions, meeting, PROCESSOR);
      if (offered.some((candidate) => candidate.meeting.id === meeting.id && candidate.meeting.provenance.canonical_revision === meeting.provenance.canonical_revision)) {
        throw new Error("core input meeting revision was already offered");
      }
      offered.push(Object.freeze({ meeting, decisions }));
      return Object.freeze({ cursor: cursor(offered.length - 1), next_cursor: cursor(offered.length) });
    },
  });
}

export const coreInputIdentities = Object.freeze({ source: SOURCE, processor: PROCESSOR, source_cursor_policy });
