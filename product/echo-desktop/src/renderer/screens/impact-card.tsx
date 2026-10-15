import type { PersonRunErrorCodeV1, PersonRunV1 } from '@echo-brain/organization-api';
import type { ImpactView } from '../../shared/protocol.js';

const REASONS: Readonly<Record<PersonRunErrorCodeV1, string>> = {
  no_access: 'You no longer have access to what this check needs.',
  unavailable: 'The impact check is unavailable right now.',
  timed_out: 'The impact check took too long.',
  research_failed: 'The impact check failed.',
};

/**
 * What an approved meeting's check found (runs store and impact card v1,
 * section 5; follow-ups thread v1): while it is queued or running, how it
 * stands; when it failed, why, and Try again; once done, what was decided and
 * its follow-ups in one line ("Follow-ups · 4 not sent"), which open that
 * meeting's list.
 */
export function ImpactSection({ run, view, publishing, busy, followUps, onRetry }: {
  run: PersonRunV1 | undefined;
  view: ImpactView | null | undefined;
  publishing: boolean;
  busy: boolean;
  /** The meeting's follow-ups counted, once read, and what opens them when there are any. */
  followUps: { words: string; open: (() => void) | null } | null;
  onRetry(): void;
}) {
  if (run === undefined && !publishing) return null;
  return <section class="impact" aria-label="Impact">
    <div class="impact-head">
      <h4 class="section-label">Impact</h4>
      {(run === undefined || run.state === 'pending') && <span class="notice-line">Check queued</span>}
      {run?.state === 'running' && <span class="asking"><i /><i /><i /><span>Checking what this changes · a few minutes</span></span>}
      {run?.state === 'done' && view === undefined && <span class="notice-line">Opening…</span>}
    </div>
    {run?.state === 'failed' && <div class="choices start">
      <span class="error">{REASONS[run.error_code ?? 'research_failed']}</span>
      <button type="button" class="link-button" disabled={busy} onClick={onRetry}>Try again</button>
    </div>}
    {run?.state === 'done' && view === null && <p class="error">The impact check could not be opened. Open the meeting again to retry.</p>}
    {run?.state === 'done' && view && <>
      {view.decided.length > 0 && <div class="impact-section"><h5>What was decided</h5>
        {view.decided.map((row, index) => <div key={index} class="record-item">{row.text}</div>)}</div>}
      {followUps && <div class="impact-follow-ups" data-testid="impact-follow-ups">
        <span><b>Follow-ups</b> <span class="faint">· {followUps.words}</span></span>
        {followUps.open && <button type="button" class="link-button" onClick={followUps.open}>Open follow-ups</button>}
      </div>}
    </>}
  </section>;
}
