import { expect, test, type Locator } from '@playwright/test';
import { launch, type Launched } from './launch.js';

// ADR-0049: Mine goes; Only me is a row in the sidebar, the list of everything only you can read, filed or not.
let run: Launched;
test.afterEach(async () => {
  await run?.close();
});
const lists = () => run.calls().filter(call => call.path === '/v1/person/list');
const opens = () => run.calls().filter(call => call.path === '/v1/person/open');
const hue = (of: Locator) => of.evaluate(element => getComputedStyle(element).color);

type Rpc = (method: string, params?: unknown) => Promise<{ ok: boolean; failure?: { code: string } }>;

// What Only me shows (its rows, kinds, tiles, ages, More and its sidebar row) is only-me-row.test's, only-me.test's and
// sidebar.test's, and Escape's way Home shell.spec's; here, what the real client asks for it, a tile's hue as the window paints
// it, and the page with no Back link (main.tsx, which no unit test renders).
test('the sidebar\'s Only me lists what only you can read through the client, a filed row in its project\'s hue, and More reads the next page', async () => {
  run = await launch('only-me');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('sidebar-only-me').click();
  await expect(page.getByTestId('title')).toHaveText('Only me');
  await expect(page.getByTestId('back')).toHaveCount(0);
  const rows = page.getByTestId('only-me-row');
  await expect(rows).toHaveCount(10);
  // Filed in Apollo: its row shows Apollo's tile, in the sidebar's hue.
  await expect(rows.nth(2).getByTestId('only-me-tiles')).toHaveAttribute('title', 'Apollo');
  expect(await hue(rows.nth(2).locator('.alt-tile'))).toBe(await hue(page.getByTestId('sidebar-project').nth(0).locator('.dot')));
  await page.getByTestId('only-me-more').click();
  await expect(rows).toHaveCount(11);
  expect(lists().map(call => call.body)).toEqual([{ schema_version: 1, only_me: true }, { schema_version: 1, only_me: true, cursor: expect.any(String) }]);
});

// ADR-0049: a locked item filed in a project shows there, with the lock, for its owner alone.

test('the host opens only a well-formed ref, in a scope the app lists, and anything you cannot read is not_found', async () => {
  run = await launch('only-me');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  const replies = await page.evaluate(async () => {
    const { rpc } = (window as unknown as { echo: { rpc: Rpc } }).echo;
    const expect = { authority: 'https://authority.example', membership_id: 'mem_22222222-2222-4222-8222-222222222222' };
    const note = `ctx_${'a'.repeat(64)}`;
    return {
      guessed: await rpc('open.ref', { expect, ref: { kind: 'meeting', id: `sha256:${'0'.repeat(64)}` } }),
      badId: await rpc('open.ref', { expect, ref: { kind: 'note', id: 'ctx_short' } }),
      transcript: await rpc('open.ref', { expect, ref: { kind: 'transcript', id: `sha256:${'7'.repeat(64)}` } }),
      noteCursor: await rpc('open.ref', { expect, ref: { kind: 'note', id: note }, cursor: 'AQ' }),
      badCursor: await rpc('open.ref', { expect, ref: { kind: 'document', id: `doc_${'9'.repeat(64)}` }, cursor: '../x' }),
      global: await rpc('list.page', { expect, scope: { kind: 'global' } }),
      // The desktop lists what only you can read, never Mine any more.
      mine: await rpc('list.page', { expect, scope: { kind: 'mine' } }),
      noScope: await rpc('list.page', { expect }),
      badProject: await rpc('list.page', { expect, scope: { kind: 'project', project_id: 'prj_../x' } }),
      longCursor: await rpc('list.page', { expect, scope: { kind: 'only-me' }, cursor: 'x'.repeat(513) }),
    };
  });
  expect(replies.guessed).toMatchObject({ ok: false, failure: { code: 'not_found' } });
  for (const reply of [replies.badId, replies.transcript, replies.noteCursor, replies.badCursor, replies.global, replies.mine, replies.noScope, replies.badProject,
    replies.longCursor]) {
    expect(reply).toMatchObject({ ok: false, failure: { code: 'invalid_request' } });
  }
  // Only the guessed ref reached the Authority.
  expect(opens().map(call => call.body)).toEqual([{ schema_version: 1, ref: `meeting:sha256:${'0'.repeat(64)}` }]);
  expect(lists()).toHaveLength(0);
});
