import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { chooseFromTray, emit, launch, type Launched } from './launch.js';
import { captureOpenExternal } from './native.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const APOLLO = 'prj_11111111-1111-4111-8111-111111111111';
const BEACON = 'prj_44444444-4444-4444-8444-444444444444';

const settingCalls = () => run.calls().filter(call => call.path === '/v1/person/projects/rename' || call.path === '/v1/person/projects/archive' || call.path === '/v1/person/projects/leave');

/** Opens Apollo and its settings menu, then the menu's item if one is named. */
async function openApolloSetting(page: Page, item?: string): Promise<void> {
  await page.getByTestId('sidebar-project').first().click();
  await page.getByTestId('project-settings').click();
  if (item) await page.getByTestId(`project-${item}`).click();
}

test('a lead renames then archives and restores a project while its existing feed remains readable', async () => {
  run = await launch();
  const { page } = run;
  await openApolloSetting(page, 'rename');
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
  await page.getByTestId('sidebar-project').first().click();
  await page.getByRole('button', { name: 'Actions for Beacon' }).click();
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await page.getByTestId('project-leave').click();
  await expect(page.getByRole('heading', { name: 'Leave Beacon?' })).toBeVisible();
  await page.getByTestId('project-settings-confirm').click();
  await expect(page.getByTestId('title')).toHaveText('ECHO');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(1);
  expect(settingCalls().at(-1)?.body).toMatchObject({ kind: 'echo-project-leave-v1', project_id: BEACON });
});

for (const origin of ['sidebar', 'header'] as const) {
  test(`Capture dismisses the ${origin} project menu and keeps its keyboard focus`, async () => {
    run = await launch();
    const { page } = run;
    if (origin === 'header') await page.getByTestId('sidebar-project').first().click();
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

test('Rename owns Escape, Capture and the caret while it is up', async () => {
  run = await launch();
  const { page, app } = run;
  await page.getByTestId('sidebar-project').first().click();
  await page.getByTestId('project-settings').click();
  await page.getByTestId('project-rename').click();
  await expect(page.getByTestId('project-rename-input')).toBeFocused();
  // Capture and the window coming forward open nothing under the dialog, and do not take its caret.
  await emit(app, 'echo-test:capture');
  await expect(page.getByTestId('compose')).toHaveCount(0);
  await emit(app, 'echo-test:shown');
  await expect(page.getByTestId('project-rename-input')).toBeFocused();
  // Escape cancels the rename and only that: the project page stays.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('project-rename-input')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  expect(settingCalls()).toHaveLength(0);
});

test('Capture keeps the open Tools sheet in front', async () => {
  run = await launch();
  const { page } = run;
  await openApolloSetting(page, 'tools-item');
  await expect(page.getByTestId('project-jira-current')).toBeVisible();
  await emit(run.app, 'echo-test:capture');
  await expect(page.getByTestId('compose')).toHaveCount(0);
  await expect(page.getByTestId('project-tools-sheet')).toBeVisible();
});

for (const role of ['member', 'lead'] as const) {
  test(`a bottom-edge ${role} menu leaves its opener available to close it`, async () => {
    run = await launch(role === 'lead' ? 'many-projects-lead' : 'many-projects');
    const { page } = run;
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(800, 560));
    await page.getByTestId('sidebar-more').click();
    await expect(page.getByTestId('sidebar-project')).toHaveCount(13);
    const opener = page.getByTestId('sidebar-project-more').last();
    await opener.scrollIntoViewIfNeeded();
    // Settle the deliberate scroll before opening: scrolling an open menu dismisses it.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const box = (await opener.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.click(x, y);
    await expect(page.getByTestId('project-settings-menu')).toBeVisible();
    const menu = (await page.getByTestId('project-settings-menu').boundingBox())!;
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(menu.x).toBeGreaterThanOrEqual(8);
    expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(menu.y).toBeGreaterThanOrEqual(8);
    expect(menu.y + menu.height).toBeLessThanOrEqual(viewport.height - 8);
    if (role === 'lead') expect(menu.y + menu.height).toBeLessThanOrEqual(box.y - 4);
    // A second click at the same physical point must hit the opener, never an action.
    await page.mouse.click(x, y);
    await expect(page.getByTestId('project-settings-menu')).toHaveCount(0);
    await expect(page.getByTestId('project-rename-input')).toHaveCount(0);
    await expect(page.getByTestId('project-settings-confirm')).toHaveCount(0);
    expect(settingCalls()).toHaveLength(0);
  });
}

test('a last lead is told to promote another lead before leaving', async () => {
  run = await launch();
  const { page } = run;
  await openApolloSetting(page, 'leave');
  await page.getByTestId('project-settings-confirm').click();
  await expect(page.getByTestId('project-settings-error')).toHaveText('Promote another lead before leaving this project.');
  await expect(page.getByTestId('title')).toHaveText('Apollo');
});

test('an unconfirmed rename is retried with its same request instead of being called successful', async () => {
  run = await launch('change-reply-lost');
  const { page } = run;
  await openApolloSetting(page, 'rename');
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
  await openApolloSetting(page, 'rename');
  await expect(page.getByTestId('project-rename-save')).toBeDisabled();
  await page.getByTestId('project-rename-input').fill('   ');
  await expect(page.getByTestId('project-rename-save')).toBeDisabled();
  expect(settingCalls()).toHaveLength(0);
});

test('switching away conceals a project settings draft and returning preserves it', async () => {
  run = await launch();
  const { page, app } = run;
  await openApolloSetting(page, 'rename');
  await page.getByTestId('project-rename-input').fill('Private draft name');
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(page.getByTestId('project-rename-input')).toHaveCount(0);
  await emit(app, 'echo-test:resume');
  await expect(page.getByTestId('project-rename-input')).toHaveValue('Private draft name');
  expect(settingCalls()).toHaveLength(0);
});


test('a lead maps a Jira project on Tools, Save closes it, asks in that scope, and stops reading it', async () => {
  run = await launch('ask-ticket');
  const { page } = run;
  await openApolloSetting(page, 'tools-item');
  await expect(page.getByTestId('project-jira-current')).toHaveText('Not set');
  await expect(page.getByTestId('project-jira-linked')).toHaveText('Connected');
  await expect(page.getByTestId('project-tools-save')).toBeDisabled();
  await page.getByTestId('project-jira-input').fill('echo');
  await page.getByTestId('project-tools-save').click();
  // Save closes the sheet by itself and says what the project reads now.
  await expect(page.getByTestId('project-tools-sheet')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toHaveText('Apollo now reads Jira ECHO');
  await expect(page.getByTestId('project-tools-line')).toContainText('Reads · Jira ECHO');
  const save = run.calls().find(call => call.path === '/v1/person/tools/jira/project/set');
  expect(save?.body).toMatchObject({ schema_version: 1, project_id: APOLLO, expected_revision: null, jira_project: 'ECHO' });
  await page.getByTestId('ask-field').fill('What is the status of Apollo?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('statement-text')).toHaveText('ECHO-7 is titled Jira launch.');
  expect(run.calls().filter(call => call.path === '/v7/person/ask').at(-1)?.body).toMatchObject({ project_id: APOLLO });
  await page.getByTestId('sources-toggle').click();
  await expect(page.getByTestId('source-row')).toHaveText(/^1\s*ECHO-7 · Jira launch$/);
  await page.getByTestId('back').click();
  await page.getByTestId('project-tools').click();
  await expect(page.getByTestId('project-jira-current')).toHaveText('Reads ECHO');
  await page.getByTestId('project-jira-remove').click();
  await expect(page.getByTestId('project-jira-current')).toHaveText('Reads ECHO · stops on Save');
  await page.getByTestId('project-tools-save').click();
  await expect(page.getByTestId('project-tools-sheet')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toHaveText('Apollo no longer reads Jira');
  const removed = run.calls().filter(call => call.path === '/v1/person/tools/jira/project/set').at(-1)!;
  expect(removed.body?.jira_project).toBeNull(); expect(removed.body?.expected_revision).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByTestId('ask-field').fill('What is the status of Apollo?');
  await page.getByTestId('ask-field').press('Enter');
  // The new answer finds nothing in Apollo, and cites nothing. Asked word for word in the same place, it stands for the one
  // before, which folds away: the question shows once (ADR-0049).
  const latest = page.getByTestId('turn').last();
  await expect(latest.getByTestId('project-empty')).toContainText('Nothing in Apollo matched.');
  await expect(latest.getByTestId('sources-toggle')).toHaveCount(0);
  await expect(page.getByTestId('turn')).toHaveCount(1);
  await expect(page.getByTestId('timeline-row')).toHaveCount(0);
});

test('a lead maps accessible Confluence spaces, loads another page, asks with a page citation, and stops reading them', async () => {
  run = await launch('ask-confluence');
  const { page, app } = run;
  const permalink = 'https://example.atlassian.net/wiki/pages/viewpage.action?pageId=12345';
  const opened = await captureOpenExternal(app);
  await openApolloSetting(page, 'tools-item');
  await expect(page.getByTestId('project-confluence-current')).toHaveText('Not set');
  await expect(page.getByTestId('project-confluence-spaces')).toContainText('ECHO product (ECHO)');
  await expect(page.getByTestId('project-confluence-spaces')).not.toContainText('100');
  await page.getByTestId('project-confluence-more').click();
  await expect(page.getByTestId('project-confluence-spaces')).toContainText('Engineering (ENG)');
  await page.getByLabel(/ECHO product/).check();
  await page.getByLabel(/Engineering/).check();
  await page.getByTestId('project-tools-save').click();
  await expect(page.getByTestId('project-tools-sheet')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toHaveText('Apollo now reads 2 Confluence spaces');
  const save = run.calls().find(call => call.path === '/v1/person/tools/confluence/project/set');
  expect(save?.body).toMatchObject({ schema_version: 1, project_id: APOLLO, expected_revision: null, space_ids: ['100', '300'] });
  expect(run.calls().filter(call => call.path === '/v1/person/tools/confluence/spaces/list').map(call => call.body)).toEqual([{ schema_version: 1 }, { schema_version: 1, cursor: 'next-spaces' }]);
  await page.getByTestId('ask-field').fill('Are we ready for EVT?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('statement-text')).toHaveText('The Confluence EVT readiness page is current.');
  expect(run.calls().filter(call => call.path === '/v7/person/ask').at(-1)?.body).toMatchObject({ project_id: APOLLO });
  await page.getByTestId('citation').click();
  const pane = page.getByTestId('source-pane');
  await expect(pane).toContainText('Confluence · Page');
  await expect(pane.getByTestId('open-page-source')).toHaveAttribute('title', permalink);
  await pane.getByTestId('open-page-source').click();
  await expect.poll(opened).toEqual([permalink]);
  await page.getByTestId('back').click();
  await page.getByTestId('project-tools-change').click();
  await expect(page.getByTestId('project-confluence-current')).toHaveText('Reads 2 spaces');
  await page.getByTestId('project-confluence-remove').click();
  await page.getByTestId('project-tools-save').click();
  await expect(page.getByTestId('toast')).toHaveText('Apollo no longer reads Confluence');
  const removed = run.calls().filter(call => call.path === '/v1/person/tools/confluence/project/set').at(-1)!;
  expect(removed.body?.space_ids).toBeNull();
});

test('a lead sets up a new project’s tools from its feed: Connect waits in the row, then the spaces, and Save closes the sheet', async () => {
  run = await launch();
  const { page } = run;
  await page.getByTestId('sidebar-project').first().click();
  await expect(page.getByTestId('project-tools-line')).toContainText('Apollo reads nothing from your tools yet');
  await page.getByTestId('project-tools-setup').click();
  await expect(page.getByTestId('project-confluence-current')).toHaveText('Not set');
  await expect(page.getByTestId('project-confluence')).toContainText('Connect Confluence to choose what Apollo reads.');
  await page.getByTestId('project-confluence-connect').click();
  await expect(page.getByTestId('project-confluence-waiting')).toContainText('Finish connecting Confluence in your browser');
  // The row turns into the space list once the browser approves: no second sheet, no trip to Tools.
  await expect(page.getByTestId('project-confluence-linked')).toHaveText('Connected just now', { timeout: 15_000 });
  await expect(page.getByTestId('tool-connect-sheet')).toHaveCount(0);
  await page.getByLabel(/ECHO product/).check();
  await page.getByTestId('project-tools-save').click();
  await expect(page.getByTestId('project-tools-sheet')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toHaveText('Apollo now reads 1 Confluence space');
  await expect(page.getByTestId('project-tools-line')).toContainText('Reads · 1 Confluence space');
  expect(run.calls().filter(call => call.path.startsWith('/v1/person/tools/confluence/') && !call.path.includes('/project/'))
    .map(call => call.path.split('/').pop())).toEqual(['connect', 'status', 'status', 'list']);
  expect(run.calls().filter(call => call.path === '/v1/person/tools/confluence/project/set').at(-1)?.body).toMatchObject({ project_id: APOLLO, space_ids: ['100'] });
});

test('closing Tools while a connection waits on the browser cancels it', async () => {
  run = await launch('tools-waiting');
  const { page } = run;
  await openApolloSetting(page, 'tools-item');
  await page.getByTestId('project-jira-connect').click();
  await expect(page.getByTestId('project-jira-waiting')).toContainText(/expires in (29|30) min/);
  await expect(page.getByTestId('project-tools-save')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('project-tools-sheet')).toHaveCount(0);
  await expect.poll(() => run.calls().filter(call => call.path === '/v1/person/tools/jira/cancel')).toHaveLength(1);
});

test('a project member reads what the project reads on Tools but cannot change it', async () => {
  run = await launch();
  const { page } = run;
  await page.getByRole('button', { name: 'Actions for Beacon' }).click();
  await page.getByTestId('project-tools-item').click();
  await expect(page.getByTestId('project-jira-current')).toHaveText('Not set');
  await expect(page.getByRole('dialog')).toContainText('A project lead can change what Beacon reads.');
  await expect(page.getByTestId('project-tools-save')).toHaveCount(0);
  await expect(page.getByTestId('project-jira-input')).toHaveCount(0);
  await page.getByTestId('project-tools-close').click();
  await expect(page.getByTestId('project-tools-sheet')).toHaveCount(0);
  expect(run.calls().filter(call => call.path === '/v1/person/tools/jira/project/set')).toHaveLength(0);
});

test('a member reads the saved Confluence mapping without loading a personal space picker', async () => {
  run = await launch('confluence-member-read');
  const { page } = run;
  await page.getByRole('button', { name: 'Actions for Beacon' }).click();
  await page.getByTestId('project-tools-item').click();
  await expect(page.getByTestId('project-confluence-current')).toHaveText('Reads 1 space');
  await expect(page.getByRole('dialog')).toContainText('A project lead can change what Beacon reads.');
  await expect(page.getByTestId('project-confluence-spaces')).toHaveCount(0);
  expect(run.calls().filter(call => call.path === '/v1/person/tools/confluence/project/read')).toHaveLength(1);
  expect(run.calls().filter(call => call.path === '/v1/person/tools/confluence/spaces/list')).toHaveLength(0);
});

test('a lead keeps a saved Confluence mapping and can stop reading it when the personal picker is unavailable', async () => {
  run = await launch('confluence-spaces-unavailable');
  const { page } = run;
  await openApolloSetting(page, 'tools-item');
  await expect(page.getByTestId('project-confluence-current')).toHaveText('Reads 1 space');
  await expect(page.getByTestId('project-confluence-picker-error')).toContainText('ECHO is unavailable right now. Try again.');
  await expect(page.getByTestId('project-tools-save')).toBeDisabled();
  await page.getByTestId('project-confluence-remove').click();
  await page.getByTestId('project-tools-save').click();
  await expect(page.getByTestId('toast')).toHaveText('Apollo no longer reads Confluence');
  expect(run.calls().filter(call => call.path === '/v1/person/tools/confluence/project/set').at(-1)?.body).toMatchObject({ project_id: APOLLO, space_ids: null });
});

// A change the Authority refused as stale, and one whose reply was lost: each tool's setting goes through the same adapter.
for (const [mode, tool, said, reloaded] of [
  ['confluence-project-conflict', 'confluence', 'This setting changed.', 'Not set'],
  ['jira-project-reply-lost', 'jira', 'The change could not be confirmed.', 'Reads ECHO'],
] as const) {
  test(`${mode}: keeps Tools up and reloads the saved setting after an unconfirmed change without resubmitting`, async () => {
    run = await launch(mode);
    const { page } = run;
    await openApolloSetting(page, 'tools-item');
    if (tool === 'jira') await page.getByTestId('project-jira-input').fill('ECHO');
    else await page.getByLabel(/ECHO product/).check();
    await page.getByTestId('project-tools-save').click();
    await expect(page.getByTestId(`project-${tool}-error`)).toContainText(said);
    await expect(page.getByTestId('project-tools-sheet')).toBeVisible();
    await expect(page.getByTestId('project-tools-save')).toBeDisabled();
    await page.getByRole('button', { name: 'Reload setting' }).click();
    await expect(page.getByTestId(`project-${tool}-current`)).toHaveText(reloaded);
    expect(run.calls().filter(call => call.path === `/v1/person/tools/${tool}/project/set`)).toHaveLength(1);
  });
}


test('a Jira save keeps Tools up until its reply, ignores Escape meanwhile, then closes by itself', async () => {
  run = await launch('jira-project-slow');
  const { page } = run;
  await openApolloSetting(page, 'tools-item');
  await page.getByTestId('project-jira-input').fill('ECHO');
  await page.getByTestId('project-tools-save').click();
  await expect.poll(() => run.calls().filter(call => call.path === '/v1/person/tools/jira/project/set').length).toBe(1);
  // Disabling the focused Save button may return focus to the document.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByTestId('project-tools-save')).toBeDisabled();
  await expect(page.getByTestId('project-tools-cancel')).toBeDisabled();
  await expect(page.getByTestId('project-settings')).toBeDisabled();
  writeFileSync(join(run.home, 'release-jira-setting'), 'ready');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toHaveText('Apollo now reads Jira ECHO');
  await expect(page.getByTestId('title')).toHaveText('Apollo');
});
