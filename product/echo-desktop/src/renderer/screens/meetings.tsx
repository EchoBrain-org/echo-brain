import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PersonMeetingHomeV2, PersonMeetingResultsV2 } from '@echo-brain/organization-api';
import { dateTime } from '../format.js';
import { loadHome, loadProjects, meetingCommand, useStore } from '../store.js';
import { Passage } from './ask.js';
import { Calendar, Caret } from './icons.js';

/** A meeting's day, "Oct 6", from the date Granola gives it. */
function day(date: string): string {
  const time = Date.parse(date);
  return Number.isNaN(time) ? date : new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** A labelled select, in the sheet's style. */
function Select({ label, value, disabled, onChange, children }: {
  label: string; value: string; disabled: boolean; onChange(value: string): void; children: ComponentChildren;
}) {
  return (
    <label class="select-field">
      <span class="select-label">{label}</span>
      <span class="select-wrap">
        <select class="field small" value={value} disabled={disabled} onChange={event => onChange(event.currentTarget.value)}>{children}</select>
        <Caret />
      </span>
    </label>
  );
}

/**
 * Granola: the folder ECHO watches, and any meeting you add by hand. Browsing
 * never saves meeting content; only Add to ECHO and the folder watch do, with
 * your consent given once. Decisions from added meetings reach Home.
 */
export function Meetings() {
  const state = useStore();
  const alive = useRef(true);
  const [home, setHome] = useState<PersonMeetingHomeV2 | null>(null);
  const [meetings, setMeetings] = useState<PersonMeetingResultsV2['browse']['meetings']>([]);
  const [preview, setPreview] = useState<PersonMeetingResultsV2['open'] | null>(null);
  const [folder, setFolder] = useState(''), [project, setProject] = useState('');
  const [retain, setRetain] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  /** The folder's meetings, newest first, as soon as it is chosen. */
  async function browse(folder_id: string) {
    setMeetings([]); setPreview(null);
    if (!folder_id) return;
    const result = await meetingCommand({ operation: 'browse', folder_id });
    if (alive.current) setMeetings(result.meetings);
  }
  async function refresh(initialize = false) {
    const next = await meetingCommand({ operation: 'home' }).catch((error: unknown) => { setHome(null); throw error; });
    if (!alive.current) return;
    setHome(next);
    const watch = next.sources.find(s => s.folder_id !== null);
    if (watch && initialize) {
      setFolder(watch.folder_id!); setProject(watch.folder_project_id!);
      try { await browse(watch.folder_id!); } catch { /* the list can be read again */ }
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
  const watch = home?.sources.find(s => s.folder_id !== null);
  const watchFolder = watch ? home?.folders.find(f => f.id === watch.folder_id)?.title ?? 'Selected folder' : '';
  const savedTo = project ? projectName(project) : 'Only me';

  const stopWatch = () => void run(async () => {
    await meetingCommand({ operation: 'watch', folder_id: null, project_id: null, settings_sha256: home!.settings_sha256, retain: true });
    await refresh();
  });

  return <section class="personal-meetings" aria-label="Personal meetings" aria-busy={busy}>
    <div class="meetings-sub">
      <span class="notice-line">{home === null ? (busy ? '' : 'Granola could not be reached.') : home.connected ? `${home.email} · ${home.workspace}` : 'Reconnect Granola to browse and import meetings.'}</span>
      {busy ? <span class="asking"><i /><i /><i /><span>Working…</span></span>
        : <button type="button" class="link-button" onClick={() => void run(refresh)}>Refresh</button>}
    </div>
    {notice && <div class="meetings-status" role="status">{notice}</div>}

    {/* Add: the folder ECHO watches, or one meeting by hand. Consent is given once, for both. */}
    {home?.connected && <>
      <div class="section-label">Add meetings</div>
      {watch && (
        <div class="watch-row" data-testid="meeting-watch">
          <span class="item-icon" aria-hidden="true"><Calendar /></span>
          <span class="lines">
            <span class="name">{watchFolder} → {projectName(watch.folder_project_id)}</span>
            <span class="detail">{watch.baseline ? 'Automatic import active' : 'Preparing automatic import'}{watch.checked_at ? ` · Checked ${dateTime(watch.checked_at)}` : ''} · Checks about every five minutes</span>
          </span>
          <button type="button" class="link-button" disabled={busy} onClick={stopWatch}>Stop</button>
        </div>
      )}
      <div class="meeting-controls">
        <Select label="Granola folder" value={folder} disabled={busy} onChange={value => { setFolder(value); void run(() => browse(value)); }}>
          <option value="">Choose a folder</option>{home.folders.map(f => <option key={f.id} value={f.id}>{f.title} ({f.count})</option>)}
        </Select>
        <Select label="Save to" value={project} disabled={busy} onChange={setProject}>
          <option value="">Only me</option>{projects.map(p => <option key={p.project_id} value={p.project_id}>{p.name}</option>)}
        </Select>
        {state.projects.next && <button type="button" class="link-button" disabled={busy || state.projects.loading} onClick={() => void loadProjects(true)}>More projects</button>}
      </div>
      {home.sources.map(s => <div key={s.source_key} class="source-notes">
        {s.error && <div class="error">{s.error}</div>}
        {s.pending_imports.map(id => <div key={id} class="notice-line">Import queued
          <button type="button" class="link-button" disabled={busy} onClick={() => void run(async () => { await meetingCommand({ operation: 'cancel_import', source_key: s.source_key, meeting_id: id }); await refresh(); })}>Cancel</button></div>)}
      </div>)}
      <label class="check consent"><input type="checkbox" checked={retain} disabled={busy} onChange={e => setRetain(e.currentTarget.checked)} />
        <span>I allow ECHO to retain notes and transcripts from these meetings and process them.</span></label>
      <div class="notice-line">Project members can read imported notes. Transcripts stay private until you share them at approval. Browsing saves nothing.</div>
      {!watch && <div class="choices start">
        <button type="button" class="plain-button small" disabled={busy || !folder || !project || !retain} onClick={() => void run(async () => {
          await meetingCommand({ operation: 'watch', folder_id: folder, project_id: project, settings_sha256: home.settings_sha256, retain: true });
          await refresh(); if (alive.current) setNotice('Folder saved. New meetings in it are imported by themselves; existing ones you add below.');
        })}>Use folder for automatic import</button>
        <span class="notice-line">Up to 50 meetings in the folder.</span>
      </div>}
      {folder && !busy && meetings.length === 0 && <div class="notice-line">No meetings in this folder.</div>}
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
            if (alive.current) { setPreview(null); setNotice('Added. It reaches Home once processed.'); void loadHome(); }
          })}>Add to ECHO</button>
          <span class="notice-line">Saved to {savedTo}{!retain ? ' · Allow retention above first' : ''}</span>
        </div>
      </article>}
    </>}
  </section>;
}
