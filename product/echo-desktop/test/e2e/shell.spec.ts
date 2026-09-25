import { expect, test } from '@playwright/test';
import { emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const feeds = () => run.calls().filter(call => call.path === '/v2/person/projects/context/feed').length;

test('the sidebar lists your projects, and one click switches project from any page', async () => {
  run = await launch();
  const { page } = run;
  const rows = page.getByTestId('sidebar-project');
  await expect(rows).toHaveText([/Apollo$/, /Beacon$/]);
  await expect(rows.nth(0)).not.toHaveAttribute('aria-current', 'page');

  await rows.nth(1).click();
  await expect(page.getByTestId('title')).toHaveText('Beacon');
  await expect(rows.nth(1)).toHaveAttribute('aria-current', 'page');
  await rows.nth(0).click();
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'page');
  await expect(rows.nth(1)).not.toHaveAttribute('aria-current', 'page');
  await expect.poll(feeds).toBe(2);

  // An answer on screen: the sidebar still switches, and the page follows.
  await page.getByTestId('ask-field').fill('What did we agree?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('answer')).toBeVisible();
  await rows.nth(1).click();
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('Beacon');
  await expect(page.getByTestId('scope-chip')).toHaveText('Beacon');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('title')).toHaveText('ECHO');
  await expect(rows.nth(1)).not.toHaveAttribute('aria-current', 'page');
});

test('the sidebar pages with More, sharing the list Home loaded', async () => {
  run = await launch('many-projects');
  const { page } = run;
  const lists = () => run.calls().filter(call => call.path === '/v1/person/projects').length;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(10);
  await page.getByTestId('sidebar-more').click();
  await expect(page.getByTestId('sidebar-project')).toHaveCount(13);
  await expect(page.getByTestId('project-row')).toHaveCount(13);
  await expect(page.getByTestId('sidebar-more')).toHaveCount(0);
  await expect(page.getByTestId('more-projects')).toHaveCount(0);
  expect(lists()).toBe(2);
});

test('Capture in the sidebar opens capture where you are, and the account row names you', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('sidebar-capture')).toContainText('Capture');
  await expect(page.getByTestId('sidebar-capture')).toContainText('⌘⇧E');
  await expect(page.getByTestId('account-row')).toContainText('Ari');
  await expect(page.getByTestId('account-row')).toContainText('employee');
  // People & invites is for owners.
  await expect(page.getByTestId('sidebar-organization')).toHaveCount(0);

  await page.getByTestId('sidebar-capture').click();
  await expect(page.getByTestId('readers-only-me')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('compose-body')).toBeFocused();
  await page.getByTestId('compose-body').fill('Kickoff moved');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved for you');
  await expect(page.getByTestId('compose')).toHaveCount(0);

  await page.getByTestId('sidebar-project').nth(0).click();
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await page.getByTestId('sidebar-capture').click();
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Apollo');
});

test('the sidebar is on by default, and the toggle only hides it', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('sidebar')).toHaveCount(0);
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await expect(page.getByTestId('ask-field')).toBeVisible();
  // Remembered on this computer.
  await page.reload();
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await expect(page.getByTestId('sidebar')).toHaveCount(0);
  await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
});

test('while another app is in front the page is covered, and the project rows stay for a drop', async () => {
  run = await launch();
  const { page, app } = run;
  await page.getByTestId('sidebar-project').nth(0).click();
  await expect(page.getByTestId('feed-row')).toBeVisible();
  await page.getByTestId('ask-field').fill('ship');
  await expect(page.getByTestId('match-row')).toHaveCount(1);
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(page.getByTestId('feed-row')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-project')).toHaveText([/Apollo$/, /Beacon$/]);
  // Nothing says which project was open, or what was searched in it.
  await expect(page.getByTestId('sidebar-project').nth(0)).not.toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await expect(page.getByTestId('ask-field')).toHaveAttribute('placeholder', 'Search or ask ECHO');
  await expect(page.getByTestId('ask-field')).toHaveValue('');
  await expect(page.getByTestId('matches')).toHaveCount(0);
  await emit(app, 'echo-test:resume');
  await expect(page.getByTestId('sidebar-project').nth(0)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('scope-chip')).toHaveText('Apollo');
  await expect(page.getByTestId('feed-row')).toBeVisible();
  await expect(page.getByTestId('ask-field')).toHaveValue('ship');
  await expect(page.getByTestId('match-row')).toHaveCount(1);
});
