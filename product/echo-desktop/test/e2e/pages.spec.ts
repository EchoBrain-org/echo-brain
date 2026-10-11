import { expect, test } from '@playwright/test';
import { emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const lists = () => run.calls().filter(call => call.method === 'GET' && call.path === '/v2/person/projects' &&
  new URLSearchParams(call.query).get('status') === 'active').length;

test('Back keeps the pages Home had loaded, and showing the window re-reads it', async () => {
  run = await launch('many-projects');
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(10);
  await page.getByTestId('sidebar-more').click();
  await expect(page.getByTestId('sidebar-project')).toHaveCount(13);
  await expect(page.getByTestId('sidebar-more')).toHaveCount(0);
  await page.getByTestId('sidebar-project').nth(12).click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('sidebar-project')).toHaveCount(13);
  expect(lists()).toBe(2);
  await emit(app, 'echo-test:shown');
  await expect.poll(lists).toBe(3);
  await expect(page.getByTestId('sidebar-project')).toHaveCount(13);
});

test('opening ECHO again while it runs brings the window forward, as Open ECHO does', async () => {
  run = await launch();
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  const before = lists();
  // What macOS sends when ECHO is opened from Spotlight or Finder while it runs.
  await app.evaluate(({ app: electronApp }) => { electronApp.emit('activate', {}, false); });
  await expect.poll(lists).toBe(before + 1);
  await expect(page.getByTestId('ask-field')).toBeFocused();
});

for (const event of ['shown', 'resume'] as const) {
  test(`a project created elsewhere reaches the sidebar on ${event} without resetting an approval draft`, async () => {
    run = await launch('granola-project-added');
    const { page, app } = run;
    await expect(page.getByTestId('need-row')).toContainText('Pilot planning');
    await expect(page.getByTestId('sidebar-project')).toHaveCount(0);
    await page.getByTestId('need-row').click();
    const card = page.getByTestId('decision');
    // The review reads its suggestions fresh even though the sidebar's first list was empty.
    await expect(card.getByRole('checkbox', { name: 'Thermostat redesign' })).toBeChecked();
    await card.getByLabel('Owner for: Send the revised quote').fill('Rafael M.');
    await card.getByRole('radio', { name: 'Only me' }).check();
    await card.getByLabel('Share the transcript with the selected audience').check();
    const before = lists();
    if (event === 'resume') {
      await emit(app, 'echo-test:conceal');
      await expect(page.getByTestId('concealed')).toBeVisible();
      await emit(app, 'echo-test:resume');
    } else await emit(app, 'echo-test:shown');
    await expect(page.getByTestId('sidebar-project')).toHaveCount(1);
    await expect(page.getByTestId('sidebar-project')).toContainText('Thermostat redesign');
    expect(lists()).toBe(before + 1);
    await expect(card.getByLabel('Owner for: Send the revised quote')).toHaveValue('Rafael M.');
    await expect(card.getByRole('radio', { name: 'Only me' })).toHaveAttribute('aria-checked', 'true');
    await expect(card.getByLabel('Share the transcript with the selected audience')).toBeChecked();
    expect(run.calls().filter(call => call.method === 'POST' && call.path === '/v1/person/projects')).toHaveLength(0);
    expect(run.calls().filter(call => call.body?.operation === 'review')).toHaveLength(0);
  });
}

test('the ask bar has the caret at launch and whenever the window comes forward', async () => {
  run = await launch();
  const { page, app } = run;
  await expect(page.getByTestId('ask-field')).toBeFocused();
  await page.getByTestId('sidebar-project').nth(0).focus();
  await emit(app, 'echo-test:shown');
  await expect(page.getByTestId('ask-field')).toBeFocused();
});

test('an ask can be cancelled, and its late answer is dropped', async () => {
  run = await launch('ask-hangs');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('ask-field').fill('Where are we?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('asking')).toBeVisible();
  await page.getByTestId('ask-cancel').click();
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
});

test('a source shows at most 2,000 characters', async () => {
  run = await launch('long-evidence');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('ask-field').fill('What did we agree?');
  await page.getByTestId('ask-field').press('Enter');
  await page.getByTestId('source-row').nth(1).click();
  await expect(page.getByTestId('evidence-text')).toHaveText(`${'x'.repeat(2_000)}…`);
});
