import { expect, test } from '@playwright/test';
import { chooseFromTray, emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const APOLLO = 'prj_11111111-1111-4111-8111-111111111111';
const BEACON = 'prj_44444444-4444-4444-8444-444444444444';

const settingCalls = () => run.calls().filter(call => call.path === '/v1/person/projects/rename' || call.path === '/v1/person/projects/archive' || call.path === '/v1/person/projects/leave');

test('a lead renames then archives and restores a project while its existing feed remains readable', async () => {
  run = await launch();
  const { page } = run;
  await page.getByTestId('project-row').first().click();

  await page.getByTestId('project-settings').click();
  await page.getByTestId('project-rename').click();
  await page.getByTestId('project-rename-input').fill('Apollo 2');
  await page.getByTestId('project-rename-save').click();
  await expect(page.getByTestId('title')).toHaveText('Apollo 2');
  expect(settingCalls().at(-1)?.body).toMatchObject({ kind: 'echo-project-rename-v1', project_id: APOLLO, name: 'Apollo 2' });

  await page.getByTestId('project-settings').click();
  await page.getByTestId('project-archive').click();
  await page.getByTestId('project-settings-confirm').click();
  await expect(page.getByTestId('toast')).toHaveText('Archived Apollo 2');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(1);
  await expect(page.getByTestId('feed-row')).toHaveCount(1);
  expect(settingCalls().at(-1)?.body).toMatchObject({ kind: 'echo-project-archive-v1', project_id: APOLLO, archived: true });

  // Archived projects are still readable, but are absent from Capture's target list.
  await page.getByTestId('back').click();
  await expect(page.getByTestId('archived-projects-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('archived-project-row')).toHaveCount(0);
  await page.getByTestId('archived-projects-toggle').click();
  await expect(page.getByTestId('archived-projects-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('archived-project-row')).toHaveCount(1);
  await page.getByTestId('sidebar-capture').click();
  await page.getByTestId('readers-projects').click();
  await expect(page.getByTestId('projects-row')).toHaveText(['Beacon']);
  await page.getByTestId('compose-close').click();
  await page.getByTestId('archived-project-row').click();

  await page.getByTestId('project-settings').click();
  await page.getByTestId('project-archive').click();
  await page.getByTestId('project-settings-confirm').click();
  await expect(page.getByTestId('toast')).toHaveText('Restored Apollo 2');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  expect(settingCalls().at(-1)?.body).toMatchObject({ kind: 'echo-project-archive-v1', project_id: APOLLO, archived: false });
});

test('a sidebar action targets its row without navigating and preserves member permissions', async () => {
  run = await launch();
  const { page } = run;
  await page.getByRole('button', { name: 'Actions for Beacon' }).click();
  await expect(page.getByTestId('title')).toHaveText('ECHO');
  await expect(page.getByTestId('project-settings-menu')).toHaveCount(1);
  await expect(page.getByTestId('project-rename')).toHaveCount(0);
  await expect(page.getByTestId('project-archive')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Actions for Beacon' })).toBeFocused();
  await page.getByTestId('project-row').first().click();
  await page.getByRole('button', { name: 'Actions for Beacon' }).click();
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await page.getByTestId('project-leave').click();
  await expect(page.getByRole('heading', { name: 'Leave Beacon?' })).toBeVisible();
  await page.getByTestId('project-settings-confirm').click();
  await expect(page.getByTestId('title')).toHaveText('ECHO');
  await expect(page.getByTestId('project-row')).toHaveCount(1);
  await expect(page.getByTestId('sidebar-project')).toHaveCount(1);
  expect(settingCalls().at(-1)?.body).toMatchObject({ kind: 'echo-project-leave-v1', project_id: BEACON });
});

for (const origin of ['sidebar', 'header'] as const) {
  test(`Capture dismisses the ${origin} project menu and keeps its keyboard focus`, async () => {
    run = await launch();
    const { page } = run;
    if (origin === 'header') await page.getByTestId('project-row').first().click();
    const opener = origin === 'header' ? page.getByTestId('project-settings')
      : page.getByRole('button', { name: 'Actions for Apollo' });
    await opener.click();
    await expect(page.getByTestId('project-settings-menu')).toBeVisible();
    // The real global shortcut opens Capture without a pointer event to dismiss the menu.
    await emit(run.app, 'echo-test:capture');
    await expect(page.getByTestId('compose-body')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('compose-body')).toBeFocused();
    await expect(page.getByTestId('project-settings-menu')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('compose')).toHaveCount(0);
    await expect(page.getByTestId('project-settings-menu')).toHaveCount(0);
    await opener.click();
    await expect(page.getByTestId('project-settings-menu')).toHaveCount(1);
    expect(settingCalls()).toHaveLength(0);
  });
}

test('a native account sheet dismisses the project menu without restoring it afterward', async () => {
  run = await launch();
  const { page } = run;
  await page.getByRole('button', { name: 'Actions for Apollo' }).click();
  await chooseFromTray(run, 'Sign out…');
  await expect(page.getByTestId('confirm-cancel')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('confirm-cancel')).toBeFocused();
  await expect(page.getByTestId('project-settings-menu')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('confirm')).toHaveCount(0);
  await expect(page.getByTestId('project-settings-menu')).toHaveCount(0);
  expect(settingCalls()).toHaveLength(0);
});

test('a last lead is told to promote another lead before leaving', async () => {
  run = await launch();
  const { page } = run;
  await page.getByTestId('project-row').first().click();
  await page.getByTestId('project-settings').click();
  await page.getByTestId('project-leave').click();
  await page.getByTestId('project-settings-confirm').click();
  await expect(page.getByTestId('project-settings-error')).toHaveText('Promote another lead before leaving this project.');
  await expect(page.getByTestId('title')).toHaveText('Apollo');
});

test('an unconfirmed rename is retried with its same request instead of being called successful', async () => {
  run = await launch('change-reply-lost');
  const { page } = run;
  await page.getByTestId('project-row').first().click();
  await page.getByTestId('project-settings').click();
  await page.getByTestId('project-rename').click();
  await page.getByTestId('project-rename-input').fill('Apollo retry');
  await page.getByTestId('project-rename-save').click();
  await expect(page.getByTestId('project-settings-error')).toHaveText('This may not have been sent.');
  const request = settingCalls().at(-1)?.body?.request_id;
  // A blocking sheet closes only transient menus; the unresolved write must survive it.
  await chooseFromTray(run, 'Sign out…');
  await expect(page.getByTestId('confirm-signout')).toBeDisabled();
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('project-settings-error')).toHaveText('This may not have been sent.');
  await page.getByTestId('project-settings-retry').click();
  await expect(page.getByTestId('title')).toHaveText('Apollo retry');
  expect(settingCalls().at(-1)?.body?.request_id).toBe(request);
});

test('rename does not submit an empty or unchanged name', async () => {
  run = await launch();
  const { page } = run;
  await page.getByTestId('project-row').first().click();
  await page.getByTestId('project-settings').click();
  await page.getByTestId('project-rename').click();
  await expect(page.getByTestId('project-rename-save')).toBeDisabled();
  await page.getByTestId('project-rename-input').fill('   ');
  await expect(page.getByTestId('project-rename-save')).toBeDisabled();
  expect(settingCalls()).toHaveLength(0);
});

test('switching away conceals a project settings draft and returning preserves it', async () => {
  run = await launch();
  const { page, app } = run;
  await page.getByTestId('project-row').first().click();
  await page.getByTestId('project-settings').click();
  await page.getByTestId('project-rename').click();
  await page.getByTestId('project-rename-input').fill('Private draft name');
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(page.getByTestId('project-rename-input')).toHaveCount(0);
  await emit(app, 'echo-test:resume');
  await expect(page.getByTestId('project-rename-input')).toHaveValue('Private draft name');
  expect(settingCalls()).toHaveLength(0);
});
