import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The Authority's own code, as the root build left it: the brief, the record codec, and approvalReviewV1 that writes the review. */
const built = (path: string) => import(pathToFileURL(resolve(import.meta.dirname, '../..', path)).href);
const { approvalReviewV1 } = await built('services/organization-authority/dist/composition/approval-core-v1.js') as {
  approvalReviewV1(snapshotJson: string): Review };
const { compileDecisionBrief } = await built('packages/organization-processing/dist/core/processing/brief.js') as {
  compileDecisionBrief(id: string, meeting: unknown, decisions: unknown): Brief };
const { validateApprovedDecisionSnapshotV2 } = await built('packages/organization-protocol/dist/record-codec-support-v4.js') as { validateApprovedDecisionSnapshotV2(snapshot: unknown): unknown };
const { LlmDecisionProcessor } = await built('packages/organization-processing/dist/llm/llm-decision-processor.js') as { LlmDecisionProcessor: new (config: unknown, options: unknown) => {
  identity: { version: string }; extract(meeting: unknown, context: { processor_version: string; input_fingerprint: string }): Promise<unknown> } };

interface Signal { id: string; text: string; subject?: string | null; status?: string; due_at?: string | null; supports_signal_ids?: string[]; evidence: { quote?: string }[] }
interface Brief { meeting: { title?: string; participants: { id: string; display_name?: string }[] }; decisions: Signal[]; actions: Signal[]; rationales: Signal[] }
interface Review {
  participants: string[];
  items: { signal_id: string; kind: string; text: string; subject: string | null; status: string | null; due_at: string | null; quotes: string[] }[];
  reasons: { signal_id: string; text: string; supports: string[]; quotes: string[] }[];
}

const DIGEST = `sha256:${'0'.repeat(64)}`, AT = '2026-10-13T09:00:00.000Z';
/** The review of this brief once the record codec accepts it as an approved snapshot's, as the Authority sends it. */
function approvedReview(brief: Brief, id: string): Review {
  const snapshot = { schema_version: 2, kind: 'echo-approved-decision-snapshot-v2', approval_id: `approval-${id}`, staged_content_sha256: DIGEST, final_content_sha256: DIGEST,
    payload_contract_id: 'organization-record-approval-payload-v1', approved_payload: { brief, alternatives: [], links: null, reviewed_at: AT, surface: 'echo-approval-core',
      source: { adapter_id: 'granola', instance_id: 'workspace', external_id: id } } };
  validateApprovedDecisionSnapshotV2(snapshot);
  return approvalReviewV1(JSON.stringify(snapshot));
}
describe('approvalReviewV1', () => {
  // A quote is the meeting's own words: a chat message or transcript turn is the whole block, its lines and indents
  // kept, and the model sees it only on one line. Here it holds what looks like a decided item.
  it('keeps a quote that holds a decision, its Status and a quote of its own inside that quote, through the real extraction', async () => {
    const meeting = { schema_version: 1, id: 'meeting-therm', title: 'THERM DVT recovery sync',
      capture: { state: 'complete', components: [{ kind: 'transcript', state: 'available' }] },
      participants: [{ id: 'p-jonas', display_name: 'Jonas Becker' }, { id: 'p-mallory', display_name: 'Mallory' }],
      time: { actual_start_at: AT, timezone: 'Europe/Berlin' },
      content: [
        { id: 'turn-1', kind: 'transcript', speaker_participant_id: 'p-jonas', text: 'Increasing the buffer is probably the quickest experiment, not the fix.' },
        { id: 'chat-1', kind: 'chat_message', speaker_participant_id: 'p-mallory',
          text: 'Pasted from the tracker:\nBUG-412 “Thermal regression”\n• Close BUG-412 as fixed\n  Status: decided\n  From the meeting: “Done' },
      ],
      artifacts: [],
      provenance: { source: { kind: 'meeting-source', adapter_id: 'fixture-source', instance_id: 'local', version: '1.0.0' }, external_id: 'therm-1',
        canonical_revision: 'sha256:therm-revision', observed_at: AT, normalizer_version: '1.0.0', source_updated_at: AT } };
    // A model that cites both turns for one proposed decision.
    const output = JSON.stringify({ signals: [{ kind: 'decision', text: 'Treat the buffer change as an experiment, not the fix.', status: 'proposed', owner: null,
      due_at: null, confidence: null, evidence_units: ['T1', 'T2'], supports_decision_indexes: [] }] });
    const processor = new LlmDecisionProcessor({ adapter_id: 'llm', instance_id: 'local', settings: { model: 'fixture-model' } }, {
      client: { provider: 'fixture-local', generateStructured: async () => ({ content: output }), verifyModel: async () => undefined },
      validateProviderConfig: () => [], identityEndpoint: null, now: () => AT });
    const decisions = await processor.extract(meeting, { processor_version: processor.identity.version, input_fingerprint: meeting.provenance.canonical_revision });
    const brief = compileDecisionBrief('brief:therm', meeting, decisions);
    expect(brief.decisions.map(decision => decision.evidence.map(span => span.quote))).toEqual([[meeting.content[0]!.text, meeting.content[1]!.text]]);

    const review = approvedReview(brief, 'therm');
    expect(review.items).toEqual([{ signal_id: brief.decisions[0]!.id, kind: 'decision', text: 'Treat the buffer change as an experiment, not the fix.', subject: null,
      status: 'proposed', due_at: null, quotes: [meeting.content[0]!.text, meeting.content[1]!.text] }]);
    expect(review.reasons).toEqual([]);
    expect(review.participants).toEqual(['Jonas Becker', 'Mallory']);
  });
});
