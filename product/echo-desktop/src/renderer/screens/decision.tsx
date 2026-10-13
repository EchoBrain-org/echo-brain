import { useEffect, useRef } from 'preact/hooks';
import { MAX_CAPTURE_PROJECTS, type ProjectSummary } from '../../shared/protocol.js';
import { dateTime } from '../format.js';
import { proposalRead, readProposal, type Proposal as Read, type ProposalSignal } from '../proposal.js';
import {
  decide, loadProjects, retryImpact, setDecisionAudience, setDecisionOwner, setDecisionShare, tickDecisionProject, type DecisionState, type State,
} from '../store.js';
import { Passage } from './ask.js';
import { CardHead, dueWords, Face, Reasons, SignalRow } from './card.js';
import { ImpactSection } from './impact-card.js';
import { ProjectPicker } from './project-picker.js';

/** The projects to pick from: yours, plus any the proposal suggests that you are not listed in. */
function choices(projects: readonly ProjectSummary[], suggested: NonNullable<DecisionState['open']>['suggested_projects']): readonly ProjectSummary[] {
  const all = new Map(projects.map(project => [project.project_id, project]));
  for (const project of suggested) if (!all.has(project.project_id)) all.set(project.project_id, { ...project, role: 'member', created_at: '', status: 'active' });
  return [...all.values()];
}

/** "2 decisions · 1 action": what the proposal holds. */
function counts(read: Read): string | null {
  const parts = [
    read.decisions.length > 0 ? `${read.decisions.length} ${read.decisions.length === 1 ? 'decision' : 'decisions'}` : null,
    read.actions.length > 0 ? `${read.actions.length} ${read.actions.length === 1 ? 'action' : 'actions'}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Where the meeting came from: "Meeting · Oct 13, 9:00 AM". */
function meetingWhere(meetingAt: string | null): string {
  const at = meetingAt ? dateTime(meetingAt) : '';
  return at ? `Meeting · ${at}` : 'Meeting';
}

/** What was decided, numbered. */
function Decided({ read }: { read: Read }) {
  if (read.decisions.length === 0) return null;
  return (
    <section class="card-section" aria-labelledby="decision-decided">
      <div class="section-label" id="decision-decided">Decided</div>
      <div class="card-list">{read.decisions.map((signal, index) => <SignalRow key={index} signal={signal} number={index + 1} />)}</div>
    </section>
  );
}

/**
 * Who does what: each action with its due date, and its owner, a name you
 * can change before approving (the Authority keeps it as typed). Actions the
 * proposal names without an owner to set show as they are.
 */
/** The same words, whatever their spacing: an owner's action as the proposal text wrote it. */
function same(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

function ToDo({ decision, read, frozen }: { decision: DecisionState; read: Read; frozen: boolean }) {
  const actions = read.actions;
  const loose: ProposalSignal[] = actions.filter(action => !decision.owners.some(owner => same(owner.action, action.text)));
  if (decision.owners.length === 0 && loose.length === 0) return null;
  const due = (text: string) => dueWords(actions.find(action => same(action.text, text))?.due ?? null);
  return (
    <section class="card-section" aria-labelledby="decision-todo">
      <div class="section-label" id="decision-todo">To do</div>
      <div class="card-list">
        {decision.owners.map(owner => {
          const signal = actions.find(action => same(action.text, owner.action)) ?? { text: owner.action, subject: null, status: null, due: null, quotes: [] };
          const when = due(owner.action);
          return (
            <SignalRow key={owner.signal_id} signal={signal}>
              {when && <span class="card-due">{when}</span>}
              <label class="card-owner">
                <Face name={owner.owner || '?'} />
                <input type="text" value={owner.owner} disabled={frozen} placeholder="No owner" aria-label={`Owner for: ${owner.action}`}
                  onInput={event => setDecisionOwner(owner.signal_id, (event.target as HTMLInputElement).value)} />
              </label>
            </SignalRow>
          );
        })}
        {loose.map((signal, index) => {
          const when = dueWords(signal.due);
          return <SignalRow key={`loose-${index}`} signal={signal}>{when && <span class="card-due">{when}</span>}</SignalRow>;
        })}
      </div>
    </section>
  );
}

/** The proposal's own words, when they do not read as a proposal. */
function AsWritten({ text, title }: { text: string; title: string }) {
  return <div class="passage selectable decision-body" data-testid="decision-body"><Passage text={text} label={title} /></div>;
}

/** Approve this decision? What was decided and who does what on the left; who sees it, and the one button, on the right. */
function Proposal({ state, decision }: { state: State; decision: DecisionState }) {
  const open = decision.open!;
  const read = readProposal(open.content);
  const readable = proposalRead(read);
  const projects = choices(state.projects.items, open.suggested_projects);
  const chosen = decision.project_ids.map(id => projects.find(project => project.project_id === id)?.name ?? id);
  const approvable = !decision.busy && (decision.audience === 'only-me' || decision.project_ids.length > 0);
  // Sending, or maybe sent: Approve and Reject resend the same choices.
  const frozen = decision.busy || decision.unknown === true;
  return (
    <div class="card-page" data-testid="decision">
      <article class="card-main" aria-labelledby="decision-ask">
        <CardHead kind="approve" verb="Approve" where={meetingWhere(open.review.meeting_at)} title={open.review.title} id="decision-ask"
          meta={readable ? counts(read) : null} />
        {readable ? <>
          <Decided read={read} />
          <ToDo decision={decision} read={read} frozen={frozen} />
          <Reasons reasons={read.rationales} />
        </> : <>
          <AsWritten text={open.content} title={open.review.title} />
          <ToDo decision={decision} read={read} frozen={frozen} />
        </>}
      </article>
      <aside class="card-rail" aria-label="Your decision">
        <section class="card-panel" aria-labelledby="decision-readers">
          <div class="section-label" id="decision-readers">Seen by</div>
          <div role="radiogroup" aria-labelledby="decision-readers" class="readers-row">
            <button type="button" role="radio" class="reader-pill" aria-checked={decision.audience === 'only-me'} disabled={frozen}
              data-testid="decision-only-me" onClick={() => setDecisionAudience('only-me')}>Only me</button>
            <button type="button" role="radio" class="reader-pill" aria-checked={decision.audience === 'projects'} disabled={frozen}
              data-testid="decision-projects" onClick={() => setDecisionAudience('projects')}>
              {decision.audience === 'projects' && chosen.length > 0 ? `${chosen[0]}${chosen.length > 1 ? ` +${chosen.length - 1}` : ''}` : 'Projects'}
            </button>
          </div>
          {decision.audience === 'projects' && (
            <div class="well picker" data-testid="decision-picker">
              <ProjectPicker projects={projects} ticked={decision.project_ids} max={MAX_CAPTURE_PROJECTS} onTick={tickDecisionProject} disabled={frozen}
                more={state.projects.next !== null && !state.projects.loading} onMore={() => void loadProjects(true)} />
            </div>
          )}
          <label class="check"><input type="checkbox" checked={decision.share} disabled={frozen} onChange={event => setDecisionShare((event.target as HTMLInputElement).checked)} />
            <span>Share the transcript with them too</span></label>
          {decision.failure && <div class="error" data-testid="decision-error" aria-live="polite">{decision.failure}</div>}
          <div class="card-rule" />
          <button type="button" class="primary-button" data-testid="decision-approve" disabled={!approvable} onClick={() => void decide('approve')}>Approve</button>
          <button type="button" class="plain-button" data-testid="decision-reject" disabled={decision.busy} onClick={() => void decide('reject')}>Reject</button>
          {decision.busy && <span class="asking card-busy"><i /><i /><i /><span>Sending</span></span>}
        </section>
        {read.participants.length > 0 && (
          <section class="card-side" aria-labelledby="decision-people">
            <div class="section-label" id="decision-people">In the meeting · {read.participants.length}</div>
            {read.participants.map(name => <div class="card-person" key={name}><Face name={name} /><span>{name}</span></div>)}
          </section>
        )}
      </aside>
    </div>
  );
}

/**
 * What did it change? The approved decision's impact card, or where the
 * check stands (Tell the owners?' Details, and a failed check's Try again),
 * then what was decided.
 */
function Impact({ state, decision }: { state: State; decision: DecisionState }) {
  const open = decision.open!;
  const read = readProposal(open.content);
  const run = decision.run;
  const done = run?.state === 'done' && decision.impact !== undefined;
  const ask = run?.state === 'failed' ? 'The check did not finish' : done ? 'What did it change?' : 'Checking what it changes';
  const verb = open.review.status === 'rejected' ? 'Rejected' : open.review.status === 'superseded' ? 'Replaced by a newer version' : 'Approved';
  const standing = open.review.decided_on === 'slack' ? `${verb} in Slack` : verb;
  return (
    <div class="card-page" data-testid="decision">
      <article class="card-main" aria-labelledby="decision-ask">
        <CardHead kind="done" verb={standing} where={open.review.title} title={ask} id="decision-ask" />
        <ImpactSection run={run ?? undefined} view={decision.impact} publishing={open.review.status === 'publishing'} busy={decision.busy}
          tools={state.tools?.items ?? undefined} onRetry={() => void retryImpact()} />
        {proposalRead(read) ? <>
          <Decided read={read} />
          {read.actions.length > 0 && (
            <section class="card-section" aria-labelledby="decision-todo">
              <div class="section-label" id="decision-todo">To do</div>
              <div class="card-list">{read.actions.map((signal, index) => {
                const when = dueWords(signal.due);
                return <SignalRow key={index} signal={signal}>{when && <span class="card-due">{when}</span>}</SignalRow>;
              })}</div>
            </section>
          )}
        </> : <AsWritten text={open.content} title={open.review.title} />}
      </article>
    </div>
  );
}

/** The decision page, from a Home row: the proposal to approve, or what an approved one changed. */
export function Decision({ state, decision }: { state: State; decision: DecisionState }) {
  const box = useRef<HTMLDivElement>(null);
  // The heading takes the focus, as on Your open items: Enter or Space must not change a choice or open a source.
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
