#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv";
import {
  ALL_CHECK_IDS,
  BLOCKED_CHECK_IDS,
  BLOCKED_CHECK_REASON_BY_ID,
  PASSING_CHECK_IDS,
} from "./report.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DEFAULT_REPORT_SCHEMA_PATH = resolve(
  REPO_ROOT,
  "schemas/phase5/one-machine-rehearsal-report.v1.schema.json",
);
const MAX_REPORT_BYTES = 256 * 1024;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FORBIDDEN_KEY_PART =
  /(?:^|_)(?:error|exception|message|detail|note|description|path|directory|filename|hostname|host_name|machine|username|user_name|operator|account|email|ip|ip_address|address|token|secret|password|credential|authorization|grant|private_key|request|response|header|headers|body|stdout|stderr)(?:_|$)/i;
const ABSOLUTE_PATH =
  /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/]|\\\\)|(?:^|[\s=])\/(?:Users|home|private|tmp|var|etc|opt|usr|Volumes)(?:\/|$)/;
const IPV4 =
  /(?:^|[^0-9])(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}(?:$|[^0-9])/;
const HOSTNAME =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:local|lan|internal|corp|com|net|org|io|dev)$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
const SECRET_VALUE =
  /(?:\bBearer\s+|\bEcho-(?:Proxy|Enrollment)\s+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bxox[baprs]-|\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|x-echo-(?:proxy-authorization|authenticated-client-id))/i;
const CANONICAL_32_BYTE_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const URL_VALUE = /\b[a-z][a-z0-9+.-]*:\/\//i;

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function displayPath(path) {
  return path === "" ? "/" : path;
}

function scanReportContent(value) {
  const errors = [];
  const visited = new WeakSet();

  function visit(current, path, key) {
    if (typeof current === "string") {
      if (ABSOLUTE_PATH.test(current)) {
        errors.push(`${displayPath(path)} contains an absolute local path`);
      }
      if (URL_VALUE.test(current)) {
        errors.push(`${displayPath(path)} contains a URL or hostname`);
      }
      if (IPV4.test(current)) {
        errors.push(`${displayPath(path)} contains an IP address`);
      }
      const unbracketed =
        current.startsWith("[") && current.endsWith("]")
          ? current.slice(1, -1)
          : current;
      if (isIP(unbracketed) !== 0) {
        errors.push(`${displayPath(path)} contains an IP address`);
      }
      if (EMAIL.test(current)) {
        errors.push(`${displayPath(path)} contains an email or username`);
      }
      if (key !== "version" && key !== "node" && HOSTNAME.test(current)) {
        errors.push(`${displayPath(path)} contains a hostname`);
      }
      if (
        SECRET_VALUE.test(current) ||
        CANONICAL_32_BYTE_BASE64URL.test(current)
      ) {
        errors.push(`${displayPath(path)} contains secret-like content`);
      }
      return;
    }
    if (current === null || typeof current !== "object") return;
    if (visited.has(current)) {
      errors.push(`${displayPath(path)} contains a cycle`);
      return;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      current.forEach((item, index) =>
        visit(item, `${path}/${String(index)}`, String(index)),
      );
      return;
    }
    if (!isPlainObject(current)) {
      errors.push(`${displayPath(path)} must contain only plain JSON objects`);
      return;
    }
    if (Object.getOwnPropertySymbols(current).length > 0) {
      errors.push(`${displayPath(path)} contains symbol properties`);
    }
    for (const [property, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(current),
    )) {
      const propertyPath = `${path}/${property}`;
      if (FORBIDDEN_KEY_PART.test(property)) {
        errors.push(
          `${displayPath(propertyPath)} is a forbidden free-form or sensitive field`,
        );
      }
      if (!("value" in descriptor)) {
        errors.push(`${displayPath(propertyPath)} contains an accessor`);
        continue;
      }
      visit(descriptor.value, propertyPath, property);
    }
  }

  visit(value, "", "");
  return uniqueSorted(errors);
}

function formatSchemaError(error) {
  const path = error.instancePath === "" ? "/" : error.instancePath;
  return `${path} violates report schema (${error.keyword})`;
}

function compileSchema(schemaPath) {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: true });
  return ajv.compile(schema);
}

function timestampMillis(value) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    return null;
  }
  return milliseconds;
}

function checkContractErrors(report) {
  const errors = [];
  if (!isPlainObject(report) || !Array.isArray(report.checks)) return errors;

  const seen = new Set();
  for (const check of report.checks) {
    if (!isPlainObject(check) || typeof check.id !== "string") continue;
    const known = ALL_CHECK_IDS.includes(check.id);
    if (seen.has(check.id)) {
      errors.push(
        known
          ? `duplicate Phase 5 check: ${check.id}`
          : "duplicate unexpected Phase 5 check identifier",
      );
    }
    seen.add(check.id);
    if (!known) {
      errors.push("unexpected Phase 5 check identifier");
    }
  }
  for (const id of ALL_CHECK_IDS) {
    if (!seen.has(id)) errors.push(`missing Phase 5 check: ${id}`);
  }

  ALL_CHECK_IDS.forEach((expectedId, index) => {
    const check = report.checks[index];
    if (!isPlainObject(check) || check.id !== expectedId) {
      errors.push(`Phase 5 check order differs at position ${String(index)}`);
      return;
    }
    if (PASSING_CHECK_IDS.includes(expectedId)) {
      if (check.status !== "pass") {
        errors.push(`${expectedId} must pass in a rehearsal-passed report`);
      }
      if (typeof check.evidence_sha256 !== "string") {
        errors.push(`${expectedId} must bind hash-only evidence`);
      }
      if ("reason_code" in check) {
        errors.push(`${expectedId} must not carry a reason or free-form error`);
      }
      return;
    }
    if (check.status !== "blocked") {
      errors.push(`${expectedId} must remain blocked in a one-machine report`);
    }
    if (check.reason_code !== BLOCKED_CHECK_REASON_BY_ID[expectedId]) {
      errors.push(`${expectedId} has an unexpected blocked reason code`);
    }
    if ("evidence_sha256" in check) {
      errors.push(`${expectedId} must not masquerade as passing evidence`);
    }
  });

  const sourceSha = report.source_sha;
  const artifacts = isPlainObject(report.artifacts) ? report.artifacts : {};
  for (const target of ["employee", "authority", "ceremony_driver"]) {
    const identity = artifacts[target];
    if (isPlainObject(identity) && identity.source_sha !== sourceSha) {
      errors.push(`${target} source identity differs from the report`);
    }
  }

  const startedAt = timestampMillis(report.started_at);
  const completedAt = timestampMillis(report.completed_at);
  if (startedAt === null) errors.push("started_at is not a real timestamp");
  if (completedAt === null) errors.push("completed_at is not a real timestamp");
  if (startedAt !== null && completedAt !== null && completedAt < startedAt) {
    errors.push("completed_at precedes started_at");
  }
  for (const check of report.checks) {
    if (!isPlainObject(check)) continue;
    const observedAt = timestampMillis(check.observed_at);
    if (observedAt === null) {
      if (typeof check.id === "string") {
        const label = ALL_CHECK_IDS.includes(check.id)
          ? check.id
          : "unknown Phase 5 check";
        errors.push(`${label} observed_at is not a real timestamp`);
      }
      continue;
    }
    if (
      startedAt !== null &&
      completedAt !== null &&
      (observedAt < startedAt || observedAt > completedAt)
    ) {
      const label =
        typeof check.id === "string" && ALL_CHECK_IDS.includes(check.id)
          ? check.id
          : "unknown Phase 5 check";
      errors.push(`${label} observation is outside the run window`);
    }
  }

  const topology = isPlainObject(report.topology) ? report.topology : {};
  const installations = Array.isArray(topology.installations)
    ? topology.installations
    : [];
  if (installations[0]?.label !== "A" || installations[1]?.label !== "B") {
    errors.push("topology installations must be ordered A then B");
  }
  for (const property of [
    "principal_id",
    "membership_id",
    "installation_id",
    "installation_key_id",
  ]) {
    const values = installations
      .map((installation) => installation?.[property])
      .filter((value) => typeof value === "string");
    if (values.length === 2 && new Set(values).size !== 2) {
      errors.push(`installation A and B share ${property}`);
    }
  }

  for (const id of BLOCKED_CHECK_IDS) {
    const check = report.checks.find((candidate) => candidate?.id === id);
    if (check?.status !== "blocked") {
      errors.push(`${id} cannot be waived by a one-machine rehearsal`);
    }
  }
  return uniqueSorted(errors);
}

/**
 * Validates both the closed JSON shape and the semantic non-qualification and
 * privacy contracts. Error strings never reproduce report values.
 */
export function validateOneMachineRehearsalReport(report, options = {}) {
  const safetyErrors = scanReportContent(report);
  if (safetyErrors.length > 0) return { ok: false, errors: safetyErrors };

  let validateSchema;
  try {
    validateSchema = compileSchema(
      resolve(options.schemaPath ?? DEFAULT_REPORT_SCHEMA_PATH),
    );
  } catch {
    return {
      ok: false,
      errors: ["Phase 5 report schema could not be loaded"],
    };
  }
  const schemaOk = validateSchema(report);
  const schemaErrors = schemaOk
    ? []
    : (validateSchema.errors ?? []).map(formatSchemaError);
  const semanticErrors = checkContractErrors(report);
  const errors = uniqueSorted([...schemaErrors, ...semanticErrors]);
  return { ok: errors.length === 0, errors };
}

function readBoundedReport(path) {
  const state = lstatSync(path);
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    state.size > MAX_REPORT_BYTES
  ) {
    throw new Error("unsafe report file");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--report") {
    throw new Error("usage: validate-report.mjs --report ABSOLUTE_PATH");
  }
  if (!isAbsolute(argv[1])) {
    throw new Error("--report must be an absolute path");
  }
  return argv[1];
}

async function main() {
  let result;
  try {
    const report = readBoundedReport(parseArguments(process.argv.slice(2)));
    result = validateOneMachineRehearsalReport(report);
  } catch {
    result = {
      ok: false,
      errors: ["Phase 5 report could not be read as bounded JSON"],
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
