#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

export const ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_CHECK_IDS = Object.freeze([
  "artifact_verified",
  "target_preflight",
  "authority_loopback_ready",
  "listener_ready",
  "vpn_ingress_443_ready",
  "non_vpn_ingress_rejected",
  "direct_high_port_rejected",
  "vpn_forwarding_disable_proven",
  "supervisor_restart",
  "valid_pinned_client_allowed",
  "missing_client_cert_rejected",
  "untrusted_client_chain_rejected",
  "unpinned_client_rejected",
  "edge_config_exact",
  "proxy_identity_exact",
  "admin_workflow_complete",
  "employee_authority_ready",
  "cross_client_replay_rejected",
  "forbidden_routes_rejected",
  "secret_safe_logging",
  "log_rotation_ready",
  "certificate_expiry_monitoring",
  "authority_backup_restore",
  "incident_owner_assigned",
  "disable_proven",
  "rollback_preflight",
  "rollback_restored",
]);

export const ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_KNOWN_LIMITATIONS =
  Object.freeze([
    "authority_development_file_signer",
    "certificate_lifecycle_manual",
    "phase5_physical_gate_open",
    "founder_pilot_only",
  ]);

const FAILURE_CODES = Object.freeze([
  "target_unavailable",
  "artifact_invalid",
  "platform_mismatch",
  "runtime_material_invalid",
  "authority_unavailable",
  "listener_unavailable",
  "supervisor_failure",
  "mtls_failure",
  "network_boundary_failure",
  "route_boundary_failure",
  "session_isolation_failure",
  "admin_workflow_failure",
  "rollback_failure",
  "operations_gap",
  "plan_invalid",
]);
const CHECK_STATUSES = Object.freeze(["not_run", "pass", "fail"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/;
const RELEASE_ID_PATTERN =
  /^\d+\.\d+\.\d+-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*-[a-f0-9]{12}-[a-f0-9]{12}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_RECORD_BYTES = 1024 * 1024;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function add(errors, path, message) {
  errors.push(`${path} ${message}`);
}

function exactObject(value, keys, path, errors) {
  if (!isPlainObject(value)) {
    add(errors, path, "must be an object");
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    add(errors, path, "must contain exactly the fixed contract fields");
    return false;
  }
  return true;
}

function isSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isIsoUtc(value) {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const normalized = new Date(milliseconds).toISOString();
  return value === normalized || value === normalized.replace(".000Z", "Z");
}

function validateCandidate(candidate, path, errors) {
  const keys = [
    "source_sha",
    "version",
    "artifact_sha256",
    "artifact_manifest_sha256",
    "deployed_tree_sha256",
    "release_id",
    "config_sha256",
    "supervisor_plist_sha256",
    "node_executable_sha256",
  ];
  if (!exactObject(candidate, keys, path, errors)) return;
  if (
    typeof candidate.source_sha !== "string" ||
    !SOURCE_SHA_PATTERN.test(candidate.source_sha)
  ) {
    add(errors, `${path}/source_sha`, "must be one lowercase source SHA");
  }
  if (
    typeof candidate.version !== "string" ||
    candidate.version.length > 128 ||
    !VERSION_PATTERN.test(candidate.version)
  ) {
    add(errors, `${path}/version`, "must be a bounded prerelease version");
  }
  if (
    typeof candidate.release_id !== "string" ||
    candidate.release_id.length > 160 ||
    !RELEASE_ID_PATTERN.test(candidate.release_id)
  ) {
    add(errors, `${path}/release_id`, "must be the exact release identity");
  }
  for (const key of keys.filter((candidateKey) =>
    candidateKey.endsWith("sha256"),
  )) {
    if (!isSha256(candidate[key])) {
      add(errors, `${path}/${key}`, "must be one lowercase SHA-256 digest");
    }
  }
}

function validateDeployment(deployment, path, errors, allowNullPolicy) {
  const keys = [
    "ingress_mode",
    "network_policy_sha256",
    "network_procedure_sha256",
    "public_port",
    "edge_listener_host",
    "edge_listener_port",
    "supervisor",
    "service_label",
  ];
  if (!exactObject(deployment, keys, path, errors)) return;
  if (deployment.ingress_mode !== "vpn-l4-forward-to-loopback") {
    add(errors, `${path}/ingress_mode`, "must use VPN L4 loopback forwarding");
  }
  if (
    !isSha256(deployment.network_policy_sha256) &&
    !(allowNullPolicy && deployment.network_policy_sha256 === null)
  ) {
    add(
      errors,
      `${path}/network_policy_sha256`,
      "must bind the applied network policy",
    );
  }
  if (
    !isSha256(deployment.network_procedure_sha256) &&
    !(allowNullPolicy && deployment.network_procedure_sha256 === null)
  ) {
    add(
      errors,
      `${path}/network_procedure_sha256`,
      "must bind the predeclared network procedure",
    );
  }
  if (deployment.public_port !== 443) {
    add(errors, `${path}/public_port`, "must be 443");
  }
  if (deployment.edge_listener_host !== "127.0.0.1") {
    add(errors, `${path}/edge_listener_host`, "must be loopback");
  }
  if (deployment.edge_listener_port !== 8443) {
    add(errors, `${path}/edge_listener_port`, "must be 8443");
  }
  if (deployment.supervisor !== "launchd") {
    add(errors, `${path}/supervisor`, "must be launchd");
  }
  if (
    deployment.service_label !==
    "com.echo.brain.organization-admin-edge.founder-live"
  ) {
    add(errors, `${path}/service_label`, "must be the fixed service label");
  }
}

function validatePlan(plan, errors) {
  const keys = [
    "schema_version",
    "kind",
    "created_at",
    "preparation_record_sha256",
    "preflight_record_sha256",
    "observed_platform",
    "candidate",
    "deployment",
    "regime",
    "recovery",
  ];
  if (!exactObject(plan, keys, "/plan-record", errors)) return;
  if (plan.schema_version !== 1) {
    add(errors, "/plan-record/schema_version", "must be 1");
  }
  if (plan.kind !== "echo-organization-admin-edge-founder-live-plan") {
    add(errors, "/plan-record/kind", "is invalid");
  }
  if (!isIsoUtc(plan.created_at)) {
    add(errors, "/plan-record/created_at", "must be an exact UTC timestamp");
  }
  if (!isSha256(plan.preparation_record_sha256)) {
    add(
      errors,
      "/plan-record/preparation_record_sha256",
      "must be one lowercase SHA-256 digest",
    );
  }
  if (!isSha256(plan.preflight_record_sha256)) {
    add(
      errors,
      "/plan-record/preflight_record_sha256",
      "must be one lowercase SHA-256 digest",
    );
  }
  if (
    exactObject(
      plan.observed_platform,
      ["os", "architecture", "node"],
      "/plan-record/observed_platform",
      errors,
    ) &&
    (plan.observed_platform.os !== "darwin" ||
      plan.observed_platform.architecture !== "arm64" ||
      plan.observed_platform.node !== "22.22.1")
  ) {
    add(
      errors,
      "/plan-record/observed_platform",
      "must be darwin/arm64 with Node 22.22.1",
    );
  }
  validateCandidate(plan.candidate, "/plan-record/candidate", errors);
  validateDeployment(plan.deployment, "/plan-record/deployment", errors, false);
  if (
    exactObject(
      plan.regime,
      ["name", "planned_run_count", "check_ids"],
      "/plan-record/regime",
      errors,
    )
  ) {
    if (plan.regime.name !== "founder-controlled-live") {
      add(errors, "/plan-record/regime/name", "is invalid");
    }
    if (plan.regime.planned_run_count !== 1) {
      add(errors, "/plan-record/regime/planned_run_count", "must be exactly 1");
    }
    if (
      !Array.isArray(plan.regime.check_ids) ||
      plan.regime.check_ids.length !==
        ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_CHECK_IDS.length ||
      plan.regime.check_ids.some(
        (id, index) =>
          id !== ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_CHECK_IDS[index],
      )
    ) {
      add(
        errors,
        "/plan-record/regime/check_ids",
        "must be the exact predeclared check sequence",
      );
    }
  }
  if (
    exactObject(
      plan.recovery,
      [
        "mode",
        "restored_preparation_record_sha256",
        "restored_release_id",
        "restored_artifact_sha256",
        "restored_plist_sha256",
      ],
      "/plan-record/recovery",
      errors,
    )
  ) {
    if (
      plan.recovery.mode !== "disable_restore_same_candidate" &&
      plan.recovery.mode !== "rollback_previous_release"
    ) {
      add(errors, "/plan-record/recovery/mode", "is invalid");
    }
    if (!isSha256(plan.recovery.restored_preparation_record_sha256)) {
      add(
        errors,
        "/plan-record/recovery/restored_preparation_record_sha256",
        "must be one lowercase SHA-256 digest",
      );
    }
    if (
      typeof plan.recovery.restored_release_id !== "string" ||
      !RELEASE_ID_PATTERN.test(plan.recovery.restored_release_id)
    ) {
      add(
        errors,
        "/plan-record/recovery/restored_release_id",
        "must be an exact release identity",
      );
    }
    for (const key of ["restored_artifact_sha256", "restored_plist_sha256"]) {
      if (!isSha256(plan.recovery[key])) {
        add(
          errors,
          `/plan-record/recovery/${key}`,
          "must be one lowercase SHA-256 digest",
        );
      }
    }
    if (
      plan.recovery.mode === "disable_restore_same_candidate" &&
      (plan.recovery.restored_preparation_record_sha256 !==
        plan.preparation_record_sha256 ||
        plan.recovery.restored_release_id !== plan.candidate?.release_id ||
        plan.recovery.restored_artifact_sha256 !==
          plan.candidate?.artifact_sha256 ||
        plan.recovery.restored_plist_sha256 !==
          plan.candidate?.supervisor_plist_sha256)
    ) {
      add(
        errors,
        "/plan-record/recovery",
        "same-candidate recovery must match the planned candidate",
      );
    }
    if (
      plan.recovery.mode === "rollback_previous_release" &&
      (plan.recovery.restored_preparation_record_sha256 ===
        plan.preparation_record_sha256 ||
        plan.recovery.restored_release_id === plan.candidate?.release_id ||
        plan.recovery.restored_artifact_sha256 ===
          plan.candidate?.artifact_sha256 ||
        plan.recovery.restored_plist_sha256 ===
          plan.candidate?.supervisor_plist_sha256)
    ) {
      add(
        errors,
        "/plan-record/recovery",
        "previous-release recovery must be distinct from the candidate",
      );
    }
  }
}

function validatePlanCommitment(commitment, errors) {
  if (
    !exactObject(
      commitment,
      [
        "schema_version",
        "kind",
        "plan_sha256",
        "committed_at",
        "channel",
        "receipt_id",
      ],
      "/plan-commitment",
      errors,
    )
  ) {
    return;
  }
  if (commitment.schema_version !== 1) {
    add(errors, "/plan-commitment/schema_version", "must be 1");
  }
  if (
    commitment.kind !==
    "echo-organization-admin-edge-founder-live-plan-commitment"
  ) {
    add(errors, "/plan-commitment/kind", "is invalid");
  }
  if (!isSha256(commitment.plan_sha256)) {
    add(errors, "/plan-commitment/plan_sha256", "must be one SHA-256 digest");
  }
  if (!isIsoUtc(commitment.committed_at)) {
    add(
      errors,
      "/plan-commitment/committed_at",
      "must be an exact UTC timestamp",
    );
  }
  for (const key of ["channel", "receipt_id"]) {
    if (
      typeof commitment[key] !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(commitment[key])
    ) {
      add(errors, `/plan-commitment/${key}`, "is invalid");
    }
  }
}

function validateReportStructure(report, errors) {
  const keys = [
    "schema_version",
    "kind",
    "recorded_at",
    "started_at",
    "completed_at",
    "plan",
    "candidate",
    "observed_platform",
    "deployment",
    "preflight",
    "acceptance",
    "recovery",
    "failure_codes",
    "known_limitations",
    "maturity",
    "result",
  ];
  if (!exactObject(report, keys, "/", errors)) return false;
  if (report.schema_version !== 1) {
    add(errors, "/schema_version", "must be 1");
  }
  if (report.kind !== "echo-organization-admin-edge-founder-live-evidence") {
    add(errors, "/kind", "is invalid");
  }
  if (!isIsoUtc(report.recorded_at)) {
    add(errors, "/recorded_at", "must be an exact UTC timestamp");
  }
  for (const key of ["started_at", "completed_at"]) {
    if (report[key] !== null && !isIsoUtc(report[key])) {
      add(errors, `/${key}`, "must be null or an exact UTC timestamp");
    }
  }
  if (report.plan !== null) {
    if (
      exactObject(
        report.plan,
        [
          "record_sha256",
          "created_at",
          "committed_at",
          "commitment_receipt_sha256",
          "planned_run_count",
          "completed_run_count",
        ],
        "/plan",
        errors,
      )
    ) {
      if (!isSha256(report.plan.record_sha256)) {
        add(errors, "/plan/record_sha256", "must be one SHA-256 digest");
      }
      if (!isIsoUtc(report.plan.created_at)) {
        add(errors, "/plan/created_at", "must be an exact UTC timestamp");
      }
      if (!isIsoUtc(report.plan.committed_at)) {
        add(errors, "/plan/committed_at", "must be an exact UTC timestamp");
      }
      if (!isSha256(report.plan.commitment_receipt_sha256)) {
        add(
          errors,
          "/plan/commitment_receipt_sha256",
          "must bind one independent commitment receipt",
        );
      }
      if (report.plan.planned_run_count !== 1) {
        add(errors, "/plan/planned_run_count", "must be exactly 1");
      }
      if (
        !Number.isInteger(report.plan.completed_run_count) ||
        report.plan.completed_run_count < 0 ||
        report.plan.completed_run_count > 1
      ) {
        add(errors, "/plan/completed_run_count", "must be 0 or 1");
      }
    }
  }
  validateCandidate(report.candidate, "/candidate", errors);
  if (report.observed_platform !== null) {
    if (
      exactObject(
        report.observed_platform,
        ["os", "architecture", "node"],
        "/observed_platform",
        errors,
      )
    ) {
      if (
        report.observed_platform.os !== "darwin" ||
        report.observed_platform.architecture !== "arm64" ||
        report.observed_platform.node !== "22.22.1"
      ) {
        add(
          errors,
          "/observed_platform",
          "must be darwin/arm64 with Node 22.22.1",
        );
      }
    }
  }
  validateDeployment(report.deployment, "/deployment", errors, true);
  if (
    exactObject(
      report.preflight,
      ["ok", "release_platform_qualified", "record_sha256"],
      "/preflight",
      errors,
    )
  ) {
    if (typeof report.preflight.ok !== "boolean") {
      add(errors, "/preflight/ok", "must be boolean");
    }
    if (typeof report.preflight.release_platform_qualified !== "boolean") {
      add(errors, "/preflight/release_platform_qualified", "must be boolean");
    }
    if (
      report.preflight.record_sha256 !== null &&
      !isSha256(report.preflight.record_sha256)
    ) {
      add(errors, "/preflight/record_sha256", "must be null or a SHA-256");
    }
    if (
      report.preflight.ok === true &&
      !isSha256(report.preflight.record_sha256)
    ) {
      add(
        errors,
        "/preflight/record_sha256",
        "must bind a successful preflight",
      );
    }
  }
  validateAcceptance(report.acceptance, errors);
  validateRecovery(report.recovery, errors);
  validateFixedArray(
    report.failure_codes,
    FAILURE_CODES,
    15,
    "/failure_codes",
    errors,
  );
  validateFixedArray(
    report.known_limitations,
    ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_KNOWN_LIMITATIONS,
    4,
    "/known_limitations",
    errors,
  );
  if (report.maturity !== "DEV" && report.maturity !== "FOUNDER LIVE") {
    add(errors, "/maturity", "must be DEV or FOUNDER LIVE");
  }
  if (
    report.result !== "incomplete" &&
    report.result !== "pass" &&
    report.result !== "fail"
  ) {
    add(errors, "/result", "must be incomplete, pass, or fail");
  }
  return true;
}

function validateAcceptance(acceptance, errors) {
  if (
    !exactObject(
      acceptance,
      ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_CHECK_IDS,
      "/acceptance",
      errors,
    )
  ) {
    return;
  }
  for (const id of ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_CHECK_IDS) {
    const check = acceptance[id];
    const path = `/acceptance/${id}`;
    if (
      !exactObject(
        check,
        ["status", "evidence_sha256", "observed_at"],
        path,
        errors,
      )
    ) {
      continue;
    }
    if (!CHECK_STATUSES.includes(check.status)) {
      add(errors, `${path}/status`, "is invalid");
    }
    if (check.status === "not_run") {
      if (check.evidence_sha256 !== null || check.observed_at !== null) {
        add(
          errors,
          path,
          "a not-run check cannot contain evidence or an observation time",
        );
      }
    } else if (
      !isSha256(check.evidence_sha256) ||
      !isIsoUtc(check.observed_at)
    ) {
      add(
        errors,
        path,
        "a completed check requires an evidence digest and UTC observation",
      );
    }
  }
}

function validateRecovery(recovery, errors) {
  const keys = [
    "mode",
    "disable_status",
    "rollback_preflight_status",
    "restore_status",
    "service_restored",
    "restored_preparation_record_sha256",
    "restored_release_id",
    "restored_artifact_sha256",
    "restored_plist_sha256",
  ];
  if (!exactObject(recovery, keys, "/recovery", errors)) return;
  if (
    recovery.mode !== null &&
    recovery.mode !== "disable_restore_same_candidate" &&
    recovery.mode !== "rollback_previous_release"
  ) {
    add(errors, "/recovery/mode", "is invalid");
  }
  for (const key of [
    "disable_status",
    "rollback_preflight_status",
    "restore_status",
  ]) {
    if (!CHECK_STATUSES.includes(recovery[key])) {
      add(errors, `/recovery/${key}`, "is invalid");
    }
  }
  if (typeof recovery.service_restored !== "boolean") {
    add(errors, "/recovery/service_restored", "must be boolean");
  }
  if (
    recovery.restored_release_id !== null &&
    (typeof recovery.restored_release_id !== "string" ||
      !RELEASE_ID_PATTERN.test(recovery.restored_release_id))
  ) {
    add(
      errors,
      "/recovery/restored_release_id",
      "must be null or an exact release identity",
    );
  }
  for (const key of [
    "restored_preparation_record_sha256",
    "restored_artifact_sha256",
    "restored_plist_sha256",
  ]) {
    if (recovery[key] !== null && !isSha256(recovery[key])) {
      add(errors, `/recovery/${key}`, "must be null or one SHA-256 digest");
    }
  }
}

function validateFixedArray(value, allowed, maximum, path, errors) {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    new Set(value).size !== value.length ||
    value.some((entry) => !allowed.includes(entry))
  ) {
    add(errors, path, "contains invalid or duplicate fixed values");
  }
}

function validatePass(report, planContext, errors) {
  if (report.maturity !== "FOUNDER LIVE") {
    errors.push("a passing report must declare maturity FOUNDER LIVE");
  }
  if (
    report.plan === null ||
    !isPlainObject(planContext) ||
    !isPlainObject(planContext.plan) ||
    !isSha256(planContext.sha256) ||
    !isPlainObject(planContext.commitment) ||
    !isSha256(planContext.commitmentSha256)
  ) {
    errors.push(
      "a passing report requires the exact predeclared plan and independent commitment",
    );
    return;
  }
  const plan = planContext.plan;
  const commitment = planContext.commitment;
  validatePlan(plan, errors);
  validatePlanCommitment(commitment, errors);
  if (report.plan.record_sha256 !== planContext.sha256) {
    errors.push("the report does not bind the supplied plan bytes");
  }
  if (
    commitment.plan_sha256 !== planContext.sha256 ||
    report.plan.commitment_receipt_sha256 !== planContext.commitmentSha256 ||
    report.plan.committed_at !== commitment.committed_at
  ) {
    errors.push(
      "the report does not bind an independent pre-run plan commitment",
    );
  }
  if (
    report.plan.created_at !== plan.created_at ||
    report.plan.planned_run_count !== plan.regime?.planned_run_count ||
    report.plan.completed_run_count !== plan.regime?.planned_run_count
  ) {
    errors.push(
      "the report run count or declaration time differs from its plan",
    );
  }
  if (
    !isDeepStrictEqual(report.candidate, plan.candidate) ||
    !isDeepStrictEqual(report.deployment, plan.deployment) ||
    !isDeepStrictEqual(report.observed_platform, plan.observed_platform)
  ) {
    errors.push(
      "the executed platform, candidate, or deployment differs from its plan",
    );
  }
  if (
    report.recovery?.mode !== plan.recovery?.mode ||
    report.recovery?.restored_preparation_record_sha256 !==
      plan.recovery?.restored_preparation_record_sha256 ||
    report.recovery?.restored_release_id !==
      plan.recovery?.restored_release_id ||
    report.recovery?.restored_artifact_sha256 !==
      plan.recovery?.restored_artifact_sha256 ||
    report.recovery?.restored_plist_sha256 !==
      plan.recovery?.restored_plist_sha256
  ) {
    errors.push("the executed recovery identity differs from its plan");
  }

  const startedAt = Date.parse(report.started_at);
  const completedAt = Date.parse(report.completed_at);
  const recordedAt = Date.parse(report.recorded_at);
  const planCreatedAt = Date.parse(plan.created_at);
  const planCommittedAt = Date.parse(commitment.committed_at);
  if (
    !isIsoUtc(report.started_at) ||
    !isIsoUtc(report.completed_at) ||
    !isIsoUtc(commitment.committed_at) ||
    planCommittedAt < planCreatedAt ||
    startedAt <= planCommittedAt ||
    completedAt < startedAt ||
    recordedAt < completedAt
  ) {
    errors.push("a passing report requires plan-before-run chronology");
  }

  const checks = ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_CHECK_IDS.map(
    (id) => report.acceptance?.[id],
  );
  if (
    !checks.every(
      (check) =>
        check?.status === "pass" &&
        isSha256(check.evidence_sha256) &&
        isIsoUtc(check.observed_at) &&
        Date.parse(check.observed_at) >= startedAt &&
        Date.parse(check.observed_at) <= completedAt,
    )
  ) {
    errors.push(
      "a passing report requires every planned check within the live run",
    );
  }
  const observedTimes = checks.map((check) => Date.parse(check?.observed_at));
  if (
    observedTimes.some(
      (observedAt, index) =>
        index > 0 && observedAt <= observedTimes[index - 1],
    )
  ) {
    errors.push(
      "a passing report requires acceptance observations in planned order",
    );
  }
  if (
    report.preflight?.ok !== true ||
    report.preflight?.release_platform_qualified !== true ||
    !isSha256(report.preflight?.record_sha256)
  ) {
    errors.push("a passing report requires a qualifying target preflight");
  } else if (report.preflight.record_sha256 !== plan.preflight_record_sha256) {
    errors.push("the report preflight differs from the planned preflight");
  }
  if (report.observed_platform === null) {
    errors.push("a passing report requires an observed release platform");
  }
  if (
    report.recovery?.disable_status !== "pass" ||
    report.recovery?.rollback_preflight_status !== "pass" ||
    report.recovery?.restore_status !== "pass" ||
    report.recovery?.service_restored !== true
  ) {
    errors.push("a passing report requires disable and recovery proof");
  }
  if (!Array.isArray(report.failure_codes) || report.failure_codes.length > 0) {
    errors.push("a passing report cannot contain failure codes");
  }
  const actualLimitations = Array.isArray(report.known_limitations)
    ? [...report.known_limitations].sort()
    : [];
  const fixedLimitations = [
    ...ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_KNOWN_LIMITATIONS,
  ].sort();
  if (
    actualLimitations.length !== fixedLimitations.length ||
    actualLimitations.some(
      (limitation, index) => limitation !== fixedLimitations[index],
    )
  ) {
    errors.push(
      "a passing report must declare the exact four known limitations",
    );
  }
}

export function validateOrganizationAdminEdgeFounderLiveEvidence(
  report,
  planContext = null,
) {
  const errors = [];
  if (!validateReportStructure(report, errors)) {
    return { ok: false, errors: [...new Set(errors)].sort() };
  }

  const checks = ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_CHECK_IDS.map(
    (id) => report.acceptance?.[id],
  );
  if (report.result === "pass") {
    validatePass(report, planContext, errors);
  } else {
    if (report.maturity !== "DEV") {
      errors.push("an incomplete or failed report must remain at DEV maturity");
    }
    if (report.result === "fail") {
      const hasFailure =
        Array.isArray(report.failure_codes) && report.failure_codes.length > 0;
      const hasFailedCheck = checks.some((check) => check?.status === "fail");
      if (!hasFailure || !hasFailedCheck) {
        errors.push(
          "a failed report requires both a fixed failure code and a failed check",
        );
      }
    } else if (report.result === "incomplete") {
      const hasFailure =
        Array.isArray(report.failure_codes) && report.failure_codes.length > 0;
      const hasFailedCheck = checks.some((check) => check?.status === "fail");
      if (hasFailure || hasFailedCheck) {
        errors.push(
          "an incomplete report cannot hide a failure code or failed check",
        );
      }
    }
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)].sort() };
}

function normalizedAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return value;
}

function readStableJson(path, label) {
  const state = lstatSync(path);
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    realpathSync(path) !== path ||
    state.size > MAX_RECORD_BYTES
  ) {
    throw new Error(`${label} must be a canonical bounded regular file`);
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== state.dev ||
      opened.ino !== state.ino ||
      opened.size !== state.size
    ) {
      throw new Error(`${label} changed while opening`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      bytes.length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`${label} changed while reading`);
    }
    try {
      return {
        value: JSON.parse(bytes.toString("utf8")),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch {
      throw new Error(`${label} is not valid JSON`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function parseArgs(argv) {
  if (
    argv.length !== 6 ||
    argv[0] !== "--report" ||
    argv[2] !== "--plan" ||
    argv[4] !== "--commitment"
  ) {
    throw new Error(
      "usage: validate-founder-live-evidence --report <absolute-path> --plan <absolute-path> --commitment <absolute-path>",
    );
  }
  return {
    report: normalizedAbsolutePath(argv[1], "report"),
    plan: normalizedAbsolutePath(argv[3], "plan"),
    commitment: normalizedAbsolutePath(argv[5], "commitment"),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportRecord = readStableJson(args.report, "Founder Live evidence");
  const planRecord = readStableJson(args.plan, "Founder Live plan");
  const commitmentRecord = readStableJson(
    args.commitment,
    "Founder Live plan commitment",
  );
  const result = validateOrganizationAdminEdgeFounderLiveEvidence(
    reportRecord.value,
    {
      plan: planRecord.value,
      sha256: planRecord.sha256,
      commitment: commitmentRecord.value,
      commitmentSha256: commitmentRecord.sha256,
    },
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `admin-edge-validate-founder-live-evidence: ${error.message}\n`,
    );
    process.exitCode = 1;
  }
}
