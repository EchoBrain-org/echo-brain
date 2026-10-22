import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { identity, initials } from '../format.js';
import { saidLines, type ProposalSignal } from '../proposal.js';
import { Chevron } from './icons.js';

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

/** What was said in the meeting, one line per speaker, with the time the meeting tool gave it. */
function Said({ quotes }: { quotes: readonly string[] }) {
  return (
    <div class="said selectable">
      {quotes.flatMap(quote => saidLines(quote)).map((line, index) => (
        <div class="said-line" key={index}>
          <span class="said-time">{line.time ?? ''}</span>
          <span class="said-who">{line.speaker ?? ''}</span>
          <span class="said-text">{line.speaker === null ? `…${line.text}` : line.text}</span>
        </div>
      ))}
    </div>
  );
}

/** A decision that is not decided says so: proposed, or unresolved. */
const STATUS: Readonly<Record<string, string>> = { proposed: 'Proposed', unresolved: 'Unresolved' };

/** One decision or action: its words, a tag for a status other than decided, and the meeting's words behind one button. */
export function SignalRow({ signal, number, children }: { signal: ProposalSignal; number?: number; children?: ComponentChildren }) {
  const [open, setOpen] = useState(false);
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
        {open && signal.quotes.length > 0 && <Said quotes={signal.quotes} />}
      </div>
      {children}
      {signal.quotes.length > 0 && (
        <button type="button" class={`card-toggle${open ? ' open' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}
          aria-label={`In the meeting: ${signal.text.length > 80 ? `${signal.text.slice(0, 79)}…` : signal.text}`}>
          In the meeting<Chevron />
        </button>
      )}
    </div>
  );
}

/** The reasons given in the meeting, behind one line. */
export function Reasons({ reasons }: { reasons: readonly ProposalSignal[] }) {
  const [open, setOpen] = useState(false);
  if (reasons.length === 0) return null;
  return (
    <section class="card-section" aria-label="Why">
      <button type="button" class={`card-toggle wide${open ? ' open' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron />Why · {reasons.length === 1 ? '1 reason' : `${reasons.length} reasons`} from the meeting
      </button>
      {open && <ul class="card-reasons selectable">{reasons.map((reason, index) => <li key={index}>{reason.text}</li>)}</ul>}
    </section>
  );
}
