import type { FollowUpProgress } from '../needs.js';

/**
 * A thin bar under a follow-ups line, as wide as the line: done, then sent and
 * still open, then not sent (the track), each its share of every follow-up
 * not dismissed. The words beside it say the same, so screen readers skip it;
 * with nothing to count it takes no room.
 */
export function ProgressBar({ progress }: { progress: FollowUpProgress }) {
  if (progress.total === 0) return null;
  const share = (count: number) => `${(count / progress.total) * 100}%`;
  return (
    <div class="progress-bar" data-testid="follow-ups-progress" aria-hidden="true">
      {progress.done > 0 && <span class="done" style={{ width: share(progress.done) }} />}
      {progress.open > 0 && <span class="open" style={{ width: share(progress.open) }} />}
    </div>
  );
}
