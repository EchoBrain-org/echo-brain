import { describe, expect, it } from 'vitest';
import { MAIN_METHODS, ticketPermalink } from '../../src/shared/protocol.js';

describe('ticket display link containment', () => {
  it('allows the generic ticket opener and a canonical safe display link', () => {
    expect(MAIN_METHODS).toContain('source.openTicket');
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
