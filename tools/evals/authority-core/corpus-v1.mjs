import { createHash } from "node:crypto";

/**
 * Provider-free synthetic corpus templates for Authority core capacity.
 *
 * This module deliberately has no import from a candidate package.  The
 * analyzer/ranking contract it independently implements is taken from
 * packages/organization-retrieval/src/application/analyzer.ts at:
 * f954d0aab99025dae93d9b3fb076d74cea22399c50cc5264f42f6b1a2601e2ff
 */
export const ANALYZER_SOURCE_SHA256 =
  "f954d0aab99025dae93d9b3fb076d74cea22399c50cc5264f42f6b1a2601e2ff";
export const VOCABULARY_SIZE = 4096;
export const ZIPF_EXPONENT = 1.1;
export const POLICY_ORGANIZATION_MEMBER = "organization-member-readable-person-v2";
export const POLICY_RESTRICTED_REVIEWER = "restricted-reviewer-person-v2";

const DECISION_FAMILY = Object.freeze([
  "decision",
  "decisions",
  "decide",
  "decided",
  "deciding",
]);
const WORD_PREFIXES = Object.freeze([
  "ba", "be", "bi", "bo", "bu", "ca", "ce", "da", "de", "di",
  "fa", "fe", "ga", "ge", "ha", "ka", "la", "le", "ma", "me",
  "na", "ne", "pa", "pe", "ra", "re", "sa", "se", "ta", "te",
  "va", "ve", "za", "ze",
]);
const WORD_MIDDLES = Object.freeze([
  "la", "lan", "len", "lin", "lor", "mar", "mer", "mir", "nal", "nel",
  "nor", "ran", "ren", "rin", "sar", "sel", "ser", "tal", "tel", "tor",
]);
const WORD_SUFFIXES = Object.freeze([
  "a", "an", "ar", "el", "en", "er", "ia", "il", "in", "ir", "on",
  "or", "um", "un", "us", "y",
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function stringSeed(value) {
  const bytes = createHash("sha256").update(String(value)).digest();
  return bytes.readUInt32LE(0);
}

/** A reproducible PRNG whose result does not depend on JavaScript's Math.random. */
export function seededRandom(seed) {
  let state = (typeof seed === "number" ? seed : stringSeed(seed)) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function base26(value) {
  let remaining = value;
  let result = "";
  do {
    result = String.fromCharCode(97 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26);
  } while (remaining > 0);
  return result;
}

/**
 * Produces pronounceable-ish, lower-case alphabetic words.  The final suffix
 * makes the 4,096 values unique without leaking numerical marker syntax.
 */
export function buildVocabulary(size = VOCABULARY_SIZE) {
  if (!Number.isInteger(size) || size < 1 || size > VOCABULARY_SIZE) {
    throw new Error("vocabulary size must be an integer from 1 through 4096");
  }
  const vocabulary = [];
  const used = new Set();
  for (let index = 0; vocabulary.length < size; index += 1) {
    const word = `${WORD_PREFIXES[index % WORD_PREFIXES.length]}${
      WORD_MIDDLES[Math.floor(index / WORD_PREFIXES.length) % WORD_MIDDLES.length]
    }${WORD_SUFFIXES[Math.floor(index / (WORD_PREFIXES.length * WORD_MIDDLES.length)) % WORD_SUFFIXES.length]}${
      base26(Math.floor(index / (WORD_PREFIXES.length * WORD_MIDDLES.length * WORD_SUFFIXES.length)))
    }`;
    if (word.length < 4 || word.length > 12 || used.has(word)) continue;
    used.add(word);
    vocabulary.push(word);
  }
  return Object.freeze(vocabulary);
}

function zipfCdf(size, exponent) {
  let total = 0;
  for (let rank = 1; rank <= size; rank += 1) total += rank ** -exponent;
  let accumulated = 0;
  const cdf = [];
  for (let rank = 1; rank <= size; rank += 1) {
    accumulated += rank ** -exponent / total;
    cdf.push(accumulated);
  }
  cdf[cdf.length - 1] = 1;
  return cdf;
}

function sampleZipf(cdf, random) {
  const needle = random();
  let low = 0;
  let high = cdf.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (cdf[middle] >= needle) high = middle;
    else low = middle + 1;
  }
  return low;
}

function sampleFrequency(random) {
  const value = random();
  if (value < 0.7) return 1;
  if (value < 0.9) return 2;
  return 3;
}

function chooseUniqueTerms({ vocabulary, cdf, random, count, reserved = [] }) {
  const terms = new Set(reserved);
  let attempts = 0;
  while (terms.size < count) {
    if (attempts > count * 1000) throw new Error("unable to sample distinct corpus terms");
    terms.add(vocabulary[sampleZipf(cdf, random)]);
    attempts += 1;
  }
  return [...terms];
}

function itemKindFor(index) {
  return index % 10 === 0 ? "decision" : index % 2 === 0 ? "action" : "rationale";
}

function buildAtom({ index, logPosition, ownerCount, vocabulary, cdf, random, ageBucket, historyDays }) {
  const itemKind = itemKindFor(index);
  // "decision" is a controlled category posting under the real analyzer. It
  // must therefore be counted in the fixed 25 posting budget.
  const contentTermCount = itemKind === "decision" ? 24 : 25;
  const terms = chooseUniqueTerms({ vocabulary, cdf, random, count: contentTermCount });
  const renderedTerms = [];
  for (const term of terms) {
    const frequency = sampleFrequency(random);
    for (let repeat = 0; repeat < frequency; repeat += 1) renderedTerms.push(term);
  }
  // Distribute the 70/30 policy split through time while retaining the exact
  // floor(0.7 * atom_count) organization-member total at every milestone.
  const policyId = Math.floor(((index + 1) * 7) / 10) > Math.floor((index * 7) / 10)
    ? POLICY_ORGANIZATION_MEMBER
    : POLICY_RESTRICTED_REVIEWER;
  // Keep all five facts from a meeting with one owner. Rotating per atom would
  // couple reviewer identities to the repeating 70/30 policy pattern.
  const ownerIndex = Math.floor(index / 5) % ownerCount;
  const atomBase = {
    owner_id: `owner-${String(ownerIndex).padStart(3, "0")}`,
    source_id: `source-${String(Math.floor(index / 5)).padStart(8, "0")}`,
    source_revision: 1,
    atom_order: index % 5,
    log_position: logPosition,
    item_kind: itemKind,
    text: renderedTerms.join(" "),
    policy_id: policyId,
    reviewer_principal_id:
      policyId === POLICY_RESTRICTED_REVIEWER
        ? `employee-${String(ownerIndex).padStart(3, "0")}`
        : null,
    reviewer_membership_id:
      policyId === POLICY_RESTRICTED_REVIEWER
        ? `membership-${String(ownerIndex).padStart(3, "0")}`
        : null,
    age_bucket: ageBucket,
    source_age_days: Math.max(0, Math.floor((ageBucket * historyDays) / 9)),
  };
  const atomId = digest({ kind: "authority-capacity-v1-atom", ...atomBase });
  const contentDigest = createHash("sha256").update(atomBase.text).digest("hex");
  const recordHash = digest({ kind: "authority-capacity-v1-record", atom_id: atomId, ...atomBase });
  return Object.freeze({
    ...atomBase,
    atom_id: atomId,
    content_digest: contentDigest,
    record_hash: recordHash,
  });
}

function milestoneShape(milestone) {
  const shapes = {
    M1: { atoms: 350, historyDays: 30, workdays: 20, owners: 10 },
    M2: { atoms: 21875, historyDays: 365, workdays: 250, owners: 50 },
    M3: { atoms: 218750, historyDays: 730, workdays: 500, owners: 250 },
  };
  const shape = shapes[milestone];
  if (shape === undefined) throw new Error(`unsupported milestone: ${milestone}`);
  return shape;
}

export function analyzeDocument(text, itemKind) {
  if (text !== text.normalize("NFC")) throw new Error("document text must be NFC");
  const frequencies = new Map();
  for (const run of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const term = run.toLowerCase().normalize("NFC");
    if (Buffer.byteLength(term, "utf8") <= 64) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
  }
  if (itemKind === "decision") frequencies.set("decision", (frequencies.get("decision") ?? 0) + 1);
  return frequencies;
}

export function analyzeQuery(query) {
  if (query !== query.normalize("NFC")) throw new Error("query must be NFC");
  const terms = [];
  const observed = new Set();
  for (const run of query.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const term = run.toLowerCase().normalize("NFC");
    if (Buffer.byteLength(term, "utf8") > 64) throw new Error("query term exceeds 64 UTF-8 bytes");
    if (!observed.has(term)) {
      observed.add(term);
      terms.push(term);
    }
  }
  if (terms.length === 0 || terms.length > 32) throw new Error("query must contain one through 32 unique terms");
  if (terms.some((term) => DECISION_FAMILY.includes(term))) {
    for (const term of DECISION_FAMILY) {
      if (!observed.has(term)) terms.push(term);
    }
  }
  return Object.freeze(terms);
}

export function logicalPostings(atoms) {
  const postings = [];
  for (const atom of atoms) {
    for (const [term, termFrequency] of analyzeDocument(atom.text, atom.item_kind)) {
      postings.push(Object.freeze({ term, atom_id: atom.atom_id, term_frequency: termFrequency }));
    }
  }
  return Object.freeze(postings.sort(comparePostings));
}

function comparePostings(left, right) {
  return left.term.localeCompare(right.term, "en") ||
    left.atom_id.localeCompare(right.atom_id, "en") ||
    left.term_frequency - right.term_frequency;
}

/**
 * Build a corpus at an exact immutable head.  Later harness stages can append
 * atoms by creating a new corpus with a later head; no query result is stored
 * in this object.
 */
export function buildSyntheticCorpus({ milestone = "M1", seed = "capacity-v1" } = {}) {
  const shape = milestoneShape(milestone);
  const vocabulary = buildVocabulary();
  const cdf = zipfCdf(vocabulary.length, ZIPF_EXPONENT);
  const random = seededRandom(seed);
  const atoms = [];
  for (let index = 0; index < shape.atoms; index += 1) {
    const ageBucket = Math.min(9, Math.floor((index * 10) / shape.atoms));
    atoms.push(buildAtom({
      index,
      logPosition: index + 1,
      ownerCount: shape.owners,
      vocabulary,
      cdf,
      random,
      ageBucket,
      historyDays: shape.historyDays,
    }));
  }
  const corpus = Object.freeze({
    kind: "authority-capacity-v1-corpus",
    milestone,
    seed: String(seed),
    vocabulary,
    atoms: Object.freeze(atoms),
    history_calendar_days: shape.historyDays,
    history_workdays: shape.workdays,
    admitted_owner_count: shape.owners,
    lineage_id: digest({ kind: "authority-capacity-v1-lineage", milestone, seed: String(seed) }),
    exact_head: Object.freeze({
      lineage_id: digest({ kind: "authority-capacity-v1-lineage", milestone, seed: String(seed) }),
      position: atoms.length,
      hash: digest(atoms.map((atom) => atom.record_hash)),
    }),
  });
  assertCorpusShape(corpus);
  return corpus;
}

export function appendSyntheticAtoms(corpus, { count = 1, seed = "append" } = {}) {
  if (!Number.isInteger(count) || count < 1) throw new Error("append count must be a positive integer");
  const cdf = zipfCdf(corpus.vocabulary.length, ZIPF_EXPONENT);
  const random = seededRandom(`${corpus.seed}:${seed}:${corpus.atoms.length}`);
  const atoms = [...corpus.atoms];
  for (let offset = 0; offset < count; offset += 1) {
    const index = atoms.length;
    atoms.push(buildAtom({
      index,
      logPosition: index + 1,
      ownerCount: corpus.admitted_owner_count,
      vocabulary: corpus.vocabulary,
      cdf,
      random,
      ageBucket: 0,
      historyDays: corpus.history_calendar_days,
    }));
  }
  return Object.freeze({
    ...corpus,
    atoms: Object.freeze(atoms),
    exact_head: Object.freeze({
      lineage_id: corpus.lineage_id,
      position: atoms.length,
      hash: digest(atoms.map((atom) => atom.record_hash)),
    }),
  });
}

export function atomsAtHead(corpus, exactHead) {
  if (!exactHead || !Number.isInteger(exactHead.position) || exactHead.position < 0) {
    throw new Error("exact head must have a non-negative integer position");
  }
  if (exactHead.position > corpus.atoms.length) throw new Error("exact head is beyond corpus");
  if (exactHead.lineage_id !== corpus.lineage_id) throw new Error("exact head belongs to a different record lineage");
  const atoms = corpus.atoms.filter((atom) => atom.log_position <= exactHead.position);
  const actualHash = digest(atoms.map((atom) => atom.record_hash));
  if (actualHash !== exactHead.hash) throw new Error("exact head hash does not bind corpus records");
  return Object.freeze(atoms);
}

export function headForPosition(corpus, position) {
  if (!Number.isInteger(position) || position < 0 || position > corpus.atoms.length) {
    throw new Error("head position is outside corpus");
  }
  const atoms = corpus.atoms.filter((atom) => atom.log_position <= position);
  return Object.freeze({
    lineage_id: corpus.lineage_id,
    position,
    hash: digest(atoms.map((atom) => atom.record_hash)),
  });
}

export function assertCorpusShape(corpus) {
  const expected = milestoneShape(corpus.milestone);
  if (corpus.atoms.length !== expected.atoms) throw new Error("corpus atom count differs from milestone");
  const postingCount = logicalPostings(corpus.atoms).length;
  if (postingCount !== corpus.atoms.length * 25) throw new Error("corpus must have exactly 25 logical postings per atom");
  const expectedOrganization = Math.floor((corpus.atoms.length * 7) / 10);
  const organization = corpus.atoms.filter((atom) => atom.policy_id === POLICY_ORGANIZATION_MEMBER).length;
  if (organization !== expectedOrganization) throw new Error("corpus must have a 70/30 policy split with deterministic floor rounding");
  const buckets = Array.from({ length: 10 }, (_, bucket) => corpus.atoms.filter((atom) => atom.age_bucket === bucket).length);
  if (buckets.some((count) => count === 0) || Math.max(...buckets) - Math.min(...buckets) > 1) {
    throw new Error("corpus age buckets must be balanced");
  }
  if (!corpus.atoms.some((atom) => atom.source_age_days >= corpus.history_calendar_days)) {
    throw new Error("corpus must include at least one full-age source");
  }
  return Object.freeze({ posting_count: postingCount, age_buckets: Object.freeze(buckets) });
}
