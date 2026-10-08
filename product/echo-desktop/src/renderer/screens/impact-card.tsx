import { useState } from 'preact/hooks';
import type { PersonRunErrorCodeV1, PersonRunV1 } from '@echo-brain/organization-api';
import type { AnswerSource, ConnectedTool, ExternalAnswerSource, ImpactView } from '../../shared/protocol.js';
import { externalSourceProvider } from '../answer.js';
import { dateTime } from '../format.js';
import { openImpactSource } from '../store.js';

const REASONS: Readonly<Record<PersonRunErrorCodeV1, string>> = {
  no_access: 'You no longer have access to what this check needs.',
  unavailable: 'The impact check is unavailable right now.',
  timed_out: 'The impact check took too long.',
  research_failed: 'The impact check failed.',
};
const RELATIONS = { confirms: 'Confirms', conflicts: 'Conflicts', needs_updating: 'Needs updating' } as const;

function hiddenLine(hidden: number): string {
  return hidden === 1 ? '1 item you can no longer open is hidden.' : `${hidden} items you can no longer open are hidden.`;
}

function OpenSource({ source, tools }: { source: ExternalAnswerSource; tools: readonly ConnectedTool[] | undefined }) {
  const [failed, setFailed] = useState(false);
  return <>
    <button type="button" class="link-button" title={source.permalink}
      onClick={async () => { setFailed(false); setFailed(!(await openImpactSource(source))); }}>Open in {externalSourceProvider(source, tools)}</button>
    {failed && <span class="error">The item could not be opened. Try again.</span>}
  </>;
}

/**
 * What an approved meeting changes, checked as you with your own access
 * (runs store and impact card v1, section 5). A finished card is rebuilt from
 * fresh reads each time it is opened; items you can no longer open are only
 * counted.
 */
export function ImpactSection({ run, view, publishing, busy, tools, onRetry }: {
  run: PersonRunV1 | undefined;
  view: ImpactView | null | undefined;
  publishing: boolean;
  busy: boolean;
  tools: readonly ConnectedTool[] | undefined;
  onRetry(): void;
}) {
  if (run === undefined && !publishing) return null;
  const label = (source: AnswerSource | undefined) => source?.label ?? 'Item';
  return <section class="impact" aria-label="Impact">
    <h4>Impact</h4>
    {(run === undefined || run.state === 'pending') && <p class="context">Impact check queued.</p>}
    {run?.state === 'running' && <p class="context">Checking what this changes. This can take a few minutes.</p>}
    {run?.state === 'failed' && <>
      <p>{REASONS[run.error_code ?? 'research_failed']}</p>
      <button type="button" class="plain-button small" disabled={busy} onClick={onRetry}>Try again</button>
    </>}
    {run?.state === 'done' && view === undefined && <p class="context">Opening the impact check…</p>}
    {run?.state === 'done' && view === null && <p class="error">The impact check could not be opened. Open the meeting again to retry.</p>}
    {run?.state === 'done' && view && <>
      {view.decided.length > 0 && <><h5>What was decided</h5><ul>{view.decided.map((row, index) => <li key={index}>{row.text}</li>)}</ul></>}
      <h5>Affected items</h5>
      {view.status === 'not_assessed' && <p class="context">Not assessed. These items may be affected.</p>}
      {view.affected.length === 0 ? <p class="context">No affected items found.</p> : <ul class="impact-items">{view.affected.map(row => {
        const source = view.sources[row.citation_index];
        return <li key={row.citation_index} class="record-item">
          <span>{row.relation && <span class="status">{RELATIONS[row.relation]}</span>} {label(source)}</span>
          <span>{row.says_now}</span>
          {row.owner && <span class="owner">Owner: {row.owner}</span>}
          {row.date_at_risk && <span class="owner">Date at risk: {row.date_at_risk.milestone}, {row.date_at_risk.date}</span>}
          {source && 'permalink' in source && <span><OpenSource source={source} tools={tools} /></span>}
        </li>;
      })}</ul>}
      {view.unconfirmed.length > 0 && <><h5>Couldn't confirm</h5><ul>{view.unconfirmed.map(note => <li key={note}>{note}</li>)}</ul></>}
      {view.people.length > 0 && <><h5>People to tell</h5><ul>{view.people.map(person => <li key={person.name}>
        {person.name}{person.items.length > 0 && <span class="owner"> · {person.items.map(index => label(view.sources[index])).join(', ')}</span>}
      </li>)}</ul></>}
      <p class="context">Checked {dateTime(view.checked_at)}</p>
      {view.hidden > 0 && <p class="context">{hiddenLine(view.hidden)}</p>}
    </>}
  </section>;
}
