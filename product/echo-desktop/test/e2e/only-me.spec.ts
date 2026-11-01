import { expect, test, type Locator } from '@playwright/test';
import { launch, type Launched } from './launch.js';

// ADR-0049: Mine goes; Only me is a row in the sidebar, the list of everything only you can read, filed or not.
let run: Launched;
test.afterEach(async () => {
  await run?.close();
});
const PRICING_REVIEW = `meeting:sha256:${'7'.repeat(64)}`;
const LONG_ACTION = `Draft the renewal terms.${' Clause.'.repeat(872)}`;
const lists = () => run.calls().filter(call => call.path === '/v1/person/list');
const opens = () => run.calls().filter(call => call.path === '/v1/person/open');
const hue = (of: Locator) => of.evaluate(element => getComputedStyle(element).color);

type Rpc = (method: string, params?: unknown) => Promise<{ ok: boolean; failure?: { code: string } }>;

test('the sidebar\'s Only me opens what only you can read, filed or not, newest first, with no lock on any row; More reads the rest', async () => {
  run = await launch('only-me');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  // Home, Ask, Capture, Follow-ups, then Only me under it with its lock and no count; then your projects; Tools stays at the bottom.
  await expect(page.getByTestId('sidebar').locator('.side-row')).toHaveText(['Home', 'Ask', /Capture/, 'Follow-ups', 'Only me', 'Tools']);
  await expect(page.getByTestId('needs-foot')).toHaveCount(0);
  await page.getByTestId('sidebar-only-me').click();
  await expect(page.getByTestId('title')).toHaveText('Only me');
  // A place of its own: its row is lit, Home's is not, and there is no link back.
  await expect(page.getByTestId('back')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-only-me')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('sidebar-home')).not.toHaveAttribute('aria-current', 'page');
  const rows = page.getByTestId('only-me-row');
  await expect(rows).toHaveCount(10);
  // One flat row each: a grey shape for its kind (named on hover), the title, and a short age; no boxed icon.
  await expect(rows.nth(0).getByTestId('only-me-title')).toHaveText('Pricing decision from Tuesday sync');
  await expect(rows.nth(0).getByTestId('only-me-kind')).toHaveAttribute('title', 'Note');
  await expect(rows.nth(1)).toHaveAttribute('data-kind', 'meeting');
  await expect(rows.nth(1).getByTestId('only-me-title')).toHaveText('Pricing review');
  await expect(rows.nth(1).getByTestId('only-me-kind')).toHaveAttribute('title', 'Meeting');
  await expect(page.getByTestId('only-me').locator('.item-icon')).toHaveCount(0);
  // Filed in Apollo under the lock: its row shows Apollo's tile, in the sidebar's hue, named on hover. No other row is filed.
  await expect(rows.nth(2).getByTestId('only-me-title')).toHaveText('Supplier call notes');
  await expect(rows.nth(2).getByTestId('only-me-tiles')).toHaveAttribute('title', 'Apollo');
  await expect(rows.nth(2).locator('.alt-tile')).toHaveText(['A']);
  await expect(rows.nth(2)).toHaveAttribute('aria-label', /^Note: Supplier call notes\. Filed in Apollo\. Added /);
  expect(await hue(rows.nth(2).locator('.alt-tile'))).toBe(await hue(page.getByTestId('sidebar-project').nth(0).locator('.dot')));
  await expect(page.getByTestId('only-me').locator('.alt-tile')).toHaveCount(1);
  // Every row is only yours: none carries a lock, nor any other word on who can read it.
  await expect(page.getByTestId('only-me').locator('.mark')).toHaveCount(0);
  await expect(page.getByTestId('only-me').getByLabel(/Only me|Organization/)).toHaveCount(0);
  // The time today, days under a week, then the day.
  for (const at of [0, 1, 2, 3]) await expect(rows.nth(at).getByTestId('only-me-age')).toHaveText(/^(\d{2}:\d{2}|[1-6]d|[A-Z][a-z]{2} \d{1,2})$/);
  // What others can read is not here, even what Ari added; nor what is Maya's alone.
  for (const title of ['Launch checklist', 'Pricing memo', 'Beacon kickoff', 'Maya\'s draft']) await expect(rows.filter({ hasText: title })).toHaveCount(0);
  // Its bar is Home's: all context, no chip, and ⊕ captures.
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await expect(page.getByTestId('ask-field')).toHaveAttribute('placeholder', 'Search or ask ECHO');
  await expect(page.getByTestId('write-button')).toBeVisible();

  await page.getByTestId('only-me-more').click();
  await expect(rows).toHaveCount(11);
  await expect(rows.last()).toContainText('Standup 8');
  await expect(page.getByTestId('only-me-more')).toHaveCount(0);
  expect(lists().map(call => call.body)).toEqual([{ schema_version: 1, only_me: true }, { schema_version: 1, only_me: true, cursor: expect.any(String) }]);

  // A meeting's record pages join its long actions.
  await rows.filter({ hasText: 'Pricing review' }).click();
  await expect(page.getByTestId('reader').locator('h1')).toHaveText('Pricing review');
  await expect(page.getByTestId('back')).toHaveText('Only me');
  const actions = page.getByTestId('record-actions').locator('.record-item');
  await expect(actions).toHaveCount(4);
  await page.getByTestId('reader-more').click();
  await expect(actions).toHaveCount(5);
  await expect(actions.nth(3)).toHaveText(LONG_ACTION);
  expect(opens().map(call => call.body)).toEqual([{ schema_version: 1, ref: PRICING_REVIEW }, { schema_version: 1, ref: PRICING_REVIEW, cursor: expect.any(String) }]);
  await page.getByTestId('back').click();
  await expect(rows).toHaveCount(11);
  // Escape goes Home.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('title').getByTestId('alt-stops')).toBeVisible();
  await expect(page.getByTestId('sidebar-only-me')).not.toHaveAttribute('aria-current', 'page');
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
