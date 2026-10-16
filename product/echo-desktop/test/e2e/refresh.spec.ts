// Desktop refresh and notifications v1, end to end: the real person client's
// change check against the fixture Authority.
import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, launch, notices, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const PROJECT_ADDED = 'prj_55555555-5555-4555-8555-555555555555';
const desktopLog = () => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8');
const checks = () => run.calls().filter(call => call.method === 'GET' && call.path === '/v1/person/changes').length;
const lists = () => run.calls().filter(call => call.method === 'GET' && call.path === '/v2/person/projects').length;

test('the 2026-10-15 scenario: added to a project while ECHO keeps focus, the sidebar shows it and a notification says so within one check', async () => {
  // The Authority asks for a check every 15 s, its shortest.
  run = await launch('project-added', { 'changes-seconds': '15' });
  const { page } = run;
  const rows = page.getByTestId('sidebar-project');
  await expect(rows).toHaveCount(2);
  // The first check, at sign-in, only learns.
  await expect.poll(checks).toBe(1);
  // Another person adds Ari to Comet. Nothing happens to the window: no focus change, no shown, no click.
  writeFileSync(join(run.home, 'project-added'), '');
  await expect(rows).toHaveCount(3, { timeout: 30_000 });
  await expect(rows.first()).toContainText('Comet');
  await expect.poll(() => notices(run)).toEqual([{ title: 'ECHO', body: 'You were added to Comet', target: { kind: 'project', project_id: PROJECT_ADDED } }]);
  // The log says which area moved, by name only, and that the window never came or went.
  expect(desktopLog()).toMatch(/changes moved projects\n/);
  expect(desktopLog()).not.toMatch(/lifecycle /);
  expect(desktopLog()).not.toMatch(/sha256:|prj_/);
});

test('waking the machine checks at once, and the log says so', async () => {
  run = await launch('project-added');
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await expect.poll(checks).toBe(1);
  writeFileSync(join(run.home, 'project-added'), '');
  await emit(app, 'echo-test:wake');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(3);
  expect(checks()).toBe(2);
  expect(desktopLog()).toMatch(/lifecycle wake\n/);
});

test('a hidden window is notified, and reads what shows once it is shown again', async () => {
  run = await launch('granola-owner-later', { 'changes-seconds': '15' });
  const { page, app } = run;
  await expect(page.getByTestId('need-row').filter({ hasText: 'ECHO-12' })).toBeVisible();
  await expect.poll(checks).toBe(1);
  const homeReads = () => run.calls().filter(call => call.path === '/v1/person/runs' && call.body?.operation === 'home' && call.body.read === 'rows').length;
  await expect(page.getByTestId('needs')).toHaveAttribute('aria-busy', 'false');
  await emit(app, 'echo-test:hidden');
  const before = homeReads();
  // Mina sends Ari a ticket while the window is hidden: the check notifies, and Home waits.
  writeFileSync(join(run.home, 'mina-sends'), '');
  await expect.poll(() => notices(run), { timeout: 30_000 }).toHaveLength(1);
  expect(homeReads()).toBe(before);
  await emit(app, 'echo-test:shown');
  await expect.poll(homeReads).toBe(before + 1);
  await expect(page.getByTestId('need-row').filter({ hasText: 'order six weeks ahead' })).toBeVisible();
  expect(desktopLog()).toMatch(/lifecycle shown\n/);
});

test('an Authority without the change check: logged once, and the sidebar is read again on each return', async () => {
  run = await launch('no-changes');
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await expect.poll(desktopLog).toMatch(/changes unsupported\n/);
  const before = lists();
  await emit(app, 'echo-test:conceal');
  await emit(app, 'echo-test:resume');
  await expect.poll(lists).toBe(before + 2);
  expect(desktopLog().match(/changes unsupported/g)).toHaveLength(1);
  expect(desktopLog()).toMatch(/lifecycle conceal\n.*lifecycle resume\n/s);
});
