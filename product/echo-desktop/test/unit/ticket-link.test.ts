import { describe, expect, it } from 'vitest';
import { externalSourcePermalink, MAIN_METHODS, pagePermalink, ticketPermalink } from '../../src/shared/protocol.js';

it('dispatches generic external opening through the correct closed link policy', () => {
  const page = 'https://wiki.example.test/page?id=12345';
  expect(MAIN_METHODS).toContain('source.openExternal');
  expect(externalSourcePermalink('page', page)).toBe(page);
  expect(externalSourcePermalink('ticket', page)).toBeNull();
  expect(externalSourcePermalink('slack', page)).toBeNull();
  expect(externalSourcePermalink('unknown', page)).toBeNull();
});

describe('ticket display link containment', () => {
  it('allows the generic ticket opener and a canonical safe display link', () => {
    expect(externalSourcePermalink('ticket', 'https://example.atlassian.net/browse/ECHO-7')).toBe('https://example.atlassian.net/browse/ECHO-7');
    expect(ticketPermalink('https://example.atlassian.net/browse/ECHO-7')).toBe('https://example.atlassian.net/browse/ECHO-7');
    // The client does not decide a provider tenant. The adapter validates that
    // before release; this final display boundary only constrains URL safety.
    expect(ticketPermalink('https://tickets.example.test/ticket/7')).toBe('https://tickets.example.test/ticket/7');
  });
  it.each(['http://example.test/ticket/7', 'https://user:pass@example.test/ticket/7', 'https://example.test/ticket/7?redirect=evil',
    'https://example.test/ticket/7#secret', 'https://example.test\\@evil.test/ticket/7', 'javascript:alert(1)', 'https://example.test/ticket/7\n'])('refuses unsafe link %s', value => {
    expect(ticketPermalink(value)).toBeNull();
  });
});

describe('page display link containment', () => {
  it('opens stable page-id URLs with their query intact', () => {
    const link = 'https://example.atlassian.net/wiki/pages/viewpage.action?pageId=12345';
    expect(externalSourcePermalink('page', link)).toBe(link);
    expect(pagePermalink(link)).toBe(link);
  });
  it.each(['http://example.test/page/7', 'https://user:pass@example.test/page/7', 'https://example.test/page/7#secret',
    'https://example.test\\@evil.test/page/7', 'javascript:alert(1)', 'https://example.test/page/7\n'])('refuses unsafe page link %s', value => {
    expect(pagePermalink(value)).toBeNull();
  });
});
