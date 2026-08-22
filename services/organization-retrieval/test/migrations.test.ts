import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { organizationMemberSegmentIdentity } from "../src/index.js";
import {
  applyReadableSearchPlaneBaselineV1,
  READABLE_SEARCH_CONTENT_BASELINE_V1,
  READABLE_SEARCH_FACTS_BASELINE_V1,
  READABLE_SEARCH_LEXICAL_BASELINE_V1,
  READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
  readableSearchPlaneBaselineSha256V1,
  readableSearchPlaneBaselineSqlV1,
} from "../src/persistence/baseline.js";
import { ReadableSearchContentStore } from "../src/persistence/content-store.js";
import {
  READABLE_SEARCH_CONTENT_DATABASE,
  READABLE_SEARCH_FACTS_DATABASE,
  READABLE_SEARCH_LEXICAL_DATABASE,
} from "../src/persistence/database-definition.js";
import { ReadableSearchFactsStore } from "../src/persistence/facts-store.js";
import { ReadableSearchLexicalStore } from "../src/persistence/lexical-store.js";
import {
  openAndMigrateReadableSearchPlane,
  openReadableSearchPlane,
} from "../src/persistence/open-plane.js";

const digest = (value: string): `sha256:${string}` =>
  `sha256:${value.padEnd(64, "0").slice(0, 64)}`;

function metadata() {
  return {
    ...organizationMemberSegmentIdentity({
      organization_id: "org_test",
      policy_contract_sha256: digest("1"),
    }),
    analyzer_contract_sha256: digest("2"),
  };
}

describe("retrieval plane migrations", () => {
  it("creates separate identified planes and rejects mutation after finalization", () => {
    const directory = mkdtempSync(join(tmpdir(), "echo-retrieval-"));
    try {
      const facts = ReadableSearchFactsStore.open(
        join(directory, "facts.sqlite"),
      );
      const content = ReadableSearchContentStore.open(
        join(directory, "content.sqlite"),
      );
      const lexical = ReadableSearchLexicalStore.open(
        join(directory, "lexical.sqlite"),
      );
      facts.initialize(metadata());
      content.initialize(metadata());
      lexical.initialize(metadata());
      expect(facts.metadata().plane).toBe("facts");
      expect(content.metadata().plane).toBe("content");
      expect(lexical.metadata().plane).toBe("lexical");
      lexical.insertDocument({
        atom_id: digest("a"),
        log_position: 1,
        atom_order: 0,
        content_binding_sha256: digest("b"),
      });
      lexical.insertPosting({
        term: "term",
        atom_id: digest("a"),
        term_frequency: 1,
      });
      lexical.finalize();
      expect(() =>
        lexical.insertPosting({
          term: "next",
          atom_id: digest("a"),
          term_frequency: 1,
        }),
      ).toThrow("finalized");
      facts.close();
      content.close();
      lexical.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("retrieval plane opening is split from migration", () => {
  it("opens a fresh plane without installing any schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "echo-retrieval-"));
    try {
      const database = openReadableSearchPlane(join(directory, "pure.sqlite"));
      try {
        expect(database.pragma("user_version", { simple: true })).toBe(0);
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

  it("never upgrades or judges an existing schema on open", () => {
    const directory = mkdtempSync(join(tmpdir(), "echo-retrieval-"));
    try {
      const path = join(directory, "facts.sqlite");
      const migrated = openAndMigrateReadableSearchPlane(
        path,
        READABLE_SEARCH_FACTS_DATABASE,
      );
      const version = migrated.pragma("user_version", {
        simple: true,
      }) as number;
      migrated.close();

      const reopened = openReadableSearchPlane(path);
      try {
        expect(reopened.pragma("user_version", { simple: true })).toBe(version);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("readable-search plane new-lineage baselines v1", () => {
  const INSTALLATION_ERA = /enrollment|installation|(?<!re)lease/i;
  const PLANES = [
    {
      baseline: READABLE_SEARCH_FACTS_BASELINE_V1,
      definition: READABLE_SEARCH_FACTS_DATABASE,
      sha256:
        "sha256:1b6a88f1d65b120f58c66bf782d77b6823f06afbc623e75466a8a91311a8751c",
    },
    {
      baseline: READABLE_SEARCH_CONTENT_BASELINE_V1,
      definition: READABLE_SEARCH_CONTENT_DATABASE,
      sha256:
        "sha256:43fa96480d6dca253b0b826ff21ef1242fb39a717dcc375fb6dec8836f1e00d5",
    },
    {
      baseline: READABLE_SEARCH_LEXICAL_BASELINE_V1,
      definition: READABLE_SEARCH_LEXICAL_DATABASE,
      sha256:
        "sha256:03fdc4679f3361da6168efbea80472f7d40b3d95db433269b662974fa6ce2f7c",
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

  it("creates each clean current-policy plane schema without a migration ledger", () => {
    const directory = mkdtempSync(join(tmpdir(), "echo-retrieval-"));
    try {
      for (const { baseline, definition } of PLANES) {
        const database = openReadableSearchPlane(
          join(directory, `${baseline.plane}-baseline.sqlite`),
        );
        try {
          applyReadableSearchPlaneBaselineV1(database, baseline);
          const objects = schemaObjects(database);
          expect(objects.length).toBeGreaterThan(0);
          expect(objects.map((row) => row.name)).not.toContain(
            "retrieval_schema_migrations",
          );
          expect(
            objects.some((row) =>
              row.sql.includes("organization-member-readable-person-v2"),
            ),
          ).toBe(true);
          expect(
            objects.some((row) =>
              row.sql.includes("restricted-reviewer-person-v2"),
            ),
          ).toBe(true);
          expect(database.pragma("user_version", { simple: true })).toBe(
            READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
          );
          expect(database.pragma("application_id", { simple: true })).toBe(
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

  it("contains no installation-era object and freezes each baseline digest", () => {
    for (const { baseline, sha256 } of PLANES) {
      const sql = readableSearchPlaneBaselineSqlV1(baseline);
      expect(INSTALLATION_ERA.test(sql)).toBe(false);
      expect(readableSearchPlaneBaselineSha256V1(baseline)).toBe(sha256);
    }
  });

  it("refuses any database that is not completely empty", () => {
    const directory = mkdtempSync(join(tmpdir(), "echo-retrieval-"));
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
