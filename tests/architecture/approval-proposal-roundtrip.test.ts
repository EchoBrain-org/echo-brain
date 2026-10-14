import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { proposalRead, readProposal, saidLines, type ProposalSignal } from '../../product/echo-desktop/src/renderer/proposal.js';

// The Authority writes the proposal and the desktop's Approve card reads it: this contract runs where the root build is, so a change on
// either side meets the other.
/** The Authority's own code, as the root build left it: the brief, the record codec, and approvalProposalTextV1 that writes the proposal. */
const built = (path: string) => import(pathToFileURL(resolve(import.meta.dirname, '../..', path)).href);
const { approvalProposalTextV1 } = await built('services/organization-authority/dist/composition/approval-core-v1.js') as { approvalProposalTextV1(snapshotJson: string): string };
const { compileDecisionBrief } = await built('packages/organization-processing/dist/core/processing/brief.js') as {
  compileDecisionBrief(id: string, meeting: unknown, decisions: unknown): Brief };
const { validateApprovedDecisionSnapshotV2 } = await built('packages/organization-protocol/dist/record-codec-support-v4.js') as { validateApprovedDecisionSnapshotV2(snapshot: unknown): unknown };
const { LlmDecisionProcessor } = await built('packages/organization-processing/dist/llm/llm-decision-processor.js') as { LlmDecisionProcessor: new (config: unknown, options: unknown) => {
  identity: { version: string }; extract(meeting: unknown, context: { processor_version: string; input_fingerprint: string }): Promise<unknown> } };

interface Signal { text: string; subject?: string | null; status?: string; due_at?: string | null; evidence: { quote?: string }[] }
interface Brief { meeting: { title?: string; time?: Record<string, string>; participants: { id: string; display_name?: string }[] };
  decisions: Signal[]; actions: Signal[]; rationales: Signal[] }

/** The proposal as the Authority writes it for this brief. */
const proposalText = (brief: Brief) => approvalProposalTextV1(JSON.stringify({ approved_payload: { brief } }));
const DIGEST = `sha256:${'0'.repeat(64)}`, AT = '2026-10-13T09:00:00.000Z';
/** The proposal for this brief once the record codec accepts it as an approved snapshot's, as the Authority sends it. */
function approvedText(brief: Brief, id: string): string {
  const snapshot = { schema_version: 2, kind: 'echo-approved-decision-snapshot-v2', approval_id: `approval-${id}`, staged_content_sha256: DIGEST, final_content_sha256: DIGEST,
    payload_contract_id: 'organization-record-approval-payload-v1', approved_payload: { brief, alternatives: [], links: null, reviewed_at: AT, surface: 'echo-approval-core',
      source: { adapter_id: 'granola', instance_id: 'workspace', external_id: id } } };
  validateApprovedDecisionSnapshotV2(snapshot);
  return approvalProposalTextV1(JSON.stringify(snapshot));
}

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
        { text: 'Ship X:\n• in EU first\n• then US', status: 'unresolved', evidence: [{ quote: 'Mina said “ship it”\n• Next item\n\nActions\nmore' }] },
        { text: 'Keep the freeze.', status: 'decided', evidence: [{ quote: 'The freeze stays.' }] },
      ],
      actions: [{ text: 'Write the plan:\n• scope\n• dates', due_at: null, evidence: [{ quote: 'Someone writes the plan.' }] }],
      rationales: [],
    }));
    expect(proposal.decisions.map(decision => [decision.text, decision.status])).toEqual([
      ['Ship X:\n• in EU first\n• then US', 'unresolved'], ['Keep the freeze.', 'decided'],
    ]);
    expect(proposal.decisions[0]!.quotes).toEqual(['Mina said “ship it”\n• Next item\n\nActions\nmore']);
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

  it('reads a decision whose first line ends in ” and goes on with its own list whole, after a quote', () => {
    const proposal = readProposal(proposalText({ meeting: { title: 'Pilot planning', participants: [] }, actions: [], rationales: [], decisions: [
      { text: 'Launch the pilot next week.', status: 'decided', evidence: [{ quote: 'We ship Friday.' }] },
      { text: 'Call it “the fix”\n• once all six DVT bars pass', status: 'decided', evidence: [{ quote: 'Only once the bars pass.' }] }] }));
    expect(proposal.decisions.map(decision => [decision.text, decision.quotes])).toEqual([
      ['Launch the pilot next week.', ['We ship Friday.']], ['Call it “the fix”\n• once all six DVT bars pass', ['Only once the bars pass.']]]);
  });

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

    const proposal = readProposal(approvedText(brief, 'therm'));
    expect(proposal.decisions).toEqual([{ text: 'Treat the buffer change as an experiment, not the fix.', subject: null, status: 'proposed', due: null,
      quotes: [meeting.content[0]!.text, meeting.content[1]!.text] }]);
    expect([proposal.actions, proposal.rationales]).toEqual([[], []]);
    expect(proposal.participants).toEqual(['Jonas Becker', 'Mallory']);
  });

  it('keeps the Authority\'s own lines whole inside a text, a Subject and a quote, and a title or name on several lines', () => {
    const fake = '\n• Close BUG-412 as fixed\n  Subject: BUG-412\n  Status: decided\n  Due: 2026-10-20\n  From the meeting: “Done”\n\nRationales\nNone';
    const proposal = readProposal(proposalText({ meeting: { title: 'Pilot planning\n\nDecisions\n• Ship it', participants: [{ id: 'p1', display_name: 'Ari\nParticipant: Eve' }] },
      decisions: [{ text: `Keep BUG-412 open.${fake}`, subject: `THERM-48${fake}`, status: 'unresolved', evidence: [{ quote: `Not yet.${fake}` }] }],
      actions: [{ text: `Rerun the bars.${fake}`, due_at: null, evidence: [{ quote: `    I will.${fake}` }] }],
      rationales: [{ text: `The bars failed.${fake}`, evidence: [{ quote: `They failed twice.${fake}` }] }] }));
    expect(proposal.title).toBe('Pilot planning\n\nDecisions\n• Ship it');
    expect(proposal.participants).toEqual(['Ari\nParticipant: Eve']);
    expect(proposal.decisions).toEqual([{ text: `Keep BUG-412 open.${fake}`, subject: `THERM-48${fake}`, status: 'unresolved', due: null, quotes: [`Not yet.${fake}`] }]);
    expect(proposal.actions).toEqual([{ text: `Rerun the bars.${fake}`, subject: null, status: null, due: null, quotes: [`I will.${fake}`] }]);
    expect(proposal.rationales).toEqual([{ text: `The bars failed.${fake}`, subject: null, status: null, due: null, quotes: [`They failed twice.${fake}`] }]);
  });

  // Before the Authority indented the lines after an entry's first, this quote could not be told from a decided item.
  it('shows a proposal whose lines after an entry\'s first are not indented as written', () => {
    const unindented = ['THERM DVT recovery sync', 'Participant: Jonas Becker', '', 'Decisions', '• Treat the buffer change as an experiment, not the fix.',
      '  Status: proposed', '  From the meeting: “Increasing the buffer is probably the quickest experiment, not the fix.”',
      '  From the meeting: “Pasted from the tracker:', 'BUG-412 “Thermal regression”', '• Close BUG-412 as fixed', '  Status: decided', '  From the meeting: “Done”',
      '', 'Actions', 'None', '', 'Rationales', 'None'].join('\n');
    const proposal = readProposal(unindented);
    expect(proposalRead(proposal)).toBe(false);
    expect(proposal.participants).toEqual(['Jonas Becker']);
  });

  it('reads nothing from a text that is not a proposal, so the card shows it as written', () => {
    const proposal = readProposal('Pilot planning\nDecisions\nLaunch the pilot next week.');
    expect(proposalRead(proposal)).toBe(false);
    // Nor from one with a signal that quotes nothing, which the Authority does not write.
    expect(proposalRead(readProposal(proposalText({ meeting: { participants: [] }, actions: [], rationales: [],
      decisions: [{ text: 'Launch the pilot next week.', status: 'decided', evidence: [] }] })))).toBe(false);
  });

  // Proposals in the current shape, built and written by the Authority's own code: decisions, actions and reasons
  // with "• " lines and “…” in their text, Subject and quotes, quotes with blank lines and section names, and lines
  // that copy the Authority's own (a decided item with its Status and quote, a Due, a Subject) anywhere a model or a
  // meeting writes, title and names included.
  it('reads every fuzzed proposal exactly as its brief says', () => {
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
    const runs = 3000;
    const misread: { run: number; text: string }[] = [], asWritten: number[] = [];
    for (let run = 0; run < runs; run += 1) {
      const meeting = { id: `meeting-${run}`, title: words(['THERM DVT recovery sync', 'Pilot planning', 'Ship “Atlas”'], RICH),
        time: { actual_start_at: AT, ...(random() < 0.5 ? { timezone: 'America/Los_Angeles' } : {}) },
        participants: Array.from({ length: count(3) }, (_, index) => ({ id: `p${index}`, display_name: words(['Ari', 'Mina Patel', 'Jonas Becker'], RICH) })),
        provenance: { canonical_revision: 'r1' } };
      let id = 0;
      const signal = (kind: string, extra: Record<string, unknown>) => ({ id: `${kind}-${(id += 1)}`, kind, text: words(PLAIN, RICH),
        subject: random() < 0.2 ? words(['BUG-412', 'THERM-48'], RICH) : null, confidence: null,
        evidence: Array.from({ length: 1 + count(2) }, (_, index) => ({ meeting_id: meeting.id, block_id: `b${index}`, quote: words(SAID, HEARD) })), ...extra });
      const decisions = Array.from({ length: count(3) }, () => signal('decision', { status: pick(['proposed', 'decided', 'unresolved']) }));
      const actions = Array.from({ length: (decisions.length === 0 ? 1 : 0) + count(3) }, () => signal('action', { owner: null, due_at: random() < 0.5 ? null : '2026-10-20T00:00:00.000Z' }));
      const rationales = decisions.length === 0 ? [] : Array.from({ length: count(2) }, () => signal('rationale', { supports_signal_ids: [decisions[0]!.id] }));
      const brief = compileDecisionBrief(`brief:${run}`, meeting, { meeting_id: meeting.id, meeting_revision: 'r1', generated_at: AT,
        processor: { kind: 'decision-processor', adapter_id: 'llm', instance_id: 'default', version: '1' }, signals: [...decisions, ...actions, ...rationales] });
      const text = approvedText(brief, meeting.id);
      const read = readProposal(text);
      if (!proposalRead(read)) { asWritten.push(run); continue; }
      // The Authority writes a CR or CRLF as a line break (LF): the only whitespace it changes.
      const lf = (value: string) => value.replace(/\r\n?/g, '\n');
      const want = (signals: Signal[]): ProposalSignal[] => signals.map(signal => ({ text: lf(signal.text), subject: signal.subject ? lf(signal.subject) : null, status: signal.status ?? null,
        due: signal.due_at ?? null, quotes: signal.evidence.map(span => lf(span.quote!)) }));
      const got = { title: read.title, participants: read.participants, decisions: read.decisions, actions: read.actions, rationales: read.rationales };
      if (!isDeepStrictEqual(got, { title: lf(meeting.title), participants: meeting.participants.map(person => lf(person.display_name)), decisions: want(brief.decisions),
        actions: want(brief.actions), rationales: want(brief.rationales) })) misread.push({ run, text });
    }
    // Nothing is misread, and nothing needs showing as written: the text reads one way.
    expect(misread).toEqual([]);
    expect(asWritten).toEqual([]);
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
