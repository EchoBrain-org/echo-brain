// Home's altitudes on the page (Home altitude v1): the stops, My projects grouped by health with what needs attention and how
// long it waited, a project's decisions and owners, a person's follow-ups by project, and Me as Home has always been.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AltitudeState, ProjectRead, State } from '../../src/renderer/store.js';
import type { OpenItemView, ProjectSummary } from '../../src/shared/protocol.js';
import { ACCOUNT, byTestId, elements, EMPTY_SUMMARY, plainHooks, project, render, text } from './harness.js';

vi.mock('../../src/renderer/api.js', () => ({ rpc: vi.fn(), dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const THERMAL = project(1, 30, { name: 'Thermal' });
const CERT = project(2, 29, { name: 'Certification' });
const PACKAGING = project(3, 28, { name: 'Packaging' });
const BROKEN = project(4, 27, { name: 'Battery pack' });
const person = (name: string) => ({ membership_id: `mem_${name.split(' ')[0]!.toLowerCase()}`, name, active: true });

function item(id: string, of: ProjectSummary, extra: Partial<OpenItemView> & { days?: number; owner_name?: string } = {}): OpenItemView {
  const { days = 0, owner_name = 'Mina Patel', ...rest } = extra;
  return {
    item_id: `itm_${id}`, run_id: 'run_1', kind: 'action',
    decision: { approval_id: 'apr_1', record_sha256: `sha256:${of.name}`, title: `${of.name} sync`, first_line: null, approved_at: ago(10), project_ids: [of.project_id] },
    relation: null, expected: `Follow-up ${id}`, approver: person('Lin Chen'), owner: { ...person(owner_name), match: 'name' }, waits_on: 'owner', state: 'open',
    created_at: ago(days), sent_at: ago(days), state_set_at: ago(days), state_set_by: person('Lin Chen'), owner_set_at: null, owner_set_by: null,
    send_included: true, check: null, can: { set_state: true, assign: true }, reach: 'not_read', ...rest,
  };
}
const read = (active: OpenItemView[], extra: Partial<ProjectRead> = {}): ProjectRead => ({
  loading: false, counts: { ...EMPTY_SUMMARY, open: active.length }, active, all: null, reading: false, ...extra,
});

async function stateWith(altitude: Partial<AltitudeState>, projects: ProjectSummary[] = [THERMAL, CERT, PACKAGING], list: Partial<State['projects']> = {}): Promise<State> {
  const { getState } = await import('../../src/renderer/store.js');
  return {
    ...getState(), status: { client_version: 'test', signed_in: true, account: ACCOUNT },
    projects: { items: projects, next: null, loading: false, ...list },
    home: { seq: 1, loading: false, meetings: true, reviews: [], runs: [], open: null, live: {}, reading: false },
    altitude: { level: 'projects', project_id: null, membership_id: null, name: null, reads: {}, live: {}, list: null, settled: true, reading: false, ...altitude },
  };
}

const READS = {
  [THERMAL.project_id]: read([item('t1', THERMAL, { days: 9, kind: 'ticket' }), item('t2', THERMAL, { days: 4, owner_name: 'Rafael Moreno' }),
    item('t3', THERMAL, { owner: { ...person('Lin Chen'), match: 'approver' } })]),
  [CERT.project_id]: read([item('c1', CERT, { days: 4 })]),
  [PACKAGING.project_id]: read([item('p1', PACKAGING)], { counts: { ...EMPTY_SUMMARY, open: 1, done: 3 } }),
};

beforeEach(() => { vi.useFakeTimers({ now: NOW }); });

describe('the stops', () => {
  it('on Me, light Me and leave the project and person stops off until Home has zoomed on one', async () => {
    const { Stops } = await import('../../src/renderer/screens/altitude.js');
    const tree = render(Stops({ state: await stateWith({ level: 'me' }) }));
    expect(byTestId(tree, 'alt-me')[0]!.props['aria-pressed']).toBe(true);
    const stops = byTestId(tree, 'alt-stop');
    expect(stops.map(stop => [stop.props['data-level'], stop.props.disabled ?? false])).toEqual([['projects', false], ['project', true], ['person', true]]);
  });

  it('name the project and person Home last zoomed on', async () => {
    const { Stops } = await import('../../src/renderer/screens/altitude.js');
    const tree = render(Stops({ state: await stateWith({ level: 'project', project_id: THERMAL.project_id, membership_id: 'mem_mina', name: 'Mina Patel' }) }));
    expect(byTestId(tree, 'alt-stop').map(stop => stop.props['aria-label'])).toEqual(['My projects', 'Project, Thermal', 'Person, Mina Patel']);
  });
});

describe('My projects', () => {
  it('groups projects off track, at risk, then on track, each with what needs attention and its longest wait', async () => {
    const { MyProjects } = await import('../../src/renderer/screens/altitude.js');
    const tree = render(MyProjects({ state: await stateWith({ reads: READS }) }));
    expect(byTestId(tree, 'alt-group-head').map(text)).toEqual(['Off track1', 'At risk1', 'On track1']);
    const rows = byTestId(tree, 'alt-project');
    expect(rows.map(row => row.props['data-project'])).toEqual([THERMAL.project_id, CERT.project_id, PACKAGING.project_id]);
    const thermal = text(rows[0]);
    expect(thermal).toContain('Thermal');
    expect(thermal).toContain('3');
    expect(thermal).toContain('9d');
    expect(rows[2]!.props['aria-label']).toBe('Packaging, On track');
    expect(text(rows[2])).toContain('75%');
  });

  it('shows a project it could not read as unread, never on track', async () => {
    const { MyProjects } = await import('../../src/renderer/screens/altitude.js');
    const reads = { ...READS, [BROKEN.project_id]: { ...read([]), failure: { code: 'unavailable', retryable: true } } };
    const tree = render(MyProjects({ state: await stateWith({ reads }, [THERMAL, CERT, PACKAGING, BROKEN]) }));
    const broken = byTestId(tree, 'alt-project').find(row => row.props['data-project'] === BROKEN.project_id)!;
    expect(broken.props['aria-label']).toBe('Battery pack, Couldn’t read just now');
    expect(elements(broken).some(node => node.props.title === 'Couldn’t read just now')).toBe(true);
  });

  it('with no projects, offers a new one', async () => {
    const { MyProjects } = await import('../../src/renderer/screens/altitude.js');
    expect(byTestId(render(MyProjects({ state: await stateWith({}, []) })), 'empty-new-project')).toHaveLength(1);
  });
});

describe('a project', () => {
  it('shows its decisions, then its owners needing attention first, and no owner as a group that does not zoom', async () => {
    const { ProjectLevel } = await import('../../src/renderer/screens/altitude.js');
    const tree = render(ProjectLevel({ state: await stateWith({ level: 'project', project_id: THERMAL.project_id, reads: READS }) }));
    expect(byTestId(tree, 'alt-group').map(group => group.props['data-group'])).toEqual(['decisions', 'mem_mina', 'none', 'mem_rafael']);
    const owners = byTestId(tree, 'alt-owner');
    expect(owners.map(owner => owner.props['data-zoom'])).toEqual(['person:mem_mina', undefined, 'person:mem_rafael']);
    expect(owners[1]!.type).not.toBe('button');
    expect(byTestId(tree, 'alt-decision').map(text).join()).toContain('Thermal sync');
  });

  it('says what each follow-up is: a Jira ticket, a meeting action', async () => {
    const { ProjectLevel } = await import('../../src/renderer/screens/altitude.js');
    const tree = render(ProjectLevel({ state: await stateWith({ level: 'project', project_id: THERMAL.project_id, reads: READS }) }));
    const kinds = byTestId(tree, 'alt-item').map(row => elements(row).find(node => node.props['data-kind'] !== undefined)!.props.title);
    expect(kinds).toContain('Jira ticket');
    expect(kinds).toContain('Meeting action');
  });
});

describe('a person', () => {
  it('shows their follow-ups project by project, each project zooming in', async () => {
    const { PersonLevel } = await import('../../src/renderer/screens/altitude.js');
    const tree = render(PersonLevel({ state: await stateWith({ level: 'person', membership_id: 'mem_mina', name: 'Mina Patel', reads: READS }) }));
    expect(byTestId(tree, 'alt-group').map(group => group.props['data-group'])).toEqual([THERMAL.project_id, CERT.project_id, PACKAGING.project_id]);
    expect(byTestId(tree, 'alt-project-head').map(head => head.props['data-zoom'])).toEqual(
      [THERMAL.project_id, CERT.project_id, PACKAGING.project_id].map(id => `project:${id}`));
    expect(byTestId(tree, 'alt-item')).toHaveLength(3);
  });
});

describe('Home', () => {
  it('on Me is Needs you, as it has always been, under the stops', async () => {
    const { Home } = await import('../../src/renderer/screens/home.js');
    const tree = render(Home({ state: await stateWith({ level: 'me' }) }));
    expect(byTestId(tree, 'alt-stops')).toHaveLength(1);
    expect(byTestId(tree, 'needs')).toHaveLength(1);
    expect(byTestId(tree, 'alt-projects')).toHaveLength(0);
  });

  it('zoomed out shows My projects in place of Needs you', async () => {
    const { Home } = await import('../../src/renderer/screens/home.js');
    const tree = render(Home({ state: await stateWith({ reads: READS }) }));
    expect(byTestId(tree, 'alt-projects')).toHaveLength(1);
    expect(byTestId(tree, 'needs')).toHaveLength(0);
  });
});

describe('what the altitudes say while reading, and when a read fails', () => {
  it('a project header never says On track or 100% before its project is read, or when the read failed', async () => {
    const { ProjectLevel } = await import('../../src/renderer/screens/altitude.js');
    const reading = text(render(ProjectLevel({ state: await stateWith({ level: 'project', project_id: THERMAL.project_id, reads: {} }) })));
    expect(reading).toContain('Reading');
    expect(reading).not.toContain('On track');
    expect(reading).not.toContain('100%');
    const failed = { [THERMAL.project_id]: { ...read([]), counts: null, failure: { code: 'unavailable', retryable: true } } };
    const unread = text(render(ProjectLevel({ state: await stateWith({ level: 'project', project_id: THERMAL.project_id, reads: failed }) })));
    expect(unread).toContain('Couldn’t read just now');
    expect(unread).not.toContain('On track');
    expect(unread).not.toContain('100%');
  });

  it('a person says nothing is waiting only once every project has been read', async () => {
    const { PersonLevel } = await import('../../src/renderer/screens/altitude.js');
    const someone = { level: 'person' as const, membership_id: 'mem_nobody', name: 'Nobody Here' };
    const loading = { ...READS, [CERT.project_id]: read([], { loading: true, counts: null }) };
    expect(text(render(PersonLevel({ state: await stateWith({ ...someone, reads: loading }) })))).not.toContain('Nothing of theirs is waiting');
    const failed = { ...READS, [CERT.project_id]: { ...read([]), failure: { code: 'unavailable', retryable: true } } };
    expect(text(render(PersonLevel({ state: await stateWith({ ...someone, reads: failed }) })))).toContain('Couldn’t read every project just now');
    expect(text(render(PersonLevel({ state: await stateWith({ ...someone, reads: READS }) })))).toContain('Nothing of theirs is waiting');
  });

  it('a title waits faintly only while its live read is on its way', async () => {
    const { ProjectLevel } = await import('../../src/renderer/screens/altitude.js');
    const done = item('d1', THERMAL, { kind: 'ticket', state: 'done' });
    const open = item('o1', THERMAL, { kind: 'ticket' });
    const faint = async (reading: boolean) => elements(render(ProjectLevel({ state: await stateWith({
      level: 'project', project_id: THERMAL.project_id, reads: { [THERMAL.project_id]: read([open], { all: [open, done], reading }) } }) })))
      .filter(node => node.props.class === 'reading-title').length;
    expect(await faint(true)).toBe(1);
    expect(await faint(false)).toBe(0);
  });

  it('a person shows only what is waiting, even for a project whose done follow-ups were read', async () => {
    const { PersonLevel } = await import('../../src/renderer/screens/altitude.js');
    const closed = item('x1', THERMAL, { state: 'done' });
    const reads = { ...READS, [THERMAL.project_id]: { ...READS[THERMAL.project_id]!, all: [...READS[THERMAL.project_id]!.active, closed] } };
    const tree = render(PersonLevel({ state: await stateWith({ level: 'person', membership_id: 'mem_mina', name: 'Mina Patel', reads }) }));
    expect(byTestId(tree, 'alt-item').map(row => row.props['data-item'])).not.toContain('itm_x1');
  });

  it('a person’s header counts a follow-up filed in two projects once', async () => {
    const { PersonLevel } = await import('../../src/renderer/screens/altitude.js');
    const shared = item('s1', THERMAL, { days: 5 });
    const reads = { [THERMAL.project_id]: read([shared]), [CERT.project_id]: read([shared]), [PACKAGING.project_id]: read([]) };
    const tree = render(PersonLevel({ state: await stateWith({ level: 'person', membership_id: 'mem_mina', name: 'Mina Patel', reads }) }));
    expect(byTestId(tree, 'alt-chip').map(text)).toEqual(['1', '1']);
  });
});

describe('My projects on first open, and without a list', () => {
  it('keeps the list’s order, ungrouped, until the first reads settle', async () => {
    const { MyProjects } = await import('../../src/renderer/screens/altitude.js');
    const tree = render(MyProjects({ state: await stateWith({ reads: READS, settled: false }, [PACKAGING, THERMAL, CERT]) }));
    expect(byTestId(tree, 'alt-group-head')).toHaveLength(0);
    expect(byTestId(tree, 'alt-project').map(row => row.props['data-project'])).toEqual([PACKAGING.project_id, THERMAL.project_id, CERT.project_id]);
  });

  it('does not offer a new project when your projects could not be read', async () => {
    const { MyProjects } = await import('../../src/renderer/screens/altitude.js');
    const tree = render(MyProjects({ state: await stateWith({}, [], { failure: { code: 'unavailable', retryable: true } }) }));
    expect(byTestId(tree, 'empty-new-project')).toHaveLength(0);
    expect(text(tree)).toContain('Couldn’t read your projects just now');
  });

  it('opens with its name and how many projects are off track, at risk and on track', async () => {
    const { MyProjects } = await import('../../src/renderer/screens/altitude.js');
    const tree = render(MyProjects({ state: await stateWith({ reads: READS }) }));
    const head = byTestId(tree, 'alt-head')[0]!;
    expect(text(head)).toContain('My projects');
    expect(byTestId(head, 'alt-chip').map(chip => chip.props.title)).toEqual(['1 off track', '1 at risk', '1 on track']);
  });
});

