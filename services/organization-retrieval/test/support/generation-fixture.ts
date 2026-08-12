import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Digest } from '@echo-brain/federation-protocol';
import type {
  ReadableSearchAdmittedAtom,
  ReadableSearchStoppedBuildInput,
} from '../../src/application/contracts.js';

export const digest = (value: string): `sha256:${string}` => sha256Digest(value);

export function atom(input: {
  atom_id: string;
  policy_id?: 'organization-member-readable-v1' | 'restricted-reviewer-v1';
  text: string;
  position?: number;
  reviewer_principal_id?: string;
  reviewer_membership_id?: string;
}): ReadableSearchAdmittedAtom {
  const policyId = input.policy_id ?? 'organization-member-readable-v1';
  const reviewer = policyId === 'restricted-reviewer-v1';
  const position = input.position ?? 1;
  return {
    fact: {
      atom_id: digest(input.atom_id), organization_id: 'org_test', envelope_sha256: digest(`env${input.atom_id}`),
      log_position: position, record_hash: digest(`record${position}`), atom_order: 0,
      signal_id_sha256: digest(`signal${input.atom_id}`), item_kind: 'decision', policy_id: policyId,
      policy_contract_sha256: digest(policyId === 'organization-member-readable-v1' ? 'member' : 'reviewer'),
      approval_actor_principal_id: 'prn_actor', approval_actor_membership_id: 'mem_actor',
      reviewer_principal_id: reviewer ? (input.reviewer_principal_id ?? 'prn_reviewer') : null,
      reviewer_membership_id: reviewer ? (input.reviewer_membership_id ?? 'mem_reviewer') : null,
      release_draft_sha256: digest(`draft${input.atom_id}`), approval_presentation_sha256: digest(`presentation${input.atom_id}`),
      semantic_intent_sha256: digest(`intent${input.atom_id}`), message_presentation_sha256: digest(`message${input.atom_id}`),
      authorization_audit_event_id: `aud_${input.atom_id}`, authorization_audit_entry_sha256: digest(`audit${input.atom_id}`),
      evaluated_at: '2026-01-01T00:00:00.000Z', authorization_proof_sha256: digest(`proof${input.atom_id}`),
      content_binding_sha256: digest(`content${input.atom_id}`), provenance_binding_sha256: digest(`provenance${input.atom_id}`),
    },
    text: input.text,
    text_sha256: sha256Digest(input.text),
  };
}

export function buildInput(directory: string, atoms: readonly ReadableSearchAdmittedAtom[]): ReadableSearchStoppedBuildInput {
  return {
    state_directory: directory,
    organization_id: 'org_test',
    record_head: { position: 3, record_hash: digest('head') },
    upstream_input_root: digest('input-root'), retrieval_contract_sha256: digest('contract'),
    organization_member_policy_contract_sha256: digest('member'),
    restricted_reviewer_policy_contract_sha256: digest('reviewer'),
    analyzer: {
      analyzer_id: 'echo-unicode-alnum-frequency-v1', analyzer_contract_sha256: digest('analyzer-contract'),
      analyzer_source_sha256: digest('analyzer-source'), node_version: '22.22.1', unicode_version: '16.0', icu_version: '76.1',
    },
    source_revision: 'source-1', builder_artifact_sha256: digest('builder'), sqlite_version: '3.50.4', atoms,
  };
}

export function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'echo-retrieval-generation-'));
}

export function removeStateDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}
