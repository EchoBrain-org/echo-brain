import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ageBucketForSource,
  buildSyntheticCorpus,
  ownerIndexForSource,
  POLICY_ORGANIZATION_MEMBER,
  POLICY_RESTRICTED_REVIEWER,
  policyForSource,
} from "../corpus-v1.mjs";

const contract = JSON.parse(readFileSync(new URL("../metrics.v3.json", import.meta.url)));

test("M1 history represents every contracted employee with coherent meeting ownership and policy", () => {
  const milestone = contract.milestones.find(({ id }) => id === "M1");
  const corpus = buildSyntheticCorpus({ milestone: milestone.id, seed: "ownership-shape" });
  assert.equal(new Set(corpus.atoms.map(({ owner_id }) => owner_id)).size, milestone.active_employees);
  const privateFacts = corpus.atoms.filter(({ policy_id }) => policy_id === POLICY_RESTRICTED_REVIEWER);
  assert.equal(new Set(privateFacts.map(({ reviewer_principal_id }) => reviewer_principal_id)).size, milestone.active_employees);
  assert.equal(new Set(privateFacts.map(({ reviewer_membership_id }) => reviewer_membership_id)).size, milestone.active_employees);
  for (const atoms of Object.values(Object.groupBy(corpus.atoms, ({ source_id }) => source_id))) {
    assert.equal(atoms.length, contract.workload.atoms_per_approved_meeting);
    assert.equal(new Set(atoms.map(({ owner_id }) => owner_id)).size, 1);
    assert.equal(new Set(atoms.map(({ policy_id }) => policy_id)).size, 1);
    assert.equal(new Set(atoms.map(({ reviewer_principal_id }) => reviewer_principal_id)).size, 1);
    assert.equal(new Set(atoms.map(({ reviewer_membership_id }) => reviewer_membership_id)).size, 1);
    assert.equal(new Set(atoms.map(({ age_bucket }) => age_bucket)).size, 1);
    assert.equal(new Set(atoms.map(({ source_age_days }) => source_age_days)).size, 1);
  }
});

test("every V3 milestone rounds source-level policy, owner, and age assignments without materializing history", () => {
  for (const milestone of contract.milestones) {
    const meetingCount = milestone.historical_atoms_min / contract.workload.atoms_per_approved_meeting;
    let sharedMeetings = 0;
    const restrictedOwners = new Set();
    const ageBuckets = Array(10).fill(0);
    for (let sourceIndex = 0; sourceIndex < meetingCount; sourceIndex += 1) {
      if (policyForSource(sourceIndex) === POLICY_ORGANIZATION_MEMBER) sharedMeetings += 1;
      else restrictedOwners.add(ownerIndexForSource(sourceIndex, milestone.active_employees));
      ageBuckets[ageBucketForSource(sourceIndex, meetingCount)] += 1;
    }
    assert.equal(sharedMeetings, Math.floor((meetingCount * 7) / 10));
    assert.equal(meetingCount - sharedMeetings, Math.ceil((meetingCount * 3) / 10));
    assert.equal(restrictedOwners.size, milestone.active_employees);
    assert.ok(ageBuckets.every((count) => count > 0));
    assert.ok(Math.max(...ageBuckets) - Math.min(...ageBuckets) <= 1);
  }
});
