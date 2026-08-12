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
import { buildStoppedReadableSearchGeneration } from '../src/build.js';
import { atom, buildInput, removeStateDirectory, stateDirectory } from './support/generation-fixture.js';

describe('stopped readable-search generation builder', () => {
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
