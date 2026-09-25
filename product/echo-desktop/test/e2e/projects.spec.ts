import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emit, launch, type Launched } from './launch.js';

let run: Launched;
const folders: string[] = [];
test.afterEach(async () => {
  await run?.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const APOLLO = 'prj_11111111-1111-4111-8111-111111111111';
const BEACON = 'prj_44444444-4444-4444-8444-444444444444';
const DOCUMENT = `doc_${'e'.repeat(64)}`;
const MAYA = 'mem_33333333-3333-4333-8333-333333333333';
const RAJ = 'mem_44444444-4444-4444-8444-444444444444';

test('a project is one feed of notes and documents, and More reads older ones in order', async () => {
  run = await launch('long-feed');
  const { page } = run;
  await page.getByTestId('project-row').nth(1).click();
  const rows = page.getByTestId('feed-row');
  // Ten notes are read; the document is older than the tenth, so it waits for More.
  await expect(rows).toHaveCount(10);
  await expect(rows.first()).toContainText('Note 1');
  await expect(page.locator('[data-kind="document"]')).toHaveCount(0);
  await page.getByTestId('feed-more').click();
  await expect(rows).toHaveCount(13);
  await expect(rows.nth(10)).toContainText('Note 11');
  await expect(rows.nth(11)).toContainText('Q4 hiring plan.pdf');
  await expect(rows.nth(11).getByTestId('document-detail')).toHaveText('PDF · 24 bytes');
  await expect(rows.nth(12)).toContainText('Note 12');
  await expect(page.getByTestId('feed-more')).toHaveCount(0);
  const feeds = run.calls().filter(call => call.path === '/v2/person/projects/context/feed');
  expect(feeds.map(call => call.body?.cursor ?? null)).toEqual([null, 'cGFnZTI']);
  expect(run.calls().filter(call => call.path === '/v2/person/documents/search').map(call => call.body))
    .toEqual([{ schema_version: 2, kind: 'echo-person-document-search-v2', project_id: BEACON, query: '', limit: 10, cursor: null }]);
});

test('the feed keeps its place: Back from an original, or ECHO coming back, returns to where it was scrolled', async () => {
  run = await launch('long-feed');
  const { page, app } = run;
  await page.getByTestId('project-row').nth(1).click();
  const rows = page.getByTestId('feed-row');
  await expect(rows).toHaveCount(10);
  await page.getByTestId('feed-more').click();
  await expect(rows).toHaveCount(13);
  const feed = page.getByTestId('feed');
  const top = () => feed.evaluate(element => element.scrollTop);
  await feed.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const bottom = await top();
  expect(bottom).toBeGreaterThan(0);

  await rows.nth(12).click();
  await expect(page.getByTestId('reader-text')).toBeVisible();
  await page.getByTestId('back').click();
  await expect(rows).toHaveCount(13);
  expect(await top()).toBe(bottom);

  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await emit(app, 'echo-test:resume');
  await expect(rows).toHaveCount(13);
  expect(await top()).toBe(bottom);

  // Opening the project again is a new visit: its first page, from the top.
  await page.getByTestId('sidebar-project').nth(1).click();
  await expect(rows).toHaveCount(10);
  expect(await top()).toBe(0);
});

test('the reader says who can read an original when it is not the project\'s members', async () => {
  run = await launch('long-feed');
  const { page } = run;
  await page.getByTestId('project-row').nth(1).click();
  const rows = page.getByTestId('feed-row');
  await expect(rows).toHaveCount(10);
  await page.getByTestId('write-button').click();
  await page.getByTestId('readers-only-me').click();
  await page.getByTestId('compose-body').fill('My own reminder');
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByTestId('toast')).toHaveText('Saved for you');
  await expect(rows.first()).toContainText('My own reminder');
  await expect(rows.first().getByLabel('Only me')).toBeVisible();
  await rows.first().click();
  await expect(page.getByTestId('reader-meta')).toHaveText(/^Only me · /);
  await page.getByTestId('back').click();
  // The project's members: nothing more to say.
  await rows.nth(1).click();
  await expect(page.getByTestId('reader-text')).toHaveText('Note 1 text.');
  await expect(page.getByTestId('reader-meta')).not.toContainText('Only me');
  await page.getByTestId('back').click();

  // A saved note found in all context says it too.
  await page.getByTestId('scope-clear').click();
  await page.getByTestId('ask-field').fill('pricing tiers');
  await page.getByTestId('match-row').first().click();
  await expect(page.getByTestId('reader-meta')).toHaveText(/^Only me · /);
});

test('a save into the project on screen keeps the rows shown, even when reading them again fails', async () => {
  run = await launch('long-feed-refresh-fails');
  const { page } = run;
  const feeds = () => run.calls().filter(call => call.path === '/v2/person/projects/context/feed').length;
  const log = () => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8');
  await page.getByTestId('project-row').nth(1).click();
  const rows = page.getByTestId('feed-row');
  await expect(rows).toHaveCount(10);
  await page.getByTestId('feed-more').click();
  await expect(rows).toHaveCount(13);

  // Read again after the save, the notes fail: nothing shown goes, and no error is shown for it.
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Beacon standup');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved to Beacon');
  await expect.poll(log).toMatch(/projects\.feed unavailable/);
  await page.waitForTimeout(300);
  await expect(rows).toHaveCount(13);
  await expect(page.getByTestId('feed-failure')).toHaveCount(0);
  await expect(page.getByTestId('feed-error')).toHaveCount(0);

  // Read again once more, the new note leads, and the older rows More loaded stay.
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Beacon standup');
  await page.getByTestId('compose-send').click();
  await expect(rows.first()).toContainText('Beacon standup');
  await expect(rows).toHaveCount(14);
  await expect(rows.last()).toContainText('Note 12');
  await expect(page.getByTestId('feed-more')).toHaveCount(0);
  expect(feeds()).toBe(4);
});

test('a list that could not be read says why beside the rest, and Try again reads only it', async () => {
  run = await launch('documents-fail-once');
  const { page } = run;
  const lists = () => run.calls().filter(call => call.path === '/v2/person/documents/search').length;
  await page.getByTestId('project-row').nth(1).click();
  await expect(page.getByTestId('feed-row')).toHaveCount(1);
  await expect(page.getByTestId('feed-failure')).toContainText('ECHO is unavailable right now.');
  const feeds = run.calls().filter(call => call.path === '/v2/person/projects/context/feed').length;
  await page.getByTestId('feed-retry').click();
  await expect(page.getByTestId('feed-row')).toHaveCount(2);
  await expect(page.locator('[data-kind="document"]')).toContainText('Q4 hiring plan.pdf');
  await expect(page.getByTestId('feed-failure')).toHaveCount(0);
  expect(lists()).toBe(2);
  expect(run.calls().filter(call => call.path === '/v2/person/projects/context/feed')).toHaveLength(feeds);
});

test('a document reads a page of text at a time, and Save original writes the checked original where main was told', async () => {
  run = await launch();
  const { page, app } = run;
  await page.getByTestId('project-row').nth(1).click();
  await page.locator('[data-kind="document"]').click();
  await expect(page.getByTestId('reader-chunk')).toHaveText(['Hire two engineers in October.']);
  await expect(page.getByTestId('reader-meta')).toContainText('PDF · 24 bytes');
  await page.getByTestId('reader-actions').click();
  await page.getByTestId('reader-next').click();
  await expect(page.getByTestId('reader-chunk')).toHaveText(['Open a design role in November.']);
  await page.getByTestId('reader-actions').click();
  await expect(page.getByTestId('reader-next')).toBeDisabled();
  // Read in the project it was opened from.
  const texts = run.calls().filter(call => call.path === `/v2/person/documents/${DOCUMENT}/text`);
  expect(texts.map(call => call.query)).toEqual([`?project_id=${BEACON}`, `?cursor=cGFnZTI&project_id=${BEACON}`]);

  const folder = mkdtempSync(join(tmpdir(), 'echo-save-'));
  folders.push(folder);
  const target = join(folder, 'Q4 hiring plan.pdf');
  await app.evaluate(({ dialog }, path) => {
    const names: string[] = [];
    dialog.showSaveDialog = (async (_window: unknown, options: { defaultPath?: string }) => {
      names.push(options.defaultPath ?? '');
      return { canceled: false, filePath: path };
    }) as never;
    (globalThis as { echoTestSaveNames?: string[] }).echoTestSaveNames = names;
  }, target);
  await page.getByTestId('reader-save').click();
  await expect(page.getByTestId('reader-save-status')).toHaveText('Original saved to your selected file.');
  expect(readFileSync(target, 'utf8')).toBe('%PDF-1.4 Q4 hiring plan\n');
  expect(await app.evaluate(() => (globalThis as { echoTestSaveNames?: string[] }).echoTestSaveNames)).toEqual(['Q4 hiring plan.pdf']);
  // The page never held the path, and the log names none.
  expect(await page.content()).not.toContain(folder);
  expect(readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8')).not.toContain('echo-save-');

  // The client never replaces a file: the same place again asks for a new name, and nothing is read.
  const originals = () => run.calls().filter(call => call.path.endsWith('/original')).length;
  expect(originals()).toBe(1);
  await page.getByTestId('reader-actions').click();
  await page.getByTestId('reader-save').click();
  await expect(page.getByTestId('reader-save-status')).toHaveText('A file with that name is already there. Choose a new name.');
  expect(originals()).toBe(1);
  expect(existsSync(target)).toBe(true);

  // It leaves the project it was opened in.
  await page.getByTestId('reader-actions').click();
  await page.getByTestId('reader-remove').click();
  await expect(page.getByTestId('toast')).toHaveText('Removed from Beacon');
  await expect(page.getByTestId('reader')).toHaveCount(0);
  await expect(page.locator('[data-kind="document"]')).toHaveCount(0);
  const dissociate = run.calls().filter(call => call.path === `/v1/person/documents/${DOCUMENT}/dissociate`);
  expect(dissociate.map(call => call.body)).toEqual([expect.objectContaining({ project_id: BEACON })]);
});

test('an original can leave the project it is in, or be added to another, and the reader says where it went', async () => {
  run = await launch();
  const { page } = run;
  await page.getByTestId('project-row').nth(0).click();
  await page.getByTestId('feed-row').click();
  await expect(page.getByTestId('reader-text')).toHaveText('We agreed to ship.');
  await page.getByTestId('reader-actions').click();
  await page.getByTestId('reader-remove').click();
  await expect(page.getByTestId('toast')).toHaveText('Removed from Apollo');
  await expect(page.getByTestId('reader')).toHaveCount(0);
  await expect(page.getByTestId('feed-empty')).toBeVisible();
  const dissociate = run.calls().filter(call => call.path === '/v1/person/projects/context/dissociate');
  expect(dissociate).toHaveLength(1);
  expect(dissociate[0]!.body).toMatchObject({ project_id: APOLLO, context_id: `ctx_${'a'.repeat(64)}`, kind: 'echo-project-context-dissociate-v1' });

  // A saved note found in all context goes to another project, which opens on it.
  await page.getByTestId('scope-clear').click();
  await page.getByTestId('ask-field').fill('pricing');
  await page.getByTestId('match-row').first().click();
  await expect(page.getByTestId('reader-text')).toContainText('usage-based pricing');
  await page.getByTestId('reader-actions').click();
  await expect(page.getByTestId('reader-remove')).toHaveCount(0);
  await page.getByTestId('reader-add').click();
  await expect(page.getByTestId('reader-project')).toHaveText(['Apollo', 'Beacon']);
  await page.getByTestId('reader-project').nth(1).click();
  await expect(page.getByTestId('toast')).toHaveText('Added to Beacon');
  await expect(page.getByTestId('title')).toHaveText('Beacon');
  await expect(page.getByTestId('feed-row').filter({ hasText: 'Pricing decision from Tuesday sync' })).toHaveCount(1);
  const associate = run.calls().filter(call => call.path === '/v1/person/projects/context/associate');
  expect(associate.map(call => call.body)).toEqual([expect.objectContaining({ project_id: BEACON, context_id: `ctx_${'d'.repeat(64)}` })]);

  // An empty project offers Capture, into it.
  await page.getByTestId('sidebar-project').nth(0).click();
  await page.getByTestId('empty-capture').click();
  await expect(page.getByTestId('readers-project')).toHaveText('Apollo');
  await expect(page.getByTestId('readers-project')).toHaveAttribute('aria-pressed', 'true');
});

test('a lead adds someone at once, Undo removes only them, and making a lead or removing is asked first', async () => {
  run = await launch();
  const { page, app } = run;
  const changes = (kind: string) => run.calls().filter(call => call.path === `/v1/person/projects/members/${kind}`).map(call => call.body!);
  await page.getByTestId('project-row').nth(0).click();
  await expect(page.getByTestId('members-button')).toHaveText('AMC');
  await page.getByTestId('members-button').click();
  const members = page.getByTestId('member-row');
  await expect(members).toHaveText(['AAriLead', 'MCMaya Chen']);
  // You never manage your own row.
  await expect(page.getByTestId('member-more')).toHaveCount(1);
  await expect(page.getByTestId('candidate-row')).toHaveText(['RKRaj KumarAdd', 'AMAna MillsAdd']);
  await page.getByTestId('people-find').fill('raj');
  await expect(page.getByTestId('candidate-row')).toHaveText(['RKRaj KumarAdd']);
  expect(run.calls().filter(call => call.path === '/v1/person/projects/directory').at(-1)!.body).toMatchObject({ project_id: APOLLO, query: 'raj' });

  await page.getByTestId('candidate-add').click();
  await expect(page.getByTestId('people-added')).toContainText('Added Raj Kumar.');
  await expect(members).toHaveCount(3);
  await expect(page.getByTestId('candidate-row')).toHaveCount(0);
  await page.getByTestId('people-undo').click();
  await expect(members).toHaveCount(2);
  await expect(page.getByTestId('people-added')).toHaveCount(0);
  expect(changes('add')).toEqual([expect.objectContaining({ project_id: APOLLO, membership_id: RAJ })]);
  expect(changes('remove')).toEqual([expect.objectContaining({ project_id: APOLLO, membership_id: RAJ })]);
  expect(changes('remove')[0]!.request_id).not.toBe(changes('add')[0]!.request_id);

  await page.getByTestId('member-more').click();
  await page.getByTestId('member-role').click();
  await expect(page.getByTestId('people-confirm')).toContainText('Make Maya Chen a lead?');
  expect(changes('set')).toHaveLength(0);
  await page.getByTestId('people-confirm-go').click();
  await expect(members.nth(1)).toContainText('Lead');
  expect(changes('set')).toEqual([expect.objectContaining({ membership_id: MAYA, role: 'lead' })]);

  await page.getByTestId('member-more').click();
  await page.getByTestId('member-remove').click();
  await expect(page.getByTestId('people-confirm')).toContainText('Remove Maya Chen?');
  // Escape steps back from the question, not out of People.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('people-confirm')).toHaveCount(0);
  await expect(page.getByTestId('people')).toBeVisible();
  await page.getByTestId('member-more').click();
  await page.getByTestId('member-remove').click();
  await page.getByTestId('people-confirm-go').click();
  await expect(members).toHaveText(['AAriLead']);
  expect(changes('remove')).toHaveLength(2);

  // Another app in front: People closes, and the rows a file can land on stay.
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('people')).toHaveCount(0);
  await expect(page.getByTestId('members-button')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
});

test('a member sees who is in a project and cannot change it', async () => {
  run = await launch();
  const { page } = run;
  await page.getByTestId('project-row').nth(1).click();
  await page.getByTestId('members-button').click();
  await expect(page.getByTestId('member-row')).toHaveText(['MCMaya ChenLead', 'AAri']);
  await expect(page.getByTestId('people-find')).toHaveCount(0);
  await expect(page.getByTestId('member-more')).toHaveCount(0);
  await expect(page.getByTestId('candidate-row')).toHaveCount(0);
  expect(run.calls().filter(call => call.path === '/v1/person/projects/directory')).toHaveLength(0);
});

test('People reads your role again, and a new one empties the bar', async () => {
  run = await launch('demoted');
  const { page } = run;
  await page.getByTestId('project-row').nth(0).click();
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await page.getByTestId('ask-field').fill('apollo');
  await page.getByTestId('members-button').click();
  await expect(page.getByTestId('member-row')).toHaveCount(2);
  await expect(page.getByTestId('people-find')).toHaveCount(0);
  await expect(page.getByTestId('ask-field')).toHaveValue('');
  await expect(page.getByTestId('sidebar-project').nth(0)).toBeVisible();
});

test('a change whose reply was lost is never called made: Try again resends the same request until the Authority answers', async () => {
  run = await launch('change-reply-lost');
  const { page, app } = run;
  const adds = () => run.calls().filter(call => call.path === '/v1/person/projects/members/add').map(call => call.body!);
  await page.getByTestId('project-row').nth(0).click();
  // People over a note: its line shows once, in People.
  await page.getByTestId('feed-row').click();
  await expect(page.getByTestId('reader-text')).toBeVisible();
  await page.getByTestId('members-button').click();
  await page.getByTestId('candidate-add').first().click();
  await expect(page.getByTestId('change-error')).toHaveText('This may not have been sent.');
  await expect(page.getByTestId('people-added')).toHaveCount(0);
  // Nothing else changes until it is settled.
  await expect(page.getByTestId('candidate-add').first()).toBeDisabled();
  await expect(page.getByTestId('member-more')).toBeDisabled();
  const asked = await app.evaluate(async ({ app: electronApp, dialog }) => {
    const prompts: string[] = [];
    dialog.showMessageBoxSync = ((options: Electron.MessageBoxSyncOptions) => { prompts.push(options.message); return 1; }) as never; // Cancel
    electronApp.quit();
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
    return prompts;
  });
  expect(asked).toEqual(['A project change may not have finished.']);

  // Closed and opened again, it shows at the top of the page, then back in People.
  await page.getByTestId('people-close').click();
  await expect(page.getByTestId('change-banner')).toContainText('This may not have been sent.');
  // A save's toast does not hide it.
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Kickoff notes');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved to Apollo');
  await expect(page.getByTestId('change-banner')).toContainText('This may not have been sent.');
  await page.getByTestId('members-button').click();
  await page.getByTestId('change-retry').click();
  await expect(page.getByTestId('people-added')).toContainText('Added Raj Kumar.');
  await expect(page.getByTestId('change-line')).toHaveCount(0);
  expect(adds()).toHaveLength(2);
  expect(adds()[1]).toEqual(adds()[0]);
});
