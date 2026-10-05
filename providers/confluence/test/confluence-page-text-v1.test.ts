import { describe, expect, it } from 'vitest';
import { normalizeConfluencePageStorageV1 } from '../src/confluence-page-text-v1.js';

describe('Confluence storage page text', () => {
  it('preserves headings, gate table relationships, lists, links and Unicode entities', () => {
    const result = normalizeConfluencePageStorageV1('<h1>ECHO PRD</h1><p>Ready &amp; reviewed &#x1F680; &#8212; next</p><table><tr><th>Gate</th><th>Status</th></tr><tr><td>EVT</td><td>Blocked</td></tr></table><ul><li>Connect Jira</li><li><a href="https://example.test/?x=1&amp;y=2" title="a &gt; b">Read Confluence</a></li></ul>');
    const text = result.sections.join('');
    expect(text).toContain('Ready & reviewed 🚀 — next');
    expect(text).toContain('| Gate | Status');
    expect(text).toContain('| EVT | Blocked');
    expect(text).toContain('• Connect Jira');
    expect(text).toContain('• Read Confluence');
    expect(result.incomplete).toBe(false);
  });

  it('retains safe text macro bodies and omits opaque embeds without exposing their parameters', () => {
    const result = normalizeConfluencePageStorageV1('<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">javascript</ac:parameter><ac:plain-text-body><![CDATA[if (a < b) return "ready";]]></ac:plain-text-body></ac:structured-macro><ac:structured-macro ac:name="jira"><ac:parameter ac:name="secret">UNRELEASED-PARAMETER</ac:parameter><ac:rich-text-body><p>UNREAD-EMBED</p></ac:rich-text-body></ac:structured-macro><p>Visible after embed</p><ac:image><ri:attachment ri:filename="image.png" /></ac:image>');
    const text = result.sections.join('');
    expect(text).toContain('if (a < b) return "ready";');
    expect(text).toContain('Visible after embed');
    expect(text).toContain('[Unsupported embedded content omitted.]');
    expect(text).not.toContain('UNRELEASED-PARAMETER');
    expect(text).not.toContain('UNREAD-EMBED');
    expect(result.incomplete).toBe(true);
  });

  it('keeps every character of a long MRD reachable in bounded Unicode sections', () => {
    const raw = `MRD start\n${'Requirement 🚀 e\u0301. '.repeat(1600)}\nPVT acceptance at the end`;
    const result = normalizeConfluencePageStorageV1(`<pre>${raw}</pre>`);
    expect(result.sections.length).toBeGreaterThan(10);
    expect(result.sections.join('')).toBe(raw.normalize('NFC'));
    for (const section of result.sections) {
      expect(Buffer.byteLength(section, 'utf8')).toBeLessThanOrEqual(3072);
      expect(section).not.toContain('\uFFFD');
    }
    expect(result.sections.at(-1)).toContain('PVT acceptance at the end');
  });

  it('does not let tags inside quoted attributes or CDATA alter the parser structure', () => {
    expect(normalizeConfluencePageStorageV1('<p title="a > b and <ignored>">Visible</p><ac:plain-text-body><![CDATA[<tag>text &amp;</tag>]]></ac:plain-text-body>').sections.join('')).toBe('Visible\n\n<tag>text &amp;</tag>');
  });

  it('preserves meaningful code indentation and marks self-closing opaque macros incomplete', () => {
    const result = normalizeConfluencePageStorageV1('<ac:plain-text-body><![CDATA[  if ready:\n    ship()\n\n  stop()]]></ac:plain-text-body><ac:structured-macro ac:name="external-data" />');
    expect(result.sections.join('')).toContain('  if ready:\n    ship()\n\n  stop()');
    expect(result.sections.join('')).toContain('[Unsupported embedded content omitted.]');
    expect(result.incomplete).toBe(true);
  });

  it('preserves Confluence date and task macros used in gate checklists', () => {
    const result = normalizeConfluencePageStorageV1('<p>EVT due <time datetime="2026-10-05" /></p><ac:task-list><ac:task><ac:task-id>123456789</ac:task-id><ac:task-uuid>task-uuid</ac:task-uuid><ac:task-status>incomplete</ac:task-status><ac:task-body>Approve the gate</ac:task-body></ac:task></ac:task-list>');
    expect(result.sections.join('')).toContain('EVT due 2026-10-05');
    expect(result.sections.join('')).toContain('incomplete');
    expect(result.sections.join('')).toContain('Approve the gate');
    expect(result.sections.join('')).not.toContain('123456789');
    expect(result.sections.join('')).not.toContain('task-uuid');
    expect(result.incomplete).toBe(false);
  });

  it.each(['<!DOCTYPE root [<!ENTITY x SYSTEM "file:///private/data">]><p>&x;</p>', '<p>unfinished', '<p></div>', '<p>&#0;</p>', '<p>\ud800</p>', '<p>&#x85;</p>', '<p>\u0085</p>', '<p>'.repeat(65) + '</p>'.repeat(65), 'x'.repeat(1024 * 1024 + 1)])('rejects malformed or excessive storage without external expansion', html => {
    expect(() => normalizeConfluencePageStorageV1(html)).toThrow();
  });
});
