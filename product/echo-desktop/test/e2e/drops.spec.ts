import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const uploads = () => run.calls().filter(call => call.method === 'PUT' && call.path.startsWith('/v2/person/documents/'));

/** A new file on disk, like one in Finder. */
function onDisk(name: string, text = 'Annual pricing.'): string {
  const folder = mkdtempSync(join(tmpdir(), 'echo-drop-'));
  folders.push(folder);
  const file = join(folder, name);
  writeFileSync(file, text);
  return file;
}

/**
 * Drops one file on a target, as a drag from Finder does. Playwright cannot
 * drag from the desktop, so a hidden file input makes a File with a real path
 * on disk; `null` drops a file made in the page, which has none.
 */
async function drop(page: Page, target: Locator, path: string | null): Promise<void> {
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  if (path) {
    await page.evaluate(() => {
      const input = Object.assign(document.createElement('input'), { type: 'file', id: 'drop-source', hidden: true });
      document.body.append(input);
    });
    await page.setInputFiles('#drop-source', path);
    await page.evaluate(dataTransfer => {
      const input = document.getElementById('drop-source') as HTMLInputElement;
      dataTransfer.items.add(input.files![0]!);
      input.remove();
    }, transfer);
  } else {
    await page.evaluate(dataTransfer => { dataTransfer.items.add(new File(['made in the page'], 'Made.txt', { type: 'text/plain' })); }, transfer);
  }
  await target.dispatchEvent('dragover', { dataTransfer: transfer });
  await target.dispatchEvent('drop', { dataTransfer: transfer });
}

test('a file dropped on a sidebar project, with another app in front, is captured into that project', async () => {
  run = await launch();
  const { page, app } = run;
  await page.getByTestId('sidebar-project').nth(0).click();
  await expect(page.getByTestId('feed-row')).toBeVisible();
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await drop(page, page.getByTestId('sidebar-project').nth(1), onDisk('Brief.md'));
  await expect(page.getByTestId('compose-file')).toHaveText('Brief.md · 15 bytes');
  await expect(page.getByTestId('readers-project')).toHaveText('Beacon');
  await expect(page.getByTestId('readers-project')).toHaveAttribute('aria-pressed', 'true');
  // Ready for ⌘↩ once ECHO is in front.
  await expect(page.getByTestId('compose')).toBeFocused();
  await emit(app, 'echo-test:resume');
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByTestId('toast')).toHaveText('Saved to Beacon · Extracting text');
  expect(uploads()).toHaveLength(1);
  expect(uploads()[0]!.body).toMatchObject({
    title: 'Brief.md', filename: 'Brief.md', audience: { kind: 'project', project_id: BEACON }, association_project_ids: [BEACON],
  });
  // The drop went through main's own channel, and the log holds no path.
  const log = readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8');
  expect(log).toContain('drop ok');
  expect(log).not.toContain('echo-drop-');
});

test('Home rows take a drop while another app is in front, and a file dropped on the sheet keeps who can read it', async () => {
  run = await launch();
  const { page, app } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await drop(page, page.getByTestId('project-row').nth(0), onDisk('Pricing.txt'));
  await expect(page.getByTestId('readers-project')).toHaveText('Apollo');
  await expect(page.getByTestId('readers-project')).toHaveAttribute('aria-pressed', 'true');
  await emit(app, 'echo-test:resume');
  await page.getByTestId('readers-team').click();
  await drop(page, page.getByTestId('compose'), onDisk('Terms.pdf', 'Payment in 30 days.'));
  await expect(page.getByTestId('compose-file')).toHaveText('Terms.pdf · 19 bytes');
  await expect(page.getByTestId('readers-team')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('compose-readers')).toHaveText('Everyone in your org can read this.');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Shared with your organization · Extracting text');
  expect(uploads()).toHaveLength(1);
  expect(uploads()[0]!.body).toMatchObject({ title: 'Terms.pdf', audience: { kind: 'team' }, association_project_ids: [APOLLO] });
});

test('a drop never changes a draft with words in it, or a save not yet settled', async () => {
  run = await launch('write-unavailable');
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Half a thought');
  // Words dragged in are not a file: the note takes them as usual.
  const taken = await page.getByTestId('compose-body').evaluate(body => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', 'dragged words');
    const event = new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true });
    body.dispatchEvent(event);
    return !event.defaultPrevented;
  });
  expect(taken).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('compose')).toHaveCount(0);
  await drop(page, page.getByTestId('sidebar-project').nth(1), onDisk('Brief.md'));
  await expect(page.getByTestId('compose-body')).toHaveValue('Half a thought');
  await expect(page.getByTestId('compose-notice')).toHaveText('The file was not attached. Save this note first.');
  await expect(page.getByTestId('readers-only-me')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('readers-project')).toHaveCount(0);
  await expect(page.getByTestId('compose-file')).toHaveCount(0);

  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('compose-unresolved')).toBeVisible();
  await drop(page, page.getByTestId('compose'), onDisk('Brief.md'));
  await expect(page.getByTestId('compose-notice')).toHaveText('The file was not attached.');
  await expect(page.getByTestId('compose-body')).toHaveValue('Half a thought');
  await expect(page.getByTestId('compose-unresolved')).toBeVisible();
  expect(uploads()).toHaveLength(0);
});

test('a drop main cannot vouch for is refused: a file made in the page, or a link', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await drop(page, page.getByTestId('project-row').nth(0), null);
  await expect(page.getByTestId('compose-notice')).toHaveText('Choose a TXT, Markdown, PDF or Word file up to 25 MB.');
  await expect(page.getByTestId('compose-file')).toHaveCount(0);
  await expect(page.getByTestId('readers-project')).toHaveText('Apollo');

  const link = join(mkdtempSync(join(tmpdir(), 'echo-drop-')), 'Link.txt');
  folders.push(join(link, '..'));
  symlinkSync(onDisk('Real.txt'), link);
  await drop(page, page.getByTestId('compose'), link);
  await expect(page.getByTestId('compose-notice')).toHaveText('Choose a TXT, Markdown, PDF or Word file up to 25 MB.');
  await expect(page.getByTestId('compose-file')).toHaveCount(0);
  expect(readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8').match(/drop unsupported_file/g)).toHaveLength(2);
});
