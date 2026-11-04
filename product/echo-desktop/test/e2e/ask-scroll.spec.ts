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

/** A paragraph's location inside the reading viewport; fractional layout and scroll rounding allow one CSS pixel. */
async function offset(paragraph: Locator): Promise<number> {
  return paragraph.evaluate(element => element.getBoundingClientRect().top - element.closest('.ask')!.getBoundingClientRect().top);
}

test('a short latest answer stays in view below long history when its source opens and closes', async () => {
  run = await launch('ask-scroll');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Long readout');
  await ask(page, 'Another long readout');
  await ask(page, 'Quick status');
  const latest = page.getByTestId('turn').last();
  const bottom = () => page.getByTestId('ask-view').evaluate(view => view.scrollHeight - view.scrollTop - view.clientHeight);
  await expect.poll(bottom).toBeLessThan(1);
  const bounds = await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
  const widthBefore = await page.getByTestId('ask-view').evaluate(view => view.clientWidth);
  try {
    for (const width of [bounds.width - 100, bounds.width + 100]) {
      await run.app.evaluate(({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0]!.setBounds(next), { ...bounds, width });
      await expect.poll(() => page.getByTestId('ask-view').evaluate(view => view.clientWidth)).toBe(widthBefore + width - bounds.width);
      await expect.poll(bottom).toBeLessThan(1);
      await expect(latest.getByTestId('statement-text')).toBeInViewport();
    }
  } finally {
    await run.app.evaluate(({ BrowserWindow }, original) => BrowserWindow.getAllWindows()[0]!.setBounds(original), bounds);
  }
  await expect.poll(() => page.getByTestId('ask-view').evaluate(view => view.clientWidth)).toBe(widthBefore);
  await expect.poll(bottom).toBeLessThan(1);
  const heightBefore = await latest.evaluate(turn => turn.getBoundingClientRect().height);
  await latest.getByTestId('citation').click();
  await expect(page.getByTestId('source-pane')).toBeVisible();
  // A short answer still gains lines when narrowed; keeping its original top must not abandon the end of the thread.
  await expect.poll(() => latest.evaluate(turn => turn.getBoundingClientRect().height)).toBeGreaterThan(heightBefore);
  await expect(latest.getByTestId('question')).toBeInViewport();
  await expect(latest.getByTestId('statement-text')).toBeInViewport();
  await expect.poll(bottom).toBeLessThan(1);
  await page.getByTestId('source-close').click();
  await expect(page.getByTestId('source-pane')).toHaveCount(0);
  await expect.poll(bottom).toBeLessThan(1);
  // A source row has no sentence focus: opening that pane preserves bottom-following intent too.
  await latest.getByTestId('sources-toggle').click();
  await page.getByTestId('ask-view').evaluate(view => { view.scrollTop = view.scrollHeight; });
  await expect.poll(bottom).toBeLessThan(1);
  await latest.getByTestId('source-row').click();
  await expect(page.getByTestId('source-pane')).toBeVisible();
  await expect.poll(bottom).toBeLessThan(1);
  await page.getByTestId('source-close').click();
  await expect(page.getByTestId('source-pane')).toHaveCount(0);
  await expect.poll(bottom).toBeLessThan(1);
});

test('opening an older citation preserves its sentence rather than a different visible sentence', async () => {
  run = await launch('ask-scroll');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Long readout');
  await ask(page, 'Quick status');
  const older = page.getByTestId('turn').first();
  const sentence = older.getByTestId('statement-text').nth(7);
  await sentence.evaluate(element => {
    const view = element.closest('.ask')!;
    view.scrollTop += element.getBoundingClientRect().top - view.getBoundingClientRect().top - 180;
  });
  await expect.poll(async () => Math.abs(await offset(sentence) - 180)).toBeLessThanOrEqual(1);
  await older.getByTestId('citation').nth(7).focus();
  await older.getByTestId('citation').nth(7).press('Enter');
  await expect(page.getByTestId('source-pane')).toBeVisible();
  await expect.poll(async () => Math.abs(await offset(sentence) - 180)).toBeLessThanOrEqual(1);
  await page.getByTestId('source-close').click();
  await expect(page.getByTestId('source-pane')).toHaveCount(0);
  await expect.poll(async () => Math.abs(await offset(sentence) - 180)).toBeLessThanOrEqual(1);
  // Manually reading somewhere else replaces the citation focus even while that source stays open.
  await older.getByTestId('citation').nth(7).click();
  const other = older.getByTestId('statement-text').nth(2);
  await other.evaluate(element => {
    const view = element.closest('.ask')!;
    view.scrollTop += element.getBoundingClientRect().top - view.getBoundingClientRect().top - 24;
  });
  await expect.poll(async () => Math.abs(await offset(other) - 24)).toBeLessThanOrEqual(1);
  await page.getByTestId('source-close').click();
  await expect(page.getByTestId('source-pane')).toHaveCount(0);
  await expect.poll(async () => Math.abs(await offset(other) - 24)).toBeLessThanOrEqual(1);
});

test('a citation in a long latest answer stays readable when keeping the end would hide it', async () => {
  run = await launch('ask-scroll');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Long readout');
  const latest = page.getByTestId('turn').last();
  const bottom = () => page.getByTestId('ask-view').evaluate(view => view.scrollHeight - view.scrollTop - view.clientHeight);
  await expect.poll(bottom).toBeLessThan(1);
  // Different scrollbar widths change which sentence fits at the top of the end viewport.
  const index = await latest.getByTestId('statement-text').evaluateAll(elements => {
    const view = elements[0]!.closest('.ask')!.getBoundingClientRect();
    return elements.findIndex(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.top >= view.top && bounds.bottom <= view.bottom;
    });
  });
  expect(index).toBeGreaterThanOrEqual(0);
  const sentence = latest.getByTestId('statement-text').nth(index);
  await expect(sentence).toBeInViewport({ ratio: 1 });
  const before = await offset(sentence);
  await latest.getByTestId('citation').nth(index).click();
  await expect(page.getByTestId('source-pane')).toBeVisible();
  await expect(sentence).toBeInViewport({ ratio: 1 });
  await expect.poll(async () => Math.abs(await offset(sentence) - before)).toBeLessThanOrEqual(1);
  // The cited sentence would be above the viewport if this long answer were pinned to the end after narrowing.
  expect(await offset(sentence) - await bottom()).toBeLessThan(0);
  await page.getByTestId('source-close').click();
  await expect(page.getByTestId('source-pane')).toHaveCount(0);
  await expect(sentence).toBeInViewport({ ratio: 1 });
  await expect.poll(async () => Math.abs(await offset(sentence) - before)).toBeLessThanOrEqual(1);
});

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
    await expect.poll(async () => Math.abs(await offset(paragraph) - 24)).toBeLessThanOrEqual(1);
    const before = await offset(paragraph);
    const remainingBefore = await page.getByTestId('ask-view').evaluate(view => view.scrollHeight - view.scrollTop - view.clientHeight);
    await turn.getByTestId('citation').nth(2).click();
    await expect(page.getByTestId('source-pane')).toBeVisible();
    await expect.poll(async () => Math.abs(await offset(paragraph) - before)).toBeLessThanOrEqual(1);
    await page.getByTestId('source-close').click();
    await expect(page.getByTestId('source-pane')).toHaveCount(0);
    await expect.poll(async () => Math.abs(await offset(paragraph) - before)).toBeLessThanOrEqual(1);
    // Closing a source while reading history must not send the person to the latest turn.
    const remaining = await page.getByTestId('ask-view').evaluate(view => view.scrollHeight - view.scrollTop - view.clientHeight);
    expect(Math.abs(remaining - remainingBefore)).toBeLessThanOrEqual(1);
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
    // A manual scroll must not measure every statement in the accumulated history.
    const measurements = await page.getByTestId('ask-view').evaluate(async view => {
      const measure = Element.prototype.getBoundingClientRect;
      let count = 0;
      Element.prototype.getBoundingClientRect = function () { count += 1; return measure.call(this); };
      try {
        view.scrollTop += 40;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return count;
      } finally { Element.prototype.getBoundingClientRect = measure; }
    });
    expect(measurements).toBeLessThan(await page.getByTestId('statement-text').count() / 2);
    if (place === 'latest') {
      // A new question still takes the reader to the new answer, even with a source open.
      await turn.getByTestId('citation').nth(2).click();
      await ask(page, 'Next readout');
      await expect.poll(() => page.getByTestId('ask-view').evaluate(view => view.scrollHeight - view.scrollTop - view.clientHeight)).toBeLessThan(1);
    }
  });
}
