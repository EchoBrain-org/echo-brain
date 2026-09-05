import assert from "node:assert/strict";
import test from "node:test";
import { createProductionWireFixtureServer } from "../fixtures.mjs";
import { validateSealedManifest } from "../runner.mjs";
import {
  generateM1Manifest,
  loadCapacityContract,
  materializeRuntimeFixturePackets,
  plannedScriptedDelay,
  plannedWaitDiagnostics,
} from "../manifest-v1.mjs";

const contract = loadCapacityContract();
const candidate = Object.freeze({
  candidate_digest: "a".repeat(64),
  source_digest: "b".repeat(64),
  config_digest: "c".repeat(64),
  milestone: "M1",
});
const material = Buffer.alloc(32, 7);

function operationsOf(manifest, kind) {
  return manifest.operations.filter((operation) => operation.kind === kind);
}

test("generates a deterministic complete M1 manifest only after candidate registration material", () => {
  const first = generateM1Manifest({ candidate, sealing_material: material, contract });
  const second = generateM1Manifest({ candidate, sealing_material: material, contract });
  assert.deepEqual(first, second);
  assert.throws(() => generateM1Manifest({ candidate, sealing_material: Buffer.alloc(8), contract }), /sealing_material/);
  assert.equal(first.milestone, "M1");
  assert.equal(first.active_users.length, 10);
  assert.match(first.sealed_seed, /^[a-f0-9]{64}$/);
  assert.notEqual(first.sealed_seed, candidate.candidate_digest);
});

test("M1 operation populations exactly meet the sealed runner's qualification counts", () => {
  const manifest = generateM1Manifest({ candidate, sealing_material: material, contract });
  const accepted = validateSealedManifest(manifest, contract, { milestoneId: "M1", qualification: true });
  assert.equal(accepted.operations.length, manifest.operations.length);
  assert.equal(operationsOf(manifest, "source_revision").length, 6);
  assert.equal(operationsOf(manifest, "direct_user_search").length, 55);
  assert.equal(operationsOf(manifest, "availability_probe").length, 2880);
  assert.equal(operationsOf(manifest, "history_probe").length, 220);
  assert.equal(operationsOf(manifest, "answer").length, 55);
  assert.equal(operationsOf(manifest, "timed_permission_probe").length, 40);
  assert.equal(operationsOf(manifest, "fault_observation").filter((operation) => operation.fault === "candidate-cgroup-kill").length, 1);
});

test("history coverage, hidden peak, and timed correctness shape are complete", () => {
  const manifest = generateM1Manifest({ candidate, sealing_material: material, contract });
  assert.ok(manifest.peak_start_ms >= 7200000 && manifest.peak_start_ms <= 21600000);
  assert.equal(manifest.arrival_profile.peak_multiplier, 4);
  assert.equal(manifest.arrival_profile.peak_duration_ms, 900000);
  const history = operationsOf(manifest, "history_probe");
  const positives = history.filter((operation) => operation.internal.expected_synthetic_atom_id !== undefined);
  const negatives = history.filter((operation) => operation.internal.expected_top_ten_synthetic_atom_ids.length === 0);
  assert.equal(positives.length, 200);
  assert.equal(negatives.length, 20);
  for (let bucket = 0; bucket < 10; bucket += 1) {
    assert.equal(positives.filter((operation) => operation.internal.bucket === bucket).length, 20);
  }
  assert.ok(operationsOf(manifest, "timed_permission_probe").filter((operation) => operation.peak).length >= 10);
  const [kill] = operationsOf(manifest, "fault_observation");
  assert.ok(kill.offset_ms >= manifest.peak_start_ms);
  assert.ok(kill.offset_ms < manifest.peak_start_ms + contract.workload.peak_duration_ms);
});

test("direct and availability traffic retain the sealed broad, medium, selective, and negative mix", () => {
  const manifest = generateM1Manifest({ candidate, sealing_material: material, contract });
  for (const kind of ["direct_user_search", "availability_probe"]) {
    const classes = new Set(operationsOf(manifest, kind).map((operation) => operation.internal.query_class));
    assert.deepEqual([...classes].sort(), ["broad", "medium", "negative", "selective"]);
  }
});

test("approval decisions are sealed but remain dependent on complete-card observation", () => {
  const manifest = generateM1Manifest({ candidate, sealing_material: material, contract });
  assert.equal(manifest.approval_plan.length, 6);
  assert.equal(manifest.approval_plan.filter((entry) => entry.action === "approve").length, 4);
  assert.equal(manifest.approval_plan.filter((entry) => entry.action === "reject").length, 2);
  assert.ok(manifest.approval_plan.every((entry) => entry.offer_after_complete_card_ms === 30000));
  assert.equal(manifest.operations.some((operation) => operation.kind === "approval_visibility_poll"), false);
});

test("timed source fixture outputs use the current extraction and relationship envelopes", () => {
  const manifest = generateM1Manifest({ candidate, sealing_material: material, contract });
  const extraction = manifest.fixture_packet_templates.filter((packet) => packet.stage === "extraction");
  assert.equal(extraction.length, 6);
  assert.ok(extraction.every((packet) => packet.response_value.signals.length === 5));
  assert.ok(extraction.flatMap((packet) => packet.response_value.signals).every((signal) =>
    Object.keys(signal).sort().join(",") === "confidence,due_at,evidence,kind,status,supports_decision_indexes,text"));
  assert.ok(manifest.fixture_packet_templates
    .filter((packet) => packet.stage === "relationship_projection")
    .every((packet) => JSON.stringify(packet.response_value) === JSON.stringify({ relationships: [] })));
  const timedSyntheticIds = new Set(operationsOf(manifest, "source_revision")
    .flatMap((operation) => operation.internal.synthetic_atoms.map((atom) => atom.synthetic_atom_id)));
  assert.equal(timedSyntheticIds.size, 30);
});

test("answer evidence and fixture templates remain verifier-owned synthetic data", () => {
  const manifest = generateM1Manifest({ candidate, sealing_material: material, contract });
  const answer = operationsOf(manifest, "answer")[0];
  assert.deepEqual(Object.keys(answer.offer_payload).sort(), ["question", "reader"]);
  assert.equal(answer.internal.runtime_binding_required, true);
  assert.ok(answer.internal.oracle_owned_expected_evidence_packet.canonical_packet_bytes > 0);
  assert.equal(manifest.runtime_binding.status, "integration-required-before-run");
  assert.equal(manifest.runtime_binding.candidate_runtime_record_or_head_identifiers_present, false);
  assert.ok(manifest.fixture_packet_templates.every((packet) => packet.offer_nonce_binding === "driver-mint-at-offer"));
  assert.ok(manifest.fixture_packet_templates.every((packet) => packet.offer_nonce === undefined));
  assert.ok(manifest.fixture_packet_templates.some((packet) => packet.stage === "answer_generation"));
  assert.ok(manifest.fixture_packet_templates.every((packet) => packet.runtime_request_binding === "required-from-production-serializer-at-observed-runtime-head"));
  assert.ok(manifest.fixture_packet_templates.every((packet) => packet.wire_budget === undefined));
});

test("only an observed production serialization can materialize fixture request bytes and hashes", async () => {
  const manifest = generateM1Manifest({ candidate, sealing_material: material, contract });
  const bindings = manifest.fixture_packet_templates.map((template) => {
    const prompt = template.stage === "answer_generation"
      ? template.oracle_evidence_requirements.canonical_packet_json
      : JSON.stringify({ question: `runtime ${template.semantic_root}` });
    const serialized_request = JSON.stringify({
      model: "deepseek/deepseek-v3.2",
      messages: [
        { role: "system", content: "Observed production system prompt." },
        { role: "user", content: prompt },
      ],
      stream: false,
      max_tokens: template.stage === "answer_generation" ? 1200 : 300,
      response_format: { type: "json_schema", json_schema: { name: "echo_layer4", strict: true, schema: { type: "object" } } },
      provider: { require_parameters: true, data_collection: "deny" },
    });
    return {
      semantic_root: template.semantic_root,
      stage: template.stage,
      candidate_serialized_request: serialized_request,
      independently_observed_runtime_release: { observer_receipt: `release-${template.semantic_root}` },
    };
  });
  const independently_serialize = ({ template, independently_observed_runtime_release }) => {
    assert.match(independently_observed_runtime_release.observer_receipt, /^release-/);
    const binding = bindings.find((entry) => entry.semantic_root === template.semantic_root && entry.stage === template.stage);
    return { serialized_request: binding.candidate_serialized_request };
  };
  const packets = materializeRuntimeFixturePackets({ manifest, bindings, independently_serialize });
  assert.equal(packets.length, manifest.fixture_packet_templates.length);
  assert.ok(packets.every((packet) => /^[a-f0-9]{64}$/.test(packet.request_match.request_sha256)));
  assert.ok(packets.every((packet) => packet.wire_budget.canonical_request_bytes > 100));
  assert.equal(JSON.stringify(packets).includes("synthetic_atom_id"), false);
  const fixture = createProductionWireFixtureServer({
    run: { id: "manifest-template-validation", sealed_seed: manifest.sealed_seed, delays_ms: contract.provider_profile.delays_ms },
    expected_packets: packets,
  });
  await fixture.close();
  assert.throws(() => materializeRuntimeFixturePackets({
    manifest,
    bindings: bindings.map((binding) => binding.stage === "answer_generation"
      ? { ...binding, candidate_serialized_request: binding.candidate_serialized_request.replace("What approved information", "Wrong evidence") }
      : binding),
    independently_serialize,
  }), /candidate provider request differs/);
});

test("planned scripted waits cover every simulated population/stage with p95 diagnostics", () => {
  const manifest = generateM1Manifest({ candidate, sealing_material: material, contract });
  const diagnostics = plannedWaitDiagnostics(manifest);
  assert.ok(diagnostics.some((entry) => entry.population === "source_to_card" && entry.stage === "source_request"));
  assert.ok(diagnostics.some((entry) => entry.population === "source_to_card" && entry.stage === "extraction"));
  assert.ok(diagnostics.some((entry) => entry.population === "approval_to_search" && entry.stage === "relationship_projection"));
  assert.ok(diagnostics.some((entry) => entry.population === "answer" && entry.stage === "answer_planner"));
  assert.ok(diagnostics.some((entry) => entry.population === "answer" && entry.stage === "answer_generation"));
  assert.ok(diagnostics.some((entry) => entry.population === "identity" && entry.stage === "identity_provider_request"));
  assert.ok(diagnostics.every((entry) => entry.sample_count > 0 && Number.isInteger(entry.prescribed_wait_p95_ms)));
});

test("scripted delay covers the full configured range instead of only its lower half", () => {
  const range = { min: 1000, max: 8000 };
  const samples = Array.from({ length: 512 }, (_, index) => plannedScriptedDelay(
    "delay-range-test",
    `root-${index}`,
    "relationship_projection",
    range,
  ));
  assert.ok(Math.min(...samples) < range.min + ((range.max - range.min) * 0.1));
  assert.ok(Math.max(...samples) > range.min + ((range.max - range.min) * 0.9));
  assert.ok(samples.every((value) => value >= range.min && value <= range.max));
});
