import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

type Rpc = (method: string, params?: unknown) => Promise<{ ok: boolean; failure?: { code: string } }>;

test('the page can never name a file path', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  const replies = await page.evaluate(async () => {
    const rpc = (window as unknown as { echo: { rpc: Rpc } }).echo.rpc;
    const expect = { authority: 'https://authority.example', membership_id: 'mem_22222222-2222-4222-8222-222222222222' };
    return {
      drop: await rpc('drop.accept', { path: '/etc/hosts' }),
      upload: await rpc('documents.upload', {
        expect, request_id: crypto.randomUUID(), file_handle: 'made-up', file: '/etc/hosts', title: 'x', audience: { kind: 'only-me' },
      }),
      odd: await rpc('../../<script>', {}),
      invitation: await rpc('signin.invitation', { invitation_handle: 'made-up', invitation: '/etc/hosts' }),
    };
  });
  expect(replies.drop).toMatchObject({ ok: false, failure: { code: 'invalid_request' } });
  expect(replies.upload).toMatchObject({ ok: false, failure: { code: 'unsupported_file' } });
  expect(replies.invitation).toMatchObject({ ok: false, failure: { code: 'unsupported_invitation' } });
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
  await expect(page.getByTestId('sent')).toContainText('Saved for you');
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
  await expect(page.getByTestId('sent')).toBeVisible();
  const title = String(run.calls().find(call => call.path === '/v3/person/updates')!.body?.title);
  expect(Buffer.byteLength(title)).toBe(200);
  await page.getByTestId('compose-done').click();

  await page.getByTestId('ask-field').fill('q'.repeat(400));
  await expect(page.getByTestId('ask-field')).toHaveValue('q'.repeat(240));
});
