import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import type { AdmittedMeetingSourceCursorPolicyV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-source-cursor-policy-v1';
import { SqliteAuthorityMeetingProcessingStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1';
import type { ContextCaptureContentV1, SourceAdapterV1, MeetingSourceAdapter } from '@echo-brain/organization-processing/core';
import { GRANOLA_CONTEXT_CAPTURE_ADAPTER_ID, GRANOLA_CONTEXT_CAPTURE_ADAPTER_VERSION } from '@echo-brain/provider-granola/context/granola-context-source-v1';
import type { JiraPersonConnectionV1 } from '@echo-brain/provider-jira/jira-person-connection-v1';
import { join } from 'node:path';
import {
  runContextCaptureRehearsalV1,
  type ContextCaptureRehearsalReceiptV1,
} from '../application/context-capture-rehearsal-v1.js';
import type { ContextIntakeAuthorityV1 } from '../application/context-intake-v1.js';
import { createGranolaContextIntakeV1, createJiraContextIntakeV1 } from './provider-context-intakes-v1.js';
import { createContextSourceIntakeV1 } from './context-source-intake-v1.js';
import { verifyOrganizationAuthorityApiLineage } from './organization-authority-api-runtime.js';

const JIRA_CONTEXT_CAPTURE_ADAPTER_ID = 'jira-context-capture';
const CONTEXT_CAPTURE_ADAPTER_VERSION = '1.0.0';
const REHEARSAL_TIMEOUT_MS = 15_000;

export interface ConnectorRehearsalInitialOwnerV1 {
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
}

export interface ConnectorRehearsalAuthenticatorV1 {
  authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization;
}

/** The running Authority supplies this serialized lane and its shutdown signal. */
export interface ConnectorRehearsalExclusiveRunnerV1 {
  run_exclusive<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export interface ConnectorRehearsalGranolaV1 {
  /** The exact live adapter object the normal runtime has already admitted. */
  readonly source: MeetingSourceAdapter;
  readonly source_cursor_policy: AdmittedMeetingSourceCursorPolicyV1;
  readonly processor_adapter_id: string;
}

export interface ConnectorRehearsalJiraV1 {
  readonly connection: JiraPersonConnectionV1;
  /** Fixed by the Authority profile, never selected by the caller. */
  readonly project: string;
  /** Fixed non-secret capture identity selected by the Authority profile. */
  readonly source_instance_id: string;
  /** V1 remains request-only excerpts; V2 explicitly selects retained pointers. */
  readonly representation?: 'excerpt' | 'pointer';
  readonly retention?: 'retained_pointer';
}

export interface ConnectorRehearsalSlackV1 {
  /** Opens one source after fresh owner, active-connection and scope proof. */
  create_source(input: { readonly access_token: string; readonly signal: AbortSignal }): Promise<{
    readonly source: SourceAdapterV1<ContextCaptureContentV1>;
    readonly source_instance_id: string;
    /** Synchronous Authority/active-connection fence, repeated at SQLite admission. */
    readonly require_current: () => void;
  }>;
}

export interface OpenConnectorRehearsalCaptureInputV1 {
  /** An isolated, bootstrapped Authority; Granola capture additionally requires admission. */
  readonly state_directory: string;
  /** Read from the Authority bootstrap manifest by the composition root. */
  readonly initial_owner: ConnectorRehearsalInitialOwnerV1;
  readonly authenticate_access: ConnectorRehearsalAuthenticatorV1;
  readonly exclusive: ConnectorRehearsalExclusiveRunnerV1;
  /** Optional until the Authority has completed Granola admission. */
  readonly granola?: ConnectorRehearsalGranolaV1;
  readonly jira: ConnectorRehearsalJiraV1;
  /** V2-only explicit public-channel pointer source. */
  readonly slack?: ConnectorRehearsalSlackV1;
}

export interface ConnectorRehearsalCaptureInputV1 {
  readonly tool: 'granola' | 'jira' | 'slack';
  readonly access_token: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
  /** Optional caller tightening of the fixed 15-second local qualification deadline. */
  readonly timeout_ms?: number;
}

export interface OpenedConnectorRehearsalCaptureV1 {
  capture(input: ConnectorRehearsalCaptureInputV1): Promise<ContextCaptureRehearsalReceiptV1>;
  close(): void;
}

function failure(): Error { return new Error('Context capture rehearsal failed'); }
function cancelled(): DOMException { return new DOMException('Context capture rehearsal was cancelled', 'AbortError'); }
function sameOwner(left: PersonAccessAuthorization, right: ConnectorRehearsalInitialOwnerV1): boolean {
  return left.organization_id === right.organization_id && left.principal_id === right.principal_id &&
    left.membership_id === right.membership_id && left.membership_type === 'owner';
}
function sourceIdentity(adapter_id: string, instance_id: string, version: string) {
  return { kind: 'source' as const, adapter_id, instance_id, version };
}
function combinedSignal(shutdown: AbortSignal, caller?: AbortSignal): AbortSignal {
  return caller === undefined ? shutdown : AbortSignal.any([shutdown, caller]);
}

/**
 * Explicit rehearsal capture composition. It deliberately has no listener, scheduler,
 * provider construction or credential input. The root passes live provider
 * objects only after it has started the selected local or staging Authority runtime.
 */
export function openConnectorRehearsalCaptureV1(
  options: OpenConnectorRehearsalCaptureInputV1,
): OpenedConnectorRehearsalCaptureV1 {
  const lineage = verifyOrganizationAuthorityApiLineage(options.state_directory);
  const owner = Object.freeze({ ...options.initial_owner });
  if ([owner.organization_id, owner.principal_id, owner.membership_id].some(value => typeof value !== 'string' || value.trim() === '')) {
    throw new Error('Connector rehearsal initial owner is invalid');
  }
  if (lineage.root.organization_id !== owner.organization_id ||
      typeof options.exclusive?.run_exclusive !== 'function' ||
      typeof options.authenticate_access?.authenticateAccess !== 'function') {
    throw new Error('Connector rehearsal composition is invalid');
  }
  const database = openAuthorityDatabase(join(options.state_directory, 'authority.sqlite'), { fileMustExist: true });
  let closed = false;
  const requireOwner = (accessToken: string): PersonAccessAuthorization => {
    if (closed) throw new Error('Connector rehearsal is closed');
    const authorization = options.authenticate_access.authenticateAccess({ access_token: accessToken });
    if (!sameOwner(authorization, owner)) throw failure();
    const active = database.prepare(
      `SELECT 1 FROM authority_memberships
        WHERE organization_id=? AND principal_id=? AND membership_id=?
          AND membership_type='owner' AND status='active'`,
    ).get(owner.organization_id, owner.principal_id, owner.membership_id);
    if (active === undefined) throw failure();
    return authorization;
  };
  const metadata = database.prepare('SELECT organization_id FROM authority_metadata WHERE singleton=1').get() as { organization_id?: unknown } | undefined;
  if (metadata?.organization_id !== owner.organization_id) {
    database.close();
    throw new Error('Connector rehearsal Authority metadata differs from its owner');
  }

  const granolaState = options.granola === undefined ? undefined : new SqliteAuthorityMeetingProcessingStateV1(
    database,
    options.granola.source_cursor_policy,
    options.granola.processor_adapter_id,
  );
  if (options.granola !== undefined &&
      (options.granola.source.identity.kind !== 'meeting-source' || options.granola.source.identity.adapter_id !== 'granola')) {
    database.close();
    throw new Error('Connector rehearsal Granola source is invalid');
  }
  const requireGranolaAdmissionOwner = (): void => {
    const admitted = database.prepare(
      `SELECT organization_id, principal_id, membership_id, membership_type
         FROM authority_live_source_admission_v2 WHERE singleton=1`,
    ).get() as { organization_id?: unknown; principal_id?: unknown; membership_id?: unknown; membership_type?: unknown } | undefined;
    if (admitted?.organization_id !== owner.organization_id || admitted.principal_id !== owner.principal_id ||
        admitted.membership_id !== owner.membership_id || admitted.membership_type !== 'owner') throw failure();
  };

  const captureGranola = async (input: ConnectorRehearsalCaptureInputV1, signal: AbortSignal): Promise<ContextCaptureRehearsalReceiptV1> => {
    if (options.granola === undefined || granolaState === undefined) throw failure();
    requireOwner(input.access_token);
    requireGranolaAdmissionOwner();
    // This reads the current admitted live cursor but never advances it. The
    // root serializes this manual observation against normal source polling.
    const admission = await granolaState.readAdmission();
    const live = options.granola.source;
    if (admission.source.adapter_id !== live.identity.adapter_id || admission.source.instance_id !== live.identity.instance_id ||
        admission.source.version !== live.identity.version) throw failure();
    const currentRead = async () => {
      requireOwner(input.access_token);
      requireGranolaAdmissionOwner();
      const current = await granolaState.readAdmission();
      if (current.source.adapter_id !== live.identity.adapter_id || current.source.instance_id !== live.identity.instance_id ||
          current.source.version !== live.identity.version) throw failure();
    };
    const authority: ContextIntakeAuthorityV1 = {
      select: () => ({
        // This is a deliberately separate rehearsal qualification policy. A
        // Granola credential or Jira grant never selects retained custody.
        disposition: 'retained',
        scope: {
          organization_id: owner.organization_id,
          custody_ref: `organization:${owner.organization_id}`,
          access_policy_ref: `connector-rehearsal-granola-initial-owner:${owner.membership_id}`,
          analysis_policy: 'on_request',
        },
        permitted_representations: ['full_snapshot'],
      }),
      requireCurrent: () => {
        requireOwner(input.access_token);
        requireGranolaAdmissionOwner();
        // The async read fence above checks the admitted source before and
        // after provider I/O. This hook is also called during batch planning;
        // only its storage invocation has the transaction needed for the
        // authoritative source-admission fence.
        if (database.inTransaction) granolaState.assertCurrentSourceAdmission(live.identity);
      },
    };
    const intake = createGranolaContextIntakeV1({
      source: live,
      source_instance_id: live.identity.instance_id,
      organization_id: owner.organization_id,
      authority,
      require_read_current: currentRead,
      retention: { disposition: 'retained', database },
    });
    return runContextCaptureRehearsalV1({
      intake,
      expected_source_identity_sha256: canonicalSha256(sourceIdentity(
        GRANOLA_CONTEXT_CAPTURE_ADAPTER_ID, live.identity.instance_id, GRANOLA_CONTEXT_CAPTURE_ADAPTER_VERSION,
      )),
      limit: input.limit,
      cursor: admission.source.cursor,
      signal,
      timeout_ms: input.timeout_ms ?? REHEARSAL_TIMEOUT_MS,
    });
  };

  const captureJira = async (input: ConnectorRehearsalCaptureInputV1, signal: AbortSignal): Promise<ContextCaptureRehearsalReceiptV1> => {
    const authorization = requireOwner(input.access_token);
    const current = await options.jira.connection.captureConnection({ access_token: input.access_token, signal });
    const binding = current.transport.binding;
    if (binding.organization_id !== owner.organization_id || binding.principal_id !== authorization.principal_id ||
        binding.membership_id !== authorization.membership_id) throw failure();
    const requireCurrent = () => {
      requireOwner(input.access_token);
      current.require_current();
    };
    const retained = options.jira.retention === 'retained_pointer';
    const representation = options.jira.representation ?? 'excerpt';
    if (retained && representation !== 'pointer') throw failure();
    const authority: ContextIntakeAuthorityV1 = {
      select: () => ({
        disposition: retained ? 'retained' : 'request_only',
        scope: {
          organization_id: owner.organization_id,
          custody_ref: `membership:${owner.membership_id}`,
          access_policy_ref: `connector-rehearsal-jira-initial-owner:${owner.membership_id}`,
          analysis_policy: 'on_request',
        },
        permitted_representations: [representation],
      }),
      requireCurrent: requireCurrent,
    };
    const intake = createJiraContextIntakeV1({
      transport: current.transport,
      project: options.jira.project,
      representation,
      source_instance_id: options.jira.source_instance_id,
      organization_id: owner.organization_id,
      authority,
      require_read_current: requireCurrent,
      ...(retained ? { retention: { disposition: 'retained' as const, database } } : {}),
    });
    return runContextCaptureRehearsalV1({
      intake,
      expected_source_identity_sha256: canonicalSha256(sourceIdentity(
        JIRA_CONTEXT_CAPTURE_ADAPTER_ID, options.jira.source_instance_id, CONTEXT_CAPTURE_ADAPTER_VERSION,
      )),
      limit: input.limit,
      signal,
      timeout_ms: input.timeout_ms ?? REHEARSAL_TIMEOUT_MS,
    });
  };

  const captureSlack = async (input: ConnectorRehearsalCaptureInputV1, signal: AbortSignal): Promise<ContextCaptureRehearsalReceiptV1> => {
    if (options.slack === undefined) throw failure();
    const configured = await options.slack.create_source({ access_token: input.access_token, signal });
    if (configured.source.identity.kind !== 'source' || configured.source.identity.adapter_id !== 'slack-context-capture' ||
        configured.source.identity.instance_id !== configured.source_instance_id || configured.source.identity.version !== CONTEXT_CAPTURE_ADAPTER_VERSION) throw failure();
    const requireCurrent = () => { requireOwner(input.access_token); configured.require_current(); };
    const authority: ContextIntakeAuthorityV1 = {
      select: () => ({
        disposition: 'retained',
        scope: {
          organization_id: owner.organization_id,
          custody_ref: `membership:${owner.membership_id}`,
          access_policy_ref: `connector-rehearsal-slack-initial-owner:${owner.membership_id}`,
          analysis_policy: 'on_request',
        },
        permitted_representations: ['pointer'],
      }),
      requireCurrent,
    };
    const intake = createContextSourceIntakeV1({
      source: configured.source,
      identity: configured.source.identity,
      organization_id: owner.organization_id,
      authority,
      require_read_current: requireCurrent,
      retention: { disposition: 'retained', database },
    });
    return runContextCaptureRehearsalV1({
      intake,
      expected_source_identity_sha256: canonicalSha256(configured.source.identity),
      limit: input.limit,
      signal,
      timeout_ms: input.timeout_ms ?? REHEARSAL_TIMEOUT_MS,
    });
  };

  return Object.freeze({
    async capture(input: ConnectorRehearsalCaptureInputV1): Promise<ContextCaptureRehearsalReceiptV1> {
      if (closed || input === null || typeof input !== 'object' || !['granola', 'jira', 'slack'].includes(input.tool)) throw failure();
      return options.exclusive.run_exclusive(async shutdown => {
        const signal = combinedSignal(shutdown, input.signal);
        if (signal.aborted) throw cancelled();
        try {
          if (input.tool === 'granola') return await captureGranola(input, signal);
          if (input.tool === 'jira') return await captureJira(input, signal);
          return await captureSlack(input, signal);
        } catch (_error) {
          if (signal.aborted) throw cancelled();
          throw failure();
        }
      });
    },
    close() {
      if (!closed) { closed = true; database.close(); }
    },
  });
}
