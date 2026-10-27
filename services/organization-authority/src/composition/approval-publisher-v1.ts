import type Database from 'better-sqlite3';
import { canonicalJson, type JsonValue, type Sha256Digest } from '@echo-brain/federation-protocol';
import {
  APPROVAL_DECISION_RECORD_INPUT_CODEC_V2, createRecordEnvelopeFactoryV4, createRecordInputCodecRegistryV4, createRecordReceiptFactoryV2,
  organizationAuthorityPinSha256, verifyOrganizationAuthorityPin, type RecordAppendFactoryOptionsV4,
} from '@echo-brain/organization-protocol';
import type { ApprovalWorkflowContextV1, ApprovalWorkflowProcessingV1 } from '@echo-brain/organization-processing/ports/approval-workflow-bundle-v1';
import { annotateCoreRuntimeV1, coreRuntimeIdentityV1, observeCoreRuntimeSyncV1, observeCoreRuntimeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import type { ApprovalActorV1, ApprovalDecisionBodyV1 } from './approval-core-v1.js';
import { buildApprovalDecisionRecordsV1 } from './approval-decision-projection-v1.js';

/** One published record of a decision: its own approval id, its destination (`private` when kept for the reviewer alone inside
 *  its projects, present only then), and the record log's signed receipt verbatim, whose body names record_sha256
 *  (authority_approval_decision_receipt_v1 enforces it). */
export interface ApprovalDecisionReceiptRecordV1 {
  readonly approval_id: string; readonly project_ids: readonly string[]; readonly private?: true; readonly record_sha256: Sha256Digest; readonly receipt: Readonly<Record<string, unknown>>;
}
/** Exact canonical JSON stored in authority_approval_decisions_v1.receipt_json: every record of the decision, in group order. */
export interface ApprovalDecisionReceiptV1 { readonly records: readonly ApprovalDecisionReceiptRecordV1[] }

/** Builds the receipt_json value from each record's append result; throws unless every receipt names its record. */
export function approvalDecisionReceiptJsonV1(records: readonly { readonly approval_id: string; readonly project_ids: readonly string[]; readonly private?: true;
  readonly record_sha256: string; readonly receipt: unknown }[]): string {
  if (records.length === 0) throw new Error('an approval receipt needs its records');
  return canonicalJson({ records: records.map(record => {
    const receipt = record.receipt as { readonly body?: { readonly record_sha256?: unknown } } | null;
    if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt) || typeof record.record_sha256 !== 'string'
      || receipt.body?.record_sha256 !== record.record_sha256) {
      throw new Error('approval receipt does not name its record');
    }
    return { approval_id: record.approval_id, project_ids: [...record.project_ids], ...(record.private === true ? { private: true } : {}), record_sha256: record.record_sha256, receipt };
  }) } as unknown as JsonValue);
}

export interface AfterApprovedRecordEventV1 {
  /** The record's own approval id; each record of a decision has its own. */
  readonly approval_id: string;
  /** The decided proposal, which every record of the decision shares. */
  readonly proposal_approval_id: string;
  readonly record_sha256: Sha256Digest;
  /** The signed reference's organization_id and final_approver; equal to the decision body's actor (asserted). The run trigger compares these ids. */
  readonly reviewer: ApprovalActorV1;
  /** The signed reference's approved_at; equal to the decision body's decided_at (asserted). */
  readonly decided_at: string;
}
/**
 * Runs inside the Authority transaction that writes the receipt, once per record of the decision, only when that
 * transaction's UPDATE wrote it (changes === 1), after the UPDATE and on the same handle. It may write Authority rows through
 * `transaction` only, never another connection. It must be synchronous: an async function is refused at registration, and a
 * call that returns a thenable is refused (its rejection is swallowed, but work it scheduled may still run after the rollback,
 * outside the transaction). Any other return value is ignored. A throw rolls back the receipt and every hook write of every
 * record. The next pass retries: each append returns `duplicate`, the UPDATE changes 1 row, and the hooks run again. Hooks
 * must be total (e.g. INSERT … ON CONFLICT DO NOTHING).
 */
export type AfterApprovedRecordHookV1 = (transaction: Database.Database, event: AfterApprovedRecordEventV1) => void;

/** The publisher writes only its own proof. */
const WRITER_CODECS = createRecordInputCodecRegistryV4([APPROVAL_DECISION_RECORD_INPUT_CODEC_V2]);
interface DecisionRowV1 { readonly sequence: number; readonly approval_id: string; readonly command_id: string; readonly surface: string; readonly body_json: string }
const ASYNC_TAGS = new Set(['[object AsyncFunction]', '[object AsyncGeneratorFunction]']);
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function';
/** What a stored receipt and a rebuilt one must agree on: each record's id, destination and digest, in order. */
const published = (records: readonly Pick<ApprovalDecisionReceiptRecordV1, 'approval_id' | 'project_ids' | 'private' | 'record_sha256'>[]) =>
  canonicalJson(records.map(({ approval_id, project_ids, private: kept, record_sha256 }) =>
    ({ approval_id, project_ids: [...project_ids], ...(kept === true ? { private: true } : {}), record_sha256 })) as unknown as JsonValue);

async function publisherAppendOptionsV1(context: ApprovalWorkflowContextV1): Promise<RecordAppendFactoryOptionsV4> {
  const descriptor = await context.signer.inspect();
  return Object.freeze({ pinned_authority: verifyOrganizationAuthorityPin(descriptor, organizationAuthorityPinSha256(descriptor)),
    state_lineage_id: context.coordinates.state_lineage_id, sign: (message: Buffer, keyId: Sha256Digest) => context.signer.sign(message, keyId), codecs: WRITER_CODECS });
}

/**
 * The one publisher: appends every approved, unpublished decision as one echo-approval-decision-ref-v2 record per destination
 * group, then writes its receipt and runs the after-record hooks once per record in that receipt's transaction. Each decision
 * is isolated, shows as a failed record_append span, and is retried on every pass. Append rethrows the first decision failure
 * after the pass; recovery does not, so one unpublishable decision cannot stop startup or the rest of a cycle. A failure of the
 * whole pass (signer, page query, abort) throws from both. The core adds reconcileApprovalPresentations when it has
 * presenters; the lifecycle requests search and presentation after each cycle and publication wake.
 */
export function createApprovalPublisherV1(database: Database.Database, context: ApprovalWorkflowContextV1,
  hooks: readonly AfterApprovedRecordHookV1[]): ApprovalWorkflowProcessingV1 {
  if (!Array.isArray(hooks) || hooks.some(hook => typeof hook !== 'function')) throw new TypeError('after-record hooks must be functions');
  // An async function cannot run inside the receipt transaction. Refusing it here means its body never starts, so it can never leave an unhandled rejection.
  if (hooks.some(hook => ASYNC_TAGS.has(Object.prototype.toString.call(hook)))) throw new TypeError('after-record hooks must be synchronous functions');
  const after = Object.freeze([...hooks]);
  // The signer is inspected at construction (a broken signer shows up as early as eager inspection did) and awaited on every pass.
  // A failed inspection is not cached, so the next pass retries it. The brief's synchronous signature is kept.
  let factories: Promise<RecordAppendFactoryOptionsV4> | undefined;
  const prepared = (): Promise<RecordAppendFactoryOptionsV4> =>
    factories ??= publisherAppendOptionsV1(context).catch((error: unknown) => { factories = undefined; throw error; });
  void prepared().catch(() => undefined);
  // The partial index authority_approval_decisions_v1_unpublished serves this page.
  const page = database.prepare(`SELECT sequence, approval_id, command_id, surface, body_json FROM authority_approval_decisions_v1
     WHERE action = 'approve' AND receipt_json IS NULL AND sequence > ? ORDER BY sequence LIMIT 25`);
  const writeReceipt = database.prepare(`UPDATE authority_approval_decisions_v1 SET receipt_json = ?
     WHERE approval_id = ? AND action = 'approve' AND receipt_json IS NULL`);
  const storedReceipt = database.prepare(`SELECT receipt_json FROM authority_approval_decisions_v1 WHERE approval_id = ? AND receipt_json IS NOT NULL`).pluck();

  async function publishOne(row: DecisionRowV1, options: RecordAppendFactoryOptionsV4): Promise<void> {
    // [T1] autocommit reads only (the bound state port refuses an open transaction).
    const body = JSON.parse(row.body_json) as ApprovalDecisionBodyV1;
    if (body.request.approval_id !== row.approval_id || body.request.command_id !== row.command_id || body.surface !== row.surface
      || body.request.action !== 'approve' || body.actor.organization_id !== context.coordinates.organization_id) throw new Error('Approval decision body differs from its row');
    const frozen = context.state.readFrozenCandidateForApproval(row.approval_id);
    // A source this runtime does not configure keeps its decision until a runtime that does publishes it.
    if (frozen === undefined) return;
    if (frozen.approved_snapshot === null || frozen.approved_snapshot_sha256 !== body.request.snapshot_sha256) throw new Error('Frozen proposal changed after the decision');
    // Every group is built and checked before the first append, so a decision is never left with only some of its records.
    const built = buildApprovalDecisionRecordsV1({ coordinates: context.coordinates, decision: { sequence: row.sequence, body },
      candidate_sha256: frozen.candidate_semantic_sha256 as Sha256Digest, approved_snapshot: frozen.approved_snapshot });
    const provenance = frozen.meeting.provenance, processor = frozen.decisions.processor;
    // [T2] record-log.sqlite only, one group at a time in group order: BEGIN IMMEDIATE … COMMIT inside the record appender, then
    //      the signed receipt in its own autocommit. The Authority handle holds no transaction across these awaits. The build is
    //      deterministic, so a retry after a partial pass gets `duplicate` for each group already in the log.
    const appended: { readonly approval_id: string; readonly project_ids: readonly string[]; readonly private?: true; readonly record_sha256: Sha256Digest; readonly receipt: unknown;
      readonly event: AfterApprovedRecordEventV1 }[] = [];
    for (const record of built) {
      const ref = record.human_act_record_input.approval_decision_ref_v2;
      const result = await context.record_append.append({ approval_id: record.approval_id, action: 'approve', semantic_idempotency_key: record.semantic_idempotency_key,
        receipt_issued_at: body.decided_at, authorization_witness: record.authorization_witness as unknown as JsonValue,
        envelope_factory: createRecordEnvelopeFactoryV4(options, { issued_at: body.decided_at, human_act_record_input: record.human_act_record_input,
          source_provenance: { schema_version: 1, kind: 'echo-meeting-source-provenance-v1', ...context.coordinates, source_adapter_kind: 'meeting-source',
            source_adapter_id: provenance.source.adapter_id, source_adapter_instance_id: provenance.source.instance_id, source_adapter_version: provenance.source.version,
            external_id: provenance.external_id, canonical_revision: provenance.canonical_revision, normalizer_version: provenance.normalizer_version,
            source_revision: provenance.source_revision ?? null },
          processor_provenance: { schema_version: 1, kind: 'echo-decision-processor-provenance-v1', ...context.coordinates, processor_adapter_kind: 'decision-processor',
            processor_adapter_id: processor.adapter_id, processor_adapter_instance_id: processor.instance_id, processor_adapter_version: processor.version,
            processor_contract_sha256: frozen.admission.processor.configuration_sha256 as Sha256Digest } }, context.next_envelope_id),
        receipt_factory: createRecordReceiptFactoryV2(options) });
      // The hook event comes from the signed reference, so the run trigger sees exactly what the record says.
      const event: AfterApprovedRecordEventV1 = Object.freeze({ approval_id: ref.approval_id, proposal_approval_id: ref.proposal_approval_id, record_sha256: result.record_sha256 as Sha256Digest,
        reviewer: Object.freeze({ organization_id: ref.organization_id, principal_id: ref.final_approver.principal_id, membership_id: ref.final_approver.membership_id }),
        decided_at: ref.approved_at });
      if (event.reviewer.principal_id !== body.actor.principal_id || event.reviewer.membership_id !== body.actor.membership_id
        || event.reviewer.organization_id !== body.actor.organization_id || event.decided_at !== body.decided_at
        || event.proposal_approval_id !== row.approval_id) throw new Error('Approval record names another reviewer');
      appended.push({ approval_id: record.approval_id, project_ids: record.project_ids, ...(record.private === true ? { private: true as const } : {}),
        record_sha256: result.record_sha256 as Sha256Digest, receipt: result.receipt, event });
    }
    const receipt_json = approvalDecisionReceiptJsonV1(appended);
    // A nested .immediate() would be a savepoint, so the hooks would commit with someone else's outer transaction.
    if (database.inTransaction) throw new Error('Approval receipts need an idle Authority transaction');
    // [T3] authority.sqlite: one BEGIN IMMEDIATE transaction, with no await inside.
    const committed = database.transaction(() => {
      const changes = writeReceipt.run(receipt_json, row.approval_id).changes;
      if (changes === 1) {
        // The receipt is visible inside this transaction. Each record in group order, each hook in registration order; the first throw rolls all back.
        for (const { event } of appended) {
          for (const hook of after) {
            const returned: unknown = hook(database, event);
            if (isThenable(returned)) {
              // Adopt and swallow its outcome first, so a late rejection cannot become an unhandled rejection.
              void Promise.resolve(returned).catch(() => undefined);
              throw new Error('An after-record hook must be synchronous; it returned a promise');
            }
          }
        }
        return true;
      }
      // R30(d) zero-change path: another publisher (handle, process or earlier pass) already wrote this approval's receipt. Verify the whole set and run nothing.
      const stored = storedReceipt.get(row.approval_id) as string | undefined;
      if (stored === undefined || published((JSON.parse(stored) as ApprovalDecisionReceiptV1).records) !== published(appended)) {
        throw new Error('approval receipt conflicts with the stored records');
      }
      return false;
    }).immediate();
    // Publish correlation only after the receipt and all hook writes have committed. The source revision joins the earlier
    // intake; each record's event (its own approval id, the run's event_ref) joins its later research run. Each record has
    // its own span, so a decision or a batch cannot overwrite another record's links.
    const source_revision = coreRuntimeIdentityV1('source_revision', JSON.stringify([provenance.external_id, provenance.canonical_revision]));
    annotateCoreRuntimeV1({ source_revision, result: committed ? 'published' : 'current' });
    for (const record of appended) {
      observeCoreRuntimeSyncV1('record_append', () => annotateCoreRuntimeV1({
        event_id: coreRuntimeIdentityV1('research-event', record.approval_id),
        output_id: coreRuntimeIdentityV1('research-output', record.record_sha256),
        source_revision, result: committed ? 'published' : 'current',
      }));
    }
  }

  async function publish(signal: AbortSignal, rethrowRows: boolean): Promise<void> {
    const options = await prepared();
    let afterSequence = 0, failed = false, first: unknown;
    for (;;) {
      const rows = page.all(afterSequence) as DecisionRowV1[];
      if (rows.length === 0) break;
      for (const row of rows) {
        // The cursor passes failed rows, so a pass always ends.
        afterSequence = row.sequence;
        signal.throwIfAborted();
        try { await observeCoreRuntimeV1('record_append', () => publishOne(row, options)); }
        catch (error) {
          if (signal.aborted) throw error;
          if (!failed) { failed = true; first = error; }
        }
      }
    }
    // Every other row was published; the failed row stays unpublished until a later pass.
    if (failed && rethrowRows) throw first;
  }
  return Object.freeze({ recoverV4Appends: (signal: AbortSignal) => publish(signal, false),
    appendFinalizedApprovalsToV4: (signal: AbortSignal) => publish(signal, true) });
}
