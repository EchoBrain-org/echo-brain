import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

type Rpc = (method: string, params?: unknown) => Promise<{ ok: boolean; failure?: { code: string } }>;
type DropFile = (file: unknown) => Promise<{ ok: boolean; failure?: { code: string } }>;

test('the page can never name a file path', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  const replies = await page.evaluate(async () => {
    const { rpc, dropFile } = (window as unknown as { echo: { rpc: Rpc; dropFile: DropFile } }).echo;
    const expect = { authority: 'https://authority.example', membership_id: 'mem_22222222-2222-4222-8222-222222222222' };
    return {
      drop: await rpc('drop.accept', { path: '/etc/hosts' }),
      // The drop channel reads a path only off a real dropped File, never from the page.
      dropPath: await dropFile('/etc/hosts'),
      dropObject: await dropFile({ path: '/etc/hosts', name: 'hosts.txt' }),
      upload: await rpc('documents.upload', {
        expect, request_id: crypto.randomUUID(), file_handle: 'made-up', file: '/etc/hosts', title: 'x', audience: { kind: 'only-me' },
      }),
      odd: await rpc('../../<script>', {}),
      invitation: await rpc('signin.invitation', { invitation_handle: 'made-up', invitation: '/etc/hosts' }),
      // Save original… writes only where main's own dialog was told, and suggests only a file name.
      save: await rpc('documents.save', { expect, document_id: `doc_${'e'.repeat(64)}`, save_handle: 'made-up', out: '/tmp/echo-anywhere.pdf' }),
      saveName: await rpc('dialog.saveDocument', { name: '../../etc/hosts' }),
      // An invitation is saved only in a folder main's own dialog chose, and shown only by the handle that saved it.
      invite: await rpc('employees.invite', {
        expect, name: 'Kim', email: 'kim@example.com', invitation_handle: 'made-up', out: '/tmp/echo-anywhere/person-invitation.json',
      }),
      reissue: await rpc('employees.reissue', { expect, email: 'raj@example.com', out: '/tmp/echo-anywhere/person-invitation.json' }),
      show: await rpc('invitation.show', { invitation_handle: 'made-up' }),
      inviteName: await rpc('dialog.saveInvitation', { name: 5 }),
    };
  });
  expect(replies.drop).toMatchObject({ ok: false, failure: { code: 'invalid_request' } });
  expect(replies.dropPath).toMatchObject({ ok: false, failure: { code: 'unsupported_file' } });
  expect(replies.dropObject).toMatchObject({ ok: false, failure: { code: 'unsupported_file' } });
  expect(replies.upload).toMatchObject({ ok: false, failure: { code: 'unsupported_file' } });
  expect(replies.invitation).toMatchObject({ ok: false, failure: { code: 'unsupported_invitation' } });
  expect(replies.save).toMatchObject({ ok: false, failure: { code: 'invalid_request' } });
  expect(replies.saveName).toMatchObject({ ok: false, failure: { code: 'invalid_request' } });
  for (const reply of [replies.invite, replies.reissue, replies.show, replies.inviteName]) {
    expect(reply).toMatchObject({ ok: false, failure: { code: 'invalid_request' } });
  }
  expect(run.calls().some(call => call.path === '/v1/person/employees')).toBe(false);
  expect(run.calls().some(call => call.path.startsWith('/v2/session/'))).toBe(false);
  expect(replies.odd).toMatchObject({ ok: false, failure: { code: 'invalid_request' } });
  expect(run.calls().some(call => call.path.includes('document'))).toBe(false);
  // The log names only methods the app knows.
  const log = readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8');
  expect(log).toContain('? invalid_request');
  expect(log).not.toMatch(/script|drop\.accept|etc/);
});

test('a note that starts with a dash is sent as text, not read as an option', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('--audience=team\nstill only for me');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved for you');
  const saved = run.calls().filter(call => call.method === 'POST' && call.path === '/v3/person/updates');
  expect(saved[0]!.body?.title).toBe('--audience=team');
  expect(saved[0]!.body?.audience).toEqual({ kind: 'only_me' });
});

test('a long title is cut to what the API takes, and a long question is capped', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill(`${'é'.repeat(150)}\tend`);
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toBeVisible();
  const title = String(run.calls().find(call => call.path === '/v3/person/updates')!.body?.title);
  expect(Buffer.byteLength(title)).toBe(200);

  await page.getByTestId('ask-field').fill('q'.repeat(400));
  await expect(page.getByTestId('ask-field')).toHaveValue('q'.repeat(240));
});
