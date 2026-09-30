import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drop, emit, launch, type Launched } from './launch.js';

let run: Launched;
const folders: string[] = [];
test.afterEach(async () => {
  await run?.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const PRICING_REVIEW = `meeting:sha256:${'7'.repeat(64)}`;
const LONG_ACTION = `Draft the renewal terms.${' Clause.'.repeat(872)}`;
const lists = () => run.calls().filter(call => call.path === '/v1/person/list');
const opens = () => run.calls().filter(call => call.path === '/v1/person/open');
const log = () => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8');

type Rpc = (method: string, params?: unknown) => Promise<{ ok: boolean; failure?: { code: string } }>;

test('Mine lists only what you added, newest first, with what each is, where it is filed and who can read it; More reads the rest', async () => {
  run = await launch('mine');
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  // Under New project, and above your projects.
  await expect(page.getByTestId('sidebar').locator('.side-row')).toHaveText([/Capture/, 'New project', 'Mine']);
  await page.getByTestId('sidebar-mine').click();
  await expect(page.getByTestId('title')).toHaveText('Mine');
  await expect(page.getByTestId('back')).toHaveText('Home');
  await expect(page.getByTestId('sidebar-mine')).toHaveAttribute('aria-current', 'page');
  const rows = page.getByTestId('mine-row');
  await expect(rows).toHaveCount(10);
  await expect(rows.nth(0)).toContainText('Pricing decision from Tuesday sync');
  await expect(rows.nth(0).getByLabel('Only me')).toBeVisible();
  await expect(rows.nth(1)).toHaveAttribute('data-kind', 'meeting');
  await expect(rows.nth(1)).toContainText('Pricing review');
  await expect(rows.nth(2)).toHaveAttribute('data-kind', 'document');
  await expect(rows.nth(2).getByTestId('document-detail')).toHaveText('PDF · 22 bytes');
  await expect(rows.nth(2).getByTestId('item-projects')).toHaveText('Apollo');
  await expect(rows.nth(3)).toContainText('Launch checklist');
  await expect(rows.nth(3).getByTestId('item-projects')).toHaveText('Apollo, Beacon');
  await expect(rows.nth(3).getByLabel('Organization')).toBeVisible();
  // Maya approved Beacon's kickoff: it is in Beacon, not in Ari's Mine.
  await expect(rows.filter({ hasText: 'Beacon kickoff' })).toHaveCount(0);
  // A place to see and ask: no ⊕, and nothing offers to capture.
  await expect(page.getByTestId('write-button')).toHaveCount(0);
  await expect(page.getByTestId('empty-capture')).toHaveCount(0);

  await page.getByTestId('mine-more').click();
  await expect(rows).toHaveCount(12);
  await expect(rows.last()).toContainText('Standup 8');
  await expect(page.getByTestId('mine-more')).toHaveCount(0);
  expect(lists().map(call => call.body)).toEqual([{ schema_version: 1, mine: true }, { schema_version: 1, mine: true, cursor: expect.any(String) }]);

  await page.getByTestId('back').click();
  await expect(page.getByTestId('title')).toHaveText('ECHO');
  await expect(page.getByTestId('sidebar-mine')).not.toHaveAttribute('aria-current', 'page');
});

test('a project renamed from Mine takes its new name in every row, and the rows More loaded stay', async () => {
  run = await launch('mine');
  const { page } = run;
  await page.getByTestId('sidebar-mine').click();
  const rows = page.getByTestId('mine-row');
  await expect(rows).toHaveCount(10);
  await page.getByTestId('mine-more').click();
  await expect(rows).toHaveCount(12);
  await page.getByRole('button', { name: 'Actions for Apollo' }).click();
  await page.getByTestId('project-rename').click();
  await page.getByTestId('project-rename-input').fill('Apollo 2');
  await page.getByTestId('project-rename-save').click();
  await expect(page.getByTestId('toast')).toHaveText('Renamed to Apollo 2');
  await expect(page.getByTestId('title')).toHaveText('Mine');
  await expect(rows.nth(2).getByTestId('item-projects')).toHaveText('Apollo 2');
  await expect(rows.nth(3).getByTestId('item-projects')).toHaveText('Apollo 2, Beacon');
  await expect(page.getByTestId('item-projects').filter({ hasText: /Apollo(?! 2)/ })).toHaveCount(0);
  await expect(rows).toHaveCount(12);
});

test('a meeting opened from Mine is its approved record: More reads the rest, and a long action\'s parts join into one', async () => {
  run = await launch('mine');
  const { page } = run;
  await page.getByTestId('sidebar-mine').click();
  await page.getByTestId('mine-row').filter({ hasText: 'Pricing review' }).click();
  const record = page.getByTestId('record');
  await expect(record.locator('h2')).toHaveText('Pricing review');
  await expect(page.getByTestId('record-visibility')).toHaveText('Only the approver');
  await expect(record).toContainText('Record approved by');
  await expect(record).toContainText('Ari, Maya Chen');
  await expect(page.getByTestId('back')).toHaveText('Mine');
  // An approved meeting's projects were set when it was approved: nothing to file.
  await expect(page.getByTestId('reader-actions')).toHaveCount(0);
  const decisions = page.getByTestId('record-decisions').locator('.record-item');
  const actions = page.getByTestId('record-actions').locator('.record-item');
  await expect(decisions).toHaveCount(20);
  await expect(actions).toHaveCount(4);
  await expect(page.getByTestId('record-owner')).toHaveText('Owner: Maya Chen');
  await expect(page.getByTestId('record-rationales')).toHaveCount(0);

  await page.getByTestId('reader-more').click();
  await expect(actions).toHaveCount(5);
  await expect(actions.nth(3)).toHaveText(LONG_ACTION);
  await expect(page.getByTestId('record-rationales').locator('.record-item')).toHaveText(['Annual plans fund the launch.', 'Teams asked for one price sheet.']);
  await expect(page.getByTestId('reader-more')).toHaveCount(0);
  expect(opens().map(call => call.body)).toEqual([{ schema_version: 1, ref: PRICING_REVIEW }, { schema_version: 1, ref: PRICING_REVIEW, cursor: expect.any(String) }]);

  await page.getByTestId('back').click();
  await expect(page.getByTestId('mine-row')).toHaveCount(10);
  await expect(page.getByTestId('title')).toHaveText('Mine');
});

test('Mine\'s bar only asks what you added, and a cited original is read under all you may read', async () => {
  run = await launch('mine');
  const { page } = run;
  const field = page.getByTestId('ask-field');
  await page.getByTestId('sidebar-mine').click();
  await expect(page.getByTestId('scope-chip')).toHaveText('Mine');
  await expect(field).toHaveAttribute('placeholder', 'Ask Mine');
  await field.fill('pricing');
  await expect(page.getByTestId('match-ask')).toContainText('Ask Mine about “pricing”');
  await expect(page.getByTestId('matches-head')).toHaveCount(0);
  await expect(page.getByTestId('match-row')).toHaveCount(0);
  expect(run.calls().filter(call => call.path.endsWith('/updates/search') || call.path.endsWith('/context/search'))).toHaveLength(0);

  await field.press('Enter');
  await expect(page.getByTestId('answer')).toBeVisible();
  await expect(page.locator('.asked')).toHaveText('Mine');
  const asks = run.calls().filter(call => call.path === '/v3/person/ask');
  expect(asks.map(call => call.body)).toEqual([{ schema_version: 3, question: 'pricing', mine: true }]);
  await page.getByTestId('citation').nth(1).click();
  await expect(page.getByTestId('evidence-text')).toHaveText('We agreed to ship.');
  expect(run.calls().find(call => call.path === '/v2/person/ask/source')?.body?.scope).toEqual({ kind: 'global' });

  // Back on Mine, × widens the bar to all context; the page stays.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('title')).toHaveText('Mine');
  await page.getByTestId('scope-clear').click();
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await expect(field).toHaveAttribute('placeholder', 'Search or ask ECHO');
  await expect(page.getByTestId('mine-row')).toHaveCount(10);
});

test('a save only Mine shows opens it from its toast, and a save made on Mine joins the list', async () => {
  run = await launch('mine');
  const { page, app } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await emit(app, 'echo-test:capture');
  await page.getByTestId('compose-body').fill('Call notes with Dana');
  await page.getByTestId('compose-send').click();
  const toast = page.getByTestId('toast');
  await expect(toast).toHaveText('Saved for you');
  await expect(toast).toHaveJSProperty('tagName', 'BUTTON');
  await toast.click();
  await expect(page.getByTestId('title')).toHaveText('Mine');
  await expect(page.getByTestId('mine-row').first()).toContainText('Call notes with Dana');
  await expect(page.getByTestId('mine-row').first().getByLabel('Only me')).toBeVisible();

  // Captured over Mine for everyone: the list is read again, and holds it too.
  const before = lists().length;
  await page.getByTestId('sidebar-capture').click();
  await page.getByTestId('readers-team').click();
  await page.getByTestId('compose-body').fill('All hands notes');
  await page.getByTestId('compose-send').click();
  await expect(toast).toHaveText('Shared with your organization');
  await expect.poll(() => lists().length).toBe(before + 1);
  await expect(page.getByTestId('mine-row').filter({ hasText: 'All hands notes' })).toHaveCount(1);
  await expect(page.getByTestId('mine-row').filter({ hasText: 'Call notes with Dana' })).toHaveCount(1);

  // A save to a project says where it went, and opens nothing.
  await page.getByTestId('sidebar-project').nth(0).click();
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Apollo standup');
  await page.getByTestId('compose-send').click();
  await expect(toast).toHaveText('Saved to Apollo');
  await expect(toast).toHaveJSProperty('tagName', 'DIV');
});

test('with nothing added yet Mine is blank, and a file dropped on it is not taken', async () => {
  run = await launch('mine-empty');
  const { page } = run;
  await page.getByTestId('sidebar-mine').click();
  await expect(page.getByTestId('mine')).toBeVisible();
  await expect(page.getByTestId('mine')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByTestId('mine-row')).toHaveCount(0);
  await expect(page.getByTestId('empty-capture')).toHaveCount(0);
  await expect(page.getByTestId('mine-error')).toHaveCount(0);
  await expect(page.getByTestId('write-button')).toHaveCount(0);

  const folder = mkdtempSync(join(tmpdir(), 'echo-drop-'));
  folders.push(folder);
  writeFileSync(join(folder, 'Brief.md'), 'Annual pricing.');
  await drop(page, page.getByTestId('mine'), join(folder, 'Brief.md'));
  await drop(page, page.getByTestId('sidebar-mine'), join(folder, 'Brief.md'));
  await page.waitForTimeout(300);
  await expect(page.getByTestId('compose')).toHaveCount(0);
  expect(log()).not.toMatch(/drop ok/);
  // A project row still takes it, into that project.
  await drop(page, page.getByTestId('sidebar-project').nth(0), join(folder, 'Brief.md'));
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Apollo');
});

test('Mine that could not be read says why and reads again; a project you were taken out of is no longer available, and you stay signed in', async () => {
  run = await launch('mine-fails-once');
  let { page } = run;
  await page.getByTestId('sidebar-mine').click();
  await expect(page.getByTestId('mine-error')).toContainText('ECHO is unavailable right now. Try again.');
  await page.getByTestId('mine-retry').click();
  await expect(page.getByTestId('mine-row')).toHaveCount(10);
  await expect(page.getByTestId('mine-error')).toHaveCount(0);
  expect(lists()).toHaveLength(2);

  await run.close();
  run = await launch('feed-unauthorized');
  ({ page } = run);
  await page.getByTestId('project-row').nth(0).click();
  await expect(page.getByTestId('feed-error')).toContainText('This is no longer available to you.');
  await expect(page.getByText('Sign in again')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  // Your account and projects are read again, once.
  const after = () => log().split('list.page unauthorized')[1] ?? '';
  await expect.poll(() => after().match(/projects\.list ok/g)?.length ?? 0).toBe(1);
  await page.waitForTimeout(300);
  expect(after().match(/app\.status/g)).toHaveLength(1);
  await expect(page.getByTestId('account-row')).toContainText('Ari');
});

test('the host opens only a well-formed ref, in a scope the app lists, and anything you cannot read is not_found', async () => {
  run = await launch('mine');
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
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
      noScope: await rpc('list.page', { expect }),
      badProject: await rpc('list.page', { expect, scope: { kind: 'project', project_id: 'prj_../x' } }),
      longCursor: await rpc('list.page', { expect, scope: { kind: 'mine' }, cursor: 'x'.repeat(513) }),
    };
  });
  expect(replies.guessed).toMatchObject({ ok: false, failure: { code: 'not_found' } });
  for (const reply of [replies.badId, replies.transcript, replies.noteCursor, replies.badCursor, replies.global, replies.noScope, replies.badProject,
    replies.longCursor]) {
    expect(reply).toMatchObject({ ok: false, failure: { code: 'invalid_request' } });
  }
  // Only the guessed ref reached the Authority.
  expect(opens().map(call => call.body)).toEqual([{ schema_version: 1, ref: `meeting:sha256:${'0'.repeat(64)}` }]);
  expect(lists()).toHaveLength(0);
});

test('a project\'s page lists its approved meetings too, and an owner\'s Mine holds what they approved', async () => {
  run = await launch('owner-mine');
  const { page } = run;
  await expect(page.getByTestId('sidebar-organization')).toBeVisible();
  await page.getByTestId('project-row').nth(1).click();
  const rows = page.getByTestId('feed-row');
  await expect(rows.filter({ hasText: 'Beacon kickoff' })).toHaveAttribute('data-kind', 'meeting');
  await expect(rows.filter({ hasText: 'Launch checklist' })).toHaveCount(1);
  // A project's rows do not repeat its name.
  await expect(page.getByTestId('item-projects')).toHaveCount(0);
  expect(lists().map(call => call.body)).toEqual([{ schema_version: 1, project_id: 'prj_44444444-4444-4444-8444-444444444444' }]);
  await rows.filter({ hasText: 'Beacon kickoff' }).click();
  await expect(page.getByTestId('record-visibility')).toHaveText('Visible to project members');
  await expect(page.getByTestId('record')).toContainText('Maya Chen');
  await expect(page.getByTestId('back')).toHaveText('Beacon');

  await page.getByTestId('sidebar-mine').click();
  await expect(page.getByTestId('title')).toHaveText('Mine');
  await expect(page.getByTestId('reader')).toHaveCount(0);
  await expect(page.getByTestId('mine-row').filter({ hasText: 'Pricing review' })).toHaveCount(1);
  await expect(page.getByTestId('mine-row').filter({ hasText: 'Beacon kickoff' })).toHaveCount(0);

  // "Yesterday", the longest date a row shows, fits its place: nothing is cut, and the list never scrolls sideways.
  const fit = await page.getByTestId('mine-row').first().locator('.meta').evaluate((meta) => {
    const other = meta.closest('.column')!.querySelectorAll('.item-row .meta')[1]!;
    meta.textContent = 'Yesterday';
    const column = meta.closest('.column')!;
    return {
      cut: meta.scrollWidth > meta.clientWidth, sideways: column.scrollWidth > column.clientWidth,
      edges: meta.getBoundingClientRect().right - other.getBoundingClientRect().right,
    };
  });
  expect(fit).toEqual({ cut: false, sideways: false, edges: 0 });
});
