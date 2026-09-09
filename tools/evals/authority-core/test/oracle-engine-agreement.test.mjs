/** Independent oracle and actual engine must agree under each reader's scope. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSyntheticCorpus } from "../corpus-v1.mjs";
import { buildQueryPlan, searchAtHead } from "../oracle-v1.mjs";
import { withSearchGeneration } from "../search-generation-fixture.mjs";

test("engine top ten equals the independent oracle top ten for held-out queries and both reader kinds", () => {
  const corpus = buildSyntheticCorpus({ milestone: "M1", seed: "oracle-engine-agreement" });
  withSearchGeneration(corpus.atoms, ({ search }) => {
    const readers = [
      { principal_id: "employee-000", membership_id: "membership-000" },
      { principal_id: "employee-003", membership_id: "membership-003" },
      { principal_id: "prn_member_only", membership_id: "mem_member_only" },
    ];
    let compared = 0;
    for (const reader of readers) {
      const plan = buildQueryPlan({ corpus, reader, count: 60, seed: `agreement-${reader.principal_id}` });
      for (const { query } of plan) {
        const expected = searchAtHead({ corpus, exactHead: corpus.exact_head, reader, query, limit: 10 });
        const actual = search(reader, query);
        assert.deepEqual(
          actual.items.map((item) => item.atom_id),
          expected.items.map((item) => `sha256:${item.atom_id}`),
          `top ten differs for reader ${reader.principal_id} query "${query}"`,
        );
        compared += 1;
      }
    }
    assert.equal(compared, 180);
  });
});
