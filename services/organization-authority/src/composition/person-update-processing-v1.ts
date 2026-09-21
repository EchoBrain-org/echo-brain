import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { withoutCoreRuntimeContentV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import type { ApprovalWorkflowComponentsV1 } from '@echo-brain/organization-processing/ports/approval-workflow-bundle-v1';
import { AdapterError, type DecisionProcessorAdapter, type MeetingDocument, type MeetingSourceAdapter } from '@echo-brain/organization-processing/core';
import { AdmittedMeetingProcessingCycleV1, type AdmittedMeetingProcessingAdmissionV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/meeting-processing-cycle-v1';
import { SqliteAuthorityMeetingProcessingStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1';
import { normalizePersonUpdateV1, personUpdateCursorPolicyV1, personUpdateSourceIdentityV1, PERSON_UPDATE_SOURCE_ADAPTER_V1 } from '@echo-brain/organization-processing/admitted-meeting-processing/person-update-source-v1';
import { SqlitePersonUpdateInboxV1, type StoredPersonUpdateV1 } from '../adapters/persistence/sqlite/person-update-inbox-v1.js';

class ReviewerUnavailable extends Error {}

/** Resolve authored provenance only against the immutable, organization-custodied submission. */
export function verifiedPersonUpdateActorV1(inbox: SqlitePersonUpdateInboxV1, document: MeetingDocument): AuthorityPersonMembershipBinding | 'unavailable' | undefined {
  if (document.provenance.source.adapter_id !== PERSON_UPDATE_SOURCE_ADAPTER_V1) return undefined;
  let locator: { organization_id: string; membership_id: string; request_id: string };
  try { locator = JSON.parse(document.provenance.external_id) as typeof locator; }
  catch { return 'unavailable'; }
  if (typeof locator?.organization_id !== 'string' || typeof locator.membership_id !== 'string' || typeof locator.request_id !== 'string') return 'unavailable';
  const row = inbox.read(locator, locator.request_id);
  if (row === undefined || !inbox.isActive(row)) return 'unavailable';
  inbox.validate(row);
  if (canonicalJson(normalizePersonUpdateV1(row)) !== canonicalJson(document)) return 'unavailable';
  return { organization_id: row.organization_id, principal_id: row.principal_id, membership_id: row.membership_id, membership_type: row.membership_type };
}

/** One new/retryable item per serialized tick. Approval effects use the shared frozen pipeline. */
export class PersonUpdateProcessingV1 {
  private readonly cycle: AdmittedMeetingProcessingCycleV1;
  private readonly state: SqliteAuthorityMeetingProcessingStateV1;
  private current: StoredPersonUpdateV1 | undefined;

  constructor(
    private readonly inbox: SqlitePersonUpdateInboxV1,
    organizationId: string,
    admission: AdmittedMeetingProcessingAdmissionV1,
    processor: DecisionProcessorAdapter,
    private readonly approvals: ApprovalWorkflowComponentsV1,
    now: () => string = () => new Date().toISOString(),
  ) {
    const identity = personUpdateSourceIdentityV1(organizationId);
    const binding = { source: identity, processor: admission.processor, organization_id: organizationId, normalizer_version: 'person-update-note-v1' };
    const digest = canonicalSha256(binding);
    inbox.database.prepare(`INSERT INTO authority_processing_sources_v1 (semantic_input_sha256, source_adapter_id, source_adapter_instance_id, source_adapter_version, cutoff_at, processor_adapter_id, processor_instance_id, processor_adapter_version, processor_configuration_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (semantic_input_sha256) DO NOTHING`)
      .run(digest, identity.adapter_id, identity.instance_id, identity.version, admission.source.cutoff_at, admission.processor.adapter_id, admission.processor.instance_id, admission.processor.version, admission.processor.configuration_sha256);
    const assertActive = () => {
      const row = this.current;
      if (row === undefined || !inbox.isActive(row) || approvals.can_review_as?.(row) !== true) throw new ReviewerUnavailable();
    };
    this.state = new SqliteAuthorityMeetingProcessingStateV1(inbox.database, personUpdateCursorPolicyV1, processor.identity.adapter_id, now, { semantic_input_sha256: digest, assert_active: assertActive });
    const source: MeetingSourceAdapter = {
      identity,
      validateConfig: () => ({ ok: true, errors: [] }),
      healthCheck: async () => ({ status: 'healthy', checked_at: now() }),
      pull: async (_request, context) => {
        context?.signal.throwIfAborted();
        assertActive();
        return { meetings: [normalizePersonUpdateV1(this.current!)] };
      },
    };
    this.cycle = new AdmittedMeetingProcessingCycleV1({
      source, processor, state: this.state, source_cursor_policy: personUpdateCursorPolicyV1,
      stager: {
        stage: async (input, context) => {
          context?.signal.throwIfAborted();
          assertActive();
          // Candidate creation and this link share the Authority store, while approval may use another store.
          inbox.update(this.current!, { status: 'processing' }, input.candidate.candidate_id);
          const result = await approvals.stager.stage(input, context);
          if (result.kind === 'quarantined') inbox.update(this.current!, { status: 'blocked', reason: 'approval_delivery_quarantined' });
          else if (result.kind === 'staged') inbox.update(this.current!, { status: 'awaiting_approval' });
          else inbox.update(this.current!, { status: 'blocked', reason: result.kind === 'revoked' ? 'reviewer_unavailable' : 'temporarily_unavailable' });
          return result;
        },
        // Reconciliation is global and is separately retained by the existing meeting/approval lifecycle.
        reconcilePendingDeliveries: async () => {},
        reconcileSuperseded: async () => {},
      },
    });
  }

  refreshOutcomes(): void {
    for (const row of this.inbox.awaiting()) {
      if (row.candidate_id === null) throw new Error('Person update handoff lacks a candidate');
      const approvalId = `apr_${row.candidate_id.slice(4)}`;
      const outcome = this.approvals.read_terminal_outcome?.(approvalId);
      if (outcome !== undefined) this.inbox.update(row, { status: 'resolved', outcome });
      else if (!this.inbox.isActive(row)) this.inbox.update(row, { status: 'blocked', reason: 'reviewer_unavailable' });
    }
  }

  runOnce(signal: AbortSignal): Promise<void> {
    return withoutCoreRuntimeContentV1(() => this.run(signal));
  }

  private async run(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.refreshOutcomes();
    const row = this.inbox.claim();
    if (row === undefined) return;
    this.current = row;
    try {
      try { this.inbox.validate(row); }
      catch { this.inbox.update(row, { status: 'failed', reason: 'processing_rejected' }); throw new Error('Person update persisted payload is invalid'); }
      await this.cycle.runOnce(signal);
      signal.throwIfAborted();
      const frozen = await this.state.readFrozenCandidateForSourceRevision({ external_id: normalizePersonUpdateV1(row).provenance.external_id, canonical_revision: row.payload_sha256 });
      if (frozen === undefined) throw new Error('Person update processing produced no frozen candidate');
      if (frozen.disposition === 'no_signals') this.inbox.update(row, { status: 'no_signals' }, frozen.candidate_id);
      else if (frozen.disposition === 'actionable' && frozen.state === 'staged') this.inbox.update(row, { status: 'awaiting_approval' }, frozen.candidate_id);
      else if (frozen.disposition !== 'actionable') throw new Error('Immutable Person update unexpectedly coalesced');
      this.refreshOutcomes();
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof ReviewerUnavailable) this.inbox.update(row, { status: 'blocked', reason: 'reviewer_unavailable' });
      else if (error instanceof AdapterError) {
        // Once handed off, shared approval reconciliation still owns the frozen
        // candidate. A delivery refusal cannot make that pending work terminal.
        const current = this.inbox.read(row, row.request_id);
        if (current === undefined) throw new Error('Person update work disappeared');
        this.inbox.update(row, error.code === 'permanently_rejected' && current.candidate_id === null
          ? { status: 'failed', reason: 'processing_rejected' }
          : { status: 'blocked', reason: 'temporarily_unavailable' });
      }
      else throw error;
    } finally { this.current = undefined; }
  }
}
