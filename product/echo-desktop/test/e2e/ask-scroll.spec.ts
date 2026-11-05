import { expect, test, type Locator, type Page } from '@playwright/test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** The first of a turn's sentences wholly inside the reading viewport, by its place. */
async function firstWhole(turn: Locator): Promise<number> {
  return turn.getByTestId('statement-text').evaluateAll(elements => {
    const view = elements[0]!.closest('.ask')!.getBoundingClientRect();
    return elements.findIndex(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.top >= view.top && bounds.bottom <= view.bottom;
    });
  });
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

for (const narrower of [0, 100]) {
  test(`back at the end after an earlier citation, a latest citation keeps the end (window ${narrower}px narrower)`, async () => {
    run = await launch('ask-scroll');
    const { page } = run;
    await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
    await ask(page, 'Long readout');
    await ask(page, 'Quick status');
    const earlier = page.getByTestId('turn').first();
    const latest = page.getByTestId('turn').last();
    const bottom = () => page.getByTestId('ask-view').evaluate(view => view.scrollHeight - view.scrollTop - view.clientHeight);
    await expect.poll(bottom).toBeLessThan(1);
    if (narrower > 0) {
      const bounds = await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
      const widthBefore = await page.getByTestId('ask-view').evaluate(view => view.clientWidth);
      await run.app.evaluate(({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0]!.setBounds(next), { ...bounds, width: bounds.width - narrower });
      await expect.poll(() => page.getByTestId('ask-view').evaluate(view => view.clientWidth)).toBe(widthBefore - narrower);
      await expect.poll(bottom).toBeLessThan(1);
    }
    // From the end, an earlier turn's citation in view opens its source; closing it brings the view back to the end.
    const cited = earlier.getByTestId('citation').last();
    await expect(cited).toBeInViewport({ ratio: 1 });
    await cited.click();
    await expect(page.getByTestId('source-pane')).toBeVisible();
    await page.getByTestId('source-close').click();
    await expect(page.getByTestId('source-pane')).toHaveCount(0);
    await expect.poll(bottom).toBeLessThan(1);
    // Back at the end, the latest turn's citation keeps the end: its foot is not clipped by the narrower view.
    await latest.getByTestId('citation').click();
    await expect(page.getByTestId('source-pane')).toBeVisible();
    await expect.poll(bottom).toBeLessThan(1);
    await expect(latest.getByTestId('statement-text')).toBeInViewport({ ratio: 1 });
    await expect(latest.getByTestId('turn-foot')).toBeInViewport({ ratio: 1 });
    await page.getByTestId('source-close').click();
    await expect(page.getByTestId('source-pane')).toHaveCount(0);
    await expect.poll(bottom).toBeLessThan(1);
  });
}

test('a view a restore brings back to the end follows it again, and a latest citation chosen a little short of the end keeps it', async () => {
  run = await launch('ask-scroll');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Long readout');
  await ask(page, 'Quick status');
  const cited = page.getByTestId('turn').first().getByTestId('citation').last();
  const latest = page.getByTestId('turn').last();
  const bottom = () => page.getByTestId('ask-view').evaluate(view => view.scrollHeight - view.scrollTop - view.clientHeight);
  await expect.poll(bottom).toBeLessThan(1);
  await expect(cited).toBeInViewport({ ratio: 1 });
  await cited.click();
  await expect(page.getByTestId('source-pane')).toBeVisible();
  await page.getByTestId('source-close').click();
  await expect(page.getByTestId('source-pane')).toHaveCount(0);
  await expect.poll(bottom).toBeLessThan(1);
  // Back at the end, the view follows the end again while the earlier sentence stays in view there: a shorter window keeps the end.
  const bounds = await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
  const heightBefore = await page.getByTestId('ask-view').evaluate(view => view.clientHeight);
  try {
    await run.app.evaluate(({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0]!.setBounds(next), { ...bounds, height: bounds.height - 100 });
    await expect.poll(() => page.getByTestId('ask-view').evaluate(view => view.clientHeight)).toBe(heightBefore - 100);
    await expect.poll(bottom).toBeLessThan(1);
  } finally {
    await run.app.evaluate(({ BrowserWindow }, original) => BrowserWindow.getAllWindows()[0]!.setBounds(original), bounds);
  }
  await expect.poll(() => page.getByTestId('ask-view').evaluate(view => view.clientHeight)).toBe(heightBefore);
  await expect.poll(bottom).toBeLessThan(1);
  // A little short of the end still reads to the end. The earlier citation there returns the view to the same place, a
  // little short; the latest citation from there keeps the end.
  await page.getByTestId('ask-view').evaluate(view => { view.scrollTop -= 12; });
  await expect.poll(async () => Math.abs(await bottom() - 12)).toBeLessThanOrEqual(1);
  await expect(cited).toBeInViewport({ ratio: 1 });
  await cited.click();
  await expect(page.getByTestId('source-pane')).toBeVisible();
  await page.getByTestId('source-close').click();
  await expect(page.getByTestId('source-pane')).toHaveCount(0);
  await expect.poll(async () => Math.abs(await bottom() - 12)).toBeLessThanOrEqual(1);
  await latest.getByTestId('citation').click();
  await expect(page.getByTestId('source-pane')).toBeVisible();
  await expect.poll(bottom).toBeLessThan(1);
  await expect(latest.getByTestId('turn-foot')).toBeInViewport({ ratio: 1 });
});

for (const sidebar of [false, true]) {
  test(`a sentence a long latest answer holds stays held when the view, back at the end, narrows${sidebar ? ' after the sidebar is hidden and shown' : ''}`, async () => {
    run = await launch('ask-scroll');
    const { page } = run;
    await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
    await ask(page, 'Long readout');
    const latest = page.getByTestId('turn').last();
    const view = page.getByTestId('ask-view');
    const bottom = () => view.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
    await expect.poll(bottom).toBeLessThan(1);
    const index = await firstWhole(latest);
    expect(index).toBeGreaterThanOrEqual(0);
    const sentence = latest.getByTestId('statement-text').nth(index);
    const before = await offset(sentence);
    // Its pane would push the sentence out of view at the end, so it is held there; closing the pane brings the view back
    // to the end with it.
    await latest.getByTestId('citation').nth(index).click();
    await expect(page.getByTestId('source-pane')).toBeVisible();
    await expect.poll(async () => Math.abs(await offset(sentence) - before)).toBeLessThanOrEqual(1);
    await page.getByTestId('source-close').click();
    await expect(page.getByTestId('source-pane')).toHaveCount(0);
    await expect.poll(async () => Math.abs(await offset(sentence) - before)).toBeLessThanOrEqual(1);
    await expect.poll(bottom).toBeLessThan(1);
    if (sidebar) {
      // Wider, then as it was: the end keeps the sentence in view each time, so the view follows the end.
      for (const shown of [false, true]) {
        await page.getByTestId('sidebar-toggle').click();
        await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-pressed', String(shown));
        await expect.poll(bottom).toBeLessThan(1);
        await expect(sentence).toBeInViewport({ ratio: 1 });
      }
      await expect.poll(async () => Math.abs(await offset(sentence) - before)).toBeLessThanOrEqual(1);
    }
    // Narrower, the end would take the sentence out of view: it stays where it is held.
    const bounds = await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
    const widthBefore = await view.evaluate(element => element.clientWidth);
    try {
      await run.app.evaluate(({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0]!.setBounds(next), { ...bounds, width: bounds.width - 100 });
      await expect.poll(() => view.evaluate(element => element.clientWidth)).toBe(widthBefore - 100);
      await expect(sentence).toBeInViewport({ ratio: 1 });
      await expect.poll(async () => Math.abs(await offset(sentence) - before)).toBeLessThanOrEqual(1);
    } finally {
      await run.app.evaluate(({ BrowserWindow }, original) => BrowserWindow.getAllWindows()[0]!.setBounds(original), bounds);
    }
    await expect.poll(() => view.evaluate(element => element.clientWidth)).toBe(widthBefore);
    await expect.poll(async () => Math.abs(await offset(sentence) - before)).toBeLessThanOrEqual(1);
    await expect.poll(bottom).toBeLessThan(1);
  });
}

test('a sentence held by scrolling stays held when a wider window brings the view to the end and the window then narrows', async () => {
  run = await launch('ask-scroll');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Long readout');
  const view = page.getByTestId('ask-view');
  const bottom = () => view.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
  await expect.poll(bottom).toBeLessThan(1);
  const bounds = await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
  const widthBefore = await view.evaluate(element => element.clientWidth);
  const widen = async (by: number) => {
    await run.app.evaluate(({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0]!.setBounds(next), { ...bounds, width: bounds.width + by });
    await expect.poll(() => view.evaluate(element => element.clientWidth)).toBe(widthBefore + by);
  };
  try {
    // At the end of a window 100px wider, the first sentence that starts in view, and where it reads there.
    await widen(100);
    await expect.poll(bottom).toBeLessThan(1);
    const anchor = await view.evaluate(element => {
      const top = element.getBoundingClientRect().top;
      return [...element.querySelectorAll('[data-reading-anchor]')].find(item => item.getBoundingClientRect().top >= top)!.getAttribute('data-reading-anchor')!;
    });
    const held = view.locator(`[data-reading-anchor="${anchor}"]`);
    const at = await offset(held);
    await widen(0);
    await expect.poll(bottom).toBeLessThan(1);
    // Scrolled to read it there in the window as it was: short of the end by what the wider window takes off below it.
    await held.evaluate((element, top) => {
      const reading = element.closest('.ask')!;
      reading.scrollTop += element.getBoundingClientRect().top - reading.getBoundingClientRect().top - top;
    }, at);
    await expect.poll(async () => Math.abs(await offset(held) - at)).toBeLessThanOrEqual(1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await bottom()).toBeGreaterThanOrEqual(40);
    // Wider again, the sentence held where it is leaves nothing below the view.
    await widen(100);
    await expect.poll(async () => Math.abs(await offset(held) - at)).toBeLessThanOrEqual(1);
    await expect.poll(bottom).toBeLessThan(1);
    // Narrower than at first, the end would take the sentence out of view: it stays where it is held.
    await widen(-100);
    await expect(held).toBeInViewport({ ratio: 1 });
    await expect.poll(async () => Math.abs(await offset(held) - at)).toBeLessThanOrEqual(1);
  } finally {
    await run.app.evaluate(({ BrowserWindow }, original) => BrowserWindow.getAllWindows()[0]!.setBounds(original), bounds);
  }
});

test('rows of a question on its way follow the end under a latest citation chosen there while the end keeps its sentence in view', async () => {
  run = await launch('ask-progress');
  const { page, home } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  const view = page.getByTestId('ask-view');
  const bottom = () => view.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
  // Answers first, more than the view holds: the fixture holds each answer until the test releases it.
  for (const question of ['What did we agree?', 'Who owns pricing?', 'When is the review?', 'What is still open?', 'Who signed off?', 'What changed?']) {
    await page.getByTestId('ask-field').fill(question);
    await page.getByTestId('ask-field').press('Enter');
    writeFileSync(join(home, 'release-ask'), '');
    await expect(page.getByTestId('turn').last().getByTestId('question')).toHaveText(question);
    await expect(page.getByTestId('asking')).toHaveCount(0);
    rmSync(join(home, 'release-ask'));
  }
  await expect.poll(() => view.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100);
  // With another question on its way, the latest answer's citation, chosen at the end, opens its source beside it.
  await page.getByTestId('ask-field').fill('And the pricing?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('asking')).toBeVisible();
  await expect.poll(bottom).toBeLessThan(1);
  const latest = page.getByTestId('turn').last();
  await latest.getByTestId('citation').first().click();
  await expect(page.getByTestId('source-pane')).toBeVisible();
  await expect.poll(bottom).toBeLessThan(1);
  // Its rows, opened, come in below; the end still keeps the cited sentence wholly in view, so the view follows them.
  const line = page.getByTestId('ask-line');
  await expect(line).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });
  await line.click();
  await expect(page.getByTestId('ask-steps').getByTestId('ask-step')).toHaveCount(2);
  await expect.poll(bottom).toBeLessThan(1);
  await expect(latest.getByTestId('statement-text')).toBeInViewport({ ratio: 1 });
  writeFileSync(join(home, 'release-ask'), '');
  await expect(page.getByTestId('asking')).toHaveCount(0);
});
