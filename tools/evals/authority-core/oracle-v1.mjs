import { createHash } from "node:crypto";
import {
  ANALYZER_SOURCE_SHA256,
  POLICY_ORGANIZATION_MEMBER,
  POLICY_RESTRICTED_REVIEWER,
  analyzeDocument,
  analyzeQuery,
  atomsAtHead,
  headForPosition,
  logicalPostings,
  seededRandom,
} from "./corpus-v1.mjs";

/**
 * Independent core search oracle. This is intentionally a plain JS
 * reimplementation, not an adapter around organization-retrieval.  Its source
 * contract is analyzer.ts SHA-256 ANALYZER_SOURCE_SHA256.
 */
export { ANALYZER_SOURCE_SHA256 };

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareCandidates(left, right) {
  if (left.score !== right.score) return right.score - left.score;
  if (left.log_position !== right.log_position) return right.log_position - left.log_position;
  if (left.atom_order !== right.atom_order) return left.atom_order - right.atom_order;
  return Buffer.compare(Buffer.from(left.atom_id), Buffer.from(right.atom_id));
}

export function isAuthorized(atom, reader) {
  if (atom.policy_id === POLICY_ORGANIZATION_MEMBER) return true;
  return atom.policy_id === POLICY_RESTRICTED_REVIEWER &&
    atom.reviewer_principal_id === reader.principal_id &&
    atom.reviewer_membership_id === reader.membership_id;
}

function itemForResult(atom) {
  return Object.freeze({
    atom_id: atom.atom_id,
    record_hash: atom.record_hash,
    policy_id: atom.policy_id,
    content_digest: atom.content_digest,
    text_digest: sha256(atom.text),
    text: atom.text,
    record_position: atom.log_position,
    atom_order: atom.atom_order,
  });
}

export function searchAtHead({ corpus, exactHead, reader, query, limit = 10 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("search limit must be 1 through 10");
  const terms = analyzeQuery(query);
  const candidates = [];
  for (const atom of atomsAtHead(corpus, exactHead)) {
    if (!isAuthorized(atom, reader)) continue;
    const frequencies = analyzeDocument(atom.text, atom.item_kind);
    const score = terms.reduce((total, term) => total + (frequencies.get(term) ?? 0), 0);
    if (score === 0) continue;
    candidates.push({ ...atom, score });
  }
  candidates.sort(compareCandidates);
  return Object.freeze({
    exact_head: exactHead,
    terms,
    authorized_candidate_count: candidates.length,
    items: Object.freeze(candidates.slice(0, limit).map(itemForResult)),
  });
}

function resultIdentity(item) {
  return `${item.atom_id}\u0000${item.record_hash}\u0000${item.policy_id}\u0000${item.content_digest}`;
}

function sameHeadIdentity(left, right) {
  return left?.lineage_id === right?.lineage_id &&
    left?.position === right?.position &&
    left?.hash === right?.hash;
}

function assertSameItems(expected, actual) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    throw new Error("search result does not contain the entire expected top-k");
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (resultIdentity(expected[index]) !== resultIdentity(actual[index]) ||
        actual[index].text !== expected[index].text ||
        sha256(actual[index].text) !== expected[index].text_digest) {
      throw new Error(`search result differs at rank ${index + 1}`);
    }
  }
}

/**
 * Verify one direct-search response against an independent active-head ledger.
 * The runner records one same-lineage active pointer at offer and one when it
 * releases the response. A result must bind the release observation; when no
 * publication intervened that is the offer head, otherwise it is the newer
 * release head. A response at any older head is a failure even when its
 * ranking is otherwise correct. Thus no start/end snapshot oracle exists.
 */
export function assertDirectSearchResponse({
  corpus,
  reader,
  query,
  offer_head: offerHead,
  response,
  independently_observed_active_heads: observedHeads,
  release_head: releaseHead,
  current_person_release_fence: personFence,
}) {
  if (!response || !response.exact_head || !Array.isArray(observedHeads) || !releaseHead || !personFence) {
    throw new Error("response, offer/release observed heads, and a current Person release fence are required");
  }
  const observedOffer = observedHeads.find((head) => sameHeadIdentity(head, offerHead));
  if (observedOffer === undefined) throw new Error("offer head was not independently observed as active");
  const observedRelease = observedHeads.find((head) => sameHeadIdentity(head, releaseHead));
  if (observedRelease === undefined) throw new Error("release head was not independently observed as active");
  if (observedRelease.lineage_id !== observedOffer.lineage_id) {
    throw new Error("release head belongs to a different record lineage than the offer head");
  }
  if (observedRelease.position < observedOffer.position) {
    throw new Error("release head is older than the independently observed offer head");
  }
  if (!sameHeadIdentity(response.exact_head, observedRelease)) {
    throw new Error("response does not bind the independently observed active release head");
  }
  if (!response.release_fence || !sameHeadIdentity(response.release_fence.exact_record_head, observedRelease)) {
    throw new Error("response was not released under its independently observed exact record head");
  }
  if (response.release_fence.principal_id !== reader.principal_id ||
      response.release_fence.membership_id !== reader.membership_id ||
      response.release_fence.current_person_version !== personFence.current_person_version) {
    throw new Error("response does not meet the current Person release fence");
  }
  const expected = searchAtHead({ corpus, exactHead: observedRelease, reader, query, limit: 10 });
  assertSameItems(expected.items, response.items);
  return expected;
}

function candidateCountFor(corpus, head, reader, query) {
  return searchAtHead({ corpus, exactHead: head, reader, query, limit: 10 }).authorized_candidate_count;
}

function selectPairQuery(corpus, head, reader, excludedQueries = new Set()) {
  const atoms = atomsAtHead(corpus, head).filter((atom) => isAuthorized(atom, reader));
  const singleFrequency = new Map();
  const atomIdsByTerm = new Map();
  for (const atom of atoms) {
    const terms = [...analyzeDocument(atom.text, atom.item_kind).keys()].filter((term) => term !== "decision").sort();
    for (const term of terms) {
      singleFrequency.set(term, (singleFrequency.get(term) ?? 0) + 1);
      const ids = atomIdsByTerm.get(term) ?? [];
      ids.push(atom.atom_id);
      atomIdsByTerm.set(term, ids);
    }
  }
  // Intersect only selected term posting lists. Building all 300 term pairs
  // per atom would create tens of millions of entries at M3.
  const intersection = (left, right) => {
    const rightIds = new Set(right);
    return left.filter((atomId) => rightIds.has(atomId));
  };
  for (const atom of atoms) {
    const selectiveFrequencyMaximum = Math.max(20, Math.ceil(Math.sqrt(atoms.length) * 4));
    const terms = [...analyzeDocument(atom.text, atom.item_kind).keys()]
      .filter((term) => term !== "decision" && singleFrequency.get(term) >= 2 && singleFrequency.get(term) <= selectiveFrequencyMaximum)
      .sort((left, right) => singleFrequency.get(left) - singleFrequency.get(right));
    for (let left = 0; left < terms.length; left += 1) {
      for (let right = left + 1; right < terms.length; right += 1) {
        const atomIds = intersection(atomIdsByTerm.get(terms[left]), atomIdsByTerm.get(terms[right]));
        if (atomIds.length !== 1 || atomIds[0] !== atom.atom_id) continue;
        const query = `${terms[left]} ${terms[right]}`;
        if (excludedQueries.has(query)) continue;
        const result = searchAtHead({ corpus, exactHead: head, reader, query });
        if (result.items.some((item) => item.atom_id === atom.atom_id)) {
          return Object.freeze({ kind: "selective", query, target_atom_id: atom.atom_id, candidate_count: result.authorized_candidate_count });
        }
      }
    }
  }
  throw new Error("unable to construct a selective query with a unique co-occurrence");
}

function topVocabularyTerms(corpus, head, reader) {
  const frequencies = new Map();
  for (const atom of atomsAtHead(corpus, head)) {
    if (!isAuthorized(atom, reader)) continue;
    for (const term of analyzeDocument(atom.text, atom.item_kind).keys()) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
  }
  return [...frequencies.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "en"));
}

function positiveQuery({ corpus, head, reader, kind, minimumCandidates, termCount, startOffset = 0 }) {
  const rankedTerms = topVocabularyTerms(corpus, head, reader).map(([term]) => term).filter((term) => term !== "decision");
  const attempts = Math.min(12, rankedTerms.length - termCount + 1);
  for (let relative = 0; relative < attempts; relative += 1) {
    // Try the requested variant first, then fall back through the hottest
    // ordinary vocabulary terms. This preserves the declared candidate shape
    // without an unbounded scan through 4,096 terms during sealing.
    const offset = relative === 0
      ? startOffset % (rankedTerms.length - termCount + 1)
      : relative - 1;
    const query = rankedTerms.slice(offset, offset + termCount).join(" ");
    const candidateCount = candidateCountFor(corpus, head, reader, query);
    if (candidateCount >= minimumCandidates) {
      return Object.freeze({ kind, query, candidate_count: candidateCount });
    }
  }
  throw new Error(`unable to construct ${kind} query with ${minimumCandidates} authorized candidates`);
}

function absentTerm(corpus, random) {
  const present = new Set(logicalPostings(corpus.atoms).map((posting) => posting.term));
  for (let sequence = 0; sequence < 10000; sequence += 1) {
    const candidate = `noral${String.fromCharCode(97 + Math.floor(random() * 26))}${String.fromCharCode(97 + Math.floor(random() * 26))}${String.fromCharCode(97 + Math.floor(random() * 26))}`;
    if (!present.has(candidate)) return candidate;
  }
  throw new Error("unable to produce an absent ordinary-looking term");
}

/**
 * Generate held-out search shapes.  Each plan deliberately contains queries,
 * not expected answers. Expected ranking is calculated only from the
 * independently observed active head at response verification time.
 */
export function buildQueryPlan({ corpus, reader, count = 100, seed = "queries", exact_head: exactHead = corpus.exact_head }) {
  if (!Number.isInteger(count) || count < 10) throw new Error("query count must be an integer of at least ten");
  const random = seededRandom(seed);
  const broadMinimum = corpus.milestone === "M1" ? 200 : 1000;
  const classes = [
    ["selective", Math.round(count * 0.4)],
    ["medium", Math.round(count * 0.3)],
    ["broad", Math.round(count * 0.2)],
  ];
  const built = [];
  const selectiveQueries = new Set();
  const selectiveVariants = [];
  for (const [kind, amount] of classes) {
    for (let index = 0; index < amount; index += 1) {
      if (kind === "selective") {
        // M1 has only a small query population. Eight distinct held-out pairs
        // avoid a marker-like single lookup while keeping sealing bounded;
        // remaining selective offers reuse that diverse ordinary-term pool.
        if (selectiveVariants.length < Math.min(amount, 8)) {
          const entry = selectPairQuery(corpus, exactHead, reader, selectiveQueries);
          selectiveQueries.add(entry.query);
          selectiveVariants.push(entry);
        }
        built.push(selectiveVariants[index % selectiveVariants.length]);
      }
      if (kind === "medium") built.push(positiveQuery({ corpus, head: exactHead, reader, kind, minimumCandidates: 100, termCount: 2 + (index % 3), startOffset: index }));
      if (kind === "broad") built.push(positiveQuery({ corpus, head: exactHead, reader, kind, minimumCandidates: broadMinimum, termCount: 1 + (index % 3), startOffset: index }));
    }
  }
  while (built.length < count) {
    const query = `${absentTerm(corpus, random)} ${absentTerm(corpus, random)}`;
    if (candidateCountFor(corpus, exactHead, reader, query) !== 0) throw new Error("negative query unexpectedly matched");
    built.push(Object.freeze({ kind: "negative", query, candidate_count: 0 }));
  }
  return Object.freeze(built.slice(0, count));
}

/** Compare every logical fact and posting; no candidate-supplied root is trusted. */
export function assertCompleteLogicalIndex({ corpus, exact_head: exactHead, actual }) {
  if (!actual || !Array.isArray(actual.facts) || !Array.isArray(actual.postings)) {
    throw new Error("actual decoded facts and postings are required");
  }
  const atoms = atomsAtHead(corpus, exactHead);
  const expectedFacts = atoms.map((atom) => ({
    atom_id: atom.atom_id,
    record_hash: atom.record_hash,
    policy_id: atom.policy_id,
    content_digest: atom.content_digest,
    reviewer_principal_id: atom.reviewer_principal_id,
    reviewer_membership_id: atom.reviewer_membership_id,
    text: atom.text,
    log_position: atom.log_position,
    atom_order: atom.atom_order,
    item_kind: atom.item_kind,
  })).sort((left, right) => left.atom_id.localeCompare(right.atom_id, "en"));
  const actualFacts = actual.facts.map((fact) => ({
    atom_id: fact.atom_id,
    record_hash: fact.record_hash,
    policy_id: fact.policy_id,
    content_digest: fact.content_digest,
    reviewer_principal_id: fact.reviewer_principal_id,
    reviewer_membership_id: fact.reviewer_membership_id,
    text: fact.text,
    log_position: fact.log_position,
    atom_order: fact.atom_order,
    item_kind: fact.item_kind,
  })).sort((left, right) => left.atom_id.localeCompare(right.atom_id, "en"));
  if (JSON.stringify(actualFacts) !== JSON.stringify(expectedFacts)) {
    throw new Error("decoded index facts differ from independently derived approved facts");
  }
  const expectedPostings = logicalPostings(atoms);
  const actualPostings = actual.postings.map((posting) => ({
    term: posting.term,
    atom_id: posting.atom_id,
    term_frequency: posting.term_frequency,
  })).sort((left, right) =>
    left.term.localeCompare(right.term, "en") || left.atom_id.localeCompare(right.atom_id, "en") || left.term_frequency - right.term_frequency,
  );
  if (JSON.stringify(actualPostings) !== JSON.stringify(expectedPostings)) {
    throw new Error("decoded index postings differ from the complete independent logical posting multiset");
  }
  return Object.freeze({ facts: expectedFacts.length, postings: expectedPostings.length });
}

/** Test utility for producing a response-like object from an independently chosen head. */
export function oracleResponse({
  corpus,
  reader,
  query,
  head_position = corpus.exact_head.position,
  current_person_version = "oracle-person-v1",
}) {
  const exactHead = headForPosition(corpus, head_position);
  const expected = searchAtHead({ corpus, exactHead, reader, query });
  return Object.freeze({
    exact_head: exactHead,
    items: expected.items,
    release_fence: Object.freeze({
      exact_record_head: exactHead,
      principal_id: reader.principal_id,
      membership_id: reader.membership_id,
      current_person_version,
    }),
  });
}
