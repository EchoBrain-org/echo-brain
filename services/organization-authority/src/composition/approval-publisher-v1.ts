import type Database from 'better-sqlite3';
import { canonicalJson, type JsonValue, type Sha256Digest } from '@echo-brain/federation-protocol';
import {
  APPROVAL_DECISION_RECORD_INPUT_CODEC_V1, createRecordEnvelopeFactoryV4, createRecordInputCodecRegistryV4, createRecordReceiptFactoryV2,
  organizationAuthorityPinSha256, verifyOrganizationAuthorityPin, type RecordAppendFactoryOptionsV4,
} from '@echo-brain/organization-protocol';
import type { ApprovalWorkflowContextV1, ApprovalWorkflowProcessingV1 } from '@echo-brain/organization-processing/ports/approval-workflow-bundle-v1';
import type { ApprovalActorV1, ApprovalDecisionBodyV1 } from './approval-core-v1.js';
import { buildApprovalDecisionRecordV1 } from './approval-decision-projection-v1.js';

/** JSON path of the approved record's digest inside receipt_json. Task 13's trigger reads exactly this path. */
export const APPROVAL_DECISION_RECORD_SHA256_PATH_V1 = '$.record_sha256';
/** Exact canonical JSON stored in authority_approval_decisions_v1.receipt_json. `receipt` is the record log's signed
 *  receipt verbatim; `record_sha256` equals receipt.body.record_sha256 (the CHECK enforces it). */
export interface ApprovalDecisionReceiptV1 { readonly record_sha256: Sha256Digest; readonly receipt: Readonly<Record<string, unknown>> }

/** Builds the receipt_json value from an append result; throws unless result.receipt.body.record_sha256 === result.record_sha256. */
export function approvalDecisionReceiptJsonV1(result: { readonly record_sha256: string; readonly receipt: unknown }): string {
  const receipt = result.receipt as { readonly body?: { readonly record_sha256?: unknown } } | null;
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt) || typeof result.record_sha256 !== 'string'
    || receipt.body?.record_sha256 !== result.record_sha256) {
    throw new Error('approval receipt does not name its record');
  }
  return canonicalJson({ record_sha256: result.record_sha256, receipt } as unknown as JsonValue);
}

export interface AfterApprovedRecordEventV1 {
  readonly approval_id: string; readonly record_sha256: Sha256Digest;
  /** The signed reference's organization_id and final_approver; equal to the decision body's actor (asserted). Task 13's trigger compares these ids. */
  readonly reviewer: ApprovalActorV1;
  /** The signed reference's approved_at; equal to the decision body's decided_at (asserted). */
  readonly decided_at: string;
}
/**
 * Runs inside the Authority transaction that writes the receipt, only when that transaction's UPDATE wrote it (changes === 1), after
 * the UPDATE and on the same handle. It may write Authority rows through `transaction` only, never another connection.
 * It must be synchronous: an async function is refused at registration, and a call that returns a thenable is refused (its rejection is
 * swallowed, but work it scheduled may still run after the rollback, outside the transaction). Any other return value is ignored.
 * A throw rolls back the receipt and every hook write of that row. The next pass retries: the append returns `duplicate`, the UPDATE
 * changes 1 row, and the hooks run again. Hooks must be total (e.g. INSERT … ON CONFLICT DO NOTHING).
 */
export type AfterApprovedRecordHookV1 = (transaction: Database.Database, event: AfterApprovedRecordEventV1) => void;

/** The publisher writes only its own proof. */
const WRITER_CODECS = createRecordInputCodecRegistryV4([APPROVAL_DECISION_RECORD_INPUT_CODEC_V1]);
interface DecisionRowV1 { readonly sequence: number; readonly approval_id: string; readonly command_id: string; readonly surface: string; readonly body_json: string }
const ASYNC_TAGS = new Set(['[object AsyncFunction]', '[object AsyncGeneratorFunction]']);
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function';

async function publisherAppendOptionsV1(context: ApprovalWorkflowContextV1): Promise<RecordAppendFactoryOptionsV4> {
  const descriptor = await context.signer.inspect();
  return Object.freeze({ pinned_authority: verifyOrganizationAuthorityPin(descriptor, organizationAuthorityPinSha256(descriptor)),
    state_lineage_id: context.coordinates.state_lineage_id, sign: (message: Buffer, keyId: Sha256Digest) => context.signer.sign(message, keyId), codecs: WRITER_CODECS });
}

/**
 * The one publisher: appends every approved, unpublished decision as an echo-approval-decision-ref-v1 record, writes its receipt and
 * runs the after-record hooks in that receipt's transaction. Each row is isolated: the first failure is rethrown after the pass, unless
 * the signal aborted. reconcileApprovalPresentations stays undefined until Task 11; the lifecycle requests search and presentation
 * after each successful pass.
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
  const storedRecord = database.prepare(`SELECT json_extract(receipt_json, '${APPROVAL_DECISION_RECORD_SHA256_PATH_V1}')
     FROM authority_approval_decisions_v1 WHERE approval_id = ? AND receipt_json IS NOT NULL`).pluck();

  async function publishOne(row: DecisionRowV1, options: RecordAppendFactoryOptionsV4): Promise<void> {
    // [T1] autocommit reads only (the bound state port refuses an open transaction).
    const body = JSON.parse(row.body_json) as ApprovalDecisionBodyV1;
    if (body.request.approval_id !== row.approval_id || body.request.command_id !== row.command_id || body.surface !== row.surface
      || body.request.action !== 'approve' || body.actor.organization_id !== context.coordinates.organization_id) throw new Error('Approval decision body differs from its row');
    const frozen = context.state.readFrozenCandidateForApproval(row.approval_id);
    // A source this runtime does not configure keeps its decision until a runtime that does publishes it.
    if (frozen === undefined) return;
    if (frozen.approved_snapshot === null || frozen.approved_snapshot_sha256 !== body.request.snapshot_sha256) throw new Error('Frozen proposal changed after the decision');
    const built = buildApprovalDecisionRecordV1({ coordinates: context.coordinates, decision: { sequence: row.sequence, body },
      candidate_sha256: frozen.candidate_semantic_sha256 as Sha256Digest, approved_snapshot: frozen.approved_snapshot });
    const ref = built.human_act_record_input.approval_decision_ref_v1;
    const provenance = frozen.meeting.provenance, processor = frozen.decisions.processor;
    // [T2] record-log.sqlite only: BEGIN IMMEDIATE … COMMIT inside the record appender, then the signed receipt in its own autocommit.
    //      The Authority handle holds no transaction across this await. Same (approval_id, action) and key → outcome 'duplicate'.
    const result = await context.record_append.append({ approval_id: row.approval_id, action: 'approve', semantic_idempotency_key: built.semantic_idempotency_key,
      receipt_issued_at: body.decided_at, authorization_witness: built.authorization_witness as unknown as JsonValue,
      envelope_factory: createRecordEnvelopeFactoryV4(options, { issued_at: body.decided_at, human_act_record_input: built.human_act_record_input,
        source_provenance: { schema_version: 1, kind: 'echo-meeting-source-provenance-v1', ...context.coordinates, source_adapter_kind: 'meeting-source',
          source_adapter_id: provenance.source.adapter_id, source_adapter_instance_id: provenance.source.instance_id, source_adapter_version: provenance.source.version,
          external_id: provenance.external_id, canonical_revision: provenance.canonical_revision, normalizer_version: provenance.normalizer_version,
          source_revision: provenance.source_revision ?? null },
        processor_provenance: { schema_version: 1, kind: 'echo-decision-processor-provenance-v1', ...context.coordinates, processor_adapter_kind: 'decision-processor',
          processor_adapter_id: processor.adapter_id, processor_adapter_instance_id: processor.instance_id, processor_adapter_version: processor.version,
          processor_contract_sha256: frozen.admission.processor.configuration_sha256 as Sha256Digest } }, context.next_envelope_id),
      receipt_factory: createRecordReceiptFactoryV2(options) });
    const receipt_json = approvalDecisionReceiptJsonV1(result);
    // The hook event comes from the signed reference, so Task 13's trigger sees exactly what the record says.
    const event: AfterApprovedRecordEventV1 = Object.freeze({ approval_id: ref.approval_id, record_sha256: result.record_sha256 as Sha256Digest,
      reviewer: Object.freeze({ organization_id: ref.organization_id, principal_id: ref.final_approver.principal_id, membership_id: ref.final_approver.membership_id }),
      decided_at: ref.approved_at });
    if (event.reviewer.principal_id !== body.actor.principal_id || event.reviewer.membership_id !== body.actor.membership_id
      || event.reviewer.organization_id !== body.actor.organization_id || event.decided_at !== body.decided_at) throw new Error('Approval record names another reviewer');
    // A nested .immediate() would be a savepoint, so the hooks would commit with someone else's outer transaction.
    if (database.inTransaction) throw new Error('Approval receipts need an idle Authority transaction');
    // [T3] authority.sqlite: one BEGIN IMMEDIATE transaction, with no await inside.
    database.transaction(() => {
      const changes = writeReceipt.run(receipt_json, row.approval_id).changes;
      if (changes === 1) {
        // The receipt is visible inside this transaction. Registration order; the first throw rolls all back.
        for (const hook of after) {
          const returned: unknown = hook(database, event);
          if (isThenable(returned)) {
            // Adopt and swallow its outcome first, so a late rejection cannot become an unhandled rejection.
            void Promise.resolve(returned).catch(() => undefined);
            throw new Error('An after-record hook must be synchronous; it returned a promise');
          }
        }
        return;
      }
      // R30(d) zero-change path: another publisher (handle, process or earlier pass) already wrote this approval's receipt. Verify and run nothing.
      if (storedRecord.get(row.approval_id) !== result.record_sha256) throw new Error('approval receipt conflicts with the stored record');
    }).immediate();
  }

  async function publish(signal: AbortSignal): Promise<void> {
    const options = await prepared();
    let afterSequence = 0, failed = false, first: unknown;
    for (;;) {
      const rows = page.all(afterSequence) as DecisionRowV1[];
      if (rows.length === 0) break;
      for (const row of rows) {
        // The cursor passes failed rows, so a pass always ends.
        afterSequence = row.sequence;
        signal.throwIfAborted();
        try { await publishOne(row, options); }
        catch (error) {
          if (signal.aborted) throw error;
          if (!failed) { failed = true; first = error; }
        }
      }
    }
    // A visible failure; every other row was published. Search wakes on the next successful pass or cycle.
    if (failed) throw first;
  }
  return Object.freeze({ recoverV4Appends: publish, appendFinalizedApprovalsToV4: publish, async observeAndFinalizePendingApprovals() {} });
}
