import { useEffect, useRef, useState } from 'preact/hooks';
import { MAX_PASTED_MEETING_BYTES, pastedMeetingAsSent, type ConnectedTool, type PastedMeeting } from '../../shared/protocol.js';
import { closeSheet, getState, handInMeeting, loadHome, loadProjects, onAccountGone, useStore } from '../store.js';
import { trapTab } from './compose.js';
import { Caret, Close } from './icons.js';

/** The sheet's fields as typed, and what the last Add said. */
interface Draft {
  title: string; date: string; time: string; notes: string; transcript: string;
  /** The transcript field shows: asked for, or holding text. */
  transcriptShown: boolean;
  project: string; retain: boolean;
  status: 'idle' | 'adding' | 'added' | 'failed'; failure: string;
}
const EMPTY: Draft = { title: '', date: '', time: '', notes: '', transcript: '', transcriptShown: false, project: '', retain: false, status: 'idle', failure: '' };
/**
 * The draft lives beside the sheet, not in it: the privacy cover takes the sheet away while another app is in front,
 * which is where the text is copied from, and it must come back as it was. It goes when the sheet closes, and with its
 * account (forgotten, switched or signed out), under the cover too.
 */
let draft: Draft = EMPTY;
/** Counts the sheet's closings: an Add's answer that comes after its sheet closed, or its account went, changes nothing. */
let closings = 0;
/** The sheet on screen re-renders when an Add it started settles, even one started before a cover. */
let shown: (() => void) | null = null;
function update(patch: Partial<Draft>): void {
  draft = { ...draft, ...patch };
  shown?.();
}
onAccountGone(() => { draft = EMPTY; closings += 1; });

/** No time, a whole day, or a start in this computer's time zone; null for a start that is not a real time. */
function when(date: string, time: string): Pick<PastedMeeting, 'date' | 'started_at'> | null {
  if (date === '') return {};
  if (time === '') return { date };
  const start = new Date(`${date}T${time}`);
  return Number.isNaN(start.getTime()) ? null : { started_at: start.toISOString() };
}

async function add(): Promise<void> {
  const time = when(draft.date, draft.time);
  if (time === null || draft.status === 'adding') return;
  const meeting: PastedMeeting = { title: draft.title, notes: draft.notes, transcript: draft.transcript, ...time };
  const mine = closings;
  update({ status: 'adding', failure: '' });
  try {
    await handInMeeting(meeting, draft.project || null);
    if (mine !== closings) return;
    // The same meeting again is the same meeting, so what was added clears; the project and the consent stay.
    update({ ...EMPTY, project: draft.project, retain: draft.retain, status: 'added' });
    void loadHome();
  } catch (error) {
    if (mine !== closings) return;
    update({ status: 'failed', failure: error instanceof Error ? error.message : 'Something went wrong. Try again.' });
  }
}

/**
 * Paste a meeting from any tool: a title, an optional date and time, notes, an optional transcript and an optional
 * suggested project. It enters your private custody; once processed, any decisions and actions wait on Home like any
 * meeting's.
 */
export function PasteMeeting({ tool }: { tool: ConnectedTool }) {
  const state = useStore();
  const [, render] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLInputElement>(null);
  useEffect(() => {
    shown = () => render(count => count + 1);
    title.current?.focus();
    return () => {
      shown = null;
      // Covered, the sheet comes back as it was; closed, its draft goes.
      const sheet = getState().sheet;
      if (sheet?.kind !== 'tool-manage' || sheet.tool.tool_id !== tool.tool_id) { draft = EMPTY; closings += 1; }
    };
  }, []);
  const busy = draft.status === 'adding';
  const time = when(draft.date, draft.time);
  // Measured as the client sends it, canonical and with its time, so the page refuses what the meetings API would and no more.
  const sent = pastedMeetingAsSent({ title: draft.title, notes: draft.notes, transcript: draft.transcript, ...(time ?? {}) }, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const tooLong = new TextEncoder().encode(JSON.stringify(sent)).length > MAX_PASTED_MEETING_BYTES;
  const ready = sent.title !== '' && (sent.notes !== '' || sent.transcript !== '') && draft.retain && time !== null && !tooLong && !busy;
  const projects = state.projects.items;
  const line = busy ? 'Adding…' : tooLong ? 'Too long to add: up to 60 KB of text.' : draft.status === 'added' ? 'Added.' : '';
  return (
    <div class="overlay" onClick={() => { if (!busy) closeSheet(); }}>
      <div class="sheet confirm paste" role="dialog" aria-labelledby="paste-title" aria-busy={busy} data-testid="paste-sheet" ref={box} tabIndex={-1}
        onClick={event => event.stopPropagation()} onKeyDown={event => trapTab(event, box.current)}>
        <div class="sheet-head">
          <h2 id="paste-title">{tool.name}</h2>
          <button type="button" class="circle small" aria-label="Close" onClick={closeSheet} disabled={busy}><Close /></button>
        </div>
        <div class="sheet-scroll paste-form">
          <label class="select-field"><span class="select-label">Title</span>
            <input class="field small" ref={title} value={draft.title} maxLength={200} disabled={busy} onInput={event => update({ title: event.currentTarget.value, status: 'idle' })} /></label>
          <div class="paste-when">
            <label class="select-field"><span class="select-label">Date</span>
              <input class="field small" type="date" value={draft.date} disabled={busy}
                onInput={event => update({ date: event.currentTarget.value, ...(event.currentTarget.value === '' ? { time: '' } : {}), status: 'idle' })} /></label>
            <label class="select-field"><span class="select-label">Time</span>
              <input class="field small" type="time" value={draft.time} disabled={busy || draft.date === ''} onInput={event => update({ time: event.currentTarget.value, status: 'idle' })} /></label>
          </div>
          <label class="select-field"><span class="select-label">Notes</span>
            <textarea class="field" rows={8} value={draft.notes} disabled={busy} onInput={event => update({ notes: event.currentTarget.value, status: 'idle' })} /></label>
          {draft.transcriptShown || draft.transcript !== ''
            ? <label class="select-field"><span class="select-label">Transcript</span>
              <textarea class="field" rows={8} value={draft.transcript} disabled={busy} onInput={event => update({ transcript: event.currentTarget.value, status: 'idle' })} /></label>
            : <button type="button" class="link-button" aria-expanded={false} disabled={busy} onClick={() => update({ transcriptShown: true })}>Add a transcript</button>}
          <label class="select-field"><span class="select-label">Suggest project</span>
            <span class="select-wrap">
              <select class="field small" value={draft.project} disabled={busy} onChange={event => update({ project: event.currentTarget.value })}>
                <option value="">None</option>{projects.map(project => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}
              </select>
              <Caret />
            </span>
          </label>
          {state.projects.next && <button type="button" class="link-button" disabled={busy || state.projects.loading} onClick={() => void loadProjects(true)}>More projects</button>}
          <label class="check consent"><input type="checkbox" checked={draft.retain} disabled={busy} onChange={event => update({ retain: event.currentTarget.checked })} />
            <span>I allow ECHO to retain this meeting's notes and transcript and process them.</span></label>
        </div>
        {draft.status === 'failed' && <p class="error" role="alert">{draft.failure}</p>}
        <div class="choices between">
          <span class="notice-line" role="status">{line}</span>
          <button type="button" class="primary-button small" disabled={!ready} onClick={() => void add()}>Add</button>
        </div>
      </div>
    </div>
  );
}
