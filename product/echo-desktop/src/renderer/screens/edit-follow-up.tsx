import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { OpenItemView } from '../../shared/protocol.js';
import type { ItemEdit } from '../store.js';

/** The longest line a follow-up keeps (the runs contract's own bound). */
const LINE_CHARS = 120;

/**
 * Edit, on a follow-up from a chat that you may edit (ADR-0053): its one line
 * and its due date, in place. Save sends only what changed and closes once it
 * went; Cancel or Escape closes it unchanged. An empty date clears it.
 */
export function EditFollowUp({ item, busy, save, close }: {
  item: OpenItemView; busy: boolean; save: (edit: ItemEdit) => Promise<boolean>; close: () => void;
}) {
  const [line, setLine] = useState(item.expected ?? '');
  const [due, setDue] = useState(item.due_on ?? '');
  const field = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { field.current?.focus(); }, []);
  const empty = line.trim() === '';
  const submit = async () => {
    if (busy || empty) return;
    if (await save({ expected: line, due_on: due === '' ? null : due })) close();
  };
  return (
    <form class="edit-follow-up" data-testid="edit-follow-up" onSubmit={event => { event.preventDefault(); void submit(); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <label class="edit-follow-up-field">
        <span class="section-label">What needs doing</span>
        <input ref={field} class="field small" type="text" data-testid="edit-follow-up-line" maxLength={LINE_CHARS} value={line} disabled={busy}
          onInput={event => setLine((event.target as HTMLInputElement).value)} />
      </label>
      <label class="edit-follow-up-field due">
        <span class="section-label">Due</span>
        <input class="field small" type="date" data-testid="edit-follow-up-due" value={due} disabled={busy}
          onInput={event => setDue((event.target as HTMLInputElement).value)} />
      </label>
      <div class="edit-follow-up-actions">
        <button type="submit" class="primary-button small" data-testid="edit-follow-up-save" disabled={busy || empty}>Save</button>
        <button type="button" class="plain-button small" disabled={busy} onClick={close}>Cancel</button>
      </div>
    </form>
  );
}
