import { describe, expect, it } from 'vitest';
import { externalSourcePermalink, pagePermalink, ticketPermalink } from '../../src/shared/protocol.js';

it('dispatches generic external opening through the correct closed link policy', () => {
  const page = 'https://wiki.example.test/page?id=12345';
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

describe('tool container display link containment (research tool contract v1)', () => {
  it.each(['https://example.atlassian.net/browse/THERM', 'https://example.atlassian.net/wiki/spaces/THT', 'https://acme.slack.com/archives/C0123456'])(
    'opens a Jira project, Confluence space or Slack channel as a ticket opens: %s', link => {
      expect(externalSourcePermalink('container', link)).toBe(link);
    });
  it.each(['http://example.test/browse/THERM', 'https://user:pass@example.test/browse/THERM', 'https://example.test/browse/THERM?redirect=evil',
    'https://example.test/browse/THERM#secret', 'javascript:alert(1)'])('refuses unsafe container link %s', value => {
    expect(externalSourcePermalink('container', value)).toBeNull();
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
