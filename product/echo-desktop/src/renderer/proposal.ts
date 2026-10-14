// A meeting proposal as the Approve card shows it, read from the text the
// Authority sends for review (approvalProposalTextV1): the meeting's title,
// its time and participants, then Decisions, Actions and Rationales, each a
// "• " line with its Subject, Status or Due, and its quotes. Every line after
// the first of an entry starts with four spaces, so a line of the meeting's own
// words or of a signal's text never reads as one the Authority wrote. A text
// that does not read this way has no signals, and the card shows it as written.

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

const NAMES = ['Decisions', 'Actions', 'Rationales'] as const;
const LISTS = ['decisions', 'actions', 'rationales'] as const;
/** Starts every line after the first of an entry: the title, a time, a participant, a signal's text, Subject or quote. */
const MORE = '    ';
const QUOTE = '  From the meeting: “';
/** The line a decision and an action have after their text and any Subject; a reason has none. */
const REQUIRED = ['  Status: ', '  Due: ', null] as const;

/** The text's entries as the Authority wrote them: a line, then each line after it that starts with four spaces, less those spaces. The first is the title's. */
function entries(text: string): string[] {
  const read: string[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (index > 0 && line.startsWith(MORE)) read[read.length - 1] += `\n${line.slice(MORE.length)}`;
    else read.push(line);
  }
  return read;
}

type Signals = Pick<Proposal, 'decisions' | 'actions' | 'rationales'>;

/**
 * Decisions, Actions and Rationales, from the blank entry before Decisions to the last entry, as approvalProposalTextV1
 * writes them: a blank entry, the name, then None or its signals. A signal is "• " and its text, any Subject, a
 * decision's Status or an action's Due, then a quote for each unit it cites (every signal cites one). Null when the
 * entries do not read so.
 */
function signals(read: readonly string[], from: number): Signals | null {
  const found: Signals = { decisions: [], actions: [], rationales: [] };
  let at = from;
  const take = (prefix: string): string | null => read[at]?.startsWith(prefix) ? read[at++]!.slice(prefix.length) : null;
  for (const [section, name] of NAMES.entries()) {
    if (read[at] !== '' || read[at + 1] !== name) return null;
    at += 2;
    if (read[at] === 'None') { at += 1; continue; }
    do {
      const text = take('• ');
      if (text === null) return null;
      const subject = take('  Subject: '), required = REQUIRED[section] ?? null;
      const field = required === null ? '' : take(required);
      if (field === null) return null;
      const quotes: string[] = [];
      for (let quote = take(QUOTE); quote !== null; quote = take(QUOTE)) {
        if (!quote.endsWith('”')) return null;
        quotes.push(quote.slice(0, -1).trim());
      }
      if (quotes.length === 0) return null;
      const due = section === 1 ? field.trim() : '';
      found[LISTS[section]!].push({ text: text.trim(), subject: subject?.trim() || null, status: section === 0 ? field.trim() || null : null,
        due: due === '' || due === 'Not specified' ? null : due, quotes });
    } while (read[at]?.startsWith('• '));
  }
  return at === read.length ? found : null;
}

export function readProposal(text: string): Proposal {
  const read = entries(text);
  const proposal: Proposal = { title: read[0] ?? '', participants: [], decisions: [], actions: [], rationales: [] };
  // The meeting's time and participants, up to the first blank entry.
  let at = 1;
  for (; at < read.length && read[at] !== ''; at += 1) {
    if (read[at]!.startsWith('Participant: ')) proposal.participants.push(read[at]!.slice('Participant: '.length).trim());
  }
  return { ...proposal, ...signals(read, at) };
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
