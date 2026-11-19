// A follow-up an Ask answer drafted (ADR-0053), through the real person client: it shows under the answer, not sent and in
// your own list; you edit its line and date, pick its owner and send it from there, and it reads as sent, in your follow-ups
// as "From a chat". Home's Send rows list it while it waits. How each part reads is ask-follow-ups.test's and
// chat-follow-ups.test's.
import { expect, test, type Page } from '@playwright/test';
import { launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const QUESTION = 'Nobody picked up the pricing page update from Tuesday. Give it to Maya, due Friday.';

/** Asks the question; its answer comes with one draft under it. */
async function ask(page: Page) {
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('ask-field').fill(QUESTION);
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('statement-text').first()).toBeVisible();
  const card = page.getByTestId('ask-follow-up');
  await expect(card).toHaveAttribute('data-status', 'loaded');
  return card;
}

test('a draft under the answer is edited, given an owner and sent, and then reads as sent and is in your follow-ups', async () => {
  run = await launch('ask-follow-ups');
  const { page } = run;
  const card = await ask(page);
  await expect(card.getByTestId('ask-follow-up-title')).toHaveText('Update the pricing page for the new tiers');
  // The app reads this computer's calendar, so the day it runs on decides which form the due date takes; the unit tests pin each form.
  await expect(card.getByTestId('ask-follow-up-line')).toHaveText(/^From this chat · No owner yet · (Due today|Due tomorrow|(Was due|Due) Nov 20)$/u);
  // Nobody owns it yet: no Send.
  await expect(card.getByTestId('ask-follow-up-send')).toHaveCount(0);

  await card.getByTestId('ask-follow-up-edit').click();
  await card.getByTestId('edit-follow-up-line').fill('Update the pricing page for the Pro tier');
  await card.getByTestId('edit-follow-up-due').fill('2026-11-27');
  await card.getByTestId('edit-follow-up-save').click();
  await expect(card.getByTestId('ask-follow-up-said')).toHaveText('Saved');
  await expect(card.getByTestId('ask-follow-up-title')).toHaveText('Update the pricing page for the Pro tier');
  await expect(card.getByTestId('ask-follow-up-line')).toHaveText(/^From this chat · No owner yet · (Due today|Due tomorrow|(Was due|Due) Nov 27)$/u);

  // Escape closes the people picker first, and leaves Ask open.
  await card.getByRole('button', { name: /^Pick owner/u }).click();
  await expect(page.getByTestId('owner-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('owner-picker')).toHaveCount(0);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /^Pick owner/u }).click();
  await page.getByTestId('owner-picker').getByRole('option', { name: 'Maya Chen', exact: true }).click();
  await expect(card.getByTestId('ask-follow-up-said')).toHaveText('Owner changed to Maya');
  await card.getByTestId('ask-follow-up-send').click();
  await expect(card.getByTestId('ask-follow-up-said')).toHaveText('Sent to Maya');
  await expect(card).toHaveAttribute('data-state', 'open');
  await expect(card.getByTestId('ask-follow-up-line')).toHaveText(/^From this chat · Sent to Maya/u);
  await expect(card.getByTestId('ask-follow-up-send')).toHaveCount(0);

  // In your follow-ups, open, from a chat.
  await page.getByTestId('sidebar-follow-ups').click();
  const row = page.getByTestId('follow-up-row').filter({ hasText: 'Update the pricing page for the Pro tier' });
  await expect(row).toHaveAttribute('data-state', 'open');
  await expect(row.getByTestId('follow-up-from')).toHaveText('From a chat');
});

test('Home lists a draft as a Send row while it waits, which opens its page', async () => {
  run = await launch('ask-follow-ups');
  const { page } = run;
  await ask(page);
  await page.keyboard.press('Escape');
  const row = page.getByTestId('need-row').filter({ hasText: 'Update the pricing page for the new tiers' });
  await expect(row).toHaveAttribute('data-kind', 'send');
  await expect(row).toContainText('From a chat · No owner yet');
  await row.click();
  await expect(page.getByTestId('follow-up')).toContainText('Follow-up · From a chat');
  await expect(page.getByTestId('follow-up')).toContainText('Pick an owner to send it');
});
