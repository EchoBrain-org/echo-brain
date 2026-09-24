import { useEffect, useRef, useState } from 'preact/hooks';
import { message } from '../messages.js';
import {
  acceptDrop, attachFile, chooseTarget, closeCompose, removeFile, sendCompose, sentLabel, setComposeText, targetLabel,
  toggleTargets, type ComposeTarget, type State,
} from '../store.js';
import { Check, Chevron, Clip, Close, Up } from './icons.js';

/** Write and Capture: To, the text, send. First line is the title. */
export function Compose({ state }: { state: State }) {
  const compose = state.compose!;
  const body = useRef<HTMLTextAreaElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => { body.current?.focus(); }, [compose.seq]);

  if (compose.status === 'sent') {
    return (
      <div class="overlay" onClick={closeCompose}>
        <div class="sheet" role="dialog" aria-label="Sent" onClick={event => event.stopPropagation()}>
          <div class="sent" data-testid="sent">
            <div class="check"><Check /></div>
            <div class="what">{sentLabel(compose.target)}</div>
            <button type="button" class="plain-button" data-testid="compose-done" onClick={closeCompose}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  const targets: ComposeTarget[] = [
    { kind: 'only-me' },
    ...state.projects.items.map(project => ({ kind: 'project' as const, project })),
    { kind: 'team' },
  ];
  const same = (a: ComposeTarget, b: ComposeTarget) =>
    a.kind === b.kind && (a.kind !== 'project' || (b.kind === 'project' && a.project.project_id === b.project.project_id));
  const sending = compose.status === 'sending';
  const empty = compose.text.trim() === '' && !compose.file;

  return (
    <div class="overlay" onClick={closeCompose}>
      <div
        class={`sheet${over ? ' drop-target' : ''}`} role="dialog" aria-label="Write" data-testid="compose"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); closeCompose(); }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void sendCompose(); }
        }}
        onDragOver={event => { event.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={event => {
          event.preventDefault(); setOver(false);
          const file = event.dataTransfer?.files[0];
          if (file) void acceptDrop(file);
        }}
      >
        <div class="to-row">
          <button type="button" class="circle" aria-label="Close" onClick={closeCompose} disabled={sending}><Close /></button>
          <span class="label">To</span>
          <button type="button" class="to-button" data-testid="compose-to" aria-expanded={compose.picking} onClick={toggleTargets} disabled={sending}>
            <span>{targetLabel(compose.target)}</span><Chevron />
          </button>
        </div>
        {compose.picking && (
          <div class="pills" role="listbox" aria-label="To">
            {targets.map(target => (
              <button
                type="button" role="option" aria-selected={same(target, compose.target)} data-testid="compose-target"
                key={target.kind === 'project' ? target.project.project_id : target.kind}
                class={`pill${same(target, compose.target) ? ' on' : ''}`} onClick={() => chooseTarget(target)}
              >{targetLabel(target)}</button>
            ))}
          </div>
        )}
        <label for="compose-body" class="sr-only">What happened?</label>
        <textarea
          id="compose-body" ref={body} data-testid="compose-body" placeholder="What happened?" disabled={sending}
          value={compose.text} onInput={event => setComposeText((event.target as HTMLTextAreaElement).value)}
        />
        {compose.file && (
          <div class="file-chip" data-testid="compose-file">
            <span>{compose.file.name}</span>
            <button type="button" aria-label="Remove file" onClick={removeFile} disabled={sending}><Close /></button>
          </div>
        )}
        <div class="sheet-foot">
          <button type="button" class="circle" aria-label="Attach a file" data-testid="compose-attach" onClick={() => void attachFile()} disabled={sending}><Clip /></button>
          <div class="status" aria-live="polite">
            {sending && <span class="notice">Sending</span>}
            {compose.status === 'error' && compose.failure && <span class="error" data-testid="compose-error">{message(compose.failure)}</span>}
          </div>
          <span class="hint">⌘↩</span>
          <button type="button" class="circle primary" aria-label="Send" data-testid="compose-send" disabled={sending || empty} onClick={() => void sendCompose()}><Up /></button>
        </div>
      </div>
    </div>
  );
}
