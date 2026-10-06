import { useEffect, useRef, useState } from 'preact/hooks';
import type { PersonMeetingHomeV1, PersonMeetingResultsV1, PersonMeetingReviewV1 } from '@echo-brain/organization-api';
import { loadProjects, meetingCommand, useStore } from '../store.js';

/** Provider browsing is transient. Only checked retention actions enter ECHO. */
export function Meetings() {
  const state = useStore();
  const alive = useRef(true);
  const [home, setHome] = useState<PersonMeetingHomeV1 | null>(null);
  const [reviews, setReviews] = useState<readonly PersonMeetingReviewV1[]>([]);
  const [meetings, setMeetings] = useState<PersonMeetingResultsV1['browse']['meetings']>([]);
  const [preview, setPreview] = useState<PersonMeetingResultsV1['open'] | null>(null);
  const [review, setReview] = useState<(PersonMeetingResultsV1['review_open'] & { command: string }) | null>(null);
  const [folder, setFolder] = useState(''), [project, setProject] = useState(''), [reviewProject, setReviewProject] = useState('');
  const [retain, setRetain] = useState(false), [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  async function refresh(initialize = false) {
    const [next, pending] = await Promise.all([meetingCommand({ operation: 'home' }), meetingCommand({ operation: 'reviews' })]);
    if (!alive.current) return;
    setHome(next); setReviews(pending.reviews);
    const watch = next.sources.find(s => s.folder_id !== null);
    if (watch && initialize) { setFolder(watch.folder_id!); setProject(watch.project_id!); }
  }
  async function run(work: () => Promise<void>) {
    if (busy) return; setBusy(true); setNotice('');
    try { await work(); } catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : 'Meeting request failed.'); }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void run(() => refresh(true)); return () => { alive.current = false; }; }, []);
  const projects = state.projects.items;
  const audience = (value: string, change: (value: string) => void) => <><label>Save to <select value={value} disabled={busy} onChange={e => change(e.currentTarget.value)}>
    <option value="">Only me</option>{projects.map(p => <option value={p.project_id}>{p.name}</option>)}
  </select></label>{state.projects.next && <button class="plain-button small" disabled={busy || state.projects.loading} onClick={() => void loadProjects(true)}>More projects</button>}</>;
  const watch = home?.sources.find(s => s.folder_id !== null);
  return <section class="personal-meetings" aria-label="Personal meetings" aria-busy={busy}>
    <div class="choices start"><h3>Your meetings</h3><button class="plain-button small" disabled={busy} onClick={() => void run(refresh)}>Refresh</button></div>
    {notice && <p role="status">{notice}</p>}
    {busy && <p class="context">Working…</p>}
    {home && <>
      <p>{home.connected ? `${home.email} · ${home.workspace}` : 'Reconnect Granola to browse and import meetings.'}</p>
      {watch && <p>Automatic import: {home.folders.find(f => f.id === watch.folder_id)?.title ?? 'Selected folder'} → {projects.find(p => p.project_id === watch.project_id)?.name ?? 'Selected project'}.
        <button class="plain-button small" disabled={busy} onClick={() => void run(async () => { await meetingCommand({ operation: 'watch', folder_id: null, project_id: null, settings_sha256: home.settings_sha256, retain: true }); await refresh(); })}>Stop automatic import</button></p>}
      {home.sources.map(s => <div key={s.source_key}>
        {s.error && <p class="error">{s.error}</p>}
        {s.checked_at && <p class="context">Last checked {new Date(s.checked_at).toLocaleString()}</p>}
        {s.pending_imports.map(id => <p key={id}>Import queued <button class="plain-button small" disabled={busy} onClick={() => void run(async () => { await meetingCommand({ operation: 'cancel_import', source_key: s.source_key, meeting_id: id }); await refresh(); })}>Cancel</button></p>)}
      </div>)}
      {home.connected && <>
        <label>Granola folder <select value={folder} disabled={busy} onChange={e => { setFolder(e.currentTarget.value); setMeetings([]); setPreview(null); setRetain(false); }}>
          <option value="">Choose a folder</option>{home.folders.map(f => <option value={f.id}>{f.title} ({f.count})</option>)}
        </select></label>
        <button class="plain-button small" disabled={busy || !folder} onClick={() => void run(async () => { const result = await meetingCommand({ operation: 'browse', folder_id: folder }); if (alive.current) setMeetings(result.meetings); })}>Browse meetings</button>
        <p class="context">Browsing does not save meeting content in ECHO.</p>
        {audience(project, setProject)}
        <label><input type="checkbox" checked={retain} disabled={busy} onChange={e => setRetain(e.currentTarget.checked)} /> I allow ECHO to retain notes and transcripts and process this import. Project members can read imported notes; transcripts stay private until explicitly shared at approval.</label>
        <button class="primary-button small" disabled={busy || !folder || !project || !retain} onClick={() => void run(async () => {
          await meetingCommand({ operation: 'watch', folder_id: folder, project_id: project, settings_sha256: home.settings_sha256, retain: true });
          await refresh(); if (alive.current) setNotice('Automatic import is ready. New, moved, or edited meetings will enter ECHO. Existing history stays in Granola until you import it.');
        })}>Use folder for automatic import</button>
        <p class="context">Checks about every five minutes. This folder can contain up to 50 meetings.</p>
        <ul>{meetings.map(m => <li key={m.id}><button class="plain-button" disabled={busy} onClick={() => void run(async () => {
          const result = await meetingCommand({ operation: 'open', meeting_id: m.id }); if (alive.current) { setPreview(result); setReview(null); setRetain(false); }
        })}>{m.title}</button> <small>{m.date}</small></li>)}</ul>
        {preview && <article><h4>{preview.title}</h4><pre>{preview.notes}</pre><pre>{preview.summary}</pre>{preview.truncated && <p>Preview shortened. Import retains the full meeting.</p>}
          <button class="primary-button small" disabled={busy || !retain} onClick={() => void run(async () => {
            await meetingCommand({ operation: 'import', meeting_id: preview.id, project_id: project || null, retain: true }); await refresh(); if (alive.current) setNotice('Import queued. Review the result below after processing.');
          })}>Add to ECHO</button></article>}
      </>}
    </>}
    <h3>Review</h3><p>You approve these meetings in ECHO. A Slack connection is not required.</p>
    <ul>{reviews.map(item => <li key={item.approval_id}><button class="plain-button" disabled={busy} onClick={() => void run(async () => {
      const result = await meetingCommand({ operation: 'review_open', approval_id: item.approval_id });
      if (alive.current) { setReview({ ...result, command: crypto.randomUUID() }); setReviewProject(result.review.project_id ?? ''); setShare(false); setPreview(null); }
    })}>{item.title}</button> · {item.status}</li>)}</ul>
    {review && <article><h4>{review.review.title}</h4><pre>{review.content}</pre>
      {review.review.status === 'pending' && <>{audience(reviewProject, setReviewProject)}
        <label><input type="checkbox" checked={share} disabled={busy} onChange={e => setShare(e.currentTarget.checked)} /> Share the transcript with the selected audience</label>
        <div class="choices">{(['reject', 'approve'] as const).map(action => <button class={action === 'approve' ? 'primary-button small' : 'plain-button'} disabled={busy} onClick={() => void run(async () => {
          const result = await meetingCommand({ operation: 'review', approval_id: review.review.approval_id, command_id: review.command, snapshot_sha256: review.snapshot_sha256,
            action, project_id: action === 'approve' ? reviewProject || null : null, share_transcript: action === 'approve' && share });
          if (alive.current) { setReview(null); setNotice(result.status === 'publishing' ? 'Approved. Publishing to ECHO…' : result.status); } await refresh();
        })}>{action === 'approve' ? 'Approve' : 'Reject'}</button>)}</div>
      </>}
    </article>}
  </section>;
}
