import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatClientUpdateError,
  parseClientUpdateCliArguments,
  renderClientUpdateResult,
  runClientUpdateCli,
} from '../../src/product/person-client/client-update-cli.js';

const result = (status: string, overrides: Partial<{
  installed_release: string;
  available_release: string | null;
  checked_at: number | null;
}> = {}) => ({
  kind: 'echo-client-update-result-v1' as const,
  status,
  platform: 'darwin/arm64/native/cli-kit',
  installed_release: 'clean-v1-release-a',
  available_release: null,
  checked_at: Date.parse('2026-09-25T18:00:00.000Z'),
  ...overrides,
});

describe('client update CLI presentation', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('prints help and rejects invalid grammar before touching an installation', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await runClientUpdateCli(['--help'])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('echo-brain update --check'));
    expect(await runClientUpdateCli(['--json', '--json'])).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Use --json for machine-readable output.'));
  });

  it('keeps a strict mode grammar and rejects duplicate JSON flags before work starts', () => {
    expect(parseClientUpdateCliArguments([])).toEqual({ mode: 'apply', json: false });
    expect(parseClientUpdateCliArguments(['--check', '--json'])).toEqual({ mode: 'check', json: true });
    expect(parseClientUpdateCliArguments(['configure', '--file', '/tmp/trusted.json', '--json'])).toEqual({ mode: 'configure', json: true, file: '/tmp/trusted.json' });
    expect(parseClientUpdateCliArguments(['--json', '--json'])).toBeUndefined();
    expect(parseClientUpdateCliArguments(['--check', '--status'])).toBeUndefined();
  });

  it('uses clear terminal output while retaining JSON for pipes and explicit JSON', () => {
    const available = result('available', { available_release: 'clean-v1-release-b' });
    expect(renderClientUpdateResult(available, { tty: true, json: false, mode: 'check', automatic: true })).toContain('Run echo-brain update to install it.');
    expect(renderClientUpdateResult(available, { tty: false, json: false, mode: 'check', automatic: true })).toBe(JSON.stringify(available) + '\n');
    expect(renderClientUpdateResult(available, { tty: true, json: true, mode: 'check', automatic: true })).toBe(JSON.stringify(available) + '\n');
  });

  it('labels status as saved local information rather than a fresh online check', () => {
    const text = renderClientUpdateResult(result('available', { available_release: 'clean-v1-release-b' }), { tty: true, json: false, mode: 'status', automatic: false });
    expect(text).toContain('Saved update status (no online check).');
    expect(text).toContain('Latest known release: clean-v1-release-b.');
    expect(text).toContain('Automatic checks: disabled.');
    const savedSuccess = renderClientUpdateResult(result('updated'), { tty: true, json: false, mode: 'status', automatic: true });
    expect(savedSuccess).toContain('Last saved update result: updated successfully.');
    expect(savedSuccess).not.toContain('failed');
  });

  it('gives safe guidance for uncertain installation and does not render unsafe local strings', () => {
    for (const code of ['installation_outcome_unknown', 'activation_mismatch']) {
      expect(formatClientUpdateError(code, { tty: true, json: false })).toContain('Contact the release operator before retrying.');
      expect(JSON.parse(formatClientUpdateError(code, { tty: false, json: false }))).toEqual({ ok: false, error: code });
    }
    expect(formatClientUpdateError('activation_mismatch', { tty: true, json: false })).toContain('Contact the release operator before retrying.');
    const text = renderClientUpdateResult(result('available', { available_release: 'clean-v1-release-b\u001b[2J' }), { tty: true, json: false, mode: 'check', automatic: true });
    expect(text).toContain('Available release: unknown.');
    expect(text).not.toContain('\u001b');
  });
});
