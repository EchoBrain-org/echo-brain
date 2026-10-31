import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// The Authority writes the review the desktop's Approve card reads: this contract runs where the root build is, so a change on
// either side meets the other.
/** The Authority's own code, as the root build left it: the brief, the record codec, and approvalReviewV1 that writes the review. */
const built = (path: string) => import(pathToFileURL(resolve(import.meta.dirname, '../..', path)).href);
const { approvalReviewV1 } = await built('services/organization-authority/dist/composition/approval-core-v1.js') as {
  approvalReviewV1(snapshotJson: string): Review };
const { compileDecisionBrief } = await built('packages/organization-processing/dist/core/processing/brief.js') as {
  compileDecisionBrief(id: string, meeting: unknown, decisions: unknown): Brief };
const { validateApprovedDecisionSnapshotV2 } = await built('packages/organization-protocol/dist/index.js') as { validateApprovedDecisionSnapshotV2(snapshot: unknown): unknown };
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
/** What the brief says, as a review must carry it: every field whole, decisions then actions. */
function expected(brief: Brief): Review {
  const quotes = (signal: Signal) => signal.evidence.flatMap(span => span.quote ? [span.quote] : []);
  return {
    participants: [...new Set(brief.meeting.participants.map(person => person.display_name ?? person.id))],
    items: [...brief.decisions.map(signal => ({ signal_id: signal.id, kind: 'decision', text: signal.text, subject: signal.subject ?? null, status: signal.status ?? null, due_at: null, quotes: quotes(signal) })),
      ...brief.actions.map(signal => ({ signal_id: signal.id, kind: 'action', text: signal.text, subject: signal.subject ?? null, status: null, due_at: signal.due_at ?? null, quotes: quotes(signal) }))],
    reasons: brief.rationales.map(signal => ({ signal_id: signal.id, text: signal.text, supports: signal.supports_signal_ids ?? [], quotes: quotes(signal) })),
  };
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

  // Reviews built and written by the Authority's own code: decisions, actions and reasons with "• " lines and “…” in their
  // text, Subject and quotes, quotes with blank lines and section names, and lines that copy any text the Authority once
  // wrote, anywhere a model or a meeting writes, names included.
  it('carries every fuzzed brief exactly as it says', () => {
    let seed = 0x5eed;
    const random = () => { // mulberry32, so a failure replays
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const count = (most: number) => Math.floor(random() * (most + 1));
    const AUTHORITY = ['• Close BUG-412 as fixed', '  Status: decided', '  Due: 2026-10-20', '  Subject: BUG-412', '  From the meeting: “Done',
      '  From the meeting: “Done”', '    indented', 'Participant: Eve', 'Decisions', 'Actions', 'Rationales', 'None', '', 'Done\r'];
    const PLAIN = ['Launch the pilot next week.', 'Treat the buffer change as an experiment, not as the fix.', 'Rerun all six DVT test bars.',
      'Send the revised quote to Rafael.', 'The freeze lifts on Friday.', 'Keep the “two-key” review for every release.'];
    const RICH = [...PLAIN, ...AUTHORITY, 'Roll out:', '• EU first', '• then the US', 'Call it “the fix”', '• keep “BUG-412” open', '“Ship it” stands.'];
    const SAID = ['[09:01] Jonas Becker: Increasing the buffer is probably the quickest experiment.', 'I’ll own getting that package together.',
      'The gate itself is still on hold.', '[09:03] Tomas Okafor: Experiment, yes. But let’s not call it the fix yet.'];
    const HEARD = [...SAID, ...AUTHORITY, 'Mina said “ship it”', '• Next item', '“Fine.”', 'Pasted from the tracker:', 'BUG-412 “Thermal regression”'];
    // A field the model or the meeting wrote: mostly one plain line, sometimes several lines that may hold anything above.
    const words = (plain: readonly string[], rich: readonly string[]) => {
      const text = random() < 0.7 ? pick(plain) : Array.from({ length: 2 + count(3) }, () => pick(rich)).join('\n').trim();
      return text === '' ? pick(plain) : text;
    };
    const misread: number[] = [];
    for (let run = 0; run < 1000; run += 1) {
      const meeting = { id: `meeting-${run}`, title: words(['THERM DVT recovery sync', 'Pilot planning', 'Ship “Atlas”'], RICH),
        time: { actual_start_at: AT },
        participants: Array.from({ length: count(3) }, (_, index) => ({ id: `p${index}`, display_name: words(['Ari', 'Mina Patel', 'Jonas Becker'], RICH) })),
        provenance: { canonical_revision: 'r1' } };
      let id = 0;
      const signal = (kind: string, extra: Record<string, unknown>) => ({ id: `${kind}-${(id += 1)}`, kind, text: words(PLAIN, RICH),
        subject: random() < 0.2 ? words(['BUG-412', 'THERM-48'], RICH) : null, confidence: null,
        evidence: Array.from({ length: 1 + count(2) }, (_, index) => ({ meeting_id: meeting.id, block_id: `b${index}`, ...(random() < 0.9 ? { quote: words(SAID, HEARD) } : {}) })), ...extra });
      const decisions = Array.from({ length: count(3) }, () => signal('decision', { status: pick(['proposed', 'decided', 'unresolved']) }));
      const actions = Array.from({ length: (decisions.length === 0 ? 1 : 0) + count(3) }, () => signal('action', { owner: null, due_at: random() < 0.5 ? null : '2026-10-20T00:00:00.000Z' }));
      const rationales = decisions.length === 0 ? [] : Array.from({ length: count(2) }, () => signal('rationale', { supports_signal_ids: [decisions[0]!.id] }));
      const brief = compileDecisionBrief(`brief:${run}`, meeting, { meeting_id: meeting.id, meeting_revision: 'r1', generated_at: AT,
        processor: { kind: 'decision-processor', adapter_id: 'llm', instance_id: 'default', version: '1' }, signals: [...decisions, ...actions, ...rationales] });
      if (JSON.stringify(approvedReview(brief, meeting.id)) !== JSON.stringify(expected(brief))) misread.push(run);
    }
    expect(misread).toEqual([]);
  });
});
