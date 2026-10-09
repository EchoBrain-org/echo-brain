import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteOpenItemPeopleV1 } from '../src/adapters/persistence/sqlite/open-item-people-v1.js';
import { addMembership, OWNER, PROJECT_ALPHA as PROJECT_A, PROJECT_BETA as PROJECT_B, PROJECT_CONTEXT_NOW, projectContextDatabase, revokeMembership } from './fixtures/project-context-sqlite.js';

const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

type PersonRow = readonly [membership_id: string, name: string, status: 'active' | 'revoked'];
/** The project fixture's organization plus these employees; `grant` adds a project (created by the owner) and a role in it. */
function peopleFixture(rows: readonly PersonRow[]) {
  const db = projectContextDatabase(); opened.push(db);
  const org = OWNER.organization_id;
  const binding = (membership_id: string) => ({ organization_id: org, principal_id: `prn_${membership_id.slice(4)}`, membership_id, membership_type: 'employee' as const });
  for (const [membershipId, name, status] of rows) {
    addMembership(db, binding(membershipId), name, `${membershipId}@example.test`);
    if (status === 'revoked') revokeMembership(db, binding(membershipId));
  }
  let grants = 0;
  return {
    db, org, people: new SqliteOpenItemPeopleV1(db),
    grant(membershipId: string, projectId: string, role: 'lead' | 'member'): string {
      db.prepare(`INSERT OR IGNORE INTO authority_projects_v1 (project_id, organization_id, name, status, created_at, creator_principal_id, creator_membership_id, creator_membership_type)
        VALUES (?, ?, 'Pilot', 'active', ?, ?, ?, 'owner')`).run(projectId, org, PROJECT_CONTEXT_NOW, OWNER.principal_id, OWNER.membership_id);
      const id = `pgm_00000000-0000-4000-8000-${(++grants).toString(16).padStart(12, '0')}`;
      const who = binding(membershipId);
      db.prepare(`INSERT INTO authority_project_memberships_v1 (project_membership_id, project_id, organization_id, principal_id, membership_id, membership_type, role, status, granted_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`).run(id, projectId, org, who.principal_id, membershipId, who.membership_type, role, PROJECT_CONTEXT_NOW);
      return id;
    },
    revokeGrant(id: string) { db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked', revoked_at=? WHERE project_membership_id=?").run(PROJECT_CONTEXT_NOW, id); },
    archive(projectId: string) { db.prepare("UPDATE authority_projects_v1 SET status='archived' WHERE project_id=?").run(projectId); },
    revoke(membershipId: string) { revokeMembership(db, binding(membershipId)); },
  };
}

describe('SQLite open item people v1', () => {
  it('matches an exact name held by exactly one active member', () => {
    const f = peopleFixture([['mem_a', 'Rafael Moreno', 'active'], ['mem_b', 'Mina Patel', 'active'], ['mem_c', 'Mina  patel', 'active'], ['mem_d', 'Ari Lee', 'revoked']]);
    expect(f.people.activeByName(f.org, 'rafael moreno')).toEqual(['mem_a']);
    expect(f.people.activeByName(f.org, 'Mina Patel')).toEqual(['mem_b', 'mem_c']);   // two holders: the caller treats it as no match
    expect(f.people.activeByName(f.org, 'Ari Lee')).toEqual([]);
    expect(f.people.leadsAny('mem_a', [PROJECT_A])).toBe(false);
  });

  it('compares names after NFC, ignoring case and runs of whitespace, and only whole names', () => {
    const f = peopleFixture([['mem_a', 'Rafael Moreno', 'active'], ['mem_e', 'José Ruiz', 'active'], ['mem_f', 'S. Okafor', 'active']]);
    expect(f.people.activeByName(f.org, '  RAFAEL\t moreno\n')).toEqual(['mem_a']);
    expect(f.people.activeByName(f.org, 'José ruiz')).toEqual(['mem_e']);
    expect(f.people.activeByName(f.org, 's. okafor')).toEqual(['mem_f']);
    expect(f.people.activeByName(f.org, 'Rafael')).toEqual([]);
    expect(f.people.activeByName(f.org, '   ')).toEqual([]);
    expect(f.people.activeByName('org_other', 'Rafael Moreno')).toEqual([]);
  });

  it('reads names and whether each membership is active, within the organization', () => {
    const f = peopleFixture([['mem_a', 'Rafael Moreno', 'active'], ['mem_d', 'Ari Lee', 'revoked']]);
    expect([...f.people.people(f.org, ['mem_d', 'mem_a', 'mem_missing', 'mem_a'])]).toEqual([
      ['mem_a', { name: 'Rafael Moreno', active: true }], ['mem_d', { name: 'Ari Lee', active: false }],
    ]);
    expect(f.people.people(f.org, []).size).toBe(0);
    expect(f.people.people('org_other', ['mem_a']).size).toBe(0);
    expect(f.people.isActiveMember(f.org, 'mem_a')).toBe(true);
    expect(f.people.isActiveMember(f.org, 'mem_d')).toBe(false);
    expect(f.people.isActiveMember(f.org, 'mem_missing')).toBe(false);
    expect(f.people.isActiveMember('org_other', 'mem_a')).toBe(false);
  });

  it('counts an active lead grant of an active member only', () => {
    const f = peopleFixture([['mem_a', 'Rafael Moreno', 'active'], ['mem_b', 'Mina Patel', 'active'], ['mem_c', 'S. Okafor', 'active']]);
    const lead = f.grant('mem_a', PROJECT_A, 'lead');
    f.grant('mem_b', PROJECT_A, 'member');
    f.grant('mem_c', PROJECT_B, 'lead');
    expect(f.people.leadsAny('mem_a', [PROJECT_B, PROJECT_A])).toBe(true);
    expect(f.people.leadsAny('mem_a', [PROJECT_B])).toBe(false);
    expect(f.people.leadsAny('mem_a', [])).toBe(false);
    expect(f.people.leadsAny('mem_b', [PROJECT_A])).toBe(false);
    f.revokeGrant(lead);
    expect(f.people.leadsAny('mem_a', [PROJECT_A])).toBe(false);
    expect(f.people.leadsAny('mem_c', [PROJECT_B])).toBe(true);
    f.revoke('mem_c');
    expect(f.people.leadsAny('mem_c', [PROJECT_B])).toBe(false);
  });

  it('does not count an active lead of an archived project', () => {
    const f = peopleFixture([['mem_a', 'Rafael Moreno', 'active']]);
    f.grant('mem_a', PROJECT_A, 'lead');
    f.grant('mem_a', PROJECT_B, 'lead');
    f.archive(PROJECT_A);
    expect(f.people.leadsAny('mem_a', [PROJECT_A])).toBe(false);
    expect(f.people.leadsAny('mem_a', [PROJECT_A, PROJECT_B])).toBe(true);
  });
});
