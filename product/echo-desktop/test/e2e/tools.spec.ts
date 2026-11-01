import { expect, test } from '@playwright/test';
import { addMeeting, chooseFromAccountMenu, emit, launch, routeAll, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const toolCalls = () => run.calls().filter(call => call.path.startsWith('/v1/person/tools/jira/') || call.path.startsWith('/v1/person/tools/confluence/') || call.path.includes('/slack/disconnect'))
  .map(call => call.path.replace('/v1/person/tools/jira/', 'jira ').replace('/v1/person/tools/confluence/', 'confluence ').replace('/v2/person/external-identities/slack/', 'slack '));

test('Connect waits on the browser, reads the attempt until it completes, and lists the tool as connected', async () => {
  run = await launch();
  const { page } = run;
  await chooseFromAccountMenu(run, page.getByTestId('account-row'), 'Connected tools…');
  await expect(page.getByTestId('tools')).toContainText('Ari · https://authority.example');
  await page.locator('[data-tool="jira"]').getByTestId('tool-connect').click();
  await expect(page.getByTestId('tool-connect-sheet')).toContainText('Finish connecting Jira in your browser');
  await expect(page.getByTestId('tool-connect-waiting')).toContainText(/Waiting · expires in (29|30) min/);
  await expect(page.getByTestId('toast')).toHaveText('Jira connected', { timeout: 15_000 });
  await expect(page.getByTestId('tool-connect-sheet')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Connected' }).getByTestId('tool-row')).toHaveText(['SSlackConnectedManage', 'JJiraConnectedManage']);
  await expect(page.getByRole('region', { name: 'Available' }).getByTestId('tool-row')).toHaveText(['CConfluenceNot connectedConnect']);
  expect(await page.content()).not.toMatch(/T0123ABCD|U0123ABCD|atlassian-account/);
  await page.locator('[data-tool="slack"]').getByTestId('tool-manage').click();
  await expect(page.getByTestId('tool-manage-sheet')).toContainText('Disconnecting removes only your own Slack connection');
  await emit(run.app, 'echo-test:conceal');
  await expect(page.getByTestId('tool-manage-sheet')).toHaveCount(0);
  await emit(run.app, 'echo-test:resume');
  await expect(page.getByTestId('tool-manage-sheet')).toContainText('Disconnecting removes only your own Slack connection');
  await page.getByTestId('tool-disconnect').click();
  await expect(page.getByTestId('toast')).toHaveText('Slack disconnected');
  await expect(page.getByTestId('tool-manage-sheet')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Available' }).getByTestId('tool-row')).toHaveText(['SSlackNot connectedConnect', 'CConfluenceNot connectedConnect']);
  expect(toolCalls()).toEqual(['jira connect', 'jira status', 'jira status', 'slack disconnect']);
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
  await expect(card.getByRole('heading', { name: 'Pilot planning' })).toBeFocused();
  await expect(card).toContainText('Approve');
  await expect(card).toContainText('Launch the pilot next week.');
  // The card reads the review the Authority sent: what was decided, who does what by when, what was said, and where each goes.
  await expect(card).toContainText('1 decision · 2 actions');
  await expect(card.getByTestId('card-signal').filter({ hasText: 'Confirm the trace' })).toContainText('Due Oct 10');
  await expect(card.getByRole('region', { name: 'In the meeting · 3' })).toContainText('Rafael Moreno');
  // The meeting's words are behind one button in the head, not one per item, and open at the card's full width.
  await expect(card.getByRole('button', { name: /^In the meeting:/ })).toHaveCount(0);
  await card.getByTestId('card-notes-toggle').click();
  await expect(card.getByTestId('card-notes-toggle')).toHaveText('Hide the notes');
  await expect(card.getByTestId('card-notes').locator('.said-line').filter({ hasText: 'Agreed. The freeze lifts on Friday.' })).toContainText('Mina Patel');
  await card.getByTestId('card-notes-toggle').click();
  await expect(card.getByTestId('card-notes')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Why · 1 reason from the meeting' })).toBeVisible();
  await expect(card.getByTestId('route-chip')).toHaveText(['Thermostat redesign', 'Thermostat redesign', 'Thermostat redesign']);
  await expect(card.getByTestId('route-readers')).toHaveText(['Project members can read it', 'Project members can read it', 'Project members can read it']);
  await expect(card.getByTestId('route-all')).toHaveText('Thermostat redesign');
  await expect(card.getByTestId('route-summary')).toHaveText('3 to Thermostat redesign');
  // Nothing on the card shares the transcript, and no one picks a single audience for the whole meeting.
  await expect(card.getByText(/transcript/i)).toHaveCount(0);
  await expect(card.getByText('Seen by')).toHaveCount(0);
  await routeAll(card, 'No project');
  await expect(card.getByTestId('route-chip')).toHaveText(['No project', 'No project', 'No project']);
  // In no project the lock stays on: only Ari reads them, and each says so.
  for (let index = 0; index < 3; index += 1) {
    await expect(card.getByTestId('route-lock').nth(index)).toHaveAttribute('aria-pressed', 'true');
    await expect(card.getByTestId('route-lock').nth(index)).toHaveAttribute('aria-disabled', 'true');
  }
  await expect(card.getByTestId('route-readers')).toHaveText(['Only you can read it', 'Only you can read it', 'Only you can read it']);
  await page.screenshot({ path: testInfo.outputPath('decision-approve.png') });
  await card.getByLabel('Owner for: Send the revised quote').fill('Rafael M.');
  await card.getByTestId('decision-approve').click();
  await expect.poll(() => run.calls().filter(call => call.body?.operation === 'review')).toHaveLength(1);
  const sent = run.calls().find(call => call.body?.operation === 'review')?.body;
  expect(sent).toMatchObject({
    action: 'approve', routes: [{ signal_id: 'dec-1', project_ids: [] }, { signal_id: 'act-1', project_ids: [] }, { signal_id: 'act-2', project_ids: [] }], owners: [
      { signal_id: 'act-1', owner: 'Rafael M.' },
      { signal_id: 'act-2', owner: 'Mina Patel' },
    ],
  });
  expect(sent).not.toHaveProperty('share_transcript');
  expect(sent).not.toHaveProperty('project_ids');
  // Back on Home: the row says the check is on its way, then what it found waits to be sent.
  await expect(page.getByTestId('title').getByTestId('alt-stops')).toBeVisible();
  await expect(page.getByTestId('toast')).toContainText('Approved');
  await expect(page.getByTestId('need-row')).toHaveAttribute('data-kind', /checking|send/);
});

test('Granola imports my meetings automatically with no folder, suggests a project only if asked, changes it in place, and stops', async () => {
  run = await launch('granola-preparing');
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="granola"]').getByTestId('tool-manage').click();
  const meetings = page.getByRole('region', { name: 'Personal meetings' });
  const automatic = meetings.getByRole('group', { name: 'Automatic import' });
  const save = meetings.getByRole('button', { name: 'Save', exact: true });
  const apollo = 'prj_11111111-1111-4111-8111-111111111111', beacon = 'prj_44444444-4444-4444-8444-444444444444';
  // Imported meetings are private by default, so the sheet says nothing about who reads them.
  await expect(meetings).toContainText('I allow ECHO to retain');
  await expect(meetings).not.toContainText('Project members can read');
  await expect(meetings).not.toContainText('stay private');
  await automatic.getByLabel('Import').selectOption({ label: 'My meetings' });
  await expect(automatic.getByLabel('Folder', { exact: true })).toHaveCount(0);
  await expect(automatic.getByLabel('Suggest')).toHaveValue('');
  // Consent comes first.
  await expect(save).toBeDisabled();
  await automatic.getByLabel('Suggest').selectOption({ label: 'Apollo' });
  await meetings.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await save.click();
  const watch = meetings.getByTestId('meeting-watch');
  await expect(watch).toHaveText(/^PreparingStop$/);
  await expect(meetings.getByRole('status')).toHaveText('Saved.');
  // The controls show the watch that runs; Save is back only once they differ from it.
  await expect(automatic.getByLabel('Import')).toHaveValue('mine');
  await expect(automatic.getByLabel('Suggest')).toHaveValue(apollo);
  await expect(save).toHaveCount(0);
  await meetings.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(watch).toContainText('Checked');
  // Another suggestion updates the running watch, with no Stop first.
  await automatic.getByLabel('Suggest').selectOption({ label: 'Beacon' });
  await save.click();
  await expect(meetings.getByRole('status')).toHaveText('Saved.');
  await expect(automatic.getByLabel('Suggest')).toHaveValue(beacon);
  await expect(save).toHaveCount(0);
  await expect(watch).toContainText('Checked');
  expect(run.calls().filter(call => call.body?.operation === 'watch').map(call => call.body)).toMatchObject([
    { watch: 'mine', folder_id: null, project_id: apollo, retain: true },
    { watch: 'mine', folder_id: null, project_id: beacon, retain: true },
  ]);
  await watch.getByRole('button', { name: 'Stop' }).click();
  await expect(watch).toHaveCount(0);
  await expect(automatic.getByLabel('Import')).toHaveValue('off');
  expect(run.calls().filter(call => call.body?.operation === 'watch').at(-1)?.body).toMatchObject({ watch: 'off', folder_id: null, project_id: null });
  // The next watch starts with no suggestion, as a first one does.
  await automatic.getByLabel('Import').selectOption({ label: 'My meetings' });
  await expect(automatic.getByLabel('Suggest')).toHaveValue('');
  const add = meetings.getByRole('group', { name: 'Add one meeting' });
  await add.getByLabel('From').selectOption({ label: 'ECHO (1)' });
  await expect.poll(() => run.calls().filter(call => call.body?.operation === 'browse').map(call => call.body?.folder_id))
    .toEqual([null, '00000000-0000-4000-8000-000000000011']);
  await add.getByLabel('Suggest').selectOption({ label: 'Apollo' });
  await meetings.getByRole('button', { name: 'Pilot planning', exact: true }).click();
  await expect(meetings.getByRole('article', { name: 'Pilot planning' })).toContainText('Suggests Apollo');
  await meetings.getByRole('button', { name: 'Add to ECHO', exact: true }).click();
  await expect(meetings.getByRole('status')).toHaveText('Added.');
  expect(run.calls().find(call => call.body?.operation === 'import')?.body).toMatchObject({ retain: true, project_id: apollo });
});
