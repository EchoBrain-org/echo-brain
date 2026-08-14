import { describe, expect, it } from 'vitest';
import type { ReadableSearchAdmittedAtom } from '@echo-brain/organization-retrieval/build';
import type { RetrievalBuildBatch } from '@echo-brain/organization-record/retrieval-build';
import { readableSearchUpstreamInputRoot } from '../src/composition/readable-search-layer1.js';

const digest = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;

const fact: ReadableSearchAdmittedAtom['fact'] = Object.freeze({
  atom_id: digest('a'), organization_id: 'org_test', envelope_sha256: digest('b'),
  log_position: 2, record_hash: digest('c'), atom_order: 0,
  signal_id_sha256: digest('d'), item_kind: 'decision',
  policy_id: 'restricted-reviewer-v1', policy_contract_sha256: digest('e'),
  approval_actor_principal_id: 'prn_test', approval_actor_membership_id: 'mem_test',
  reviewer_principal_id: 'prn_test', reviewer_membership_id: 'mem_test',
  release_draft_sha256: digest('f'), approval_presentation_sha256: digest('0'),
  semantic_intent_sha256: digest('1'), message_presentation_sha256: digest('2'),
  authorization_audit_event_id: 'aud_test', authorization_audit_entry_sha256: digest('3'),
  evaluated_at: '2026-08-14T00:00:00.000Z', authorization_proof_sha256: digest('4'),
  content_binding_sha256: digest('5'), provenance_binding_sha256: digest('6'),
});

const atom: ReadableSearchAdmittedAtom = Object.freeze({
  fact,
  text: 'This must never enter the Layer 1 root.',
  text_sha256: digest('7'),
});

const memberFact: ReadableSearchAdmittedAtom['fact'] = Object.freeze({
  ...fact,
  atom_id: digest('8'), envelope_sha256: digest('9'), log_position: 3,
  record_hash: digest('0'), signal_id_sha256: digest('1'),
  policy_id: 'organization-member-readable-v1', policy_contract_sha256: digest('2'),
  approval_actor_principal_id: 'prn_member', approval_actor_membership_id: 'mem_member',
  reviewer_principal_id: null, reviewer_membership_id: null,
  authorization_audit_event_id: 'aud_member', authorization_audit_entry_sha256: digest('3'),
  content_binding_sha256: digest('4'), provenance_binding_sha256: digest('5'),
});

const memberAtom: ReadableSearchAdmittedAtom = Object.freeze({
  fact: memberFact,
  text: 'Member text must also remain outside the Layer 1 root.',
  text_sha256: digest('6'),
});

function batch(rows: RetrievalBuildBatch['row_classifications']): RetrievalBuildBatch {
  const last = rows.at(-1);
  return Object.freeze({
    record_head: {
      position: last?.log_position ?? 0,
      record_hash: last?.record_hash ?? null,
    },
    row_classifications: rows,
    reviewer_items: [],
    organization_member_items: [],
  });
}

describe('readable-search dense Layer 1 input root', () => {
  it('has stable empty and mixed/excluded goldens, with only family-neutral fact keys', () => {
    const empty = readableSearchUpstreamInputRoot({
      organization_id: 'org_test', batch: batch([]), atoms: [],
    });
    expect(empty.preimage).toMatchObject({
      kind: 'readable-search-upstream-input-root-v1',
      input_contract_version: 1,
      rows: [],
    });
    expect(empty.upstream_input_root).toBe(
      'sha256:6eddfdb8cf38a92e7b8208c456f81b0116901b3e5689edec330569fc6bac6aa5',
    );

    const mixedBatch = batch(Object.freeze([
      Object.freeze({
        classification: 'legacy-schema-v1-excluded' as const,
        log_position: 1, record_hash: digest('8'), envelope_sha256: digest('9'), items: Object.freeze([] as const),
      }),
      Object.freeze({
        classification: 'restricted-reviewer-v2-admitted' as const,
        log_position: 2, record_hash: digest('c'), envelope_sha256: digest('b'),
      }),
    ]));
    const mixed = readableSearchUpstreamInputRoot({
      organization_id: 'org_test', batch: mixedBatch, atoms: [atom],
    });
    expect(mixed.upstream_input_root).toBe(
      'sha256:662de91b3aee129d510821c8c5336c488306a01f317bed29a53ca8c76184a182',
    );
    expect(mixed.preimage.rows.map((row) => row.classification)).toEqual([
      'legacy-schema-v1-excluded',
      'restricted-reviewer-v2-admitted',
    ]);
    expect(mixed.preimage.rows[0]?.items).toEqual([]);
    expect(Object.keys(mixed.preimage.rows[1]!.items[0]!).sort()).toEqual([
      'approval_actor_membership_id', 'approval_actor_principal_id',
      'approval_presentation_sha256', 'atom_id', 'atom_order',
      'authorization_audit_entry_sha256', 'authorization_audit_event_id',
      'authorization_proof_sha256', 'content_binding_sha256', 'envelope_sha256',
      'evaluated_at', 'item_kind', 'log_position', 'message_presentation_sha256',
      'organization_id', 'policy_contract_sha256', 'policy_id',
      'provenance_binding_sha256', 'record_hash', 'release_draft_sha256',
      'reviewer_membership_id', 'reviewer_principal_id', 'semantic_intent_sha256',
      'signal_id_sha256',
    ]);
    expect(JSON.stringify(mixed.preimage)).not.toContain(atom.text);
  });

  it('changes when a dense classification or fact binding changes and rejects an unclassified fact', () => {
    const source = batch(Object.freeze([
      Object.freeze({
        classification: 'legacy-schema-v1-excluded' as const,
        log_position: 1, record_hash: digest('8'), envelope_sha256: digest('9'), items: Object.freeze([] as const),
      }),
      Object.freeze({
        classification: 'restricted-reviewer-v2-admitted' as const,
        log_position: 2, record_hash: digest('c'), envelope_sha256: digest('b'),
      }),
    ]));
    const root = readableSearchUpstreamInputRoot({ organization_id: 'org_test', batch: source, atoms: [atom] });
    const changed = readableSearchUpstreamInputRoot({
      organization_id: 'org_test',
      batch: source,
      atoms: [Object.freeze({ ...atom, fact: Object.freeze({ ...fact, semantic_intent_sha256: digest('f') }) })],
    });
    expect(changed.upstream_input_root).not.toBe(root.upstream_input_root);
    const changedExcludedRow = readableSearchUpstreamInputRoot({
      organization_id: 'org_test',
      batch: batch(Object.freeze([
        Object.freeze({
          classification: 'legacy-schema-v1-excluded' as const,
          log_position: 1, record_hash: digest('7'), envelope_sha256: digest('9'), items: Object.freeze([] as const),
        }),
        source.row_classifications[1]!,
      ])),
      atoms: [atom],
    });
    expect(changedExcludedRow.upstream_input_root).not.toBe(root.upstream_input_root);
    expect(() => readableSearchUpstreamInputRoot({
      organization_id: 'org_test',
      batch: batch(Object.freeze([
        source.row_classifications[0]!,
        Object.freeze({ classification: 'legacy-schema-v1-excluded' as const, log_position: 2, record_hash: digest('c'), envelope_sha256: digest('b'), items: Object.freeze([] as const) }),
      ])),
      atoms: [atom],
    })).toThrow(/legacy Layer 1 row/);
    expect(() => readableSearchUpstreamInputRoot({
      organization_id: 'another_org',
      batch: source,
      atoms: [atom],
    })).toThrow(/does not bind exact retrieval facts/);
    expect(() => readableSearchUpstreamInputRoot({
      organization_id: 'org_test',
      batch: batch(Object.freeze([...source.row_classifications].reverse())),
      atoms: [atom],
    })).toThrow(/densely cover/);
    const factWithRuntimeExtra = Object.freeze({
      ...fact,
      undeclared: 'must not enter the Layer 1 root',
    });
    expect(() => readableSearchUpstreamInputRoot({
      organization_id: 'org_test',
      batch: source,
      atoms: [Object.freeze({ ...atom, fact: factWithRuntimeExtra })],
    })).toThrow(/unexpected shape/);
  });

  it('freezes the mixed reviewer and member family-neutral fact preimage', () => {
    const source = batch(Object.freeze([
      Object.freeze({
        classification: 'legacy-schema-v1-excluded' as const,
        log_position: 1, record_hash: digest('7'), envelope_sha256: digest('8'), items: Object.freeze([] as const),
      }),
      Object.freeze({
        classification: 'restricted-reviewer-v2-admitted' as const,
        log_position: 2, record_hash: digest('c'), envelope_sha256: digest('b'),
      }),
      Object.freeze({
        classification: 'organization-member-readable-v3-admitted' as const,
        log_position: 3, record_hash: digest('0'), envelope_sha256: digest('9'),
      }),
    ]));
    const mixed = readableSearchUpstreamInputRoot({
      organization_id: 'org_test',
      batch: source,
      atoms: [atom, memberAtom],
    });
    expect(mixed.upstream_input_root).toBe(
      'sha256:abb3326bd3e0c41d1c84c6a6b1fdf87323e5e99617b92cfeeefcd7b4162bf348',
    );
    expect(mixed.preimage.rows[2]?.items).toEqual([memberFact]);
    expect(mixed.preimage.rows[2]?.items[0]?.reviewer_principal_id).toBeNull();
    expect(JSON.stringify(mixed.preimage)).not.toContain(memberAtom.text);
  });
});
