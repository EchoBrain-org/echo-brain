import { describe, expect, it } from 'vitest';
import { proposalRead, readProposal, saidLines } from '../../src/renderer/proposal.js';

interface Signal { text: string; subject?: string | null; status?: string; due_at?: string | null; evidence: { quote?: string }[] }

/** The Authority's approvalProposalTextV1, line for line (services/organization-authority/src/composition/approval-core-v1.ts). */
function proposalText(brief: { meeting: { title?: string; time?: Record<string, string>; participants: { id: string; display_name?: string }[] };
  decisions: Signal[]; actions: Signal[]; rationales: Signal[] }): string {
  const lines = [brief.meeting.title ?? 'Meeting', ...Object.entries(brief.meeting.time ?? {}).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`),
    ...brief.meeting.participants.map(person => `Participant: ${person.display_name ?? person.id}`)];
  for (const [name, signals] of [['Decisions', brief.decisions], ['Actions', brief.actions], ['Rationales', brief.rationales]] as const) {
    lines.push('', name);
    if (signals.length === 0) lines.push('None');
    for (const signal of signals) {
      lines.push(`• ${signal.text}`);
      if (signal.subject) lines.push(`  Subject: ${signal.subject}`);
      if ('status' in signal) lines.push(`  Status: ${signal.status}`);
      if ('due_at' in signal) lines.push(`  Due: ${signal.due_at ?? 'Not specified'}`);
      for (const span of signal.evidence) if (span.quote) lines.push(`  From the meeting: “${span.quote}”`);
    }
  }
  return lines.join('\n');
}

const THERM = proposalText({
  meeting: { title: 'THERM DVT recovery sync', time: { actual_start_at: '2026-10-13T09:00:00.000Z' },
    participants: [{ id: 'p1', display_name: 'Jonas Becker' }, { id: 'p2', display_name: 'Tomas Okafor' }, { id: 'p3' }] },
  decisions: [
    { text: 'The buffer change is treated as an experiment, not as the confirmed fix for BUG-412 / THERM-46.', status: 'decided', evidence: [
      { quote: 'The gate itself is still on hold.\n\n[09:01] Jonas Becker: Increasing the buffer is probably the quickest experiment.\n\n[09:01] Tomas Okafor: Experiment, yes. But let\'s not call it the fix yet.' },
      { quote: '[09:03] Zhen Ye: No, that would get ahead of the evidence.\n\nActions\n\n[09:03] Jonas Becker: Fine.' },
    ] },
    { text: 'Rerun all six DVT test bars.', subject: 'THERM-48', status: 'unresolved', evidence: [] },
  ],
  actions: [{ text: 'Put the recovery package together against BUG-412.', due_at: '2026-10-20', evidence: [{ quote: 'I will own getting that package together.' }] },
    { text: 'Contribute the firmware detail.', due_at: null, evidence: [] }],
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
      ['Contribute the firmware detail.', null, []],
    ]);
    expect(proposal.rationales).toEqual([]);
    expect(proposalRead(proposal)).toBe(true);
  });

  it('keeps a decision whose text has its own bullets whole, and a quote whose lines look like the next signal', () => {
    const proposal = readProposal(proposalText({
      meeting: { title: 'Rollout', participants: [] },
      decisions: [
        { text: 'Ship X:\n• in EU first\n• then US', status: 'unresolved', evidence: [{ quote: 'Mina said “ship it”\n• Next item\n\nActions\nmore' }] },
        { text: 'Keep the freeze.', status: 'decided', evidence: [] },
      ],
      actions: [{ text: 'Write the plan:\n• scope\n• dates', due_at: null, evidence: [] }],
      rationales: [],
    }));
    expect(proposal.decisions.map(decision => [decision.text, decision.status])).toEqual([
      ['Ship X:\n• in EU first\n• then US', 'unresolved'], ['Keep the freeze.', 'decided'],
    ]);
    expect(proposal.decisions[0]!.quotes).toEqual(['Mina said “ship it”\n• Next item\n\nActions\nmore']);
    expect(proposal.actions.map(action => action.text)).toEqual(['Write the plan:\n• scope\n• dates']);
  });

  // Since meetings are cited by numbered units, every signal has at least one quote, one per unit it cites: a
  // transcript turn without its "Label: ", a note line without its list marker, or a sentence-packed part.
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

  it('reads nothing from a text that is not a proposal, so the card shows it as written', () => {
    const proposal = readProposal('Pilot planning\nDecisions\nLaunch the pilot next week.');
    expect(proposalRead(proposal)).toBe(false);
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
