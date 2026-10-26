import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { MAX_CAPTURE_PROJECTS, type ProjectSummary } from '../../shared/protocol.js';
import { dateTime } from '../format.js';
import { dueWords } from '../needs.js';
import {
  decide, destinationFrom, keptItems, keptPrivate, loadProjects, lockDecisionRoute, lockDecisionRoutes, retryImpact, routedProjects, setDecisionOwner,
  setDecisionRoute, setDecisionRoutes, sharedDestination, tickDecisionRoute, tickDecisionRoutes, type DecisionState, type Destination, type State,
} from '../store.js';
import { CardHead, Face, Reasons, SignalRow } from './card.js';
import { Caret, Lock } from './icons.js';
import { ImpactSection, meetingFollowUps } from './impact-card.js';
import { ProjectPicker } from './project-picker.js';

type Open = NonNullable<DecisionState['open']>;
type Item = Open['items'][number];

/** The projects to pick from: yours, plus any the items name that you are not listed in. */
function choices(projects: readonly ProjectSummary[], suggested: Open['suggested_projects']): readonly ProjectSummary[] {
  const all = new Map(projects.map(project => [project.project_id, project]));
  for (const project of suggested) if (!all.has(project.project_id)) all.set(project.project_id, { ...project, role: 'member', created_at: '', status: 'active' });
  return [...all.values()];
}

/** Project names by id, as you can read them. */
function namesOf(projects: readonly ProjectSummary[]): ReadonlyMap<string, string> {
  return new Map(projects.map(project => [project.project_id, project.name]));
}

/** Where a destination is, in a few words: its first project's name ("THERM +1" with more), Only me, or Not kept. */
function destinationPlace(destination: Destination, names: ReadonlyMap<string, string>): string {
  if (destination === null) return 'Not kept';
  if (destination.projects.length === 0) return 'Only me';
  const first = names.get(destination.projects[0]!) ?? 'A project';
  return destination.projects.length > 1 ? `${first} +${destination.projects.length - 1}` : first;
}

/** A destination in words: where it is, then ", only me" when it is filed there for you alone. */
export function destinationLabel(destination: Destination, names: ReadonlyMap<string, string>): string {
  return keptPrivate(destination) ? `${destinationPlace(destination, names)}, only me` : destinationPlace(destination, names);
}

/** A chip's face: the lock when it is filed for you alone (its words stay in the chip's name), then where it is. */
function ChipFace({ label, locked }: { label: string; locked: boolean }) {
  return <>{locked && <span class="route-lock" data-testid="route-lock" title="Only you can read it there"><Lock /></span>}<span class="name">{label}</span></>;
}

/**
 * "2 to Thermostat redesign · 1 to Thermostat redesign, only me · 1 to Only me · 1 not kept": where Approve sends the items,
 * in the card's order. Counted by destination, not by its words: THERM with ECHO and THERM with SUPPLIER both read
 * "THERM +1", and are two records; so are THERM shared and THERM kept for you alone.
 */
function summary(items: readonly Item[], routes: DecisionState['routes'], names: ReadonlyMap<string, string>): string {
  const counts = new Map<string, { destination: Destination; count: number }>();
  for (const item of items) {
    const destination = routes[item.signal_id] ?? null;
    const key = JSON.stringify(destination && [destination.private, ...destination.projects]);
    counts.set(key, { destination, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => Number(a.destination === null) - Number(b.destination === null))
    .map(({ destination, count }) => (destination === null ? `${count} not kept` : `${count} to ${destinationLabel(destination, names)}`)).join(' · ');
}

/**
 * A chip's choice as it shows: Don't keep (a faint chip), the Only me lock pressed (Only me itself, or projects only you
 * read), the projects ticked, and those only some items have.
 */
interface Shown { dropped: boolean; onlyMe: boolean; ticked: readonly string[]; partly: readonly string[] }

function shownOf(destination: Destination): Shown {
  return { dropped: destination === null, onlyMe: destination?.private === true, ticked: destination?.projects ?? [], partly: [] };
}

/**
 * The All items control: the one destination every kept item has, or Not kept when none is. Mixed is its own: the lock
 * pressed only when every kept item is for you alone, a project every kept item has ticked, and one only some have part-ticked.
 */
function allShown(decision: DecisionState): Shown {
  const kept = keptItems(decision).map(item => decision.routes[item.signal_id]!);
  const shared = sharedDestination(decision);
  if (kept.length === 0 || shared !== null) return shownOf(kept.length === 0 ? null : shared);
  const every = (id: string) => kept.every(destination => destination.projects.includes(id));
  const named = [...new Set(kept.flatMap(destination => destination.projects))];
  return { dropped: false, onlyMe: kept.every(destination => destination.private), ticked: named.filter(every), partly: named.filter(id => !every(id)) };
}

/** "2 decisions · 1 action": what the proposal holds. */
function counts(items: readonly Item[]): string | null {
  const decisions = items.filter(item => item.kind === 'decision').length, actions = items.length - decisions;
  const parts = [
    decisions > 0 ? `${decisions} ${decisions === 1 ? 'decision' : 'decisions'}` : null,
    actions > 0 ? `${actions} ${actions === 1 ? 'action' : 'actions'}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Where the meeting came from: "Meeting · Oct 13, 9:00 AM", or a whole day's date alone, "Meeting · Oct 13". */
function meetingWhere(meetingAt: string | null, allDay: boolean): string {
  const at = meetingAt ? dateTime(meetingAt, allDay) : '';
  return at ? `Meeting · ${at}` : 'Meeting';
}

/** A short line of an item's words, for a control's name. */
function short(text: string): string {
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * A destination chip and its menu: the Only me lock, your projects (several,
 * up to 20 named by the whole meeting), or Don't keep. With no project ticked
 * the lock is Only me itself and closes the menu; with projects ticked it
 * turns whether only you read the item in them, and stays pressed while they
 * stay ticked. Escape or a click elsewhere closes it.
 */
function RouteChip({ label, locked, shown, named, projects, state, frozen, name, testid, onOnlyMe, onTick, onDrop }: {
  label: string; locked: boolean; shown: Shown; named: readonly string[]; projects: readonly ProjectSummary[]; state: State; frozen: boolean; name: string; testid: string;
  onOnlyMe(): void; onTick(projectId: string): void; onDrop(): void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); chip.current?.focus(); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key, true); };
  }, [open]);
  useEffect(() => { if (frozen) setOpen(false); }, [frozen]);
  const choose = (then: () => void) => () => { then(); setOpen(false); chip.current?.focus(); };
  return (
    <div class="route" ref={box}>
      <button type="button" ref={chip} class={`route-chip${shown.dropped ? ' dropped' : ''}`} aria-haspopup="true" aria-expanded={open} disabled={frozen}
        aria-label={`${name}: ${label}${locked ? ', only me' : ''}`} data-testid={testid} onClick={() => setOpen(!open)}>
        <ChipFace label={label} locked={locked} /><Caret />
      </button>
      {open && (
        <div class="menu route-menu" role="group" aria-label={name} data-testid="route-menu">
          <button type="button" class="menu-item" aria-pressed={shown.onlyMe}
            onClick={shown.ticked.length + shown.partly.length === 0 ? choose(onOnlyMe) : onOnlyMe}>Only me</button>
          <div class="menu-rule" />
          <ProjectPicker projects={projects} ticked={shown.ticked} partly={shown.partly} named={named} max={MAX_CAPTURE_PROJECTS} onTick={onTick} disabled={frozen}
            more={state.projects.next !== null && !state.projects.loading} onMore={() => void loadProjects(true)} />
          <div class="menu-rule" />
          <button type="button" class="menu-item" aria-pressed={shown.dropped} onClick={choose(onDrop)}>Don't keep</button>
        </div>
      )}
    </div>
  );
}

/** One item's chip: where this decision or action goes. */
function ItemRoute({ item, decision, state, projects, names, named, frozen }: {
  item: Item; decision: DecisionState; state: State; projects: readonly ProjectSummary[]; names: ReadonlyMap<string, string>; named: readonly string[]; frozen: boolean;
}) {
  const destination = decision.routes[item.signal_id] ?? null;
  return <RouteChip label={destinationPlace(destination, names)} locked={keptPrivate(destination)} shown={shownOf(destination)} named={named} projects={projects} state={state} frozen={frozen}
    name={`Where it goes: ${short(item.text)}`} testid="route-chip"
    onOnlyMe={() => lockDecisionRoute(item.signal_id)} onTick={id => tickDecisionRoute(item.signal_id, id)} onDrop={() => setDecisionRoute(item.signal_id, null)} />;
}

/** The meeting's decisions, numbered, each with what goes with it. */
function Decided({ items, children }: { items: readonly Item[]; children(item: Item): ComponentChildren }) {
  const decisions = items.filter(item => item.kind === 'decision');
  if (decisions.length === 0) return null;
  return (
    <section class="card-section" aria-labelledby="decision-decided">
      <div class="section-label" id="decision-decided">Decided</div>
      <div class="card-list">{decisions.map((item, index) => <SignalRow key={item.signal_id} signal={item} number={index + 1}>{children(item)}</SignalRow>)}</div>
    </section>
  );
}

/** Who does what: each action with its due date and owner, and what goes with it. */
function ToDo({ items, children }: { items: readonly Item[]; children(item: Item): ComponentChildren }) {
  const actions = items.filter(item => item.kind === 'action');
  if (actions.length === 0) return null;
  return (
    <section class="card-section" aria-labelledby="decision-todo">
      <div class="section-label" id="decision-todo">To do</div>
      <div class="card-list">{actions.map(item => {
        const when = dueWords(item.due_at);
        return <SignalRow key={item.signal_id} signal={item}>{when && <span class="card-due">{when}</span>}{children(item)}</SignalRow>;
      })}</div>
    </section>
  );
}

/**
 * Approve this meeting? What was decided and who does what on the left, each
 * with where it goes; on the right one control for every kept item, where
 * they go in a line, and the two buttons.
 */
function Proposal({ state, decision }: { state: State; decision: DecisionState }) {
  const open = decision.open!;
  const projects = choices(state.projects.items, open.suggested_projects);
  const names = namesOf(projects);
  // Sending, or maybe sent: Approve and Reject resend the same choices.
  const frozen = decision.busy || decision.unknown === true;
  const kept = keptItems(decision);
  const shared = sharedDestination(decision);
  const all = kept.length === 0 ? 'Not kept' : shared === null ? 'Mixed' : destinationPlace(shared, names);
  const approvable = !decision.busy && kept.length > 0;
  // Every chip counts the whole meeting's projects toward the 20 one approval may name.
  const named = [...routedProjects(decision.routes)];
  const route = (item: Item) => <ItemRoute item={item} decision={decision} state={state} projects={projects} names={names} named={named} frozen={frozen} />;
  return (
    <div class="card-page" data-testid="decision">
      <article class="card-main" aria-labelledby="decision-ask">
        <CardHead kind="approve" verb="Approve" where={meetingWhere(open.review.meeting_at, open.review.all_day)} title={open.review.title} id="decision-ask" meta={counts(open.items)} />
        <Decided items={open.items}>{route}</Decided>
        <Reasons reasons={open.reasons} />
        <ToDo items={open.items}>{item => <>
          {item.owner_editable && (
            <label class="card-owner">
              <Face name={decision.owners[item.signal_id] || '?'} />
              <input type="text" value={decision.owners[item.signal_id] ?? ''} disabled={frozen || decision.routes[item.signal_id] === null} placeholder="No owner"
                aria-label={`Owner for: ${item.text}`} onInput={event => setDecisionOwner(item.signal_id, (event.target as HTMLInputElement).value)} />
            </label>
          )}
          {route(item)}
        </>}</ToDo>
      </article>
      <aside class="card-rail" aria-label="Your decision">
        <section class="card-panel" aria-labelledby="decision-route">
          <div class="route-all">
            <div class="section-label" id="decision-route">All items</div>
            <RouteChip label={all} locked={keptPrivate(shared)} shown={allShown(decision)} named={named} projects={projects} state={state} frozen={frozen} name="Where all items go" testid="route-all"
              onOnlyMe={lockDecisionRoutes} onTick={tickDecisionRoutes} onDrop={() => setDecisionRoutes(null)} />
          </div>
          <div class="route-summary" data-testid="route-summary">{summary(open.items, decision.routes, names)}</div>
          {decision.failure && <div class="error" data-testid="decision-error" aria-live="polite">{decision.failure}</div>}
          <div class="card-rule" />
          <button type="button" class="primary-button" data-testid="decision-approve" disabled={!approvable} onClick={() => void decide('approve')}>Approve</button>
          <button type="button" class="plain-button" data-testid="decision-reject" disabled={decision.busy} onClick={() => void decide('reject')}>Reject</button>
          {decision.busy && <span class="asking card-busy"><i /><i /><i /><span>Sending</span></span>}
        </section>
        {open.participants.length > 0 && (
          <section class="card-side" aria-labelledby="decision-people">
            <div class="section-label" id="decision-people">In the meeting · {open.participants.length}</div>
            {open.participants.map(name => <div class="card-person" key={name}><Face name={name} /><span>{name}</span></div>)}
          </section>
        )}
      </aside>
    </div>
  );
}

/**
 * What did it change? For an approval, each destination's record with its own
 * check (a failed check's Try again) and follow-ups, then the decisions and
 * actions with where each went and who owns it.
 */
function Impact({ state, decision }: { state: State; decision: DecisionState }) {
  const open = decision.open!;
  const names = namesOf(choices(state.projects.items, open.suggested_projects));
  const status = open.review.status;
  const runs = decision.runs;
  const approved = status === 'approved' || status === 'publishing';
  const ask = runs.some(run => run.state === 'failed') ? 'The check did not finish'
    : runs.length > 0 && runs.length >= open.records.length && runs.every(run => run.state === 'done') ? 'What did it change?' : 'Checking what it changes';
  const verb = status === 'rejected' ? 'Rejected' : status === 'superseded' ? 'Replaced by a newer version' : 'Approved';
  const standing = open.review.decided_on === 'slack' ? `${verb} in Slack` : verb;
  const where = (item: Item) => {
    const destination = destinationFrom(item);
    return approved ? <span class={`route-chip still${destination === null ? ' dropped' : ''}`} data-testid="route-final" title={destinationLabel(destination, names)}>
      <ChipFace label={destinationPlace(destination, names)} locked={keptPrivate(destination)} /></span> : null;
  };
  return (
    <div class="card-page" data-testid="decision">
      <article class="card-main" aria-labelledby="decision-ask">
        <CardHead kind="done" verb={standing} where={open.review.title} title={approved ? ask : open.review.title} id="decision-ask" />
        {status === 'publishing' && <ImpactSection run={undefined} publishing busy={decision.busy} followUps={null} onRetry={() => undefined} />}
        {open.records.map(record => {
          const run = runs.find(item => item.event_ref === record.approval_id);
          const line = run ? decision.lines[run.run_id] : undefined;
          const followUps = run && line ? meetingFollowUps({ scope: 'run', id: run.run_id, seq: 0, loading: false, summary: line.summary, stage: line.stage, busy: false }, open.review.title) : null;
          return <ImpactSection key={record.approval_id} label={destinationLabel(destinationFrom(record), names)} run={run} publishing={run === undefined} busy={decision.busy}
            followUps={followUps} onRetry={() => { if (run) void retryImpact(run.run_id); }} />;
        })}
        <Decided items={open.items}>{where}</Decided>
        <ToDo items={open.items}>{item => <>
          {approved && item.owner !== null && <span class="card-owner still"><Face name={item.owner} /><span>{item.owner}</span></span>}
          {where(item)}
        </>}</ToDo>
      </article>
    </div>
  );
}

/** The decision page, from a Home row: the proposal to approve, or what an approved one changed. */
export function Decision({ state, decision }: { state: State; decision: DecisionState }) {
  const box = useRef<HTMLDivElement>(null);
  // The heading takes the focus, as on a follow-ups list: Enter or Space must not change a choice or open a source.
  useEffect(() => { box.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true }); }, [decision.loading]);
  if (decision.loading) return <div class="column center" aria-busy="true" data-testid="decision-loading"><span class="asking"><i /><i /><i /></span></div>;
  if (!decision.open) {
    return <div class="column center" data-testid="decision-error"><div class="error">{decision.failure ?? 'The decision could not be read.'}</div></div>;
  }
  const pending = decision.open.review.status === 'pending';
  return (
    <div class="column card" ref={box}>
      {pending ? <Proposal state={state} decision={decision} /> : <Impact state={state} decision={decision} />}
    </div>
  );
}
