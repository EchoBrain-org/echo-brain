import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { MAX_CAPTURE_PROJECTS, type ProjectSummary } from '../../shared/protocol.js';
import { dateTime } from '../format.js';
import { dueWords } from '../needs.js';
import {
  decide, destinationFrom, keptItems, loadProjects, lockDecisionRoute, lockDecisionRoutes, ONLY_ME, retryImpact, routedProjects,
  setDecisionOwner, setDecisionRoute, setDecisionRoutes, tickDecisionRoute, tickDecisionRoutes, type DecisionState, type Destination,
  type State,
} from '../store.js';
import { CardHead, Face, NotesButton, NotesPanel, Reasons, SignalRow } from './card.js';
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

/** Where a destination is, in a few words: its first project's name ("THERM +1" with more), No project, or Not kept. */
function destinationPlace(destination: Destination, names: ReadonlyMap<string, string>): string {
  if (destination === null) return 'Not kept';
  if (destination.projects.length === 0) return 'No project';
  const first = names.get(destination.projects[0]!) ?? 'A project';
  return destination.projects.length > 1 ? `${first} +${destination.projects.length - 1}` : first;
}

/**
 * A destination in words: where it is, then ", only me" when only you read it there, as the Only me lock says: always with
 * no project, and on projects with the lock pressed.
 */
export function destinationLabel(destination: Destination, names: ReadonlyMap<string, string>): string {
  return destination?.private === true ? `${destinationPlace(destination, names)}, only me` : destinationPlace(destination, names);
}

/** Where an approved item went: the lock when only you read it there (its words stay in the chip's title), then where. */
function ChipFace({ label, locked }: { label: string; locked: boolean }) {
  return <>{locked && <span class="route-lock" data-testid="route-final-lock" title="Only you can read it there"><Lock /></span>}<span class="name">{label}</span></>;
}

/**
 * "2 to Thermostat redesign · 1 to Thermostat redesign, only me · 1 to No project, only me · 1 not kept": where Approve
 * sends the items, in the card's order, in the words of each place and its lock. Counted by destination, not by its words:
 * THERM with ECHO and THERM with SUPPLIER both read "THERM +1", and are two records; so are THERM shared and THERM kept for
 * you alone.
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

/** Where an item is, on its place button: its first project ("THERM +1" with more), No project, or Don't keep. */
function placeLabel(destination: Destination, names: ReadonlyMap<string, string>): string {
  return destination === null ? 'Don\'t keep' : destinationPlace(destination, names);
}

/** Who reads an item where it goes, beside its controls; nothing when it is not kept. */
function readersOf(destination: Destination): string | null {
  if (destination === null) return null;
  if (destination.projects.length === 0) return 'Only you can read it';
  const many = destination.projects.length > 1;
  return destination.private ? `Only you can read it, filed in ${many ? 'these projects' : 'the project'}`
    : `${many ? 'Members of these projects' : 'Project members'} can read it`;
}

/** A place menu's choice as it shows: the projects ticked, those only some items have, No project, or Don't keep. */
interface Shown { dropped: boolean; noProject: boolean; ticked: readonly string[]; partly: readonly string[] }

function shownOf(destination: Destination): Shown {
  return { dropped: destination === null, noProject: destination?.projects.length === 0, ticked: destination?.projects ?? [], partly: [] };
}

/** The kept items' destinations, in the card's order. */
function keptDestinations(decision: DecisionState): NonNullable<Destination>[] {
  return keptItems(decision).map(item => decision.routes[item.signal_id]!);
}

/**
 * The All items place menu: Don't keep when nothing is kept, No project when no kept item has one, a project every kept
 * item has ticked, and one only some have part-ticked. Who reads them is the lock's, never the menu's.
 */
function allShown(decision: DecisionState): Shown {
  const kept = keptDestinations(decision);
  if (kept.length === 0) return shownOf(null);
  const every = (id: string) => kept.every(destination => destination.projects.includes(id));
  const named = [...new Set(kept.flatMap(destination => destination.projects))];
  return { dropped: false, noProject: named.length === 0, ticked: named.filter(every), partly: named.filter(id => !every(id)) };
}

/** Where every kept item is, the lock aside: their one place, Mixed when they differ, or Don't keep when nothing is kept. */
function allPlace(decision: DecisionState, names: ReadonlyMap<string, string>): string {
  const kept = keptDestinations(decision);
  const [first] = kept;
  if (first === undefined) return placeLabel(null, names);
  const place = (destination: NonNullable<Destination>) => destination.projects.join('\n');
  return kept.every(destination => place(destination) === place(first)) ? placeLabel(first, names) : 'Mixed';
}

/**
 * The Only me lock beside a place (ADR-0049, as on Capture): pressed when only you read it; for All items, "1 of 3" when
 * only some kept items are yours alone. With no project it stays on: there is no one to share it with.
 */
interface LockShown { pressed: boolean | 'mixed'; fixed: boolean; label: string }

function lockOf(destination: Destination): LockShown | null {
  if (destination === null) return null;
  return { pressed: destination.private, fixed: destination.projects.length === 0, label: 'Only me' };
}

function allLock(decision: DecisionState): LockShown | null {
  const kept = keptDestinations(decision);
  if (kept.length === 0) return null;
  if (kept.every(destination => destination.projects.length === 0)) return lockOf(ONLY_ME);
  // No project is always only you: it counts among the items only you read.
  const mine = kept.filter(destination => destination.private).length;
  if (mine === 0 || mine === kept.length) return { pressed: mine > 0, fixed: false, label: 'Only me' };
  return { pressed: 'mixed', fixed: false, label: `${mine} of ${kept.length}` };
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
 * Where an item goes, and who reads it there (ADR-0049, as on Capture): a place button, whose menu holds places only (your
 * projects, several, up to 20 named by the whole meeting; No project; Don't keep), then the Only me lock beside it, and
 * who can read it in words. With no project the lock stays on and says why. Escape or a click elsewhere closes the menu.
 */
function Where({ label, shown, lock, readers, readersId, named, projects, state, frozen, name, lockName, testid, lockTestid, onTick, onNoProject, onDrop, onLock }: {
  label: string; shown: Shown; lock: LockShown | null; readers: string | null; readersId?: string; named: readonly string[]; projects: readonly ProjectSummary[];
  state: State; frozen: boolean; name: string; lockName: string; testid: string; lockTestid: string;
  onTick(projectId: string): void; onNoProject(): void; onDrop(): void; onLock(): void;
}) {
  // Both controls say who reads it, from the line beside them, as on Capture.
  const described = readers !== null && readersId !== undefined ? readersId : undefined;
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
    <div class="where">
      <div class="route" ref={box}>
        <button type="button" ref={chip} class={`route-chip${shown.dropped ? ' dropped' : ''}`} aria-haspopup="true" aria-expanded={open} disabled={frozen}
          aria-label={`${name}: ${label}`} aria-describedby={described} data-testid={testid} onClick={() => setOpen(!open)}>
          <span class="name">{label}</span><Caret />
        </button>
        {open && (
          <div class="menu route-menu" role="group" aria-label={name} data-testid="route-menu">
            <div class="menu-label">Projects</div>
            <ProjectPicker projects={projects} ticked={shown.ticked} partly={shown.partly} named={named} max={MAX_CAPTURE_PROJECTS} onTick={onTick} disabled={frozen}
              more={state.projects.next !== null && !state.projects.loading} onMore={() => void loadProjects(true)} />
            <div class="menu-rule" />
            {/* Either, never both, and neither while projects are ticked: Capture's choices for the same places. */}
            <div class="menu-choices" role="radiogroup" aria-label="Not in a project">
              <button type="button" class="menu-item" role="radio" aria-checked={shown.noProject} onClick={choose(onNoProject)}>No project <span class="menu-hint">only you</span></button>
              <button type="button" class="menu-item" role="radio" aria-checked={shown.dropped} onClick={choose(onDrop)}>Don't keep</button>
            </div>
          </div>
        )}
      </div>
      {lock && (
        <button type="button" class="lock-toggle" data-testid={lockTestid} aria-pressed={lock.pressed} aria-disabled={lock.fixed ? 'true' : undefined} disabled={frozen}
          aria-label={lock.pressed === 'mixed' ? `${lockName}: ${lock.label}` : lockName} aria-describedby={described}
          title={lock.fixed ? 'No project: only you can read it' : undefined} onClick={lock.fixed ? undefined : onLock}>
          <Lock />{lock.label}
        </button>
      )}
      {readers && <span class="route-readers" id={readersId} data-testid="route-readers">{readers}</span>}
    </div>
  );
}

/** One item's place and lock: where this decision or action goes, and who reads it there. */
function ItemRoute({ item, decision, state, projects, names, named, frozen }: {
  item: Item; decision: DecisionState; state: State; projects: readonly ProjectSummary[]; names: ReadonlyMap<string, string>; named: readonly string[]; frozen: boolean;
}) {
  const destination = decision.routes[item.signal_id] ?? null;
  return <Where label={placeLabel(destination, names)} shown={shownOf(destination)} lock={lockOf(destination)} readers={readersOf(destination)}
    readersId={`route-readers-${item.signal_id}`} named={named}
    projects={projects} state={state} frozen={frozen} name={`Where it goes: ${short(item.text)}`} lockName={`Only me: ${short(item.text)}`}
    testid="route-chip" lockTestid="route-lock" onTick={id => tickDecisionRoute(item.signal_id, id)} onNoProject={() => setDecisionRoute(item.signal_id, ONLY_ME)}
    onDrop={() => setDecisionRoute(item.signal_id, null)} onLock={() => lockDecisionRoute(item.signal_id)} />;
}

/** The meeting's decisions, numbered: `under` each what is chosen for it, beside it what is short. */
function Decided({ items, under, children }: { items: readonly Item[]; under?(item: Item): ComponentChildren; children?(item: Item): ComponentChildren }) {
  const decisions = items.filter(item => item.kind === 'decision');
  if (decisions.length === 0) return null;
  return (
    <section class="card-section" aria-labelledby="decision-decided">
      <div class="section-label" id="decision-decided">Decided</div>
      <div class="card-list">{decisions.map((item, index) => (
        <SignalRow key={item.signal_id} signal={item} number={index + 1} under={under?.(item)}>{children?.(item)}</SignalRow>
      ))}</div>
    </section>
  );
}

/** Who does what: each action with its due date beside it, its owner and where it goes under or beside it. */
function ToDo({ items, under, children }: { items: readonly Item[]; under?(item: Item): ComponentChildren; children?(item: Item): ComponentChildren }) {
  const actions = items.filter(item => item.kind === 'action');
  if (actions.length === 0) return null;
  return (
    <section class="card-section" aria-labelledby="decision-todo">
      <div class="section-label" id="decision-todo">To do</div>
      <div class="card-list">{actions.map(item => {
        const when = dueWords(item.due_at);
        return <SignalRow key={item.signal_id} signal={item} under={under?.(item)}>{when && <span class="card-due">{when}</span>}{children?.(item)}</SignalRow>;
      })}</div>
    </section>
  );
}

/** Every quote the items carry, each once, in the card's order: the meeting's words behind what it holds. */
function notesOf(items: readonly Item[]): readonly string[] {
  return [...new Set(items.flatMap(item => item.quotes))];
}

/**
 * Approve this meeting? What was decided and who does what on the left, each
 * with where it goes and who reads it there under its words; the meeting's
 * own words behind one button in the head; on the right one control for every
 * kept item, where they go in a line, and the two buttons.
 */
function Proposal({ state, decision }: { state: State; decision: DecisionState }) {
  const open = decision.open!;
  const [notes, setNotes] = useState(false);
  const projects = choices(state.projects.items, open.suggested_projects);
  const names = namesOf(projects);
  // Sending, or maybe sent: Approve and Reject resend the same choices.
  const frozen = decision.busy || decision.unknown === true;
  const approvable = !decision.busy && keptItems(decision).length > 0;
  // Every chip counts the whole meeting's projects toward the 20 one approval may name.
  const named = [...routedProjects(decision.routes)];
  const quotes = notesOf(open.items);
  const holds = counts(open.items);
  const route = (item: Item) => <ItemRoute item={item} decision={decision} state={state} projects={projects} names={names} named={named} frozen={frozen} />;
  return (
    <div class="card-page" data-testid="decision">
      <article class="card-main" aria-labelledby="decision-ask">
        <CardHead kind="approve" verb="Approve" where={meetingWhere(open.review.meeting_at, open.review.all_day)} title={open.review.title} id="decision-ask"
          meta={holds === null && quotes.length === 0 ? undefined : <>
            {holds}{holds !== null && quotes.length > 0 && <span aria-hidden="true">·</span>}
            {quotes.length > 0 && <NotesButton open={notes} onToggle={() => setNotes(!notes)} />}
          </>} />
        {notes && <NotesPanel quotes={quotes} />}
        <Decided items={open.items} under={route} />
        <Reasons reasons={open.reasons} />
        <ToDo items={open.items} under={item => (
          <div class="card-controls">
            {item.owner_editable && (
              <label class="card-owner">
                <Face name={decision.owners[item.signal_id] || '?'} />
                <input type="text" value={decision.owners[item.signal_id] ?? ''} disabled={frozen || decision.routes[item.signal_id] === null} placeholder="No owner"
                  aria-label={`Owner for: ${item.text}`} onInput={event => setDecisionOwner(item.signal_id, (event.target as HTMLInputElement).value)} />
              </label>
            )}
            {route(item)}
          </div>
        )} />
      </article>
      <aside class="card-rail" aria-label="Your decision">
        <section class="card-panel" aria-labelledby="decision-route">
          <div class="route-all">
            <div class="section-label" id="decision-route">All items</div>
            <Where label={allPlace(decision, names)} shown={allShown(decision)} lock={allLock(decision)} readers={null} named={named} projects={projects} state={state}
              frozen={frozen} name="Where all items go" lockName="Only me: all items" testid="route-all" lockTestid="route-all-lock" onTick={tickDecisionRoutes}
              onNoProject={() => setDecisionRoutes(ONLY_ME)} onDrop={() => setDecisionRoutes(null)} onLock={lockDecisionRoutes} />
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
  const [notes, setNotes] = useState(false);
  const names = namesOf(choices(state.projects.items, open.suggested_projects));
  const quotes = notesOf(open.items);
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
      <ChipFace label={destinationPlace(destination, names)} locked={destination?.private === true} /></span> : null;
  };
  return (
    <div class="card-page" data-testid="decision">
      <article class="card-main" aria-labelledby="decision-ask">
        <CardHead kind="done" verb={standing} where={open.review.title} title={approved ? ask : open.review.title} id="decision-ask"
          meta={quotes.length > 0 ? <NotesButton open={notes} onToggle={() => setNotes(!notes)} /> : undefined} />
        {notes && <NotesPanel quotes={quotes} />}
        {status === 'publishing' && <ImpactSection run={undefined} publishing busy={decision.busy} followUps={null} onRetry={() => undefined} />}
        {open.records.map(record => {
          const run = runs.find(item => item.event_ref === record.approval_id);
          const line = run ? decision.lines[run.run_id] : undefined;
          const followUps = run && line ? meetingFollowUps({ scope: 'run', id: run.run_id, seq: 0, loading: false, summary: line.summary, stage: line.stage, busy: false }, open.review.title) : null;
          return <ImpactSection key={record.approval_id} label={destinationLabel(destinationFrom(record), names)} run={run} publishing={run === undefined} busy={decision.busy}
            followUps={followUps} onRetry={() => { if (run) void retryImpact(run.run_id); }} />;
        })}
        {/* Where each went sits under its words, as where each goes did: beside them it would narrow them. */}
        <Decided items={open.items} under={where} />
        <ToDo items={open.items} under={item => approved ? (
          <div class="card-controls">
            {item.owner !== null && <span class="card-owner still"><Face name={item.owner} /><span>{item.owner}</span></span>}
            {where(item)}
          </div>
        ) : null} />
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
