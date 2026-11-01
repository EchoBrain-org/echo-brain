import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drop, launch, type Launched } from './launch.js';

let run: Launched;
const folders: string[] = [];
test.afterEach(async () => {
  await run?.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const RAJ = 'mem_44444444-4444-4444-8444-444444444444';
const MAYA = 'mem_33333333-3333-4333-8333-333333333333';
const creates = () => run.calls().filter(call => call.method === 'POST' && call.path === '/v1/person/projects');
const adds = () => run.calls().filter(call => call.path === '/v1/person/projects/members/add').map(call => call.body!);
const uploads = () => run.calls().filter(call => call.method === 'PUT' && call.path.startsWith('/v2/person/documents/'));
const directory = () => run.calls().filter(call => call.path === '/v1/person/directory').map(call => call.body);

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

test('New project is one page: name, people and files before Create; Create opens the project, and the people and the file go in behind it', async () => {
  run = await launch('no-projects');
  const { page } = run;
  await page.getByTestId('empty-new-project').click();
  await expect(page.getByTestId('new-project-name')).toBeFocused();
  // Everything is usable from the start: you lead it, and the organization's people are there to add.
  await expect(page.getByTestId('member-row')).toHaveText(['AAriLead']);
  await expect(page.getByTestId('candidate-row')).toHaveText(['MCMaya ChenAdd', 'RKRaj KumarAdd', 'AMAna MillsAdd']);
  const people = (await page.getByTestId('people-find').boundingBox())!;
  const well = (await page.getByTestId('new-project-files').boundingBox())!;
  expect(people.y).toBeLessThan(well.y);

  // Picked by name; each pick is a row until Create, and can be taken back.
  await page.getByTestId('people-find').fill('raj');
  await expect(page.getByTestId('candidate-row')).toHaveText(['RKRaj KumarAdd']);
  await page.getByTestId('candidate-add').click();
  const picks = page.getByTestId('pick-row');
  await expect(picks).toHaveText(['RKRaj Kumar']);
  await expect(page.getByTestId('people-none')).toHaveText('No one else by that name');
  await page.getByTestId('people-find').fill('');
  await expect(page.getByTestId('candidate-row')).toHaveText(['MCMaya ChenAdd', 'AMAna MillsAdd']);
  await page.getByRole('button', { name: 'Add Ana Mills' }).click();
  await page.getByRole('button', { name: 'Add Maya Chen' }).click();
  await expect(picks).toHaveText(['RKRaj Kumar', 'AMAna Mills', 'MCMaya Chen']);
  await page.getByRole('button', { name: 'Remove Ana Mills' }).click();
  await expect(picks).toHaveText(['RKRaj Kumar', 'MCMaya Chen']);
  await expect(page.getByTestId('candidate-row')).toHaveText(['AMAna MillsAdd']);

  // Files are taken before Create too, dropped or chosen; one main refuses says why, and goes with ×.
  const files = page.getByTestId('new-project-file');
  const [brief] = onDisk('Brief.md');
  await drop(page, page.getByTestId('new-project'), brief!);
  await expect(files).toHaveText(['Brief.md']);
  await chooseInDialog([join(tmpdir(), 'photo.png')]);
  await page.getByTestId('new-project-add-files').click();
  await expect(files).toHaveText(['Brief.md', 'photo.png · Choose a TXT, Markdown, PDF or Word file up to 25 MB.']);
  await page.getByRole('button', { name: 'Remove photo.png' }).click();
  await expect(files).toHaveText(['Brief.md']);

  // Nothing is sent before Create: the organization's directory was only read, for the account on screen.
  expect(creates()).toHaveLength(0);
  expect(adds()).toHaveLength(0);
  expect(uploads()).toHaveLength(0);
  expect(directory()).toContainEqual({ limit: 10, query: 'raj' });
  expect(directory()[0]).toEqual({ limit: 10 });

  await page.getByTestId('new-project-name').fill('  Cedar ');
  await page.getByTestId('new-project-create').click();
  // Create closes the sheet and opens the project; the toast says how it went once everyone and everything is in.
  await expect(page.getByTestId('new-project')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('Cedar');
  await expect(page.getByTestId('sidebar-project')).toHaveText(['CCedar']);
  await expect(page.getByTestId('toast')).toHaveText('Cedar is ready · 2 people, 1 file');

  // In order: the project is made and opens, both people are added, then the file is saved.
  const steps = () => run.calls().map(call => call.method === 'POST' && call.path === '/v1/person/projects' ? 'create'
    : call.path === '/v1/person/projects/members/add' ? `add ${call.body?.membership_id === RAJ ? 'Raj' : call.body?.membership_id === MAYA ? 'Maya' : '?'}`
    : call.method === 'PUT' && call.path.startsWith('/v2/person/documents/') ? 'save'
    : call.path === '/v1/person/list' ? 'open' : null).filter(Boolean);
  await expect.poll(() => steps().filter(step => step !== 'open')).toEqual(['create', 'add Raj', 'add Maya', 'save']);
  expect(steps()).toContain('open');
  expect(steps().indexOf('open')).toBeLessThan(steps().indexOf('save'));
  expect(creates().map(call => call.body)).toEqual([
    { schema_version: 1, kind: 'echo-project-create-v1', request_id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: 'Cedar' },
  ]);
  const project = String(run.calls().find(call => call.method === 'GET' && call.path.startsWith('/v2/person/projects/prj_'))!.path.split('/').pop());
  expect(adds()).toEqual([
    expect.objectContaining({ project_id: project, membership_id: RAJ }), expect.objectContaining({ project_id: project, membership_id: MAYA }),
  ]);
  expect(new Set([creates()[0]!.body!.request_id, ...adds().map(add => add.request_id)]).size).toBe(3);
  expect(uploads().map(call => call.body?.filename)).toEqual(['Brief.md']);
  expect(uploads()[0]!.body).toMatchObject({ audience: { kind: 'project', project_id: project }, association_project_ids: [project] });

  await expect(page.getByTestId('members-button')).toHaveText('ARKMC');
  await expect(page.getByTestId('ask-field')).toBeFocused();
  await expect(page.getByTestId('scope-chip')).toHaveText('Cedar');
});

test('a create whose reply was lost is never called made: Try again resends the same request, then the people and files go', async () => {
  run = await launch('change-reply-lost');
  const { page } = run;
  await page.getByTestId('sidebar-new-project').click();
  await page.getByRole('button', { name: 'Add Raj Kumar' }).click();
  const [brief] = onDisk('Brief.md');
  await drop(page, page.getByTestId('new-project'), brief!);
  await page.getByTestId('new-project-name').fill('Cedar');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('new-project-error')).toHaveText('This may not have been sent.');
  await expect(page.getByTestId('new-project-name')).toHaveAttribute('readonly', '');
  // Closing now is asked first; Escape keeps it.
  await page.getByTestId('new-project-close').click();
  await expect(page.getByTestId('new-project-close-anyway')).toBeVisible();
  await expect(page.getByText('Close? The project may still have been made.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('new-project-retry')).toBeVisible();
  await expect(page.getByTestId('new-project-create')).toHaveCount(0);
  // Until it is made, the person and the file wait, unsent.
  await expect(page.getByTestId('pick-row')).toHaveText(['RKRaj Kumar']);
  await expect(page.getByTestId('new-project-file')).toHaveText(['Brief.md']);
  expect(adds()).toHaveLength(0);
  expect(uploads()).toHaveLength(0);

  await page.getByTestId('new-project-retry').click();
  await expect(page.getByTestId('new-project')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('Cedar');
  await expect(page.getByTestId('toast')).toHaveText('Cedar is ready · 1 person, 1 file');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(3);
  expect(creates()).toHaveLength(2);
  expect(creates()[1]!.body).toEqual(creates()[0]!.body);
  expect(adds()).toHaveLength(1);
  expect(uploads()).toHaveLength(1);
});
