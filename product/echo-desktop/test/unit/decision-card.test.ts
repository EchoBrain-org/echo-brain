// The decision page as it shows (per-item routing v1): called as a function, its hooks holding nothing.
import { describe, expect, it, vi } from 'vitest';
import type { PersonRunV1 } from '@echo-brain/organization-api';
import type { DecisionState, State } from '../../src/renderer/store.js';
import { byTestId, elements, plainHooks, render, text, type Node } from './harness.js';

vi.mock('../../src/renderer/api.js', () => ({ rpc: vi.fn(), dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));

const THERM = 'prj_11111111-1111-4111-8111-111111111111';
const ECHO = 'prj_22222222-2222-4222-8222-222222222222';
const SUPPLIER = 'prj_44444444-4444-4444-8444-444444444444';
const project = (project_id: string, name: string) => ({ project_id, name, role: 'member' as const, created_at: '2026-10-01T00:00:00.000Z', status: 'active' as const });
const items = [
  { signal_id: 'dec-1', kind: 'decision' as const, text: 'Launch the pilot next week.', subject: null, status: 'decided' as const, due_at: null,
    quotes: ['[09:02] Ari: Let\'s launch it.'], owner: null, owner_editable: false, project_ids: [THERM] },
  { signal_id: 'dec-2', kind: 'decision' as const, text: 'Keep the freeze.', subject: null, status: 'proposed' as const, due_at: null, quotes: [], owner: null, owner_editable: false,
    project_ids: [THERM] },
  { signal_id: 'act-1', kind: 'action' as const, text: 'Send the revised quote', subject: null, status: null, due_at: null, quotes: [], owner: 'Rafael Moreno', owner_editable: true,
    project_ids: [THERM] },
];
const review = { approval_id: 'apr_' + 'a'.repeat(64), title: 'Pilot planning', project_ids: [], status: 'pending' as const, decided_on: null, first_line: null,
  action_count: 1, meeting_at: null as string | null, all_day: false, records: [] };
const open = { review, snapshot_sha256: 'sha256:' + 'b'.repeat(64), participants: ['Ari', 'Mina Patel'], items, suggested_projects: [{ project_id: THERM, name: 'THERM' }],
  reasons: [{ signal_id: 'why-1', text: 'The freeze lifts on Friday.', supports: ['dec-1'], quotes: [] }], records: [] };
const decision = (patch: Partial<DecisionState> = {}): DecisionState => ({
  approval_id: review.approval_id, seq: 1, loading: false, open, command: 'command-1', busy: false, runs: [], lines: {},
  routes: { 'dec-1': [THERM], 'dec-2': [THERM], 'act-1': [THERM] }, owners: { 'act-1': 'Rafael Moreno' }, ...patch,
});
const run = (id: string, event_ref: string, state: PersonRunV1['state']): PersonRunV1 => ({ run_id: `run_00000000-0000-4000-8000-0000000000${id}`, trigger: 'approved_record',
  event_ref, state, error_code: state === 'failed' ? 'research_failed' : null, created_at: '2026-10-08T10:00:00.000Z', updated_at: '2026-10-08T10:05:00.000Z' });

async function page(value: DecisionState): Promise<Node> {
  const { getState } = await import('../../src/renderer/store.js');
  const { Decision } = await import('../../src/renderer/screens/decision.js');
  const state: State = { ...getState(), projects: { ...getState().projects, items: [project(THERM, 'THERM'), project(ECHO, 'ECHO'), project(SUPPLIER, 'SUPPLIER')] } };
  return render(Decision({ state, decision: value })) as Node;
}
const chips = (tree: Node) => byTestId(tree, 'route-chip').map(node => text(node));

describe('the decision card', () => {
  it('gives every decision and action a destination chip, and one control for all of them, with where they go in a line', async () => {
    const tree = await page(decision());
    expect(chips(tree)).toEqual(['THERM', 'THERM', 'THERM']);
    expect(byTestId(tree, 'route-chip').map(node => node.props['aria-label'])).toEqual([
      'Where it goes: Launch the pilot next week.: THERM', 'Where it goes: Keep the freeze.: THERM', 'Where it goes: Send the revised quote: THERM']);
    expect(text(byTestId(tree, 'route-all')[0])).toBe('THERM');
    expect(text(byTestId(tree, 'route-summary')[0])).toBe('3 to THERM');
    expect(byTestId(tree, 'decision-approve')[0]!.props.disabled).toBe(false);
    // The transcript is never shared from the card, and Seen by is gone; reasons stay, read-only.
    expect(text(tree)).not.toMatch(/transcript|Seen by/i);
    expect(text(tree)).toContain('Why · 1 reason from the meeting');
    expect(text(tree)).toContain('In the meeting · 2');
  });

  it('labels a destination by its first project and how many more, Only me, or Not kept; the control says Mixed when kept items differ', async () => {
    const tree = await page(decision({ routes: { 'dec-1': [ECHO, THERM].sort(), 'dec-2': [], 'act-1': null } }));
    expect(chips(tree)).toEqual(['THERM +1', 'Only me', 'Not kept']);
    expect(text(byTestId(tree, 'route-all')[0])).toBe('Mixed');
    expect(text(byTestId(tree, 'route-summary')[0])).toBe('1 to THERM +1 · 1 to Only me · 1 not kept');
    // An action not kept sends no owner, so its owner cannot be changed.
    const owner = elements(tree).find(node => node.props['aria-label'] === 'Owner for: Send the revised quote')!;
    expect(owner.props.disabled).toBe(true);
    const { destinationLabel } = await import('../../src/renderer/screens/decision.js');
    expect(destinationLabel([THERM], new Map())).toBe('A project');
  });

  it('counts the summary by destination, so two that read alike stay apart, and never shows Mixed as not kept', async () => {
    const tree = await page(decision({ routes: { 'dec-1': [THERM, ECHO], 'dec-2': [THERM, SUPPLIER], 'act-1': [THERM, ECHO] } }));
    expect(chips(tree)).toEqual(['THERM +1', 'THERM +1', 'THERM +1']);
    expect(text(byTestId(tree, 'route-summary')[0])).toBe('2 to THERM +1 · 1 to THERM +1');
    // Items are kept: Mixed is not the faint Not kept control.
    const all = byTestId(tree, 'route-all')[0]!;
    expect(text(all)).toBe('Mixed');
    expect(all.props.class).toBe('route-chip');
    expect(byTestId(await page(decision({ routes: { 'dec-1': null, 'dec-2': null, 'act-1': null } })), 'route-all')[0]!.props.class).toBe('route-chip dropped');
  });

  it('says why a decision could not be opened', async () => {
    expect(text(await page(decision({ open: null, failure: 'ECHO is unavailable right now. Try again.' })))).toBe('ECHO is unavailable right now. Try again.');
  });

  it('cannot approve when nothing is kept', async () => {
    const tree = await page(decision({ routes: { 'dec-1': null, 'dec-2': null, 'act-1': null } }));
    expect(text(byTestId(tree, 'route-all')[0])).toBe('Not kept');
    expect(byTestId(tree, 'decision-approve')[0]!.props.disabled).toBe(true);
    expect(byTestId(tree, 'decision-reject')[0]!.props.disabled).toBe(false);
  });

  it('heads a whole day\'s card with its UTC date alone, the same day in any time zone, and a timed meeting\'s with its time', async () => {
    const top = (tree: Node) => text(elements(tree).find(node => node.props.class === 'card-top'));
    // A meeting tool's all-day event is midnight UTC and a pasted day noon UTC: both are Oct 21, wherever this computer is.
    for (const meeting_at of ['2026-10-21T00:00:00.000Z', '2026-10-21T12:00:00.000Z']) {
      expect(top(await page(decision({ open: { ...open, review: { ...review, meeting_at, all_day: true } } })))).toBe('Approve· Meeting · Oct 21');
    }
    expect(top(await page(decision({ open: { ...open, review: { ...review, meeting_at: '2026-10-21T16:30:00.000Z' } } })))).toMatch(/^Approve· Meeting · Oct 2\d, .*:30/);
    expect(top(await page(decision()))).toBe('Approve· Meeting');
  });

  it('locks every chip while a decision may be on its way', async () => {
    const tree = await page(decision({ unknown: true }));
    expect([...byTestId(tree, 'route-chip'), ...byTestId(tree, 'route-all')].every(node => node.props.disabled === true)).toBe(true);
  });

  it('shows each destination of an approved meeting with its own check, then the items where they went', async () => {
    const records = [{ approval_id: 'apr_' + '1'.repeat(64), project_ids: [THERM] }, { approval_id: 'apr_' + '2'.repeat(64), project_ids: [] }];
    const decided = { ...open, review: { ...review, status: 'approved' as const, decided_on: 'desktop' as const, records }, records,
      items: [{ ...items[0]!, project_ids: [THERM] }, { ...items[1]!, project_ids: null }, { ...items[2]!, owner: 'R. Moreno', owner_editable: false, project_ids: [] }] };
    const tree = await page(decision({ open: decided, runs: [run('41', records[0]!.approval_id, 'done'), run('42', records[1]!.approval_id, 'failed')],
      lines: { 'run_00000000-0000-4000-8000-000000000041': { summary: { unsent: 2, open: 0, done: 0, not_relevant: 0, landed: 0, changed: 0, unreadable: 0, decisions: 1,
        last_checked_at: null, by_decision: [] }, stage: null } } }));
    const impacts = elements(tree).filter(node => node.props.class === 'impact');
    expect(impacts.map(node => node.props['aria-label'])).toEqual(['Impact · THERM', 'Impact · Only me']);
    expect(text(impacts[0])).toContain('Follow-ups');
    expect(text(impacts[1])).toContain('Try again');
    expect(byTestId(tree, 'route-final').map(node => text(node))).toEqual(['THERM', 'Not kept', 'Only me']);
    expect(text(tree)).toContain('R. Moreno');
    expect(text(tree)).toContain('The check did not finish');
    expect(byTestId(tree, 'route-chip')).toEqual([]);
  });
});

describe('the project picker', () => {
  it('part-ticks a project only some items have, and once the meeting names its most, offers only the projects it names', async () => {
    const { ProjectPicker } = await import('../../src/renderer/screens/project-picker.js');
    const projects = [project(THERM, 'THERM'), project(ECHO, 'ECHO'), project(SUPPLIER, 'SUPPLIER')];
    const picker = (props: { ticked: readonly string[]; partly?: readonly string[]; named?: readonly string[] }) =>
      render(ProjectPicker({ projects, onTick: () => undefined, onMore: () => undefined, more: false, max: 2, ...props }));
    const boxes = (tree: unknown) => elements(tree).filter(node => node.type === 'input')
      .map(node => ({ checked: node.props.checked, indeterminate: node.props.indeterminate, disabled: node.props.disabled }));
    // All items, Mixed: THERM on every kept item, ECHO on some. The two are the most here, so SUPPLIER would be one too many.
    const all = picker({ ticked: [THERM], partly: [ECHO], named: [THERM, ECHO] });
    expect(boxes(all)).toEqual([{ checked: true, indeterminate: false, disabled: false }, { checked: false, indeterminate: true, disabled: false },
      { checked: false, indeterminate: false, disabled: true }]);
    expect(text(byTestId(all, 'projects-limit')[0])).toBe('Up to 2 projects.');
    // One item's chip, nothing ticked on it: the projects other items name stay open to it.
    expect(boxes(picker({ ticked: [], named: [THERM, ECHO] })).map(box => box.disabled)).toEqual([false, false, true]);
    // Counting its own ticks alone (Capture), a free place leaves every project open.
    const own = picker({ ticked: [THERM] });
    expect(boxes(own).map(box => box.disabled)).toEqual([false, false, false]);
    expect(byTestId(own, 'projects-limit')).toEqual([]);
  });
});

describe('saidLines', () => {
  it('splits a quote into who said what, joining a line without a speaker to the one before it', async () => {
    const { saidLines } = await import('../../src/renderer/screens/card.js');
    expect(saidLines('The gate itself is still on hold.\n\n[09:01] Jonas Becker: Increasing the buffer\nis the quickest experiment.\n[09:01:30] Tomas Okafor: Experiment, yes.')).toEqual([
      { time: null, speaker: null, text: 'The gate itself is still on hold.' },
      { time: '09:01', speaker: 'Jonas Becker', text: 'Increasing the buffer is the quickest experiment.' },
      { time: '09:01:30', speaker: 'Tomas Okafor', text: 'Experiment, yes.' },
    ]);
  });

  it('takes a speaker whose words start on the next line, and keeps a paragraph after a blank line apart', async () => {
    const { saidLines } = await import('../../src/renderer/screens/card.js');
    expect(saidLines('[09:01] Jonas: Hi\n[09:02] Mina:\nAgreed.\n\nA note on its own.')).toEqual([
      { time: '09:01', speaker: 'Jonas', text: 'Hi' },
      { time: '09:02', speaker: 'Mina', text: 'Agreed.' },
      { time: null, speaker: null, text: 'A note on its own.' },
    ]);
  });
});
