import type Database from 'better-sqlite3';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { PERSON_MEETINGS_PATH_V1, validatePersonMeetingRequestV1, validatePersonMeetingResultV1,
  type OrganizationPersonToolV4, type PersonMeetingResultsV1, type PersonMeetingReviewV1 } from '@echo-brain/organization-api';
import type { ProviderHttpApplicationV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { MeetingSourceAdapter } from '@echo-brain/organization-processing/core';
import type { AdmittedMeetingSourceCursorPolicyV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-source-cursor-policy-v1';
import type { DecisionProcessorBundleV1 } from '@echo-brain/organization-processing/ports/decision-processor-bundle-v1';
import type { AdmittedMeetingProcessingCommitmentsV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-processing-commitments';
import type { ApprovalWorkflowContextV1 } from '@echo-brain/organization-processing/ports/approval-workflow-bundle-v1';
import type { ExtractionAttemptStoreV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/extraction-attempt-store-v1';
import { AdmittedMeetingProcessingCycleV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/meeting-processing-cycle-v1';
import { SqliteApprovalWorkflowStateV1, SqliteAuthorityMeetingProcessingStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1';
import { readAdmittedMeetingProcessingCommitmentsV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-processing-commitments';
import { bindApprovalWorkflowStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/approval-workflow-state-v1';
import { SqlitePersonMeetingIntakeV1, type MeetingIntakePersonV1, type MeetingIntakeSettingV1, type PersonalMeetingCheckpointCodecV1 } from '../adapters/persistence/sqlite/person-meeting-intake-v1.js';
import { SqliteSourceAdmissionStoreV1 } from '../adapters/persistence/sqlite/source-admission-v1.js';
import { approvalProposalTextV1, createApprovalCoreV1, type ApprovalCoreOptionsV1, type ApprovalCoreV1, type ApprovalProposalViewV1 } from './approval-core-v1.js';
import { personToolAuthenticationV1 } from './person-tool-authentication-v1.js';
import type { PersonIdentitySessionApplication } from '../application/person-identity-sessions.js';
import type { OrganizationAuthorityProcessingCycleV1 } from './organization-authority-service-lifecycle.js';

export interface PersonMeetingProviderV1 {
  readonly id: string; readonly normalizer_version: string;
  /** The admission label for this provider's custodian; defaults to a person's own OAuth account. */
  readonly custodian_assurance?: string;
  readonly connection_http: ProviderHttpApplicationV1;
  readonly cursor: PersonalMeetingCheckpointCodecV1 & { readonly policy: AdmittedMeetingSourceCursorPolicyV1 };
  tool(token: string): OrganizationPersonToolV4;
  open(person: MeetingIntakePersonV1, current: () => void, signal?: AbortSignal): Promise<{
    readonly identity: MeetingSourceAdapter['identity']; readonly custodian: unknown; readonly email: string; readonly workspace: string;
    current(): void;
    folders(): Promise<PersonMeetingResultsV1['home']['folders']>;
    browse(folder: string): Promise<PersonMeetingResultsV1['browse']>;
    preview(meeting: string): Promise<PersonMeetingResultsV1['open']>;
  }>;
  source(setting: MeetingIntakeSettingV1, current: () => void): MeetingSourceAdapter & { requireCurrent(): void };
}
export function meetingIntakePersonV1(value: MeetingIntakePersonV1): MeetingIntakePersonV1 {
  return { organization_id: value.organization_id, principal_id: value.principal_id, membership_id: value.membership_id };
}
type ProcessorCommitmentsV1 = (instance_id: string) => AdmittedMeetingProcessingCommitmentsV1['processor'] | undefined;
/**
 * The one source rule: a source per person and tool account, with a processor instance per person.
 * Projects never enter the source, so one meeting is extracted and reviewed once whatever projects it suggests.
 */
export function ensurePersonMeetingSourceV1(intake: SqlitePersonMeetingIntakeV1, input: {
  readonly provider: Pick<PersonMeetingProviderV1, 'normalizer_version' | 'custodian_assurance'>; readonly person: MeetingIntakePersonV1;
  readonly session: { readonly identity: MeetingSourceAdapter['identity']; readonly custodian: unknown };
  readonly commitments: ProcessorCommitmentsV1; readonly current: () => void;
}): MeetingIntakeSettingV1 {
  const person = meetingIntakePersonV1(input.person);
  const processor = input.commitments(`personal-${canonicalSha256(person).slice(7, 39)}`);
  if (!processor) throw new AuthorityOperationError('unavailable', 'Meeting processing unavailable');
  return intake.ensure({ person, identity: input.session.identity, normalizer_version: input.provider.normalizer_version, custodian: input.session.custodian, processor, current: input.current,
    ...(input.provider.custodian_assurance === undefined ? {} : { custodian_assurance: input.provider.custodian_assurance }) });
}
/** Queues meetings into a person's own source without an HTTP session (the staging canary and setup). */
export async function queuePersonMeetingsV1(input: {
  readonly database: Database.Database; readonly provider: PersonMeetingProviderV1; readonly person: MeetingIntakePersonV1;
  readonly meeting_ids: readonly string[]; readonly commitments: ProcessorCommitmentsV1; readonly signal?: AbortSignal;
}): Promise<MeetingIntakeSettingV1> {
  const person = meetingIntakePersonV1(input.person), intake = new SqlitePersonMeetingIntakeV1(input.database, input.provider.cursor);
  const current = () => { input.signal?.throwIfAborted(); intake.currentPerson(person); };
  const session = await input.provider.open(person, current, input.signal);
  for (const meeting of input.meeting_ids) await session.preview(meeting);
  return input.database.transaction(() => {
    session.current();
    const setting = ensurePersonMeetingSourceV1(intake, { provider: input.provider, person, session, commitments: input.commitments, current });
    for (const meeting of input.meeting_ids) intake.enqueue(setting, meeting, null, current);
    return setting;
  }).immediate();
}
/** One processing lane, shared custody/candidates/append, and one approval core for every proposal. */
export function createPersonMeetingRuntimeV1(options: {
  readonly database: Database.Database; readonly sessions: Pick<PersonIdentitySessionApplication, 'authenticateAccess'>;
  /** One provider per tool; a stored source belongs to the provider whose cursor policy names its source adapter. */
  readonly providers: readonly PersonMeetingProviderV1[]; readonly processor: DecisionProcessorBundleV1;
  readonly approval: Omit<ApprovalWorkflowContextV1, 'state'>; readonly extraction_attempts: ExtractionAttemptStoreV1;
  /** Static, core-independent approval core options (Task 8 adds after_record). */
  readonly approval_core?: Pick<ApprovalCoreOptionsV1, 'now'>;
}) {
  const { database: db, providers, processor } = options;
  if (providers.length === 0 || new Set(providers.map(p => p.id)).size !== providers.length || new Set(providers.map(p => p.cursor.policy.source_adapter_id)).size !== providers.length) {
    throw new Error('Personal meeting providers need distinct tools and source adapters');
  }
  // Each provider decodes only its own checkpoints, so every source is read through its owner's intake.
  const owners = new Map(providers.map(provider => [provider.cursor.policy.source_adapter_id, { provider, intake: new SqlitePersonMeetingIntakeV1(db, provider.cursor) }]));
  const ownerOf = (sourceAdapterId: string) => {
    const owner = owners.get(sourceAdapterId);
    if (!owner) throw new AuthorityOperationError('not_found', 'Meeting tool unavailable');
    return owner;
  };
  // Person, membership and settings reads do not decode a cursor; any provider's intake serves them.
  const intake = ownerOf(providers[0]!.cursor.policy.source_adapter_id).intake;
  const authenticate = personToolAuthenticationV1(options.sessions);
  const observed = new Map<string, { checked_at: string; error: string | null; next: number }>();
  // One approval core per runtime: routes, cycles and the publisher all read and decide through it.
  const workflowState = new SqliteApprovalWorkflowStateV1(db, {
    source_cursor_policies: providers.map(p => p.cursor.policy), processor_adapter_id: processor.processor_adapter_id,
  });
  const approvalState = bindApprovalWorkflowStateV1(workflowState, () => { if (db.inTransaction) throw new Error('Approval state transaction must be idle'); });
  let core: Promise<ApprovalCoreV1> | undefined;
  const approvals = (): Promise<ApprovalCoreV1> => core ??= createApprovalCoreV1(db, { ...options.approval, state: approvalState }, {
    ...options.approval_core,
    suggestions: (sourceKey, externalId) => intake.proposalSuggestions(sourceKey, externalId),
    projects: (actor, ids) => { for (const id of ids) intake.currentPerson(actor, id); },
  }).catch((error: unknown) => { core = undefined; throw error; });
  function settings(person: MeetingIntakePersonV1) { return canonicalSha256(intake.list(person).map(({ source_key, folder_id, folder_project_id, settings_revision }) => ({ source_key, folder_id, folder_project_id, settings_revision }))); }
  async function lane(setting: MeetingIntakeSettingV1) {
    const { provider } = ownerOf(setting.source_adapter_id);
    // Pin the person's exact active membership; a source belongs to the person, not to a project.
    // Approval recovery itself can proceed without an active provider grant.
    let grant: string | undefined;
    const source = provider.source(setting, () => {
      intake.requireCurrent(setting);
      const now = intake.currentPerson(meetingIntakePersonV1(setting)).grant_sha256;
      if (grant !== undefined && now !== grant) throw new AuthorityOperationError('stale_access_state', 'Meeting access changed');
      grant = now;
    });
    const providerIntake = ownerOf(setting.source_adapter_id).intake;
    // The advance that drops a processed import from the queue records its project choices in the same transaction.
    const state = new SqliteAuthorityMeetingProcessingStateV1(db, provider.cursor.policy, processor.processor_adapter_id, undefined, setting.source_key, () => source.requireCurrent(),
      ({ expected_cursor, next_cursor }) => providerIntake.promoteConsumedImports(setting, expected_cursor, next_cursor));
    return { source, state };
  }
  // Decisions survive disconnect/restart and need no provider access. A source whose provider is not selected in
  // this runtime keeps its decisions until it is (the core's state does not route to it).
  async function publish(signal: AbortSignal) { await (await approvals()).processing.appendFinalizedApprovalsToV4(signal); }
  let after = '';
  const processing: OrganizationAuthorityProcessingCycleV1 = {
    recoverV4Appends: publish, appendFinalizedApprovalsToV4: publish,
    async observeAndFinalizePendingApprovals() {}, async reconcileReadableSearchGeneration() {},
    async pollAndStageAdmittedMeetings(signal) {
      // A source with an unfrozen proposal stays eligible until its freeze succeeds, even with nothing left to import.
      const unfrozen = new Set(workflowState.listPendingApprovalSourceKeys());
      const eligible = intake.list().filter(s => owners.has(s.source_adapter_id) && (s.folder_id !== null || ownerOf(s.source_adapter_id).intake.checkpoint(s.source_key).manual.length > 0 || unfrozen.has(s.source_key)) && (observed.get(s.source_key)?.next ?? 0) <= Date.now());
      const setting = eligible.find(s => s.source_key > after) ?? eligible[0];
      if (!setting) return;
      after = setting.source_key;
      try {
        intake.requireCurrent(setting);
        if (setting.folder_id === null && ownerOf(setting.source_adapter_id).intake.checkpoint(setting.source_key).manual.length === 0) {
          // Only a failed freeze is left: retry it from the stored extraction, without the provider.
          await (await approvals()).stagerForSource(setting.source_key).reconcilePendingDeliveries({ signal });
          // More than one reconcile page left keeps the source eligible at once; a frozen source drops out.
          observed.set(setting.source_key, { checked_at: new Date().toISOString(), error: null, next: Date.now() });
          return;
        }
        processor.assert_admission_commitments(readAdmittedMeetingProcessingCommitmentsV1(db, setting.source_key));
        const { source, state } = await lane(setting);
        const stager = (await approvals()).stagerForSource(setting.source_key);
        const admission = await state.readAdmission();
        const { provider, intake: sourceIntake } = ownerOf(setting.source_adapter_id);
        const outcome = await new AdmittedMeetingProcessingCycleV1({ source, state, processor: processor.create_processor(admission), extraction_attempts: options.extraction_attempts,
          source_cursor_policy: provider.cursor.policy, stager,
          source_ingestion: { store: new SqliteSourceAdmissionStoreV1(db, delivered => {
            source.requireCurrent(); state.assertCurrentSourceAdmission(source.identity);
            if (provider.cursor.write(sourceIntake.checkpoint(setting.source_key)) !== admission.source.cursor) throw new AuthorityOperationError('stale_access_state', 'Meeting intake changed during acquisition');
            // Same transaction as the admission: a folder delivery's project becomes the meeting's suggestion.
            sourceIntake.recordAdmission(setting, delivered.item.external_id);
          }),
            scope: { organization_id: setting.organization_id, custody_ref: `person:${setting.membership_id}`, access_policy_ref: `personal-meeting:${setting.source_key}`, analysis_policy: 'automatic' } },
        }).runOnce(signal);
        const queued = sourceIntake.checkpoint(setting.source_key).manual.length > 0 || (outcome.cursor_advanced && !outcome.kind.startsWith('empty'));
        observed.set(setting.source_key, { checked_at: new Date().toISOString(), error: null, next: Date.now() + (queued ? 0 : 300_000) });
      } catch (error) {
        signal.throwIfAborted();
        const remaining = ownerOf(setting.source_adapter_id).intake.checkpoint(setting.source_key);
        // Nothing left to retry: the import queue is empty and every proposal of this source is frozen.
        if (remaining.folder === null && remaining.manual.length === 0 && !workflowState.listPendingApprovalSourceKeys().includes(setting.source_key)) { observed.delete(setting.source_key); return; }
        // Fixed, content-free status; one broken grant cannot starve another person's work.
        observed.set(setting.source_key, { checked_at: new Date().toISOString(), error: 'Meeting intake needs attention. Check the connection, folder access, and project access.', next: Date.now() + 60_000 });
        if (!(error instanceof AuthorityOperationError) && !(error instanceof Error)) throw error;
      }
    },
  };
  /** True when the access check passes, false when it refuses; any other failure is rethrown. */
  function allowed(check: () => unknown): boolean {
    try { check(); return true; }
    catch (error) { if (error instanceof AuthorityOperationError) return false; throw error; }
  }
  // Meetings API v1 names one project: the first of the proposal's projects (its decision's, or its readable suggestions).
  function reviewView(view: ApprovalProposalViewV1): PersonMeetingReviewV1 {
    return { approval_id: view.approval_id, title: view.title, project_id: view.project_ids[0] ?? null, status: view.status };
  }
  const application: ProviderHttpApplicationV1 = {
    routes: [{ route_id: 'personal-meetings', method: 'POST', path: PERSON_MEETINGS_PATH_V1 }],
    async accept(request) {
      if (request.route_id !== 'personal-meetings') throw new AuthorityOperationError('not_found', 'Meeting route unavailable');
      const header = request.headers.authorization;
      if (!header?.startsWith('Bearer ') || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.content_type ?? '')) throw new AuthorityOperationError('invalid_request', 'Invalid meeting request');
      const token = header.slice(7), authorization = authenticate(token), person = meetingIntakePersonV1(authorization);
      const current = () => { request.signal?.throwIfAborted(); if (canonicalSha256(authenticate(token)) !== canonicalSha256(authorization)) throw new AuthorityOperationError('stale_access_state', 'Person session changed'); };
      let input;
      try { input = validatePersonMeetingRequestV1(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.raw_body))); }
      catch { throw new AuthorityOperationError('invalid_request', 'Invalid meeting request'); }
      const provider = providers.find(p => p.id === input.tool_id);
      if (!provider) throw new AuthorityOperationError('not_found', 'Meeting tool unavailable');
      const result = async (): Promise<unknown> => {
        if (input.operation === 'reviews' || input.operation === 'review_open' || input.operation === 'review') {
          // Reviews belong to the person who brought the meeting in, whatever projects it suggests.
          const reviewer = allowed(() => intake.currentPerson(person));
          if (input.operation === 'reviews') return { reviews: reviewer ? (await approvals()).proposals(person).map(reviewView) : [] };
          if (!reviewer) throw new AuthorityOperationError('not_found', 'Meeting review unavailable');
          const approvalCore = await approvals();
          const view = approvalCore.proposal(input.approval_id);
          if (!view || view.reviewer.organization_id !== person.organization_id || view.reviewer.principal_id !== person.principal_id
            || view.reviewer.membership_id !== person.membership_id) throw new AuthorityOperationError('not_found', 'Meeting review unavailable');
          if (input.operation === 'review_open') return { review: reviewView(view), snapshot_sha256: view.snapshot_sha256, content: approvalProposalTextV1(view.snapshot_json) };
          const action = input;
          // Until the v2 contract (Task 9): one project or Only me, no owners.
          const decided = approvalCore.decide('desktop', { approval_id: action.approval_id, command_id: action.command_id, snapshot_sha256: action.snapshot_sha256 as `sha256:${string}`,
            action: action.action, project_ids: action.project_id === null ? [] : [action.project_id], share_transcript: action.share_transcript, owners: [] }, () => {
            current(); const a = authenticate(token);
            return { actor: { organization_id: a.organization_id, principal_id: a.principal_id, membership_id: a.membership_id }, evidence: { kind: 'person-session', sha256: a.authorization_sha256 } };
          });
          if (decided.kind === 'already_decided') throw new AuthorityOperationError('stale_access_state', 'Meeting review has already been resolved');
          if (decided.kind === 'stale') throw new AuthorityOperationError('stale_access_state', 'Meeting review has changed');
          return { status: decided.status };
        }
        if (input.operation === 'cancel_import') {
          const setting = intake.list(person).find(s => s.source_key === input.source_key);
          if (!setting) throw new AuthorityOperationError('not_found', 'Meeting import unavailable');
          ownerOf(setting.source_adapter_id).intake.cancelImport(setting, input.meeting_id, current); observed.delete(setting.source_key); return { status: 'cancelled' };
        }
        if (input.operation === 'watch' && input.folder_id === null) {
          current(); db.transaction(() => {
            if (settings(person) !== input.settings_sha256) throw new AuthorityOperationError('stale_access_state', 'Meeting settings changed. Reload them.');
            const old = intake.list(person).find(s => s.folder_id !== null); if (old) ownerOf(old.source_adapter_id).intake.watch(old, null, null, current);
          }).immediate(); return { status: 'saved' };
        }
        const linked = provider.tool(token).personal_status === 'linked';
        let session: Awaited<ReturnType<PersonMeetingProviderV1['open']>> | null = null;
        if (linked) {
          try { session = await provider.open(person, current, request.signal); }
          catch (error) { current(); if (input.operation !== 'home') throw error; }
        }
        if (input.operation === 'home') {
          const folders = session === null ? [] : await session.folders();
          return { connected: session !== null, email: session?.email ?? null, workspace: session?.workspace ?? null, folders, settings_sha256: settings(person),
            // Meetings API v1 still names the watched folder's project `project_id`.
            sources: intake.list(person).filter(s => s.source_adapter_id === provider.cursor.policy.source_adapter_id).map(s => ({ source_key: s.source_key, folder_id: s.folder_id, project_id: s.folder_project_id,
              baseline: ownerOf(s.source_adapter_id).intake.checkpoint(s.source_key).baseline, pending_imports: ownerOf(s.source_adapter_id).intake.checkpoint(s.source_key).manual,
              checked_at: observed.get(s.source_key)?.checked_at ?? null, error: observed.get(s.source_key)?.error ?? null })) };
        }
        if (!session) throw new AuthorityOperationError('unauthorized', 'Connect your meeting account first');
        if (input.operation === 'browse') return session.browse(input.folder_id);
        if (input.operation === 'open') return session.preview(input.meeting_id);
        const project = input.project_id;
        const grant = intake.currentPerson(person, project).grant_sha256;
        const currentProject = () => {
          session.current(); current();
          if (intake.currentPerson(person, project).grant_sha256 !== grant) throw new AuthorityOperationError('stale_access_state', 'Meeting project access changed');
        };
        // Validate folder access here; the existing worker builds its content
        // baseline from the durable pending cursor without holding this request.
        if (input.operation === 'watch') await session.browse(input.folder_id!);
        else await session.preview(input.meeting_id);
        return db.transaction(() => {
          currentProject();
          if (input.operation === 'watch' && settings(person) !== input.settings_sha256) throw new AuthorityOperationError('stale_access_state', 'Meeting settings changed. Reload them.');
          const providerIntake = ownerOf(provider.cursor.policy.source_adapter_id).intake;
          const setting = ensurePersonMeetingSourceV1(providerIntake, { provider, person, session, commitments: id => processor.current_commitments?.(id), current: currentProject });
          // "Save to" records the watched folder's project or the import's suggestion; neither changes the source.
          if (input.operation === 'watch') providerIntake.watch(setting, input.folder_id, project, currentProject);
          else providerIntake.enqueue(setting, input.meeting_id, project, currentProject);
          observed.delete(setting.source_key);
          return { status: input.operation === 'watch' ? 'saved' : 'queued' };
        }).immediate();
      };
      const body = await result(); current();
      return { status: 200, body: validatePersonMeetingResultV1(input.operation, body) };
    },
  };
  /** Queues meetings for a person through one tool, without an HTTP session (the staging canary). */
  async function queue(input: { readonly person: MeetingIntakePersonV1; readonly tool_id: string; readonly meeting_ids: readonly string[]; readonly signal?: AbortSignal }) {
    const provider = providers.find(p => p.id === input.tool_id);
    if (!provider) throw new AuthorityOperationError('not_found', 'Meeting tool unavailable');
    const setting = await queuePersonMeetingsV1({ database: db, provider, person: input.person, meeting_ids: input.meeting_ids, commitments: id => processor.current_commitments?.(id),
      ...(input.signal === undefined ? {} : { signal: input.signal }) });
    observed.delete(setting.source_key);
    return setting;
  }
  return { applications: [...providers.map(p => p.connection_http), application], processing, queue,
    tools: async (token: string) => providers.map(p => p.tool(token)), approvals, close() {} };
}
