/** Stage one only: one meeting per policy through the unchanged real core. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import Database from "better-sqlite3";
import { canonicalSha256 } from "@echo-brain/federation-protocol";

const POLICIES = ["organization-member-readable-person-v2", "restricted-reviewer-person-v2"];
const directory = realpathSync(mkdtempSync(join(tmpdir(), "echo-core-stage1-")));
chmodSync(directory, 0o700);
const reportPath = join(directory, "report.json");

function startCandidate() {
  const child = fork(new URL("./core-candidate.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const pending = new Map();
  let sequence = 0;
  child.on("message", (message) => {
    const task = pending.get(message.id);
    if (task === undefined) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(new Error(`candidate ${message.error.name}: ${message.error.message}`));
    else task.resolve(message.result);
  });
  const fail = (error) => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); }
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code, signal) => fail(new Error(`candidate exited: ${code ?? signal}`)));
  return {
    child,
    call(command, fields = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`core checkpoint command timed out: ${command}`));
        }, 45_000);
        pending.set(id, { resolve, reject, timer });
        child.send({ id, command, ...fields }, (error) => {
          if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
        });
      });
    },
  };
}

function meetingInput(identities) {
  const now = new Date().toISOString();
  const texts = [
    "Launch planning selects a staged rollout for the product.",
    "Launch staffing assigns two engineers to customer support.",
    "Launch testing requires approval of the recovery exercise.",
    "Launch reporting tracks daily activation and retention.",
    "Launch communication schedules the customer briefing on Tuesday.",
  ];
  const meeting = {
    schema_version: 1, id: "meeting-core-checkpoint", title: "Launch review",
    provenance: {
      source: identities.source, external_id: "meeting-core-checkpoint",
      canonical_revision: canonicalSha256({ texts }), observed_at: now,
      normalizer_version: identities.source.version,
    },
    capture: { state: "complete", components: [] },
    participants: [{ id: "owner", display_name: "Core Owner", identities: [{ kind: "email", value: "core-owner@example.test" }] }],
    content: texts.map((text, index) => ({ id: `block-${index}`, kind: "note", text })),
    artifacts: [], context: { owner_participant_id: "owner" },
  };
  const decisions = {
    schema_version: 1, meeting_id: meeting.id,
    meeting_revision: meeting.provenance.canonical_revision,
    processor: identities.processor, generated_at: now,
    signals: texts.map((text, index) => ({
      id: `decision-${index}`, kind: "decision", status: "decided", text,
      subject: null, confidence: 1,
      evidence: [{ meeting_id: meeting.id, block_id: `block-${index}` }],
    })),
  };
  return { meeting, decisions };
}

async function until(read, accepts, label, timeout = 40_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const result = await read();
    if (accepts(result)) return result;
    await pause(25);
  }
  throw new Error(`checkpoint did not reach ${label}`);
}

// Minimal checkpoint assertions over stopped on-disk state. This is not the
// stage-two live observer, crash proof, fsync proof, or milestone verifier.
function verifyStoppedState(stateDirectory, input, response, answers, policy) {
  const databases = ["authority.sqlite", "integrations.sqlite", "record-log.sqlite"].map((name) =>
    new Database(join(stateDirectory, name), { readonly: true, fileMustExist: true }));
  const [authority, control, record] = databases;
  try {
    for (const database of databases) assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
    const candidates = authority.prepare("SELECT meeting_json, decisions_json FROM authority_live_source_candidates_v2").all();
    assert.equal(candidates.length, 1);
    assert.deepEqual(JSON.parse(candidates[0].meeting_json), input.meeting);
    assert.deepEqual(JSON.parse(candidates[0].decisions_json), input.decisions);
    assert.equal(control.prepare("SELECT COUNT(*) AS n FROM organization_private_approval_terminal_evidence_v2 WHERE outcome = 'approved'").get().n, 1);
    assert.equal(control.prepare("SELECT COUNT(*) AS n FROM organization_private_approval_denied_action_receipts_v2").get().n, 1);
    assert.equal(record.prepare("SELECT COUNT(*) AS n FROM organization_record_log").get().n, 1);
    assert.equal(record.prepare("SELECT COUNT(*) AS n FROM organization_record_signed_receipt").get().n, 1);
    const log = record.prepare("SELECT position, record_sha256 FROM organization_record_log").get();
    assert.deepEqual(log, response.record_head);
    const pointer = authority.prepare("SELECT generation_id, record_head_position, record_head_hash FROM authority_readable_search_active_generation").get();
    assert.equal(pointer.generation_id, response.generation_id);
    assert.equal(pointer.record_head_position, log.position);
    assert.equal(pointer.record_head_hash, log.record_sha256);
    const facts = record.prepare(`SELECT atom_id, policy_id FROM organization_record_${policy === POLICIES[0] ? "member_readable" : "restricted_reviewer"}_person_fact`).all();
    assert.equal(facts.length, 5);
    assert.deepEqual(facts.map((fact) => fact.atom_id).sort(), response.items.map((item) => item.atom_id).sort());
    const audits = authority.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2 WHERE context_kind = 'answer_composition'").all().map((row) => JSON.parse(row.body_json));
    for (const answer of answers) assert.ok(audits.some((audit) => audit.response_sha256 === canonicalSha256(answer)), "returned answer has no matching persisted release audit");
    return { candidates: 1, approved_records: 1, signed_record_receipts: 1, atoms: facts.length, denied_wrong_reviewer: 1, matched_answer_audits: answers.length };
  } finally { for (const database of databases) database.close(); }
}

async function scenario(policy, index) {
  const candidate = startCandidate();
  const state_directory = join(directory, `state-${index}`);
  let stopped = false;
  try {
    const identities = await candidate.call("open", { state_directory });
    const input = meetingInput(identities);
    const inputOffered = performance.now();
    await candidate.call("offer", { input });
    const frozen = await until(
      () => candidate.call("candidate", { source_revision: { external_id: input.meeting.provenance.external_id, canonical_revision: input.meeting.provenance.canonical_revision } }),
      (result) => result?.state === "staged", "complete durable candidate",
    );
    const candidateMs = performance.now() - inputOffered;
    assert.deepEqual(frozen.decisions, input.decisions);
    const presentation = await candidate.call("presentation", { approval_id: frozen.approval_id });
    assert.ok(presentation, "staged candidate has no delivered presentation");
    for (const signal of input.decisions.signals) assert.ok(JSON.stringify(presentation).includes(signal.text), "delivered candidate is not content-complete");
    const beforeApproval = await candidate.call("search", { actor: "owner", query: "launch" });
    assert.equal(beforeApproval.items.length, 0, "unapproved content was searchable");
    await candidate.call("approve", { input: { approval_id: frozen.approval_id, actor: "employee", policy_id: policy, offer_id: "wrong-reviewer" } });
    const denied = await until(() => candidate.call("status", { approval_id: frozen.approval_id }), (result) => result.denied === 1, "wrong reviewer denial", 5_000);
    assert.equal(denied.terminal, null);
    assert.equal(denied.record_count, 0);
    const approval = { approval_id: frozen.approval_id, actor: "owner", policy_id: policy, offer_id: "owner-approval" };
    const approvalOffered = performance.now();
    await candidate.call("approve", { input: approval });
    const ackMs = performance.now() - approvalOffered;
    const response = await until(() => candidate.call("search", { actor: "owner", query: "launch" }), (result) => result.items.length === 5, "approved search visibility", 10_000);
    const visibilityMs = performance.now() - approvalOffered;
    assert.deepEqual(response.items.map((item) => item.text), input.decisions.signals.map((item) => item.text));
    assert.ok(response.items.every((item) => item.policy_id === policy));
    const employee = await candidate.call("search", { actor: "employee", query: "launch" });
    assert.deepEqual(employee.items, policy === POLICIES[0] ? response.items : []);
    const negative = await candidate.call("search", { actor: "owner", query: "unmentionedquartz" });
    assert.equal(negative.items.length, 0);
    const answerOffered = performance.now();
    const ownerAnswer = await candidate.call("answer", { actor: "owner", question: "launch" });
    const answerMs = performance.now() - answerOffered;
    assert.equal(ownerAnswer.answer, response.items[0].text);
    assert.deepEqual(ownerAnswer.citations, [{ atom_id: response.items[0].atom_id, record_sha256: response.items[0].record_sha256, policy_id: policy }]);
    const employeeAnswer = await candidate.call("answer", { actor: "employee", question: "launch" });
    if (policy === POLICIES[0]) assert.deepEqual(employeeAnswer.citations, ownerAnswer.citations);
    else {
      assert.equal(employeeAnswer.citations.length, 0);
      assert.equal(employeeAnswer.answer, "Insufficient accessible evidence to answer this question.");
    }
    const replay = await candidate.call("approve", { input: approval });
    assert.equal(replay.idempotent, true);
    // Wait through the same production exclusion boundary before stopping.
    await candidate.call("drain");
    const exit = once(candidate.child, "exit");
    await candidate.call("close");
    const [exitCode] = await exit;
    stopped = true;
    assert.equal(exitCode, 0);
    const durable = verifyStoppedState(state_directory, input, response, [ownerAnswer, employeeAnswer], policy);
    return {
      policy, result: "pass", ...durable, worker_interval_ms: identities.worker_interval_ms,
      observed_ms: { input_to_complete_candidate: Math.round(candidateMs), approval_to_durable_receipt: Math.round(ackMs), approval_to_search: Math.round(visibilityMs), deterministic_answer: Math.round(answerMs) },
    };
  } finally {
    if (!stopped && candidate.child.exitCode === null && candidate.child.signalCode === null) {
      const exit = once(candidate.child, "exit");
      candidate.child.kill("SIGKILL");
      await exit;
    }
    rmSync(state_directory, { recursive: true, force: true });
  }
}

const report = { stage: 1, checkpoint: "single-meeting-core-runtime", qualification: false, milestone_verdict: "not-run", result: "running", scenarios: [] };
try {
  for (const [index, policy] of POLICIES.entries()) {
    process.stderr.write(`Core stage 1: ${policy}; waiting on the unchanged worker.\n`);
    report.scenarios.push(await scenario(policy, index));
  }
  report.result = "pass";
} catch (error) {
  report.result = "fail";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...report, report_path: reportPath }, null, 2)}\n`);
}
