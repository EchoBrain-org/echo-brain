import { expect, test, type Page } from '@playwright/test';
import { chooseFromAccountMenu, emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const toolCalls = () => run.calls().filter(call => call.path.startsWith('/v1/person/tools/jira/') || call.path.startsWith('/v1/person/tools/confluence/') || call.path.includes('/slack/disconnect'))
  .map(call => call.path.replace('/v1/person/tools/jira/', 'jira ').replace('/v1/person/tools/confluence/', 'confluence ').replace('/v2/person/external-identities/slack/', 'slack '));

test('Tools lists every tool by your connection, from the sidebar or the Account menu', async () => {
  run = await launch();
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  await expect(page.getByTestId('title')).toHaveText('Tools');
  await expect(page.getByTestId('sidebar-tools')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('tools')).toContainText('Ari · https://authority.example');
  await expect(page.getByRole('region', { name: 'Connected' }).getByTestId('tool-row')).toHaveText(['SSlackConnectedManage']);
  await expect(page.getByRole('region', { name: 'Available' }).getByTestId('tool-row')).toHaveText(['JJiraNot connectedConnect', 'CConfluenceNot connectedConnect']);
  await expect(page.getByRole('region', { name: 'Not turned on' }).getByTestId('tool-row'))
    .toHaveText(['GGranolaNot turned on for your organization.']);
  // The external workspace and account ids never reach the page.
  expect(await page.content()).not.toMatch(/T0123ABCD|U0123ABCD|atlassian-account/);

  await page.getByTestId('back').click();
  await expect(page.getByTestId('tools')).toHaveCount(0);
  await chooseFromAccountMenu(run, page.getByTestId('account-row'), 'Connected tools…');
  await expect(page.getByTestId('tools')).toBeVisible();
  // Home reads the tools too, on sign-in and on Back: it needs to know whether meetings are turned on.
  await expect.poll(() => run.calls().filter(call => call.path === '/v4/person/tools')).toHaveLength(4);
});

test('Tools is covered while ECHO is concealed and returns on resume', async () => {
  run = await launch();
  const { page, app } = run;
  await page.getByTestId('sidebar-tools').click();
  await expect(page.getByTestId('tools')).toContainText('Ari · https://authority.example');
  await expect(page.getByTestId('tool-row')).toHaveCount(4);

  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(page.getByTestId('tools')).toHaveCount(0);
  await expect(page.getByTestId('tool-row')).toHaveCount(0);

  await emit(app, 'echo-test:resume');
  await expect(page.getByTestId('tools')).toContainText('Ari · https://authority.example');
  await expect(page.getByTestId('tool-row')).toHaveCount(4);
});

test('Connect waits on the browser, reads the attempt until it completes, and lists the tool as connected', async () => {
  run = await launch();
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="jira"]').getByTestId('tool-connect').click();
  await expect(page.getByTestId('tool-connect-sheet')).toContainText('Finish connecting Jira in your browser');
  await expect(page.getByTestId('tool-connect-waiting')).toContainText(/Waiting · expires in (29|30) min/);
  await expect(page.getByTestId('toast')).toHaveText('Jira connected', { timeout: 15_000 });
  await expect(page.getByTestId('tool-connect-sheet')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Connected' }).getByTestId('tool-row')).toHaveText(['SSlackConnectedManage', 'JJiraConnectedManage']);
  await expect(page.getByRole('region', { name: 'Available' }).getByTestId('tool-row')).toHaveText(['CConfluenceNot connectedConnect']);
  expect(toolCalls()).toEqual(['jira connect', 'jira status', 'jira status']);
});

test('Confluence uses the same browser connection lifecycle as Jira', async () => {
  run = await launch();
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="confluence"]').getByTestId('tool-connect').click();
  await expect(page.getByTestId('tool-connect-sheet')).toContainText('Finish connecting Confluence in your browser');
  await expect(page.getByTestId('toast')).toHaveText('Confluence connected', { timeout: 15_000 });
  await expect(page.locator('[data-tool="confluence"]')).toContainText('Confluence');
  expect(toolCalls()).toEqual(['confluence connect', 'confluence status', 'confluence status']);
});

test('a connection the tool refuses says why in the app’s words, and Try again starts over', async () => {
  run = await launch('tools-mismatch');
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="jira"]').getByTestId('tool-connect').click();
  await expect(page.getByTestId('tool-connect-failure'))
    .toHaveText('That Jira account does not match the one you connected before. Sign in with that account and try again.', { timeout: 15_000 });
  await expect(page.getByTestId('tool-connect-sheet')).toContainText('Jira was not connected');
  await page.getByTestId('tool-connect-retry').click();
  await expect(page.getByTestId('tool-connect-waiting')).toBeVisible();
  await page.getByTestId('tool-connect-cancel').click();
  await expect(page.getByTestId('tool-connect-sheet')).toHaveCount(0);
  await expect.poll(() => toolCalls().filter(call => call === 'jira connect')).toHaveLength(2);
});

test('Cancel, or Escape, cancels a waiting connection so a late approval binds nothing', async () => {
  run = await launch('tools-waiting');
  const { page, app } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="jira"]').getByTestId('tool-connect').click();
  await expect(page.getByTestId('tool-connect-waiting')).toBeVisible();
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(page.getByTestId('tool-connect-sheet')).toHaveCount(0);
  await emit(app, 'echo-test:resume');
  await expect(page.getByTestId('tool-connect-waiting')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tool-connect-sheet')).toHaveCount(0);
  await expect.poll(toolCalls).toContain('jira cancel');
  // The page stays, and the tool is still to connect.
  await expect(page.getByRole('region', { name: 'Available' }).getByTestId('tool-row')).toHaveText(['JJiraNot connectedConnect', 'CConfluenceNot connectedConnect']);
});

test('a stopped connection needs attention and reconnects; Manage disconnects only your own', async () => {
  run = await launch('tools-revoked');
  const { page, app } = run;
  await page.getByTestId('sidebar-tools').click();
  const attention = page.getByRole('region', { name: 'Needs attention' }).getByTestId('tool-row');
  await expect(attention).toHaveText(['JJiraConnection stopped. Reconnect to keep using it.Reconnect']);

  await page.locator('[data-tool="slack"]').getByTestId('tool-manage').click();
  await expect(page.getByTestId('tool-manage-sheet')).toContainText('Disconnecting removes only your own Slack connection');
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(page.getByTestId('tool-manage-sheet')).toHaveCount(0);
  await emit(app, 'echo-test:resume');
  await expect(page.getByTestId('tool-manage-sheet')).toContainText('Disconnecting removes only your own Slack connection');
  await page.getByTestId('tool-disconnect').click();
  await expect(page.getByTestId('toast')).toHaveText('Slack disconnected');
  await expect(page.getByTestId('tool-manage-sheet')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Available' }).getByTestId('tool-row')).toHaveText(['SSlackNot connectedConnect', 'CConfluenceNot connectedConnect']);
  await expect(page.getByRole('region', { name: 'Connected' })).toHaveCount(0);
  expect(toolCalls()).toEqual(['slack disconnect']);
});


/** Adds the fixture meeting through Tools → Granola, so its decision reaches Home. */
async function addMeeting(page: Page) {
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="granola"]').getByTestId('tool-manage').click();
  const meetings = page.getByRole('region', { name: 'Personal meetings' });
  await expect(meetings).toContainText('ari@example.test · EchoBrain');
  await meetings.getByLabel('Granola folder').selectOption({ label: 'ECHO (1)' });
  await meetings.getByRole('button', { name: 'Pilot planning', exact: true }).click();
  const add = meetings.getByRole('button', { name: 'Add to ECHO', exact: true });
  await expect(add).toBeDisabled();
  await meetings.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await add.click();
  await expect(meetings.getByRole('status')).toContainText('Added.');
  await page.keyboard.press('Escape');
  await page.getByTestId('sidebar-home').click();
  return meetings;
}

test('a meeting added through Granola reaches Home as a decision to approve, with transcript sharing off', async ({}, testInfo) => {
  run = await launch('granola');
  const { page } = run;
  await expect(page.getByTestId('home-clear')).toContainText('Nothing needs you');
  await addMeeting(page);
  expect(run.calls().find(call => call.body?.operation === 'import')?.body).toMatchObject({ retain: true, project_id: null });
  const row = page.getByTestId('need-row');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-kind', 'approve');
  await expect(row).toContainText('Pilot planning');
  await expect(page.getByTestId('sidebar-badge')).toHaveText('1');
  await page.screenshot({ path: testInfo.outputPath('home-needs-you.png') });
  await row.click();
  const card = page.getByTestId('decision');
  await expect(card).toContainText('Approve this decision?');
  await expect(card).toContainText('Launch the pilot next week.');
  await expect(card.getByLabel('Share the transcript with the selected audience')).not.toBeChecked();
  await card.getByRole('radio', { name: 'Only me' }).check();
  await page.screenshot({ path: testInfo.outputPath('decision-approve.png') });
  await card.getByTestId('decision-approve').click();
  await expect.poll(() => run.calls().filter(call => call.body?.operation === 'review')).toHaveLength(1);
  expect(run.calls().find(call => call.body?.operation === 'review')?.body).toMatchObject({
    action: 'approve', share_transcript: false, project_ids: [], owners: [
      { signal_id: 'act-1', owner: 'Rafael Moreno' },
      { signal_id: 'act-2', owner: 'Mina Patel' },
    ],
  });
  // Back on Home: the row says the check is on its way, then what it found waits to be sent.
  await expect(page.getByTestId('title')).toHaveText('ECHO');
  await expect(page.getByTestId('toast')).toContainText('Approved');
  await expect(page.getByTestId('need-row')).toHaveAttribute('data-kind', /checking|send/);
});

test('approves a meeting into two projects with an edited owner', async () => {
  run = await launch('granola');
  const { page } = run;
  await addMeeting(page);
  await page.getByTestId('need-row').click();
  const card = page.getByTestId('decision');
  await expect(card.getByRole('radio', { name: /Thermostat redesign/ })).toHaveAttribute('aria-checked', 'true');
  await expect(card.getByRole('checkbox', { name: 'Thermostat redesign' })).toBeChecked();
  await card.getByRole('checkbox', { name: 'Supplier review' }).check();
  await card.getByLabel('Owner for: Send the revised quote').fill('Rafael M.');
  await card.getByLabel('Owner for: Confirm the trace').fill('');
  await card.getByTestId('decision-approve').click();
  await expect.poll(() => run.calls().filter(call => call.body?.operation === 'review')).toHaveLength(1);
  const body = run.calls().find(call => call.body?.operation === 'review')?.body;
  expect(body).toMatchObject({ action: 'approve', share_transcript: false, owners: [{ signal_id: 'act-1', owner: 'Rafael M.' }] });
  expect(body?.project_ids).toHaveLength(2);
});

test('shows that the meeting was already approved in Slack', async () => {
  run = await launch('granola-decided-in-slack');
  const { page } = run;
  await page.getByTestId('need-row').click();
  await page.getByTestId('decision-approve').click();
  await expect(page.getByTestId('toast')).toHaveText('Already approved in Slack');
});

test('Granola saves a selected folder while its initial baseline is preparing', async () => {
  run = await launch('granola-preparing');
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="granola"]').getByTestId('tool-manage').click();
  const meetings = page.getByRole('region', { name: 'Personal meetings' });
  await meetings.getByLabel('Granola folder').selectOption({ label: 'ECHO (1)' });
  await meetings.getByLabel('Save to').selectOption({ label: 'Apollo' });
  await meetings.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await meetings.getByRole('button', { name: 'Use folder for automatic import' }).click();
  await expect(meetings.getByTestId('meeting-watch')).toContainText('ECHO → Apollo');
  await expect(meetings.getByTestId('meeting-watch')).toContainText('Preparing automatic import');
  await expect(meetings.getByRole('status')).toContainText('Folder saved.');
  await meetings.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(meetings.getByTestId('meeting-watch')).toContainText('Automatic import active');
  expect(run.calls().find(call => call.body?.operation === 'watch')?.body).toMatchObject({ folder_id: '00000000-0000-4000-8000-000000000011', project_id: 'prj_11111111-1111-4111-8111-111111111111', retain: true });
});

test('a Granola outage still lets a retained meeting be approved from Home', async () => {
  run = await launch('granola-browse-unavailable');
  const { page } = run;
  await page.getByTestId('need-row').click({ timeout: 5_000 });
  const card = page.getByTestId('decision');
  await expect(card.getByLabel('Share the transcript with the selected audience')).not.toBeChecked();
  await card.getByTestId('decision-approve').click();
  await expect(page.getByTestId('toast')).toContainText('Approved');
  expect(run.calls().filter(call => call.body?.operation === 'review')).toHaveLength(1);
});

test('Home and the decision card hide meeting content while ECHO is concealed', async () => {
  run = await launch('granola-browse-unavailable');
  const { page, app } = run;
  await expect(page.getByTestId('need-row')).toContainText('Pilot planning');
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(page.getByTestId('need-row')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await emit(app, 'echo-test:resume');
  await page.getByTestId('need-row').click();
  const owner = page.getByLabel('Owner for: Send the revised quote');
  await owner.fill('Edited owner');
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(page.getByTestId('decision')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Pilot planning');
  await emit(app, 'echo-test:resume');
  await expect(owner).toHaveValue('Edited owner');
});
