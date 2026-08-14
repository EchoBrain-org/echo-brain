import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { buildStoppedReadableSearchGeneration } from '../src/build.js';
import {
  readableSearchContentBindingSha256,
  readableSearchProvenanceBindingSha256,
} from '../src/application/upstream-input.js';
import { atom, buildInput, digest, removeStateDirectory, stateDirectory } from './support/generation-fixture.js';

describe('stopped readable-search generation builder', () => {
  it('constructs exact reviewer bindings without admitting runtime-only fields', () => {
    const reviewer = atom({
      atom_id: 'reviewer-binding',
      policy_id: 'restricted-reviewer-v1',
      text: 'private review',
      position: 2,
    });
    expect(readableSearchContentBindingSha256({
      fact: reviewer.fact,
      text_sha256: reviewer.text_sha256,
    })).toBe(canonicalSha256({
      schema_version: 1,
      kind: 'organization-record-item-content-binding-v1',
      organization_id: reviewer.fact.organization_id,
      envelope_sha256: reviewer.fact.envelope_sha256,
      log_position: reviewer.fact.log_position,
      record_hash: reviewer.fact.record_hash,
      atom_id: reviewer.fact.atom_id,
      atom_order: reviewer.fact.atom_order,
      signal_id_sha256: reviewer.fact.signal_id_sha256,
      item_kind: reviewer.fact.item_kind,
      text_sha256: reviewer.text_sha256,
    }));
    expect(readableSearchProvenanceBindingSha256(reviewer.fact)).toBe(
      canonicalSha256({
        schema_version: 1,
        kind: 'organization-record-policy-provenance-binding-v1',
        organization_id: reviewer.fact.organization_id,
        envelope_sha256: reviewer.fact.envelope_sha256,
        log_position: reviewer.fact.log_position,
        record_hash: reviewer.fact.record_hash,
        policy_id: reviewer.fact.policy_id,
        policy_contract_sha256: reviewer.fact.policy_contract_sha256,
        reviewer_principal_id: reviewer.fact.reviewer_principal_id,
        reviewer_membership_id: reviewer.fact.reviewer_membership_id,
        release_draft_sha256: reviewer.fact.release_draft_sha256,
        approval_presentation_sha256:
          reviewer.fact.approval_presentation_sha256,
        semantic_intent_sha256: reviewer.fact.semantic_intent_sha256,
        message_presentation_sha256:
          reviewer.fact.message_presentation_sha256,
        authorization_audit_event_id:
          reviewer.fact.authorization_audit_event_id,
        authorization_audit_entry_sha256:
          reviewer.fact.authorization_audit_entry_sha256,
        authorization_proof_sha256:
          reviewer.fact.authorization_proof_sha256,
        evaluated_at: reviewer.fact.evaluated_at,
      }),
    );
    const factWithRuntimeExtra = {
      ...reviewer.fact,
      text: 'must not enter either commitment',
    };
    expect(readableSearchContentBindingSha256({
      fact: factWithRuntimeExtra,
      text_sha256: reviewer.text_sha256,
    })).toBe(reviewer.fact.content_binding_sha256);
    expect(readableSearchProvenanceBindingSha256(factWithRuntimeExtra)).toBe(
      reviewer.fact.provenance_binding_sha256,
    );
  });

  it('rejects arbitrary valid atoms paired with another exact upstream root before writing state', () => {
    const directory = stateDirectory();
    try {
      const approved = atom({ atom_id: 'approved', text: 'approved text', position: 1 });
      const input = buildInput(directory, [approved]);
      const unrelated = atom({ atom_id: 'unrelated', text: 'unrelated text', position: 1 });
      expect(() => buildStoppedReadableSearchGeneration({
        ...input,
        atoms: [unrelated],
      })).toThrow('admitted atom facts do not match upstream_input_root preimage');
      expect(existsSync(join(directory, 'record-retrieval'))).toBe(false);
    } finally {
      removeStateDirectory(directory);
    }
  });

  it('rejects text substituted behind an exact committed permission fact', () => {
    const directory = stateDirectory();
    try {
      const approved = atom({ atom_id: 'approved', text: 'approved text', position: 1 });
      const input = buildInput(directory, [approved]);
      const substitutedText = 'substituted text';
      expect(() => buildStoppedReadableSearchGeneration({
        ...input,
        atoms: [{
          ...approved,
          text: substitutedText,
          text_sha256: digest(substitutedText),
        }],
      })).toThrow('admitted atom text does not bind its Layer 1 content fact');
      expect(existsSync(join(directory, 'record-retrieval'))).toBe(false);
    } finally {
      removeStateDirectory(directory);
    }
  });

  it('rejects a tampered content binding even when the preimage and claimed root agree with it', () => {
    const directory = stateDirectory();
    try {
      const approved = atom({ atom_id: 'approved', text: 'approved text', position: 1 });
      const tampered = {
        ...approved,
        fact: {
          ...approved.fact,
          content_binding_sha256: digest('tampered-content-binding'),
        },
      };
      const input = buildInput(directory, [tampered]);
      expect(() => buildStoppedReadableSearchGeneration(input)).toThrow(
        'admitted atom text does not bind its Layer 1 content fact',
      );
      expect(existsSync(join(directory, 'record-retrieval'))).toBe(false);
    } finally {
      removeStateDirectory(directory);
    }
  });

  it('rejects a tampered provenance binding even when the preimage agrees with it', () => {
    const directory = stateDirectory();
    try {
      const approved = atom({
        atom_id: 'approved',
        policy_id: 'restricted-reviewer-v1',
        text: 'approved text',
        position: 1,
      });
      const tampered = {
        ...approved,
        fact: {
          ...approved.fact,
          provenance_binding_sha256: digest('tampered-provenance-binding'),
        },
      };
      const input = buildInput(directory, [tampered]);
      expect(() => buildStoppedReadableSearchGeneration(input)).toThrow(
        'admitted atom does not bind its Layer 1 provenance fact',
      );
      expect(existsSync(join(directory, 'record-retrieval'))).toBe(false);
    } finally {
      removeStateDirectory(directory);
    }
  });

  it('derives the manifest root from the exact admitted preimage', () => {
    const directory = stateDirectory();
    try {
      const input = buildInput(directory, [
        atom({ atom_id: 'approved', text: 'approved text', position: 1 }),
      ]);
      const built = buildStoppedReadableSearchGeneration(input);
      expect(built.manifest.upstream_input_root).toBe(
        canonicalSha256(input.upstream_input_preimage),
      );
    } finally {
      removeStateDirectory(directory);
    }
  });

  it('builds distinct policy segments and retries by reusing the exact complete generation', () => {
    const directory = stateDirectory();
    try {
      const input = buildInput(directory, [
        atom({ atom_id: 'member', text: 'organization release', position: 1 }),
        atom({ atom_id: 'reviewer', policy_id: 'restricted-reviewer-v1', text: 'private review', position: 2 }),
      ]);
      const first = buildStoppedReadableSearchGeneration(input);
      const second = buildStoppedReadableSearchGeneration(input);
      expect(second.generation_directory).toBe(first.generation_directory);
      expect(second.manifest_sha256).toBe(first.manifest_sha256);
      expect(first.manifest.segments).toHaveLength(2);
      expect(existsSync(`${first.generation_directory}/manifest.json`)).toBe(true);
      expect(existsSync(`${first.generation_directory}/segments`)).toBe(true);
    } finally {
      removeStateDirectory(directory);
    }
  });

  it('always declares the empty organization segment and rejects duplicate atoms', () => {
    const directory = stateDirectory();
    try {
      const reviewer = atom({ atom_id: 'reviewer', policy_id: 'restricted-reviewer-v1', text: 'private', position: 1 });
      expect(buildStoppedReadableSearchGeneration(buildInput(directory, [reviewer])).manifest.segments).toHaveLength(2);
      expect(() => buildStoppedReadableSearchGeneration(buildInput(directory, [reviewer, reviewer])))
        .toThrow('duplicate atom');
    } finally {
      removeStateDirectory(directory);
    }
  });

  it('does not reuse a corrupted final generation under the same identity', () => {
    const directory = stateDirectory();
    try {
      const input = buildInput(directory, [atom({ atom_id: 'member', text: 'visible' })]);
      const built = buildStoppedReadableSearchGeneration(input);
      const segment = built.manifest.segments[0]!;
      writeFileSync(`${built.generation_directory}/segments/${segment.segment_id}/facts.sqlite`, 'corrupt', { mode: 0o600 });
      expect(() => buildStoppedReadableSearchGeneration(input)).toThrow();
    } finally {
      removeStateDirectory(directory);
    }
  });

  it('refuses an unsafe existing generation before reading or overwriting its target', () => {
    const directory = stateDirectory();
    try {
      const input = buildInput(directory, [atom({ atom_id: 'member', text: 'visible' })]);
      const built = buildStoppedReadableSearchGeneration(input);
      const outside = join(directory, 'outside-target');
      mkdirSync(outside, { mode: 0o700 });
      const sentinel = join(outside, 'sentinel.txt');
      writeFileSync(sentinel, 'must not be read or overwritten', { mode: 0o600 });
      rmSync(built.generation_directory, { recursive: true, force: false });
      symlinkSync(outside, built.generation_directory, 'dir');
      expect(() => buildStoppedReadableSearchGeneration(input)).toThrow(
        'existing readable-search generation must be a current-user 0700 canonical directory',
      );
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      removeStateDirectory(directory);
    }
  });

  it('refuses wrong-mode and undeclared existing-generation entries on retry', () => {
    const directory = stateDirectory();
    try {
      const input = buildInput(directory, [atom({ atom_id: 'member', text: 'visible' })]);
      const built = buildStoppedReadableSearchGeneration(input);
      chmodSync(built.generation_directory, 0o755);
      expect(() => buildStoppedReadableSearchGeneration(input)).toThrow(
        'existing readable-search generation must be a current-user 0700 canonical directory',
      );
      chmodSync(built.generation_directory, 0o700);
      writeFileSync(join(built.generation_directory, 'unexpected'), 'x', { mode: 0o600 });
      expect(() => buildStoppedReadableSearchGeneration(input)).toThrow(
        'existing readable-search generation has undeclared entries',
      );
    } finally {
      removeStateDirectory(directory);
    }
  });

  it('discards a verified orphan staging directory before a fresh stopped build', () => {
    const directory = stateDirectory();
    try {
      const root = `${directory}/record-retrieval/generations/.staging-${'a'.repeat(32)}`;
      mkdirSync(root, { recursive: true, mode: 0o700 });
      buildStoppedReadableSearchGeneration(buildInput(directory, [atom({ atom_id: 'member', text: 'visible' })]));
      expect(existsSync(root)).toBe(false);
    } finally {
      removeStateDirectory(directory);
    }
  });
});
