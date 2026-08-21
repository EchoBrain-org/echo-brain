import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  organizationMemberSegmentIdentity,
} from '../src/index.js';
import { ReadableSearchContentStore } from '../src/persistence/content-store.js';
import { READABLE_SEARCH_FACTS_DATABASE } from '../src/persistence/database-definition.js';
import { ReadableSearchFactsStore } from '../src/persistence/facts-store.js';
import { ReadableSearchLexicalStore } from '../src/persistence/lexical-store.js';
import {
  openAndMigrateReadableSearchPlane,
  openReadableSearchPlane,
} from '../src/persistence/open-plane.js';

const digest = (value: string): `sha256:${string}` =>
  `sha256:${value.padEnd(64, '0').slice(0, 64)}`;

function metadata() {
  return {
    ...organizationMemberSegmentIdentity({
      organization_id: 'org_test',
      policy_contract_sha256: digest('1'),
    }),
    analyzer_contract_sha256: digest('2'),
  };
}

describe('retrieval plane migrations', () => {
  it('creates separate identified planes and rejects mutation after finalization', () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-retrieval-'));
    try {
      const facts = ReadableSearchFactsStore.open(join(directory, 'facts.sqlite'));
      const content = ReadableSearchContentStore.open(join(directory, 'content.sqlite'));
      const lexical = ReadableSearchLexicalStore.open(join(directory, 'lexical.sqlite'));
      facts.initialize(metadata());
      content.initialize(metadata());
      lexical.initialize(metadata());
      expect(facts.metadata().plane).toBe('facts');
      expect(content.metadata().plane).toBe('content');
      expect(lexical.metadata().plane).toBe('lexical');
      lexical.insertDocument({
        atom_id: digest('a'), log_position: 1, atom_order: 0, content_binding_sha256: digest('b'),
      });
      lexical.insertPosting({ term: 'term', atom_id: digest('a'), term_frequency: 1 });
      lexical.finalize();
      expect(() => lexical.insertPosting({ term: 'next', atom_id: digest('a'), term_frequency: 1 }))
        .toThrow('finalized');
      facts.close();
      content.close();
      lexical.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('retrieval plane opening is split from migration', () => {
  it('opens a fresh plane without installing any schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-retrieval-'));
    try {
      const database = openReadableSearchPlane(join(directory, 'pure.sqlite'));
      try {
        expect(database.pragma('user_version', { simple: true })).toBe(0);
        expect(
          database
            .prepare(
              `SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`,
            )
            .all(),
        ).toEqual([]);
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('never upgrades or judges an existing schema on open', () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-retrieval-'));
    try {
      const path = join(directory, 'facts.sqlite');
      const migrated = openAndMigrateReadableSearchPlane(
        path,
        READABLE_SEARCH_FACTS_DATABASE,
      );
      const version = migrated.pragma('user_version', { simple: true }) as number;
      migrated.close();

      const reopened = openReadableSearchPlane(path);
      try {
        expect(reopened.pragma('user_version', { simple: true })).toBe(version);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
