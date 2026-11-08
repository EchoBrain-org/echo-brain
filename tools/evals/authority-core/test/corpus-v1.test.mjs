import assert from "node:assert/strict";
import test from "node:test";
import { buildSyntheticCorpus, POLICY_RESTRICTED_REVIEWER } from "../corpus-v1.mjs";

// M1 history: ten active employees; every approved meeting holds five facts.
const M1_ACTIVE_EMPLOYEES = 10;
const ATOMS_PER_APPROVED_MEETING = 5;

test("M1 history represents every contracted employee with coherent meeting ownership and policy", () => {
  const corpus = buildSyntheticCorpus({ milestone: "M1", seed: "ownership-shape" });
  assert.equal(new Set(corpus.atoms.map(({ owner_id }) => owner_id)).size, M1_ACTIVE_EMPLOYEES);
  const privateFacts = corpus.atoms.filter(({ policy_id }) => policy_id === POLICY_RESTRICTED_REVIEWER);
  assert.equal(new Set(privateFacts.map(({ reviewer_principal_id }) => reviewer_principal_id)).size, M1_ACTIVE_EMPLOYEES);
  assert.equal(new Set(privateFacts.map(({ reviewer_membership_id }) => reviewer_membership_id)).size, M1_ACTIVE_EMPLOYEES);
  for (const atoms of Object.values(Object.groupBy(corpus.atoms, ({ source_id }) => source_id))) {
    assert.equal(atoms.length, ATOMS_PER_APPROVED_MEETING);
    assert.equal(new Set(atoms.map(({ owner_id }) => owner_id)).size, 1);
    assert.equal(new Set(atoms.map(({ policy_id }) => policy_id)).size, 1);
    assert.equal(new Set(atoms.map(({ reviewer_principal_id }) => reviewer_principal_id)).size, 1);
    assert.equal(new Set(atoms.map(({ reviewer_membership_id }) => reviewer_membership_id)).size, 1);
    assert.equal(new Set(atoms.map(({ age_bucket }) => age_bucket)).size, 1);
    assert.equal(new Set(atoms.map(({ source_age_days }) => source_age_days)).size, 1);
  }
});
