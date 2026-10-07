import { createHash } from "node:crypto";
import {
  ANALYZER_SOURCE_SHA256,
  POLICY_ORGANIZATION_MEMBER,
  POLICY_RESTRICTED_REVIEWER,
  analyzeDocument,
  analyzeQuery,
  atomsAtHead,
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

export function compareCandidates(left, right) {
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

/**
 * Scoring contract "echo-bm25-fixed-point-v1", reimplemented here without
 * importing the candidate: Okapi BM25 (k1 1.2, b 0.75), Robertson/Sparck-Jones
 * IDF with the +1 floor, fixed-point integers at scale 1e6, corpus statistics
 * taken over exactly the atoms this reader is authorized to read, and the
 * closed decision family weighted as a constant unit instead of IDF.
 */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const SCORE_SCALE = 1_000_000;
const CONTROLLED_TERMS = new Set(["decision", "decisions", "decide", "decided", "deciding"]);

export function inverseDocumentFrequency(documentFrequency, documentCount) {
  if (documentFrequency <= 0 || documentCount <= 0) return 0;
  return Math.round(Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5)) * SCORE_SCALE);
}

export function bm25Score(frequencies, documentLength, terms, statistics) {
  const averageLength = statistics.document_count === 0 ? 0 : statistics.total_term_count / statistics.document_count;
  let score = 0;
  for (const term of terms) {
    const frequency = frequencies.get(term) ?? 0;
    if (frequency === 0) continue;
    const normalized = averageLength === 0
      ? 1
      : (frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * documentLength) / averageLength));
    const weight = CONTROLLED_TERMS.has(term)
      ? SCORE_SCALE
      : inverseDocumentFrequency(statistics.document_frequency.get(term) ?? 0, statistics.document_count);
    score += Math.round(weight * normalized);
  }
  return score;
}

export function searchAtHead({ corpus, exactHead, reader, query, limit = 10 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("search limit must be 1 through 10");
  const terms = analyzeQuery(query);
  const authorized = [];
  const document_frequency = new Map();
  let total_term_count = 0;
  for (const atom of atomsAtHead(corpus, exactHead)) {
    if (!isAuthorized(atom, reader)) continue;
    const frequencies = analyzeDocument(atom.text, atom.item_kind);
    let length = 0;
    for (const [term, frequency] of frequencies) {
      length += frequency;
      document_frequency.set(term, (document_frequency.get(term) ?? 0) + 1);
    }
    total_term_count += length;
    authorized.push({ atom, frequencies, length });
  }
  const statistics = { document_count: authorized.length, total_term_count, document_frequency };
  const candidates = [];
  for (const { atom, frequencies, length } of authorized) {
    const score = bm25Score(frequencies, length, terms, statistics);
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
