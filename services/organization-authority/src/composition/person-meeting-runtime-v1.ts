import type Database from 'better-sqlite3';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { PERSON_MEETINGS_PATH_V2, validatePersonMeetingRequestV2, validatePersonMeetingResultV2,
  type OrganizationPersonToolV4, type PersonMeetingResultsV2, type PersonMeetingReviewV2, type PersonSyntheticMeetingV1 } from '@echo-brain/organization-api';
import type { ProviderHttpApplicationV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { observeCoreRuntimeRootV1, type CoreRuntimeObservationScopeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
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
import { SqlitePersonListDirectoryV1 } from '../adapters/persistence/sqlite/person-list-directory-v1.js';
import { approvalProposalSummaryV1, approvalProposalTextV1, createApprovalCoreV1, type ApprovalCoreOptionsV1, type ApprovalCoreV1, type ApprovalProposalViewV1 } from './approval-core-v1.js';
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
    folders(): Promise<PersonMeetingResultsV2['home']['folders']>;
    browse(folder: string): Promise<PersonMeetingResultsV2['browse']>;
    preview(meeting: string): Promise<PersonMeetingResultsV2['open']>;
    /** Optional staging capability. Persists an immutable payload before its normal import is queued. */
    submit?(meeting: PersonSyntheticMeetingV1): void;
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
/**
 * Sources that run a meeting pass at once, one pass each. The shared model-call limiter, not this, is the real
 * backpressure; a lane mostly waits on the provider and the model.
 */
const MEETING_LANES = 3;
/** Extraction stages that mean the provider is refusing or struggling; one trips the runtime-wide breaker. */
const TRANSIENT_STAGES = new Set<string>(['rate_limited', 'temporarily_unavailable', 'timeout']);
/** Meeting lanes over shared custody/candidates/append, and one approval core for every proposal. */
export function createPersonMeetingRuntimeV1(options: {
  readonly database: Database.Database; readonly sessions: Pick<PersonIdentitySessionApplication, 'authenticateAccess'>;
  /** One provider per tool; a stored source belongs to the provider whose cursor policy names its source adapter. */
  readonly providers: readonly PersonMeetingProviderV1[]; readonly processor: DecisionProcessorBundleV1;
  readonly approval: Omit<ApprovalWorkflowContextV1, 'state'>; readonly extraction_attempts: ExtractionAttemptStoreV1;
  /** Static, core-independent approval core options: the decided_at test seam and the after-record hooks. */
  readonly approval_core?: Pick<ApprovalCoreOptionsV1, 'now' | 'after_record' | 'presenters'>;
  /** Provider routes composed around the shared personal Authority runtime. */
  readonly provider_applications?: readonly ProviderHttpApplicationV1[];
  /** Test seam for MEETING_LANES. */
  readonly meeting_lanes?: number;
  /** The lifecycle's observation scope; each lane pass is a root under it, so staging content capture covers lanes. */
  readonly observation?: CoreRuntimeObservationScopeV1;
}) {
  const { database: db, providers, processor } = options, lanes = options.meeting_lanes ?? MEETING_LANES;
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
  async function lane(setting: MeetingIntakeSettingV1, fromCustody = false) {
    const { provider } = ownerOf(setting.source_adapter_id);
    // Pin the person's exact active membership; a source belongs to the person, not to a project.
    // Approval recovery itself can proceed without an active provider grant.
    let grant: string | undefined;
    const current = () => {
      intake.requireCurrent(setting);
      const now = intake.currentPerson(meetingIntakePersonV1(setting)).grant_sha256;
      if (grant !== undefined && now !== grant) throw new AuthorityOperationError('stale_access_state', 'Meeting access changed');
      grant = now;
    };
    const source = provider.source(setting, current);
    // A pull pins the grant before any spend; a retry from custody pins it here.
    if (fromCustody) current();
    const providerIntake = ownerOf(setting.source_adapter_id).intake;
    // The advance that drops a processed import from the queue records its project choices in the same transaction.
    // A retry from custody never pulls, so it is fenced by membership and settings, not by a provider observation.
    // Another import queued or cancelled during an extraction never discards its paid result: the advance is rebased.
    const state = new SqliteAuthorityMeetingProcessingStateV1(db, provider.cursor.policy, processor.processor_adapter_id, undefined, setting.source_key,
      fromCustody ? current : () => source.requireCurrent(),
      ({ expected_cursor, next_cursor }) => providerIntake.promoteConsumedImports(setting, expected_cursor, next_cursor),
      transition => providerIntake.rebase(transition));
    return { source, state };
  }
  type HeldRowV1 = { external_id: string; attempt: number; failure_stage: string; extraction_admission_sha256: string; review_lineage_id: string; review_input_sha256: string };
  /** One source's parked meetings, oldest first. IDs and allowlisted stages only. */
  function held(sourceKey: string): HeldRowV1[] {
    return db.prepare(`SELECT external_id, attempt, failure_stage, extraction_admission_sha256, review_lineage_id, review_input_sha256
      FROM authority_live_source_held_extractions_v1 WHERE source_key = ? ORDER BY held_at, review_lineage_id`).all(sourceKey) as HeldRowV1[];
  }
  /** Whether an operator authorized one more attempt for a parked meeting: one ledger read. */
  const authorized = (row: HeldRowV1) => options.extraction_attempts.inspect({
    admission_sha256: row.extraction_admission_sha256, review_lineage_id: row.review_lineage_id, review_input_sha256: row.review_input_sha256 })?.retry_authorized === true;
  // After a retry poll, a source's next retry waits a minute, so a retry that cannot reserve never blocks its intake.
  const retryAfter = new Map<string, number>();
  const retryReady = (sourceKey: string) => (retryAfter.get(sourceKey) ?? 0) <= Date.now() && held(sourceKey).some(authorized);
  /** The owner's status for a source: its oldest authorized held meeting, else its oldest held one, then any connection or access error. */
  function sourceError(sourceKey: string): string | null {
    const rows = held(sourceKey), granted = rows.find(authorized), first = granted ?? rows[0];
    const parts = [first && `Meeting ${first.external_id} is held after extraction attempt ${first.attempt} failed at ${first.failure_stage}. Later meetings continue. ${
      granted ? 'A retry is authorized and runs on the next check.' : 'An operator can authorize one more attempt.'}`, observed.get(sourceKey)?.error];
    const text = parts.filter(part => part !== undefined && part !== null).join(' ');
    return text === '' ? null : text.slice(0, 512);
  }
  // The breaker: after a transient provider failure no source starts a pass until this time; running ones finish.
  let pausedUntil = 0;
  // One pass per source at a time in this process saves wasted pulls; the attempt ledger's lease and the cursor
  // compare-and-swap keep passes in another process or after a restart correct.
  const inFlight = new Map<string, Promise<void>>();
  function track(setting: MeetingIntakeSettingV1, run: Promise<void>): Promise<void> {
    inFlight.set(setting.source_key, run.then(() => undefined, () => undefined).finally(() => inFlight.delete(setting.source_key)));
    return run;
  }
  /** One pass over one source: an authorized retry from custody, a freeze retry, or its next meeting. */
  async function runSource(setting: MeetingIntakeSettingV1, signal: AbortSignal): Promise<void> {
    // An authorized retry re-runs one parked meeting from custody, before this source's next intake.
    const retry = retryReady(setting.source_key);
    if (retry) retryAfter.set(setting.source_key, Date.now() + 60_000);
    try {
      intake.requireCurrent(setting);
      if (!retry && setting.folder_id === null && ownerOf(setting.source_adapter_id).intake.checkpoint(setting.source_key).manual.length === 0) {
        // Only a failed freeze is left: retry it from the stored extraction, without the provider.
        const progressed = await (await approvals()).stagerForSource(setting.source_key).reconcilePendingDeliveries({ signal });
        // A full page or a freeze looks again at once (a frozen source drops out); a pass that froze nothing waits.
        observed.set(setting.source_key, { checked_at: new Date().toISOString(), error: null, next: Date.now() + (progressed === true ? 0 : 30_000) });
        return;
      }
      processor.assert_admission_commitments(readAdmittedMeetingProcessingCommitmentsV1(db, setting.source_key));
      const { source, state } = await lane(setting, retry);
      const stager = (await approvals()).stagerForSource(setting.source_key);
      const admission = await state.readAdmission();
      const { provider, intake: sourceIntake } = ownerOf(setting.source_adapter_id);
      const cycle = new AdmittedMeetingProcessingCycleV1({ source, state, processor: processor.create_processor(admission), extraction_attempts: options.extraction_attempts,
        source_cursor_policy: provider.cursor.policy, stager,
        source_ingestion: { store: new SqliteSourceAdmissionStoreV1(db, delivered => {
          source.requireCurrent(); state.assertCurrentSourceAdmission(source.identity);
          if (provider.cursor.write(sourceIntake.checkpoint(setting.source_key)) !== admission.source.cursor) throw new AuthorityOperationError('stale_access_state', 'Meeting intake changed during acquisition');
          // Same transaction as the admission: a folder delivery's project becomes the meeting's suggestion.
          sourceIntake.recordAdmission(setting, delivered.item.external_id);
        }),
          scope: { organization_id: setting.organization_id, custody_ref: `person:${setting.membership_id}`, access_policy_ref: `personal-meeting:${setting.source_key}`, analysis_policy: 'automatic' } },
      });
      const outcome = await (retry ? cycle.retryHeldOnce(signal) : cycle.runOnce(signal));
      if ((outcome.kind === 'held' || outcome.kind === 'retry_scheduled') && TRANSIENT_STAGES.has(outcome.stage)) pausedUntil = Date.now() + 60_000;
      const queued = retry || sourceIntake.checkpoint(setting.source_key).manual.length > 0 || (outcome.cursor_advanced && !outcome.kind.startsWith('empty'));
      // A pull that left its queue where it was never re-pulls at once: an automatic retry, or a head in flight elsewhere
      // (another process, or a crash's unexpired lease), waits a minute; anything else (a lost compare-and-swap) about
      // one former cycle.
      const floor = retry || outcome.cursor_advanced ? 0 : outcome.kind === 'in_flight' || outcome.kind === 'retry_scheduled' ? 60_000 : 30_000;
      observed.set(setting.source_key, { checked_at: new Date().toISOString(), error: null, next: Date.now() + (queued || outcome.kind === 'retry_scheduled' ? floor : 300_000) });
    } catch (error) {
      signal.throwIfAborted();
      const remaining = ownerOf(setting.source_adapter_id).intake.checkpoint(setting.source_key);
      // Nothing left to retry: the import queue is empty, every proposal of this source is frozen, and no granted retry is due.
      if (remaining.folder === null && remaining.manual.length === 0 && !workflowState.listPendingApprovalSourceKeys().includes(setting.source_key)
        && !retryReady(setting.source_key)) { observed.delete(setting.source_key); return; }
      // Fixed, content-free status; one broken grant cannot starve another person's work. A failed retry is already
      // deferred, so the source's intake goes next.
      observed.set(setting.source_key, { checked_at: new Date().toISOString(), error: 'Meeting intake needs attention. Check the connection, folder access, and project access.', next: Date.now() + (retry ? 0 : 60_000) });
      if (!(error instanceof AuthorityOperationError) && !(error instanceof Error)) throw error;
    }
  }
  // Decisions survive disconnect/restart and need no provider access. A source whose provider is not selected in
  // this runtime keeps its decisions until it is (the core's state does not route to it).
  // Recovery keeps going past a row that cannot publish; append reports it. Both throw when the core cannot be created.
  let after = '';
  /** Sources due a pass and not running one, round-robin from the last one started. */
  function due(): MeetingIntakeSettingV1[] {
    // The breaker pauses every source; a targeted pass (the staging canary) still runs.
    if (Date.now() < pausedUntil) return [];
    // A source with an unfrozen proposal stays eligible until its freeze succeeds, even with nothing left to import.
    // So does a source with a parked meeting whose retry an operator authorized. A source already in flight is skipped.
    // Cheap checks first: a source's held rows are read, and its grants inspected, only when it is otherwise due.
    const unfrozen = new Set(workflowState.listPendingApprovalSourceKeys());
    const eligible = intake.list().filter(s => !inFlight.has(s.source_key) && owners.has(s.source_adapter_id) && (observed.get(s.source_key)?.next ?? 0) <= Date.now()
      && (s.folder_id !== null || ownerOf(s.source_adapter_id).intake.checkpoint(s.source_key).manual.length > 0 || unfrozen.has(s.source_key) || retryReady(s.source_key)));
    return [...eligible.filter(s => s.source_key > after), ...eligible.filter(s => s.source_key <= after)];
  }
  /**
   * Starts detached passes on due sources until `lanes` run; each lane calls `settled`, then tops up again. Nothing
   * awaits between the in-flight check and `track`, so a lane and a targeted pass never double-start a source.
   */
  function topUp(signal: AbortSignal, report: (failure: unknown) => void, settled?: () => void): void {
    for (const setting of signal.aborted ? [] : due()) {
      if (inFlight.size >= lanes) return;
      after = setting.source_key;
      // Each lane pass is its own trace, so concurrent lanes never annotate one another's spans.
      track(setting, observeCoreRuntimeRootV1('worker_execution', () => runSource(setting, signal), options.observation))
        .catch((failure: unknown) => { if (!signal.aborted) report(failure); });
      // The entry settles after it is removed, so the top-up sees the freed lane. It waits a macrotask first, so a run
      // of quick passes never starves timers or requests.
      void inFlight.get(setting.source_key)!.then(() => new Promise<void>(resolve => { settled?.(); setImmediate(resolve); }))
        .then(() => topUp(signal, report, settled)).catch(report);
    }
  }
  const processing: OrganizationAuthorityProcessingCycleV1 = {
    async recoverV4Appends(signal) { await (await approvals()).processing.recoverV4Appends(signal); },
    async appendFinalizedApprovalsToV4(signal) { await (await approvals()).processing.appendFinalizedApprovalsToV4(signal); },
    async observeAndFinalizePendingApprovals() {}, async reconcileReadableSearchGeneration() {},
    async reconcileApprovalPresentations(signal) { return (await approvals()).processing.reconcileApprovalPresentations?.(signal); },
    async pollAndStageAdmittedMeetings(signal, report, settled) {
      // Given a reporter, keep up to `lanes` sources running in detached lanes; a direct caller runs one pass in place.
      if (report !== undefined) return topUp(signal, report, settled);
      const [setting] = due();
      if (!setting) return;
      after = setting.source_key;
      await track(setting, runSource(setting, signal));
    },
    // A settled lane tops up after a macrotask, so always look again after one, even when nothing is in flight now.
    async settle() {
      do { await Promise.all(inFlight.values()); await new Promise(resolve => setImmediate(resolve)); } while (inFlight.size > 0);
    },
  };
  /** Waits for any pass already running on this source, then runs one more whether or not its next poll is due. */
  async function pollAndStageSource(sourceKey: string, signal: AbortSignal): Promise<void> {
    for (let running = inFlight.get(sourceKey); running !== undefined && !signal.aborted; running = inFlight.get(sourceKey)) {
      let wake!: () => void;
      await Promise.race([running, new Promise<void>(resolve => { wake = resolve; signal.addEventListener('abort', wake, { once: true }); })]);
      signal.removeEventListener('abort', wake);
    }
    signal.throwIfAborted();
    const setting = intake.list().find(s => s.source_key === sourceKey && owners.has(s.source_adapter_id));
    if (!setting) throw new AuthorityOperationError('not_found', 'Meeting source unavailable');
    return track(setting, runSource(setting, signal));
  }
  /** True when the access check passes, false when it refuses; any other failure is rethrown. */
  function allowed(check: () => unknown): boolean {
    try { check(); return true; }
    catch (error) { if (error instanceof AuthorityOperationError) return false; throw error; }
  }
  function reviewView(view: ApprovalProposalViewV1): PersonMeetingReviewV2 {
    return { approval_id: view.approval_id, title: view.title, project_ids: view.project_ids, status: view.status, decided_on: view.decided_on, ...approvalProposalSummaryV1(view.snapshot_json) };
  }
  const application: ProviderHttpApplicationV1 = {
    routes: [{ route_id: 'personal-meetings', method: 'POST', path: PERSON_MEETINGS_PATH_V2 }],
    async accept(request) {
      if (request.route_id !== 'personal-meetings') throw new AuthorityOperationError('not_found', 'Meeting route unavailable');
      const header = request.headers.authorization;
      if (!header?.startsWith('Bearer ') || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.content_type ?? '')) throw new AuthorityOperationError('invalid_request', 'Invalid meeting request');
      const token = header.slice(7), authorization = authenticate(token), person = meetingIntakePersonV1(authorization);
      const current = () => { request.signal?.throwIfAborted(); if (canonicalSha256(authenticate(token)) !== canonicalSha256(authorization)) throw new AuthorityOperationError('stale_access_state', 'Person session changed'); };
      let input;
      try { input = validatePersonMeetingRequestV2(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.raw_body))); }
      catch { throw new AuthorityOperationError('invalid_request', 'Invalid meeting request'); }
      const provider = providers.find(p => p.id === input.tool_id);
      if (!provider) throw new AuthorityOperationError('not_found', 'Meeting tool unavailable');
      const result = async (): Promise<unknown> => {
        if (input.operation === 'reviews' || input.operation === 'review_open' || input.operation === 'review') {
          // Reviews belong to the person who brought the meeting in, whatever projects it suggests.
          const reviewer = allowed(() => intake.currentPerson(person)) ? person : null;
          if (input.operation === 'reviews') return { reviews: reviewer === null ? [] : (await approvals()).proposals(reviewer).map(reviewView) };
          if (!reviewer) throw new AuthorityOperationError('not_found', 'Meeting review unavailable');
          const approvalCore = await approvals();
          const view = approvalCore.proposal(input.approval_id);
          if (!view || view.reviewer.organization_id !== person.organization_id || view.reviewer.principal_id !== person.principal_id
            || view.reviewer.membership_id !== person.membership_id) throw new AuthorityOperationError('not_found', 'Meeting review unavailable');
          if (input.operation === 'review_open') {
            const projects = new SqlitePersonListDirectoryV1(db).joinedProjects(options.sessions.authenticateAccess({ access_token: token })).projects;
            const names = new Map(projects.filter(project => project.status === 'active').map(project => [project.project_id, project.name]));
            return { review: reviewView(view), snapshot_sha256: view.snapshot_sha256, content: approvalProposalTextV1(view.snapshot_json),
              owners: approvalCore.ownerProposals(input.approval_id), suggested_projects: view.project_ids.flatMap(project_id => {
                const name = names.get(project_id as `prj_${string}`); return name === undefined ? [] : [{ project_id: project_id as `prj_${string}`, name }];
              }) };
          }
          const action = input;
          const decided = approvalCore.decide('desktop', { approval_id: action.approval_id, command_id: action.command_id, snapshot_sha256: action.snapshot_sha256 as `sha256:${string}`,
            action: action.action, project_ids: action.project_ids, share_transcript: action.share_transcript, owners: action.owners }, () => {
            current(); const a = authenticate(token);
            return { actor: { organization_id: a.organization_id, principal_id: a.principal_id, membership_id: a.membership_id }, evidence: { kind: 'person-session', sha256: a.authorization_sha256 } };
          });
          if (decided.kind === 'already_decided') return { status: decided.status, decided_on: decided.surface };
          if (decided.kind === 'stale') throw new AuthorityOperationError('stale_access_state', 'Meeting review has changed');
          return { status: decided.status, decided_on: decided.surface };
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
            sources: intake.list(person).filter(s => s.source_adapter_id === provider.cursor.policy.source_adapter_id).map(s => ({ source_key: s.source_key, folder_id: s.folder_id, folder_project_id: s.folder_project_id,
              baseline: ownerOf(s.source_adapter_id).intake.checkpoint(s.source_key).baseline, pending_imports: ownerOf(s.source_adapter_id).intake.checkpoint(s.source_key).manual,
              checked_at: observed.get(s.source_key)?.checked_at ?? null, error: sourceError(s.source_key) })) };
        }
        if (!session) throw new AuthorityOperationError('unauthorized', 'Connect your meeting account first');
        if (input.operation === 'browse') return session.browse(input.folder_id);
        if (input.operation === 'open') return session.preview(input.meeting_id);
        const project = input.project_id;
        const grant = intake.currentPerson(person, project).grant_sha256;
        const currentProject = () => {
          session.current(); current();
          if (intake.currentPerson(person, project).grant_sha256 !== grant) throw new AuthorityOperationError('stale_access_state', 'Meeting project access changed');
          if (input.operation === 'submit' && options.sessions.authenticateAccess({ access_token: token }).membership_type !== 'owner') {
            throw new AuthorityOperationError('unauthorized', 'Only the staging owner can submit synthetic meetings');
          }
        };
        if (input.operation === 'submit') {
          currentProject();
          if (!session.submit) throw new AuthorityOperationError('not_found', 'Custom meeting submission unavailable');
          session.submit(input.meeting);
        }
        // Validate folder access here; the existing worker builds its content
        // baseline from the durable pending cursor without holding this request.
        if (input.operation === 'watch') await session.browse(input.folder_id!);
        else await session.preview(input.operation === 'submit' ? input.meeting.id : input.meeting_id);
        return db.transaction(() => {
          currentProject();
          if (input.operation === 'watch' && settings(person) !== input.settings_sha256) throw new AuthorityOperationError('stale_access_state', 'Meeting settings changed. Reload them.');
          const providerIntake = ownerOf(provider.cursor.policy.source_adapter_id).intake;
          const setting = ensurePersonMeetingSourceV1(providerIntake, { provider, person, session, commitments: id => processor.current_commitments?.(id), current: currentProject });
          // "Save to" records the watched folder's project or the import's suggestion; neither changes the source.
          if (input.operation === 'watch') providerIntake.watch(setting, input.folder_id, project, currentProject);
          else providerIntake.enqueue(setting, input.operation === 'submit' ? input.meeting.id : input.meeting_id, project, currentProject);
          observed.delete(setting.source_key);
          if (input.operation === 'submit') return { status: 'queued', meeting_id: input.meeting.id };
          return { status: input.operation === 'watch' ? 'saved' : 'queued' };
        }).immediate();
      };
      const body = await result(); current();
      return { status: 200, body: validatePersonMeetingResultV2(input.operation, body) };
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
  return { applications: [...providers.map(p => p.connection_http), ...(options.provider_applications ?? []), application], processing, queue, pollAndStageSource,
    tools: async (token: string) => providers.map(p => p.tool(token)), approvals, close() {} };
}
