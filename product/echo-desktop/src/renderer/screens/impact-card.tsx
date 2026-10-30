import type { PersonRunErrorCodeV1, PersonRunV1 } from '@echo-brain/organization-api';
import { followUpsWords, summaryTotal } from '../needs.js';
import { lineRecord, openFollowUps, type ItemsLine } from '../store.js';

const REASONS: Readonly<Record<PersonRunErrorCodeV1, string>> = {
  no_access: 'You no longer have access to what this check needs.',
  unavailable: 'The impact check is unavailable right now.',
  timed_out: 'The impact check took too long.',
  research_failed: 'The impact check failed.',
};

/** What a follow-ups line says, and what opens its follow-ups when there are any. */
interface Counted { words: string; open: (() => void) | null }

/** A meeting's follow-ups line, once counted: by status, or how its check stands; it opens the meeting's list when it has any. */
export function meetingFollowUps(line: ItemsLine, title: string): Counted | null {
  if (!line.summary) return null;
  const record = lineRecord(line);
  return { words: followUpsWords(line.summary, line.stage), open: summaryTotal(line.summary) > 0 && record !== null ? () => void openFollowUps('record', record, title) : null };
}

/** "Follow-ups · 1 open · 4 not sent": one button that opens them, or the words alone. */
export function FollowUpsLabel({ words, open, class: name, testid }: Counted & { class: string; testid?: string }) {
  const label = <><b>Follow-ups</b> <span class="faint">· {words}</span></>;
  return open ? <button type="button" class={name} data-testid={testid} onClick={open}>{label}</button> : <span class={name} data-testid={testid}>{label}</span>;
}

/**
 * Where an approved meeting's check stands (runs store and impact card v1,
 * section 5; follow-ups thread v1): queued or running; failed, with why and
 * Try again; or done, with the meeting's follow-ups counted in one line
 * ("Follow-ups · 4 not sent"), the whole line opening its list when it has
 * any. A meeting sent to several destinations has a record, and so a check,
 * for each: `label` names the destination.
 */
export function ImpactSection({ run, busy, followUps, onRetry, label }: {
  run: PersonRunV1 | undefined;
  busy: boolean;
  /** The meeting's follow-ups counted, once read, and what opens them when there are any. */
  followUps: Counted | null;
  onRetry(): void;
  label?: string;
}) {
  const name = label === undefined ? 'Impact' : `Impact · ${label}`;
  return <section class="impact" aria-label={name}>
    <div class="impact-head">
      <h4 class="section-label">{name}</h4>
      {(run === undefined || run.state === 'pending') && <span class="notice-line">Check queued</span>}
      {run?.state === 'running' && <span class="asking"><i /><i /><i /><span>Checking what this changes · a few minutes</span></span>}
    </div>
    {run?.state === 'failed' && <div class="choices start">
      <span class="error">{REASONS[run.error_code ?? 'research_failed']}</span>
      <button type="button" class="link-button" disabled={busy} onClick={onRetry}>Try again</button>
    </div>}
    {run?.state === 'done' && followUps && <FollowUpsLabel {...followUps} class="impact-follow-ups" testid="impact-follow-ups" />}
  </section>;
}
