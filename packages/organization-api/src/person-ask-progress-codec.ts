import { canonicalJson, canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { asEnumerableRecord as object, assertExactKeys, assertToolId, fail, validateOrganizationApiError } from './validation.js';

/**
 * The Ask progress stream's validators and framing (ADR-0039), for the
 * version that names what it admits: its plain source kinds, the citation
 * projection of a named item, its answer and its bounds. Internal: Ask
 * progress V3 (person-ask-progress-v3.ts) exports its typed functions.
 */
export interface AskProgressDialect {
  /** Source kinds a searched row names without a tool id. */
  readonly plain_sources: readonly string[];
  /** Source kinds a searched row names with the tool id of the connected tool it read. */
  readonly tool_sources: readonly string[];
  /** One named item: exactly the projection the version's answer citations use. */
  readonly item: (value: unknown) => { readonly citation: unknown };
  /** The released answer the terminal answer event carries. */
  readonly answer: (value: unknown) => unknown;
  readonly bounds: {
    readonly count: number;
    readonly sources: number;
    readonly read_items: number;
    readonly named: number;
    readonly receipt_rows: number;
    readonly receipt_bytes: number;
    readonly receipt_elapsed_ms: number;
    readonly event_bytes: number;
    readonly line_chars: number;
  };
}

type Source = { readonly kind: string; readonly tool_id?: string };
type Item = { readonly citation: unknown };
type Searched = { readonly type: 'searched'; readonly sources: readonly Source[]; readonly found: number };
type Read = { readonly type: 'read'; readonly items: readonly Item[] };
type Stage = { readonly type: 'stage'; readonly stage: string; readonly pending?: number };
type Step = Stage | Searched | Read;
type Receipt = { readonly looked_through: number; readonly elapsed_ms: number; readonly rows: readonly (Searched | Read)[] };
type Terminal = { readonly type: 'answer'; readonly response: unknown; readonly receipt: Receipt }
  | { readonly type: 'error'; readonly status: number; readonly error: { readonly code: string; readonly message: string } };
type Event = Step | Terminal;

export interface AskProgressCodec {
  step(value: unknown): Step;
  receipt(value: unknown): Receipt;
  format(event: unknown): string;
  decoder(): { push(text: string): readonly Event[]; end(): void };
  line(value: unknown): { readonly ok: true; readonly progress: Step };
}

const STAGES: readonly string[] = ['searching', 'reading', 'checking_access', 'writing'];
const ERROR_STATUSES: readonly number[] = [400, 401, 404, 409, 429, 500, 502, 503];

export function askProgressCodec(dialect: AskProgressDialect): AskProgressCodec {
  const { bounds } = dialect;
  function count(value: unknown, label: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > bounds.count) fail(`${label} is invalid`);
    return value as number;
  }

  function source(value: unknown): Source {
    const input = object(value, 'Ask progress source');
    if (dialect.plain_sources.includes(input.kind as string)) {
      assertExactKeys(input, ['kind'], 'Ask progress source');
      return Object.freeze({ kind: input.kind as string });
    }
    if (!dialect.tool_sources.includes(input.kind as string)) fail('Ask progress source kind is invalid');
    assertExactKeys(input, ['kind', 'tool_id'], 'Ask progress source');
    assertToolId(input.tool_id, 'Ask progress source tool_id');
    return Object.freeze({ kind: input.kind as string, tool_id: input.tool_id });
  }

  function searched(input: Record<string, unknown>, label: string): Searched {
    assertExactKeys(input, ['type', 'sources', 'found'], label);
    if (!Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > bounds.sources) fail(`${label} sources is invalid`);
    const sources = input.sources.map(source);
    if (new Set(sources.map(value => canonicalJson(value))).size !== sources.length) fail(`${label} sources contains duplicates`);
    return Object.freeze({ type: 'searched', sources: Object.freeze(sources), found: count(input.found, `${label} found`) });
  }

  /** Items of one read event or receipt row; `seen` spans a whole receipt so an item is named once. */
  function read(input: Record<string, unknown>, label: string, maximum: number, seen: Set<string> = new Set()): Read {
    assertExactKeys(input, ['type', 'items'], label);
    if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > maximum) fail(`${label} items is invalid`);
    const items = input.items.map(item => dialect.item(item));
    for (const item of items) {
      const key = canonicalJson(item.citation);
      if (seen.has(key)) fail(`${label} names an item twice`);
      seen.add(key);
    }
    return Object.freeze({ type: 'read', items: Object.freeze(items) });
  }

  function stepEvent(input: Record<string, unknown>): Step {
    if (input.type === 'stage') {
      assertExactKeys(input, ['type', 'stage', ...(Object.hasOwn(input, 'pending') ? ['pending'] : [])], 'Ask progress stage');
      if (!STAGES.includes(input.stage as string)) fail('Ask progress stage is invalid');
      if (Object.hasOwn(input, 'pending') && input.stage !== 'reading') fail('Ask progress pending applies only to reading');
      return Object.freeze({ type: 'stage', stage: input.stage as string, ...(Object.hasOwn(input, 'pending') ? { pending: count(input.pending, 'Ask progress pending', 1) } : {}) });
    }
    if (input.type === 'searched') return searched(input, 'Ask progress searched');
    if (input.type === 'read') return read(input, 'Ask progress read', bounds.read_items);
    fail('Ask progress event type is invalid');
  }

  function bounded<T>(value: T, maximum: number, label: string): T {
    if (canonicalJsonBytes(value).byteLength > maximum) fail(`${label} exceeds its JSON byte bound`);
    return value;
  }

  const step = (value: unknown): Step => bounded(stepEvent(object(value, 'Ask progress event')), bounds.event_bytes, 'Ask progress event');

  function receipt(value: unknown): Receipt {
    const input = object(value, 'Ask receipt');
    assertExactKeys(input, ['looked_through', 'elapsed_ms', 'rows'], 'Ask receipt');
    const lookedThrough = count(input.looked_through, 'Ask receipt looked_through');
    if (!Number.isSafeInteger(input.elapsed_ms) || (input.elapsed_ms as number) < 0 || (input.elapsed_ms as number) > bounds.receipt_elapsed_ms) fail('Ask receipt elapsed_ms is invalid');
    if (!Array.isArray(input.rows) || input.rows.length > bounds.receipt_rows) fail('Ask receipt rows is invalid');
    const seen = new Set<string>();
    const rows = input.rows.map((value: unknown): Searched | Read => {
      const row = object(value, 'Ask receipt row');
      if (row.type === 'searched') return searched(row, 'Ask receipt row');
      if (row.type === 'read') return read(row, 'Ask receipt row', bounds.named, seen);
      fail('Ask receipt row type is invalid');
    });
    for (let index = 1; index < rows.length; index += 1) if (rows[index]!.type === rows[index - 1]!.type) fail('Ask receipt rows are not merged');
    if (seen.size > bounds.named) fail('Ask receipt names too many items');
    if (lookedThrough < seen.size) fail('Ask receipt looked_through is less than the items it names');
    return bounded(Object.freeze({ looked_through: lookedThrough, elapsed_ms: input.elapsed_ms as number, rows: Object.freeze(rows) }), bounds.receipt_bytes, 'Ask receipt');
  }

  function event(value: unknown): Event {
    const input = object(value, 'Ask progress event');
    if (input.type === 'answer') {
      assertExactKeys(input, ['type', 'response', 'receipt'], 'Ask progress answer');
      return bounded(Object.freeze({ type: 'answer', response: dialect.answer(input.response), receipt: receipt(input.receipt) }), bounds.event_bytes, 'Ask progress answer');
    }
    if (input.type === 'error') {
      assertExactKeys(input, ['type', 'status', 'error'], 'Ask progress error');
      if (!ERROR_STATUSES.includes(input.status as number)) fail('Ask progress error status is invalid');
      const { error } = validateOrganizationApiError({ error: input.error });
      return Object.freeze({ type: 'error', status: input.status as number, error: Object.freeze(error) });
    }
    return bounded(stepEvent(input), bounds.event_bytes, 'Ask progress event');
  }

  /**
   * Reads the stream as framed and fails closed: a line other than a comment,
   * one `data: ` line or a blank line, a second data line in one event, an
   * over-long line, an invalid event, or anything after the terminal event throws.
   */
  function decoder() {
    let buffered = '';
    let data: string | undefined;
    let terminal = false;
    const line = (text: string, events: Event[]) => {
      if (text.includes('\r')) fail('Ask progress stream line is invalid');
      if (text === '') {
        if (data === undefined) return;
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch (error) { fail('Ask progress event is not JSON', error); }
        data = undefined;
        const value = event(parsed);
        events.push(value);
        if (value.type === 'answer' || value.type === 'error') terminal = true;
        return;
      }
      if (terminal) fail('Ask progress stream continued after its result');
      if (text.startsWith(':')) return;
      if (!text.startsWith('data: ') || data !== undefined) fail('Ask progress stream line is invalid');
      data = text.slice('data: '.length);
    };
    return Object.freeze({
      push(text: string) {
        const events: Event[] = [];
        buffered += text;
        let newline = buffered.indexOf('\n');
        while (newline >= 0) {
          line(buffered.slice(0, newline), events);
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf('\n');
        }
        if (buffered.length > bounds.line_chars) fail('Ask progress stream line exceeds its bound');
        return Object.freeze(events);
      },
      end() {
        if (buffered !== '' || data !== undefined || !terminal) fail('Ask progress stream ended without its result');
      },
    });
  }

  return Object.freeze({
    step,
    receipt,
    // `JSON.stringify` escapes newlines, so the frame is one data line.
    format: (value: unknown) => `data: ${JSON.stringify(event(value))}\n\n`,
    decoder,
    line(value: unknown) {
      const input = object(value, 'Ask progress line');
      assertExactKeys(input, ['ok', 'progress'], 'Ask progress line');
      if (input.ok !== true) fail('Ask progress line is invalid');
      return Object.freeze({ ok: true as const, progress: step(input.progress) });
    },
  });
}
