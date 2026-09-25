import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drop, emit, launch, type Launched } from './launch.js';

let run: Launched;
const folders: string[] = [];
test.afterEach(async () => {
  await run?.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const creates = () => run.calls().filter(call => call.method === 'POST' && call.path === '/v1/person/projects');
const uploads = () => run.calls().filter(call => call.method === 'PUT' && call.path.startsWith('/v2/person/documents/'));

/** New files on disk, like ones in Finder. */
function onDisk(...names: string[]): string[] {
  const folder = mkdtempSync(join(tmpdir(), 'echo-new-project-'));
  folders.push(folder);
  return names.map(name => {
    const file = join(folder, name);
    writeFileSync(file, `${name} text.`);
    return file;
  });
}

async function chooseInDialog(paths: string[]): Promise<void> {
  await run.app.evaluate(({ dialog }, chosen) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: chosen }); }, paths);
}

test('New project is one page: a name and Create, then people, then files if any, then Done', async () => {
  run = await launch('no-projects');
  const { page } = run;
  await page.getByTestId('empty-new-project').click();
  await expect(page.getByTestId('new-project-name')).toBeFocused();
  // Before Create, People and Files show but are off, and a file dropped on the sheet is refused.
  await expect(page.getByTestId('new-project-first')).toHaveText('Create the project first to add people and files.');
  await expect(page.getByTestId('people-find')).toBeDisabled();
  await expect(page.getByTestId('new-project-add-files')).toBeDisabled();
  const [brief] = onDisk('Brief.md');
  await drop(page, page.getByTestId('new-project'), brief!);
  await expect(page.getByTestId('new-project-notice')).toHaveText('Create the project first.');
  const files = page.getByTestId('new-project-file');
  await expect(files).toHaveCount(0);
  await page.getByTestId('new-project-name').fill('  Cedar ');
  await page.getByTestId('new-project-create').click();

  // It opens behind the sheet and joins your projects. The same sheet now takes people, and files below them; nothing is uploaded.
  await expect(page.getByTestId('new-project-title')).toHaveText('Cedar');
  await expect(page.getByTestId('title')).toHaveText('Cedar');
  await expect(page.getByTestId('sidebar-project')).toHaveText(['CCedar']);
  await expect(page.getByTestId('new-project-first')).toHaveCount(0);
  await expect(page.getByTestId('people-find')).toBeFocused();
  const people = (await page.getByTestId('people-find').boundingBox())!;
  const well = (await page.getByTestId('new-project-files').boundingBox())!;
  expect(people.y).toBeLessThan(well.y);
  expect(creates().map(call => call.body)).toEqual([
    { schema_version: 1, kind: 'echo-project-create-v1', request_id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: 'Cedar' },
  ]);
  const project = String(run.calls().find(call => call.path.startsWith('/v1/person/projects/prj_'))!.path.split('/').pop());

  // Someone is added at once, and Undo removes only them.
  await expect(page.getByTestId('member-row')).toHaveText(['AAriLead']);
  await page.getByTestId('people-find').fill('raj');
  await expect(page.getByTestId('candidate-row')).toHaveText(['RKRaj KumarAdd']);
  await page.getByTestId('candidate-add').click();
  await expect(page.getByTestId('people-added')).toContainText('Added Raj Kumar.');
  await expect(page.getByTestId('member-row')).toHaveCount(2);
  await page.getByTestId('people-undo').click();
  await expect(page.getByTestId('member-row')).toHaveText(['AAriLead']);
  expect(uploads()).toHaveLength(0);

  // Add files…: several at once, saved one after another; one main refuses says why. A file dropped now saves too.
  await chooseInDialog([...onDisk('Notes.txt', 'Plan.md'), join(tmpdir(), 'photo.png')]);
  await page.getByTestId('new-project-add-files').click();
  await expect(files).toHaveText([
    'Notes.txt · Saved · Extracting text', 'Plan.md · Saved · Extracting text',
    'photo.png · Choose a TXT, Markdown, PDF or Word file up to 25 MB.',
  ]);
  await drop(page, page.getByTestId('new-project'), brief!);
  await expect(files).toHaveText([
    'Notes.txt · Saved · Extracting text', 'Plan.md · Saved · Extracting text',
    'photo.png · Choose a TXT, Markdown, PDF or Word file up to 25 MB.', 'Brief.md · Saved · Extracting text',
  ]);
  expect(uploads().map(call => call.body?.filename)).toEqual(['Notes.txt', 'Plan.md', 'Brief.md']);
  for (const upload of uploads()) {
    expect(upload.body).toMatchObject({ audience: { kind: 'project', project_id: project }, association_project_ids: [project] });
  }

  await page.getByTestId('new-project-done').click();
  await expect(page.getByTestId('new-project')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toHaveText('Some files may not have been saved.');
  await expect(page.getByTestId('title')).toHaveText('Cedar');
  await expect(page.getByTestId('scope-chip')).toHaveText('Cedar');
});

test('a create whose reply was lost is never called made: Try again resends the same request', async () => {
  run = await launch('change-reply-lost');
  const { page } = run;
  await page.getByTestId('sidebar-new-project').click();
  await page.getByTestId('new-project-name').fill('Cedar');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('new-project-error')).toHaveText('This may not have been sent.');
  await expect(page.getByTestId('new-project-name')).toHaveAttribute('readonly', '');
  // Closing now is asked first; Escape keeps it.
  await page.getByTestId('new-project-close').click();
  await expect(page.getByTestId('new-project-close-anyway')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('new-project-retry')).toBeVisible();

  await page.getByTestId('new-project-retry').click();
  await expect(page.getByTestId('new-project-title')).toHaveText('Cedar');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(3);
  expect(creates()).toHaveLength(2);
  expect(creates()[1]!.body).toEqual(creates()[0]!.body);
  // Files are optional: Done closes it with none.
  await page.getByTestId('new-project-done').click();
  await expect(page.getByTestId('new-project')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toHaveCount(0);
  expect(uploads()).toHaveLength(0);
});

test('with another app in front New project hides its people but takes a drop; a file whose outcome is unknown holds back the rest', async () => {
  run = await launch('document-reply-lost');
  const { page, app } = run;
  await page.getByTestId('sidebar-new-project').click();
  await page.getByTestId('new-project-name').fill('Cedar');
  await page.getByTestId('new-project-create').click();
  await expect(page.getByTestId('new-project-title')).toHaveText('Cedar');
  await expect(page.getByTestId('candidate-row')).toHaveCount(3);
  // A file dragged from Finder: the page and the organization's people are covered, the sheet takes it.
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(page.getByTestId('member-row')).toHaveCount(0);
  await expect(page.getByTestId('candidate-row')).toHaveCount(0);
  const [first, second] = onDisk('A.txt', 'B.txt');
  await drop(page, page.getByTestId('new-project'), first!);
  const files = page.getByTestId('new-project-file');
  await expect(files).toHaveText([/^A\.txt · This may not have been sent\./]);
  await emit(app, 'echo-test:resume');
  await expect(page.getByTestId('candidate-row')).toHaveCount(3);
  await chooseInDialog([second!]);
  await page.getByTestId('new-project-add-files').click();
  await expect(files).toHaveText([/^A\.txt · This may not have been sent\.Check statusTry againSkip…$/, 'B.txt · Not started']);
  expect(uploads()).toHaveLength(1);
  // Closing now would give up A's Check status and Try again: it is asked first, and Escape keeps it.
  await page.getByTestId('new-project-done').click();
  await expect(page.getByTestId('new-project-close-anyway')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('new-project-done')).toBeVisible();
  await page.getByTestId('file-check').click();
  await expect(files).toHaveText(['A.txt · Saved · Extracting text', 'B.txt · Saved · Extracting text']);
  expect(uploads().map(call => call.body?.filename)).toEqual(['A.txt', 'B.txt']);
  await page.getByTestId('new-project-done').click();
  await expect(page.getByTestId('toast')).toHaveCount(0);
});
