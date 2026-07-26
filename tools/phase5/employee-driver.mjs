#!/usr/bin/env node

import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Phase5DevelopmentFileInstallationSigner } from "./development-file-installation-signer.mjs";

const MAX_INPUT_BYTES = 128 * 1024;
const MAXIMUM_ACTIVE_LEASE_TTL_MS = 5 * 60 * 1000;

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be one object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has an unexpected shape`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function decodeGrant(value) {
  const text = requiredString(value, "enrollment grant");
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) {
    throw new Error("enrollment grant is invalid");
  }
  const grant = Buffer.from(text, "base64url");
  if (grant.length !== 32 || grant.toString("base64url") !== text) {
    throw new Error("enrollment grant is invalid");
  }
  return grant;
}

async function loadExactRuntime(packageRoot) {
  const organization = await import(
    pathToFileURL(join(packageRoot, "dist/product/organization/index.js")).href
  );
  const federation = await import(
    pathToFileURL(
      join(packageRoot, "node_modules/@echo-brain/federation-protocol/dist/index.js"),
    ).href
  );
  return { organization, federation };
}

function safeDecision(decision) {
  const state = decision.state;
  return {
    permitted: decision.permitted,
    status: state.status,
    revocation_reason: state.revocation_reason,
    sequence: state.access_state_sequence,
    state_payload_sha256: state.integrity.payload_sha256,
    evaluated_at: state.evaluated_at,
    valid_until: state.valid_until,
  };
}

function safeInspection(state, signer) {
  const enrollment = state.readEnrollment();
  if (enrollment === null) {
    return { enrollment_status: "absent" };
  }
  return signer.inspect(enrollment.request.installation_id).then((key) => ({
    enrollment_status: enrollment.receipt === null ? "pending" : "enrolled",
    installation_id: enrollment.request.installation_id,
    installation_key_id: key?.key_id ?? null,
    request_payload_sha256: enrollment.request.integrity.payload_sha256,
    receipt_payload_sha256:
      enrollment.receipt?.integrity.payload_sha256 ?? null,
    accepted_sequence: enrollment.accepted_access_sequence,
    accepted_state_sha256: enrollment.accepted_access_sha256,
  }));
}

function normalizeError(error, command) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "ORGANIZATION_STATE_CORRUPT") return "STATE_CORRUPT";
  if (code === "ORGANIZATION_STATE_UNAVAILABLE") return "STATE_UNAVAILABLE";
  if (code === "ORGANIZATION_STATE_CONFLICT") return "STATE_CONFLICT";
  if (code === "ORGANIZATION_CLOCK_ROLLBACK") return "CLOCK_ROLLBACK";
  if (code === "transport_failed") return "TRANSPORT_FAILED";
  if (code === "unauthorized") return "UNAUTHORIZED";
  if (code === "request_rejected") return "REQUEST_REJECTED";
  if (code === "invalid_response" || code === "response_too_large") {
    return "INVALID_RESPONSE";
  }
  if (
    command === "refresh" &&
    error instanceof Error &&
    /^(?:signed document|organization access state|access state|organization installation access state)/.test(
      error.message,
    )
  ) {
    return "SIGNED_STATE_REJECTED";
  }
  return "OPERATION_FAILED";
}

export async function executeEmployeeCommand(input) {
  const command =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? input.command
      : undefined;
  const base = exactObject(
    input,
    command === "enroll"
      ? [
          "command",
          "package_root",
          "database_path",
          "key_directory",
          "base_url",
          "authority_descriptor",
          "authority_pin_sha256",
          "enrollment_grant_base64url",
          "principal_id",
          "membership_id",
          "installation_id",
        ]
      : [
          "command",
          "package_root",
          "database_path",
          "key_directory",
          "base_url",
        ],
    "employee command",
  );
  if (!["enroll", "refresh", "current", "inspect"].includes(base.command)) {
    throw new Error("employee command is unsupported");
  }
  const packageRoot = requiredString(base.package_root, "package root");
  const { organization, federation } = await loadExactRuntime(packageRoot);
  const state = new organization.SqliteOrganizationStateStore(
    requiredString(base.database_path, "database path"),
  );
  const signer = new Phase5DevelopmentFileInstallationSigner({
    directory: requiredString(base.key_directory, "key directory"),
    federation,
  });
  try {
    if (base.command === "inspect") {
      return await safeInspection(state, signer);
    }
    const coordinator = new organization.LocalOrganizationCoordinator({
      state,
      authorityClient: new organization.HttpOrganizationAuthorityClient({
        baseUrl: requiredString(base.base_url, "base URL"),
        allowInsecureLoopback: true,
      }),
      installationSigner: signer,
      maximumActiveLeaseTtlMs: MAXIMUM_ACTIVE_LEASE_TTL_MS,
    });
    if (base.command === "enroll") {
      const decision = await coordinator.enroll({
        authorityDescriptor: base.authority_descriptor,
        independentlyTrustedAuthorityPin: requiredString(
          base.authority_pin_sha256,
          "authority pin",
        ),
        enrollmentGrant: decodeGrant(base.enrollment_grant_base64url),
        principalId: requiredString(base.principal_id, "principal ID"),
        membershipId: requiredString(base.membership_id, "membership ID"),
        installationId: requiredString(base.installation_id, "installation ID"),
      });
      return safeDecision(decision);
    }
    const decision =
      base.command === "refresh"
        ? await coordinator.refreshAccess()
        : coordinator.currentAccess();
    return safeDecision(decision);
  } finally {
    state.close();
  }
}

async function readBoundedInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_INPUT_BYTES)
      throw new Error("employee input is too large");
    chunks.push(bytes);
  }
  if (length === 0) throw new Error("employee input is empty");
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
}

async function main() {
  let command = "unknown";
  try {
    const input = await readBoundedInput();
    if (typeof input?.command === "string") command = input.command;
    const result = await executeEmployeeCommand(input);
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error_code: normalizeError(error, command) })}\n`,
    );
    process.exitCode = 2;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
