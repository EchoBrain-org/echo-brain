// A meeting proposal as the Approve card shows it, read from the text the
// Authority sends for review (approvalProposalTextV1): the meeting's title,
// its time and participants, then Decisions, Actions and Rationales, each a
// "• " line with its Subject, Status or Due, and its quotes. A text that does
// not read this way, or reads more than one way, has no signals, and the card
// shows it as written.

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
const QUOTE = '  From the meeting: “';
/** The one line a decision and an action have after their text and Subject; a reason has none. */
const REQUIRED = ['  Status: ', '  Due: ', null] as const;
/** The Authority's own lines: never in a signal's text, Subject or quote. */
const FIELDS = ['  Subject: ', '  Status: ', '  Due: ', QUOTE];

/**
 * Where a reading stands, per section: at its name, at None or its first signal, after None, in a signal's text or
 * Subject, after its Status or Due, in a quote, after a quote. Then in the meeting's own lines, and before them.
 */
const NAME = 0, BLOCK = 1, NONE = 2, TEXT = 3, SUBJECT = 4, READY = 5, OPEN = 6, QUOTED = 7, HEADER = 24, START = 25, STATES = 26;
type Step = readonly [to: number, op: 'skip' | 'signal' | 'more' | 'subject' | 'field' | 'quote' | 'quoted' | 'close'];

/**
 * Where one line may take a reading, as approvalProposalTextV1 writes a signal: "• " and its text, any Subject, a
 * decision's Status or an action's Due, then a quote for each unit it cites (every signal cites one). A text, Subject or
 * quote runs on over any lines but the Authority's own, and a quote ends on a line that ends with ”.
 */
function steps(state: number, line: string): Step[] {
  if (state >= HEADER) return state === START || line !== '' ? [[HEADER, 'skip']] : [[HEADER, 'skip'], [NAME, 'skip']];
  const at = state - state % 8, kind = state % 8, section = at / 8, required = REQUIRED[section] ?? null;
  const quote: Step[] = !line.startsWith(QUOTE) ? []
    : line.length > QUOTE.length + 1 && line.endsWith('”') ? [[at + OPEN, 'quote'], [at + QUOTED, 'quoted']] : [[at + OPEN, 'quote']];
  const content = !FIELDS.some(field => line.startsWith(field));
  switch (kind) {
    case NAME: return line === NAMES[section] ? [[at + BLOCK, 'skip']] : [];
    case BLOCK: return line === 'None' ? [[at + NONE, 'skip']] : line.startsWith('• ') ? [[at + TEXT, 'signal']] : [];
    case NONE: return line === '' && section < 2 ? [[at + 8, 'skip']] : [];
    case READY: return quote;
    case QUOTED: return line.startsWith('• ') ? [[at + TEXT, 'signal']] : line === '' && section < 2 ? [[at + 8, 'skip']] : quote;
    case OPEN: return !content ? [] : line.endsWith('”') ? [[state, 'more'], [at + QUOTED, 'close']] : [[state, 'more']];
  }
  if (content) return [[state, 'more']];
  if (kind === TEXT && line.startsWith('  Subject: ')) return [[at + SUBJECT, 'subject']];
  return required === null ? quote : line.startsWith(required) ? [[at + READY, 'field']] : [];
}

/** The one reading of these lines, a step for each; null when they read no way, or more than one. */
function reading(lines: readonly string[]): Step[] | null {
  // ways[index * STATES + state]: how many readings lines index.. have from that state, counted to 2. The text ends
  // after the Rationales' None or a reason's quote.
  const ways = new Uint8Array((lines.length + 1) * STATES);
  ways[lines.length * STATES + 2 * 8 + NONE] = ways[lines.length * STATES + 2 * 8 + QUOTED] = 1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    for (let state = 0; state < STATES; state += 1) {
      ways[index * STATES + state] = Math.min(2, steps(state, lines[index]!).reduce((sum, [to]) => sum + ways[(index + 1) * STATES + to]!, 0));
    }
  }
  if (ways[START] !== 1) return null;
  const path: Step[] = [];
  for (let index = 0, state = START; index < lines.length; index += 1) {
    const step = steps(state, lines[index]!).find(([to]) => ways[(index + 1) * STATES + to]! > 0)!;
    path.push(step);
    state = step[0];
  }
  return path;
}

export function readProposal(text: string): Proposal {
  const lines = text.split('\n');
  const proposal: Proposal = { title: lines[0] ?? '', participants: [], decisions: [], actions: [], rationales: [] };
  // The meeting's time and participants, up to the first blank line.
  for (let index = 1; index < lines.length && lines[index] !== ''; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('Participant: ')) proposal.participants.push(line.slice('Participant: '.length).trim());
  }
  const path = reading(lines) ?? [];
  let signal: ProposalSignal | null = null;
  let quote: string | null = null;
  for (let index = 0; index < path.length; index += 1) {
    const [to, op] = path[index]!, line = lines[index]!;
    if (op === 'signal') {
      signal = { text: line.slice(2), subject: null, status: null, due: null, quotes: [] };
      proposal[LISTS[Math.floor(to / 8)]!].push(signal);
    } else if (!signal || op === 'skip') continue;
    else if (op === 'more' && quote !== null) quote = `${quote}\n${line}`;
    else if (op === 'more' && to % 8 === SUBJECT) signal.subject = `${signal.subject}\n${line}`;
    else if (op === 'more') signal.text = `${signal.text}\n${line}`;
    else if (op === 'subject') signal.subject = line.slice('  Subject: '.length);
    else if (op === 'field' && to < 8) signal.status = line.slice('  Status: '.length).trim() || null;
    else if (op === 'field') {
      const due = line.slice('  Due: '.length).trim();
      signal.due = due === '' || due === 'Not specified' ? null : due;
    } else if (op === 'quote') quote = line.slice(QUOTE.length);
    else if (op === 'quoted') signal.quotes.push(line.slice(QUOTE.length, -1).trim());
    else { signal.quotes.push(`${quote}\n${line.slice(0, -1)}`.trim()); quote = null; }
  }
  for (const read of [...proposal.decisions, ...proposal.actions, ...proposal.rationales]) {
    read.text = read.text.trim();
    read.subject = read.subject?.trim() || null;
  }
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
