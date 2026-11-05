// The review badge on imported meeting notes (the 2026-10-24 intake spec, section 1.3): what a cited revision's source
// read says about review. A provider revision that changes nothing a review covers queues no card of its own, so the card
// it coalesced into reviews it; a revision with no decision or action has nothing to review and queues no card at all.
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { meetingSourceEnvelopeV1, type DecisionSet, type MeetingDocument } from '@echo-brain/organization-processing/core';
import { SqlitePersonImportedMeetingsV1 } from '../src/adapters/persistence/sqlite/person-imported-meetings-v1.js';
import { SqlitePersonOriginalContextRetrievalV1 } from '../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js';
import { SqliteSourceAdmissionStoreV1 } from '../src/adapters/persistence/sqlite/source-admission-v1.js';
import { createPersonSourceEvidenceRouteV1 } from '../src/composition/person-source-evidence-route.js';
import type { OriginalContextCitationV1 } from '../src/application/ports/person-original-context-retrieval-v1.js';
import { assertActionable, REVIEW_POLICY } from '../../../packages/organization-processing/test/admitted-meeting-processing/fixtures/sqlite-meeting-state.js';
import { approvalCoreFixture } from './fixtures/approval-core.js';
import { addMembership, authorization } from './fixtures/project-context-sqlite.js';

const GLOBAL = { kind: 'global' } as const;

/** Ari's imported fixture meeting with its card frozen and pending, and Mina, another member who imported nothing. */
async function world() {
  const f = await approvalCoreFixture();
  const organization_id = f.person.organization_id;
  const people = {
    ari: { ...f.person, membership_type: 'owner' as const },
    mina: { organization_id, principal_id: 'prn_00000000-0000-4000-8000-0000000000f1', membership_id: 'mem_00000000-0000-4000-8000-0000000000f2', membership_type: 'employee' as const },
  };
  addMembership(f.db, people.mina, 'Mina', 'mina@example.test');
  const sessions = { authenticateAccess: ({ access_token }: { readonly access_token: string }) => authorization(people[access_token as keyof typeof people]) };
  const originals = new SqlitePersonOriginalContextRetrievalV1(f.db, sessions, organization_id);
  const route = createPersonSourceEvidenceRouteV1({ originals });
  /** The citation a new answer carries: search lists each source's newest revision only. */
  const newest = (revision_id: string) => originals.deskSearch({ access_token: 'ari', scope: GLOBAL, kinds: ['imported_meeting'] }).items
    .find(item => item.citation.revision_id === revision_id)!.citation;
  let minutes = 0;
  /**
   * A later provider revision, retained and staged as processing stages it: the fixture meeting's, unless `changes` alter
   * what a review covers (its title or items) or name another meeting.
   */
  const revise = async (label: string, changes: { readonly title?: string; readonly signals?: DecisionSet['signals']; readonly meeting?: string } = {}) => {
    const base = f.first.meeting;
    const meeting: MeetingDocument = { ...base, ...(changes.meeting === undefined ? {} : { id: changes.meeting }), ...(changes.title === undefined ? {} : { title: changes.title }),
      provenance: { ...base.provenance, external_id: changes.meeting ?? base.provenance.external_id, canonical_revision: canonicalSha256(label),
        observed_at: new Date(Date.parse(base.provenance.observed_at) + ++minutes * 60_000).toISOString() } };
    new SqliteSourceAdmissionStoreV1(f.db).admit({ source: meetingSourceEnvelopeV1(meeting), scope: { organization_id,
      custody_ref: `person:${f.person.membership_id}`, access_policy_ref: `personal-meeting:${f.sourceKey}`, analysis_policy: 'automatic' } });
    const decisions: DecisionSet = { ...f.first.decisions, meeting_id: meeting.id, meeting_revision: meeting.provenance.canonical_revision,
      ...(changes.signals === undefined ? {} : { signals: changes.signals }) };
    const admission = await f.state.readAdmission();
    const candidate = await f.state.stageCandidate({ admission, meeting, decisions, review_policy: REVIEW_POLICY });
    return {
      candidate, citation: newest(meeting.provenance.canonical_revision),
      /** Freezes this revision's card, as opening it for review does. */
      freeze: () => { assertActionable(candidate); return f.core.stager.stage({ admission, candidate, meeting, decisions }); },
    };
  };
  const read = (citation: OriginalContextCitationV1, access_token = 'ari') => originals.read({ access_token, scope: GLOBAL, citation });
  const review = (citation: OriginalContextCitationV1, access_token = 'ari') => read(citation, access_token).imported_meeting_review;
  let decided = 0;
  /** Ari decides a frozen card on the desktop (the first revision's by default). */
  const decide = (action: 'approve' | 'reject', approval_id = f.approvalId) =>
    f.core.decide('desktop', f[action]({ approval_id, command_id: `${action}-${++decided}` }), () => f.session);
  const request = (citation: OriginalContextCitationV1) => ({ schema_version: 1, scope: GLOBAL, citation }) as never;
  return { ...f, people, originals, route, revise, first: newest(f.first.meeting.provenance.canonical_revision), read, review, decide, request };
}

describe('the review badge on imported meeting notes', () => {
  it('reviews a revision that changes nothing a review covers through the card it coalesced into', async () => {
    const f = await world();
    expect(f.review(f.first)).toBe('not_reviewed');
    // The provider reports a new revision while the card is pending: same title, participants and items, so no card of its own.
    const pending = await f.revise('provider update while the card is pending');
    expect(pending.candidate.disposition).toBe('coalesced');
    expect(f.review(pending.citation)).toBe('not_reviewed');
    const before = f.read(pending.citation).atom;
    expect(f.decide('approve')).toMatchObject({ kind: 'decided' });
    expect([f.review(f.first), f.review(pending.citation)]).toEqual(['reviewed', 'reviewed']);
    // Approval changes neither the label nor the cited packet.
    expect(f.read(pending.citation).atom).toEqual(before);
    // After the review, an unchanged revision has no card left to wait for: it is reviewed at once.
    const later = await f.revise('provider update after the review');
    expect(later.candidate.disposition).toBe('coalesced');
    expect(f.review(later.citation)).toBe('reviewed');
    expect(f.db.prepare(`SELECT count(*) FROM authority_live_approval_outbox_v2 o LEFT JOIN authority_approval_decisions_v1 d ON d.approval_id=o.approval_id
      WHERE d.approval_id IS NULL AND o.state<>'superseded'`).pluck().get()).toBe(0);
    // A revision that changes what a review covers waits for its own card, and so does a later one unchanged from it.
    const renamed = await f.revise('renamed', { title: 'Pilot sync (renamed)' });
    const unchanged = await f.revise('renamed, provider update', { title: 'Pilot sync (renamed)' });
    expect([renamed.candidate.disposition, unchanged.candidate.disposition]).toEqual(['actionable', 'coalesced']);
    expect([renamed, unchanged, later].map(revision => f.review(revision.citation))).toEqual(['not_reviewed', 'not_reviewed', 'reviewed']);
    await renamed.freeze();
    expect(f.decide('reject', renamed.candidate.approval_id!)).toMatchObject({ kind: 'decided' });
    expect([renamed, unchanged].map(revision => f.review(revision.citation))).toEqual(['reviewed', 'reviewed']);
  });

  it('takes its review from the card current when the revision arrived, not from an earlier card with the same items', async () => {
    const f = await world();
    f.decide('approve');
    const renamed = await f.revise('renamed', { title: 'Pilot sync (renamed)' });
    const restored = await f.revise('title restored');
    const repeated = await f.revise('title restored, provider update');
    expect([renamed, restored, repeated].map(revision => revision.candidate.disposition)).toEqual(['actionable', 'actionable', 'coalesced']);
    // The first card reviewed the same items, but the restored revision's own card, which this one coalesced into, is pending.
    expect([f.review(f.first), f.review(restored.citation), f.review(repeated.citation)]).toEqual(['reviewed', 'not_reviewed', 'not_reviewed']);
    await restored.freeze();
    f.decide('approve', restored.candidate.approval_id!);
    expect([f.review(restored.citation), f.review(repeated.citation)]).toEqual(['reviewed', 'reviewed']);
  });

  it('has nothing to review in a revision with no decision or action, and says so only to its importer, on request', async () => {
    const f = await world();
    // Another meeting whose notes hold no decision or action never gets a card.
    const discussion = await f.revise('discussion only', { meeting: 'note-discussion', signals: [] });
    const again = await f.revise('discussion only, provider update', { meeting: 'note-discussion', signals: [] });
    expect([discussion.candidate.disposition, again.candidate.disposition]).toEqual(['no_signals', 'coalesced']);
    expect([f.review(discussion.citation), f.review(again.citation)]).toEqual(['nothing_to_review', 'nothing_to_review']);
    // A reviewed meeting whose newer notes lost their decision and actions has nothing left to review; the reviewed revision stays reviewed.
    f.decide('approve');
    const emptied = await f.revise('items removed', { signals: [] });
    expect(emptied.candidate.disposition).toBe('no_signals');
    expect([f.review(f.first), f.review(emptied.citation)]).toEqual(['reviewed', 'nothing_to_review']);
    // Only a reader that opts in gets the state; an installed reader gets exactly the old keys.
    expect(f.route.readSource({ access_token: 'ari', request: f.request(again.citation), include_imported_meeting_review: true }))
      .toMatchObject({ citation: { ...again.citation, label: 'Imported meeting: Untitled' }, imported_meeting_review: 'nothing_to_review' });
    expect(Object.keys(f.route.readSource({ access_token: 'ari', request: f.request(again.citation) })).sort()).toEqual(['citation', 'kind', 'schema_version', 'scope', 'text']);
    // Another person's read is refused before any review lookup, and the lookup itself is bound to the importer.
    for (const citation of [discussion.citation, again.citation, emptied.citation]) {
      expect(() => f.review(citation, 'mina')).toThrow();
      expect(() => f.route.readSource({ access_token: 'mina', request: f.request(citation), include_imported_meeting_review: true })).toThrow();
    }
    const imported = new SqlitePersonImportedMeetingsV1(f.db);
    const row = imported.rows(authorization(f.people.ari), GLOBAL, { source_id: again.citation.source_id, revision_id: again.citation.revision_id })[0]!;
    expect(imported.reviewState(authorization(f.people.ari), row)).toBe('nothing_to_review');
    expect(imported.reviewState(authorization(f.people.mina), row)).toBe('not_reviewed');
  });
});
