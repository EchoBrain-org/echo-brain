import assert from "node:assert/strict";
import test from "node:test";
import {
  POLICY_ORGANIZATION_MEMBER,
  assertCorpusShape,
  appendSyntheticAtoms,
  buildSyntheticCorpus,
  headForPosition,
  logicalPostings,
} from "../corpus-v1.mjs";
import {
  ANALYZER_SOURCE_SHA256,
  assertCompleteLogicalIndex,
  assertDirectSearchResponse,
  buildQueryPlan,
  oracleResponse,
  searchAtHead,
} from "../oracle-v1.mjs";

const reader = Object.freeze({ principal_id: "employee-000", membership_id: "membership-000" });
const personFence = Object.freeze({ current_person_version: "oracle-person-v1" });

function decodedIndex(corpus, exactHead = corpus.exact_head) {
  const atoms = corpus.atoms.filter((atom) => atom.log_position <= exactHead.position);
  return {
    facts: atoms.map((atom) => ({
      atom_id: atom.atom_id,
      record_hash: atom.record_hash,
      policy_id: atom.policy_id,
      content_digest: atom.content_digest,
      reviewer_principal_id: atom.reviewer_principal_id,
      reviewer_membership_id: atom.reviewer_membership_id,
      text: atom.text,
    })),
    postings: [...logicalPostings(atoms)],
  };
}

test("M1 generator is deterministic and fulfills corpus shape", () => {
  const first = buildSyntheticCorpus({ milestone: "M1", seed: "oracle-test" });
  const second = buildSyntheticCorpus({ milestone: "M1", seed: "oracle-test" });
  assert.equal(first.exact_head.hash, second.exact_head.hash);
  assert.equal(first.atoms.length, 350);
  assert.deepEqual(assertCorpusShape(first), { posting_count: 8750, age_buckets: Array(10).fill(35) });
  assert.equal(ANALYZER_SOURCE_SHA256, "f954d0aab99025dae93d9b3fb076d74cea22399c50cc5264f42f6b1a2601e2ff");
});

test("query plan contains broad, medium, selective and ordinary negative queries", () => {
  const corpus = buildSyntheticCorpus({ milestone: "M1", seed: "query-shape" });
  const plan = buildQueryPlan({ corpus, reader, count: 20, seed: "held-out" });
  const counts = Object.groupBy(plan, ({ kind }) => kind);
  assert.equal(counts.selective.length, 8);
  assert.equal(counts.medium.length, 6);
  assert.equal(counts.broad.length, 4);
  assert.equal(counts.negative.length, 2);
  assert.ok(counts.medium.every(({ candidate_count: count }) => count >= 100));
  assert.ok(counts.broad.every(({ candidate_count: count }) => count >= 200));
  assert.ok(counts.negative.every(({ candidate_count: count }) => count === 0));
});

test("direct-search expected ranking follows response's independently observed current head", () => {
  const before = buildSyntheticCorpus({ milestone: "M1", seed: "head-change" });
  const after = appendSyntheticAtoms(before, { count: 20, seed: "new-approvals" });
  const query = after.atoms[after.atoms.length - 1].text.split(" ")[0];
  const offerHead = before.exact_head;
  const response = oracleResponse({ corpus: after, reader, query, head_position: after.exact_head.position });
  const expected = assertDirectSearchResponse({
    corpus: after,
    reader,
    query,
    offer_head: offerHead,
    response,
    independently_observed_active_heads: [offerHead, after.exact_head],
    release_head: after.exact_head,
    current_person_release_fence: personFence,
  });
  assert.equal(expected.exact_head.hash, after.exact_head.hash);
  assert.throws(() => assertDirectSearchResponse({
    corpus: after,
    reader,
    query,
    offer_head: after.exact_head,
    response: oracleResponse({ corpus: after, reader, query, head_position: before.exact_head.position }),
    independently_observed_active_heads: [offerHead, after.exact_head],
    release_head: after.exact_head,
    current_person_release_fence: personFence,
  }), /active release head/);
  assert.throws(() => assertDirectSearchResponse({
    corpus: after,
    reader,
    query,
    offer_head: offerHead,
    response,
    independently_observed_active_heads: [after.exact_head],
    release_head: after.exact_head,
    current_person_release_fence: personFence,
  }), /offer head was not independently observed/);
  assert.throws(() => assertDirectSearchResponse({
    corpus: after,
    reader,
    query,
    offer_head: offerHead,
    response,
    independently_observed_active_heads: [offerHead, after.exact_head],
    release_head: after.exact_head,
    current_person_release_fence: { current_person_version: "revoked-person-v2" },
  }), /current Person release fence/);
});

test("head changes can change broad ranking and stale snapshots are rejected", () => {
  const before = buildSyntheticCorpus({ milestone: "M1", seed: "ranking-change" });
  const after = appendSyntheticAtoms(before, { count: 100, seed: "newest-wins" });
  const possibleTerms = new Set(after.atoms.slice(before.atoms.length).flatMap((atom) => atom.text.split(" ")));
  const query = [...possibleTerms].find((term) => {
    const oldItems = searchAtHead({ corpus: before, exactHead: before.exact_head, reader, query: term }).items;
    const newItems = searchAtHead({ corpus: after, exactHead: after.exact_head, reader, query: term }).items;
    return oldItems.length > 0 && JSON.stringify(oldItems) !== JSON.stringify(newItems);
  });
  assert.ok(query, "new approvals must alter at least one matching top-ten ordering");
  const oldResponse = oracleResponse({ corpus: after, reader, query, head_position: before.exact_head.position });
  assert.throws(() => assertDirectSearchResponse({
    corpus: after,
    reader,
    query,
    offer_head: after.exact_head,
    response: oldResponse,
    independently_observed_active_heads: [before.exact_head, after.exact_head],
    release_head: after.exact_head,
    current_person_release_fence: personFence,
  }), /active release head/);
});

test("complete logical posting validation catches a candidate that drops non-query postings", () => {
  const corpus = buildSyntheticCorpus({ milestone: "M1", seed: "posting-proof" });
  const actual = decodedIndex(corpus);
  assert.deepEqual(assertCompleteLogicalIndex({ corpus, exact_head: corpus.exact_head, actual }), { facts: 350, postings: 8750 });
  actual.postings.pop();
  assert.throws(() => assertCompleteLogicalIndex({ corpus, exact_head: corpus.exact_head, actual }), /postings differ/);
});

test("complete logical posting validation catches incorrect policy and content facts", () => {
  const corpus = buildSyntheticCorpus({ milestone: "M1", seed: "fact-proof" });
  const actual = decodedIndex(corpus);
  actual.facts.find((fact) => fact.policy_id === POLICY_ORGANIZATION_MEMBER).content_digest = "0".repeat(64);
  assert.throws(() => assertCompleteLogicalIndex({ corpus, exact_head: headForPosition(corpus, 350), actual }), /facts differ/);
});

test("correct ids and digest claims cannot hide wrong returned text or reviewer ownership", () => {
  const corpus = buildSyntheticCorpus({ milestone: "M1", seed: "content-and-policy" });
  const query = corpus.atoms[0].text.split(" ")[0];
  const response = structuredClone(oracleResponse({ corpus, reader, query }));
  assert.ok(response.items.length > 0);
  response.items[0].text = "fabricated content";
  assert.throws(() => assertDirectSearchResponse({
    corpus, reader, query, response,
    offer_head: corpus.exact_head, release_head: corpus.exact_head,
    independently_observed_active_heads: [corpus.exact_head],
    current_person_release_fence: personFence,
  }), /differs at rank/);
  const actual = decodedIndex(corpus);
  const privateFact = actual.facts.find((fact) => fact.reviewer_principal_id !== null);
  assert.ok(privateFact);
  privateFact.reviewer_principal_id = "another-employee";
  assert.throws(() => assertCompleteLogicalIndex({ corpus, exact_head: corpus.exact_head, actual }), /facts differ/);
});
