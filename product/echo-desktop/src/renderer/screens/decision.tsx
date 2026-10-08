import { useEffect, useRef } from 'preact/hooks';
import { MAX_CAPTURE_PROJECTS, type ProjectSummary } from '../../shared/protocol.js';
import { colorFor, initials } from '../format.js';
import {
  decide, dismissImpact, loadProjects, retryImpact, setDecisionAudience, setDecisionOwner, setDecisionShare, tickDecisionProject, type DecisionState, type State,
} from '../store.js';
import { Passage } from './ask.js';
import { ImpactSection } from './impact-card.js';
import { ProjectPicker } from './project-picker.js';

/** The projects to pick from: yours, plus any the proposal suggests that you are not listed in. */
function choices(projects: readonly ProjectSummary[], suggested: NonNullable<DecisionState['open']>['suggested_projects']): readonly ProjectSummary[] {
  const all = new Map(projects.map(project => [project.project_id, project]));
  for (const project of suggested) if (!all.has(project.project_id)) all.set(project.project_id, { ...project, role: 'member', created_at: '', status: 'active' });
  return [...all.values()];
}

function Owner({ name }: { name: string }) {
  return <span class="face" style={{ background: colorFor(name) }} aria-hidden="true">{initials(name)}</span>;
}

/** Approve this decision? The proposal, who does what, who sees it, and the one button. */
function Proposal({ state, decision }: { state: State; decision: DecisionState }) {
  const open = decision.open!;
  const projects = choices(state.projects.items, open.suggested_projects);
  const chosen = decision.project_ids.map(id => projects.find(project => project.project_id === id)?.name ?? id);
  const approvable = !decision.busy && (decision.audience === 'only-me' || decision.project_ids.length > 0);
  return (
    <article class="decision-card" data-testid="decision" aria-labelledby="decision-ask">
      <h1 id="decision-ask" class="decision-ask">Approve this decision?</h1>
      <div class="decision-from">From <b>{open.review.title}</b></div>
      <div class="passage selectable decision-body" data-testid="decision-body"><Passage text={open.content} label={open.review.title} /></div>
      {decision.owners.length > 0 && (
        <div class="decision-section">
          <div class="section-label">Who does what</div>
          {decision.owners.map(owner => (
            <label class="decision-action" key={owner.signal_id}>
              <Owner name={owner.owner || '?'} />
              <span class="decision-action-text">{owner.action}</span>
              <input class="field small" type="text" value={owner.owner} disabled={decision.busy} placeholder="No owner" aria-label={`Owner for: ${owner.action}`}
                onInput={event => setDecisionOwner(owner.signal_id, (event.target as HTMLInputElement).value)} />
            </label>
          ))}
        </div>
      )}
      <div class="decision-section">
        <div class="section-label" id="decision-readers">Seen by</div>
        <div role="radiogroup" aria-labelledby="decision-readers" class="readers-row">
          <button type="button" role="radio" class="reader-pill" aria-checked={decision.audience === 'only-me'} disabled={decision.busy}
            data-testid="decision-only-me" onClick={() => setDecisionAudience('only-me')}>Only me</button>
          <button type="button" role="radio" class="reader-pill" aria-checked={decision.audience === 'projects'} disabled={decision.busy}
            data-testid="decision-projects" onClick={() => setDecisionAudience('projects')}>
            {decision.audience === 'projects' && chosen.length > 0 ? `${chosen[0]}${chosen.length > 1 ? ` +${chosen.length - 1}` : ''}` : 'Projects'}
          </button>
        </div>
        {decision.audience === 'projects' && (
          <div class="well picker" data-testid="decision-picker">
            <ProjectPicker projects={projects} ticked={decision.project_ids} max={MAX_CAPTURE_PROJECTS} onTick={tickDecisionProject}
              more={state.projects.next !== null && !state.projects.loading} onMore={() => void loadProjects(true)} />
          </div>
        )}
        <label class="check"><input type="checkbox" checked={decision.share} disabled={decision.busy} onChange={event => setDecisionShare((event.target as HTMLInputElement).checked)} />
          <span>Share the transcript with the selected audience</span></label>
      </div>
      {decision.failure && <div class="error" data-testid="decision-error" aria-live="polite">{decision.failure}</div>}
      <div class="decision-foot">
        <button type="button" class="primary-button small" data-testid="decision-approve" disabled={!approvable} onClick={() => void decide('approve')}>Approve</button>
        <button type="button" class="plain-button" data-testid="decision-reject" disabled={decision.busy} onClick={() => void decide('reject')}>Reject</button>
        {decision.busy && <span class="asking"><i /><i /><i /><span>Sending</span></span>}
      </div>
    </article>
  );
}

/** What did it change? The approved decision and its impact card, or where the check stands. */
function Impact({ state, decision }: { state: State; decision: DecisionState }) {
  const open = decision.open!;
  const run = decision.run;
  const done = run?.state === 'done' && decision.impact !== undefined;
  const ask = run?.state === 'failed' ? 'The check did not finish' : done ? 'What did it change?' : 'Checking what it changes';
  const verb = open.review.status === 'rejected' ? 'Rejected' : open.review.status === 'superseded' ? 'Replaced by a newer version' : 'Approved';
  const standing = open.review.decided_on === 'slack' ? `${verb} in Slack` : verb;
  return (
    <article class="decision-card" data-testid="decision" aria-labelledby="decision-ask">
      <h1 id="decision-ask" class="decision-ask">{ask}</h1>
      <div class="decision-from">{standing} · <b>{open.review.title}</b></div>
      <div class="passage selectable decision-body" data-testid="decision-body"><Passage text={open.content} label={open.review.title} /></div>
      <ImpactSection run={run ?? undefined} view={decision.impact} publishing={open.review.status === 'publishing'} busy={decision.busy}
        tools={state.tools?.items ?? undefined} onRetry={() => void retryImpact()} />
      <div class="decision-foot">
        <button type="button" class="primary-button small" data-testid="decision-done" onClick={dismissImpact}>Got it</button>
      </div>
    </article>
  );
}

/** The decision page, from a Home row: the proposal to approve, or what an approved one changed. */
export function Decision({ state, decision }: { state: State; decision: DecisionState }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true }); }, [decision.loading]);
  if (decision.loading) return <div class="column center" aria-busy="true" data-testid="decision-loading"><span class="asking"><i /><i /><i /></span></div>;
  if (!decision.open) {
    return <div class="column center" data-testid="decision-error"><div class="error">{decision.failure ?? 'The decision could not be read.'}</div></div>;
  }
  const pending = decision.open.review.status === 'pending';
  return (
    <div class="column decision" ref={box}>
      {pending ? <Proposal state={state} decision={decision} /> : <Impact state={state} decision={decision} />}
    </div>
  );
}
