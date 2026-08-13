#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";

const REPO = process.cwd();
const DOCS = join(REPO, "docs");
const TEMPLATE_ROOT = join(DOCS, "_templates");
const RECORD_DIRECTORIES = new Set([
  "components",
  "invariants",
  "decisions",
  "failure-patterns",
  "operations",
  "qualification",
  "rfcs",
]);
const KINDS = new Set([
  "component-index",
  "component",
  "invariant",
  "decision",
  "rfc",
  "failure-pattern",
  "playbook",
  "runbook",
  "qualification-matrix",
  "qualification",
  "evidence-index",
]);
const ID_PATTERNS = new Map([
  ["component-index", /^CMP-CATALOG$/],
  ["component", /^CMP-[A-Z][A-Z0-9-]+$/],
  ["invariant", /^INV-[A-Z][A-Z0-9-]+-\d{3}$/],
  ["decision", /^ADR-\d{4}$/],
  ["rfc", /^RFC-\d{4}$/],
  ["failure-pattern", /^FP-[A-Z][A-Z0-9-]+-\d{3}$/],
  ["playbook", /^PB-[A-Z][A-Z0-9-]+-\d{3}$/],
  ["runbook", /^RB-[A-Z][A-Z0-9-]+-\d{3}$/],
  ["qualification-matrix", /^QMAT-[A-Z][A-Z0-9-]+-\d{3}$/],
  ["qualification", /^QUAL-\d{8}-\d{6}-\d{3}$/],
  ["evidence-index", /^EVID-INDEX-\d{3}$/],
]);
const LEGACY_INVARIANTS = new Set([
  ...Array.from(
    { length: 12 },
    (_, index) => `INV-${String(index + 1).padStart(2, "0")}`,
  ),
  "INV-11A",
  "INV-11B",
  ...Array.from(
    { length: 8 },
    (_, index) => `AD-${String(index + 1).padStart(2, "0")}`,
  ),
]);
const RELATIONS = new Map([
  ["component_ids", new Set(["component"])],
  ["invariant_ids", new Set(["invariant"])],
  ["decision_ids", new Set(["decision"])],
  ["failure_pattern_ids", new Set(["failure-pattern"])],
  ["runbook_ids", new Set(["runbook"])],
  ["qualification_ids", new Set(["qualification", "qualification-matrix"])],
]);

function markdownFiles(root) {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return markdownFiles(path);
      return entry.isFile() && path.endsWith(".md") ? [path] : [];
    })
    .sort();
}

function scalar(raw) {
  const value = raw.trim();
  if (value === "[]") return [];
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^(['"]).*\1$/.test(value)) return value.slice(1, -1);
  return value;
}

function parseFrontMatter(path, source, errors) {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    errors.push(`${relative(REPO, path)}: unterminated front matter`);
    return null;
  }
  const metadata = {};
  let arrayKey = null;
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item) {
      if (!arrayKey || !Array.isArray(metadata[arrayKey]))
        errors.push(
          `${relative(REPO, path)}:${index + 1}: list item has no array field`,
        );
      else metadata[arrayKey].push(scalar(item[1]));
      continue;
    }
    const field = /^([a-z][a-z0-9_]*):(?:\s*(.*))?$/.exec(line);
    if (!field) {
      errors.push(
        `${relative(REPO, path)}:${index + 1}: unsupported front-matter syntax`,
      );
      arrayKey = null;
      continue;
    }
    const [, key, raw = ""] = field;
    if (Object.hasOwn(metadata, key))
      errors.push(
        `${relative(REPO, path)}:${index + 1}: duplicate field ${key}`,
      );
    metadata[key] = raw === "" ? [] : scalar(raw);
    arrayKey = raw === "" ? key : null;
  }
  return metadata;
}

function required(record, field, errors) {
  const value = record.metadata[field];
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  )
    errors.push(`${record.path}: missing required field ${field}`);
  return value;
}

function array(record, field, errors, mustExist = false) {
  if (record.metadata[field] === undefined) {
    if (mustExist)
      errors.push(`${record.path}: missing required field ${field}`);
    return [];
  }
  const value = record.metadata[field];
  if (!Array.isArray(value)) {
    errors.push(`${record.path}: ${field} must be an array`);
    return [];
  }
  if (new Set(value).size !== value.length)
    errors.push(`${record.path}: ${field} contains duplicate values`);
  return value;
}

function relationValues(record, field) {
  const value = record.metadata[field];
  return Array.isArray(value) ? value : [];
}

function date(value, label, record, errors) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)))
    errors.push(`${record.path}: ${label} must use YYYY-MM-DD`);
}

function tableCells(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim().replace(/^\x60|\x60$/g, ""));
}

function markdownTable(source, requiredHeaders) {
  const lines = source.split(/\r?\n/);
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (
      !lines[index].includes("|") ||
      !/^\s*\|?\s*:?-{3,}/.test(lines[index + 1])
    )
      continue;
    const headers = tableCells(lines[index]).map((cell) => cell.toLowerCase());
    if (
      !requiredHeaders.every((header) => headers.includes(header.toLowerCase()))
    )
      continue;
    const rows = [];
    for (
      let row = index + 2;
      row < lines.length && lines[row].includes("|");
      row += 1
    ) {
      const cells = tableCells(lines[row]);
      if (cells.length !== headers.length) break;
      rows.push(
        Object.fromEntries(
          headers.map((header, column) => [header, cells[column]]),
        ),
      );
    }
    return rows;
  }
  return null;
}

function gitObjectExists(spec) {
  return (
    spawnSync("git", ["cat-file", "-e", spec], { cwd: REPO, stdio: "ignore" })
      .status === 0
  );
}

function fullSha(value) {
  return /^[0-9a-f]{40}$/.test(String(value));
}

function sameSet(left, right) {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function validateShape(record, errors) {
  const { metadata } = record;
  if (metadata.schema_version !== 1)
    errors.push(`${record.path}: schema_version must equal 1`);
  for (const field of [
    "id",
    "kind",
    "title",
    "component_ids",
    "created_at",
    "reviewed_at",
    "reviewed_ref",
  ])
    required(record, field, errors);
  if (["component", "component-index"].includes(metadata.kind))
    required(record, "owners", errors);
  array(record, "component_ids", errors, true);
  if (metadata.owners !== undefined) array(record, "owners", errors);
  if (!KINDS.has(metadata.kind)) {
    errors.push(`${record.path}: unsupported kind ${String(metadata.kind)}`);
    return;
  }
  if (
    typeof metadata.id !== "string" ||
    !ID_PATTERNS.get(metadata.kind).test(metadata.id)
  )
    errors.push(
      `${record.path}: id ${String(metadata.id)} does not match kind ${metadata.kind}`,
    );
  if (
    typeof metadata.id === "string" &&
    /(?:DOMAIN|YYYY|000)$/.test(metadata.id)
  )
    errors.push(`${record.path}: template placeholder id is not allowed`);
  date(metadata.created_at, "created_at", record, errors);
  date(metadata.reviewed_at, "reviewed_at", record, errors);
  if (!fullSha(metadata.reviewed_ref))
    errors.push(
      `${record.path}: reviewed_ref must be a full lowercase commit SHA`,
    );
  else if (!gitObjectExists(`${metadata.reviewed_ref}^{commit}`))
    errors.push(`${record.path}: reviewed_ref does not name a local commit`);
  for (const field of RELATIONS.keys()) array(record, field, errors);
}

function validateEvidence(record, errors) {
  const rows = markdownTable(record.source, ["Evidence ID", "SHA-256"]);
  if (!rows) {
    errors.push(
      `${record.path}: evidence index requires an Evidence ID and SHA-256 table`,
    );
    return new Set();
  }
  const ids = new Set();
  const hashes = new Set();
  for (const row of rows) {
    const id = row["evidence id"];
    const digest = row["sha-256"];
    if (!/^EVID-[A-Z0-9-]+$/.test(id))
      errors.push(`${record.path}: invalid evidence id ${id}`);
    if (ids.has(id)) errors.push(`${record.path}: duplicate evidence id ${id}`);
    if (!/^[0-9a-f]{64}$/.test(digest))
      errors.push(`${record.path}: evidence ${id} must have a 64-hex SHA-256`);
    else if (hashes.has(digest))
      errors.push(`${record.path}: duplicate evidence SHA-256 ${digest}`);
    ids.add(id);
    hashes.add(digest);
  }
  return ids;
}

function validateMatrix(record, errors) {
  const { metadata } = record;
  if (!Number.isInteger(metadata.matrix_version) || metadata.matrix_version < 1)
    errors.push(`${record.path}: matrix_version must be a positive integer`);
  const rows =
    markdownTable(record.source, ["Assertion ID", "Assertion"]) ??
    markdownTable(record.source, ["Case", "Boundary to exercise"]);
  if (!rows?.length) {
    errors.push(
      `${record.path}: qualification matrix requires a nonempty Assertion ID table`,
    );
    return new Set();
  }
  const ids = new Set();
  for (const row of rows) {
    const id = row["assertion id"] ?? row.case;
    if (!/^[A-Z][A-Z0-9-]*-(?:[A-Z]\d{2}|\d{3})$/.test(id))
      errors.push(`${record.path}: invalid matrix assertion id ${id}`);
    if (ids.has(id))
      errors.push(`${record.path}: duplicate matrix assertion id ${id}`);
    ids.add(id);
  }
  const declared = array(record, "assertion_ids", errors, true);
  if (!sameSet(new Set(declared), ids))
    errors.push(
      `${record.path}: matrix assertion_ids must exactly match its Assertion ID table`,
    );
  return ids;
}

function qualificationRows(record, errors) {
  const rows = markdownTable(record.source, [
    "Assertion",
    "Outcome",
    "Evidence",
  ]);
  if (!rows?.length) {
    errors.push(
      `${record.path}: qualification requires a nonempty Assertion/Outcome/Evidence result table`,
    );
    return new Map();
  }
  const results = new Map();
  for (const row of rows) {
    const evidenceIds = row.evidence
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (results.has(row.assertion))
      errors.push(
        `${record.path}: duplicate qualification assertion result ${row.assertion}`,
      );
    results.set(row.assertion, { outcome: row.outcome, evidenceIds });
  }
  return results;
}

function validateCommitRef(record, field, errors) {
  const value = record.metadata[field];
  if (!fullSha(value))
    errors.push(`${record.path}: ${field} must be a full lowercase commit SHA`);
  else if (!gitObjectExists(`${value}^{commit}`))
    errors.push(`${record.path}: ${field} does not name a local commit`);
}

function validateFailurePattern(record, evidenceIds, errors) {
  const { metadata } = record;
  for (const field of [
    "origin",
    "evidence_status",
    "status",
    "severity",
    "first_observed",
    "evidence_ids",
  ])
    required(record, field, errors);
  date(metadata.first_observed, "first_observed", record, errors);
  for (const id of array(record, "evidence_ids", errors, true))
    if (!evidenceIds.has(id))
      errors.push(`${record.path}: unknown evidence id ${id}`);
  for (const ref of array(record, "implementation_refs", errors)) {
    const match = /^commit:([0-9a-f]{40})$/.exec(ref);
    if (!match)
      errors.push(
        `${record.path}: implementation ref must use commit:<full-sha>: ${ref}`,
      );
    else if (!gitObjectExists(`${match[1]}^{commit}`))
      errors.push(
        `${record.path}: implementation ref does not name a local commit ${ref}`,
      );
  }
  for (const ref of array(record, "regression_test_refs", errors)) {
    const match = /^([^@]+)@([0-9a-f]{40})$/.exec(ref);
    if (
      !match ||
      match[1].startsWith("/") ||
      match[1].split("/").includes("..")
    )
      errors.push(
        `${record.path}: regression ref must use repository-path@full-sha: ${ref}`,
      );
    else if (!gitObjectExists(`${match[2]}:${match[1]}`))
      errors.push(
        `${record.path}: regression test path does not exist at claimed commit: ${ref}`,
      );
  }
  if (
    metadata.status === "mitigated" &&
    relationValues(record, "qualification_ids").length === 0 &&
    relationValues(record, "regression_test_refs").length === 0
  )
    errors.push(`${record.path}: mitigated pattern requires linked proof`);
}

function validateQualification(
  record,
  recordsById,
  evidenceIds,
  matrices,
  errors,
) {
  const { metadata } = record;
  for (const field of [
    "run_status",
    "result",
    "stop_reason",
    "source_commit",
    "artifact_digest",
    "configuration_identity",
    "state_identity",
    "started_at",
    "completed_at",
    "matrix_id",
    "matrix_version",
    "assertion_ids",
    "evidence_ids",
  ])
    required(record, field, errors);
  if (!["completed", "halted", "aborted"].includes(metadata.run_status))
    errors.push(`${record.path}: invalid run_status`);
  if (!["passed", "failed", "inconclusive"].includes(metadata.result))
    errors.push(`${record.path}: invalid qualification result`);
  if (metadata.source_commit !== "not-applicable")
    validateCommitRef(record, "source_commit", errors);
  if (
    !/^(?:sha256:[0-9a-f]{64}|not-applicable)$/.test(
      String(metadata.artifact_digest),
    )
  )
    errors.push(
      `${record.path}: artifact_digest must be exact or not-applicable`,
    );
  for (const field of ["configuration_identity", "state_identity"])
    if (
      !/^(?:opaque:[A-Z0-9][A-Z0-9-]*|sha256:[0-9a-f]{64}|not-applicable)$/.test(
        String(metadata[field]),
      )
    )
      errors.push(
        `${record.path}: ${field} must be opaque, a SHA-256, or not-applicable`,
      );
  if (
    metadata.started_at !== "not-recorded" &&
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(
      metadata.started_at,
    )
  )
    errors.push(`${record.path}: started_at must be RFC 3339 or not-recorded`);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(
      metadata.completed_at,
    )
  )
    errors.push(`${record.path}: completed_at must be RFC 3339`);
  const matrix = recordsById.get(metadata.matrix_id);
  if (matrix?.metadata.kind !== "qualification-matrix")
    errors.push(`${record.path}: matrix_id does not resolve to a matrix`);
  else if (metadata.matrix_version !== matrix.metadata.matrix_version)
    errors.push(
      `${record.path}: matrix_version does not match ${metadata.matrix_id}`,
    );
  const expected = matrices.get(metadata.matrix_id) ?? new Set();
  const assertions = array(record, "assertion_ids", errors, true);
  const results = qualificationRows(record, errors);
  if (
    !sameSet(new Set(assertions), expected) ||
    !sameSet(new Set(results.keys()), expected)
  )
    errors.push(
      `${record.path}: qualification assertions must exactly match its matrix`,
    );
  const reportEvidence = new Set(array(record, "evidence_ids", errors, true));
  for (const id of reportEvidence)
    if (!evidenceIds.has(id))
      errors.push(`${record.path}: unknown evidence id ${id}`);
  let allAssertionsPassed = results.size > 0;
  for (const [id, row] of results) {
    if (!["passed", "failed", "not-run"].includes(row.outcome))
      errors.push(
        `${record.path}: assertion ${id} has invalid outcome ${row.outcome}`,
      );
    if (!row.evidenceIds.length)
      errors.push(`${record.path}: assertion ${id} requires evidence`);
    for (const evidenceId of row.evidenceIds)
      if (!reportEvidence.has(evidenceId) || !evidenceIds.has(evidenceId))
        errors.push(
          `${record.path}: assertion ${id} has unresolved evidence id ${evidenceId}`,
        );
    if (metadata.result === "passed" && row.outcome !== "passed")
      errors.push(
        `${record.path}: passed qualification has non-passing assertion ${id}`,
      );
    if (row.outcome !== "passed") allAssertionsPassed = false;
  }
  if (metadata.result !== "passed" && allAssertionsPassed)
    errors.push(
      `${record.path}: non-passing qualification requires a failed or not-run assertion`,
    );
  const stopped = ["halted", "aborted"].includes(metadata.run_status);
  if (
    metadata.run_status === "completed" &&
    metadata.stop_reason !== "not-applicable"
  )
    errors.push(
      `${record.path}: completed qualification must use stop_reason not-applicable`,
    );
  if (
    stopped &&
    (metadata.result === "passed" ||
      metadata.stop_reason === "not-applicable" ||
      metadata.stop_reason === "")
  )
    errors.push(
      `${record.path}: halted or aborted qualification requires non-passing result and stop reason`,
    );
}

function validateRelations(record, recordsById, errors) {
  for (const [field, kinds] of RELATIONS)
    for (const id of relationValues(record, field)) {
      if (field === "invariant_ids" && LEGACY_INVARIANTS.has(id)) continue;
      const target = recordsById.get(id);
      if (!target || !kinds.has(target.metadata.kind))
        errors.push(`${record.path}: ${field} has unresolved id ${id}`);
    }
}

function validateCatalog(recordsById, errors) {
  const catalog = recordsById.get("CMP-CATALOG");
  if (!catalog) {
    errors.push("docs/components/README.md: missing CMP-CATALOG");
    return;
  }
  const expected = [...recordsById.values()]
    .filter((record) => record.metadata.kind === "component")
    .map((record) => record.metadata.id)
    .sort();
  if (
    JSON.stringify(relationValues(catalog, "component_ids").sort()) !==
    JSON.stringify(expected)
  )
    errors.push("CMP-CATALOG component_ids do not match component records");
  const registry = JSON.parse(
    readFileSync(
      join(REPO, "tools/workspace-source-boundaries.v1.json"),
      "utf8",
    ),
  );
  const componentText = markdownFiles(join(DOCS, "components"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  for (const manifest of registry.manifests) {
    const workspace = dirname(manifest);
    if (!componentText.includes(workspace))
      errors.push(
        `component catalog does not mention registered workspace ${workspace}`,
      );
  }
}

function validateLinks(files, errors) {
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const path of files)
    for (const match of readFileSync(path, "utf8").matchAll(pattern)) {
      let target = match[1].trim();
      target =
        target.startsWith("<") && target.endsWith(">")
          ? target.slice(1, -1)
          : target.split(/\s+["']/)[0];
      if (
        !target ||
        target.startsWith("#") ||
        /^[a-z][a-z0-9+.-]*:/i.test(target) ||
        target.startsWith("//")
      )
        continue;
      try {
        if (
          !existsSync(
            resolve(
              dirname(path),
              decodeURIComponent(target.split(/[?#]/, 1)[0]),
            ),
          )
        )
          errors.push(`${relative(REPO, path)}: broken local link ${target}`);
      } catch {
        errors.push(
          `${relative(REPO, path)}: malformed percent-encoded local link ${target}`,
        );
      }
    }
}

function validateSensitiveMaterial(files, errors) {
  const forbidden = [
    ["/Users path", /\/Users\//],
    ["S3 URI", /s3:\/\//i],
    ["AWS ARN", /arn:aws/i],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
    ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]+\b/],
    ["EC2 instance id", /\bi-[0-9a-f]{8,17}\b/],
    ["EBS volume id", /\bvol-[0-9a-f]{8,17}\b/],
    ["private receipt filename", /\bstep9-[a-z0-9-]+\.v1\.json\b/i],
  ];
  for (const path of files)
    for (const [label, pattern] of forbidden)
      if (pattern.test(readFileSync(path, "utf8")))
        errors.push(`${relative(REPO, path)}: contains forbidden ${label}`);
}

function managed(path) {
  const [directory] = relative(DOCS, path).split("/");
  return RECORD_DIRECTORIES.has(directory) && !path.endsWith("/README.md");
}

export function checkDocumentation() {
  const errors = [];
  const files = markdownFiles(DOCS);
  const records = [];
  for (const absolutePath of files) {
    if (absolutePath.startsWith(`${TEMPLATE_ROOT}/`)) continue;
    const source = readFileSync(absolutePath, "utf8");
    const metadata = parseFrontMatter(absolutePath, source, errors);
    if (!metadata) {
      if (managed(absolutePath))
        errors.push(
          `${relative(REPO, absolutePath)}: managed record requires front matter`,
        );
      continue;
    }
    records.push({
      absolutePath,
      path: relative(REPO, absolutePath),
      source,
      metadata,
    });
  }
  const recordsById = new Map();
  for (const record of records) {
    validateShape(record, errors);
    if (typeof record.metadata.id !== "string") continue;
    const prior = recordsById.get(record.metadata.id);
    if (prior)
      errors.push(
        `${record.path}: duplicate id ${record.metadata.id} already used by ${prior.path}`,
      );
    else recordsById.set(record.metadata.id, record);
  }
  const evidence = recordsById.get("EVID-INDEX-001");
  const evidenceIds =
    evidence?.metadata.kind === "evidence-index"
      ? validateEvidence(evidence, errors)
      : new Set();
  if (!evidence)
    errors.push("docs/qualification/evidence-index.md: missing EVID-INDEX-001");
  const matrices = new Map();
  for (const record of records)
    if (record.metadata.kind === "qualification-matrix")
      matrices.set(record.metadata.id, validateMatrix(record, errors));
  for (const record of records) {
    validateRelations(record, recordsById, errors);
    if (record.metadata.kind === "failure-pattern")
      validateFailurePattern(record, evidenceIds, errors);
    if (record.metadata.kind === "qualification")
      validateQualification(record, recordsById, evidenceIds, matrices, errors);
  }
  validateCatalog(recordsById, errors);
  validateLinks(files, errors);
  validateSensitiveMaterial(files, errors);
  return errors;
}

const errors = checkDocumentation();
if (errors.length) {
  for (const error of errors) process.stderr.write(`docs: ${error}\n`);
  process.exitCode = 1;
} else
  process.stdout.write(
    "docs: metadata, relations, links, catalog, and safety checks passed\n",
  );
