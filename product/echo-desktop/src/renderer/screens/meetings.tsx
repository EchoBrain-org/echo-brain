import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PersonMeetingHomeV2, PersonMeetingResultsV2, PersonMeetingWatchV2 } from '@echo-brain/organization-api';
import { dateTime } from '../format.js';
import { loadHome, loadProjects, meetingCommand, useStore } from '../store.js';
import { Passage } from './ask.js';
import { Calendar, Caret } from './icons.js';

/** A meeting's day, "Oct 6", from the date Granola gives it: the day its own label states, not that day in UTC. */
function day(date: string): string {
  const label = /^([A-Z][a-z]{2} \d{1,2}),/.exec(date)?.[1];
  if (label !== undefined) return label;
  const time = Date.parse(date);
  return Number.isNaN(time) ? date : new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** A labelled select, in the sheet's style, named by its label alone (not its options' text). */
function Select({ label, value, disabled, onChange, children }: {
  label: string; value: string; disabled: boolean; onChange(value: string): void; children: ComponentChildren;
}) {
  return (
    <label class="select-field">
      <span class="select-label">{label}</span>
      <span class="select-wrap">
        <select class="field small" aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.currentTarget.value)}>{children}</select>
        <Caret />
      </span>
    </label>
  );
}

/**
 * Granola: what ECHO imports by itself (nothing, the meetings you captured, or one folder), and any meeting you add by
 * hand. Browsing never saves meeting content; only Add to ECHO and automatic import do, with your consent given once.
 * Imported meetings stay yours until you approve items from them: a suggested project only pre-ticks where they go.
 */
export function Meetings() {
  const state = useStore();
  const alive = useRef(true);
  const [home, setHome] = useState<PersonMeetingHomeV2 | null>(null);
  const [meetings, setMeetings] = useState<PersonMeetingResultsV2['browse']['meetings']>([]);
  const [preview, setPreview] = useState<PersonMeetingResultsV2['open'] | null>(null);
  // Automatic import: what it watches, its folder, and the project it suggests.
  const [mode, setMode] = useState<PersonMeetingWatchV2>('off'), [watchFolder, setWatchFolder] = useState(''), [suggest, setSuggest] = useState('');
  // One meeting by hand: from your recent meetings ('') or a folder, and the project it suggests.
  const [from, setFrom] = useState(''), [project, setProject] = useState('');
  const [retain, setRetain] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  /** Your recent meetings, or one folder's, newest first. */
  async function browse(folder: string) {
    setMeetings([]); setPreview(null);
    const result = await meetingCommand({ operation: 'browse', folder_id: folder || null });
    if (alive.current) setMeetings(result.meetings);
  }
  async function refresh(initialize = false) {
    const next = await meetingCommand({ operation: 'home' }).catch((error: unknown) => { setHome(null); throw error; });
    if (!alive.current) return;
    setHome(next);
    if (initialize && next.connected) {
      try { await browse(''); } catch { /* the list can be read again */ }
    }
  }
  async function run(work: () => Promise<void>) {
    if (busy) return; setBusy(true); setNotice('');
    try { await work(); } catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : 'Meeting request failed.'); }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true; void run(() => refresh(true));
    return () => { alive.current = false; };
  }, []);

  const projects = state.projects.items;
  const projectName = (id: string | null) => projects.find(p => p.project_id === id)?.name ?? 'Selected project';
  const projectOptions = projects.map(p => <option key={p.project_id} value={p.project_id}>{p.name}</option>);
  const moreProjects = state.projects.next && <button type="button" class="link-button" disabled={busy || state.projects.loading} onClick={() => void loadProjects(true)}>More projects</button>;
  const watch = home?.sources.find(s => s.watch !== 'off');
  const watchLine = !watch ? '' : [
    watch.watch === 'folder' ? `${home?.folders.find(f => f.id === watch.folder_id)?.title ?? 'Selected'} folder` : 'My meetings',
    watch.project_id !== null ? `suggests ${projectName(watch.project_id)}` : '',
    !watch.baseline ? 'Preparing' : watch.checked_at ? `Checked ${dateTime(watch.checked_at)}` : 'Active',
  ].filter(part => part !== '').join(' · ');

  const saveWatch = () => void run(async () => {
    await meetingCommand({ operation: 'watch', watch: mode, folder_id: mode === 'folder' ? watchFolder : null, project_id: suggest || null, settings_sha256: home!.settings_sha256, retain: true });
    await refresh(); if (alive.current) setNotice('Saved. New meetings come in by themselves.');
  });
  const stopWatch = () => void run(async () => {
    await meetingCommand({ operation: 'watch', watch: 'off', folder_id: null, project_id: null, settings_sha256: home!.settings_sha256, retain: true });
    await refresh(); if (alive.current) setMode('off');
  });

  return <section class="personal-meetings" aria-label="Personal meetings" aria-busy={busy}>
    <div class="meetings-sub">
      <span class="notice-line">{home === null ? (busy ? '' : 'Granola could not be reached.') : home.connected ? `${home.email} · ${home.workspace}` : 'Reconnect Granola to browse and import meetings.'}</span>
      {busy ? <span class="asking"><i /><i /><i /><span>Working…</span></span>
        : <button type="button" class="link-button" onClick={() => void run(refresh)}>Refresh</button>}
    </div>
    {notice && <div class="meetings-status" role="status">{notice}</div>}

    {/* Automatic import, or one meeting by hand. Consent is given once, for both. */}
    {home?.connected && <>
      <div class="section-label">Automatic import</div>
      {watch ? (
        <div class="watch-row" data-testid="meeting-watch">
          <span class="item-icon" aria-hidden="true"><Calendar /></span>
          <span class="lines"><span class="name">{watchLine}</span></span>
          <button type="button" class="link-button" disabled={busy} onClick={stopWatch}>Stop</button>
        </div>
      ) : (
        <div class="meeting-controls thirds" role="group" aria-label="Automatic import">
          <Select label="Import" value={mode} disabled={busy} onChange={value => setMode(value as PersonMeetingWatchV2)}>
            <option value="off">Off</option><option value="mine">My meetings</option><option value="folder">One folder</option>
          </Select>
          {mode === 'folder' && <Select label="Folder" value={watchFolder} disabled={busy} onChange={setWatchFolder}>
            <option value="">Choose a folder</option>{home.folders.map(f => <option key={f.id} value={f.id}>{f.title}</option>)}
          </Select>}
          {mode !== 'off' && <><Select label="Suggest" value={suggest} disabled={busy} onChange={setSuggest}><option value="">None</option>{projectOptions}</Select>{moreProjects}</>}
        </div>
      )}
      {home.sources.map(s => <div key={s.source_key} class="source-notes">
        {s.error && <div class="error">{s.error}</div>}
        {s.pending_imports.map(id => <div key={id} class="notice-line">Import queued
          <button type="button" class="link-button" disabled={busy} onClick={() => void run(async () => { await meetingCommand({ operation: 'cancel_import', source_key: s.source_key, meeting_id: id }); await refresh(); })}>Cancel</button></div>)}
      </div>)}
      <label class="check consent"><input type="checkbox" checked={retain} disabled={busy} onChange={e => setRetain(e.currentTarget.checked)} />
        <span>I allow ECHO to retain notes and transcripts from these meetings and process them.</span></label>
      <div class="notice-line">Imported meetings stay private until you approve items from them.</div>
      {!watch && mode !== 'off' && <div class="choices start">
        <button type="button" class="plain-button small" disabled={busy || !retain || (mode === 'folder' && !watchFolder)} onClick={saveWatch}>Save</button>
      </div>}

      <div class="section-label">Add one meeting</div>
      <div class="meeting-controls" role="group" aria-label="Add one meeting">
        <Select label="From" value={from} disabled={busy} onChange={value => { setFrom(value); void run(() => browse(value)); }}>
          <option value="">Recent meetings</option>{home.folders.map(f => <option key={f.id} value={f.id}>{f.title} ({f.count})</option>)}
        </Select>
        <Select label="Suggest" value={project} disabled={busy} onChange={setProject}><option value="">None</option>{projectOptions}</Select>
        {moreProjects}
      </div>
      {!busy && meetings.length === 0 && <div class="notice-line">No meetings.</div>}
      <div class="meeting-list">
        {meetings.map(m => {
          const open = preview?.id === m.id;
          return <button type="button" key={m.id} class={`row item-row meeting-row${open ? ' current' : ''}`} disabled={busy} aria-expanded={open} aria-label={m.title} onClick={() => void run(async () => {
            const result = await meetingCommand({ operation: 'open', meeting_id: m.id }); if (alive.current) setPreview(result);
          })}>
            <span class="item-icon" aria-hidden="true"><Calendar /></span>
            <span class="name">{m.title}</span>
            <span class="meta">{day(m.date)}</span>
          </button>;
        })}
      </div>
      {preview && <article class="meeting-card" aria-label={preview.title}>
        <div class="meeting-card-head"><h3>{preview.title}</h3></div>
        {preview.notes && <div class="passage selectable"><Passage text={preview.notes} label="" /></div>}
        {preview.summary && <div class="passage selectable"><Passage text={preview.summary} label="" /></div>}
        {preview.truncated && <div class="notice-line">Preview shortened. Add to ECHO keeps the full meeting.</div>}
        <div class="choices start">
          <button type="button" class="primary-button small" disabled={busy || !retain} onClick={() => void run(async () => {
            await meetingCommand({ operation: 'import', meeting_id: preview.id, project_id: project || null, retain: true }); await refresh();
            if (alive.current) { setPreview(null); setNotice('Added. Its decisions and actions reach Home once processed.'); void loadHome(); }
          })}>Add to ECHO</button>
          <span class="notice-line">{[project ? `Suggests ${projectName(project)}` : '', retain ? '' : 'Allow retention above first'].filter(part => part !== '').join(' · ')}</span>
        </div>
      </article>}
    </>}
  </section>;
}
