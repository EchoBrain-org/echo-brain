import { expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { CLOUD, openItemsFixture } from './fixtures/open-items.js';

it('keeps a newly assigned item in the notification read even with twenty changed items', async () => {
  const f = await openItemsFixture();
  await f.finishImpactRun();
  const run = f.runs.read(f.person, f.runId)!;
  const draft = (index: number) => ({
    item_key: canonicalSha256(`pr325-review-${index}`), relation: 'needs_updating' as const,
    expected: 'Update the release checklist', owner_membership_id: f.membership('mina'), owner_match: 'jira_account' as const,
    pointer: { kind: 'ticket', tool_id: 'jira', external_scope_id: CLOUD, ticket_id: String(90000 + index),
      permalink: `https://echo-fixture.atlassian.net/browse/ECHO-${90000 + index}`, text_sha256: canonicalSha256(`text-${index}`) },
  });
  f.advance(1000);
  f.db.transaction(() => f.items.insertForRun(f.db, run, Array.from({ length: 20 }, (_, index) => draft(index))))();
  const older = f.items.forRun(f.runId).filter(row => row.pointer.kind === 'ticket' && Number(row.pointer.ticket_id) >= 90000);
  f.items.send({ run_id: f.runId, by: f.membership('ari'), command_id: 'review-older', choices: older.map(row => ({ item_id: row.item_id, include: true })) });
  for (const row of older) f.check(row.item_id, 'changed');
  f.advance(1000);
  f.db.transaction(() => f.items.insertForRun(f.db, run, [draft(99)]))();
  const fresh = f.items.forRun(f.runId).find(row => row.pointer.ticket_id === '90099')!;
  f.items.send({ run_id: f.runId, by: f.membership('ari'), command_id: 'review-fresh', choices: [{ item_id: fresh.item_id, include: true }] });
  const home = await f.app.home({ access_token: 'mina', request: { schema_version: 1, operation: 'home', read: 'rows' } });
  expect(home.items.map(row => row.item_id)).toContain(fresh.item_id);
});
