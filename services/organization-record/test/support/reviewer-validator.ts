import type {
  JsonObject,
} from '../../src/index.js';
import type {
  ReviewerRestrictedEnvelopeValidator,
  ReviewerRestrictedEnvelopeView,
} from '../../src/application/reviewer-policy-fact.js';
import { assertReviewerRestrictedEnvelopeView } from '../../src/application/reviewer-policy-fact.js';

/**
 * A stand-in for the injected closed reviewer-v2 validator.
 *
 * The real one lives in `packages/organization-protocol` and is adapted by
 * Authority composition; it verifies the complete signed document, the frozen
 * release draft, and the exact authorization evidence. This double exists for
 * the same reason `acceptingVerifier` does: these suites exercise the record
 * core's own fact, proof, derive, and boundary behavior, not the protocol
 * package's contract, and the fixtures here carry stand-in signatures the real
 * validator would rightly reject.
 *
 * It is deliberately *not* a second durable contract: it lives in `test/`, no
 * production module can reach it, and everything it returns still passes
 * through the shipped `assertReviewerRestrictedEnvelopeView` normalizer.
 */
export function testReviewerValidator(
  organizationId: string,
): ReviewerRestrictedEnvelopeValidator {
  return (envelope: JsonObject): ReviewerRestrictedEnvelopeView => {
    const document = envelope as Record<string, unknown>;
    if (
      document['kind'] !== 'echo-organization-record-envelope' ||
      document['schema_version'] !== 2
    ) {
      throw new Error('kind or schema version is unsupported');
    }
    if (document['event_type'] !== 'approval') {
      throw new Error('schema version 2 admits approval only');
    }
    const intent = record(document['intent']);
    const provenance = record(intent['provenance']);
    if (
      intent['policy_id'] !== 'restricted-reviewer-v1' ||
      intent['visibility'] !== 'restricted'
    ) {
      throw new Error('reviewer envelope intent policy is unsupported');
    }
    const reviewer = record(document['reviewer']);
    const authorization = record(reviewer['authorization']);
    if (
      authorization['allowed'] !== true ||
      authorization['action'] !== 'approve' ||
      authorization['reason_code'] !== 'active_reviewer_restricted_notice_v1'
    ) {
      throw new Error('reviewer envelope authorization is not the closed allow');
    }
    if (authorization['organization_id'] !== organizationId) {
      throw new Error(
        'reviewer envelope authorization does not name this organization',
      );
    }
    if (
      provenance['semantic_intent_sha256'] !==
      authorization['semantic_intent_sha256']
    ) {
      throw new Error(
        'reviewer envelope intent does not quote its authorized semantic intent',
      );
    }
    const payload = record(document['payload']);
    if (payload['surface'] !== 'slack-reviewer-v1') {
      throw new Error('reviewer envelope payload surface is unsupported');
    }
    if (payload['reviewed_at'] !== authorization['evaluated_at']) {
      throw new Error(
        'reviewer envelope action time does not match its authorization',
      );
    }
    const submitter = record(document['submitter']);
    return assertReviewerRestrictedEnvelopeView({
      schema_version: 2,
      authority_id: authorization['authority_id'],
      organization_id: authorization['organization_id'],
      envelope_id: document['envelope_id'],
      idempotency_key: document['idempotency_key'],
      installation_id: submitter['installation_id'],
      reviewer_principal_id: reviewer['principal_id'],
      reviewer_membership_id: reviewer['membership_id'],
      approval_id: authorization['approval_id'],
      request_id: authorization['request_id'],
      request_sha256: authorization['request_sha256'],
      provider_event_sha256: authorization['provider_event_sha256'],
      adapter_binding_id: authorization['adapter_binding_id'],
      permission_grant_id: authorization['permission_grant_id'],
      semantic_intent_sha256: authorization['semantic_intent_sha256'],
      reviewer_release_draft_sha256:
        authorization['reviewer_release_draft_sha256'],
      approval_presentation_sha256:
        authorization['approval_presentation_sha256'],
      message_presentation_sha256: authorization['message_presentation_sha256'],
      authorization_audit_event_id:
        authorization['authorization_audit_event_id'],
      authorization_audit_entry_sha256:
        authorization['authorization_audit_entry_sha256'],
      evaluated_at: authorization['evaluated_at'],
      signals: releasedSignals(record(payload['brief'])),
    });
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('reviewer envelope member is not an object');
  }
  return value as Record<string, unknown>;
}

/** Canonical draft order: decisions, then actions, then rationales. */
function releasedSignals(
  brief: Record<string, unknown>,
): { id: string; kind: string; text: string }[] {
  const collected: { id: string; kind: string; text: string }[] = [];
  for (const [collection, kind] of [
    ['decisions', 'decision'],
    ['actions', 'action'],
    ['rationales', 'rationale'],
  ] as const) {
    const value = brief[collection];
    if (!Array.isArray(value)) {
      throw new Error(`reviewer envelope brief ${collection} is invalid`);
    }
    for (const entry of value as unknown[]) {
      const signal = record(entry);
      if (signal['kind'] !== kind) {
        throw new Error(`reviewer envelope ${collection} item kind is invalid`);
      }
      collected.push({
        id: signal['id'] as string,
        kind,
        text: signal['text'] as string,
      });
    }
  }
  return collected;
}
