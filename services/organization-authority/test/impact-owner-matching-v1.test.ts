import { describe, expect, it, vi } from 'vitest';
import type { JiraOwnerAccountsV1 } from '../src/application/ports/jira-owner-accounts-v1.js';
import { matchImpactOwnersV1, type ImpactOwnerPeopleV1 } from '../src/composition/impact-owner-matching-v1.js';

type Person = { readonly organization_id: string; readonly principal_id: string; readonly membership_id: string };
const CLOUD = '00000000-0000-4000-8000-000000000007';
const OTHER_CLOUD = '00000000-0000-4000-8000-000000000008';
const ARI = { organization_id: 'org_fixture', membership_id: 'mem_ari' };
const MINA: Person = { organization_id: 'org_fixture', principal_id: 'prn_mina', membership_id: 'mem_mina' };
const RAFAEL: Person = { organization_id: 'org_fixture', principal_id: 'prn_rafael', membership_id: 'mem_rafael' };
const APPROVER = { owner_membership_id: ARI.membership_id, owner_match: 'approver' };
const digest = (hex: string) => `sha256:${hex.repeat(64)}`;

const ticket = (ticket_id: string, external_scope_id = CLOUD, tool_id = 'jira') => ({ kind: 'ticket', tool_id, external_scope_id, ticket_id,
  permalink: 'https://echo-fixture.atlassian.net/browse/ECHO-12', text_sha256: digest('1') });
const record = () => ({ kind: 'approved_record', atom_id: digest('2'), record_sha256: digest('3'), policy_id: 'organization-member-readable-person-v2' });
const document = () => ({ kind: 'source_revision', source_id: 'source:fixture', revision_id: 'revision-1', source_sha256: digest('4'),
  representation_sha256: digest('5'), anchor_sha256: digest('6') });
const page = () => ({ kind: 'page', tool_id: 'confluence', external_scope_id: CLOUD, page_id: '200', section_id: 'section-1', version: '3',
  permalink: 'https://echo-fixture.atlassian.net/wiki/spaces/ECHO/pages/200', text_sha256: digest('7') });
const slack = () => ({ kind: 'slack_message', team_id: 'T0FIXTURE', channel_id: 'C0FIXTURE', message_ts: '1760000000.000100' });

function fakeJira(options: { readonly assignees: ReadonlyMap<string, string> | Error; readonly people: Readonly<Record<string, readonly Person[]>> }) {
  return {
    cloud_id: CLOUD,
    assignees: vi.fn(async (_input: { readonly access_token: string; readonly ticket_ids: readonly string[]; readonly signal?: AbortSignal }) => {
      if (options.assignees instanceof Error) throw options.assignees;
      return options.assignees;
    }),
    people: vi.fn((accountId: string) => options.people[accountId] ?? []),
  } satisfies JiraOwnerAccountsV1;
}

/** ECHO's directory: active members by exact display name; `inactive` memberships have left. */
function people(byName: Readonly<Record<string, readonly string[]>>, inactive: readonly string[] = []): ImpactOwnerPeopleV1 {
  return {
    activeByName: (organizationId, name) => (organizationId === ARI.organization_id ? byName[name] ?? [] : []),
    isActiveMember: (organizationId, membershipId) => organizationId === ARI.organization_id && !inactive.includes(membershipId),
  };
}

describe('impact owner matching', () => {
  it('matches a Jira assignee by connected account and an ECHO action owner by unique name', async () => {
    const jira = fakeJira({ assignees: new Map([['10046', 'acct-mina']]), people: { 'acct-mina': [MINA] } });
    const result = await matchImpactOwnersV1({ candidates: [
      { pointer: ticket('10046'), owner_name: 'Mina Patel' },
      { pointer: record(), owner_name: 'Rafael Moreno' },
      { pointer: page(), owner_name: 'Someone' },
      { pointer: ticket('10047'), owner_name: 'Rafael Moreno' },
    ], approver: ARI, access_token: 'tok', people: people({ 'Rafael Moreno': ['mem_rafael'] }), jira });
    expect(result).toEqual([
      { owner_membership_id: MINA.membership_id, owner_match: 'jira_account' },
      { owner_membership_id: 'mem_rafael', owner_match: 'name' },
      { owner_membership_id: ARI.membership_id, owner_match: 'approver' },
      { owner_membership_id: ARI.membership_id, owner_match: 'approver' },
    ]);
    // One bulk read, with the approver's own session, for the tickets on the runtime's site.
    expect(jira.assignees).toHaveBeenCalledTimes(1);
    expect(jira.assignees).toHaveBeenCalledWith({ access_token: 'tok', ticket_ids: ['10046', '10047'] });
  });

  it('falls back to the approver for a shared name, another organization, an inactive member, another site and a failed read', async () => {
    const elsewhere: Person = { organization_id: 'org_other', principal_id: 'prn_other', membership_id: 'mem_other' };
    const gone: Person = { organization_id: 'org_fixture', principal_id: 'prn_gone', membership_id: 'mem_gone' };
    const directory = people({ 'Mina Patel': ['mem_mina', 'mem_mina_2'], 'Rafael Moreno': ['mem_rafael'] }, ['mem_gone']);
    const jira = fakeJira({
      assignees: new Map([['10046', 'acct-other'], ['10047', 'acct-gone'], ['10048', 'acct-mina'], ['10049', 'acct-shared']]),
      people: { 'acct-other': [elsewhere], 'acct-gone': [gone], 'acct-mina': [MINA], 'acct-shared': [MINA, RAFAEL] },
    });
    expect(await matchImpactOwnersV1({ candidates: [
      { pointer: record(), owner_name: 'Mina Patel' },
      { pointer: ticket('10046') },
      { pointer: ticket('10047') },
      { pointer: ticket('10048', OTHER_CLOUD) },
      { pointer: ticket('10049') },
    ], approver: ARI, access_token: 'tok', people: directory, jira })).toEqual([APPROVER, APPROVER, APPROVER, APPROVER, APPROVER]);
    expect(jira.assignees).toHaveBeenCalledWith({ access_token: 'tok', ticket_ids: ['10046', '10047', '10049'] });

    const failed = fakeJira({ assignees: new Error('Jira is unavailable'), people: { 'acct-mina': [MINA] } });
    expect(await matchImpactOwnersV1({ candidates: [{ pointer: ticket('10046') }, { pointer: record(), owner_name: 'Rafael Moreno' }],
      approver: ARI, access_token: 'tok', people: directory, jira: failed })).toEqual([APPROVER, { owner_membership_id: 'mem_rafael', owner_match: 'name' }]);
    const brokenStore = { ...fakeJira({ assignees: new Map([['10046', 'acct-mina']]), people: {} }), people: () => { throw new Error('connection store is unavailable'); } };
    const brokenDirectory: ImpactOwnerPeopleV1 = {
      activeByName: () => { throw new Error('directory is unavailable'); },
      isActiveMember: () => { throw new Error('directory is unavailable'); },
    };
    expect(await matchImpactOwnersV1({ candidates: [{ pointer: ticket('10046') }, { pointer: record(), owner_name: 'Rafael Moreno' }],
      approver: ARI, access_token: 'tok', people: directory, jira: brokenStore })).toEqual([APPROVER, { owner_membership_id: 'mem_rafael', owner_match: 'name' }]);
    expect(await matchImpactOwnersV1({ candidates: [{ pointer: ticket('10046') }, { pointer: record(), owner_name: 'Rafael Moreno' }],
      approver: ARI, access_token: 'tok', people: brokenDirectory, jira: fakeJira({ assignees: new Map([['10046', 'acct-mina']]), people: { 'acct-mina': [MINA] } }) }))
      .toEqual([APPROVER, APPROVER]);
  });

  it('matches an ECHO document action by name and leaves every other item with the approver', async () => {
    const directory = people({ 'Rafael Moreno': ['mem_rafael'] });
    // Without a Jira runtime a ticket has no account to match, and is never matched by name.
    expect(await matchImpactOwnersV1({ candidates: [
      { pointer: document(), owner_name: 'Rafael Moreno' },
      { pointer: slack(), owner_name: 'Rafael Moreno' },
      { pointer: ticket('10046', CLOUD, 'linear'), owner_name: 'Rafael Moreno' },
      { pointer: ticket('10046'), owner_name: 'Rafael Moreno' },
      { pointer: record() },
      { pointer: record(), owner_name: ' ' },
      { pointer: {}, owner_name: 'Rafael Moreno' },
    ], approver: ARI, access_token: 'tok', people: directory })).toEqual([
      { owner_membership_id: 'mem_rafael', owner_match: 'name' },
      APPROVER, APPROVER, APPROVER, APPROVER, APPROVER, APPROVER,
    ]);
    // No ticket on the runtime's site: no Jira read at all.
    const jira = fakeJira({ assignees: new Map(), people: {} });
    await matchImpactOwnersV1({ candidates: [{ pointer: record(), owner_name: 'Rafael Moreno' }, { pointer: ticket('10046', OTHER_CLOUD) }], approver: ARI, access_token: 'tok', people: directory, jira });
    expect(jira.assignees).not.toHaveBeenCalled();
  });
});
