import type { PersonProviderV1 } from './person-provider-v1.js';

const BLOCKS = new Set(['doc', 'paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'taskList', 'codeBlock', 'table', 'tableRow', 'tableCell', 'tableHeader', 'panel', 'expand', 'nestedExpand', 'layoutSection', 'layoutColumn']);
const OMITTED = '[Unsupported embedded content omitted.]';
type Validation = Pick<PersonProviderV1, 'record' | 'array' | 'string' | 'failure'>;

/** Native Atlassian Document Format only. No HTML parsing, media hydration or link fetching. */
export function normalizeAtlassianDocumentTextV1(value: unknown, provider: Validation, options: {
  readonly unsupported?: 'reject' | 'omit';
  readonly maximum_bytes?: number;
  readonly maximum_nodes?: number;
  readonly maximum_depth?: number;
} = {}): Readonly<{ text: string; incomplete: boolean }> {
  const { record, array, string } = provider;
  const failure: Validation['failure'] = provider.failure;
  const maximum = options.maximum_bytes ?? 256 * 1024;
  const nodeLimit = options.maximum_nodes ?? 4096;
  const depthLimit = options.maximum_depth ?? 32;
  const doc = record(value);
  if (doc.type !== 'doc' || doc.version !== 1) failure('invalid_output');
  let nodes = 0;
  let bytes = 0;
  let incomplete = false;
  function unsupported(): string {
    if (options.unsupported !== 'omit') failure('invalid_output');
    incomplete = true;
    return `\n${OMITTED}\n`;
  }
  function text(value: unknown): string {
    if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cs}]/u.test(value)) failure('invalid_output');
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > maximum) failure('invalid_output');
    return value;
  }
  function walk(value: unknown, depth: number): string {
    if (++nodes > nodeLimit || depth > depthLimit) failure('invalid_output');
    const node = record(value);
    const type = string(node.type, 64);
    if (type === 'text') {
      if (node.content !== undefined) failure('invalid_output');
      if (node.marks !== undefined) for (const mark of array(node.marks, 32)) string(record(mark).type, 64);
      return text(node.text);
    }
    if (type === 'hardBreak' || type === 'rule') return '\n';
    if (type === 'inlineCard') {
      const attrs = record(node.attrs);
      if (node.content !== undefined) failure('invalid_output');
      if (attrs.data !== undefined) return unsupported();
      return text(string(attrs.url, 8192));
    }
    if (type === 'mention' || type === 'emoji' || type === 'status') {
      const attrs = record(node.attrs);
      const label = attrs.text ?? (type === 'emoji' ? attrs.shortName : undefined);
      if (label === undefined) return unsupported();
      return text(string(label, 512));
    }
    if (type === 'date') {
      const timestamp = string(record(node.attrs).timestamp, 32, /^-?\d+$/);
      const date = new Date(Number(timestamp));
      if (!Number.isFinite(date.getTime())) failure('invalid_output');
      return text(date.toISOString().slice(0, 10));
    }
    if (type === 'taskItem') {
      const state = record(node.attrs).state;
      if (state !== 'TODO' && state !== 'DONE') failure('invalid_output');
      return `[${state === 'DONE' ? 'x' : ' '}] ${array(node.content ?? [], nodeLimit).map(child => walk(child, depth + 1)).join('')}\n`;
    }
    if (!BLOCKS.has(type)) {
      // Includes legacy macro extensions. Neither parameters nor opaque child
      // content become evidence; the caller must expose the incomplete notice.
      return unsupported();
    }
    const content = array(type === 'doc' ? node.content : node.content ?? [], nodeLimit);
    const body = content.map(child => walk(child, depth + 1)).join('');
    if (type === 'doc') return body;
    if (type === 'tableCell' || type === 'tableHeader') return ` | ${body.replace(/\n+$/g, '')}`;
    if (type === 'listItem') return `• ${body}`;
    if (type === 'expand' || type === 'nestedExpand') {
      const title = node.attrs === undefined ? undefined : record(node.attrs).title;
      return `${title === undefined ? '' : `${text(string(title, 1024))}\n`}${body}\n`;
    }
    return `${body}\n`;
  }
  const result = walk(doc, 0).replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '').normalize('NFC');
  if (Buffer.byteLength(result, 'utf8') > maximum) failure('invalid_output');
  return Object.freeze({ text: result, incomplete });
}

/** Lossless bounded chunks: code-point safe, with a nearby word boundary when available. */
export function splitAtlassianTextV1(text: string, maximum = 3072): readonly string[] {
  if (!Number.isSafeInteger(maximum) || maximum < 4) throw new Error('Text section size is invalid');
  const result: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let bytes = 0;
    let boundary = start;
    for (const point of text.slice(start)) {
      const size = Buffer.byteLength(point, 'utf8');
      if (bytes + size > maximum) break;
      bytes += size;
      end += point.length;
      if (point === '\n' || point === ' ') boundary = end;
    }
    if (end < text.length && boundary > start + (end - start) / 2) end = boundary;
    result.push(text.slice(start, end));
    start = end;
  }
  return Object.freeze(result.length === 0 ? [''] : result);
}
