import { confluenceFailure } from './confluence-validation-v1.js';

const MAX_STORAGE_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const SECTION_BYTES = 3072;
const OMITTED = '[Unsupported embedded content omitted.]';
const BLOCKS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'hr', 'ac:task-list', 'ac:task', 'ac:task-body', 'ac:rich-text-body', 'ac:plain-text-body']);
const INLINE = new Set(['span', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'strike', 'small', 'sub', 'sup', 'code', 'a', 'td', 'th', 'br', 'time', 'ac:link', 'ac:plain-text-link-body', 'ac:task-status']);
const VOID = new Set(['br', 'hr', 'img', 'input', 'wbr', 'ri:page', 'ri:user', 'ri:url', 'ri:attachment']);
const TEXT_MACROS = new Set(['code', 'noformat', 'panel', 'expand', 'info', 'note', 'warning', 'tip', 'status']);
const ENTITIES: Readonly<Record<string, string>> = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', times: '×', rarr: '→', larr: '←', ne: '≠', le: '≤', ge: '≥' });

interface Frame { readonly name: string; readonly suppressed: boolean }
export interface ConfluencePageTextV1 {
  readonly sections: readonly string[];
  /** Some visible provider content cannot be represented as text. */
  readonly incomplete: boolean;
}

/** Split only on Unicode code point boundaries. Each section fits the shared 3 KiB release limit. */
function sections(text: string): readonly string[] {
  const result: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let bytes = 0;
    let boundary = start;
    for (const point of text.slice(start)) {
      const size = Buffer.byteLength(point, 'utf8');
      if (bytes + size > SECTION_BYTES) break;
      bytes += size;
      end += point.length;
      if (point === '\n' || point === ' ') boundary = end;
    }
    if (end < text.length && boundary > start + (end - start) / 2) end = boundary;
    if (end <= start) confluenceFailure('invalid_output');
    result.push(text.slice(start, end));
    start = end;
  }
  return Object.freeze(result.length === 0 ? [''] : result);
}

/**
 * Bounded, non-executing reader for Confluence's XHTML storage representation.
 * It never resolves entities externally, loads images, or follows links. Known
 * text wrappers are preserved; opaque macros/media are explicitly omitted.
 */
export function normalizeConfluencePageStorageV1(html: string): ConfluencePageTextV1 {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_STORAGE_BYTES) confluenceFailure('invalid_output');
  for (const point of html) {
    const code = point.codePointAt(0)!;
    if ((code >= 0xd800 && code <= 0xdfff) || (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) confluenceFailure('invalid_output');
  }
  const stack: Frame[] = [];
  const output: string[] = [];
  let outputBytes = 0;
  let incomplete = false;
  let tokens = 0;
  const suppressed = () => stack.at(-1)?.suppressed === true;
  function append(text: string): void {
    if (text.length === 0) return;
    outputBytes += Buffer.byteLength(text, 'utf8');
    if (outputBytes > MAX_TEXT_BYTES) confluenceFailure('invalid_output');
    output.push(text);
  }
  function entities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (raw, name: string) => {
      if (name.startsWith('#')) {
        const code = name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
        if (!Number.isSafeInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) confluenceFailure('invalid_output');
        return String.fromCodePoint(code);
      }
      const decoded = ENTITIES[name];
      if (decoded !== undefined) return decoded;
      // Preserve the literal spelling instead of silently inventing its value.
      incomplete = true;
      return raw;
    });
  }
  function attribute(token: string, name: string): string | undefined {
    const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(token);
    return match === null ? undefined : entities(match[1] ?? match[2]!);
  }

  for (let offset = 0; offset < html.length;) {
    if (++tokens > 50_000) confluenceFailure('invalid_output');
    if (html[offset] !== '<') {
      const next = html.indexOf('<', offset);
      const end = next < 0 ? html.length : next;
      if (!suppressed()) append(entities(html.slice(offset, end)));
      offset = end;
      continue;
    }
    if (html.startsWith('<!--', offset)) {
      const end = html.indexOf('-->', offset + 4);
      if (end < 0) confluenceFailure('invalid_output');
      offset = end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', offset)) {
      const end = html.indexOf(']]>', offset + 9);
      if (end < 0) confluenceFailure('invalid_output');
      if (!suppressed()) append(html.slice(offset + 9, end));
      offset = end + 3;
      continue;
    }
    // Storage does not need processing instructions or DTD/entity declarations.
    if (html.startsWith('<!', offset) || html.startsWith('<?', offset)) confluenceFailure('invalid_output');
    let end = offset + 1;
    let quote = '';
    for (; end < html.length; end += 1) {
      const character = html[end]!;
      if (quote !== '') { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end === html.length || end - offset > 64 * 1024) confluenceFailure('invalid_output');
    const token = html.slice(offset + 1, end).trim();
    offset = end + 1;
    const match = /^(\/)?([a-z][a-z0-9:-]*)(?=\s|\/|$)/i.exec(token);
    if (match === null) confluenceFailure('invalid_output');
    const name = match[2]!.toLowerCase();
    if (match[1] !== undefined) {
      if (!/^\/[a-z][a-z0-9:-]*\s*$/i.test(token)) confluenceFailure('invalid_output');
      const frame = stack.pop();
      if (frame === undefined || frame.name !== name) confluenceFailure('invalid_output');
      if (!frame.suppressed && (BLOCKS.has(name) || name === 'ac:structured-macro')) append('\n');
      if (!frame.suppressed && name === 'ac:task-status') append(' ');
      continue;
    }
    const parentSuppressed = suppressed();
    const metadata = name === 'ri:page' || name === 'ri:user' || name === 'ri:url' || name === 'ac:task-id' || name === 'ac:task-uuid';
    const macro = name === 'ac:structured-macro' && TEXT_MACROS.has(attribute(token, 'ac:name') ?? '');
    const parameter = name === 'ac:parameter';
    const visibleParameter = parameter && attribute(token, 'ac:name') === 'title';
    const supported = BLOCKS.has(name) || INLINE.has(name) || macro || parameter || metadata || name === 'wbr';
    const hide = parentSuppressed || !supported || metadata || (parameter && !visibleParameter);
    if (!parentSuppressed && !supported) { append(`\n${OMITTED}\n`); incomplete = true; }
    if (!hide) {
      if (BLOCKS.has(name) || macro || name === 'br' || visibleParameter) append('\n');
      if (name === 'li') append('• ');
      if (name === 'td' || name === 'th') append(' | ');
      if (name === 'time') {
        const datetime = attribute(token, 'datetime');
        if (datetime !== undefined) {
          if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(datetime) ||
              !Number.isFinite(Date.parse(datetime)) || new Date(`${datetime.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== datetime.slice(0, 10)) confluenceFailure('invalid_output');
          append(datetime);
        }
      }
    }
    if (!/\/\s*$/.test(token) && !VOID.has(name)) {
      if (stack.length >= 64) confluenceFailure('invalid_output');
      stack.push({ name, suppressed: hide });
    }
  }
  if (stack.length !== 0) confluenceFailure('invalid_output');
  // Whitespace inside code/preformatted content can carry meaning. Strip only
  // the outer block separators added above, not indentation or internal lines.
  const text = output.join('').replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '').normalize('NFC');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) confluenceFailure('invalid_output');
  return Object.freeze({ sections: sections(text), incomplete });
}
