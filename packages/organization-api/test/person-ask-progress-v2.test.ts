import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  createPersonAskProgressDecoderV1,
  createPersonAskProgressDecoderV2,
  formatPersonAskProgressEventV1,
  formatPersonAskProgressEventV2,
  validatePersonAskProgressStepEventV1,
  validatePersonAskProgressStepEventV2,
  validatePersonAskReceiptV1,
  validatePersonAskReceiptV2,
} from '../src/index.js';

const record = canonicalSha256('record');
const decision = { citation: { kind: 'approved_record' as const, atom_id: canonicalSha256('atom'), record_sha256: record, policy_id: 'organization-member-readable-person-v2' as const }, kind: 'decision' as const, label: 'THERM DVT recovery sync', visibility: 'team' as const, ref: `meeting:${record}` as const };
const followUp = { citation: { kind: 'follow_up' as const, item_id: 'itm_launch-1' }, kind: 'follow_up' as const, label: 'Ship the launch checklist', visibility: 'team' as const, ref: 'follow_up:itm_launch-1' as const };
const receipt = () => ({ looked_through: 2, elapsed_ms: 31_000, rows: [{ type: 'searched' as const, sources: [{ kind: 'meetings' as const }, { kind: 'follow_ups' as const }, { kind: 'tickets' as const, tool_id: 'jira' }], found: 9 },
  { type: 'read' as const, items: [followUp, decision] }] });

describe('Ask progress V2 wire contract (/v6, ADR-0040)', () => {
  it('names follow-ups as a searched source kind, with no tool id', () => {
    const searched = { type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'follow_ups' }, { kind: 'tickets', tool_id: 'jira' }], found: 9 };
    expect(validatePersonAskProgressStepEventV2(searched)).toEqual(searched);
    expect(() => validatePersonAskProgressStepEventV2({ type: 'searched', sources: [{ kind: 'follow_ups', tool_id: 'jira' }], found: 1 })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV2({ type: 'searched', sources: [{ kind: 'follow_ups' }, { kind: 'follow_ups' }], found: 1 })).toThrow('duplicates');
    // A V1 client never meets one.
    expect(() => validatePersonAskProgressStepEventV1(searched)).toThrow('kind is invalid');
  });

  it('names a follow-up read as its V7 citation, with the ref that opens its item page', () => {
    const event = validatePersonAskProgressStepEventV2({ type: 'read', items: [followUp, decision] });
    expect(event).toEqual({ type: 'read', items: [followUp, decision] });
    expect(Object.isFrozen(event)).toBe(true);
    expect(() => validatePersonAskProgressStepEventV2({ type: 'read', items: [{ ...followUp, ref: undefined }] })).toThrow();
    const { ref: _ref, ...unopened } = followUp;
    expect(() => validatePersonAskProgressStepEventV2({ type: 'read', items: [unopened] })).toThrow('ref is missing');
    expect(() => validatePersonAskProgressStepEventV2({ type: 'read', items: [{ ...followUp, ref: 'follow_up:itm_other-1' }] })).toThrow('ref is inconsistent');
    expect(() => validatePersonAskProgressStepEventV2({ type: 'read', items: [{ ...followUp, kind: 'decision' }] })).toThrow();
    expect(() => validatePersonAskProgressStepEventV2({ type: 'read', items: [followUp, followUp] })).toThrow('names an item twice');
    expect(() => validatePersonAskProgressStepEventV1({ type: 'read', items: [followUp] })).toThrow();
  });

  it('builds a receipt whose rows may name follow-ups', () => {
    expect(validatePersonAskReceiptV2(receipt())).toEqual(receipt());
    expect(() => validatePersonAskReceiptV1(receipt())).toThrow();
  });

  it('decodes a V1 stream, while a V1 decoder refuses a follow-up', () => {
    expect(() => createPersonAskProgressDecoderV1().push(formatPersonAskProgressEventV2({ type: 'read', items: [followUp] }))).toThrow();
    expect(createPersonAskProgressDecoderV2().push(formatPersonAskProgressEventV1({ type: 'read', items: [decision] }))).toEqual([{ type: 'read', items: [decision] }]);
  });
});
