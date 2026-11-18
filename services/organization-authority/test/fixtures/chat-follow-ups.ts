import { askFollowUpItemIdV1, type AskFollowUpDraftV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import type { PersonRunsResultsV1 } from '@echo-brain/organization-api';
import { createAskFollowUpSinksV1 } from '../../src/composition/ask-follow-up-sink-v1.js';
import { CLOUD, openItemsFixture, type FixturePerson } from './open-items.js';

/**
 * Follow-ups from a chat (ADR-0053) with no meeting behind them, over the
 * open-items fixture's people and real Authority V17 database: Ari, Mina
 * Patel, Rafael Moreno (project A) and S. Okafor (outside it). An Ask answer's
 * drafts are saved through the asker's sink, exactly as the Ask route will
 * save a released answer's. The fixture's meeting is approved but its impact
 * check never finishes unless a test calls `finishImpactRun`, so no meeting
 * follow-up exists beside the chat ones.
 */
export async function chatFollowUpsFixture() {
  const f = await openItemsFixture();
  const sinks = createAskFollowUpSinksV1({ items: f.items, people: f.directory });
  const authorization = (name: FixturePerson) => f.openItemsOptions.sessions.authenticateAccess({ access_token: name });
  /** The ticket the fixture's Jira opens, as a stored pointer an answer may be about. */
  const ticket = Object.freeze({ kind: 'ticket', tool_id: 'jira', external_scope_id: CLOUD, ticket_id: '10012', permalink: 'https://echo-fixture.atlassian.net/browse/ECHO-12' });
  let requests = 0;
  /** Saves one Ask answer's drafts as `name`'s; each id is fixed by the answer's request and the draft's place. */
  const draft = (name: FixturePerson, drafts: readonly Omit<AskFollowUpDraftV1, 'item_id'>[], request = `ask-request-${String(requests += 1)}`): string[] => {
    const ids = drafts.map((_, ordinal) => askFollowUpItemIdV1(request, ordinal));
    sinks(authorization(name)).save(drafts.map((entry, ordinal) => ({ ...entry, item_id: ids[ordinal]! })));
    return ids;
  };
  const sendItem = (name: FixturePerson, item_id: string, include: boolean, extra: { readonly command_id?: string; readonly owner?: FixturePerson } = {}):
    Promise<PersonRunsResultsV1['send_item']> => f.app.send_item({ access_token: name, request: {
    schema_version: 1, operation: 'send_item', item_id, command_id: extra.command_id ?? `send-${item_id}`, include,
    ...(extra.owner === undefined ? {} : { owner_membership_id: f.membership(extra.owner) }) } });
  const edit = (name: FixturePerson, item_id: string, change: { readonly expected?: string; readonly due_on?: string | null }) =>
    f.app.edit({ access_token: name, request: { schema_version: 1, operation: 'edit', item_id, ...change } });
  const item = (name: FixturePerson, item_id: string) => f.app.item({ access_token: name, request: { schema_version: 1, operation: 'item', item_id } }).then(value => value.item);
  const mine = (name: FixturePerson) => f.app.items({ access_token: name, request: { schema_version: 1, operation: 'items', scope: 'mine' } });
  return { ...f, sinks, authorization, ticket, draft, sendItem, edit, item, mine };
}
export type ChatFollowUpsFixtureV1 = Awaited<ReturnType<typeof chatFollowUpsFixture>>;
