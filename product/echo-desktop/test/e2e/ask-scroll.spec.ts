import { expect, test, type Locator, type Page } from '@playwright/test';
import { launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

async function ask(page: Page, question: string): Promise<void> {
  await page.getByTestId('ask-field').fill(question);
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('turn').last().getByTestId('question')).toHaveText(question);
  await expect(page.getByTestId('asking')).toHaveCount(0);
}

/** A paragraph's location inside the reading viewport, independent of the window's chrome. */
async function offset(paragraph: Locator): Promise<number> {
  return paragraph.evaluate(element => element.getBoundingClientRect().top - element.closest('.ask')!.getBoundingClientRect().top);
}

for (const place of ['latest', 'earlier'] as const) {
  test(`sources and window resizing preserve the paragraph being read in the ${place} answer`, async () => {
    run = await launch('ask-scroll');
    const { page } = run;
    await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
    for (let index = 1; index <= 4; index += 1) await ask(page, `Readout ${index}`);
    const turn = page.getByTestId('turn').nth(place === 'latest' ? 3 : 1);
    const paragraph = turn.getByTestId('statement-text').nth(2);
    // Read well inside a long answer, with both earlier and later content offscreen.
    await paragraph.evaluate(element => {
      const view = element.closest('.ask')!;
      view.scrollTop += element.getBoundingClientRect().top - view.getBoundingClientRect().top - 24;
    });
    await expect.poll(() => offset(paragraph)).toBeCloseTo(24, 0);
    const before = await offset(paragraph);
    const remainingBefore = await page.getByTestId('ask-view').evaluate(view => view.scrollHeight - view.scrollTop - view.clientHeight);
    await turn.getByTestId('citation').nth(2).click();
    await expect(page.getByTestId('source-pane')).toBeVisible();
    await expect.poll(() => offset(paragraph)).toBeCloseTo(before, 0);
    await page.getByTestId('source-close').click();
    await expect(page.getByTestId('source-pane')).toHaveCount(0);
    await expect.poll(() => offset(paragraph)).toBeCloseTo(before, 0);
    // Closing a source while reading history must not send the person to the latest turn.
    const remaining = await page.getByTestId('ask-view').evaluate(view => view.scrollHeight - view.scrollTop - view.clientHeight);
    expect(remaining).toBeCloseTo(remainingBefore, 0);
    expect(remaining).toBeGreaterThan(0);
    // Native window resizing changes layout without updating Ask state, exercising the resize observer itself.
    const bounds = await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
    const widthBefore = await page.getByTestId('ask-view').evaluate(view => view.clientWidth);
    try {
      for (const width of [bounds.width - 100, bounds.width + 100]) {
        await run.app.evaluate(({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0]!.setBounds(next), { ...bounds, width });
        await expect.poll(() => page.getByTestId('ask-view').evaluate(view => view.clientWidth)).toBe(widthBefore + width - bounds.width);
        // Native resizing can round the scroll position by a fractional CSS pixel.
        await expect.poll(async () => Math.abs(await offset(paragraph) - before)).toBeLessThanOrEqual(1);
      }
    } finally {
      await run.app.evaluate(({ BrowserWindow }, original) => BrowserWindow.getAllWindows()[0]!.setBounds(original), bounds);
    }
    await expect.poll(() => page.getByTestId('ask-view').evaluate(view => view.clientWidth)).toBe(widthBefore);
    await expect.poll(async () => Math.abs(await offset(paragraph) - before)).toBeLessThanOrEqual(1);
    if (place === 'latest') {
      // A new question still takes the reader to the new answer, even with a source open.
      await turn.getByTestId('citation').nth(2).click();
      await ask(page, 'Next readout');
      await expect.poll(() => page.getByTestId('ask-view').evaluate(view => view.scrollHeight - view.scrollTop - view.clientHeight)).toBeLessThan(1);
    }
  });
}
