import type { AnswerSource } from '../shared/protocol.js';

/**
 * One source as an answer shows it: a document, a meeting's approved record,
 * or a Slack message. An answer cites passages and record items; those of one
 * document or one record are one source, numbered once.
 */
export interface SourceGroup {
  readonly kind: AnswerSource['kind'];
  /** Its citations, by their place in the answer's sources. */
  readonly indexes: readonly number[];
}

function groupKey(source: AnswerSource): string {
  if (source.kind === 'record') return `record:${source.record.record_sha256}`;
  if (source.kind === 'original') return `original:${source.ref.source_id}`;
  return `${source.kind}:${source.permalink}`;
}

/** An answer's sources, in the order it first cites them. */
export function sourceGroups(sources: readonly AnswerSource[]): SourceGroup[] {
  const groups = new Map<string, { kind: AnswerSource['kind']; indexes: number[] }>();
  sources.forEach((source, index) => {
    const key = groupKey(source);
    const group = groups.get(key);
    if (group) group.indexes.push(index);
    else groups.set(key, { kind: source.kind, indexes: [index] });
  });
  return [...groups.values()];
}

/** The sources a sentence cites, by their place among the answer's sources: one marker each. */
export function statementGroups(citations: readonly number[], groups: readonly SourceGroup[]): number[] {
  const cited = new Set(citations);
  return groups.flatMap((group, position) => group.indexes.some(index => cited.has(index)) ? [position] : []);
}

const EXTENSION = /\.(md|markdown|txt|text|pdf|docx?|rtf|html?)$/iu;
const VERSION = /^(.*\S)[\s_-]+(v\d+(?:\.\d+)*)$/iu;

/**
 * A file name as a person would say it: "SCOUT-Hardware-Review-v0.1.md" is
 * SCOUT Hardware Review, v0.1. A title someone wrote, with spaces, keeps
 * everything but its extension.
 */
export function documentName(label: string): { name: string; version?: string } {
  const stem = label.replace(EXTENSION, '');
  if (stem.trim() === '') return { name: label };
  if (/\s/u.test(stem)) return { name: stem };
  const name = stem.replace(/[-_]+/gu, ' ').trim();
  const versioned = VERSION.exec(name);
  return versioned ? { name: versioned[1]!, version: versioned[2]! } : { name };
}

/** A run of a passage's text: plain, bold, or code. */
export interface Inline {
  readonly text: string;
  readonly bold?: true;
  readonly code?: true;
}

/** A passage's text in the blocks its markdown means. Anything else stays as written, line by line. */
export type Block =
  | { readonly kind: 'heading'; readonly text: readonly Inline[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] }
  | { readonly kind: 'paragraph'; readonly text: readonly Inline[] };

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/u;
const ITEM = /^\s*(?:[-*+]|(\d{1,9})[.)])\s+(.*)$/u;
const RULE = /^\s{0,3}(?:[-*_]\s*){3,}$/u;
const INLINE = /\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`/gu;

function inline(text: string): Inline[] {
  const runs: Inline[] = [];
  let from = 0;
  for (const found of text.matchAll(INLINE)) {
    if (found.index > from) runs.push({ text: text.slice(from, found.index) });
    runs.push(found[3] !== undefined ? { text: found[3], code: true } : { text: (found[1] ?? found[2])!, bold: true });
    from = found.index + found[0].length;
  }
  if (from < text.length) runs.push({ text: text.slice(from) });
  return runs;
}

/**
 * A cited passage, ready to read: its markdown as blocks. Evidence can start
 * with the file name it came from; the pane already names it, so it goes.
 */
export function passageBlocks(text: string, label: string): Block[] {
  let body = text;
  if (label !== '' && body.startsWith(label) && (body.length === label.length || /\s/u.test(body[label.length]!))) {
    body = body.slice(label.length).trimStart();
  }
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: Inline[][] } | null = null;
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: inline(paragraph.join('\n')) });
    if (list) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    paragraph = [];
    list = null;
  };
  for (const line of body.split(/\r?\n/u)) {
    if (line.trim() === '' || RULE.test(line)) { flush(); continue; }
    const heading = HEADING.exec(line);
    if (heading) { flush(); blocks.push({ kind: 'heading', text: inline(heading[1]!) }); continue; }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = item[1] !== undefined;
      if (paragraph.length > 0 || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(inline(item[2]!));
      continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}
