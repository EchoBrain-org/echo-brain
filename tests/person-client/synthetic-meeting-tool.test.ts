import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersonToolVerbContextV1 } from '@echo-brain/organization-api';
import { createSyntheticMeetingToolV1 } from '../../src/product/person-client/synthetic-meeting-tool.js';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const meeting = { id: 'synthetic-custom-test', title: 'Test', notes: '', transcript: 'Synthetic speaker: ship the cohort onboarding.' };
function fixture(contents: string | Buffer = JSON.stringify(meeting)) {
  const dir = mkdtempSync(join(tmpdir(), 'echo-custom-meeting-cli-')); dirs.push(dir);
  const path = join(dir, 'meeting.json'); writeFileSync(path, contents);
  const requests: unknown[] = [], printed: unknown[] = [];
  const session = vi.fn();
  const withToolSession: PersonToolVerbContextV1['host']['withToolSession'] = async operation => { session(); return operation({
    identity: { organization_id: 'org_test', membership_id: 'mem_test' }, random_bytes: () => new Uint8Array(), request_id: () => 'unused',
    transport: { async json(request) { requests.push(request.validate_request(request.body)); return request.validate_response({ status: 'queued', meeting_id: meeting.id }); },
      async getJson() { throw new Error('unused'); } },
  }); };
  const context: PersonToolVerbContextV1 = { host: { withToolSession }, values: { 'meeting-file': path, retain: true }, print: value => printed.push(value),
    read_interactive_line: async () => '', read_secret_line: async () => '', open_browser: () => false, sleep: async () => undefined };
  return { path, context, requests, printed, session };
}
describe('synthetic meeting CLI', () => {
  it('submits a bounded file with retention and a project suggestion, without echoing its content', async () => {
    const f = fixture(), project = 'prj_00000000-0000-4000-8000-000000000003';
    await createSyntheticMeetingToolV1().verbs.meetings!.run({ ...f.context, values: { ...f.context.values, 'echo-project': project } });
    expect(f.requests).toEqual([{ schema_version: 2, tool_id: 'synthetic', operation: 'submit', meeting, project_id: project, retain: true }]);
    expect(f.printed).toEqual([{ ok: true, result: { status: 'queued', meeting_id: meeting.id } }]);
  });
  it.each(['oversize', 'invalid utf8', 'invalid json', 'directory', 'missing consent', 'mixed input'])('refuses %s before authentication or transport', async kind => {
    const f = fixture(kind === 'oversize' ? 'x'.repeat(49153) : kind === 'invalid utf8' ? Buffer.from([0xff]) : kind === 'invalid json' ? 'not JSON' : undefined);
    const values = { ...f.context.values,
      ...(kind === 'directory' ? { 'meeting-file': dirs.at(-1)! } : {}),
      ...(kind === 'missing consent' ? { retain: false } : {}),
      ...(kind === 'mixed input' ? { request: '{}' } : {}),
    };
    await expect(createSyntheticMeetingToolV1().verbs.meetings!.run({ ...f.context, values })).rejects.toThrow();
    expect(f.session).not.toHaveBeenCalled();
  });
  it('registers the shipped command and its help without option collisions', async () => {
    let output = '';
    expect(await runPersonClientCli(['tools', 'meetings', '--help'], { stdout: { write: value => { output += value; return true; } } })).toBe(0);
    expect(output).toContain('--tool synthetic'); expect(output).toContain('--meeting-file'); expect(output).toContain('--retain');
  });
  it('requires file submission even when a valid submit payload is supplied through --request', async () => {
    const f = fixture();
    const request = JSON.stringify({ schema_version: 2, tool_id: 'synthetic', operation: 'submit', meeting, project_id: null, retain: true });
    await expect(createSyntheticMeetingToolV1().verbs.meetings!.run({ ...f.context, values: { request } })).rejects.toThrow('--meeting-file');
    expect(f.session).not.toHaveBeenCalled();
  });
});
