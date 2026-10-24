import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERSON_TOOL_REQUEST_MAX_BYTES_V1, type PersonToolVerbContextV1 } from '@echo-brain/organization-api';
import { createHandInMeetingToolV1 } from '../../src/product/person-client/hand-in-meeting-tool.js';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const project = 'prj_00000000-0000-4000-8000-000000000003';
const meetingId = `hand-in-${'a'.repeat(64)}`;
/** Fictional notes, with a Windows line ending and edge whitespace the canonical text drops. */
const NOTES = '  Decision: move the pilot to Friday.\r\nAction: Mina sends the revised quote.\n\n';
const TRANSCRIPT = 'Mina Patel: I will send the revised quote.\n\nRafael Moreno: Friday works.';

function fixture(files: Readonly<Record<string, string | Buffer>> = { 'notes.md': NOTES, 'transcript.txt': TRANSCRIPT }, reply: unknown = { status: 'queued', meeting_id: meetingId }) {
  const dir = mkdtempSync(join(tmpdir(), 'echo-hand-in-cli-')); dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  const requests: unknown[] = [], bounds: unknown[] = [], printed: unknown[] = [];
  const session = vi.fn();
  const withToolSession: PersonToolVerbContextV1['host']['withToolSession'] = async operation => { session(); return operation({
    identity: { organization_id: 'org_test', membership_id: 'mem_test' }, random_bytes: () => new Uint8Array(), request_id: () => 'unused',
    transport: { async json(request) { requests.push(request.validate_request(request.body)); bounds.push(request.maximum_request_bytes); return request.validate_response(reply); },
      async getJson() { throw new Error('unused'); } },
  }); };
  const values = { 'meeting-title': ' Supplier sync ', 'notes-file': join(dir, 'notes.md'), 'transcript-file': join(dir, 'transcript.txt'), retain: true };
  const context: PersonToolVerbContextV1 = { host: { withToolSession }, values, print: value => printed.push(value),
    read_interactive_line: async () => '', read_secret_line: async () => '', open_browser: () => false, sleep: async () => undefined };
  return { dir, context, values, requests, bounds, printed, session };
}
const submit = (f: ReturnType<typeof fixture>, values: Record<string, string | boolean | undefined>) => createHandInMeetingToolV1().verbs.submit!.run({ ...f.context, values });

describe('hand-in meeting CLI', () => {
  it('hands in canonical text from files for a whole day, with retention and a suggestion, past the ordinary request bound', async () => {
    const f = fixture();
    await submit(f, { ...f.values, date: '2026-10-21', 'echo-project': project });
    expect(f.requests).toEqual([{ schema_version: 2, tool_id: 'hand-in', operation: 'submit', retain: true, project_id: project, meeting: {
      title: 'Supplier sync', notes: 'Decision: move the pilot to Friday.\nAction: Mina sends the revised quote.', transcript: TRANSCRIPT,
      started_at: '2026-10-21T12:00:00.000Z', all_day: true } }]);
    expect(f.bounds).toEqual([PERSON_TOOL_REQUEST_MAX_BYTES_V1]);
    // Only the queued id is printed, never the meeting's text.
    expect(f.printed).toEqual([{ ok: true, result: { status: 'queued', meeting_id: meetingId } }]);
  });

  it('keeps a start in this machine\'s time zone, and takes notes or a transcript alone', async () => {
    const f = fixture();
    await submit(f, { 'meeting-title': 'Supplier sync', 'notes-file': f.values['notes-file'], 'started-at': '2026-10-21T15:30', retain: true });
    await submit(f, { 'meeting-title': 'Supplier sync', 'transcript-file': f.values['transcript-file'], 'started-at': '2026-10-21T15:30:00+09:00', retain: true });
    expect(f.requests.map(request => (request as { meeting: unknown }).meeting)).toEqual([
      { title: 'Supplier sync', notes: 'Decision: move the pilot to Friday.\nAction: Mina sends the revised quote.', transcript: '',
        started_at: new Date('2026-10-21T15:30').toISOString(), time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      { title: 'Supplier sync', notes: '', transcript: TRANSCRIPT, started_at: '2026-10-21T06:30:00.000Z', time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    ]);
  });

  it.each([
    ['no consent', { retain: false }],
    ['no text file', { 'notes-file': undefined, 'transcript-file': undefined }],
    ['a start and a day', { 'started-at': '2026-10-21T15:30', date: '2026-10-21' }],
    ['a start that is not a time', { 'started-at': 'tomorrow' }],
    ['a start on a day that does not exist', { 'started-at': '2026-02-30T10:00' }],
    ['a day that does not exist', { date: '2026-02-30' }],
    ['a day with a time', { date: '2026-10-21T00:00' }],
    ['a title of two lines', { 'meeting-title': 'Supplier\nsync' }],
    ['a blank title', { 'meeting-title': '  ' }],
    ['an invalid project', { 'echo-project': 'Supplier review' }],
    ['a directory', { 'notes-file': tmpdir() }],
  ])('refuses %s before authentication or transport', async (_name, overrides) => {
    const f = fixture();
    await expect(submit(f, { ...f.values, ...overrides })).rejects.toThrow();
    expect(f.session).not.toHaveBeenCalled();
  });

  it.each([
    ['blank text', { 'notes.md': ' \n\t\n', 'transcript.txt': '\n' }],
    ['invalid UTF-8', { 'notes.md': Buffer.from([0xff, 0xfe, 0x00]), 'transcript.txt': TRANSCRIPT }],
    ['a file over 60 KiB', { 'notes.md': 'x'.repeat(60 * 1024 + 1), 'transcript.txt': TRANSCRIPT }],
    ['text over 60 KiB together', { 'notes.md': 'n'.repeat(31 * 1024), 'transcript.txt': 't'.repeat(31 * 1024) }],
  ])('refuses %s before authentication or transport', async (_name, files) => {
    const f = fixture(files);
    await expect(submit(f, f.values)).rejects.toThrow();
    expect(f.session).not.toHaveBeenCalled();
  });

  it('reads reviews through the meetings verb, which never carries meeting text', async () => {
    const f = fixture({}, { reviews: [] });
    await createHandInMeetingToolV1().verbs.meetings!.run({ ...f.context, values: { request: JSON.stringify({ schema_version: 2, tool_id: 'hand-in', operation: 'reviews' }) } });
    expect(f.printed).toEqual([{ ok: true, result: { reviews: [] } }]);
    const handIn = JSON.stringify({ schema_version: 2, tool_id: 'hand-in', operation: 'submit', retain: true, project_id: null,
      meeting: { title: 'Supplier sync', notes: 'Decision: move the pilot to Friday.', transcript: '' } });
    await expect(createHandInMeetingToolV1().verbs.meetings!.run({ ...f.context, values: { request: handIn } })).rejects.toThrow('arguments');
    await expect(createHandInMeetingToolV1().verbs.meetings!.run({ ...f.context, values: { request: JSON.stringify({ schema_version: 2, tool_id: 'granola', operation: 'reviews' }) } }))
      .rejects.toThrow('hand-in');
    expect(f.session).toHaveBeenCalledOnce();
  });

  it('registers the shipped verbs and their help without option collisions', async () => {
    let output = '';
    const home = mkdtempSync(join(tmpdir(), 'echo-hand-in-home-')); dirs.push(home);
    const stdout = { write: (value: string) => { output += value; return true; } };
    expect(await runPersonClientCli(['tools', 'submit', '--help'], { home_directory: home, stdout })).toBe(0);
    for (const text of ['--tool hand-in', '--meeting-title <value>', '--notes-file', '--transcript-file', '--started-at', '--date', '--echo-project', '--retain']) expect(output).toContain(text);
    output = '';
    expect(await runPersonClientCli(['tools', 'meetings', '--help'], { home_directory: home, stdout })).toBe(0);
    expect(output).toContain('--tool hand-in --request <value>');
  });
});
