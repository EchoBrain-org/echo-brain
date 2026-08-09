import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { OrganizationIngestExclusion } from './exclusion.js';
import type {
  BuiltOrganizationRecordEnvelope,
  OrganizationRecordAction,
  OrganizationRecordAuthorizationEvidence,
  OrganizationRecordCandidateNode,
  OrganizationRecordClient,
  OrganizationRecordEnvelopeBuilder,
  OrganizationRecordEventType,
  OrganizationRecordFrozenEnvelope,
  OrganizationRecordNodeStore,
  OrganizationRecordSourceLocator,
  VerifiedOrganizationRecordReceipt,
} from './ports.js';

export type OrganizationRecordAlertCode =
  | 'node_unreadable'
  | 'retired_federation_node'
  | 'source_locator_missing'
  | 'authorization_evidence_invalid'
  | 'envelope_builder_invalid'
  | 'envelope_digest_mismatch'
  | 'receipt_binding_mismatch'
  | 'permanently_rejected'
  | 'submit_failed';

export interface OrganizationRecordAlert {
  readonly code: OrganizationRecordAlertCode;
  readonly approval_id: string;
  readonly detail: string;
}

type OrganizationRecordNodeOutcomeStatus =
  | 'unresolved'
  | 'excluded'
  | 'skipped'
  | 'complete'
  | 'published'
  | 'rejected'
  | 'retry';

export interface OrganizationRecordSweepResult {
  readonly ok: boolean;
  readonly examined: number;
  readonly excluded: number;
  readonly skipped: number;
  readonly published: number;
  readonly rejected: number;
  readonly retried: number;
  readonly alerts: readonly OrganizationRecordAlert[];
}

export interface OrganizationRecordSubmitterOptions {
  readonly nodes: OrganizationRecordNodeStore;
  readonly envelopes: OrganizationRecordEnvelopeBuilder;
  readonly client: OrganizationRecordClient;
  /** The enrolled installation whose receipts this member accepts. */
  readonly installationId: string;
  readonly exclusion: OrganizationIngestExclusion;
  /**
   * Required, not defaulted: this module is always composed, so it takes the
   * composition's clock rather than adding another wall-clock read to the
   * product layer.
   */
  readonly now: () => string;
}

export interface OrganizationRecordSweepOptions {
  readonly signal?: AbortSignal;
}

const APPROVAL_ID_RE = /^[a-f0-9]{64}$/;
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const ACTION_BY_STATUS: Readonly<
  Record<'approved' | 'rejected', OrganizationRecordAction>
> = Object.freeze({ approved: 'approve', rejected: 'reject' });

const EVENT_TYPE_BY_STATUS: Readonly<
  Record<'approved' | 'rejected', OrganizationRecordEventType>
> = Object.freeze({ approved: 'approval', rejected: 'rejection' });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Organization ingest requires complete, allowed authorization evidence bound
 * to this exact node, action, and installation. Anything short of that --
 * absent, denied, bound to another approval, issued to another installation,
 * or unable to prove which action was authorized -- is skipped with an alert
 * rather than downgraded to a display name.
 *
 * Completeness is checked here rather than left to the Authority: the evidence
 * is what its pre-append audit lookup matches against, so evidence missing its
 * request digests or attribution ids can only fail after a round trip.
 */
function readOrganizationRecordAuthorization(
  node: Pick<
    OrganizationRecordCandidateNode,
    'approval_id' | 'status' | 'resolved_metadata'
  >,
  installationId: string,
): OrganizationRecordAuthorizationEvidence | string {
  if (node.status !== 'approved' && node.status !== 'rejected') {
    return 'decision node is not resolved';
  }
  const evidence = node.resolved_metadata?.['authorization'];
  if (!isPlainObject(evidence)) {
    return 'resolved metadata carries no authorization evidence';
  }
  if (evidence['kind'] !== 'echo-organization-authorization-evidence') {
    return 'authorization evidence kind is not recognized';
  }
  if (evidence['schema_version'] !== 1) {
    return 'authorization evidence schema version is not supported';
  }
  if (evidence['allowed'] !== true) {
    return 'authorization evidence is not an allow decision';
  }
  if (evidence['approval_id'] !== node.approval_id) {
    return 'authorization evidence belongs to another approval';
  }
  // Evidence issued to another installation would be submitted under this
  // installation's signature and idempotency scope, attributing one machine's
  // authorization to another's act.
  if (evidence['installation_id'] !== installationId) {
    return 'authorization evidence was issued to another installation';
  }
  const expectedAction = ACTION_BY_STATUS[node.status];
  if (evidence['action'] !== expectedAction) {
    // Evidence written before the action was recorded cannot prove which act
    // the authority allowed, so it fails closed exactly like a mismatch.
    return `authorization evidence does not record the '${expectedAction}' action`;
  }
  for (const field of [
    'authority_id',
    'organization_id',
    'enrollment_id',
    'request_id',
    'reason_code',
    'principal_id',
    'membership_id',
    'adapter_binding_id',
    'permission_grant_id',
    'evaluated_at',
  ] as const) {
    if (!isNonEmptyString(evidence[field])) {
      return `authorization evidence is missing ${field}`;
    }
  }
  for (const field of ['request_sha256', 'provider_event_sha256'] as const) {
    const digest = evidence[field];
    if (typeof digest !== 'string' || !SHA256_DIGEST_RE.test(digest)) {
      return `authorization evidence ${field} is not a sha256 digest`;
    }
  }
  return evidence as unknown as OrganizationRecordAuthorizationEvidence;
}

function assertBuiltEnvelope(
  built: BuiltOrganizationRecordEnvelope,
  approvalId: string,
  eventType: OrganizationRecordEventType,
): string | null {
  if (!isPlainObject(built)) return 'envelope builder returned no envelope';
  if (built.idempotency_key !== approvalId) {
    return 'envelope builder used another idempotency key';
  }
  if (built.event_type !== eventType) {
    return `envelope builder returned a '${built.event_type}' envelope for a '${eventType}' act`;
  }
  if (!isNonEmptyString(built.envelope_id)) {
    return 'envelope builder returned no envelope id';
  }
  if (!isPlainObject(built.envelope)) {
    return 'envelope builder returned a non-object envelope';
  }
  return null;
}

function receiptBindingFailure(
  receipt: VerifiedOrganizationRecordReceipt,
  envelope: OrganizationRecordFrozenEnvelope,
  installationId: string,
): string | null {
  if (!isPlainObject(receipt)) return 'authority returned no receipt';
  if (receipt.kind !== 'echo-organization-record-receipt') {
    return 'receipt kind is not recognized';
  }
  if (receipt.schema_version !== 1) {
    return 'receipt schema version is not supported';
  }
  if (receipt.installation_id !== installationId) {
    return 'receipt belongs to another installation';
  }
  if (receipt.envelope_id !== envelope.envelope_id) {
    return 'receipt names another envelope';
  }
  if (receipt.envelope_sha256 !== envelope.envelope_sha256) {
    return 'receipt digest does not match the frozen envelope';
  }
  if (receipt.idempotency_key !== envelope.idempotency_key) {
    return 'receipt uses another idempotency key';
  }
  if (
    typeof receipt.position !== 'number' ||
    !Number.isSafeInteger(receipt.position) ||
    receipt.position < 1
  ) {
    return 'receipt position is not a valid append position';
  }
  if (!isNonEmptyString(receipt.record_hash)) {
    return 'receipt carries no record hash';
  }
  // The signature is durable state, not a transport detail: a receipt filed
  // without it could never be presented back against the org log.
  const integrity = receipt.integrity as unknown;
  if (!isPlainObject(integrity)) return 'receipt carries no integrity block';
  if (integrity['canonicalization'] !== 'RFC8785') {
    return 'receipt canonicalization is unsupported';
  }
  if (integrity['signature_algorithm'] !== 'ecdsa-p256-sha256-der-low-s') {
    return 'receipt signature algorithm is unsupported';
  }
  for (const field of ['payload_sha256', 'key_id'] as const) {
    const digest = integrity[field];
    if (typeof digest !== 'string' || !SHA256_DIGEST_RE.test(digest)) {
      return `receipt integrity ${field} is not a sha256 digest`;
    }
  }
  if (!isNonEmptyString(integrity['signature_base64'])) {
    return 'receipt carries no signature';
  }
  return null;
}

/**
 * Member-side organization record submitter.
 *
 * There is no watcher daemon, queue database, or timer here: the decision
 * node's own write-once slot files are the state machine, and `sweep()` is
 * driven by the existing product service cycle and composition startup. Every
 * step is idempotent, so a sweep interrupted anywhere is safe to repeat.
 */
export class OrganizationRecordSubmitter {
  constructor(private readonly options: OrganizationRecordSubmitterOptions) {
    if (!isNonEmptyString(options.installationId)) {
      throw new Error('organization record submitter needs an installation id');
    }
  }

  async sweep(
    options: OrganizationRecordSweepOptions = {},
  ): Promise<OrganizationRecordSweepResult> {
    const alerts: OrganizationRecordAlert[] = [];
    const outcomes: OrganizationRecordNodeOutcomeStatus[] = [];
    const exclusion = this.options.exclusion;
    const listing = await this.options.nodes.listForSubmission();
    for (const skip of listing.skipped) {
      alerts.push({
        code:
          skip.reason === 'retired_federation'
            ? 'retired_federation_node'
            : 'node_unreadable',
        approval_id: skip.approval_id,
        detail: skip.detail,
      });
    }
    for (const node of listing.nodes) {
      options.signal?.throwIfAborted();
      try {
        outcomes.push(await this.submitNode(node, exclusion, alerts, options));
      } catch (error) {
        // One node that cannot be processed -- a throwing envelope builder, a
        // slot that will not create -- never stalls organization ingest for
        // the rest, which is the whole reason the enumerator is tolerant.
        if (options.signal?.aborted === true) throw error;
        const detail = (error as Error).message;
        alerts.push({
          code: 'submit_failed',
          approval_id: node.approval_id,
          detail,
        });
        outcomes.push('skipped');
      }
    }
    return this.summarize(outcomes, alerts);
  }

  private async submitNode(
    node: OrganizationRecordCandidateNode,
    exclusion: OrganizationIngestExclusion,
    alerts: OrganizationRecordAlert[],
    options: OrganizationRecordSweepOptions,
  ): Promise<OrganizationRecordNodeOutcomeStatus> {
    const recordStatus = node.organization_record.status;
    const alert = (
      code: OrganizationRecordAlertCode,
      detail: string,
    ): OrganizationRecordNodeOutcomeStatus => {
      alerts.push({ code, approval_id: node.approval_id, detail });
      return code === 'permanently_rejected' ? 'rejected' : 'skipped';
    };

    if (recordStatus === 'published' || recordStatus === 'rejected') {
      return 'complete';
    }
    if (recordStatus === 'unresolved') return 'unresolved';

    const source = node.source;
    if (source === null) {
      // A node stored before the locator existed cannot be checked against the
      // exclusion list, so it cannot be submitted safely.
      return alert(
        'source_locator_missing',
        'decision node has no persisted source locator and cannot be checked against the exclusion list',
      );
    }
    // Checked before first building and again before every send: an excluded
    // source produces no envelope of either event type.
    if (exclusion.excludes(source)) return 'excluded';

    let envelope = node.organization_record.envelope;
    if (envelope === null) {
      const authorization = readOrganizationRecordAuthorization(
        node,
        this.options.installationId,
      );
      if (typeof authorization === 'string') {
        return alert('authorization_evidence_invalid', authorization);
      }
      const built = await this.buildEnvelope(node, source, authorization);
      if (typeof built === 'string') {
        return alert('envelope_builder_invalid', built);
      }
      const envelopeSha256 = canonicalSha256(built.envelope);
      envelope = await this.options.nodes.createOrganizationRecordEnvelope({
        approvalId: node.approval_id,
        recordEventType: built.event_type,
        envelopeId: built.envelope_id,
        idempotencyKey: built.idempotency_key,
        envelopeSha256,
        envelope: built.envelope,
      });
    }
    // Proves the resend is the exact frozen wire form: the slot file is
    // pretty-printed, so only re-canonicalizing the parsed value reproduces
    // the bytes that were signed.
    if (canonicalSha256(envelope.envelope) !== envelope.envelope_sha256) {
      return alert(
        'envelope_digest_mismatch',
        'frozen organization record envelope no longer canonicalizes to its pinned digest',
      );
    }
    return await this.send(node, envelope, alert, options);
  }

  private async buildEnvelope(
    node: OrganizationRecordCandidateNode,
    source: OrganizationRecordSourceLocator,
    authorization: OrganizationRecordAuthorizationEvidence,
  ): Promise<BuiltOrganizationRecordEnvelope | string> {
    if (!APPROVAL_ID_RE.test(node.approval_id)) {
      return 'decision node approval id is not a sha256 digest';
    }
    const status = node.status as 'approved' | 'rejected';
    const eventType = EVENT_TYPE_BY_STATUS[status];
    const reviewedAt = node.reviewed_at;
    if (reviewedAt === null) return 'resolved decision node has no review time';
    const built = await this.options.envelopes.build({
      event_type: eventType,
      approval_id: node.approval_id,
      source,
      meeting_id: node.brief.meeting.id,
      brief: eventType === 'approval' ? node.brief : null,
      alternatives: node.alternatives,
      links: node.links,
      reviewed_at: reviewedAt,
      reviewed_by: node.reviewed_by ?? '',
      reason: node.reason,
      surface: node.resolved_surface ?? '',
      authorization,
      submitted_at: this.options.now(),
    });
    return assertBuiltEnvelope(built, node.approval_id, eventType) ?? built;
  }

  private async send(
    node: OrganizationRecordCandidateNode,
    envelope: OrganizationRecordFrozenEnvelope,
    alert: (
      code: OrganizationRecordAlertCode,
      detail: string,
    ) => OrganizationRecordNodeOutcomeStatus,
    options: OrganizationRecordSweepOptions,
  ): Promise<OrganizationRecordNodeOutcomeStatus> {
    let result;
    try {
      result = await this.options.client.submitRecord(
        {
          envelope_id: envelope.envelope_id,
          idempotency_key: envelope.idempotency_key,
          envelope_sha256: envelope.envelope_sha256,
          envelope: envelope.envelope,
        },
        options.signal,
      );
    } catch {
      // Transport and lease-refresh failures create no terminal slot; the next
      // existing service cycle resends these exact bytes.
      return 'retry';
    }
    if (result.outcome === 'retry') {
      return 'retry';
    }
    if (result.outcome === 'rejected') {
      await this.options.nodes.recordOrganizationRecordRejection({
        approvalId: node.approval_id,
        reasonCode: result.reason_code,
        reason: result.reason,
      });
      return alert(
        'permanently_rejected',
        `${result.reason_code}: ${result.reason}`,
      );
    }
    const binding = receiptBindingFailure(
      result.receipt,
      envelope,
      this.options.installationId,
    );
    if (binding !== null) {
      // Never file an unbound receipt: the node stays outbound and loud rather
      // than recording another append as this decision's outcome.
      return alert('receipt_binding_mismatch', binding);
    }
    await this.options.nodes.recordOrganizationRecordReceipt({
      approvalId: node.approval_id,
      receipt: result.receipt,
    });
    return 'published';
  }

  private summarize(
    outcomes: readonly OrganizationRecordNodeOutcomeStatus[],
    alerts: readonly OrganizationRecordAlert[],
  ): OrganizationRecordSweepResult {
    const count = (status: OrganizationRecordNodeOutcomeStatus): number =>
      outcomes.filter((outcome) => outcome === status).length;
    return Object.freeze({
      ok: alerts.length === 0,
      examined: outcomes.length,
      excluded: count('excluded'),
      skipped: count('skipped'),
      published: count('published'),
      rejected: count('rejected'),
      retried: count('retry'),
      alerts: Object.freeze([...alerts]),
    });
  }
}
