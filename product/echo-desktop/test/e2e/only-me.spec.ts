import { expect, test, type Locator } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseFromAccountMenu, drop, emit, launch, type Launched } from './launch.js';

// ADR-0049: Mine goes; Only me is a quiet link on Home, the list of everything only you can read, filed or not.
let run: Launched;
const folders: string[] = [];
test.afterEach(async () => {
  await run?.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const APOLLO = 'prj_11111111-1111-4111-8111-111111111111';
const PRICING_REVIEW = `meeting:sha256:${'7'.repeat(64)}`;
const LONG_ACTION = `Draft the renewal terms.${' Clause.'.repeat(872)}`;
const lists = () => run.calls().filter(call => call.path === '/v1/person/list');
const opens = () => run.calls().filter(call => call.path === '/v1/person/open');
const notes = () => run.calls().filter(call => call.method === 'POST' && call.path === '/v3/person/updates');
const log = () => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8');

type Rpc = (method: string, params?: unknown) => Promise<{ ok: boolean; failure?: { code: string } }>;

test('Home\'s footer opens Only me: what only you can read, filed or not, newest first, with no lock on any row; More reads the rest', async () => {
  run = await launch('only-me');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  // Mine is gone: Home, Ask, Capture and Follow-ups, then your projects; Tools stays at the bottom.
  await expect(page.getByTestId('sidebar').locator('.side-row')).toHaveText(['Home', 'Ask', /Capture/, 'Follow-ups', 'Tools']);
  // A quiet link after Follow-ups, with its lock and no count.
  await expect(page.getByTestId('needs-foot')).toContainText('Follow-ups · Only me');
  await expect(page.getByTestId('home-only-me')).toHaveText('Only me');
  await page.getByTestId('home-only-me').click();
  await expect(page.getByTestId('title')).toHaveText('Only me');
  await expect(page.getByTestId('back')).toHaveText('Home');
  await expect(page.getByTestId('sidebar-home')).toHaveAttribute('aria-current', 'page');
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
  const hue = (of: Locator) => of.evaluate(element => getComputedStyle(element).color);
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

  await page.getByTestId('back').click();
  await expect(page.getByTestId('title')).toHaveText('ECHO');
  await expect(page.getByTestId('home-only-me')).toBeVisible();
});

test('a project renamed from Only me takes its new name in every row, and the rows More loaded stay', async () => {
  run = await launch('only-me');
  const { page } = run;
  await page.getByTestId('home-only-me').click();
  const rows = page.getByTestId('only-me-row');
  await expect(rows).toHaveCount(10);
  await page.getByTestId('only-me-more').click();
  await expect(rows).toHaveCount(11);
  await page.getByRole('button', { name: 'Actions for Apollo' }).click();
  await page.getByTestId('project-rename').click();
  await page.getByTestId('project-rename-input').fill('Apollo 2');
  await page.getByTestId('project-rename-save').click();
  await expect(page.getByTestId('toast')).toHaveText('Renamed to Apollo 2');
  await expect(page.getByTestId('title')).toHaveText('Only me');
  // The tile keeps Apollo's hue under its new name: it is still the one project of yours called that.
  await expect(rows.nth(2).getByTestId('only-me-tiles')).toHaveAttribute('title', 'Apollo 2');
  await expect(rows.nth(2).locator('.only-me-unplaced')).toHaveCount(0);
  await expect(page.locator('[data-testid="only-me-tiles"][title="Apollo"]')).toHaveCount(0);
  await expect(rows).toHaveCount(11);
});

test('a file filed in two projects shows a tile for each, in the sidebar\'s hues, named on hover; an archived project\'s tile turns quiet', async () => {
  run = await launch('only-me-filed');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('home-only-me').click();
  const contract = page.getByTestId('only-me-row').filter({ hasText: 'Supplier contract' });
  // A file: its shape, with its type and size on hover, and no extension or size line in the row.
  await expect(contract).toHaveAttribute('data-kind', 'document');
  await expect(contract.getByTestId('only-me-kind')).toHaveAttribute('title', /^File · PDF · \d+ bytes$/);
  await expect(contract.getByTestId('only-me-title')).toHaveText('Supplier contract');
  await expect(contract.getByTestId('document-detail')).toHaveCount(0);
  const tiles = contract.locator('.alt-tile');
  await expect(tiles).toHaveText(['A', 'B']);
  await expect(contract.getByTestId('only-me-tiles')).toHaveAttribute('title', 'Apollo, Beacon');
  await expect(contract).toHaveAttribute('aria-label', /^File: Supplier contract\. Filed in Apollo, Beacon\. Added /);
  const hue = (of: Locator) => of.evaluate(element => getComputedStyle(element).color);
  const sidebar = page.getByTestId('sidebar-project');
  expect(await hue(tiles.nth(0))).toBe(await hue(sidebar.nth(0).locator('.dot')));
  expect(await hue(tiles.nth(1))).toBe(await hue(sidebar.nth(1).locator('.dot')));

  // Archived, Apollo is no project Home can see: its tile turns quiet and is still named on hover; Beacon's keeps its hue.
  await page.getByRole('button', { name: 'Actions for Apollo' }).click();
  await page.getByTestId('project-archive').click();
  await page.getByTestId('project-settings-confirm').click();
  await expect(page.getByTestId('toast')).toHaveText('Archived Apollo');
  await expect(page.getByTestId('title')).toHaveText('Only me');
  await expect(tiles.nth(0)).toHaveClass(/only-me-unplaced/);
  await expect(tiles.nth(1)).not.toHaveClass(/only-me-unplaced/);
  expect(await hue(tiles.nth(1))).toBe(await hue(sidebar.nth(0).locator('.dot')));
  await expect(contract.getByTestId('only-me-tiles')).toHaveAttribute('title', 'Apollo, Beacon');

  // The row still opens the file.
  await contract.click();
  await expect(page.getByTestId('reader').locator('h1')).toHaveText('Supplier contract');
  await expect(page.getByTestId('back')).toHaveText('Only me');
});

test('an item opened from Only me is read by its ref, Back returns to Only me, and it can be filed in another project but not removed', async () => {
  run = await launch('only-me');
  const { page } = run;
  await page.getByTestId('home-only-me').click();
  const rows = page.getByTestId('only-me-row');
  await expect(rows).toHaveCount(10);
  await rows.nth(0).click();
  await expect(page.getByTestId('reader').locator('h1')).toHaveText('Pricing decision from Tuesday sync');
  await expect(page.getByTestId('reader-meta')).toHaveText(/^Only me · \S/);
  await expect(page.getByTestId('reader-text')).not.toBeEmpty();
  await expect(page.getByTestId('back')).toHaveText('Only me');
  await page.getByTestId('reader-actions').click();
  await expect(page.getByTestId('reader-add')).toBeVisible();
  await expect(page.getByTestId('reader-remove')).toHaveCount(0);
  // Back closes the menu first, then the reader.
  await page.getByTestId('back').click();
  await expect(page.getByTestId('reader-menu')).toHaveCount(0);
  await page.getByTestId('back').click();
  await expect(rows).toHaveCount(10);

  // Filed in Apollo: it can be added to Beacon too; only Apollo's page takes it out of Apollo.
  await rows.nth(2).click();
  await expect(page.getByTestId('reader').locator('h1')).toHaveText('Supplier call notes');
  await expect(page.getByTestId('reader-text')).toContainText('Lead times slip two weeks.');
  await expect(page.getByTestId('back')).toHaveText('Only me');
  await page.getByTestId('reader-actions').click();
  await expect(page.getByTestId('reader-remove')).toHaveCount(0);
  await page.getByTestId('reader-add').click();
  await expect(page.getByTestId('reader-project')).toHaveText(['Beacon']);
  expect(opens().map(call => call.body)).toEqual([
    { schema_version: 1, ref: `note:ctx_${'d'.repeat(64)}` }, { schema_version: 1, ref: `note:ctx_${'5'.repeat(64)}` },
  ]);
});

test('signing out on Only me leaves it and clears what it read, and signing in again lands on Home', async () => {
  run = await launch('only-me');
  const { page, app, home } = run;
  await page.getByTestId('home-only-me').click();
  await page.getByTestId('only-me-row').nth(0).click();
  await expect(page.getByTestId('reader-text')).not.toBeEmpty();
  // Signed out elsewhere, as the terminal's `person logout` does.
  rmSync(join(home, '.local', 'share', 'echo-brain', 'person', 'session.v1.json'));
  await emit(app, 'echo-test:shown');
  await expect(page.getByTestId('signed-out')).toBeVisible();
  await expect(page.getByTestId('reader')).toHaveCount(0);
  await expect(page.getByTestId('only-me-row')).toHaveCount(0);
  await chooseFromAccountMenu(run, page.getByTestId('signin-open'), 'Sign in with Google…');
  await page.getByTestId('signin-url').fill('https://authority.example');
  await page.getByTestId('signin-button').click();
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await expect(page.getByTestId('title')).toHaveText('ECHO');
  await expect(page.getByTestId('reader')).toHaveCount(0);
  await expect(page.getByTestId('only-me-row')).toHaveCount(0);
  await expect(page.getByTestId('home-only-me')).toBeVisible();
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
});

test('while meetings wait to be indexed, a save on Only me keeps the meetings shown, and the next read applies', async () => {
  run = await launch('only-me-meetings-held');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('home-only-me').click();
  const rows = page.getByTestId('only-me-row');
  await expect(rows.filter({ hasText: 'Pricing review' })).toHaveCount(1);
  // Saved from Only me, in no project: only you can read it, so Only me is read again.
  const save = async (text: string) => {
    await page.getByTestId('sidebar-capture').click();
    await page.getByTestId('compose-body').fill(text);
    await page.getByTestId('compose-send').click();
    await expect(page.getByTestId('toast')).toHaveText('Saved for you');
  };
  // The read after this save holds meetings: it is not applied, so nothing shown goes.
  await save('Held notes');
  await expect.poll(() => lists().length).toBe(2);
  await page.waitForTimeout(300);
  await expect(rows.filter({ hasText: 'Pricing review' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Held notes' })).toHaveCount(0);
  // The next read, with meetings again, is applied.
  await save('Indexed notes');
  await expect.poll(() => lists().length).toBe(3);
  await expect(rows.filter({ hasText: 'Indexed notes' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Held notes' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Pricing review' })).toHaveCount(1);
});

test('a meeting opened from Only me is its approved record: More reads the rest, and a long action\'s parts join into one', async () => {
  run = await launch('only-me');
  const { page } = run;
  await page.getByTestId('home-only-me').click();
  await page.getByTestId('only-me-row').filter({ hasText: 'Pricing review' }).click();
  const record = page.getByTestId('record');
  // Headed like any item read from Only me: its title, and who can read it in the row's words, with when it was added.
  await expect(page.getByTestId('reader').locator('h1')).toHaveText('Pricing review');
  await expect(page.getByTestId('reader-meta')).toHaveText(/^Only me · \S/);
  await expect(record.locator('h2')).toHaveCount(0);
  await expect(page.getByTestId('record-visibility')).toHaveCount(0);
  await expect(record).toContainText('Record approved by');
  await expect(record).toContainText('Ari, Maya Chen');
  await expect(page.getByTestId('back')).toHaveText('Only me');
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
  await expect(page.getByTestId('only-me-row')).toHaveCount(10);
  await expect(page.getByTestId('title')).toHaveText('Only me');
});

test('Capture from Only me starts in no project; "Saved for you" opens Only me on it, and what only you can read joins the list', async () => {
  run = await launch('only-me');
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await emit(app, 'echo-test:capture');
  await page.getByTestId('compose-body').fill('Call notes with Dana');
  await page.getByTestId('compose-send').click();
  const toast = page.getByTestId('toast');
  await expect(toast).toHaveText('Saved for you');
  await expect(toast).toHaveJSProperty('tagName', 'BUTTON');
  await toast.click();
  await expect(page.getByTestId('title')).toHaveText('Only me');
  const rows = page.getByTestId('only-me-row');
  await expect(rows.first()).toContainText('Call notes with Dana');

  // ⊕ on Only me: no project, so only you, with the lock on for good.
  await page.getByTestId('write-button').click();
  await expect(page.getByTestId('capture-place')).toHaveText('No project');
  await expect(page.getByTestId('capture-lock')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('capture-lock')).toBeDisabled();
  const before = lists().length;
  await page.getByTestId('compose-body').fill('Second thoughts');
  await page.getByTestId('compose-send').click();
  await expect(toast).toHaveText('Saved for you');
  await expect.poll(() => lists().length).toBe(before + 1);
  await expect(rows.filter({ hasText: 'Second thoughts' })).toHaveCount(1);
  expect(notes()[1]!.body).toMatchObject({ audience: { kind: 'only_me' }, association_project_ids: [] });

  // Filed in Apollo under the lock: it joins Only me too, naming Apollo, and its toast opens nothing.
  await page.getByTestId('write-button').click();
  await page.getByTestId('capture-place').click();
  await page.getByTestId('projects-list').getByRole('checkbox', { name: 'Apollo', exact: true }).click();
  await page.getByTestId('projects-done').click();
  await page.getByTestId('capture-lock').click();
  await page.getByTestId('compose-body').fill('Apollo pricing, privately');
  await page.getByTestId('compose-send').click();
  await expect(toast).toHaveText('Saved to Apollo · only you');
  await expect(toast).toHaveJSProperty('tagName', 'DIV');
  await expect(rows.filter({ hasText: 'Apollo pricing, privately' }).getByTestId('only-me-tiles')).toHaveAttribute('title', 'Apollo');
  expect(notes()[2]!.body).toMatchObject({ audience: { kind: 'only_me' }, association_project_ids: [APOLLO] });

  // For everyone: not only yours, so Only me is not read again, and its toast opens nothing either.
  const read = lists().length;
  await page.getByTestId('write-button').click();
  await page.getByTestId('capture-place').click();
  await page.getByTestId('place-team').click();
  await page.getByTestId('compose-body').fill('All hands notes');
  await page.getByTestId('compose-send').click();
  await expect(toast).toHaveText('Shared with your organization');
  await expect(toast).toHaveJSProperty('tagName', 'DIV');
  await page.waitForTimeout(300);
  expect(lists()).toHaveLength(read);
  await expect(rows.filter({ hasText: 'All hands notes' })).toHaveCount(0);
});

// ADR-0049: a locked item filed in a project shows there, with the lock, for its owner alone.
test('a note locked in a project lists there with the lock for its owner, never another member\'s, and Capture there locks one too', async () => {
  run = await launch('only-me');
  const { page } = run;
  await page.getByTestId('sidebar-project').nth(0).click();
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  const rows = page.getByTestId('feed-row');
  const supplier = rows.filter({ hasText: 'Supplier call notes' });
  await expect(supplier).toHaveCount(1);
  await expect(supplier.getByLabel('Only me')).toBeVisible();
  // Maya's, filed in Apollo under her own lock: never listed for Ari.
  await expect(rows.filter({ hasText: 'Launch checklist' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Maya\'s draft' })).toHaveCount(0);

  await page.getByTestId('write-button').click();
  await expect(page.getByTestId('capture-place')).toHaveText('Apollo');
  await page.getByTestId('capture-lock').click();
  await page.getByTestId('compose-body').fill('Private pricing notes');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved to Apollo · only you');
  expect(notes()[0]!.body).toMatchObject({ audience: { kind: 'only_me' }, association_project_ids: [APOLLO] });
  // Apollo's list is read again, and holds it with the lock.
  const saved = rows.filter({ hasText: 'Private pricing notes' });
  await expect(saved).toHaveCount(1);
  await expect(saved.getByLabel('Only me')).toBeVisible();
  await saved.click();
  await expect(page.getByTestId('reader-meta')).toHaveText(/^Only me · /);
  await expect(page.getByTestId('back')).toHaveText('Apollo');
  // Only me holds it too, naming Apollo.
  await page.getByTestId('sidebar-home').click();
  await page.getByTestId('home-only-me').click();
  await expect(page.getByTestId('only-me-row').filter({ hasText: 'Private pricing notes' }).getByTestId('only-me-tiles')).toHaveAttribute('title', 'Apollo');
});

test('with nothing only you can read Only me is blank, and a file dropped on it starts Capture in no project', async () => {
  run = await launch('only-me-empty');
  const { page } = run;
  await page.getByTestId('home-only-me').click();
  await expect(page.getByTestId('only-me')).toBeVisible();
  await expect(page.getByTestId('only-me')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByTestId('only-me-row')).toHaveCount(0);
  await expect(page.getByTestId('only-me-error')).toHaveCount(0);

  const folder = mkdtempSync(join(tmpdir(), 'echo-drop-'));
  folders.push(folder);
  writeFileSync(join(folder, 'Brief.md'), 'Annual pricing.');
  await drop(page, page.getByTestId('only-me'), join(folder, 'Brief.md'));
  await expect(page.getByTestId('compose-file')).toHaveText('Brief.md · 15 bytes');
  await expect(page.getByTestId('capture-place')).toHaveText('No project');
  await expect(page.getByTestId('capture-lock')).toHaveAttribute('aria-pressed', 'true');
  expect(log()).toMatch(/drop ok/);
});

test('Only me that could not be read says why and reads again; a project you were taken out of is no longer available, and you stay signed in', async () => {
  run = await launch('only-me-fails-once');
  let { page } = run;
  await page.getByTestId('home-only-me').click();
  await expect(page.getByTestId('only-me-error')).toContainText('ECHO is unavailable right now. Try again.');
  await page.getByTestId('only-me-retry').click();
  await expect(page.getByTestId('only-me-row')).toHaveCount(10);
  await expect(page.getByTestId('only-me-error')).toHaveCount(0);
  expect(lists()).toHaveLength(2);

  await run.close();
  run = await launch('feed-unauthorized');
  ({ page } = run);
  await page.getByTestId('sidebar-project').nth(0).click();
  await expect(page.getByTestId('feed-error')).toContainText('This is no longer available to you.');
  await expect(page.getByText('This is no longer available to you.')).toBeVisible();
  await expect(page.getByText('Sign in again')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  // Your account and projects are read again, once.
  const after = () => log().split('list.page unauthorized')[1] ?? '';
  await expect.poll(() => after().match(/projects\.list ok/g)?.length ?? 0).toBe(1);
  await page.waitForTimeout(300);
  expect(after().match(/app\.status/g)).toHaveLength(1);
  await expect(page.getByTestId('account-row')).toContainText('Ari');
});

test('Only me refused for the same account says your access changed, and reads status again once', async () => {
  run = await launch('only-me-unauthorized');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('home-only-me').click();
  await expect(page.getByTestId('only-me-error')).toContainText('Your access changed. Sign in again.');
  const after = () => log().split('list.page unauthorized')[1] ?? '';
  await expect.poll(() => after().match(/app\.status/g)?.length ?? 0).toBe(1);
  await page.waitForTimeout(300);
  expect(after().match(/app\.status/g)).toHaveLength(1);
  await expect(page.getByTestId('account-row')).toContainText('Ari');
});

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

test('a project\'s page lists its approved meetings too, and an owner\'s Only me holds the meeting only they can read', async () => {
  run = await launch('owner-only-me');
  const { page } = run;
  await expect(page.getByTestId('sidebar-organization')).toBeVisible();
  await page.getByTestId('sidebar-project').nth(1).click();
  const rows = page.getByTestId('feed-row');
  await expect(rows.filter({ hasText: 'Beacon kickoff' })).toHaveAttribute('data-kind', 'meeting');
  await expect(rows.filter({ hasText: 'Launch checklist' })).toHaveCount(1);
  // A project's rows name no project, though Launch checklist is filed in Apollo too.
  await expect(rows.filter({ hasText: 'Launch checklist' })).not.toContainText(/Apollo|Beacon/);
  expect(lists().map(call => call.body)).toEqual([{ schema_version: 1, project_id: 'prj_44444444-4444-4444-8444-444444444444' }]);
  await rows.filter({ hasText: 'Beacon kickoff' }).click();
  // A project members' meeting, like its row, has no readers word.
  await expect(page.getByTestId('reader').locator('h1')).toHaveText('Beacon kickoff');
  await expect(page.getByTestId('reader-meta')).not.toHaveText(/Only me|Organization/);
  await expect(page.getByTestId('reader-meta')).not.toBeEmpty();
  await expect(page.getByTestId('record')).toContainText('Maya Chen');
  await expect(page.getByTestId('back')).toHaveText('Beacon');

  await page.getByTestId('sidebar-home').click();
  await page.getByTestId('home-only-me').click();
  await expect(page.getByTestId('title')).toHaveText('Only me');
  await expect(page.getByTestId('reader')).toHaveCount(0);
  await expect(page.getByTestId('only-me-row').filter({ hasText: 'Pricing review' })).toHaveCount(1);
  await expect(page.getByTestId('only-me-row').filter({ hasText: 'Beacon kickoff' })).toHaveCount(0);

  // "Sep 30", the longest age a row shows, fits its place: nothing is cut, every age ends at the same edge, and the list
  // never scrolls sideways.
  const fit = await page.getByTestId('only-me-row').first().getByTestId('only-me-age').evaluate((age) => {
    const column = age.closest('.column')!;
    const other = column.querySelectorAll('[data-testid="only-me-age"]')[1]!;
    age.textContent = 'Sep 30';
    return {
      cut: age.scrollWidth > age.clientWidth, sideways: column.scrollWidth > column.clientWidth,
      edges: age.getBoundingClientRect().right - other.getBoundingClientRect().right,
    };
  });
  expect(fit).toEqual({ cut: false, sideways: false, edges: 0 });
});
