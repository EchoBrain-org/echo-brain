import { expect, test } from '@playwright/test';
import { addMeeting, chooseFromAccountMenu, emit, launch, routeAll, type Launched } from './launch.js';

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


test('a meeting added through Granola reaches Home as a decision to approve, each item starting at the suggested project', async ({}, testInfo) => {
  run = await launch('granola');
  const { page } = run;
  await expect(page.getByTestId('home-clear')).toContainText('Nothing needs you');
  await addMeeting(page);
  expect(run.calls().find(call => call.body?.operation === 'browse')?.body).toMatchObject({ folder_id: null });
  expect(run.calls().find(call => call.body?.operation === 'import')?.body).toMatchObject({ retain: true, project_id: null });
  const row = page.getByTestId('need-row');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-kind', 'approve');
  await expect(row).toContainText('Pilot planning');
  await expect(page.getByTestId('sidebar-badge')).toHaveText('1');
  await page.screenshot({ path: testInfo.outputPath('home-needs-you.png') });
  await row.click();
  const card = page.getByTestId('decision');
  await expect(card.getByRole('heading', { name: 'Pilot planning' })).toBeVisible();
  await expect(card).toContainText('Approve');
  await expect(card).toContainText('Launch the pilot next week.');
  // The card reads the review the Authority sent: what was decided, who does what by when, what was said, and where each goes.
  await expect(card).toContainText('1 decision · 2 actions');
  await expect(card.getByTestId('card-signal').filter({ hasText: 'Confirm the trace' })).toContainText('Due Oct 10');
  await expect(card.getByRole('region', { name: 'In the meeting · 3' })).toContainText('Rafael Moreno');
  await card.getByRole('button', { name: 'In the meeting: Launch the pilot next week.' }).click();
  await expect(card.locator('.said-line').filter({ hasText: 'Mina Patel' })).toContainText('Agreed. The freeze lifts on Friday.');
  await expect(card.getByRole('button', { name: 'Why · 1 reason from the meeting' })).toBeVisible();
  await expect(card.getByTestId('route-chip')).toHaveText(['Thermostat redesign', 'Thermostat redesign', 'Thermostat redesign']);
  await expect(card.getByTestId('route-all')).toHaveText('Thermostat redesign');
  await expect(card.getByTestId('route-summary')).toHaveText('3 to Thermostat redesign');
  // Nothing on the card shares the transcript, and no one picks a single audience for the whole meeting.
  await expect(card.getByText(/transcript/i)).toHaveCount(0);
  await expect(card.getByText('Seen by')).toHaveCount(0);
  await routeAll(card, 'Only me');
  await expect(card.getByTestId('route-chip')).toHaveText(['Only me', 'Only me', 'Only me']);
  await page.screenshot({ path: testInfo.outputPath('decision-approve.png') });
  await card.getByTestId('decision-approve').click();
  await expect.poll(() => run.calls().filter(call => call.body?.operation === 'review')).toHaveLength(1);
  const sent = run.calls().find(call => call.body?.operation === 'review')?.body;
  expect(sent).toMatchObject({
    action: 'approve', routes: [{ signal_id: 'dec-1', project_ids: [] }, { signal_id: 'act-1', project_ids: [] }, { signal_id: 'act-2', project_ids: [] }], owners: [
      { signal_id: 'act-1', owner: 'Rafael Moreno' },
      { signal_id: 'act-2', owner: 'Mina Patel' },
    ],
  });
  expect(sent).not.toHaveProperty('share_transcript');
  expect(sent).not.toHaveProperty('project_ids');
  // Back on Home: the row says the check is on its way, then what it found waits to be sent.
  await expect(page.getByTestId('title')).toHaveText('ECHO');
  await expect(page.getByTestId('toast')).toContainText('Approved');
  await expect(page.getByTestId('need-row')).toHaveAttribute('data-kind', /checking|send/);
});

test('sends each item to its own destination: a record and a check per destination, each shown once approved', async ({}, testInfo) => {
  run = await launch('granola');
  const { page } = run;
  await addMeeting(page);
  await page.getByTestId('need-row').click();
  const card = page.getByTestId('decision');
  // The heading has the focus, not a chip: Enter or Space keeps the suggested project.
  await expect(card.getByRole('heading', { name: 'Pilot planning' })).toBeFocused();
  const chips = card.getByTestId('route-chip');
  // The decision: Supplier review too.
  await chips.nth(0).click();
  const menu = card.getByTestId('route-menu');
  await expect(menu.getByRole('checkbox', { name: 'Thermostat redesign' })).toBeChecked();
  await menu.getByRole('checkbox', { name: 'Supplier review' }).check();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(chips.nth(0)).toHaveText('Thermostat redesign +1');
  // The first action stays with the suggestion, its owner edited; the second is not kept.
  await card.getByLabel('Owner for: Send the revised quote').fill('Rafael M.');
  await chips.nth(2).click();
  await menu.getByRole('button', { name: 'Don\'t keep', exact: true }).click();
  await expect(chips).toHaveText(['Thermostat redesign +1', 'Thermostat redesign', 'Not kept']);
  await expect(card.getByLabel('Owner for: Confirm the trace')).toBeDisabled();
  await expect(card.getByTestId('route-all')).toHaveText('Mixed');
  await expect(card.getByTestId('route-summary')).toHaveText('1 to Thermostat redesign +1 · 1 to Thermostat redesign · 1 not kept');
  await page.screenshot({ path: testInfo.outputPath('decision-routes.png') });
  await card.getByTestId('decision-approve').click();
  await expect.poll(() => run.calls().filter(call => call.body?.operation === 'review')).toHaveLength(1);
  const body = run.calls().find(call => call.body?.operation === 'review')?.body;
  expect(body).toMatchObject({ action: 'approve', routes: [
    { signal_id: 'dec-1', project_ids: ['prj_11111111-1111-4111-8111-111111111111', 'prj_44444444-4444-4444-8444-444444444444'] },
    { signal_id: 'act-1', project_ids: ['prj_11111111-1111-4111-8111-111111111111'] }, { signal_id: 'act-2', project_ids: null },
  ], owners: [{ signal_id: 'act-1', owner: 'Rafael M.' }] });
  // Two destinations: two records, each with its own check. The first record's follow-ups open its list; its Approved opens the meeting.
  const send = page.getByTestId('need-row').filter({ hasText: 'follow-ups to send' });
  await expect(send).toBeVisible({ timeout: 20_000 });
  await send.click();
  await page.getByTestId('follow-ups').getByRole('button', { name: /^Approved / }).click();
  const approved = page.getByTestId('decision');
  await expect(approved.getByRole('region', { name: 'Impact · Thermostat redesign +1' }).getByTestId('impact-follow-ups')).toHaveText('Follow-ups · 4 not sent', { timeout: 20_000 });
  await expect(approved.getByRole('region', { name: 'Impact · Thermostat redesign', exact: true })).toBeVisible();
  await expect(approved.getByTestId('route-final')).toHaveText(['Thermostat redesign +1', 'Thermostat redesign', 'Not kept']);
  await expect(approved).toContainText('Rafael M.');
  await page.screenshot({ path: testInfo.outputPath('decision-records.png') });
});

test('shows that the meeting was already approved in Slack', async () => {
  run = await launch('granola-decided-in-slack');
  const { page } = run;
  await page.getByTestId('need-row').click();
  await page.getByTestId('decision-approve').click();
  await expect(page.getByTestId('toast')).toHaveText('Already approved in Slack');
});

test('Granola imports my meetings automatically with no folder, suggesting a project only if asked, and stops', async () => {
  run = await launch('granola-preparing');
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="granola"]').getByTestId('tool-manage').click();
  const meetings = page.getByRole('region', { name: 'Personal meetings' });
  const automatic = meetings.getByRole('group', { name: 'Automatic import' });
  await expect(meetings).toContainText('Imported meetings stay private until you approve items from them.');
  await expect(meetings).not.toContainText('Project members can read');
  await automatic.getByLabel('Import').selectOption({ label: 'My meetings' });
  await expect(automatic.getByLabel('Folder', { exact: true })).toHaveCount(0);
  await expect(automatic.getByLabel('Suggest')).toHaveValue('');
  // Consent comes first.
  await expect(meetings.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await automatic.getByLabel('Suggest').selectOption({ label: 'Apollo' });
  await meetings.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await meetings.getByRole('button', { name: 'Save', exact: true }).click();
  const watch = meetings.getByTestId('meeting-watch');
  await expect(watch).toHaveText(/^My meetings · suggests Apollo · PreparingStop$/);
  await expect(meetings.getByRole('status')).toContainText('Saved.');
  await meetings.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(watch).toContainText('My meetings · suggests Apollo · Checked');
  expect(run.calls().find(call => call.body?.operation === 'watch')?.body).toMatchObject({ watch: 'mine', folder_id: null, project_id: 'prj_11111111-1111-4111-8111-111111111111', retain: true });
  await watch.getByRole('button', { name: 'Stop' }).click();
  await expect(watch).toHaveCount(0);
  await expect(automatic.getByLabel('Import')).toHaveValue('off');
  expect(run.calls().filter(call => call.body?.operation === 'watch').at(-1)?.body).toMatchObject({ watch: 'off', folder_id: null, project_id: null });
});

test('Granola watches one folder, with no suggested project by default', async () => {
  run = await launch('granola-preparing');
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="granola"]').getByTestId('tool-manage').click();
  const meetings = page.getByRole('region', { name: 'Personal meetings' });
  const automatic = meetings.getByRole('group', { name: 'Automatic import' });
  await meetings.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await automatic.getByLabel('Import').selectOption({ label: 'One folder' });
  await expect(meetings.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await automatic.getByLabel('Folder', { exact: true }).selectOption({ label: 'ECHO' });
  await meetings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(meetings.getByTestId('meeting-watch')).toHaveText(/^ECHO folder · PreparingStop$/);
  expect(run.calls().find(call => call.body?.operation === 'watch')?.body).toMatchObject({ watch: 'folder', folder_id: '00000000-0000-4000-8000-000000000011', project_id: null, retain: true });
});

test('adding one meeting by hand browses a chosen folder and keeps its suggested project', async () => {
  run = await launch('granola');
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="granola"]').getByTestId('tool-manage').click();
  const meetings = page.getByRole('region', { name: 'Personal meetings' });
  const add = meetings.getByRole('group', { name: 'Add one meeting' });
  await expect(add.getByLabel('From')).toHaveValue('');
  await add.getByLabel('From').selectOption({ label: 'ECHO (1)' });
  await expect.poll(() => run.calls().filter(call => call.body?.operation === 'browse').map(call => call.body?.folder_id))
    .toEqual([null, '00000000-0000-4000-8000-000000000011']);
  await add.getByLabel('Suggest').selectOption({ label: 'Thermostat redesign' });
  await meetings.getByRole('button', { name: 'Pilot planning', exact: true }).click();
  await meetings.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await expect(meetings.getByRole('article', { name: 'Pilot planning' })).toContainText('Suggests Thermostat redesign');
  await meetings.getByRole('button', { name: 'Add to ECHO', exact: true }).click();
  await expect(meetings.getByRole('status')).toContainText('Added.');
  expect(run.calls().find(call => call.body?.operation === 'import')?.body).toMatchObject({ retain: true, project_id: 'prj_11111111-1111-4111-8111-111111111111' });
});

test('a Granola outage still lets a retained meeting be approved from Home', async () => {
  run = await launch('granola-browse-unavailable');
  const { page } = run;
  await page.getByTestId('need-row').click({ timeout: 5_000 });
  const card = page.getByTestId('decision');
  // The review is the Authority's, so where each item goes needs nothing from Granola; the chip names the project as your list does.
  await expect(card.getByTestId('route-chip')).toHaveText(['Apollo', 'Apollo', 'Apollo']);
  await card.getByTestId('decision-approve').click();
  await expect(page.getByTestId('toast')).toContainText('Approved');
  expect(run.calls().filter(call => call.body?.operation === 'review')).toHaveLength(1);
  expect(run.calls().find(call => call.body?.operation === 'review')?.body).toMatchObject({ routes: [
    { signal_id: 'dec-1', project_ids: ['prj_11111111-1111-4111-8111-111111111111'] }, { signal_id: 'act-1', project_ids: ['prj_11111111-1111-4111-8111-111111111111'] },
    { signal_id: 'act-2', project_ids: ['prj_11111111-1111-4111-8111-111111111111'] }] });
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
