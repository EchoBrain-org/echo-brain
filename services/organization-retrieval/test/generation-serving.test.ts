import {
  copyFileSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import Database from 'better-sqlite3';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import { buildStoppedReadableSearchGeneration } from '../src/build.js';
import { admitReadableSearchGenerationDirectory, OpaqueReadableSearchMachine } from '../src/serve.js';
import { openAdmittedReadableSearchPlane } from '../src/serve/generation-admission.js';
import { READABLE_SEARCH_LEXICAL_DATABASE } from '../src/persistence/database-definition.js';
import { readableSearchLexicalRoot } from '../src/application/roots.js';
import type {
  RetrievalLexicalDocument,
  RetrievalTermPosting,
} from '../src/application/contracts.js';
import { atom, buildInput, digest, removeStateDirectory, stateDirectory } from './support/generation-fixture.js';

describe('admitted generation and opaque search machine', () => {
  it('searches only bound segments and requires lexical search before content', () => {
    const directory = stateDirectory();
    try {
      const build = buildStoppedReadableSearchGeneration(buildInput(directory, [
        atom({ atom_id: 'member', text: 'organization visible', position: 1 }),
        atom({ atom_id: 'reviewer', policy_id: 'restricted-reviewer-v1', text: 'reviewer secret', position: 2 }),
      ]));
      const opened = admitReadableSearchGenerationDirectory({
        generation_directory: build.generation_directory,
        admission: {
          state_directory: directory, organization_id: build.manifest.organization_id,
          record_head: build.manifest.record_head, retrieval_contract_sha256: build.manifest.retrieval_contract_sha256,
          analyzer: build.manifest.analyzer,
        },
      });
      const memberSegment = [...opened.segments.values()].find((segment) =>
        segment.manifest.policy_id === 'organization-member-readable-v1',
      )!;
      const openings: string[] = [];
      const machine = new OpaqueReadableSearchMachine(opened, {
        opened: (plane, segmentId) => openings.push(`${plane}:${segmentId}`),
      });
      const scope = machine.bind({
        request_sha256: build.manifest.upstream_input_root,
        caller_binding_sha256: build.manifest.builder_artifact_sha256,
        admitted_segment_ids: [memberSegment.manifest.segment_id],
      });
      expect(() => machine.fetch(scope)).toThrow('out of order');
      expect(openings).toEqual([`facts:${memberSegment.manifest.segment_id}`]);
      machine.search(scope, 'organization reviewer');
      expect(machine.fetch(scope)).toEqual([{
        kind: 'decision', text: 'organization visible', policy_id: 'organization-member-readable-v1',
      }]);
      expect(openings).toEqual([
        `facts:${memberSegment.manifest.segment_id}`,
        `lexical:${memberSegment.manifest.segment_id}`,
        `content:${memberSegment.manifest.segment_id}`,
      ]);
      expect(() => machine.fetch(scope)).toThrow('out of order');
    } finally {
      removeStateDirectory(directory);
    }
  });

  it('rejects a generation whose immutable plane was corrupted', () => {
    const directory = stateDirectory();
    try {
      const build = buildStoppedReadableSearchGeneration(buildInput(directory, [atom({ atom_id: 'member', text: 'visible' })]));
      const member = build.manifest.segments.find((segment) => segment.segment_id)!;
      writeFileSync(`${build.generation_directory}/segments/${member.segment_id}/content.sqlite`, 'corrupt', { mode: 0o600 });
      expect(() => admitReadableSearchGenerationDirectory({
        generation_directory: build.generation_directory,
        admission: {
          state_directory: directory, organization_id: build.manifest.organization_id,
          record_head: build.manifest.record_head, retrieval_contract_sha256: build.manifest.retrieval_contract_sha256,
          analyzer: build.manifest.analyzer,
        },
      })).toThrow();
    } finally {
      removeStateDirectory(directory);
    }
  });

  it('rejects a nested or mixed generation directory at admission', () => {
    const directory = stateDirectory();
    try {
      const build = buildStoppedReadableSearchGeneration(buildInput(directory, [
        atom({ atom_id: 'member', text: 'visible' }),
      ]));
      writeFileSync(`${build.generation_directory}/unexpected`, 'x', { mode: 0o600 });
      expect(() => admitReadableSearchGenerationDirectory({
        generation_directory: build.generation_directory,
        admission: {
          state_directory: directory, organization_id: build.manifest.organization_id,
          record_head: build.manifest.record_head, retrieval_contract_sha256: build.manifest.retrieval_contract_sha256,
          analyzer: build.manifest.analyzer,
        },
      })).toThrow('readable-search generation has undeclared entries');
    } finally {
      removeStateDirectory(directory);
    }
  });

  it.each([
    {
      label: 'undeclared nested material',
      atoms: [atom({ atom_id: 'member', text: 'visible' })],
      mutate(manifest: Record<string, unknown>): void {
        (manifest.roots as Record<string, unknown>).undeclared =
          digest('not-bound-by-the-pointer');
      },
      expected_error: 'generation roots has an unexpected shape',
    },
    {
      label: 'a normalized wrong constant',
      atoms: [atom({ atom_id: 'member', text: 'visible' })],
      mutate(manifest: Record<string, unknown>): void {
        (manifest.index as { format_version: number }).format_version = 999;
      },
      expected_error: 'generation index identity is unsupported',
    },
    {
      label: 'reordered segments',
      atoms: [
        atom({ atom_id: 'member', text: 'visible member', position: 1 }),
        atom({
          atom_id: 'reviewer',
          policy_id: 'restricted-reviewer-v1',
          text: 'visible reviewer',
          position: 2,
        }),
      ],
      mutate(manifest: Record<string, unknown>): void {
        const segments = manifest.segments as unknown[];
        expect(segments).toHaveLength(2);
        segments.reverse();
      },
      expected_error: 'generation segments must be ordered by segment_id',
    },
  ] as const)(
    'rejects canonical manifest bytes containing $label',
    ({ atoms, mutate, expected_error }) => {
      const directory = stateDirectory();
      try {
        const build = buildStoppedReadableSearchGeneration(
          buildInput(directory, atoms),
        );
        const manifestPath = `${build.generation_directory}/manifest.json`;
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
          string,
          unknown
        >;
        mutate(manifest);
        writeFileSync(manifestPath, canonicalJson(manifest), { mode: 0o600 });

        expect(() => admitReadableSearchGenerationDirectory({
          generation_directory: build.generation_directory,
          admission: {
            state_directory: directory, organization_id: build.manifest.organization_id,
            record_head: build.manifest.record_head, retrieval_contract_sha256: build.manifest.retrieval_contract_sha256,
            analyzer: build.manifest.analyzer,
          },
        })).toThrow(expected_error);
      } finally {
        removeStateDirectory(directory);
      }
    },
  );

  it('opens no plane for an empty scope and no hidden reviewer plane for an ordinary member', () => {
    const directory = stateDirectory();
    try {
      const build = buildStoppedReadableSearchGeneration(buildInput(directory, [
        atom({ atom_id: 'member', text: 'ordinary visible', position: 1 }),
        atom({ atom_id: 'reviewer', policy_id: 'restricted-reviewer-v1', text: 'hidden review', position: 2 }),
      ]));
      const opened = admitReadableSearchGenerationDirectory({
        generation_directory: build.generation_directory,
        admission: {
          state_directory: directory, organization_id: build.manifest.organization_id,
          record_head: build.manifest.record_head, retrieval_contract_sha256: build.manifest.retrieval_contract_sha256,
          analyzer: build.manifest.analyzer,
        },
      });
      const member = [...opened.segments.values()].find((segment) => segment.manifest.policy_id === 'organization-member-readable-v1')!;
      const reviewer = [...opened.segments.values()].find((segment) => segment.manifest.policy_id === 'restricted-reviewer-v1')!;
      const openings: string[] = [];
      const machine = new OpaqueReadableSearchMachine(opened, { opened: (plane, segment) => openings.push(`${plane}:${segment}`) });
      const emptyScope = machine.bind({
        request_sha256: digest('empty request'), caller_binding_sha256: digest('empty caller'), admitted_segment_ids: [],
      });
      machine.search(emptyScope, 'ordinary');
      expect(machine.fetch(emptyScope)).toEqual([]);
      expect(openings).toEqual([]);
      const memberScope = machine.bind({
        request_sha256: digest('member request'), caller_binding_sha256: digest('member caller'),
        admitted_segment_ids: [member.manifest.segment_id],
      });
      machine.search(memberScope, 'ordinary hidden');
      machine.fetch(memberScope);
      expect(openings.every((opening) => !opening.endsWith(reviewer.manifest.segment_id))).toBe(true);
      const openingsBeforeInvalidScope = openings.length;
      expect(() => machine.bind({
        request_sha256: digest('bad request'), caller_binding_sha256: digest('bad caller'),
        admitted_segment_ids: [digest('not a segment')],
      })).toThrow('undeclared');
      expect(openings).toHaveLength(openingsBeforeInvalidScope);
      expect(openings.every((opening) => !opening.endsWith(reviewer.manifest.segment_id))).toBe(true);
    } finally {
      removeStateDirectory(directory);
    }
  });

  it('keeps ordinary-member results identical when only a hidden reviewer corpus changes', () => {
    const firstDirectory = stateDirectory();
    const secondDirectory = stateDirectory();
    try {
      const first = buildStoppedReadableSearchGeneration(buildInput(firstDirectory, [
        atom({ atom_id: 'member', text: 'stable public result', position: 1 }),
        atom({ atom_id: 'reviewer-one', policy_id: 'restricted-reviewer-v1', text: 'hidden alpha', position: 2 }),
      ]));
      const second = buildStoppedReadableSearchGeneration(buildInput(secondDirectory, [
        atom({ atom_id: 'member', text: 'stable public result', position: 1 }),
        atom({ atom_id: 'reviewer-two', policy_id: 'restricted-reviewer-v1', text: 'hidden beta beta beta', position: 2 }),
      ]));
      const search = (directory: string, build: typeof first) => {
        const opened = admitReadableSearchGenerationDirectory({
          generation_directory: build.generation_directory,
          admission: {
            state_directory: directory, organization_id: build.manifest.organization_id,
            record_head: build.manifest.record_head, retrieval_contract_sha256: build.manifest.retrieval_contract_sha256,
            analyzer: build.manifest.analyzer,
          },
        });
        const member = [...opened.segments.values()].find((segment) => segment.manifest.policy_id === 'organization-member-readable-v1')!;
        const machine = new OpaqueReadableSearchMachine(opened);
        const scope = machine.bind({ request_sha256: digest(`request${directory}`), caller_binding_sha256: digest(`caller${directory}`), admitted_segment_ids: [member.manifest.segment_id] });
        machine.search(scope, 'stable hidden');
        return machine.fetch(scope);
      };
      expect(search(firstDirectory, first)).toEqual(search(secondDirectory, second));
    } finally {
      removeStateDirectory(firstDirectory);
      removeStateDirectory(secondDirectory);
    }
  });

  it('rejects swapped segment plane files before any scope is minted', () => {
    const directory = stateDirectory();
    try {
      const build = buildStoppedReadableSearchGeneration(buildInput(directory, [
        atom({ atom_id: 'member', text: 'member text', position: 1 }),
        atom({ atom_id: 'reviewer', policy_id: 'restricted-reviewer-v1', text: 'reviewer text', position: 2 }),
      ]));
      const [left, right] = build.manifest.segments;
      const leftPath = `${build.generation_directory}/segments/${left!.segment_id}/content.sqlite`;
      const rightPath = `${build.generation_directory}/segments/${right!.segment_id}/content.sqlite`;
      const temporary = `${build.generation_directory}/swapped-content.sqlite`;
      renameSync(leftPath, temporary);
      renameSync(rightPath, leftPath);
      renameSync(temporary, rightPath);
      expect(() => admitReadableSearchGenerationDirectory({
        generation_directory: build.generation_directory,
        admission: {
          state_directory: directory, organization_id: build.manifest.organization_id,
          record_head: build.manifest.record_head, retrieval_contract_sha256: build.manifest.retrieval_contract_sha256,
          analyzer: build.manifest.analyzer,
        },
      })).toThrow();
    } finally {
      removeStateDirectory(directory);
    }
  });

  it('refuses a post-admission symlink or replacement before opening lexical or content', () => {
    const directory = stateDirectory();
    try {
      const build = buildStoppedReadableSearchGeneration(buildInput(directory, [
        atom({ atom_id: 'member', text: 'member text', position: 1 }),
      ]));
      const opened = admitReadableSearchGenerationDirectory({
        generation_directory: build.generation_directory,
        admission: {
          state_directory: directory, organization_id: build.manifest.organization_id,
          record_head: build.manifest.record_head, retrieval_contract_sha256: build.manifest.retrieval_contract_sha256,
          analyzer: build.manifest.analyzer,
        },
      });
      const member = [...opened.segments.values()].find((segment) =>
        segment.manifest.policy_id === 'organization-member-readable-v1',
      )!;
      rmSync(member.lexical_path);
      symlinkSync(member.content_path, member.lexical_path, 'file');
      const machine = new OpaqueReadableSearchMachine(opened);
      const scope = machine.bind({
        request_sha256: digest('symlink request'),
        caller_binding_sha256: digest('symlink caller'),
        admitted_segment_ids: [member.manifest.segment_id],
      });
      expect(() => machine.search(scope, 'member')).toThrow(
        'readable-search lexical plane must be a current-user 0600 canonical file',
      );
    } finally {
      removeStateDirectory(directory);
    }

    const replacementDirectory = stateDirectory();
    try {
      const build = buildStoppedReadableSearchGeneration(buildInput(replacementDirectory, [
        atom({ atom_id: 'member', text: 'member text', position: 1 }),
      ]));
      const opened = admitReadableSearchGenerationDirectory({
        generation_directory: build.generation_directory,
        admission: {
          state_directory: replacementDirectory, organization_id: build.manifest.organization_id,
          record_head: build.manifest.record_head, retrieval_contract_sha256: build.manifest.retrieval_contract_sha256,
          analyzer: build.manifest.analyzer,
        },
      });
      const member = [...opened.segments.values()].find((segment) =>
        segment.manifest.policy_id === 'organization-member-readable-v1',
      )!;
      writeFileSync(member.content_path, 'replacement', { mode: 0o600 });
      const machine = new OpaqueReadableSearchMachine(opened);
      const scope = machine.bind({
        request_sha256: digest('replacement request'),
        caller_binding_sha256: digest('replacement caller'),
        admitted_segment_ids: [member.manifest.segment_id],
      });
      machine.search(scope, 'member');
      expect(() => machine.fetch(scope)).toThrow(
        'readable-search content plane differs from admitted immutable identity',
      );
    } finally {
      removeStateDirectory(replacementDirectory);
    }
  });

  it('detects a counterfeit opened lexical object after its pathname passes post-open identity validation', () => {
    const directory = stateDirectory();
    try {
      const build = buildStoppedReadableSearchGeneration(buildInput(directory, [
        atom({ atom_id: 'member', text: 'member text', position: 1 }),
      ]));
      const opened = admitReadableSearchGenerationDirectory({
        generation_directory: build.generation_directory,
        admission: {
          state_directory: directory, organization_id: build.manifest.organization_id,
          record_head: build.manifest.record_head, retrieval_contract_sha256: build.manifest.retrieval_contract_sha256,
          analyzer: build.manifest.analyzer,
        },
      });
      const member = [...opened.segments.values()].find((segment) =>
        segment.manifest.policy_id === 'organization-member-readable-v1',
      )!;
      const counterfeit = buildStoppedReadableSearchGeneration(buildInput(directory, [
        atom({ atom_id: 'member', text: 'counterfeit member text', position: 1 }),
      ]));
      const replacement = `${member.lexical_path}.replacement`;
      copyFileSync(
        `${counterfeit.generation_directory}/segments/${member.manifest.segment_id}/lexical.sqlite`,
        replacement,
        0,
      );
      expect(() => openAdmittedReadableSearchPlane(
        member.lexical_path,
        READABLE_SEARCH_LEXICAL_DATABASE,
        member.lexical_identity,
        {
          open_database: (path) => {
            expect(path).toBe(member.lexical_path);
            return new Database(replacement, { readonly: true, fileMustExist: true });
          },
          validate_opened: (database) => {
            const documents = database.prepare(
              'SELECT * FROM retrieval_lexical_document ORDER BY log_position, atom_order, atom_id',
            ).all() as RetrievalLexicalDocument[];
            const postings = database.prepare(
              'SELECT * FROM retrieval_term_posting ORDER BY CAST(term AS BLOB), atom_id',
            ).all() as RetrievalTermPosting[];
            if (
              readableSearchLexicalRoot({
                segment_id: member.manifest.segment_id,
                documents,
                postings,
              }) !== member.manifest.lexical_root
            ) {
              throw new Error('opened lexical object root differs from admission');
            }
          },
        },
      )).toThrow('opened lexical object root differs from admission');
    } finally {
      removeStateDirectory(directory);
    }
  });
});
