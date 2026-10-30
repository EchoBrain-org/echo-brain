// Home's altitudes on the page (Home altitude v1, One place to look v1): the stops; Home's top, with what needs you by kind
// above your projects, each with a mark only when it is not on track, why, how much is done and how long its oldest waited;
// one kind's list; a project's decisions and owners; and a person's follow-ups by project.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonMeetingReviewV2 } from '@echo-brain/organization-api';
import type { AltitudeState, ProjectRead, State } from '../../src/renderer/store.js';
import type { HomeView, OpenItemView, ProjectSummary } from '../../src/shared/protocol.js';
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

async function stateWith(altitude: Partial<AltitudeState>, projects: ProjectSummary[] = [THERMAL, CERT, PACKAGING], list: Partial<State['projects']> = {},
  home: Partial<NonNullable<State['home']>> = {}): Promise<State> {
  const { getState } = await import('../../src/renderer/store.js');
  return {
    ...getState(), status: { client_version: 'test', signed_in: true, account: ACCOUNT },
    projects: { items: projects, next: null, loading: false, ...list },
    home: { seq: 1, loading: false, meetings: true, reviews: [], runs: [], open: null, live: {}, reading: false, ...home },
    altitude: { level: 'projects', category: null, project_id: null, membership_id: null, name: null, reads: {}, live: {}, list: null, settled: true, reading: false,
      listFailure: null, listStale: false, ...altitude },
  };
}

/** A meeting waiting for you to approve it. */
const meeting = (title: string, meeting_at: string | null = null): PersonMeetingReviewV2 => ({
  approval_id: `apr_${title.toLowerCase().replace(/\W/g, '')}`, title, project_ids: [], status: 'pending', decided_on: null, first_line: `${title} decided.`,
  action_count: 1, meeting_at, all_day: false, records: [],
});
/** What waits on you: these follow-ups, yours to update. */
const waiting = (items: OpenItemView[]): HomeView => ({ send: [], items, landed: 0, waiting: 0, last_checked_at: null, sweep_due: false });

const READS = {
  [THERMAL.project_id]: read([item('t1', THERMAL, { days: 9, kind: 'ticket' }), item('t2', THERMAL, { days: 4, owner_name: 'Rafael Moreno' }),
    item('t3', THERMAL, { owner: { ...person('Lin Chen'), match: 'approver' } })]),
  [CERT.project_id]: read([item('c1', CERT, { days: 4 })]),
  [PACKAGING.project_id]: read([item('p1', PACKAGING)], { counts: { ...EMPTY_SUMMARY, open: 1, done: 3 } }),
};

beforeEach(() => { vi.useFakeTimers({ now: NOW }); });

describe('the stops', () => {
  it('at the top light My projects, a kind’s list open or not, with no Me; the project and person stops stay off until Home has zoomed on one', async () => {
    const { Stops } = await import('../../src/renderer/screens/altitude.js');
    for (const category of [null, 'update'] as const) {
      const tree = render(Stops({ state: await stateWith({ category }) }));
      expect(byTestId(tree, 'alt-me')).toHaveLength(0);
      const stops = byTestId(tree, 'alt-stop');
      expect(stops.map(stop => [stop.props['data-level'], stop.props['aria-pressed'], stop.props.disabled ?? false]))
        .toEqual([['projects', true, false], ['project', false, true], ['person', false, true]]);
      expect(text(tree)).toBe('My projects');
    }
  });

  it('name the project and person Home last zoomed on', async () => {
    const { Stops } = await import('../../src/renderer/screens/altitude.js');
    const tree = render(Stops({ state: await stateWith({ level: 'project', project_id: THERMAL.project_id, membership_id: 'mem_mina', name: 'Mina Patel' }) }));
    expect(byTestId(tree, 'alt-stop').map(stop => stop.props['aria-label'])).toEqual(['My projects', 'Project, Thermal', 'Person, Mina Patel']);
  });
});

describe('My projects', () => {
  /** A row's part, by its class. */
  const part = (row: unknown, name: string) => elements(row).find(node => node.props.class === name);

  it('puts projects off track, at risk, then on track: a mark only when not on track, why, a grey bar of what is done, and the oldest wait', async () => {
    const { MyProjects } = await import('../../src/renderer/screens/altitude.js');
    const tree = render(MyProjects({ state: await stateWith({ reads: READS }) }));
    expect(text(byTestId(tree, 'alt-projects-head')[0])).toBe('Projects');
    // One flat list: order carries the grouping, with no health chips or group bars.
    expect(byTestId(tree, 'alt-group-head')).toHaveLength(0);
    expect(byTestId(tree, 'alt-chip')).toHaveLength(0);
    const rows = byTestId(tree, 'alt-project');
    expect(rows.map(row => row.props['data-project'])).toEqual([THERMAL.project_id, CERT.project_id, PACKAGING.project_id]);
    expect(rows.map(row => row.props['aria-label'])).toEqual(['Thermal, Off track', 'Certification, At risk', 'Packaging, On track']);
    // A solid dot off track, a ring at risk, nothing on track.
    expect(rows.map(row => elements(row).find(node => typeof node.props.class === 'string' && node.props.class.startsWith('health-mark'))?.props.class ?? null))
      .toEqual(['health-mark off', 'health-mark risk', null]);
    // Why, faint, only when not on track: the follow-up needing attention that waited longest, and whose it is.
    expect(text(part(rows[0], 'alt-reason'))).toBe('Jira ticket · Thermal sync · Mina Patel');
    expect(text(part(rows[1], 'alt-reason'))).toBe('Follow-up c1 · Mina Patel');
    expect(part(rows[2], 'alt-reason')).toBeUndefined();
    // Done out of every follow-up, as a grey bar with its words on hover; no percentage.
    expect(part(rows[2], 'alt-bar')!.props.title).toBe('3 of 4 follow-ups done');
    expect(elements(part(rows[2], 'alt-bar')).find(node => node.type === 'i')!.props.style).toEqual({ width: '75%' });
    expect(text(rows[2])).not.toContain('%');
    expect(rows.map(row => text(part(row, 'alt-date')))).toEqual(['9d', '4d', '0d']);
  });

  it('names the reason as Home’s own live read of it does, when Home has one', async () => {
    const { MyProjects } = await import('../../src/renderer/screens/altitude.js');
    const t1 = READS[THERMAL.project_id]!.active[0]!;
    const current = { source: { kind: 'ticket' as const, tool_id: 'jira', label: 'ECHO-61 · Fan curve', permalink: 'https://example.atlassian.net/browse/ECHO-61' },
      says_now: 'Peak at 60%.' };
    const state = await stateWith({ reads: READS }, undefined, {}, { live: { [t1.item_id]: { reach: 'opened', current } } });
    const [thermal] = byTestId(render(MyProjects({ state })), 'alt-project');
    expect(text(part(thermal, 'alt-reason'))).toBe('ECHO-61 · Fan curve · Mina Patel');
  });

  it('says no owner when nobody owns the reason, and draws no bar for a project with no follow-ups', async () => {
    const { MyProjects } = await import('../../src/renderer/screens/altitude.js');
    const nobodys = item('n1', THERMAL, { kind: 'action', expected: 'Heat-sink sourcing', owner: { ...person('Lin Chen'), match: 'approver' } });
    const reads = { [THERMAL.project_id]: read([nobodys]), [CERT.project_id]: read([], { counts: EMPTY_SUMMARY }) };
    const rows = byTestId(render(MyProjects({ state: await stateWith({ reads }, [THERMAL, CERT]) })), 'alt-project');
    expect(text(part(rows[0], 'alt-reason'))).toBe('Heat-sink sourcing · no owner');
    expect(part(rows[1], 'alt-bar')).toBeUndefined();
    expect(text(part(rows[1], 'alt-date'))).toBe('');
  });

  it('shows a project it could not read as unread, never on track', async () => {
    const { MyProjects } = await import('../../src/renderer/screens/altitude.js');
    const reads = { ...READS, [BROKEN.project_id]: { ...read([]), failure: { code: 'unavailable', retryable: true } } };
    const tree = render(MyProjects({ state: await stateWith({ reads }, [THERMAL, CERT, PACKAGING, BROKEN]) }));
    const broken = byTestId(tree, 'alt-project').find(row => row.props['data-project'] === BROKEN.project_id)!;
    expect(broken.props['aria-label']).toBe('Battery pack, Couldn’t read just now');
    expect(elements(broken).some(node => node.props.title === 'Couldn’t read just now')).toBe(true);
    // Its faint ring, never a health mark, and last.
    expect(elements(broken).some(node => node.props.class === 'ring-mark')).toBe(true);
    expect(byTestId(tree, 'alt-project').at(-1)).toBe(broken);
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
  /** Home's top, or a kind's list, as it shows. */
  const home = async (altitude: Partial<AltitudeState>, homePart: Partial<NonNullable<State['home']>>, projects?: ProjectSummary[]) => {
    const { Home } = await import('../../src/renderer/screens/home.js');
    return render(Home({ state: await stateWith({ reads: READS, ...altitude }, projects, {}, homePart) }));
  };

  it('at its top shows what needs you above your projects, with no stops (they are in the title row) and no footer', async () => {
    const tree = await home({}, { open: waiting([item('u1', THERMAL)]) });
    const parts = elements(tree).map(node => node.props['data-testid']).filter(id => id === 'needs' || id === 'alt-projects');
    expect(parts).toEqual(['needs', 'alt-projects']);
    expect(text(byTestId(tree, 'needs-head')[0])).toBe('Needs you1');
    expect(byTestId(tree, 'alt-stops')).toHaveLength(0);
    for (const gone of ['needs-foot', 'your-follow-ups', 'home-only-me']) expect(byTestId(tree, gone)).toHaveLength(0);
  });

  it('shows a kind with one row as that row, and a kind with two or more as one line that opens its list', async () => {
    const tree = await home({}, { reviews: [meeting('Supplier sync', ago(0.1)), meeting('Weekly standup')], open: waiting([item('u1', THERMAL, { days: 2 })]) });
    // The one Update is its row, as it has always been; the two meetings to approve are one line.
    expect(byTestId(tree, 'need-row').map(row => row.props['data-kind'])).toEqual(['update']);
    const [line] = byTestId(tree, 'need-category');
    expect(line!.type).toBe('button');
    expect(line!.props['data-category']).toBe('approve');
    expect(line!.props.title).toBe('See all 2 to approve');
    // Its verb and count, the newest's name, how many more, and how long ago the newest met.
    expect(text(line)).toBe('Approve2Supplier syncand 1 more2h');
    // The badge's number: everything that waits on you.
    expect(text(byTestId(tree, 'needs-head')[0])).toBe('Needs you3');
    const { getState } = await import('../../src/renderer/store.js');
    (line!.props.onClick as () => void)();
    expect(getState().altitude.category).toBe('approve');
  });

  it('shows two checks on their way as one faint line that opens nothing, and never counts them', async () => {
    const checking = (title: string): PersonMeetingReviewV2 => ({ ...meeting(title), status: 'publishing', decided_on: 'desktop' });
    const tree = await home({}, { reviews: [checking('Supplier sync'), checking('Weekly standup')] });
    const [line] = byTestId(tree, 'need-category');
    expect(line!.type).toBe('div');
    expect(line!.props['data-category']).toBe('checking');
    expect(text(line)).toBe('CheckingSupplier syncand 1 more');
    expect(text(byTestId(tree, 'needs-head')[0])).toBe('Needs you');
  });

  it('says Nothing needs you in one quiet line, with your projects below it', async () => {
    const tree = await home({}, {});
    expect(text(byTestId(tree, 'home-clear')[0])).toBe('Nothing needs you');
    expect(byTestId(tree, 'needs-head')).toHaveLength(0);
    expect(byTestId(tree, 'alt-project')).toHaveLength(3);
  });

  it('with no projects and nothing waiting is the first run: New project, once', async () => {
    const tree = await home({}, {}, []);
    expect(byTestId(tree, 'home-empty')).toHaveLength(1);
    expect(byTestId(tree, 'empty-new-project')).toHaveLength(1);
    expect(byTestId(tree, 'needs')).toHaveLength(0);
  });

  it('zoomed into a kind shows its verb and count, then its rows newest first, in place of the top', async () => {
    const older = item('u1', THERMAL, { days: 3, expected: 'Older' }), newer = item('u2', CERT, { days: 1, expected: 'Newer' });
    const tree = await home({ category: 'update' }, { open: waiting([older, newer]) });
    const [list] = byTestId(tree, 'needs');
    expect(list!.props['data-category']).toBe('update');
    expect(text(byTestId(tree, 'need-list-head')[0])).toBe('Update2');
    expect(byTestId(tree, 'need-row').map(row => text(row))).toEqual([expect.stringContaining('Newer'), expect.stringContaining('Older')]);
    expect(byTestId(tree, 'alt-projects')).toHaveLength(0);
    expect(byTestId(tree, 'need-category')).toHaveLength(0);
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
  it('keeps the list’s order until the first reads settle', async () => {
    const { MyProjects } = await import('../../src/renderer/screens/altitude.js');
    const tree = render(MyProjects({ state: await stateWith({ reads: READS, settled: false }, [PACKAGING, THERMAL, CERT]) }));
    expect(byTestId(tree, 'alt-project').map(row => row.props['data-project'])).toEqual([PACKAGING.project_id, THERMAL.project_id, CERT.project_id]);
  });

  it('does not offer a new project when your projects could not be read', async () => {
    const { MyProjects } = await import('../../src/renderer/screens/altitude.js');
    const tree = render(MyProjects({ state: await stateWith({}, [], { failure: { code: 'unavailable', retryable: true } }) }));
    expect(byTestId(tree, 'empty-new-project')).toHaveLength(0);
    expect(text(tree)).toContain('Couldn’t read your projects just now');
  });

  it('within each health, puts first the project with most needing attention, then the longest wait', async () => {
    const { MyProjects } = await import('../../src/renderer/screens/altitude.js');
    const reads = { ...READS, [PACKAGING.project_id]: read([item('p1', PACKAGING, { days: 5 })]) };
    const tree = render(MyProjects({ state: await stateWith({ reads }) }));
    expect(byTestId(tree, 'alt-project').map(row => row.props['data-project'])).toEqual([THERMAL.project_id, PACKAGING.project_id, CERT.project_id]);
  });
});

describe('a long or unread list of projects', () => {
  it('names and opens the Project stop for a project past the sidebar’s first page', async () => {
    const { Stops } = await import('../../src/renderer/screens/altitude.js');
    const far = project(12, 19, { name: 'Far away' });
    const tree = render(Stops({ state: await stateWith({ level: 'project', project_id: far.project_id, list: [THERMAL, CERT, PACKAGING, far] },
      [THERMAL, CERT, PACKAGING], { next: 'more' }) }));
    const stop = byTestId(tree, 'alt-stop').find(each => each.props['data-level'] === 'project')!;
    expect(stop.props['aria-label']).toBe('Project, Far away');
    expect(stop.props.disabled).toBe(false);
  });

  it('a person says nothing is waiting only once your projects themselves are read', async () => {
    const { PersonLevel } = await import('../../src/renderer/screens/altitude.js');
    const someone = { level: 'person' as const, membership_id: 'mem_nobody', name: 'Nobody Here', reads: {} };
    expect(text(render(PersonLevel({ state: await stateWith(someone, [], { loading: true }) })))).not.toContain('Nothing of theirs is waiting');
    const failed = text(render(PersonLevel({ state: await stateWith(someone, [], { failure: { code: 'unavailable', retryable: true } }) })));
    expect(failed).not.toContain('Nothing of theirs is waiting');
    expect(failed).toContain('Couldn’t read every project just now');
  });

  it('says when every page of your projects could not be read', async () => {
    const { MyProjects, PersonLevel } = await import('../../src/renderer/screens/altitude.js');
    const listFailure = { code: 'unavailable', retryable: true };
    // While Home's own read of every page is the list in use: the sidebar has more pages than it shows.
    const paged = { next: 'more' };
    expect(text(render(MyProjects({ state: await stateWith({ reads: READS, listFailure }, [THERMAL, CERT, PACKAGING], paged) })))).toContain('Couldn’t read every project just now');
    expect(text(render(PersonLevel({ state: await stateWith({ level: 'person', membership_id: 'mem_mina', name: 'Mina Patel', reads: READS, listFailure },
      [THERMAL, CERT, PACKAGING], paged) })))).toContain('Couldn’t read every project just now');
  });
});

describe('stops and notices for a long list', () => {
  it('keeps the Project stop open at the top for a project last zoomed on that it cannot see on the sidebar’s first page', async () => {
    const { Stops } = await import('../../src/renderer/screens/altitude.js');
    const tree = render(Stops({ state: await stateWith({ project_id: 'prj_far-away' }, [THERMAL, CERT, PACKAGING], { next: 'more' }) }));
    const stop = byTestId(tree, 'alt-stop').find(each => each.props['data-level'] === 'project')!;
    expect(stop.props.disabled).toBe(false);
    expect(stop.props['aria-label']).toBe('Project');
  });

  it('a person does not blame a sidebar page that failed when every project was read', async () => {
    const { PersonLevel } = await import('../../src/renderer/screens/altitude.js');
    const tree = render(PersonLevel({ state: await stateWith({ level: 'person', membership_id: 'mem_nobody', name: 'Nobody Here', reads: READS },
      [THERMAL, CERT, PACKAGING], { failure: { code: 'unavailable', retryable: true } }) }));
    expect(text(tree)).not.toContain('Couldn’t read every project just now');
    expect(text(tree)).toContain('Nothing of theirs is waiting');
  });
});

describe('a project Home cannot find on your list', () => {
  it('says it is reading, or that it could not read every project, with a way back to My projects', async () => {
    const { ProjectLevel } = await import('../../src/renderer/screens/altitude.js');
    const lost = { level: 'project' as const, project_id: 'prj_far-away' };
    expect(text(render(ProjectLevel({ state: await stateWith(lost, [THERMAL], { next: 'more' }) })))).toContain('Reading');
    const failed = render(ProjectLevel({ state: await stateWith({ ...lost, listFailure: { code: 'unavailable', retryable: true } }, [THERMAL], { next: 'more' }) }));
    expect(text(failed)).toContain('Couldn’t read every project just now');
    expect(byTestId(failed, 'alt-back-to-projects')).toHaveLength(1);
  });
});

describe('a remembered project when your projects could not be read at all', () => {
  it('says so, with a way back to My projects, instead of reading forever', async () => {
    const { ProjectLevel } = await import('../../src/renderer/screens/altitude.js');
    const tree = render(ProjectLevel({ state: await stateWith({ level: 'project', project_id: 'prj_remembered' }, [], { failure: { code: 'unavailable', retryable: true } }) }));
    expect(text(tree)).toContain('Couldn’t read every project just now');
    expect(byTestId(tree, 'alt-back-to-projects')).toHaveLength(1);
  });
});

