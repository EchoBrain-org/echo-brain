import { expect, test, type Page } from '@playwright/test';
import { emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => {
  await run?.close();
});

const APOLLO = 'prj_11111111-1111-4111-8111-111111111111';
const BEACON = 'prj_44444444-4444-4444-8444-444444444444';
const notes = () => run.calls().filter(call => call.method === 'POST' && call.path === '/v3/person/updates');
const place = (page: Page) => page.getByTestId('capture-place');
const lock = (page: Page) => page.getByTestId('capture-lock');
const list = (page: Page) => page.getByTestId('projects-list');
const tick = (page: Page, name: string) => list(page).getByRole('checkbox', { name, exact: true });

// ADR-0049: where it goes and who can read it, as the desktop sends them.
test('each place saves as it says: a project, a project under the lock, no project, and the organization', async () => {
  run = await launch();
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);

  // From Home: no project, and so only you; the lock shows on and cannot be turned off.
  await emit(app, 'echo-test:capture');
  await expect(page.getByTestId('compose-body')).toBeFocused();
  await expect(place(page)).toHaveText('No project');
  await expect(lock(page)).toHaveText('Only me');
  await expect(lock(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(lock(page)).toBeDisabled();
  await expect(page.getByTestId('compose-readers')).toHaveText('Only you can read this.');
  await expect(page.getByRole('status')).toHaveText('');
  await page.getByTestId('compose-body').fill('Kickoff moved to Monday');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved for you');
  await expect(page.getByRole('status')).toHaveText('Saved for you');
  await expect(page.getByTestId('compose')).toHaveCount(0);
  await expect(page.getByTestId('ask-field')).toBeFocused();
  await page.getByTestId('toast').click();
  await expect(page.getByTestId('title')).toHaveText('Only me');
  expect(notes()[0]!.body).toMatchObject({ title: 'Kickoff moved to Monday', audience: { kind: 'only_me' }, association_project_ids: [] });

  // From a project: that project, unlocked, for its members.
  await page.getByTestId('sidebar-project').nth(0).click();
  await page.getByTestId('write-button').click();
  await expect(place(page)).toHaveText('Apollo');
  await expect(lock(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(lock(page)).toBeEnabled();
  await expect(page.getByTestId('compose-readers')).toHaveText('Apollo members can read this.');
  await page.getByTestId('compose-body').fill('Weekly update');
  await page.getByTestId('compose-body').press('Tab');
  await expect(place(page)).toBeFocused();
  await place(page).press('Enter');
  await expect(tick(page, 'Apollo')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByTestId('compose')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('toast')).toHaveText('Saved to Apollo');
  expect(notes()[1]!.body).toMatchObject({ audience: { kind: 'project', project_id: APOLLO }, association_project_ids: [APOLLO] });

  // Two projects: filed in both, for both projects' members.
  await page.getByTestId('write-button').click();
  await place(page).click();
  await tick(page, 'Beacon').click();
  await list(page).getByTestId('projects-done').click();
  await page.getByTestId('compose-body').fill('Pricing for both teams');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved to Apollo and Beacon');
  expect(notes()[2]!.body).toMatchObject({ audience: { kind: 'projects', project_ids: [APOLLO, BEACON] }, association_project_ids: [APOLLO, BEACON] });

  // The lock on: still filed in Apollo, and only you can read it.
  await page.getByTestId('write-button').click();
  await lock(page).click();
  await expect(lock(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(place(page)).toHaveText('Apollo');
  await expect(page.getByTestId('compose-readers')).toHaveText('Only you can read this.');
  await page.getByTestId('compose-body').fill('My own reminder');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved to Apollo · only you');
  expect(notes()[3]!.body).toMatchObject({ audience: { kind: 'only_me' }, association_project_ids: [APOLLO] });

  // Organization: everyone, filed in no project, and no lock to offer.
  await page.getByTestId('write-button').click();
  await place(page).click();
  await list(page).getByTestId('place-team').click();
  await expect(list(page)).toHaveCount(0);
  await expect(place(page)).toHaveText('Organization');
  await expect(lock(page)).toHaveCount(0);
  await expect(page.getByTestId('compose-readers')).toHaveText('Everyone in your org can read this.');
  await expect(page.getByTestId('compose-readers')).toHaveClass(/warning/);
  await page.getByTestId('compose-body').fill('All hands notes');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Shared with your organization');
  expect(notes()[4]!.body).toMatchObject({ audience: { kind: 'team' }, association_project_ids: [] });
  expect(notes()).toHaveLength(5);
});
