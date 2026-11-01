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
  await emit(run.app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(page.getByTestId('project-rename-input')).toHaveCount(0);
  await emit(run.app, 'echo-test:resume');
  await expect(page.getByTestId('project-rename-input')).toHaveValue('Apollo 2');
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
  await page.getByTestId('capture-place').click();
  await expect(page.getByTestId('projects-row')).toHaveText(['Beacon']);
  await page.getByTestId('compose-close').click();
  await page.getByTestId('archived-project-row').click();

  await page.getByTestId('project-settings').click();
  await page.getByTestId('project-archive').click();
  await page.getByTestId('project-settings-confirm').click();
  await expect(page.getByTestId('toast')).toHaveText('Restored Apollo 2');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  expect(settingCalls().at(-1)?.body).toMatchObject({ kind: 'echo-project-archive-v1', project_id: APOLLO, archived: false });
  await page.getByRole('button', { name: 'Actions for Beacon' }).click();
  await expect(page.getByTestId('title')).toHaveText('Apollo 2');
  await expect(page.getByTestId('project-rename')).toHaveCount(0);
  await expect(page.getByTestId('project-archive')).toHaveCount(0);
  await page.getByTestId('project-leave').click();
  await expect(page.getByRole('heading', { name: 'Leave Beacon?' })).toBeVisible();
  await page.getByTestId('project-settings-confirm').click();
  await expect(page.getByTestId('title').getByTestId('alt-stops')).toBeVisible();
  await expect(page.getByTestId('sidebar-project')).toHaveCount(1);
  expect(settingCalls().at(-1)?.body).toMatchObject({ kind: 'echo-project-leave-v1', project_id: BEACON });
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
