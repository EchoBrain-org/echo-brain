import {
  OrganizationRecordDerivedStore,
  OrganizationRecordFollower,
  OrganizationRecordIngest,
  OrganizationRecordLogReader,
  OrganizationRecordLogStore,
  OrganizationPermissionPilotReader,
  verifyOrganizationRecordChain,
  createReviewerRecordPort,
} from '@echo-brain/organization-record/append';
import {
  isOrganizationRecordError,
  parseOrganizationRecordEnvelope,
} from '@echo-brain/organization-record';
import type {
  OrganizationRecordAlert,
  OrganizationRecordChainVerification,
  OrganizationPermissionPilotActivationMarkerV1,
  OrganizationPermissionPilotEligibleRecord,
} from '@echo-brain/organization-record';
import type { ReviewerRecordPort } from '@echo-brain/organization-record/reviewer';
import {
  validateAcceptedOrganizationRecord,
  type AcceptedOrganizationRecordV1,
  type SubmitOrganizationRecordEnvelopeRequestV1,
} from '@echo-brain/organization-api';
import { validateOrganizationRecordEnvelope } from '@echo-brain/organization-protocol';
import { AuthorityOperationError } from '../domain/errors.js';
import type { ReadableSearchAuthorizationFence } from '../application/readable-search-authorization-fence.js';
import {
  OrganizationRecordIngestAuthority,
  OrganizationRecordIngestRejectionError,
  type OrganizationRecordAuthorizationEvidenceStore,
} from '../application/organization-record-ingest.js';
import type { OrganizationAuthorityApplication } from '../application/organization-authority.js';
import {
  isOrganizationMemberReadableRecordingPolicy,
  type OrganizationRecordingPolicyV1,
} from '../application/organization-recording-policy.js';
import type { OrganizationRecordHttpApplication } from '../presentation/organization-record-http-application.js';
import { reviewerRestrictedEnvelopeValidator } from './reviewer-envelope-validator.js';
import { organizationMemberReadableEnvelopeValidator } from './organization-member-envelope-validator.js';
import {
  verifyReviewerRestrictedReadiness,
  type ReviewerRestrictedReadiness,
} from './reviewer-restricted-admission.js';
import {
  verifyOrganizationMemberReadableReadiness,
  type OrganizationMemberReadableReadiness,
} from './organization-member-readable-admission.js';

export interface OpenOrganizationRecordRuntimeOptions {
  readonly authority: OrganizationAuthorityApplication;
  readonly evidence: OrganizationRecordAuthorizationEvidenceStore;
  readonly organization_id: string;
  readonly authority_id: string;
  readonly record_log_database_path: string;
  readonly record_derived_database_path: string;
  /** Effective central policy after the additive activation overlay is read. */
  readonly organization_recording_policy_v1?: OrganizationRecordingPolicyV1;
  /** Shared with current-Person writes; acquired only for the append commit. */
  readonly authorization_fence?: ReadableSearchAuthorizationFence;
  /** Operator alerting. Defaults to one line per alert on stderr. */
  readonly alert?: (alert: OrganizationRecordAlert) => void;
  /**
   * The narrow post-start failure signal.
   *
   * Called at most once, and only after this function has returned a runtime,
   * when derive halts under a live listener. Startup halts are not routed here:
   * they already throw out of `openOrganizationRecordRuntime`, and the
   * composition root unwinds. The host owns what a fatal failure *does* —
   * closing the listener and setting the exit code are process concerns this
   * module deliberately does not reach into.
   */
  readonly onFatal?: (failure: Error) => void;
}

/**
 * The startup-cached health of the optional permission pilot.
 *
 * `absent` is the clean pre-activation state. `degraded` means activation,
 * eligibility, or its backing notice audit failed validation; keeping that
 * state distinct prevents both hidden empty reads and permanent rejection of
 * already-frozen notice-qualified envelopes.
 */
export type OrganizationPermissionPilotRuntimeHealth =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'ready';
      readonly activation: OrganizationPermissionPilotActivationMarkerV1;
    }
  | { readonly kind: 'degraded'; readonly failure: Error };

export type ReviewerRestrictedRuntimeHealth =
  | {
      readonly kind: 'ready';
      readonly readiness: ReviewerRestrictedReadiness;
    }
  | {
      readonly kind: 'degraded';
      readonly failure: Error;
      readonly readiness?: ReviewerRestrictedReadiness;
    };

export type OrganizationMemberReadableRuntimeHealth =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ready'; readonly readiness: OrganizationMemberReadableReadiness }
  | { readonly kind: 'degraded'; readonly failure: Error; readonly readiness?: OrganizationMemberReadableReadiness };

export interface OrganizationRecordRuntime
  extends OrganizationRecordHttpApplication {
  /** Walks the internal chain. Run at process start and before every backup. */
  verifyChain(): OrganizationRecordChainVerification;
  readonly follower: OrganizationRecordFollower;
  readonly permissionPilotHealth: OrganizationPermissionPilotRuntimeHealth;
  readonly reviewerRestrictedHealth: ReviewerRestrictedRuntimeHealth;
  readonly organizationMemberReadableHealth: OrganizationMemberReadableRuntimeHealth;
  readonly reviewerRecords: ReviewerRecordPort;
  /** The fixed, newest-first <=20 canonical rows. Empty only before activation. */
  readPermissionPilotEligibleRecords(): readonly OrganizationPermissionPilotEligibleRecord[];
  /** The post-start derive failure, once one has happened. */
  readonly fatalFailure: Error | null;
  /**
   * Drains derive, verifies the chain, then closes both handles. Await this
   * before closing anything it depends on; it rejects when the stop was not
   * clean, which is what makes the stopped state safe to back up.
   */
  close(): Promise<void>;
}

function defaultAlert(alert: OrganizationRecordAlert): void {
  process.stderr.write(
    `organization-record ${alert.kind}: ${alert.message}${
      alert.log_position === null ? '' : ` (position ${alert.log_position})`
    }\n`,
  );
}

function chainFailureDetail(
  verification: OrganizationRecordChainVerification,
): string {
  return verification.failures
    .map((failure) => `${failure.position}:${failure.kind}:${failure.detail}`)
    .join('; ');
}

function deriveHaltFailure(alert: OrganizationRecordAlert): Error {
  return new Error(
    `organization record derive halted: ${alert.message}${
      alert.log_position === null ? '' : ` (position ${alert.log_position})`
    }`,
    alert.cause === undefined ? undefined : { cause: alert.cause },
  );
}

function assertPermissionPilotEvidence(
  records: readonly OrganizationPermissionPilotEligibleRecord[],
  evidenceStore: OrganizationRecordAuthorizationEvidenceStore,
  organizationId: string,
): void {
  for (const { row, eligibility } of records) {
    const envelope = validateOrganizationRecordEnvelope(
      parseOrganizationRecordEnvelope(row.canonical_envelope),
    );
    const evidence = envelope.reviewer.authorization;
    const match = evidenceStore.findAllowedApprovalAuthorizationEvidence({
      organization_id: organizationId,
      installation_id: envelope.submitter.installation_id,
      approval_id: evidence.approval_id,
      action: evidence.action,
      request_id: evidence.request_id,
      principal_id: evidence.principal_id,
      membership_id: evidence.membership_id,
      request_sha256: evidence.request_sha256,
      provider_event_sha256: evidence.provider_event_sha256,
      adapter_binding_id: evidence.adapter_binding_id,
      permission_grant_id: evidence.permission_grant_id,
      reason_code: evidence.reason_code,
      evaluated_at: evidence.evaluated_at,
    });
    const proof =
      match.status === 'matched'
        ? match.permission_pilot_eligibility
        : undefined;
    if (
      proof === undefined ||
      proof.policy_id !== eligibility.policy_id ||
      proof.presentation_policy_id !== eligibility.presentation_policy_id ||
      proof.audience_notice_sha256 !== eligibility.audience_notice_sha256 ||
      proof.message_presentation_sha256 !==
        eligibility.message_presentation_sha256
    ) {
      throw new Error(
        `organization permission pilot eligibility at record position ${row.position} has no exact audited notice evidence`,
      );
    }
  }
}

/**
 * Maps an ingest failure onto the member-visible outcome.
 *
 * Only the terminal codes become a permanent rejection. An expired lease, a
 * revoked installation, or an unexpected fault stays retryable, so the
 * submitter keeps its frozen envelope and resends the same bytes on the next
 * cycle instead of writing a terminal slot it can never take back.
 */
function ingestFailure(error: unknown): unknown {
  if (error instanceof OrganizationRecordIngestRejectionError) return error;
  if (error instanceof AuthorityOperationError) return error;
  if (isOrganizationRecordError(error) && error.code === 'idempotency_conflict') {
    return new OrganizationRecordIngestRejectionError(
      'record_idempotency_conflict',
      'this idempotency key was already used with a different envelope',
    );
  }
  return new AuthorityOperationError(
    'unavailable',
    'organization record ingest is temporarily unavailable',
  );
}

/**
 * Opens both record databases, brings them to the current schema, verifies the
 * append chain, and starts the derive follower's catch-up.
 *
 * A halted startup derivation is fatal: this function throws, the composition
 * root unwinds, and the supervisor restart exercises the same catch-up path
 * rather than leaving a healthy-looking process permanently stale. A halt after
 * start is fatal too, through `onFatal` — the design's rule is that visible
 * staleness never becomes silent staleness, and a live listener that keeps
 * accepting appends nothing will ever derive is exactly the silent case.
 * Steady-state appends stay independent of derive's progress: the log commits
 * and the follower catches up on the in-process nudge.
 */
export async function openOrganizationRecordRuntime(
  options: OpenOrganizationRecordRuntimeOptions,
): Promise<OrganizationRecordRuntime> {
  const operatorAlert = options.alert ?? defaultAlert;
  let started = false;
  let fatalFailure: Error | null = null;
  const alert = (event: OrganizationRecordAlert): void => {
    operatorAlert(event);
    if (event.kind !== 'derive-halted' || fatalFailure !== null) return;
    fatalFailure = deriveHaltFailure(event);
    // Before `started`, the startup drain below turns the same halt into a
    // throw. Signalling here as well would ask the host to tear down a runtime
    // it was never handed.
    if (started) options.onFatal?.(fatalFailure);
  };
  // One closed reviewer-v2 validator for this organization and authority,
  // built here and threaded into every record-side caller that may read a
  // reviewer-v2 document. The record workspace has no import edge to the
  // protocol package, so this is the only reviewer-v2 reading it ever gets.
  const reviewerValidator = reviewerRestrictedEnvelopeValidator({
    organization_id: options.organization_id,
    authority_id: options.authority_id,
  });
  const organizationMemberValidator = organizationMemberReadableEnvelopeValidator({
    organization_id: options.organization_id,
    authority_id: options.authority_id,
  });
  const log = OrganizationRecordLogStore.open(options.record_log_database_path, {
    organization_id: options.organization_id,
    authority_id: options.authority_id,
    reviewer_validator: reviewerValidator,
    organization_member_validator: organizationMemberValidator,
  });
  const reviewerRecords = createReviewerRecordPort(log.database, {
    organization_id: options.organization_id,
    authority_id: options.authority_id,
    reviewer_validator: reviewerValidator,
  });
  let derived: OrganizationRecordDerivedStore | undefined;
  try {
    const verification = verifyOrganizationRecordChain(log);
    if (verification.failures.length > 0) {
      throw new Error(
        `organization record log chain verification failed: ${chainFailureDetail(verification)}`,
      );
    }
    derived = OrganizationRecordDerivedStore.open(
      options.record_derived_database_path,
      { organization_id: options.organization_id },
    );
    // Derive reads the log as data at rest through its own reader; it never
    // holds the append store. Sharing the open handle keeps one file lock in
    // this single-process host while preserving that direction.
    const follower = new OrganizationRecordFollower({
      logReader: new OrganizationRecordLogReader(log.database),
      derived,
      alert,
      reviewerValidator,
      organizationMemberValidator,
    });
    const permissionPilotReader = new OrganizationPermissionPilotReader(
      log.database,
      { organization_id: options.organization_id },
    );
    let permissionPilotHealth: OrganizationPermissionPilotRuntimeHealth;
    try {
      const permissionPilotState = permissionPilotReader.validateState();
      if (permissionPilotState.activation === null) {
        permissionPilotHealth = Object.freeze({ kind: 'absent' });
      } else {
        assertPermissionPilotEvidence(
          permissionPilotState.eligible_records,
          options.evidence,
          options.organization_id,
        );
        permissionPilotHealth = Object.freeze({
          kind: 'ready',
          activation: permissionPilotState.activation,
        });
      }
    } catch (error) {
      const failure =
        error instanceof Error
          ? error
          : new Error(`permission pilot validation failed: ${String(error)}`);
      // The optional permission slice fails independently closed. The explicit
      // degraded state keeps the append-only record and deterministic derive
      // machines live without pretending this was clean non-activation.
      operatorAlert({
        kind: 'permission-pilot-inactive',
        message: `organization permission pilot is degraded: ${failure.message}`,
        log_position: null,
        cause: failure,
      });
      permissionPilotHealth = Object.freeze({ kind: 'degraded', failure });
    }
    let reviewerRestrictedHealth: ReviewerRestrictedRuntimeHealth;
    try {
      const readiness = verifyReviewerRestrictedReadiness({
        records: reviewerRecords,
        evidence: options.evidence,
        organization_id: options.organization_id,
        authority_id: options.authority_id,
      });
      if (!readiness.ready) {
        throw new Error(
          readiness.failures
            .map((failure) => `${failure.kind}:${failure.detail}`)
            .join('; '),
        );
      }
      reviewerRestrictedHealth = Object.freeze({ kind: 'ready', readiness });
    } catch (error) {
      const failure =
        error instanceof Error
          ? error
          : new Error(`reviewer-restricted admission failed: ${String(error)}`);
      operatorAlert({
        kind: 'reviewer-restricted-inactive',
        message: `reviewer-restricted V1 is degraded: ${failure.message}`,
        log_position: null,
        cause: failure,
      });
      reviewerRestrictedHealth = Object.freeze({ kind: 'degraded', failure });
    }
    let organizationMemberReadableHealth: OrganizationMemberReadableRuntimeHealth;
    if (
      !isOrganizationMemberReadableRecordingPolicy(
        options.organization_recording_policy_v1,
      )
    ) {
      // Clean legacy/reviewer-only state. Historical schema-v3 rows remain
      // derivable, but no new member-v3 append authority is minted.
      organizationMemberReadableHealth = Object.freeze({ kind: 'absent' });
    } else try {
      const readiness = verifyOrganizationMemberReadableReadiness({
        database: log.database,
        organization_id: options.organization_id,
        validator: organizationMemberValidator,
        evidence: options.evidence,
        organization_recording_policy_v1:
          options.organization_recording_policy_v1,
      });
      if (!readiness.ready) {
        throw new Error(readiness.failures.map((failure) => failure.detail).join('; '));
      }
      organizationMemberReadableHealth = Object.freeze({ kind: 'ready', readiness });
    } catch (error) {
      const failure = error instanceof Error
        ? error
        : new Error(`organization-member-readable admission failed: ${String(error)}`);
      operatorAlert({
        kind: 'organization-member-readable-inactive',
        message: `organization-member-readable V1 is degraded: ${failure.message}`,
        log_position: null,
        cause: failure,
      });
      organizationMemberReadableHealth = Object.freeze({ kind: 'degraded', failure });
    }
    const authority = new OrganizationRecordIngestAuthority({
      authority: options.authority,
      evidence: options.evidence,
      permissionPilotHealth,
      reviewerRestrictedHealth,
      organizationMemberReadableHealth,
      organizationRecordingPolicy: options.organization_recording_policy_v1,
    });
    const ingest = new OrganizationRecordIngest({
      log,
      authority,
      receiptSigner: authority,
      reviewerValidator,
      organizationMemberValidator,
      onAppended: () => follower.nudge(),
      alert,
    });
    const progress = await follower.drain();
    if (progress.halted) {
      throw new Error(
        `organization record derive halted during startup catch-up at cursor ${progress.cursor_position}`,
      );
    }
    const runtimeDerived = derived;
    let closePromise: Promise<void> | undefined;
    const runtime: OrganizationRecordRuntime = {
      async submitRecordEnvelope(
        request: SubmitOrganizationRecordEnvelopeRequestV1,
      ): Promise<AcceptedOrganizationRecordV1> {
        // Refusing after a halt is the honest answer: the log would still
        // accept the append, but nothing would ever derive it, and the member
        // would hold a receipt for a record the organization cannot read.
        // Retryable, not terminal — the frozen envelope survives the restart.
        if (fatalFailure !== null) {
          throw new AuthorityOperationError(
            'unavailable',
            'organization record ingest is stopped after a derive failure',
          );
        }
        try {
          const appended = options.authorization_fence === undefined
            ? await ingest.append(request.record_envelope)
            : await options.authorization_fence.withWrite(() =>
                ingest.append(request.record_envelope),
              );
          return validateAcceptedOrganizationRecord({
            record_receipt: appended.signed_receipt,
          });
        } catch (error) {
          throw ingestFailure(error);
        }
      },
      verifyChain: () => verifyOrganizationRecordChain(log),
      follower,
      permissionPilotHealth,
      reviewerRestrictedHealth,
      organizationMemberReadableHealth,
      reviewerRecords,
      readPermissionPilotEligibleRecords(): readonly OrganizationPermissionPilotEligibleRecord[] {
        if (permissionPilotHealth.kind === 'absent') return Object.freeze([]);
        if (permissionPilotHealth.kind === 'degraded') {
          throw new Error(
            'organization permission pilot record selection is unavailable',
            { cause: permissionPilotHealth.failure },
          );
        }
        return permissionPilotReader.readEligibleRecordsDescending();
      },
      get fatalFailure(): Error | null {
        return fatalFailure;
      },
      close(): Promise<void> {
        closePromise ??= (async (): Promise<void> => {
          const failures: unknown[] = [];
          // The caller has already drained the HTTP listener, so no new append
          // can arrive. Absorbing the nudges still in flight is what keeps a
          // stopped state consistent: a derived store behind the log is a
          // rebuildable projection, but only if the stop admits it is stale.
          try {
            const drained = await follower.drain();
            if (drained.halted) {
              failures.push(
                fatalFailure ??
                  new Error(
                    `organization record derive halted at cursor ${drained.cursor_position}`,
                  ),
              );
            }
          } catch (error) {
            failures.push(error);
          }
          // Pre-backup verification, run while the handle is still open. The
          // design's "before every backup" has no other home: the operator
          // backs up a stopped state directory, and a stop that succeeded is
          // precisely the claim that its chain still verifies.
          try {
            const stopVerification = verifyOrganizationRecordChain(log);
            if (stopVerification.failures.length > 0) {
              failures.push(
                new Error(
                  `organization record log chain verification failed at close: ${chainFailureDetail(stopVerification)}`,
                ),
              );
            }
          } catch (error) {
            failures.push(error);
          }
          // Both handles close either way. Leaving a file locked by a process
          // that is already stopping helps nobody; the throw below is what
          // tells the operator the stopped state is not backup-safe.
          try {
            runtimeDerived.close();
          } catch (error) {
            failures.push(error);
          }
          try {
            log.close();
          } catch (error) {
            failures.push(error);
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) {
            throw new AggregateError(
              failures,
              'organization record shutdown failed',
            );
          }
        })();
        return closePromise;
      },
    };
    started = true;
    return runtime;
  } catch (error) {
    try {
      derived?.close();
    } catch {}
    try {
      log.close();
    } catch {}
    throw error;
  }
}
