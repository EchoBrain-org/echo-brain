import { expect, test } from '@playwright/test';
import { emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

test('home lists your projects and a project reads its items', async () => {
  run = await launch();
  const { page } = run;
  const rows = page.getByTestId('project-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Apollo');
  await expect(rows.nth(0)).toContainText('Lead');
  await expect(rows.nth(1)).not.toContainText('Lead');
  await expect(page.getByTestId('title')).toHaveText('ECHO');

  await rows.nth(0).click();
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await expect(page.getByTestId('feed-row')).toHaveCount(1);
  await expect(page.getByTestId('feed-row')).toContainText('Apollo update');
  await page.getByTestId('feed-row').click();
  await expect(page.getByTestId('reader-text')).toHaveText('We agreed to ship.');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('feed-row')).toBeVisible();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('title')).toHaveText('ECHO');
  await expect(page.getByTestId('project-row')).toHaveCount(2);
});

test('ask inside a project is scoped to it until the chip is cleared', async () => {
  run = await launch();
  const { page } = run;
  await page.getByTestId('project-row').first().click();
  await expect(page.getByTestId('scope-chip')).toHaveText('Apollo');

  await page.getByTestId('ask-field').fill('What did we decide?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('answer')).toHaveText('We agreed to ship Apollo with annual plans first.');
  await expect(page.getByTestId('ask-field')).toHaveValue('');
  const scoped = run.calls().filter(call => call.path === '/v2/person/ask');
  expect(scoped).toHaveLength(1);
  expect(scoped[0]!.body?.project_id).toBe('prj_11111111-1111-4111-8111-111111111111');

  await page.getByTestId('source-row').first().click();
  await expect(page.getByTestId('evidence-text')).toHaveText('We agreed to ship.');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('answer')).toBeVisible();

  await page.keyboard.press('Escape');
  await page.getByTestId('scope-clear').click();
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await page.getByTestId('ask-field').fill('Anything else?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('answer')).toBeVisible();
  const asks = run.calls().filter(call => call.path === '/v2/person/ask');
  expect(asks).toHaveLength(2);
  expect(asks[1]!.body && 'project_id' in asks[1]!.body).toBe(false);
});

test('capture starts private outside a project and says where it went', async () => {
  run = await launch();
  const { page, app } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await emit(app, 'echo-test:capture');
  await expect(page.getByTestId('compose')).toBeVisible();
  await expect(page.getByTestId('compose-to')).toHaveText('Only me');
  await expect(page.getByTestId('compose-body')).toBeFocused();
  await page.getByTestId('compose-body').fill('Northwind wants annual\nwith a pilot clause.');
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByTestId('sent')).toContainText('Saved for you');
  const saved = run.calls().filter(call => call.method === 'POST' && call.path === '/v3/person/updates');
  expect(saved).toHaveLength(1);
  expect(saved[0]!.body?.audience).toEqual({ kind: 'only_me' });
  expect(saved[0]!.body?.title).toBe('Northwind wants annual');
  await page.getByTestId('compose-done').click();
  await expect(page.getByTestId('compose')).toHaveCount(0);
});

test('writing inside a project sends to that project', async () => {
  run = await launch();
  const { page } = run;
  await page.getByTestId('project-row').first().click();
  await page.getByTestId('write-button').click();
  await expect(page.getByTestId('compose-to')).toHaveText('Apollo');
  await page.getByTestId('compose-body').fill('Weekly update');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('sent')).toContainText('Sent to Apollo');
  const saved = run.calls().filter(call => call.method === 'POST' && call.path === '/v3/person/updates');
  expect(saved[0]!.body?.audience).toEqual({ kind: 'project', project_id: 'prj_11111111-1111-4111-8111-111111111111' });
  expect(saved[0]!.body?.association_project_ids).toEqual(['prj_11111111-1111-4111-8111-111111111111']);
});

test('the To picker offers only me, each project and everyone', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-to').click();
  await expect(page.getByTestId('compose-target')).toHaveText(['Only me', 'Apollo', 'Beacon', 'Everyone']);
  await page.getByTestId('compose-target').nth(3).click();
  await page.getByTestId('compose-body').fill('All hands notes');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('sent')).toContainText('Sent to everyone');
  const saved = run.calls().filter(call => call.method === 'POST' && call.path === '/v3/person/updates');
  expect(saved[0]!.body?.audience).toEqual({ kind: 'team' });
});

test('an unconfirmed save says so, locks the text and never claims it was sent', async () => {
  run = await launch('write-unavailable');
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Draft');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('compose-error')).toHaveText('This may not have been sent.');
  await expect(page.getByTestId('sent')).toHaveCount(0);
  await expect(page.getByTestId('compose-body')).toHaveValue('Draft');
  await expect(page.getByTestId('compose-body')).toHaveAttribute('readonly', '');
  await expect(page.getByTestId('compose-to')).toBeDisabled();
});

test('retry resends the identical request and then says where it went', async () => {
  run = await launch('write-unavailable-once');
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Pricing call notes');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('compose-unresolved')).toBeVisible();
  await page.getByTestId('compose-retry').click();
  await expect(page.getByTestId('sent')).toContainText('Saved for you');
  const posts = run.calls().filter(call => call.method === 'POST' && call.path === '/v3/person/updates');
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body).toEqual(posts[0]!.body);
});

test('check status on an unconfirmed save learns it was not saved, then sends it', async () => {
  run = await launch('write-unavailable-once');
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Security questionnaire sent');
  await page.getByTestId('compose-send').click();
  await page.getByTestId('compose-check').click();
  await expect(page.getByTestId('compose-error')).toHaveText('It was not saved. Send it again.');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('sent')).toContainText('Saved for you');
  const posts = run.calls().filter(call => call.method === 'POST' && call.path === '/v3/person/updates');
  expect(posts[1]!.body?.request_id).toBe(posts[0]!.body?.request_id);
});

test('an unresolved save comes back on capture, and write new asks once', async () => {
  run = await launch('write-unavailable');
  const { page, app } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Unsure');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('compose-unresolved')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('compose')).toHaveCount(0);
  await emit(app, 'echo-test:capture');
  await expect(page.getByTestId('compose-unresolved')).toBeVisible();
  await expect(page.getByTestId('compose-body')).toHaveValue('Unsure');
  await page.getByTestId('compose-new').click();
  await expect(page.getByTestId('compose-start-over')).toBeVisible();
  await page.getByTestId('compose-start-over').click();
  await expect(page.getByTestId('compose-body')).toHaveValue('');
  await expect(page.getByTestId('compose-unresolved')).toHaveCount(0);
});

test('quitting with an unresolved save asks first', async () => {
  run = await launch('write-unavailable');
  const { page, app } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Unsure');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('compose-unresolved')).toBeVisible();
  const asked = await app.evaluate(({ app: electronApp, dialog }) => {
    let prompts = 0;
    dialog.showMessageBoxSync = () => { prompts += 1; return 1; }; // Cancel
    electronApp.quit();
    return prompts;
  });
  expect(asked).toBe(1);
  await expect(page.getByTestId('compose-unresolved')).toBeVisible();
});

test('escape keeps the draft and capture brings it back', async () => {
  run = await launch();
  const { page, app } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Half a thought');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('compose')).toHaveCount(0);
  await emit(app, 'echo-test:capture');
  await expect(page.getByTestId('compose-body')).toHaveValue('Half a thought');
  await expect(page.getByTestId('compose-body')).toBeFocused();
});

test('more projects loads the next page', async () => {
  run = await launch('many-projects');
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(10);
  await page.getByTestId('more-projects').click();
  await expect(page.getByTestId('project-row')).toHaveCount(13);
  await expect(page.getByTestId('more-projects')).toHaveCount(0);
});

test('a session left behind by the weekly expiry shows sign-in at once', async () => {
  run = await launch('expired-claim');
  await expect(run.page.getByTestId('signin')).toBeVisible({ timeout: 2500 });
});

test('a failed ask shows a fixed message, not server text', async () => {
  run = await launch('ask-unavailable');
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('ask-field').fill('Anything?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('ask-error')).toHaveText('ECHO is unavailable right now. Try again.');
});

test('switching to another app covers a project, but Home rows stay for drops', async () => {
  run = await launch();
  const { page, app } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await expect(page.getByTestId('concealed')).toHaveCount(0);
  await emit(app, 'echo-test:resume');
  await page.getByTestId('project-row').first().click();
  await expect(page.getByTestId('feed-row')).toBeVisible();
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(page.getByTestId('feed-row')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('ECHO');
  await emit(app, 'echo-test:resume');
  await expect(page.getByTestId('concealed')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('Apollo');
});

test('signed out shows sign-in and nothing else', async () => {
  run = await launch('signed-out');
  const { page } = run;
  await expect(page.getByTestId('signin')).toBeVisible();
  await expect(page.getByTestId('signin-button')).toBeDisabled();
  await page.getByTestId('signin-url').fill('https://echo.example.com');
  await expect(page.getByTestId('signin-button')).toBeEnabled();
  await expect(page.getByTestId('project-row')).toHaveCount(0);
  await expect(page.getByTestId('ask-field')).toHaveCount(0);
});
