import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';

/** Synthetic people only. Alice overlaps both projects; Bob/Carol are disjoint. */
export const PEOPLE = Object.fromEntries(['alice', 'bob', 'carol', 'dana'].map((name, index) => [name, {
  organization_id: 'org_00000000-0000-4000-8000-000000000006',
  principal_id: `prn_00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
  membership_id: `mem_00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
  membership_type: 'employee',
}])) as Record<'alice' | 'bob' | 'carol' | 'dana', AuthorityPersonMembershipBinding>;

export const SCENARIO = {
  alpha: ['alice', 'bob'],
  beta: ['alice', 'carol'],
  unassigned: ['dana'],
  originals: {
    private: { title: 'Synthetic private context', text: 'PC06 original private meridian.' },
    team: { title: 'Synthetic team context', text: 'PC06 original team meridian.' },
    alpha: { title: 'Synthetic Alpha context', text: 'PC06 original alpha meridian.' },
    cross: { title: 'Synthetic cross context', text: 'PC06 original cross meridian.' },
  },
} as const;
