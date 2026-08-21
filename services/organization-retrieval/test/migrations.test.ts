import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  organizationMemberSegmentIdentity,
} from '../src/index.js';
import {
  applyReadableSearchPlaneBaselineV1,
  READABLE_SEARCH_CONTENT_BASELINE_V1,
  READABLE_SEARCH_FACTS_BASELINE_V1,
  READABLE_SEARCH_LEXICAL_BASELINE_V1,
  READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
  readableSearchPlaneBaselineSha256V1,
  readableSearchPlaneBaselineSqlV1,
} from '../src/persistence/baseline.js';
import { ReadableSearchContentStore } from '../src/persistence/content-store.js';
import {
  READABLE_SEARCH_CONTENT_DATABASE,
  READABLE_SEARCH_FACTS_DATABASE,
  READABLE_SEARCH_LEXICAL_DATABASE,
} from '../src/persistence/database-definition.js';
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

describe('readable-search plane new-lineage baselines v1', () => {
  const INSTALLATION_ERA = /enrollment|installation|(?<!re)lease/i;
  const PLANES = [
    {
      baseline: READABLE_SEARCH_FACTS_BASELINE_V1,
      definition: READABLE_SEARCH_FACTS_DATABASE,
      sha256:
        'sha256:0f141e0236a39e34e9bf7e2891c5a9ec13ef465e9f8ef881f273df6e9240adf0',
    },
    {
      baseline: READABLE_SEARCH_CONTENT_BASELINE_V1,
      definition: READABLE_SEARCH_CONTENT_DATABASE,
      sha256:
        'sha256:f4d29c426cf8061941a1e2702ddd8d30bd200084c30bea01ab9cb2e8de10e4ea',
    },
    {
      baseline: READABLE_SEARCH_LEXICAL_BASELINE_V1,
      definition: READABLE_SEARCH_LEXICAL_DATABASE,
      sha256:
        'sha256:2313bd4ce636d601b70953d45f165096049a6edb1869a2bd9f4b87310f8fdd39',
    },
  ] as const;

  function schemaObjects(database: ReturnType<typeof openReadableSearchPlane>) {
    return database
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
         ORDER BY type, name`,
      )
      .all() as { type: string; name: string; sql: string }[];
  }

  it('creates each terminal plane schema exactly, minus the migration ledger', () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-retrieval-'));
    try {
      for (const { baseline, definition } of PLANES) {
        const migrated = openAndMigrateReadableSearchPlane(
          join(directory, `${baseline.plane}-migrated.sqlite`),
          definition,
        );
        const allMigratedObjects = schemaObjects(migrated);
        migrated.close();
        const migratedObjects = allMigratedObjects.filter(
          (row) =>
            !row.name.includes('schema_migrations') &&
            !row.name.includes('migration_ledger'),
        );
        // The excluded set must be exactly the ledger machinery; a behavior
        // object whose name merely matched the filter would silently vanish
        // from both sides of the equivalence.
        expect(
          allMigratedObjects
            .filter(
              (row) =>
                row.name.includes('schema_migrations') ||
                row.name.includes('migration_ledger'),
            )
            .map((row) => `${row.type}:${row.name}`)
            .sort(),
        ).toEqual([
          'table:retrieval_schema_migrations',
          `trigger:retrieval_${baseline.plane}_migration_ledger_immutable_delete`,
          `trigger:retrieval_${baseline.plane}_migration_ledger_immutable_update`,
        ]);
        expect(migratedObjects.length).toBeGreaterThan(0);

        const database = openReadableSearchPlane(
          join(directory, `${baseline.plane}-baseline.sqlite`),
        );
        try {
          applyReadableSearchPlaneBaselineV1(database, baseline);
          expect(schemaObjects(database)).toEqual(migratedObjects);
          expect(database.pragma('user_version', { simple: true })).toBe(
            READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
          );
          expect(database.pragma('application_id', { simple: true })).toBe(
            definition.application_id,
          );
        } finally {
          database.close();
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('contains no installation-era object and freezes each baseline digest', () => {
    for (const { baseline, sha256 } of PLANES) {
      const sql = readableSearchPlaneBaselineSqlV1(baseline);
      expect(INSTALLATION_ERA.test(sql)).toBe(false);
      expect(readableSearchPlaneBaselineSha256V1(baseline)).toBe(sha256);
    }
  });

  it('refuses any database that is not completely empty', () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-retrieval-'));
    try {
      for (const { baseline, definition } of PLANES) {
        const database = openReadableSearchPlane(
          join(directory, `${baseline.plane}-twice.sqlite`),
        );
        try {
          applyReadableSearchPlaneBaselineV1(database, baseline);
          expect(() =>
            applyReadableSearchPlaneBaselineV1(database, baseline),
          ).toThrow(/completely empty database/);
        } finally {
          database.close();
        }

        const migrated = openAndMigrateReadableSearchPlane(
          join(directory, `${baseline.plane}-legacy.sqlite`),
          definition,
        );
        try {
          expect(() =>
            applyReadableSearchPlaneBaselineV1(migrated, baseline),
          ).toThrow(/completely empty database/);
        } finally {
          migrated.close();
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
