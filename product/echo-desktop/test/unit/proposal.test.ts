import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { proposalRead, readProposal, saidLines, type ProposalSignal } from '../../src/renderer/proposal.js';

/** The Authority's own code, as the root build left it: the brief, the record codec, and approvalProposalTextV1 that writes the proposal. */
const built = (path: string) => import(pathToFileURL(resolve(import.meta.dirname, '../../../..', path)).href);
const { approvalProposalTextV1 } = await built('services/organization-authority/dist/composition/approval-core-v1.js') as { approvalProposalTextV1(snapshotJson: string): string };
const { compileDecisionBrief } = await built('packages/organization-processing/dist/core/processing/brief.js') as {
  compileDecisionBrief(id: string, meeting: unknown, decisions: unknown): Brief };
const { validateApprovedDecisionSnapshotV2 } = await built('packages/organization-protocol/dist/record-codec-support-v4.js') as { validateApprovedDecisionSnapshotV2(snapshot: unknown): unknown };

interface Signal { text: string; subject?: string | null; status?: string; due_at?: string | null; evidence: { quote?: string }[] }
interface Brief { meeting: { title?: string; time?: Record<string, string>; participants: { id: string; display_name?: string }[] };
  decisions: Signal[]; actions: Signal[]; rationales: Signal[] }

/** The proposal as the Authority writes it for this brief. */
const proposalText = (brief: Brief) => approvalProposalTextV1(JSON.stringify({ approved_payload: { brief } }));

// Since meetings are cited by numbered units, every signal has at least one quote, one per unit it cites: a
// transcript turn without its "Label: ", a note line without its list marker, or a sentence-packed part.
const THERM = proposalText({
  meeting: { title: 'THERM DVT recovery sync', time: { actual_start_at: '2026-10-13T09:00:00.000Z' },
    participants: [{ id: 'p1', display_name: 'Jonas Becker' }, { id: 'p2', display_name: 'Tomas Okafor' }, { id: 'p3' }] },
  decisions: [
    { text: 'The buffer change is treated as an experiment, not as the confirmed fix for BUG-412 / THERM-46.', status: 'decided', evidence: [
      { quote: 'The gate itself is still on hold.\n\n[09:01] Jonas Becker: Increasing the buffer is probably the quickest experiment.\n\n[09:01] Tomas Okafor: Experiment, yes. But let\'s not call it the fix yet.' },
      { quote: '[09:03] Zhen Ye: No, that would get ahead of the evidence.\n\nActions\n\n[09:03] Jonas Becker: Fine.' },
    ] },
    { text: 'Rerun all six DVT test bars.', subject: 'THERM-48', status: 'unresolved', evidence: [{ quote: 'We rerun all six bars.' }] },
  ],
  actions: [{ text: 'Put the recovery package together against BUG-412.', due_at: '2026-10-20', evidence: [{ quote: 'I will own getting that package together.' }] },
    { text: 'Contribute the firmware detail.', due_at: null, evidence: [{ quote: 'I can add the firmware detail.' }] }],
  rationales: [],
});

describe('readProposal', () => {
  it('reads the meeting, each decision with its status and quotes, and each action with its due date', () => {
    const proposal = readProposal(THERM);
    expect(proposal.title).toBe('THERM DVT recovery sync');
    expect(proposal.participants).toEqual(['Jonas Becker', 'Tomas Okafor', 'p3']);
    expect(proposal.decisions.map(decision => [decision.text, decision.status, decision.subject])).toEqual([
      ['The buffer change is treated as an experiment, not as the confirmed fix for BUG-412 / THERM-46.', 'decided', null],
      ['Rerun all six DVT test bars.', 'unresolved', 'THERM-48'],
    ]);
    // A quote keeps its blank lines, and a line in it that reads like a section heading stays in it.
    expect(proposal.decisions[0]!.quotes).toEqual([
      'The gate itself is still on hold.\n\n[09:01] Jonas Becker: Increasing the buffer is probably the quickest experiment.\n\n[09:01] Tomas Okafor: Experiment, yes. But let\'s not call it the fix yet.',
      '[09:03] Zhen Ye: No, that would get ahead of the evidence.\n\nActions\n\n[09:03] Jonas Becker: Fine.',
    ]);
    expect(proposal.actions.map(action => [action.text, action.due, action.quotes])).toEqual([
      ['Put the recovery package together against BUG-412.', '2026-10-20', ['I will own getting that package together.']],
      ['Contribute the firmware detail.', null, ['I can add the firmware detail.']],
    ]);
    expect(proposal.rationales).toEqual([]);
    expect(proposalRead(proposal)).toBe(true);
  });

  it('keeps a decision whose text has its own bullets whole, and a quote whose lines look like the next signal', () => {
    const proposal = readProposal(proposalText({
      meeting: { title: 'Rollout', participants: [] },
      decisions: [
        { text: 'Ship X:\n• in EU first\n• then US', status: 'unresolved', evidence: [{ quote: 'Mina said “ship it” first\n• Next item\n\nActions\nmore' }] },
        { text: 'Keep the freeze.', status: 'decided', evidence: [{ quote: 'The freeze stays.' }] },
      ],
      actions: [{ text: 'Write the plan:\n• scope\n• dates', due_at: null, evidence: [{ quote: 'Someone writes the plan.' }] }],
      rationales: [],
    }));
    expect(proposal.decisions.map(decision => [decision.text, decision.status])).toEqual([
      ['Ship X:\n• in EU first\n• then US', 'unresolved'], ['Keep the freeze.', 'decided'],
    ]);
    expect(proposal.decisions[0]!.quotes).toEqual(['Mina said “ship it” first\n• Next item\n\nActions\nmore']);
    expect(proposal.actions.map(action => action.text)).toEqual(['Write the plan:\n• scope\n• dates']);
  });

  it('reads a signal with its own list after a quoted one, and every quote of a signal citing several units', () => {
    const proposal = readProposal(proposalText({
      meeting: { title: 'Pilot planning', time: { actual_start_at: '2026-10-06T17:00:00.000Z', timezone: 'America/Los_Angeles' },
        participants: [{ id: 'p1', display_name: 'Ari' }, { id: 'p2', display_name: 'Mina Patel' }] },
      decisions: [
        { text: 'Launch the pilot next week.', status: 'decided', evidence: [{ quote: 'Launch the pilot next week' }, { quote: 'We ship Friday.' },
          { quote: 'Actions\n\n[17:05] Mina Patel: I\'ll confirm the trace by Friday.' }] },
        { text: 'Roll out:\n• EU first\n• then the US', status: 'proposed', evidence: [{ quote: 'EU first, then the US?' }] },
      ],
      actions: [
        { text: 'Confirm the trace', due_at: '2026-10-10', evidence: [{ quote: 'Agreed, I\'ll draft it.\nSystem audio: And confirm the trace.' }] },
        { text: 'Write the plan:\n• scope\n• dates', due_at: null, evidence: [{ quote: 'Someone writes the plan.' }] },
      ],
      rationales: [{ text: 'The freeze lifts on Friday.', evidence: [{ quote: 'The freeze lifts on Friday.' }] }],
    }));
    expect(proposal.participants).toEqual(['Ari', 'Mina Patel']);
    expect(proposal.decisions.map(decision => [decision.text, decision.status, decision.quotes])).toEqual([
      ['Launch the pilot next week.', 'decided', ['Launch the pilot next week', 'We ship Friday.', 'Actions\n\n[17:05] Mina Patel: I\'ll confirm the trace by Friday.']],
      ['Roll out:\n• EU first\n• then the US', 'proposed', ['EU first, then the US?']],
    ]);
    expect(proposal.actions.map(action => [action.text, action.due, action.quotes])).toEqual([
      ['Confirm the trace', '2026-10-10', ['Agreed, I\'ll draft it.\nSystem audio: And confirm the trace.']],
      ['Write the plan:\n• scope\n• dates', null, ['Someone writes the plan.']],
    ]);
    expect(proposal.rationales.map(reason => [reason.text, reason.quotes])).toEqual([['The freeze lifts on Friday.', ['The freeze lifts on Friday.']]]);
  });

  it('reads a reason with its own list as one reason, with all its quotes', () => {
    const proposal = readProposal(proposalText({
      meeting: { title: 'Pilot planning', participants: [] },
      decisions: [{ text: 'Launch the pilot next week.', status: 'decided', evidence: [{ quote: 'Launch the pilot next week.' }] }],
      actions: [],
      rationales: [{ text: 'Because:\n• cost\n• timing', evidence: [{ quote: 'It costs less.' }, { quote: 'And the timing works.' }] }],
    }));
    expect(proposal.rationales.map(reason => [reason.text, reason.quotes])).toEqual([['Because:\n• cost\n• timing', ['It costs less.', 'And the timing works.']]]);
  });

  // After a quote, `• Call it “the fix”` may end that quote or begin the next decision; the text reads both ways.
  it('shows a proposal that reads two ways as written, never one reading of it', () => {
    const brief = (first: Signal[]): Brief => ({ meeting: { title: 'Pilot planning', participants: [] }, actions: [], rationales: [], decisions: [...first,
      { text: 'Call it “the fix”\n• once all six DVT bars pass', status: 'decided', evidence: [{ quote: 'Only once the bars pass.' }] }] });
    const after = readProposal(proposalText(brief([{ text: 'Launch the pilot next week.', status: 'decided', evidence: [{ quote: 'We ship Friday.' }] }])));
    expect(proposalRead(after)).toBe(false);
    // With no quote before it, the same decision reads one way, and whole.
    expect(readProposal(proposalText(brief([]))).decisions.map(decision => decision.text)).toEqual(['Call it “the fix”\n• once all six DVT bars pass']);
  });

  it('reads nothing from a text that is not a proposal, so the card shows it as written', () => {
    const proposal = readProposal('Pilot planning\nDecisions\nLaunch the pilot next week.');
    expect(proposalRead(proposal)).toBe(false);
    // Nor from one with a signal that quotes nothing, which the Authority does not write.
    expect(proposalRead(readProposal(proposalText({ meeting: { participants: [] }, actions: [], rationales: [],
      decisions: [{ text: 'Launch the pilot next week.', status: 'decided', evidence: [] }] })))).toBe(false);
  });

  // Proposals in the current shape, built and written by the Authority's own code: decisions, actions and reasons
  // with "• " lines and “…” in their text and in their quotes, quotes with blank lines and section names.
  it('reads every fuzzed proposal as its brief says, or shows it as written', () => {
    let seed = 0x5eed;
    const random = () => { // mulberry32, so a failure replays
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const count = (most: number) => Math.floor(random() * (most + 1));
    const PLAIN = ['Launch the pilot next week.', 'Treat the buffer change as an experiment, not as the fix.', 'Rerun all six DVT test bars.',
      'Send the revised quote to Rafael.', 'The freeze lifts on Friday.', 'Keep the “two-key” review for every release.'];
    const RICH = [...PLAIN, 'Roll out:', '• EU first', '• then the US', 'Call it “the fix”', '• keep “BUG-412” open', '“Ship it” stands.', 'Actions', 'None', ''];
    const SAID = ['[09:01] Jonas Becker: Increasing the buffer is probably the quickest experiment.', 'I’ll own getting that package together.',
      'The gate itself is still on hold.', '[09:03] Tomas Okafor: Experiment, yes. But let’s not call it the fix yet.'];
    const HEARD = [...SAID, 'Mina said “ship it”', '• Next item', '“Fine.”', '', 'Actions', 'Rationales', 'Decisions', 'None'];
    // A field the model or the meeting wrote: mostly one plain line, sometimes several lines that may hold anything above.
    const words = (plain: readonly string[], rich: readonly string[]) => {
      const text = random() < 0.7 ? pick(plain) : Array.from({ length: 2 + count(3) }, () => pick(rich)).join('\n').trim();
      return text === '' ? pick(plain) : text;
    };
    const DIGEST = `sha256:${'0'.repeat(64)}`, AT = '2026-10-13T09:00:00.000Z';
    const runs = 3000;
    const misread: { run: number; text: string }[] = [], asWritten: Signal[][] = [];
    for (let run = 0; run < runs; run += 1) {
      const meeting = { id: `meeting-${run}`, title: pick(['THERM DVT recovery sync', 'Pilot planning', 'Ship “Atlas”']),
        time: { actual_start_at: AT, ...(random() < 0.5 ? { timezone: 'America/Los_Angeles' } : {}) },
        participants: Array.from({ length: count(3) }, (_, index) => ({ id: `p${index}`, display_name: pick(['Ari', 'Mina Patel', 'Jonas Becker']) })),
        provenance: { canonical_revision: 'r1' } };
      let id = 0;
      const signal = (kind: string, extra: Record<string, unknown>) => ({ id: `${kind}-${(id += 1)}`, kind, text: words(PLAIN, RICH), subject: null, confidence: null,
        evidence: Array.from({ length: 1 + count(2) }, (_, index) => ({ meeting_id: meeting.id, block_id: `b${index}`, quote: words(SAID, HEARD) })), ...extra });
      const decisions = Array.from({ length: count(3) }, () => signal('decision', { status: pick(['proposed', 'decided', 'unresolved']) }));
      const actions = Array.from({ length: (decisions.length === 0 ? 1 : 0) + count(3) }, () => signal('action', { owner: null, due_at: random() < 0.5 ? null : '2026-10-20T00:00:00.000Z' }));
      const rationales = decisions.length === 0 ? [] : Array.from({ length: count(2) }, () => signal('rationale', { supports_signal_ids: [decisions[0]!.id] }));
      const brief = compileDecisionBrief(`brief:${run}`, meeting, { meeting_id: meeting.id, meeting_revision: 'r1', generated_at: AT,
        processor: { kind: 'decision-processor', adapter_id: 'llm', instance_id: 'default', version: '1' }, signals: [...decisions, ...actions, ...rationales] });
      const snapshot = { schema_version: 2, kind: 'echo-approved-decision-snapshot-v2', approval_id: `approval-${run}`, staged_content_sha256: DIGEST, final_content_sha256: DIGEST,
        payload_contract_id: 'organization-record-approval-payload-v1', approved_payload: { brief, alternatives: [], links: null, reviewed_at: AT, surface: 'echo-approval-core',
          source: { adapter_id: 'granola', instance_id: 'workspace', external_id: meeting.id } } };
      validateApprovedDecisionSnapshotV2(snapshot);
      const text = approvalProposalTextV1(JSON.stringify(snapshot));
      const read = readProposal(text);
      if (!proposalRead(read)) { asWritten.push([...brief.decisions, ...brief.actions, ...brief.rationales]); continue; }
      const want = (signals: Signal[]): ProposalSignal[] => signals.map(signal => ({ text: signal.text, subject: signal.subject ?? null, status: signal.status ?? null,
        due: signal.due_at ?? null, quotes: signal.evidence.map(span => span.quote!) }));
      const got = { decisions: read.decisions, actions: read.actions, rationales: read.rationales };
      if (!isDeepStrictEqual(got, { decisions: want(brief.decisions), actions: want(brief.actions), rationales: want(brief.rationales) })) misread.push({ run, text });
    }
    expect(misread).toEqual([]);
    // Shown as written only when it reads two ways, which takes a line ending in ” inside a signal's text or a quote:
    // about one in twenty here, where two in three proposals have such a line.
    const curly = (lines: string[]) => lines.some(line => line.endsWith('”'));
    for (const signals of asWritten) {
      expect(signals.some(signal => curly(signal.text.split('\n')) || signal.evidence.some(span => curly(span.quote!.split('\n').slice(0, -1))))).toBe(true);
    }
    expect(asWritten.length / runs).toBeLessThan(0.1);
  });
});

describe('saidLines', () => {
  it('splits a quote into who said what, joining a line without a speaker to the one before it', () => {
    expect(saidLines('The gate itself is still on hold.\n\n[09:01] Jonas Becker: Increasing the buffer\nis the quickest experiment.\n[09:01:30] Tomas Okafor: Experiment, yes.')).toEqual([
      { time: null, speaker: null, text: 'The gate itself is still on hold.' },
      { time: '09:01', speaker: 'Jonas Becker', text: 'Increasing the buffer is the quickest experiment.' },
      { time: '09:01:30', speaker: 'Tomas Okafor', text: 'Experiment, yes.' },
    ]);
  });

  it('takes a speaker whose words start on the next line, and keeps a paragraph after a blank line apart', () => {
    expect(saidLines('[09:01] Jonas: Hi\n[09:02] Mina:\nAgreed.\n\nA note on its own.')).toEqual([
      { time: '09:01', speaker: 'Jonas', text: 'Hi' },
      { time: '09:02', speaker: 'Mina', text: 'Agreed.' },
      { time: null, speaker: null, text: 'A note on its own.' },
    ]);
  });
});
