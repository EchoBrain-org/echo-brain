import { expect, test } from '@playwright/test';
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
  await expect.poll(() => run.calls().filter(call => call.path === '/v4/person/tools')).toHaveLength(2);
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


test('Granola browsing requires explicit retention, then offers personal review with transcript sharing off', async ({}, testInfo) => {
  run = await launch('granola');
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="granola"]').getByTestId('tool-manage').click();
  const meetings = page.getByRole('region', { name: 'Personal meetings' });
  await expect(meetings).toContainText('ari@example.test · EchoBrain');
  await meetings.getByLabel('Granola folder').selectOption({ label: 'ECHO (1)' });
  await meetings.getByRole('button', { name: 'Browse meetings' }).click();
  await meetings.getByRole('button', { name: 'Pilot planning', exact: true }).click();
  const add = meetings.getByRole('button', { name: 'Add to ECHO', exact: true });
  await expect(add).toBeDisabled();
  expect(run.calls().filter(call => call.body?.operation === 'import')).toHaveLength(0);
  await meetings.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await add.click();
  await expect(meetings.getByRole('button', { name: 'Pilot planning', exact: true })).toHaveCount(2);
  await meetings.getByRole('button', { name: 'Pilot planning', exact: true }).last().click();
  await expect(meetings.getByLabel('Share the transcript with the selected audience')).not.toBeChecked();
  await meetings.getByRole('radio', { name: 'Only me' }).check();
  await meetings.getByRole('button', { name: 'Approve', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('granola-review.png') });
  await meetings.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => run.calls().filter(call => call.body?.operation === 'review')).toHaveLength(1);
  expect(run.calls().find(call => call.body?.operation === 'import')?.body).toMatchObject({ retain: true, project_id: null });
  expect(run.calls().find(call => call.body?.operation === 'review')?.body).toMatchObject({
    action: 'approve', share_transcript: false, project_ids: [], owners: [
      { signal_id: 'act-1', owner: 'Rafael Moreno' },
      { signal_id: 'act-2', owner: 'Mina Patel' },
    ],
  });
});

test('approves a meeting into two projects with an edited owner', async () => {
  run = await launch('granola');
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="granola"]').getByTestId('tool-manage').click();
  const meetings = page.getByRole('region', { name: 'Personal meetings' });
  await meetings.getByLabel('Granola folder').selectOption({ label: 'ECHO (1)' });
  await meetings.getByRole('button', { name: 'Browse meetings' }).click();
  await meetings.getByRole('button', { name: 'Pilot planning', exact: true }).click();
  await meetings.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await meetings.getByRole('button', { name: 'Add to ECHO', exact: true }).click();
  await expect(meetings.getByRole('button', { name: 'Pilot planning', exact: true })).toHaveCount(2);
  await meetings.getByRole('button', { name: 'Pilot planning', exact: true }).last().click();

  await meetings.getByRole('radio', { name: 'Projects' }).check();
  await expect(meetings.getByRole('checkbox', { name: 'Thermostat redesign' })).toBeChecked();
  await meetings.getByRole('checkbox', { name: 'Supplier review' }).check();
  await meetings.getByLabel('Owner for: Send the revised quote').fill('Rafael M.');
  await meetings.getByLabel('Owner for: Confirm the trace').fill('');
  await meetings.getByRole('button', { name: 'Approve', exact: true }).click();

  await expect.poll(() => run.calls().filter(call => call.body?.operation === 'review')).toHaveLength(1);
  const body = run.calls().find(call => call.body?.operation === 'review')?.body;
  expect(body).toMatchObject({ action: 'approve', share_transcript: false, owners: [{ signal_id: 'act-1', owner: 'Rafael M.' }] });
  expect(body?.project_ids).toHaveLength(2);
});

test('shows that the meeting was already approved in Slack', async () => {
  run = await launch('granola-decided-in-slack');
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="granola"]').getByTestId('tool-manage').click();
  const meetings = page.getByRole('region', { name: 'Personal meetings' });
  await meetings.getByRole('button', { name: 'Pilot planning', exact: true }).click();
  await meetings.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(meetings.getByRole('status')).toHaveText('Already approved in Slack');
  await expect(meetings).toContainText('approved · Approved in Slack');
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
  await expect(meetings).toContainText('Preparing automatic import: ECHO → Apollo.');
  await expect(meetings.getByRole('status')).toHaveText('Folder saved. Existing history stays in Granola until you import it.');
  await meetings.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(meetings).toContainText('Automatic import active: ECHO → Apollo.');
  expect(run.calls().find(call => call.body?.operation === 'watch')?.body).toMatchObject({ folder_id: '00000000-0000-4000-8000-000000000011', project_id: 'prj_11111111-1111-4111-8111-111111111111', retain: true });
});

test('Granola browsing failure leaves retained meetings available for review', async () => {
  run = await launch('granola-browse-unavailable');
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="granola"]').getByTestId('tool-manage').click();
  const meetings = page.getByRole('region', { name: 'Personal meetings' });
  await expect(meetings.getByRole('status')).toBeVisible();
  await meetings.getByRole('button', { name: 'Pilot planning', exact: true }).click({ timeout: 5_000 });
  await expect(meetings.getByLabel('Share the transcript with the selected audience')).not.toBeChecked();
  await meetings.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(meetings).toContainText('approved');
  expect(run.calls().filter(call => call.body?.operation === 'review')).toHaveLength(1);
});
