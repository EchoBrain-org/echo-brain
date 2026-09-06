import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildSyntheticCorpus, POLICY_RESTRICTED_REVIEWER } from "../corpus-v1.mjs";

const contract = JSON.parse(readFileSync(new URL("../metrics.v2.json", import.meta.url)));

test("M1 history represents every contracted employee with coherent meeting ownership", () => {
  const milestone = contract.milestones.find(({ id }) => id === "M1");
  const corpus = buildSyntheticCorpus({ milestone: milestone.id, seed: "ownership-shape" });
  assert.equal(new Set(corpus.atoms.map(({ owner_id }) => owner_id)).size, milestone.active_employees);
  const privateFacts = corpus.atoms.filter(({ policy_id }) => policy_id === POLICY_RESTRICTED_REVIEWER);
  assert.equal(new Set(privateFacts.map(({ reviewer_principal_id }) => reviewer_principal_id)).size, milestone.active_employees);
  assert.equal(new Set(privateFacts.map(({ reviewer_membership_id }) => reviewer_membership_id)).size, milestone.active_employees);
  for (const atoms of Object.values(Object.groupBy(corpus.atoms, ({ source_id }) => source_id))) {
    assert.equal(atoms.length, contract.workload.atoms_per_approved_meeting);
    assert.equal(new Set(atoms.map(({ owner_id }) => owner_id)).size, 1);
  }
});
