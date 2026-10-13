// A meeting proposal as the Approve card shows it, read from the text the
// Authority sends for review (approvalProposalTextV1): the meeting's title,
// its time and participants, then Decisions, Actions and Rationales, each a
// "• " line with its Subject, Status or Due, and its quotes. A text that does
// not read this way has no signals, and the card shows it as written.

export interface ProposalSignal {
  text: string;
  subject: string | null;
  /** A decision's: proposed, decided or unresolved. */
  status: string | null;
  /** An action's, as the meeting set it; null when it set none. */
  due: string | null;
  /** What was said in the meeting, each as the meeting tool wrote it. */
  quotes: string[];
}

export interface Proposal {
  title: string;
  participants: string[];
  decisions: ProposalSignal[];
  actions: ProposalSignal[];
  rationales: ProposalSignal[];
}

/** One line of a quote: "[09:01] Jonas Becker: …" when the meeting tool wrote it so, else the words alone. */
export interface SaidLine {
  time: string | null;
  speaker: string | null;
  text: string;
}

const SECTIONS = { Decisions: 'decisions', Actions: 'actions', Rationales: 'rationales' } as const;
type Section = typeof SECTIONS[keyof typeof SECTIONS];
const QUOTE = '  From the meeting: “';
const FIELDS = ['  Subject: ', '  Status: ', '  Due: '];
/** The field the Authority always writes for a decision and for an action, so a "• " line before it is still the signal's text. */
const REQUIRED: Readonly<Record<Section, string | null>> = { decisions: '  Status: ', actions: '  Due: ', rationales: null };

function section(line: string | undefined): Section | null {
  return line !== undefined && Object.hasOwn(SECTIONS, line) ? SECTIONS[line as keyof typeof SECTIONS] : null;
}

/** A section heading really begins one: after a blank line, followed by a signal or None. */
function heading(lines: readonly string[], index: number): Section | null {
  const found = lines[index - 1] === '' ? section(lines[index]) : null;
  const next = lines[index + 1];
  return found && (next === undefined || next === 'None' || next.startsWith('• ')) ? found : null;
}

/** A "• " line at `index` begins a signal of this section: it reaches the field every such signal has before anything else could begin. */
function begins(lines: readonly string[], index: number, kind: Section): boolean {
  const required = REQUIRED[kind];
  if (required === null) return true;
  for (let at = index + 1; at < lines.length; at += 1) {
    const line = lines[at]!;
    if (line.startsWith(required)) return true;
    if (line.startsWith('• ') || line.startsWith(QUOTE) || (line === '' && heading(lines, at + 1))) return false;
  }
  return false;
}

/** Where a quote may end: the next field or signal, the next section, or the end. A quote may hold blank lines. */
function boundary(lines: readonly string[], index: number, kind: Section): boolean {
  const next = lines[index + 1];
  if (next === undefined) return true;
  if (next.startsWith('• ')) return begins(lines, index + 1, kind);
  if (next.startsWith(QUOTE) || FIELDS.some(field => next.startsWith(field))) return true;
  return next === '' && (lines[index + 2] === undefined || heading(lines, index + 2) !== null);
}

export function readProposal(text: string): Proposal {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const proposal: Proposal = { title: lines[0] ?? '', participants: [], decisions: [], actions: [], rationales: [] };
  let index = 1;
  // The meeting's time and participants, up to the first blank line.
  for (; index < lines.length && lines[index] !== ''; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('Participant: ')) proposal.participants.push(line.slice('Participant: '.length).trim());
  }
  let list: ProposalSignal[] | null = null;
  let kind: Section = 'decisions';
  let signal: ProposalSignal | null = null;
  /** The signal has not reached its required field yet: a "• " line is still its text. */
  let open = false;
  let quote: string[] | null = null;
  const close = (last: string) => {
    const lines = [...quote!.slice(0, -1), last.endsWith('”') ? last.slice(0, -1) : last];
    signal!.quotes.push(lines.join('\n').trim());
    quote = null;
  };
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (quote) {
      (quote as string[]).push(line);
      if (line.endsWith('”') && boundary(lines, index, kind)) close(line);
      continue;
    }
    const begun = heading(lines, index);
    if (begun) { list = proposal[begun]; kind = begun; signal = null; open = false; continue; }
    if (line === '' || !list) continue;
    if (line.startsWith('• ') && !(signal && open)) {
      signal = { text: line.slice(2).trim(), subject: null, status: null, due: null, quotes: [] };
      list.push(signal);
      open = REQUIRED[kind] !== null;
      continue;
    }
    if (!signal) continue;
    if (line.startsWith('  Subject: ')) signal.subject = line.slice('  Subject: '.length).trim() || null;
    else if (line.startsWith('  Status: ')) { signal.status = line.slice('  Status: '.length).trim() || null; if (kind === 'decisions') open = false; }
    else if (line.startsWith('  Due: ')) {
      const due = line.slice('  Due: '.length).trim();
      signal.due = due === '' || due === 'Not specified' ? null : due;
      if (kind === 'actions') open = false;
    } else if (line.startsWith(QUOTE)) {
      open = false;
      const first = line.slice(QUOTE.length);
      quote = [first];
      if (first.endsWith('”') && boundary(lines, index, kind)) close(first);
    } else signal.text = `${signal.text}\n${line}`.trim();
  }
  if (quote) close((quote as string[]).at(-1)!);
  return proposal;
}

/** Whether the text read as a proposal: it has at least one decision, action or reason. */
export function proposalRead(proposal: Proposal): boolean {
  return proposal.decisions.length + proposal.actions.length + proposal.rationales.length > 0;
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
