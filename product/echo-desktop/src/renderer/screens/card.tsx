import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { identity, initials } from '../format.js';
import { Chevron } from './icons.js';

/** One decision, action or reason as the card shows it: the review's own structured fields. */
interface CardSignal {
  text: string;
  subject: string | null;
  /** A decision's: proposed, decided or unresolved. */
  status: string | null;
}

/** One line of a quote: "[09:01] Jonas Becker: …" when the meeting tool wrote it so, else the words alone. */
interface SaidLine {
  time: string | null;
  speaker: string | null;
  text: string;
}

const SPOKEN = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s+([^:\n]{1,80}):\s*(.*)$/u;

/**
 * A quote, one line per thing said. A line without a speaker right under one
 * is more of what they said; after a blank line it stands on its own.
 */
export function saidLines(quote: string): SaidLine[] {
  const said: SaidLine[] = [];
  let apart = true;
  for (const raw of quote.split('\n')) {
    const line = raw.trim();
    if (line === '') { apart = true; continue; }
    const spoken = SPOKEN.exec(line);
    if (spoken) { said.push({ time: spoken[1]!, speaker: spoken[2]!.trim(), text: spoken[3]!.trim() }); apart = false; continue; }
    const last = said.at(-1);
    if (last && !apart) last.text = `${last.text} ${line}`.trim();
    else said.push({ time: null, speaker: null, text: line });
    apart = false;
  }
  return said;
}

/**
 * The decision page's head (Approve, or what an approved meeting changed): on
 * the left the verb, one headline and only what you decide on; on the right a
 * panel with the main button at its top.
 */
export function CardHead({ kind, verb, where, title, meta, id }: {
  kind: 'approve' | 'done'; verb: string; where?: ComponentChildren; title: string; meta?: ComponentChildren; id: string;
}) {
  return (
    <header class="card-head">
      <div class="card-top"><span class={`card-kind ${kind}`}>{verb}</span>{where && <span>· {where}</span>}</div>
      <h1 id={id} class="card-title" tabIndex={-1}>{title}</h1>
      {meta && <div class="card-meta">{meta}</div>}
    </header>
  );
}

/** A person, by their initials in their color. */
export function Face({ name, keyed = name }: { name: string; keyed?: string }) {
  return <span class="face" style={identity(keyed)} aria-hidden="true">{initials(name)}</span>;
}

/**
 * What was said in the meeting, one line per speaker: the time and speaker the meeting tool gave above the words, so the
 * words keep the panel's whole width. Notes with neither are the words alone.
 */
function Said({ quotes }: { quotes: readonly string[] }) {
  return (
    <div class="said selectable">
      {quotes.flatMap(quote => saidLines(quote)).map((line, index) => (
        <div class="said-line" key={index}>
          {(line.time !== null || line.speaker !== null) && (
            <div class="said-meta">
              {line.time !== null && <span class="said-time">{line.time}</span>}
              {line.speaker !== null && <span class="said-who">{line.speaker}</span>}
            </div>
          )}
          <div class="said-text">{line.speaker === null ? `…${line.text}` : line.text}</div>
        </div>
      ))}
    </div>
  );
}

/** A decision that is not decided says so: proposed, or unresolved. */
const STATUS: Readonly<Record<string, string>> = { proposed: 'Proposed', unresolved: 'Unresolved' };

/**
 * One decision or action: its words and a tag for a status other than decided; `under` them what is chosen for it (where
 * it goes, or went), so its controls never narrow its words; beside them only what is short (a due date).
 */
export function SignalRow({ signal, number, under, children }: { signal: CardSignal; number?: number; under?: ComponentChildren; children?: ComponentChildren }) {
  const status = signal.status && signal.status !== 'decided' ? STATUS[signal.status] ?? signal.status : null;
  return (
    <div class="card-row" data-testid="card-signal">
      {number !== undefined && <span class="card-num" aria-hidden="true">{number}</span>}
      <div class="card-row-body">
        <div class="card-text selectable">
          {signal.text}
          {status && <span class="card-tag">{status}</span>}
          {signal.subject && <span class="card-subject">{signal.subject}</span>}
        </div>
        {under}
      </div>
      {children}
    </div>
  );
}

/**
 * See the notes: one button in the card's head, in place of one per item, for the meeting's words behind what it holds.
 * The words open under the head (NotesPanel).
 */
export function NotesButton({ open, onToggle }: { open: boolean; onToggle(): void }) {
  return (
    <button type="button" class="notes-toggle" data-testid="card-notes-toggle" aria-expanded={open} aria-controls={open ? 'card-notes' : undefined} onClick={onToggle}>
      {open ? 'Hide the notes' : 'See the notes'}
    </button>
  );
}

/** The meeting's words behind the card's items, each quote once, at the card's full width. */
export function NotesPanel({ quotes }: { quotes: readonly string[] }) {
  return <section id="card-notes" class="card-notes" aria-label="The notes" data-testid="card-notes"><Said quotes={quotes} /></section>;
}

/** The reasons given in the meeting, behind one line. */
export function Reasons({ reasons }: { reasons: readonly Pick<CardSignal, 'text'>[] }) {
  const [open, setOpen] = useState(false);
  if (reasons.length === 0) return null;
  return (
    <section class="card-section" aria-label="Why">
      <button type="button" class={`card-toggle${open ? ' open' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron />Why · {reasons.length === 1 ? '1 reason' : `${reasons.length} reasons`} from the meeting
      </button>
      {open && <ul class="card-reasons selectable">{reasons.map((reason, index) => <li key={index}>{reason.text}</li>)}</ul>}
    </section>
  );
}
