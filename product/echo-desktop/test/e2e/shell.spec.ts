import { expect, test } from '@playwright/test';
import { emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const feeds = () => run.calls().filter(call => call.path === '/v1/person/list').length;

test('the sidebar lists your projects, and one click switches project from any page', async () => {
  run = await launch();
  const { page } = run;
  const rows = page.getByTestId('sidebar-project');
  await expect(rows).toHaveText([/Apollo$/, /Beacon$/]);
  await expect(rows.nth(0)).not.toHaveAttribute('aria-current', 'page');

  await rows.nth(1).click();
  await expect(page.getByTestId('title')).toHaveText('Beacon');
  await expect(rows.nth(1)).toHaveAttribute('aria-current', 'page');
  await rows.nth(0).click();
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'page');
  await expect(rows.nth(1)).not.toHaveAttribute('aria-current', 'page');
  await expect.poll(feeds).toBe(2);

  // An answer on screen: the sidebar still switches, and the page follows.
  await page.getByTestId('ask-field').fill('What did we agree?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('answer')).toBeVisible();
  await rows.nth(1).click();
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('Beacon');
  await expect(page.getByTestId('scope-chip')).toHaveText('Beacon');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('title').getByTestId('alt-stops')).toBeVisible();
  await expect(rows.nth(1)).not.toHaveAttribute('aria-current', 'page');
  // Something in the panel reaches far below the window, as a line Ask kept for a screen reader once did.
  await page.evaluate(() => {
    const below = Object.assign(document.createElement('div'), { id: 'below' });
    below.style.cssText = 'position: absolute; top: 2000px; width: 1px; height: 1px;';
    document.querySelector('.main')!.append(below);
  });
  // A person's wheel, a script, and a scroll to bring it into view all leave the app where it is.
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, 1_000);
  await page.evaluate(() => {
    document.scrollingElement!.scrollTop = 500;
    document.body.scrollTop = 500;
    document.getElementById('below')!.scrollIntoView();
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => document.querySelector('.app')!.getBoundingClientRect().top)).toBe(0);
});

test('while another app is in front the page is covered, and the project rows stay for a drop', async () => {
  run = await launch();
  const { page, app } = run;
  await page.getByTestId('sidebar-project').nth(0).click();
  await expect(page.getByTestId('feed-row')).toBeVisible();
  await page.getByTestId('ask-field').fill('ship');
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(page.getByTestId('title')).toHaveText('ECHO');
  await expect(page.getByTestId('feed-row')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-project')).toHaveText([/Apollo$/, /Beacon$/]);
  // Nothing says which project was open, or what was typed in its bar.
  await expect(page.getByTestId('sidebar-project').nth(0)).not.toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await expect(page.getByTestId('ask-field')).toHaveAttribute('placeholder', 'Ask ECHO');
  await expect(page.getByTestId('ask-field')).toHaveValue('');
  await emit(app, 'echo-test:resume');
  await expect(page.getByTestId('concealed')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await expect(page.getByTestId('sidebar-project').nth(0)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('scope-chip')).toHaveText('Apollo');
  await expect(page.getByTestId('feed-row')).toBeVisible();
  await expect(page.getByTestId('ask-field')).toHaveValue('ship');
});

test('the bar only asks, in its scope: ✕ widens without moving the page, Return over a reader asks, Back returns to it, and Escape clears the text first', async () => {
  run = await launch();
  const { page } = run;
  const field = page.getByTestId('ask-field');
  await page.getByTestId('sidebar-project').nth(0).click();
  await expect(page.getByTestId('scope-chip')).toHaveText('Apollo');
  await expect(field).toHaveAttribute('placeholder', 'Ask Apollo');

  // ✕ widens to all context: the page stays, and the placeholder follows.
  await page.getByTestId('scope-clear').click();
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await expect(field).toHaveAttribute('placeholder', 'Ask ECHO');
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await expect(page.getByTestId('feed-row')).toHaveCount(1);

  // A row read in place stays while you type over it; Return asks the bar's scope over it, and the bar empties.
  await page.getByTestId('feed-row').click();
  await expect(page.getByTestId('reader-text')).toHaveText('We agreed to ship.');
  await field.fill('ship');
  await field.press('Enter');
  await expect(page.getByTestId('answer')).toBeVisible();
  await expect(field).toHaveValue('');
  const asks = run.calls().filter(call => call.path === '/v7/person/ask');
  expect(asks.map(call => call.body?.question)).toEqual(['ship']);
  expect(asks[0]!.body && 'project_id' in asks[0]!.body).toBe(false);
  // Back returns to the reader, then to the project.
  await expect(page.getByTestId('back')).toHaveText('Back');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('reader-text')).toHaveText('We agreed to ship.');
  await expect(page.getByTestId('back')).toHaveText('Apollo');
  await page.getByTestId('back').click();

  // Escape clears the bar's text first, and the page stays; then it steps back.
  await field.fill('apollo');
  await field.press('Escape');
  await expect(field).toHaveValue('');
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await field.press('Escape');
  await expect(page.getByTestId('title').getByTestId('alt-stops')).toBeVisible();
  // Nothing typed was searched.
  const searches = ['/v2/person/projects/context/search', '/v3/person/updates/search', '/v2/person/updates/search'];
  expect(run.calls().filter(call => searches.includes(call.path))).toEqual([]);
});

test('hidden tests ignore native window focus changes but honor explicit conceal and resume', async () => {
  run = await launch();
  const { page, app } = run;
  await page.getByTestId('sidebar-capture').click();
  await page.getByTestId('compose-body').fill('Synthetic lifecycle proof');
  await page.getByTestId('compose-send').click();
  const toast = page.getByTestId('toast');
  await expect(toast).toHaveText('Saved for you');
  expect(run.calls().filter(call => call.method === 'POST' && call.path === '/v3/person/updates')).toHaveLength(1);
  const nativeEvent = (name: 'blur' | 'focus') => app.evaluate(async ({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0]!.emit(event);
    // Exercise Linux's real 150ms blur callback before checking that the toast stays visible.
    await new Promise(resolve => setTimeout(resolve, 175));
  }, name);
  await nativeEvent('blur');
  await expect(toast).toHaveText('Saved for you');
  await emit(app, 'echo-test:conceal');
  await expect(toast).toHaveCount(0);
  await nativeEvent('focus');
  await expect(toast).toHaveCount(0);
  await emit(app, 'echo-test:resume');
  await expect(toast).toHaveText('Saved for you');
});

/**
 * Brings the window forward with the page's frames held, as a busy machine does, until the caret's move to the bar waits
 * for the next one. The returned function lets that frame come.
 */
async function forwardWithFramesHeld(): Promise<() => Promise<void>> {
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.evaluate(() => {
    const held: FrameRequestCallback[] = [];
    Object.assign(window, { held });
    window.requestAnimationFrame = callback => held.push(callback);
  });
  await emit(app, 'echo-test:conceal');
  await emit(app, 'echo-test:resume');
  await expect.poll(() => page.evaluate(() => (window as unknown as { held: FrameRequestCallback[] }).held.some(callback => String(callback).includes('ask-field')))).toBe(true);
  return () => page.evaluate(() => { for (const callback of (window as unknown as { held: FrameRequestCallback[] }).held.splice(0)) callback(performance.now()); });
}

test('the caret goes back to the bar as the window comes forward, but not over a key you press before the next frame', async () => {
  run = await launch();
  const { page } = run;
  const frame = await forwardWithFramesHeld();
  await page.keyboard.press('Tab');
  const tabbed = await page.evaluate(() => { document.activeElement?.setAttribute('data-tabbed', ''); return document.activeElement?.id ?? ''; });
  expect(tabbed).not.toBe('ask-field');
  await frame();
  await expect(page.locator('[data-tabbed]')).toBeFocused();
});

test('focus the page moves by itself before the next frame does not keep the caret from the bar', async () => {
  run = await launch();
  const { page } = run;
  const frame = await forwardWithFramesHeld();
  await page.getByTestId('sidebar-project').first().focus();
  await frame();
  await expect(page.locator('#ask-field')).toBeFocused();
});
