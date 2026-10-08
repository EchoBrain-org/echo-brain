import { useEffect, useRef, useState } from 'preact/hooks';
import type { PersonMeetingHomeV2, PersonMeetingResultsV2, PersonMeetingReviewV2, PersonRunV1 } from '@echo-brain/organization-api';
import { MAX_CAPTURE_PROJECTS, type ImpactView, type ProjectSummary } from '../../shared/protocol.js';
import { loadProjects, meetingCommand, runsCommand, useStore } from '../store.js';
import { ImpactSection } from './impact-card.js';
import { ProjectPicker } from './project-picker.js';

/** How often an open sheet looks again while an impact check is going. */
const RUN_POLL_MS = 5_000;

type ReviewState = Omit<PersonMeetingResultsV2['review_open'], 'owners'> & {
  readonly command: string;
  readonly audience: 'only-me' | 'projects';
  readonly project_ids: readonly string[];
  readonly owners: readonly { readonly signal_id: string; readonly action: string; readonly owner: string }[];
};

function decisionStatus(review: PersonMeetingReviewV2): string {
  if (review.decided_on === null) return review.status;
  const action = review.status === 'rejected' ? 'Rejected' : 'Approved';
  return `${review.status} · ${action} ${review.decided_on === 'slack' ? 'in Slack' : 'on the desktop'}`;
}

function reviewProjects(projects: readonly ProjectSummary[], suggested: ReviewState['suggested_projects']): readonly ProjectSummary[] {
  const choices = new Map(projects.map(project => [project.project_id, project]));
  for (const project of suggested) if (!choices.has(project.project_id)) {
    choices.set(project.project_id, { ...project, role: 'member', created_at: '', status: 'active' });
  }
  return [...choices.values()];
}

/** Provider browsing is transient. Only checked retention actions enter ECHO. */
export function Meetings() {
  const state = useStore();
  const alive = useRef(true);
  const [home, setHome] = useState<PersonMeetingHomeV2 | null>(null);
  const [reviews, setReviews] = useState<readonly PersonMeetingReviewV2[]>([]);
  const [meetings, setMeetings] = useState<PersonMeetingResultsV2['browse']['meetings']>([]);
  const [preview, setPreview] = useState<PersonMeetingResultsV2['open'] | null>(null);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [folder, setFolder] = useState(''), [project, setProject] = useState('');
  const [retain, setRetain] = useState(false), [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [runs, setRuns] = useState<readonly PersonRunV1[]>([]);
  const [impact, setImpact] = useState<{ readonly run_id: string; readonly view: ImpactView | null } | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null), runsSeq = useRef(0);
  /**
   * Your impact checks: list them, start the oldest queued one when none is
   * going, and look again every five seconds while one is. A check that cannot
   * start (no model on this server) stays queued, quietly.
   */
  async function checkRuns() {
    const mine = ++runsSeq.current;
    if (poll.current) { clearTimeout(poll.current); poll.current = null; }
    const current = () => alive.current && mine === runsSeq.current;
    try {
      const listed = (await runsCommand({ schema_version: 1, operation: 'list' })).runs;
      if (!current()) return;
      setRuns(listed);
      let again = listed.some(item => item.state === 'running');
      const queued = [...listed].reverse().find(item => item.state === 'pending');
      if (!again && queued) {
        const started = await runsCommand({ schema_version: 1, operation: 'start', run_id: queued.run_id });
        if (!current()) return;
        if (started.state === 'running') setRuns(items => items.map(item => item.run_id === queued.run_id ? { ...item, state: 'running' } : item));
        // Whatever the start found, the next list shows where the check is.
        again = true;
      }
      if (again) poll.current = setTimeout(() => void checkRuns(), RUN_POLL_MS);
    } catch { /* runs are optional: the sheet works without them */ }
  }
  async function openReview(approval_id: string) {
    const result = await meetingCommand({ operation: 'review_open', approval_id });
    if (alive.current) {
      setReview({ ...result, command: crypto.randomUUID(), audience: result.suggested_projects.length > 0 ? 'projects' : 'only-me',
        project_ids: result.suggested_projects.map(project => project.project_id),
        owners: result.owners.map(owner => ({ signal_id: owner.signal_id, action: owner.action, owner: owner.proposed })) });
      // Every opening shows the card rebuilt for you now.
      setImpact(null); setShare(false); setPreview(null);
    }
  }
  async function refresh(initialize = false) {
    void checkRuns();
    const [next, pending] = await Promise.allSettled([meetingCommand({ operation: 'home' }), meetingCommand({ operation: 'reviews' })]);
    if (!alive.current) return;
    // Provider browsing and retained review have independent availability.
    setHome(next.status === 'fulfilled' ? next.value : null);
    setReviews(pending.status === 'fulfilled' ? pending.value.reviews : []);
    const watch = next.status === 'fulfilled' ? next.value.sources.find(s => s.folder_id !== null) : undefined;
    if (watch && initialize) { setFolder(watch.folder_id!); setProject(watch.folder_project_id!); }
    if (next.status === 'rejected') throw next.reason;
    if (pending.status === 'rejected') throw pending.reason;
  }
  async function run(work: () => Promise<void>) {
    if (busy) return; setBusy(true); setNotice('');
    try { await work(); } catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : 'Meeting request failed.'); }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true; void run(() => refresh(true));
    return () => { alive.current = false; if (poll.current) clearTimeout(poll.current); };
  }, []);
  const decided = review !== null && (review.review.status === 'approved' || review.review.status === 'publishing');
  const reviewRun = decided ? runs.find(item => item.event_ref === review.review.approval_id) : undefined;
  useEffect(() => {
    if (reviewRun?.state !== 'done' || impact?.run_id === reviewRun.run_id) return;
    const run_id = reviewRun.run_id;
    runsCommand({ schema_version: 1, operation: 'view', run_id }).then(
      view => { if (alive.current) setImpact({ run_id, view }); },
      () => { if (alive.current) setImpact({ run_id, view: null }); });
  }, [reviewRun?.run_id, reviewRun?.state, impact?.run_id]);
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
      {watch && <p>{watch.baseline ? 'Automatic import active:' : 'Preparing automatic import:'} {home.folders.find(f => f.id === watch.folder_id)?.title ?? 'Selected folder'} → {projects.find(p => p.project_id === watch.folder_project_id)?.name ?? 'Selected project'}.
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
          await refresh(); if (alive.current) setNotice('Folder saved. Existing history stays in Granola until you import it.');
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
    <ul>{reviews.map(item => <li key={item.approval_id}><button class="plain-button" disabled={busy} onClick={() => void run(() => openReview(item.approval_id))}>{item.title}</button> · {decisionStatus(item)}</li>)}</ul>
    {review && <article><h4>{review.review.title}</h4><pre>{review.content}</pre>
      {review.review.status === 'pending' && <>
        <fieldset class="review-readers"><legend>Who can read it</legend>
          <label><input type="radio" name="review-audience" checked={review.audience === 'only-me'} disabled={busy}
            onChange={() => setReview(current => current && { ...current, audience: 'only-me' })} /> Only me</label>
          <label><input type="radio" name="review-audience" checked={review.audience === 'projects'} disabled={busy}
            onChange={() => setReview(current => current && { ...current, audience: 'projects' })} /> Projects</label>
        </fieldset>
        {review.audience === 'projects' && <div class="review-project-picker"><ProjectPicker
          projects={reviewProjects(projects, review.suggested_projects)} ticked={review.project_ids} max={MAX_CAPTURE_PROJECTS}
          onTick={id => setReview(current => {
            if (!current) return current;
            const ticked = current.project_ids.includes(id);
            if (!ticked && current.project_ids.length >= MAX_CAPTURE_PROJECTS) return current;
            return { ...current, project_ids: ticked ? current.project_ids.filter(projectId => projectId !== id) : [...current.project_ids, id].sort() };
          })}
          more={state.projects.next !== null && !state.projects.loading} onMore={() => void loadProjects(true)}
        /></div>}
        <label><input type="checkbox" checked={share} disabled={busy} onChange={e => setShare(e.currentTarget.checked)} /> Share the transcript with the selected audience</label>
        {review.owners.map(owner => <label class="review-owner" key={owner.signal_id}>Owner for: {owner.action}
          <input class="field" type="text" value={owner.owner} disabled={busy} onInput={event => setReview(current => current && {
            ...current, owners: current.owners.map(item => item.signal_id === owner.signal_id ? { ...item, owner: event.currentTarget.value } : item),
          })} />
        </label>)}
        <div class="choices">{(['reject', 'approve'] as const).map(action => <button class={action === 'approve' ? 'primary-button small' : 'plain-button'}
          disabled={busy || action === 'approve' && review.audience === 'projects' && review.project_ids.length === 0} onClick={() => void run(async () => {
          const result = await meetingCommand({ operation: 'review', approval_id: review.review.approval_id, command_id: review.command, snapshot_sha256: review.snapshot_sha256,
            action, project_ids: action === 'approve' && review.audience === 'projects' ? review.project_ids : [], share_transcript: action === 'approve' && share,
            owners: action === 'approve' ? review.owners.flatMap(owner => owner.owner.trim() ? [{ signal_id: owner.signal_id, owner: owner.owner.trim() }] : []) : [] });
          if (alive.current) {
            setReview(null);
            setNotice(result.decided_on === 'desktop' ? result.status === 'publishing' ? 'Approved. Publishing to ECHO…' : result.status
              : `Already ${result.status === 'rejected' ? 'rejected' : 'approved'} in Slack`);
          }
          await refresh();
          // An approved meeting stays open, so its impact check shows beside it.
          if (result.status !== 'rejected' && alive.current) await openReview(review.review.approval_id);
        })}>{action === 'approve' ? 'Approve' : 'Reject'}</button>)}</div>
      </>}
      {decided && <ImpactSection run={reviewRun} view={impact !== null && impact.run_id === reviewRun?.run_id ? impact.view : undefined}
        publishing={review.review.status === 'publishing'} busy={busy} tools={state.tools?.items ?? undefined}
        onRetry={() => { if (reviewRun) void run(async () => { await runsCommand({ schema_version: 1, operation: 'retry', run_id: reviewRun.run_id }); await checkRuns(); }); }} />}
    </article>}
  </section>;
}
