// Read-only companion to the existing release commands. References and recorded
// observations are inputs; no mutable "done" flags or deployment actions live here.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { privateFile, sha256 } from './lib/operator-io.mjs';
import { readCleanV1Release } from './clean-v1-release.mjs';
import { readStagingReleaseReceipt } from './authority-staging-release.mjs';
import { inspectPreparedClientUpdateFeed, requireReleaseTargets, RELEASE_TARGETS } from './client-update-feed.mjs';
import { readClientUpdatePublicationEvidence } from './client-update-publish.mjs';

const fail = code => { throw new Error(code); };
const SHA = /^[a-f0-9]{64}$/;
const SOURCE = /^[a-f0-9]{40}$/;
const CASES = JSON.parse(readFileSync(new URL('./evals/research-loop/release-check.json', import.meta.url))).cases;
const readJson = path => {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('absolute_evidence_path_required');
  return JSON.parse(privateFile(path, 1024 * 1024, 1));
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Bind a content-free seat attestation to the files the operator inspected. */
function clientProof(path, release, manifest) {
  const proof = readJson(path);
  const target = RELEASE_TARGETS.find(item => item.option === proof.target);
  const artifact = manifest?.artifacts.find(item => target && item.platform === target.platform && item.architecture === target.architecture && item.installation === target.installation);
  if (proof.kind !== 'echo-release-client-proof-v1' || !target || !artifact || proof.release_id !== release.release_id ||
      proof.source_sha !== release.source_sha || proof.artifact_sha256 !== artifact.sha256 || proof.native !== true ||
      typeof proof.seat !== 'string' || !/^[A-Za-z0-9 _.-]{1,80}$/.test(proof.seat) || !SOURCE.test(proof.baseline_source_sha ?? '') ||
      proof.baseline_source_sha === release.source_sha || proof.method !== 'signed-feed-update') fail('client_proof_binding_invalid');
  const required = target.installation === 'cli-kit' ? ['baseline', 'available_without_activation', 'activation', 'authenticated_read', 'cited_ask']
    : ['baseline', 'in_app_update', 'installed_identity', 'authenticated_read', ...(target.platform === 'linux' ? ['package_installed'] : [])];
  if (!proof.checks || !same(Object.keys(proof.checks).sort(), required.sort())) fail('client_proof_checks_missing');
  for (const entry of Object.values(proof.checks)) {
    if (entry?.passed !== true || !SHA.test(entry.sha256 ?? '') || typeof entry.path !== 'string' || !isAbsolute(entry.path) ||
        sha256(privateFile(entry.path, 16 * 1024 * 1024, 1)) !== entry.sha256) fail('client_proof_evidence_changed');
  }
  return { target: target.option, seat: proof.seat, evidence: 'operator_attestation_with_bound_files' };
}

/** Derive progress from validated saved evidence, never claim fresh remote state. */
export function releaseRoundStatus(path, dependencies = {}) {
  const round = readJson(path);
  const allowed = ['schema_version', 'kind', 'release', 'prepared', 'server_receipts', 'publication_receipt', 'predecessor_receipt', 'research_check', 'client_proofs'];
  if (round.schema_version !== 1 || round.kind !== 'echo-release-round-v1' || Object.keys(round).some(key => !allowed.includes(key)) ||
      !Array.isArray(round.server_receipts) || round.server_receipts.length > 100 || !Array.isArray(round.client_proofs) || round.client_proofs.length > 4) fail('release_round_invalid');
  if (typeof round.release !== 'string' || !isAbsolute(round.release)) fail('absolute_evidence_path_required');
  const bytes = privateFile(round.release, 16384, 1);
  const release = readCleanV1Release(round.release);
  const releaseHash = sha256(bytes);
  const now = (dependencies.now ?? Date.now)();
  const remaining = [];
  let prepared = null;
  if (round.prepared) {
    prepared = (dependencies.inspectPrepared ?? inspectPreparedClientUpdateFeed)({ prepared: round.prepared, now, allowExpired: true });
    requireReleaseTargets(prepared.manifest);
    if (prepared.manifest.release_sha256 !== releaseHash || prepared.manifest.source_sha !== release.source_sha || prepared.manifest.release_id !== release.release_id) fail('prepared_release_mismatch');
    if (Date.parse(prepared.manifest.expires_at) <= now) remaining.push('prepare_and_approve_fresh_manifest');
  } else remaining.push('prepare_four_target_feed_for_combined_review');
  let predecessor = null;
  if (round.predecessor_receipt) {
    predecessor = (dependencies.readPublication ?? readClientUpdatePublicationEvidence)(round.predecessor_receipt, { now: () => now });
    if (predecessor.state !== 'succeeded' || !SHA.test(predecessor.feed_sha256 ?? '') ||
        (prepared && prepared.manifest.sequence <= predecessor.sequence)) fail('succeeded_predecessor_required');
  }
  for (const file of [...round.server_receipts, ...round.client_proofs, ...[round.prepared, round.publication_receipt, round.predecessor_receipt, round.research_check].filter(Boolean)]) {
    if (typeof file !== 'string' || !isAbsolute(file)) fail('absolute_evidence_path_required');
  }
  const receipts = round.server_receipts.map(file => (dependencies.readServer ?? readStagingReleaseReceipt)(file));
  const targets = receipts.map(receipt => JSON.stringify(receipt.request.target));
  if (new Set(targets).size > 1) fail('mixed_server_targets');
  for (const receipt of receipts) {
    if (receipt.request.candidate.sha256 !== releaseHash || receipt.request.candidate.release_id !== release.release_id) fail('server_release_mismatch');
  }
  receipts.sort((a, b) => a.request.created_at - b.request.created_at);
  const pending = receipts.filter(receipt => ['submitting', 'submitted', 'unconfirmed'].includes(receipt.state));
  const last = receipts.at(-1);
  let phase = prepared ? 'prepared' : 'preparing';
  const succeeded = receipts.filter(receipt => receipt.state === 'succeeded');
  const accepted = succeeded.findLast(receipt => receipt.request.action === 'status' && receipt.request.accepted.sha256 === releaseHash);
  const lastMutation = receipts.findLast(receipt => ['stage', 'rollback', 'promote'].includes(receipt.request.action));
  if (lastMutation?.state === 'succeeded' && lastMutation.request.action === 'stage') phase = 'staged';
  // A promotion is not observed acceptance until a later status confirms it.
  if (lastMutation?.state === 'succeeded' && lastMutation.request.action === 'promote') phase = 'promoted';
  if (accepted && (!lastMutation || accepted.request.created_at >= lastMutation.request.created_at)) phase = 'server_accepted';
  if (pending.length) remaining.unshift('reconcile_existing_server_receipt_with_original_tooling');
  if (last && last.state !== 'succeeded' && !pending.length) remaining.push('inspect_server_operation_result');
  if (!accepted || now - accepted.request.created_at * 1000 > 300_000 || now < accepted.request.created_at * 1000) remaining.push('obtain_fresh_accepted_server_status');
  let research = false;
  if (round.research_check) {
    const report = readJson(round.research_check);
    research = report.kind === 'echo-research-release-check-v1' && report.passed === true && Array.isArray(report.questions) &&
      same(report.questions.map(q => q.case_id).sort(), [...CASES].sort()) && report.questions.every(q => q.passed === true && q.release_sha === release.source_sha && typeof q.trace_id === 'string' && q.trace_id.length > 0);
    if (!research) remaining.push('repair_or_repeat_candidate_research_checks');
  } else remaining.push('capture_candidate_research_checks');
  let publication = null;
  if (round.publication_receipt) {
    publication = (dependencies.readPublication ?? readClientUpdatePublicationEvidence)(round.publication_receipt, { now: () => now });
    if (publication.release_sha256 !== releaseHash || publication.source_sha !== release.source_sha || publication.release_id !== release.release_id ||
        !prepared || publication.manifest_sha256 !== sha256(prepared.payload)) fail('publication_release_mismatch');
    if (publication.state === 'succeeded' && publication.verified_objects === 5 && publication.object_count === 5) phase = 'client_published';
    else remaining.push(publication.state === 'unconfirmed' ? 'reconcile_existing_publication_receipt' : 'resume_approved_publication');
    if (!publication.metadata_fresh) remaining.push('renew_expired_feed_metadata');
  } else remaining.push(['promoted', 'server_accepted'].includes(phase) ? 'publish_approved_feed' : 'complete_combined_review_then_promote_and_publish');
  const proofs = round.client_proofs.map(file => clientProof(file, release, prepared?.manifest));
  if (new Set(proofs.map(proof => proof.target)).size !== proofs.length) fail('duplicate_client_proof');
  for (const target of RELEASE_TARGETS) if (!proofs.some(proof => proof.target === target.option)) remaining.push(`verify_native_${target.option.replaceAll('-', '_')}_update`);
  if (phase === 'client_published' && proofs.length === RELEASE_TARGETS.length) phase = 'client_proofs_recorded';
  if (pending.length || (last && last.state !== 'succeeded')) phase = 'operation_incomplete';
  let nextAction;
  if (pending.length) nextAction = 'reconcile_existing_server_receipt_with_original_tooling';
  else if (phase === 'operation_incomplete') nextAction = 'inspect_server_operation_result';
  else if (publication?.state === 'unconfirmed') nextAction = 'reconcile_existing_publication_receipt';
  else if (publication && !publication.metadata_fresh) nextAction = 'renew_expired_feed_metadata';
  else if (phase === 'client_published') nextAction = remaining.find(item => item.startsWith('verify_native_'));
  else if (phase === 'client_proofs_recorded') nextAction = 'refresh_live_server_and_feed_status_before_reporting_released';
  else if (['promoted', 'server_accepted'].includes(phase)) nextAction = publication ? 'obtain_fresh_status_then_resume_approved_publication' : 'obtain_fresh_status_then_publish_approved_feed';
  else if (phase === 'staged') nextAction = research ? 'review_quality_and_exact_server_and_feed_inputs' : 'verify_canary_approval_and_tracing_then_run_candidate_checks';
  else nextAction = prepared ? 'stage_and_canary_through_existing_release_lane' : 'prepare_four_target_feed_for_combined_review';
  return { kind: 'echo-release-round-status-v1', release_id: release.release_id, source_sha: release.source_sha,
    release_sha256: releaseHash, recorded_phase: phase, observation: 'saved_evidence_only', research_coverage_passed: research,
    answer_quality: 'requires_product_regressions_and_live_review', client_proofs: proofs, remaining,
    next_action: nextAction,
    review: prepared ? { expected_predecessor_sha256: predecessor?.feed_sha256 ?? null, manifest_sha256: sha256(prepared.payload), channel: prepared.manifest.channel, sequence: prepared.manifest.sequence, expires_at: prepared.manifest.expires_at,
      targets: prepared.manifest.artifacts.map(item => ({ platform: item.platform, architecture: item.architecture, installation: item.installation, sha256: item.sha256 })) } : null };
}
