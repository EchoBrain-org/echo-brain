import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POLICY_RESTRICTED_REVIEWER,
  analyzeDocument,
  appendSyntheticAtoms,
  buildSyntheticCorpus,
  seededRandom,
} from "./corpus-v1.mjs";
import { buildQueryPlan, searchAtHead } from "./oracle-v1.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CANDIDATE_DIGEST = /^[a-f0-9]{64}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function immutable(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, immutable(child)])));
}

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function requireCandidate(candidate) {
  requireRecord(candidate, "candidate");
  if (!CANDIDATE_DIGEST.test(candidate.candidate_digest ?? "")) throw new TypeError("candidate_digest must be a SHA-256 digest");
  if (candidate.milestone !== "M1") throw new TypeError("manifest V1 generator currently supports M1 only");
  return candidate;
}

function sealedSeed(candidate, sealingMaterial) {
  if (!Buffer.isBuffer(sealingMaterial) && !(sealingMaterial instanceof Uint8Array)) {
    throw new TypeError("sealing_material must be random bytes supplied after candidate registration");
  }
  if (sealingMaterial.byteLength < 32) throw new TypeError("sealing_material must contain at least 32 bytes");
  return sha256(Buffer.concat([
    Buffer.from("authority-capacity-manifest-v1\0"),
    Buffer.from(candidate.candidate_digest),
    Buffer.from(sealingMaterial),
  ]));
}

export function plannedScriptedDelay(seed, semanticRoot, stage, range, ordinal = 1) {
  const fraction = Number.parseInt(
    sha256(`${seed}\0${semanticRoot}\0${stage}\0${ordinal}`).slice(0, 13),
    16,
  ) / 0xfffffffffffff;
  return Math.round(range.min + (range.max - range.min) * fraction);
}

function generationEnvelope(semanticRoot, stage, responseValue, ordinal = 1) {
  const content = JSON.stringify(responseValue);
  return JSON.stringify({
    id: `gen-${sha256(`${semanticRoot}\0${stage}\0${ordinal}`).slice(0, 20)}`,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

function fixtureTemplate({ semantic_root, population, stage, response_value, approved_snapshot_token, oracle_evidence_requirements }) {
  const responseBytes = Buffer.byteLength(generationEnvelope(semantic_root, stage, response_value), "utf8");
  const template = {
    semantic_root,
    population,
    stage,
    // The driver mints this at actual offer time. fixtures.mjs binds it once
    // per semantic root before any provider call; a sealed manifest must never
    // predict a future offer nonce.
    offer_nonce_binding: "driver-mint-at-offer",
    response_value,
    canonical_response_bytes: responseBytes,
    runtime_request_binding: "required-from-production-serializer-at-observed-runtime-head",
  };
  if (oracle_evidence_requirements !== undefined) template.oracle_evidence_requirements = oracle_evidence_requirements;
  if (approved_snapshot_token !== undefined) template.approved_snapshot_token = approved_snapshot_token;
  return immutable(template);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function parseRuntimeRequest(serializedRequest) {
  if (typeof serializedRequest !== "string" || serializedRequest.length === 0) {
    throw new TypeError("runtime serialized request must be non-empty JSON");
  }
  let request;
  try {
    request = JSON.parse(serializedRequest);
  } catch {
    throw new TypeError("runtime serialized request must be JSON");
  }
  const root = object(request, "runtime request");
  const responseFormat = object(root.response_format, "runtime response_format");
  const schema = object(responseFormat.json_schema, "runtime JSON schema");
  if (!Array.isArray(root.messages) || root.messages.length !== 2 || typeof schema.name !== "string" || schema.name.length === 0) {
    throw new TypeError("runtime request does not have the production structured-generation shape");
  }
  const user = object(root.messages[1], "runtime user message");
  if (user.role !== "user" || typeof user.content !== "string") throw new TypeError("runtime user prompt is invalid");
  return immutable({ response_schema_name: schema.name, user_prompt: user.content });
}

function syntheticAtomIds(value, observed = new Set()) {
  if (value === null || typeof value !== "object") return observed;
  if (Array.isArray(value)) {
    for (const child of value) syntheticAtomIds(child, observed);
    return observed;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "synthetic_atom_id" || key === "expected_synthetic_atom_id") observed.add(child);
    else syntheticAtomIds(child, observed);
  }
  return observed;
}

/**
 * Materializes templates only after the production serializer has emitted a
 * request against an independently observed runtime release. The templates
 * deliberately contain no request hash or byte count because those cannot be
 * truthfully known from a synthetic corpus. This output is the input accepted
 * by fixtures.mjs.
 */
export function materializeRuntimeFixturePackets({ manifest, bindings, independently_serialize }) {
  requireRecord(manifest, "manifest");
  if (!Array.isArray(manifest.fixture_packet_templates) || !Array.isArray(bindings) || typeof independently_serialize !== "function") {
    throw new TypeError("manifest templates, runtime bindings, and an independent verifier serializer are required");
  }
  const byRootAndStage = new Map();
  for (const binding of bindings) {
    const root = object(binding, "runtime fixture binding");
    if (typeof root.semantic_root !== "string" || typeof root.stage !== "string" || typeof root.candidate_serialized_request !== "string") {
      throw new TypeError("runtime fixture binding needs semantic_root, stage, and candidate_serialized_request");
    }
    const key = `${root.semantic_root}\0${root.stage}`;
    if (byRootAndStage.has(key)) throw new Error("runtime fixture bindings duplicate semantic root and stage");
    if (root.independently_observed_runtime_release === undefined) throw new Error("runtime fixture binding lacks an independently observed release");
    byRootAndStage.set(key, root);
  }
  const syntheticIds = syntheticAtomIds(manifest);
  const packets = manifest.fixture_packet_templates.map((template) => {
    const binding = byRootAndStage.get(`${template.semantic_root}\0${template.stage}`);
    if (binding === undefined) throw new Error(`runtime fixture binding missing ${template.semantic_root}/${template.stage}`);
    const expectedBinding = object(independently_serialize(immutable({
      template,
      independently_observed_runtime_release: binding.independently_observed_runtime_release,
    })), "independent verifier serializer result");
    if (typeof expectedBinding.serialized_request !== "string") {
      throw new TypeError("independent verifier serializer lacks serialized_request");
    }
    if (binding.candidate_serialized_request !== expectedBinding.serialized_request) {
      throw new Error("candidate provider request differs from the independently serialized canonical request");
    }
    const runtimeRequest = parseRuntimeRequest(expectedBinding.serialized_request);
    for (const syntheticId of syntheticIds) {
      if (typeof syntheticId === "string" && expectedBinding.serialized_request.includes(syntheticId)) {
        throw new Error("synthetic atom identity escaped into a production request");
      }
    }
    const packet = {
      semantic_root: template.semantic_root,
      population: template.population,
      stage: template.stage,
      offer_nonce_binding: template.offer_nonce_binding,
      request_match: {
        request_sha256: sha256(expectedBinding.serialized_request),
        response_schema_name: runtimeRequest.response_schema_name,
      },
      response_value: template.response_value,
      wire_budget: {
        canonical_request_bytes: Buffer.byteLength(expectedBinding.serialized_request, "utf8"),
        canonical_response_bytes: template.canonical_response_bytes,
        expected_call_count: 1,
      },
    };
    if (template.approved_snapshot_token !== undefined) packet.approved_snapshot_token = template.approved_snapshot_token;
    if (template.stage === "answer_generation") {
      const expected = template.oracle_evidence_requirements;
      if (runtimeRequest.user_prompt !== expected.canonical_packet_json) {
        throw new Error("runtime answer evidence packet differs from the independent oracle packet");
      }
      packet.answer_evidence = {
        canonical_packet_json: runtimeRequest.user_prompt,
        canonical_packet_bytes: Buffer.byteLength(runtimeRequest.user_prompt, "utf8"),
      };
    }
    return immutable(packet);
  });
  if (JSON.stringify(packets).includes("synthetic_atom_id")) {
    throw new Error("synthetic atom identity escaped into fixture packet materialization");
  }
  return immutable(packets);
}

function readerFor(index) {
  const id = String(index).padStart(3, "0");
  return immutable({ principal_id: `employee-${id}`, membership_id: `membership-${id}` });
}

/** Inverse-CDF sampling over a 1x baseline plus an exact 4x fifteen-minute interval. */
function weightedOffsets({ count, runDurationMs, peakStartMs, peakDurationMs, random }) {
  const before = peakStartMs;
  const after = runDurationMs - peakStartMs - peakDurationMs;
  const weight = before + (4 * peakDurationMs) + after;
  const offsets = [];
  for (let index = 0; index < count; index += 1) {
    const quantile = (index + random()) / count;
    const weightedPosition = quantile * weight;
    let offset;
    if (weightedPosition < before) offset = weightedPosition;
    else if (weightedPosition < before + (4 * peakDurationMs)) {
      offset = before + ((weightedPosition - before) / 4);
    } else {
      offset = peakStartMs + peakDurationMs + (weightedPosition - before - (4 * peakDurationMs));
    }
    offsets.push(Math.min(runDurationMs, Math.max(0, Math.floor(offset))));
  }
  return offsets.sort((left, right) => left - right);
}

function deterministicShuffle(values, random) {
  return values
    .map((value) => ({ value, shuffle_key: random() }))
    .sort((left, right) => left.shuffle_key - right.shuffle_key)
    .map(({ value }) => value);
}

function positiveHistoryQuery(corpus, atom, reader, frequencies) {
  const terms = [...analyzeDocument(atom.text, atom.item_kind).keys()]
    .filter((term) => term !== "decision")
    .sort((left, right) => (frequencies.get(left) ?? Infinity) - (frequencies.get(right) ?? Infinity));
  for (let width = 1; width <= Math.min(3, terms.length); width += 1) {
    const query = terms.slice(0, width).join(" ");
    const result = searchAtHead({ corpus, exactHead: corpus.exact_head, reader, query });
    if (result.items.some((item) => item.atom_id === atom.atom_id)) return immutable({ query, result });
  }
  throw new Error(`unable to create an ordinary positive history query for synthetic atom ${atom.atom_id}`);
}

function termDocumentFrequencies(corpus) {
  const frequencies = new Map();
  for (const atom of corpus.atoms) {
    for (const term of analyzeDocument(atom.text, atom.item_kind).keys()) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
  }
  return frequencies;
}

function buildHistoryProbes(corpus, milestone, random) {
  const frequencies = termDocumentFrequencies(corpus);
  const probes = [];
  const used = new Set();
  const positivePerBucket = milestone.history_probe_count / 10;
  if (!Number.isInteger(positivePerBucket) || positivePerBucket < 10) throw new Error("M1 history probe count cannot cover ten age buckets");
  for (let bucket = 0; bucket < 10; bucket += 1) {
    const candidates = corpus.atoms
      .filter((atom) => atom.age_bucket === bucket)
      .map((atom) => ({ atom, shuffle_key: random() }))
      .sort((left, right) => left.shuffle_key - right.shuffle_key)
      .map(({ atom }) => atom);
    let selected = 0;
    for (const atom of candidates) {
      if (selected === positivePerBucket || used.has(atom.atom_id)) continue;
      const reader = atom.policy_id === POLICY_RESTRICTED_REVIEWER
        ? immutable({ principal_id: atom.reviewer_principal_id, membership_id: atom.reviewer_membership_id })
        : readerFor((bucket + selected) % milestone.active_employees);
      const expected = positiveHistoryQuery(corpus, atom, reader, frequencies);
      probes.push(immutable({
        id: `history-positive-${String(bucket).padStart(2, "0")}-${String(selected).padStart(2, "0")}`,
        bucket,
        reader,
        query: expected.query,
        expected_synthetic_atom_id: atom.atom_id,
        expected_synthetic_content_digest: atom.content_digest,
        expected_synthetic_policy_id: atom.policy_id,
        expected_top_ten_synthetic_atom_ids: expected.result.items.map((item) => item.atom_id),
      }));
      used.add(atom.atom_id);
      selected += 1;
    }
    if (selected !== positivePerBucket) throw new Error(`history age bucket ${bucket} cannot supply ${positivePerBucket} distinct probes`);
  }
  const absent = new Set(corpus.vocabulary.filter((word) => !frequencies.has(word)));
  if (absent.size < 2) throw new Error("corpus lacks ordinary absent vocabulary for negative history probes");
  const absentTerms = [...absent];
  for (let index = 0; index < 20; index += 1) {
    const query = `${absentTerms[(index * 13) % absentTerms.length]} ${absentTerms[(index * 29 + 1) % absentTerms.length]}`;
    probes.push(immutable({
      id: `history-negative-${String(index).padStart(2, "0")}`,
      bucket: null,
      reader: readerFor(index % milestone.active_employees),
      query,
      expected_top_ten_synthetic_atom_ids: [],
    }));
  }
  return immutable(probes);
}

function answerEvidencePacket({ question, search }) {
  const sources = search.items.map((item, index) => ({
    // This is a verifier-only synthetic alias. It is not a canonical Authority
    // record ID and must be bound to a real released record before traffic.
    citation_id: `a${index + 1}`,
    text: item.text,
  }));
  const canonical_packet_json = JSON.stringify({ question, sources });
  return immutable({
    canonical_packet_json,
    canonical_packet_bytes: Buffer.byteLength(canonical_packet_json, "utf8"),
    synthetic_evidence: search.items.map((item, index) => immutable({
      citation_id: sources[index].citation_id,
      synthetic_atom_id: item.atom_id,
      synthetic_content_digest: item.content_digest,
      synthetic_policy_id: item.policy_id,
    })),
  });
}

function assertNoRuntimeFabrication(value) {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "runtime_record_id" || key === "runtime_exact_head") {
      throw new Error("manifest must not fabricate mapped Authority runtime record/head identifiers");
    }
    assertNoRuntimeFabrication(child);
  }
}

/**
 * Creates a complete, verifier-only M1 trace. `fixture_packet_templates` and
 * `oracle_expectations` are never candidate offer payloads. An integration
 * layer must bind each synthetic atom/evidence entry to the realized canonical
 * Authority record and exact active head before a timed run can start.
 */
export function generateM1Manifest({ candidate, sealing_material, contract }) {
  requireCandidate(candidate);
  requireRecord(contract, "metric contract");
  const milestone = contract.milestones.find((entry) => entry.id === "M1");
  if (milestone === undefined) throw new Error("metric contract lacks M1");
  const seed = sealedSeed(candidate, sealing_material);
  const random = seededRandom(seed);
  const corpus = buildSyntheticCorpus({ milestone: "M1", seed: `corpus:${seed}` });
  const timedSourceCorpus = appendSyntheticAtoms(corpus, {
    count: milestone.peak_day_meetings * contract.workload.atoms_per_approved_meeting,
    seed: `timed-source:${seed}`,
  });
  const timedSourceAtoms = timedSourceCorpus.atoms.slice(corpus.atoms.length);
  const [peakMinimum, peakMaximum] = contract.workload.peak_start_window_ms;
  const peakStartMs = peakMinimum + Math.floor(random() * (peakMaximum - peakMinimum + 1));
  const sourceOffsets = weightedOffsets({
    count: milestone.peak_day_meetings,
    runDurationMs: contract.workload.run_duration_ms,
    peakStartMs,
    peakDurationMs: contract.workload.peak_duration_ms,
    random,
  });
  const directOffsets = weightedOffsets({
    count: milestone.peak_day_user_searches,
    runDurationMs: contract.workload.run_duration_ms,
    peakStartMs,
    peakDurationMs: contract.workload.peak_duration_ms,
    random,
  });
  const answerOffsets = weightedOffsets({
    count: milestone.peak_day_answers,
    runDurationMs: contract.workload.run_duration_ms,
    peakStartMs,
    peakDurationMs: contract.workload.peak_duration_ms,
    random,
  });
  // This is the M1 direct-search population: 22 selective, 17 medium, 11
  // broad, and 5 negative queries after deterministic rounding. Availability
  // probes cycle the same held-out, non-marker query family.
  const queryPlan = buildQueryPlan({ corpus, reader: readerFor(0), count: milestone.peak_day_user_searches, seed: `query:${seed}` });
  const directQueryPlan = deterministicShuffle(
    Array.from({ length: milestone.peak_day_user_searches }, (_, index) =>
      queryPlan[Math.floor((index * queryPlan.length) / milestone.peak_day_user_searches)]),
    random,
  );
  const positiveQueries = queryPlan.filter((entry) => entry.kind !== "negative");
  const historyProbes = buildHistoryProbes(corpus, milestone, random);
  const fixture_packet_templates = [];
  const planned_scripted_wait_samples = [];
  const operations = [];
  const approval_plan = [];
  const runtime_binding = immutable({
    status: "integration-required-before-run",
    synthetic_fixture_identity_only: true,
    candidate_runtime_record_or_head_identifiers_present: false,
    required_mapping: "synthetic atom/content/policy evidence to actual approved canonical record and independently observed exact active head at release",
  });
  const addWait = (population, semantic_root, stage) => {
    const range = contract.provider_profile.delays_ms[stage];
    if (range === undefined) throw new Error(`metric contract lacks ${stage} delay range`);
    planned_scripted_wait_samples.push(immutable({
      population,
      semantic_root,
      stage,
      ordinal: 1,
      prescribed_wait_ms: plannedScriptedDelay(seed, semantic_root, stage, range),
    }));
  };
  const addOperation = (operation) => operations.push(immutable(operation));

  for (let index = 0; index < milestone.active_employees; index += 1) {
    addWait("identity", `identity:employee-${String(index).padStart(3, "0")}`, "identity_provider_request");
  }

  for (let index = 0; index < sourceOffsets.length; index += 1) {
    const id = `source-${String(index).padStart(3, "0")}`;
    const semanticRoot = `source:${id}`;
    const sourceAtoms = timedSourceAtoms.slice(
      index * contract.workload.atoms_per_approved_meeting,
      (index + 1) * contract.workload.atoms_per_approved_meeting,
    );
    const approved = index < Math.floor(milestone.peak_day_meetings * contract.workload.approved_fraction);
    addOperation({
      id,
      kind: "source_revision",
      population: "source_to_card",
      denominator: "ordinary",
      offset_ms: sourceOffsets[index],
      peak: sourceOffsets[index] >= peakStartMs && sourceOffsets[index] < peakStartMs + contract.workload.peak_duration_ms,
      offer_payload: immutable({ source_revision: `fixture-source-revision-${index}`, owner: "owner-000" }),
      internal: immutable({
        semantic_root: semanticRoot,
        synthetic_atoms: sourceAtoms.map((atom) => ({ synthetic_atom_id: atom.atom_id, synthetic_content_digest: atom.content_digest })),
        sealed_review_decision: approved ? "approve" : "reject",
        review_offer_after_complete_card_ms: contract.workload.approval_delay_after_card_ms,
      }),
    });
    fixture_packet_templates.push(fixtureTemplate({
      semantic_root: semanticRoot,
      population: "source_to_card",
      stage: "extraction",
      response_value: {
        signals: sourceAtoms.map((atom) => ({
          kind: atom.item_kind,
          text: atom.text,
          status: atom.item_kind === "decision" ? "decided" : "unresolved",
          due_at: null,
          confidence: null,
          evidence: [{ evidence_id: "e1", quote: atom.text }],
          supports_decision_indexes: [],
        })),
      },
    }));
    addWait("source_to_card", semanticRoot, "source_request");
    addWait("source_to_card", semanticRoot, "extraction");
    if (approved) {
      const publicationRoot = `publication:${id}`;
      const snapshotToken = sha256(`${seed}\0${publicationRoot}\0approved-snapshot`);
      fixture_packet_templates.push(fixtureTemplate({
        semantic_root: publicationRoot,
        population: "approval_to_search",
        stage: "relationship_projection",
        approved_snapshot_token: snapshotToken,
        response_value: { relationships: [] },
      }));
      addWait("approval_to_search", publicationRoot, "approval_provider_request");
      addWait("approval_to_search", publicationRoot, "relationship_projection");
    }
    // This is deliberately not a fixed-offset operation. The dependent driver
    // offers it exactly 30s after it observes the complete card; a missing card
    // stays failed source work and creates no fictitious approval sample.
    approval_plan.push(immutable({
      source_operation_id: id,
      action: approved ? "approve" : "reject",
      offer_after_complete_card_ms: contract.workload.approval_delay_after_card_ms,
      publication_semantic_root: approved ? `publication:${id}` : null,
    }));
  }

  for (let index = 0; index < directOffsets.length; index += 1) {
    const reader = readerFor(index % milestone.active_employees);
    const entry = directQueryPlan[index];
    addOperation({
      id: `direct-search-${String(index).padStart(3, "0")}`,
      kind: "direct_user_search",
      population: "direct_user_search",
      denominator: "ordinary",
      offset_ms: directOffsets[index],
      peak: directOffsets[index] >= peakStartMs && directOffsets[index] < peakStartMs + contract.workload.peak_duration_ms,
      offer_payload: immutable({ reader, query: entry.query, limit: 10 }),
      internal: immutable({ query_class: entry.kind, synthetic_head_rule: "independent-offer-or-release-head-required" }),
    });
  }

  for (let index = 0; index < contract.workload.run_duration_ms / contract.workload.availability_probe_interval_ms; index += 1) {
    const reader = readerFor(index % milestone.active_employees);
    const entry = queryPlan[index % queryPlan.length];
    addOperation({
      id: `availability-${String(index).padStart(4, "0")}`,
      kind: "availability_probe",
      population: "availability_probe",
      denominator: "ordinary",
      offset_ms: index * contract.workload.availability_probe_interval_ms,
      offer_payload: immutable({ reader, query: entry.query, limit: 10 }),
      internal: immutable({ query_class: entry.kind, independent_probe: true }),
    });
  }

  for (let index = 0; index < historyProbes.length; index += 1) {
    const probe = historyProbes[index];
    addOperation({
      id: probe.id,
      kind: "history_probe",
      population: "history_probe",
      denominator: "ordinary",
      offset_ms: Math.floor(((index + 1) * contract.workload.run_duration_ms) / (historyProbes.length + 1)),
      offer_payload: immutable({ reader: probe.reader, query: probe.query, limit: 10 }),
      internal: immutable(probe),
    });
  }

  for (let index = 0; index < answerOffsets.length; index += 1) {
    const reader = readerFor(index % milestone.active_employees);
    const candidateQuery = positiveQueries[index % positiveQueries.length].query;
    const search = searchAtHead({ corpus, exactHead: corpus.exact_head, reader, query: candidateQuery });
    if (search.items.length === 0) throw new Error("answer query lacks current authorized synthetic evidence");
    const question = `What approved information matches: ${candidateQuery}?`;
    const evidence = answerEvidencePacket({ question, search });
    const id = `answer-${String(index).padStart(3, "0")}`;
    const semanticRoot = `answer:${id}`;
    const citations = [evidence.synthetic_evidence[0].citation_id];
    fixture_packet_templates.push(fixtureTemplate({
      semantic_root: semanticRoot,
      population: "answer",
      stage: "answer_planner",
      response_value: { queries: [...search.terms].slice(0, 3) },
    }));
    fixture_packet_templates.push(fixtureTemplate({
      semantic_root: semanticRoot,
      population: "answer",
      stage: "answer_generation",
      oracle_evidence_requirements: evidence,
      response_value: {
        status: "answered",
        answer: "Synthetic fixture answer grounded in the supplied approved evidence.",
        citations,
      },
    }));
    addWait("answer", semanticRoot, "answer_planner");
    addWait("answer", semanticRoot, "answer_generation");
    addOperation({
      id,
      kind: "answer",
      population: "answer",
      denominator: "ordinary",
      offset_ms: answerOffsets[index],
      peak: answerOffsets[index] >= peakStartMs && answerOffsets[index] < peakStartMs + contract.workload.peak_duration_ms,
      offer_payload: immutable({ reader, question }),
      internal: immutable({
        semantic_root: semanticRoot,
        oracle_owned_expected_evidence_packet: evidence,
        runtime_binding_required: true,
      }),
    });
  }

  const permissionClasses = contract.correctness.permission_case_classes;
  for (let index = 0; index < contract.correctness.timed_permission_cases; index += 1) {
    const peak = index < 10;
    const offset_ms = peak
      ? peakStartMs + Math.floor(((index + 1) * contract.workload.peak_duration_ms) / 11)
      : Math.floor(((index - 9) * contract.workload.run_duration_ms) / (contract.correctness.timed_permission_cases - 9));
    addOperation({
      id: `permission-${String(index).padStart(2, "0")}`,
      kind: "timed_permission_probe",
      population: "timed_permission_probe",
      denominator: "excluded",
      offset_ms,
      peak,
      verifier_only: true,
      internal: immutable({ class: permissionClasses[index % permissionClasses.length], seed_index: Math.floor(index / permissionClasses.length) }),
    });
  }

  const killOffset = peakStartMs + Math.floor(random() * contract.workload.peak_duration_ms);
  addOperation({
    id: "fault-candidate-cgroup-kill-01",
    kind: "fault_observation",
    population: "fault_observation",
    denominator: "excluded",
    offset_ms: killOffset,
    peak: true,
    verifier_only: true,
    fault: "candidate-cgroup-kill",
    internal: immutable({ recovery_readiness_deadline_ms: contract.thresholds.post_kill_readiness_ms_max }),
  });

  const manifest = immutable({
    kind: "authority-capacity-manifest-v1",
    milestone: "M1",
    sealed_seed: seed,
    peak_start_ms: peakStartMs,
    arrival_profile: immutable({
      rate: "piecewise-constant",
      baseline_multiplier: 1,
      peak_multiplier: contract.workload.peak_multiplier,
      peak_duration_ms: contract.workload.peak_duration_ms,
      peak_start_ms: peakStartMs,
      direct_source_answer_arrivals: "inverse-CDF-sealed-realization",
      availability_arrivals: "independent-fixed-10-second-probes",
    }),
    active_users: immutable(Array.from({ length: milestone.active_employees }, (_, index) => readerFor(index))),
    synthetic_corpus: immutable({
      kind: corpus.kind,
      milestone: corpus.milestone,
      synthetic_lineage_id: corpus.lineage_id,
      synthetic_logical_head: corpus.exact_head,
      atom_count: corpus.atoms.length,
      logical_posting_count: corpus.atoms.length * 25,
    }),
    runtime_binding,
    approval_plan: immutable(approval_plan),
    fixture_packet_templates: immutable(fixture_packet_templates),
    planned_scripted_wait_samples: immutable(planned_scripted_wait_samples),
    history_probe_mix: immutable({ positives: milestone.history_probe_count, negatives: contract.workload.history_negative_probes_extra, per_age_bucket: milestone.history_probe_count / 10, query_classes: ["ordinary-positive", "ordinary-negative"] }),
    operations: immutable(operations),
  });
  assertNoRuntimeFabrication(manifest);
  return manifest;
}

export function loadCapacityContract() {
  return immutable(JSON.parse(readFileSync(resolve(here, "metrics.v1.json"), "utf8")));
}

export function plannedWaitDiagnostics(manifest) {
  requireRecord(manifest, "manifest");
  const groups = new Map();
  for (const sample of manifest.planned_scripted_wait_samples ?? []) {
    const key = `${sample.population}\0${sample.stage}`;
    const current = groups.get(key) ?? { population: sample.population, stage: sample.stage, samples: [] };
    current.samples.push(sample.prescribed_wait_ms);
    groups.set(key, current);
  }
  return immutable([...groups.values()].map((entry) => {
    const samples = [...entry.samples].sort((left, right) => left - right);
    return {
      population: entry.population,
      stage: entry.stage,
      sample_count: samples.length,
      prescribed_wait_p95_ms: samples[Math.ceil(samples.length * 0.95) - 1],
    };
  }).sort((left, right) => `${left.population}\0${left.stage}`.localeCompare(`${right.population}\0${right.stage}`, "en")));
}
