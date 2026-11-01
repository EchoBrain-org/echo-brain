import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

test('Back keeps the pages Home had loaded, and showing the window re-reads them once a project changed', async () => {
  run = await launch('many-projects');
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(10);
  await page.getByTestId('sidebar-more').click();
  await expect(page.getByTestId('sidebar-project')).toHaveCount(13);
  await expect(page.getByTestId('sidebar-more')).toHaveCount(0);
  await page.getByTestId('sidebar-project').nth(12).click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('sidebar-project')).toHaveCount(13);
  // Renamed elsewhere: the change check says your projects moved, and every page is read again (to tell a project Ari was
  // added to), which fills both pages the sidebar shows: what shows is what the Authority has now; More stays gone.
  writeFileSync(join(run.home, 'renamed'), '');
  await emit(app, 'echo-test:shown');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(13);
  await expect(page.getByTestId('sidebar-project').first()).toContainText('Project 1, renamed');
  await expect(page.getByTestId('sidebar-more')).toHaveCount(0);
});

test('opening ECHO again while it runs brings the window forward, as Open ECHO does', async () => {
  run = await launch();
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await expect(page.getByTestId('ask-field')).toBeFocused();
  // Home's reads of its rows: coming forward reads what shows again.
  const homeReads = () => run.calls().filter(call => call.path === '/v1/person/runs' && call.body?.operation === 'home' && call.body.read === 'rows').length;
  await expect.poll(homeReads).toBe(1);
  // What macOS sends when ECHO is opened from Spotlight or Finder while it runs.
  await page.getByTestId('sidebar-project').nth(0).focus();
  await app.evaluate(({ app: electronApp }) => { electronApp.emit('activate', {}, false); });
  await expect.poll(homeReads).toBe(2);
  await expect(page.getByTestId('ask-field')).toBeFocused();
});
