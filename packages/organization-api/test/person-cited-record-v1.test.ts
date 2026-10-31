import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  personCitedRecordV1,
  personRecordAtomIdV1,
  validatePersonCitedRecordV1,
  validatePersonRecordListV1,
  type PersonRecordListItemV1,
} from '../src/index.js';

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
const RECORD = sha('5');
const atom = (signal: string) => personRecordAtomIdV1(RECORD, signal);
const item = (kind: string, id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, kind, text, ...extra });

/** One record as `person records --record-sha256` lists it, its envelope trimmed to what the projection reads. */
function listed(brief: Record<string, unknown>, change: (record: Record<string, unknown>) => void = () => undefined): PersonRecordListItemV1 {
  const record: Record<string, unknown> = {
    position: 1, approval_id: 'apr_1', record_sha256: RECORD,
    envelope: { record_sha256: RECORD, body: { event: {
      kind: 'approved', policy_id: 'organization-member-readable-person-v2', approved_snapshot: { approved_payload: { brief: {
        meeting: { id: 'm1', title: 'Tuesday sync' }, decisions: [], actions: [], rationales: [], ...brief,
      } } },
    } } },
    source_metadata: { record_approved_by: { display_name: 'Maya Chen' } },
  };
  change(record);
  return validatePersonRecordListV1({ schema_version: 1, kind: 'echo-clean-person-record-list-v1', records: [record] }).records[0]!;
}
const body = (record: Record<string, unknown>) => (record.envelope as { body: Record<string, unknown> }).body;

describe('one approved record as Ask cites it', () => {
  it('names each item by the atom id its citations carry: the digest of the record and the signal', () => {
    expect(atom('d1')).toBe(canonicalSha256({ kind: 'echo-organization-record-atom', record_hash: RECORD, signal_id: 'd1' }));
    expect(atom('d1')).not.toBe(atom('d2'));
  });

  it('keeps the meeting, who approved it, who was there, its policy and what was approved, and no identity', () => {
    const cited = personCitedRecordV1(listed({
      meeting: {
        id: 'm1', title: 'Tuesday\u0000sync ', time: { scheduled_start_at: '2026-09-15T17:00:00Z', timezone: 'America/Los_Angeles' },
        participants: [
          { id: 'p1', display_name: 'Maya Chen' }, { id: 'p2', display_name: 'Ari' }, { id: 'p3', display_name: ' Maya Chen' },
          { id: 'p4', identities: [{ kind: 'email', value: 'private@example.test' }] },
        ],
      },
      decisions: [item('decision', 'd1', 'Ship annual plans first.', {
        status: 'proposed', evidence: [
          { quote: 'Annual first.', started_at: '2026-09-15T17:12:00Z', speaker_email: 'private@example.test' }, { quote: 'Annual first. ' },
          { quote: 'Two' }, { quote: '​' }, { quote: 'Three' }, { quote: 'Four' },
        ],
      })],
      actions: [item('action', 'a1', 'Update\npricing.', { status: 'proposed' })],
      rationales: [item('rationale', 'r1', 'It funds the launch.')],
    }));
    expect(cited).toEqual({
      schema_version: 1, kind: 'echo-person-cited-record-v1', record_sha256: RECORD, policy_id: 'organization-member-readable-person-v2',
      title: 'Tuesday sync', started_at: '2026-09-15T17:00:00Z', timezone: 'America/Los_Angeles', all_day: false, approved_by: 'Maya Chen',
      participants: ['Maya Chen', 'Ari'], participants_more: false,
      decisions: { more: false, items: [{ atom_id: atom('d1'), text: 'Ship annual plans first.', status: 'proposed', quotes: [
        { quote: 'Annual first.', started_at: '2026-09-15T17:12:00Z' }, { quote: 'Two' }, { quote: 'Three' },
      ] }] },
      actions: { more: false, items: [{ atom_id: atom('a1'), text: 'Update pricing.', quotes: [] }] },
      rationales: { more: false, items: [{ atom_id: atom('r1'), text: 'It funds the launch.', quotes: [] }] },
    });
    expect(JSON.stringify(cited)).not.toMatch(/private@example\.test|"p1"|"d1"|"m1"/);
    expect(validatePersonCitedRecordV1(JSON.parse(JSON.stringify(cited)))).toEqual(cited);
  });

  it('names an action owner only as the approver confirmed it in the signed approval', () => {
    const cited = personCitedRecordV1(listed({
      actions: [item('action', 'a1', 'Send the quote.', { owner: 'Unconfirmed proposal' }), item('action', 'a2', 'Book the venue.')],
    }, record => {
      body(record).human_act_resolution_ref = { action_owners: [{ signal_id: 'a2', owner: 'Priya Shah' }, { signal_id: 'd9', owner: 'Nobody' }, { signal_id: 'a1', owner: 'x'.repeat(121) }] };
    }));
    expect(cited.actions.items).toEqual([
      { atom_id: atom('a1'), text: 'Send the quote.', quotes: [] },
      { atom_id: atom('a2'), text: 'Book the venue.', owner: 'Priya Shah', quotes: [] },
    ]);
  });

  it('keeps 32 items a section and 32 participants, saying more were left out, and every text whole', () => {
    const decisions = Array.from({ length: 33 }, (_, index) => item('decision', `d${index}`, index === 0 ? 'x'.repeat(2_001) : `Decision ${index}`));
    const participants = Array.from({ length: 40 }, (_, index) => ({ id: `p${index}`, display_name: `Person ${index}` }));
    const cited = personCitedRecordV1(listed({ meeting: { id: 'm1', participants }, decisions }));
    expect(cited.title).toBeUndefined();
    expect(cited.decisions.items).toHaveLength(32);
    expect(cited.decisions.more).toBe(true);
    expect(cited.decisions.items[0]!.text).toBe('x'.repeat(2_001));
    expect(cited.participants).toHaveLength(32);
    expect(cited.participants_more).toBe(true);
    expect(validatePersonCitedRecordV1(JSON.parse(JSON.stringify(cited)))).toEqual(cited);
  });

  it('says who may read it by its policy, and has no approver when none was resolved', () => {
    const restricted = personCitedRecordV1(listed({}, record => {
      (body(record).event as Record<string, unknown>).policy_id = 'restricted-reviewer-person-v2';
      delete record.source_metadata;
    }));
    expect(restricted.policy_id).toBe('restricted-reviewer-person-v2');
    expect(restricted.approved_by).toBeUndefined();
  });

  it('refuses another record\'s envelope, an unapproved record, an unknown policy, or a malformed brief', () => {
    expect(() => personCitedRecordV1(listed({}, record => { (record.envelope as Record<string, unknown>).record_sha256 = sha('6'); }))).toThrow();
    expect(() => personCitedRecordV1(listed({}, record => { (body(record).event as Record<string, unknown>).kind = 'rejected'; }))).toThrow();
    expect(() => personCitedRecordV1(listed({}, record => { (body(record).event as Record<string, unknown>).policy_id = 'everyone'; }))).toThrow();
    expect(() => personCitedRecordV1(listed({ decisions: [item('action', 'd1', 'Wrong kind')] }))).toThrow();
    expect(() => personCitedRecordV1(listed({ decisions: [item('decision', 'd1', 'One'), item('decision', 'd1', 'Same id')] }))).toThrow();
    expect(() => personCitedRecordV1(listed({ decisions: [item('decision', 'd1', ' \u0007 ')] }))).toThrow();
    expect(() => personCitedRecordV1(listed({ actions: undefined }))).toThrow();
    expect(() => personCitedRecordV1(listed({ meeting: undefined }))).toThrow();
  });

  it('validates the projection exactly: its keys, ids, bounds and display text', () => {
    const cited = JSON.parse(JSON.stringify(personCitedRecordV1(listed({
      decisions: [item('decision', 'd1', 'Ship it.', { status: 'decided', evidence: [{ quote: 'Ship.' }] })],
      actions: [item('action', 'a1', 'Send it.')],
    }, record => { body(record).human_act_resolution_ref = { action_owners: [{ signal_id: 'a1', owner: 'Priya Shah' }] }; })))) as Record<string, unknown>;
    expect(validatePersonCitedRecordV1(cited)).toEqual(cited);
    type Copy = Record<string, unknown> & { decisions: { items: Record<string, unknown>[] }; actions: { items: Record<string, unknown>[] } };
    const variant = (change: (copy: Copy) => void): Copy => { const copy = structuredClone(cited) as Copy; change(copy); return copy; };
    for (const bad of [
      variant(copy => { copy.envelope = {}; }),
      variant(copy => { copy.kind = 'echo-clean-person-record-list-v1'; }),
      variant(copy => { copy.record_sha256 = 'sha256:nope'; }),
      variant(copy => { copy.policy_id = 'everyone'; }),
      variant(copy => { copy.title = 'Tuesday\nsync'; }),
      variant(copy => { copy.timezone = 'Not a zone!'; }),
      variant(copy => { copy.participants = ['Ari', 'Ari']; }),
      variant(copy => { copy.participants = Array.from({ length: 33 }, (_, index) => `Person ${index}`); }),
      variant(copy => { copy.decisions.items[0]!.atom_id = 'd1'; }),
      variant(copy => { copy.decisions.items[0]!.text = ' Ship it.'; }),
      variant(copy => { copy.decisions.items[0]!.status = 'maybe'; }),
      variant(copy => { copy.decisions.items[0]!.owner = 'Priya Shah'; }),
      variant(copy => { copy.decisions.items[0]!.signal_id = 'd1'; }),
      variant(copy => { copy.actions.items[0]!.status = 'decided'; }),
      variant(copy => { copy.actions.items[0]!.owner = 'x'.repeat(121); }),
      variant(copy => { copy.decisions.items[0]!.quotes = [{ quote: 'One' }, { quote: 'Two' }, { quote: 'Three' }, { quote: 'Four' }]; }),
      variant(copy => { copy.decisions.items[0]!.quotes = [{ quote: 'One' }, { quote: 'One' }]; }),
      variant(copy => { copy.decisions.items[0]!.quotes = [{ quote: 'One', started_at: 'yesterday' }]; }),
      variant(copy => { copy.decisions.items = Array.from({ length: 33 }, () => copy.decisions.items[0]!); }),
    ]) expect(() => validatePersonCitedRecordV1(bad), JSON.stringify(bad)).toThrow();
  });
});
