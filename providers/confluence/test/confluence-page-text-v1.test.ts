import { describe, expect, it } from 'vitest';
import { normalizeConfluencePageDocumentV1 } from '../src/confluence-page-text-v1.js';

const text = (value: string) => ({ type: 'text', text: value });
const paragraph = (value: string) => ({ type: 'paragraph', content: [text(value)] });
const document = (...content: unknown[]) => JSON.stringify({ type: 'doc', version: 1, content });

describe('Confluence native ADF page text', () => {
  it('preserves headings, gate table relationships, lists, links and Unicode', () => {
    const result = normalizeConfluencePageDocumentV1(document(
      { type: 'heading', attrs: { level: 1 }, content: [text('ECHO PRD')] },
      paragraph('Ready & reviewed 🚀 — next'),
      { type: 'table', content: [
        { type: 'tableRow', content: ['Gate', 'Status'].map(value => ({ type: 'tableHeader', content: [paragraph(value)] })) },
        { type: 'tableRow', content: ['EVT', 'Blocked'].map(value => ({ type: 'tableCell', content: [paragraph(value)] })) },
      ] },
      { type: 'bulletList', content: ['Connect Jira', 'Read Confluence'].map(value => ({ type: 'listItem', content: [paragraph(value)] })) },
      { type: 'paragraph', content: [{ ...text('Linked requirements'), marks: [{ type: 'link', attrs: { href: 'https://untrusted.invalid/never-fetch' } }] }] },
    ));
    const rendered = result.sections.join('');
    for (const value of ['Ready & reviewed 🚀 — next', '| Gate | Status', '| EVT | Blocked', '• Connect Jira', '• Read Confluence', 'Linked requirements']) expect(rendered).toContain(value);
    expect(result.incomplete).toBe(false);
  });

  it('preserves native code and expand content while explicitly omitting opaque legacy macros and media', () => {
    const code = '  if ready:\n    ship()\n\n  stop()';
    const result = normalizeConfluencePageDocumentV1(document(
      { type: 'codeBlock', attrs: { language: 'javascript' }, content: [text(code)] },
      { type: 'expand', attrs: { title: 'Gate notes' }, content: [paragraph('Visible after embed')] },
      { type: 'bodiedExtension', attrs: { extensionKey: 'legacy-macro', parameters: { secret: 'UNRELEASED-PARAMETER' } }, content: [paragraph('UNREAD-EMBED')] },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { url: 'https://untrusted.invalid/never-fetch' } }] },
    ));
    const rendered = result.sections.join('');
    for (const value of [code, 'Gate notes', 'Visible after embed', '[Unsupported embedded content omitted.]']) expect(rendered).toContain(value);
    for (const value of ['UNRELEASED-PARAMETER', 'UNREAD-EMBED', 'https://untrusted.invalid']) expect(rendered).not.toContain(value);
    expect(result.incomplete).toBe(true);
  });

  it('keeps every character of a long MRD reachable in bounded Unicode sections', () => {
    const raw = `MRD start\n${'Requirement 🚀 e\u0301. '.repeat(1600)}\nPVT acceptance at the end`;
    const result = normalizeConfluencePageDocumentV1(document({ type: 'codeBlock', content: [text(raw)] }));
    expect(result.sections.length).toBeGreaterThan(10);
    expect(result.sections.join('')).toBe(raw.normalize('NFC'));
    for (const section of result.sections) { expect(Buffer.byteLength(section, 'utf8')).toBeLessThanOrEqual(3072); expect(section).not.toContain('\uFFFD'); }
    expect(result.sections.at(-1)).toContain('PVT acceptance at the end');
  });

  it('preserves dates and task states without exposing internal task identifiers', () => {
    const result = normalizeConfluencePageDocumentV1(document(
      { type: 'paragraph', content: [text('EVT due '), { type: 'date', attrs: { timestamp: String(Date.parse('2026-10-05T00:00:00Z')) } }] },
      { type: 'taskList', attrs: { localId: 'list-private' }, content: [
        { type: 'taskItem', attrs: { localId: 'task-private', state: 'TODO' }, content: [text('Approve the gate')] },
        { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('Read the PRD')] },
      ] },
    ));
    const rendered = result.sections.join('');
    for (const value of ['EVT due 2026-10-05', '[ ] Approve the gate', '[x] Read the PRD']) expect(rendered).toContain(value);
    expect(rendered).not.toContain('private');
    expect(result.incomplete).toBe(false);
  });

  it.each(['<p>not ADF</p>', JSON.stringify({ type: 'doc', version: 2, content: [] }),
    document(text('\u0000')), document(text('\ud800')), document(text('\u0085')),
    document({ type: 'text', text: 'bad', content: [] }), document({ type: 'taskItem', attrs: { state: 'unknown' } }),
    document({ type: 'date', attrs: { timestamp: 'invalid' } }), 'x'.repeat(1024 * 1024 + 1),
  ])('rejects malformed or excessive native documents', value => {
    expect(() => normalizeConfluencePageDocumentV1(value)).toThrow();
  });

  it('bounds nesting, node count and total released text independently', () => {
    let nested: unknown = paragraph('Too deep');
    for (let depth = 0; depth < 65; depth++) nested = { type: 'panel', content: [nested] };
    for (const value of [document(nested), document(...Array.from({ length: 50_001 }, () => ({ type: 'hardBreak' }))), document(text('x'.repeat(512 * 1024 + 1)))]) {
      expect(() => normalizeConfluencePageDocumentV1(value)).toThrow();
    }
  });
});
