import type { PersonRunErrorCodeV1, PersonRunV1 } from '@echo-brain/organization-api';

const REASONS: Readonly<Record<PersonRunErrorCodeV1, string>> = {
  no_access: 'You no longer have access to what this check needs.',
  unavailable: 'The impact check is unavailable right now.',
  timed_out: 'The impact check took too long.',
  research_failed: 'The impact check failed.',
};

/**
 * Where an approved meeting's check stands (runs store and impact card v1,
 * section 5; follow-ups thread v1): queued or running; failed, with why and
 * Try again; or done, with the meeting's follow-ups counted in one line
 * ("Follow-ups · 4 not sent"), the whole line opening its list when it has
 * any.
 */
export function ImpactSection({ run, publishing, busy, followUps, onRetry }: {
  run: PersonRunV1 | undefined;
  publishing: boolean;
  busy: boolean;
  /** The meeting's follow-ups counted, once read, and what opens them when there are any. */
  followUps: { words: string; open: (() => void) | null } | null;
  onRetry(): void;
}) {
  if (run === undefined && !publishing) return null;
  const words = followUps && <><b>Follow-ups</b> <span class="faint">· {followUps.words}</span></>;
  return <section class="impact" aria-label="Impact">
    <div class="impact-head">
      <h4 class="section-label">Impact</h4>
      {(run === undefined || run.state === 'pending') && <span class="notice-line">Check queued</span>}
      {run?.state === 'running' && <span class="asking"><i /><i /><i /><span>Checking what this changes · a few minutes</span></span>}
    </div>
    {run?.state === 'failed' && <div class="choices start">
      <span class="error">{REASONS[run.error_code ?? 'research_failed']}</span>
      <button type="button" class="link-button" disabled={busy} onClick={onRetry}>Try again</button>
    </div>}
    {run?.state === 'done' && followUps && (followUps.open
      ? <button type="button" class="impact-follow-ups" data-testid="impact-follow-ups" onClick={followUps.open}>{words}</button>
      : <div class="impact-follow-ups" data-testid="impact-follow-ups">{words}</div>)}
  </section>;
}
