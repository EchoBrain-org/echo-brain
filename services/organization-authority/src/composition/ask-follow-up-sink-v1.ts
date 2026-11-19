import { ASK_FOLLOW_UP_ABOUT_KINDS_V1, askFollowUpPointerV1, type AskFollowUpDraftV1, type AskFollowUpSinkV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { impactItemKeyV1 } from '@echo-brain/organization-authority-kernel/answer-composition/renderers/impact-card-storage-v1';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import type { ImpactChatItemDraftV1, SqliteImpactItemsV1 } from '../adapters/persistence/sqlite/impact-items-v1.js';
import { activeMemberNamedV1, type ImpactOwnerPeopleV1 } from './impact-owner-matching-v1.js';

export interface CreateAskFollowUpSinksV1Options {
  readonly items: Pick<SqliteImpactItemsV1, 'insertForAsk'>;
  /** ECHO's member directory, as impact owner matching reads it. */
  readonly people: Pick<ImpactOwnerPeopleV1, 'activeByName'>;
}

/**
 * Where a released Ask answer's follow-ups are saved (ADR-0053): each one as
 * the asker's own unsent follow-up, in one transaction. Its owner is the one
 * active member whose display name is the name the writer gave, matched as
 * impact owner matching matches a name; none or more than one leaves it with
 * the asker, unowned (`approver`), to pick before sending. It points at the one
 * item it is about when that pointer names an item, else at itself. Nothing
 * here decides whether to save: the caller hands over only a released
 * answer's checked drafts.
 */
export function createAskFollowUpSinksV1(options: CreateAskFollowUpSinksV1Options): (asker: PersonAccessAuthorization) => AskFollowUpSinkV1 {
  return asker => Object.freeze({
    save(drafts: readonly AskFollowUpDraftV1[]): void {
      if (drafts.length === 0) return;
      let named: ((name: string) => readonly string[]) | undefined;
      const ownerOf = (name: string | undefined): Pick<ImpactChatItemDraftV1, 'owner_membership_id' | 'owner_match'> => {
        const member = activeMemberNamedV1(wanted => (named ??= options.people.activeByName(asker.organization_id))(wanted), name);
        return member === undefined ? { owner_membership_id: asker.membership_id, owner_match: 'approver' } : { owner_membership_id: member, owner_match: 'name' };
      };
      const rows = drafts.map((draft): ImpactChatItemDraftV1 => {
        const kind = draft.about?.kind;
        const about = typeof kind === 'string' && ASK_FOLLOW_UP_ABOUT_KINDS_V1.includes(kind) ? draft.about : undefined;
        const aboutKey = about === undefined ? undefined : impactItemKeyV1(about);
        const pointer = about !== undefined && aboutKey !== undefined ? about : askFollowUpPointerV1(draft.item_id);
        const item_key = aboutKey ?? impactItemKeyV1(pointer);
        if (item_key === undefined) throw new TypeError('An Ask follow-up needs an item key');
        return Object.freeze({
          item_id: draft.item_id, item_key, pointer, expected: draft.task, due_on: draft.due_on ?? null, ...ownerOf(draft.owner_name),
        });
      });
      options.items.insertForAsk({ organization_id: asker.organization_id, principal_id: asker.principal_id, membership_id: asker.membership_id }, rows);
    },
  });
}
