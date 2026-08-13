#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";

const REPO = process.cwd();
const DOCS = join(REPO, "docs");
const TEMPLATE_ROOT = join(DOCS, "_templates");
const MANAGED_RECORD_DIRECTORIES = new Set([
  "components",
  "invariants",
  "decisions",
  "failure-patterns",
  "operations",
  "qualification",
  "rfcs",
]);
const MANAGED_KINDS = new Set([
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
const COMMON_FIELDS = new Set([
  "schema_version",
  "id",
  "kind",
  "title",
  "owners",
  "component_ids",
  "created_at",
  "reviewed_at",
  "reviewed_ref",
  "invariant_ids",
  "decision_ids",
  "failure_pattern_ids",
  "runbook_ids",
  "qualification_ids",
  "issue_urls",
]);
const KIND_FIELDS = new Map([
  ["component-index", new Set()],
  ["component", new Set()],
  [
    "invariant",
    new Set(["normative", "enforcement_status", "enforcement_scope"]),
  ],
  ["decision", new Set(["status", "supersedes", "superseded_by", "updates"])],
  ["rfc", new Set(["status", "superseded_by"])],
  [
    "failure-pattern",
    new Set([
      "origin",
      "evidence_status",
      "status",
      "severity",
      "first_observed",
      "evidence_ids",
      "implementation_refs",
      "regression_test_refs",
      "risk_decision_id",
      "residual_risk",
      "next_review_at",
    ]),
  ],
  ["playbook", new Set(["tested_at"])],
  ["runbook", new Set(["tested_at"])],
  ["qualification-matrix", new Set(["matrix_version", "assertion_ids"])],
  [
    "qualification",
    new Set([
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
    ]),
  ],
  ["evidence-index", new Set()],
]);
const REQUIRED_BY_KIND = new Map([
  ["invariant", ["normative", "enforcement_status", "enforcement_scope"]],
  ["decision", ["status", "supersedes", "superseded_by", "updates"]],
  ["rfc", ["status", "superseded_by"]],
  [
    "failure-pattern",
    [
      "origin",
      "evidence_status",
      "status",
      "severity",
      "first_observed",
      "evidence_ids",
      "implementation_refs",
      "regression_test_refs",
    ],
  ],
  ["qualification-matrix", ["matrix_version", "assertion_ids"]],
  [
    "qualification",
    [
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
    ],
  ],
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
const LEGACY_INVARIANT_IDS = new Set([
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
const RELATION_FIELDS = [
  "component_ids",
  "invariant_ids",
  "decision_ids",
  "failure_pattern_ids",
  "runbook_ids",
  "qualification_ids",
];

function markdownFiles(root) {
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) result.push(path);
  }
  return result.sort();
}

function parseScalar(source) {
  const value = source.trim();
  if (value === "[]") return [];
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
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
    if (item !== null) {
      if (arrayKey === null || !Array.isArray(metadata[arrayKey])) {
        errors.push(
          `${relative(REPO, path)}:${index + 1}: list item has no array field`,
        );
      } else {
        metadata[arrayKey].push(parseScalar(item[1]));
      }
      continue;
    }
    const field = /^([a-z][a-z0-9_]*):(?:\s*(.*))?$/.exec(line);
    if (field === null) {
      errors.push(
        `${relative(REPO, path)}:${index + 1}: unsupported front-matter syntax`,
      );
      arrayKey = null;
      continue;
    }
    const [, key, raw = ""] = field;
    if (Object.hasOwn(metadata, key)) {
      errors.push(
        `${relative(REPO, path)}:${index + 1}: duplicate field ${key}`,
      );
    }
    if (raw === "") {
      metadata[key] = [];
      arrayKey = key;
    } else {
      metadata[key] = parseScalar(raw);
      arrayKey = null;
    }
  }
  return metadata;
}

function requireField(record, field, errors) {
  const value = record.metadata[field];
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  ) {
    errors.push(`${record.path}: missing required field ${field}`);
  }
}

function requirePresent(record, field, errors) {
  if (!Object.hasOwn(record.metadata, field))
    errors.push(`${record.path}: missing required field ${field}`);
}

function requireArray(record, field, errors) {
  const value = record.metadata[field];
  if (!Array.isArray(value)) {
    errors.push(`${record.path}: ${field} must be an array`);
    return [];
  }
  if (new Set(value).size !== value.length)
    errors.push(`${record.path}: ${field} contains duplicate values`);
  return value;
}

function requireDate(value, label, record, errors) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)))
    errors.push(`${record.path}: ${label} must use YYYY-MM-DD`);
}

function parseMarkdownTable(source, requiredHeaders) {
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
      let rowIndex = index + 2;
      rowIndex < lines.length && lines[rowIndex].includes("|");
      rowIndex += 1
    ) {
      const cells = tableCells(lines[rowIndex]);
      if (cells.length !== headers.length) break;
      rows.push(
        Object.fromEntries(
          headers.map((header, cellIndex) => [header, cells[cellIndex]]),
        ),
      );
    }
    return rows;
  }
  return null;
}

function tableCells(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim().replace(/^\x60|\x60$/g, ""));
}

function gitObjectExists(spec) {
  return (
    spawnSync("git", ["cat-file", "-e", spec], { cwd: REPO, stdio: "ignore" })
      .status === 0
  );
}

function validateRecordShape(record, errors) {
  const metadata = record.metadata;
  if (metadata.schema_version !== 1)
    errors.push(`${record.path}: schema_version must equal 1`);
  for (const field of [
    "id",
    "kind",
    "title",
    "owners",
    "component_ids",
    "created_at",
    "reviewed_at",
    "reviewed_ref",
  ]) {
    requireField(record, field, errors);
  }
  requireArray(record, "owners", errors);
  requireArray(record, "component_ids", errors);
  if (!MANAGED_KINDS.has(metadata.kind)) {
    errors.push(`${record.path}: unsupported kind ${String(metadata.kind)}`);
    return;
  }
  const idPattern = ID_PATTERNS.get(metadata.kind);
  if (typeof metadata.id !== "string" || !idPattern.test(metadata.id)) {
    errors.push(
      `${record.path}: id ${String(metadata.id)} does not match kind ${metadata.kind}`,
    );
  }
  if (
    typeof metadata.id === "string" &&
    /(?:DOMAIN|YYYY|000)$/.test(metadata.id)
  ) {
    errors.push(`${record.path}: template placeholder id is not allowed`);
  }
  requireDate(metadata.created_at, "created_at", record, errors);
  requireDate(metadata.reviewed_at, "reviewed_at", record, errors);
  if (!/^[0-9a-f]{40}$/.test(String(metadata.reviewed_ref))) {
    errors.push(
      `${record.path}: reviewed_ref must be a full lowercase commit SHA`,
    );
  } else if (!gitObjectExists(`${metadata.reviewed_ref}^{commit}`)) {
    errors.push(`${record.path}: reviewed_ref does not name a local commit`);
  }
  const allowed = new Set([
    ...COMMON_FIELDS,
    ...(KIND_FIELDS.get(metadata.kind) ?? []),
  ]);
  for (const field of Object.keys(metadata)) {
    if (!allowed.has(field))
      errors.push(`${record.path}: unknown field ${field}`);
  }
  for (const field of REQUIRED_BY_KIND.get(metadata.kind) ?? [])
    requirePresent(record, field, errors);
  for (const field of RELATION_FIELDS)
    if (metadata[field] !== undefined) requireArray(record, field, errors);
  if (metadata.issue_urls !== undefined) {
    for (const issue of requireArray(record, "issue_urls", errors)) {
      if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(issue))
        errors.push(`${record.path}: invalid GitHub issue URL ${issue}`);
    }
  }
}

function parseEvidenceIndex(record, errors) {
  const rows = parseMarkdownTable(record.source, ["Evidence ID", "SHA-256"]);
  if (rows === null) {
    errors.push(
      `${record.path}: evidence index requires an Evidence ID and SHA-256 table`,
    );
    return new Set();
  }
  const ids = new Set();
  for (const row of rows) {
    const id = row["evidence id"];
    const digest = row["sha-256"];
    if (!/^EVID-[A-Z0-9-]+$/.test(id))
      errors.push(`${record.path}: invalid evidence id ${id}`);
    if (ids.has(id)) errors.push(`${record.path}: duplicate evidence id ${id}`);
    ids.add(id);
    if (!/^[0-9a-f]{64}$/.test(digest))
      errors.push(`${record.path}: evidence ${id} must have a 64-hex SHA-256`);
  }
  return ids;
}

function parseMatrixAssertions(record, errors) {
  const rows =
    parseMarkdownTable(record.source, ["Assertion ID", "Assertion"]) ??
    parseMarkdownTable(record.source, ["Case", "Boundary to exercise"]);
  if (rows === null || rows.length === 0) {
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
  return ids;
}

function parseQualificationResults(record, errors) {
  const rows = parseMarkdownTable(record.source, [
    "Assertion",
    "Outcome",
    "Evidence",
  ]);
  if (rows === null || rows.length === 0) {
    errors.push(
      `${record.path}: qualification requires a nonempty Assertion/Outcome/Evidence result table`,
    );
    return new Map();
  }
  const results = new Map();
  for (const row of rows) {
    const id = row.assertion;
    const outcome = row.outcome;
    const evidenceIds = row.evidence
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (results.has(id))
      errors.push(
        `${record.path}: duplicate qualification assertion result ${id}`,
      );
    results.set(id, { outcome, evidenceIds });
  }
  return results;
}

function validateSupersession(record, recordsById, errors) {
  const metadata = record.metadata;
  if (!["decision", "rfc"].includes(metadata.kind)) return;
  const fields =
    metadata.kind === "decision"
      ? ["supersedes", "superseded_by", "updates"]
      : ["superseded_by"];
  for (const field of fields) {
    const ids = requireArray(record, field, errors);
    for (const id of ids) {
      const target = recordsById.get(id);
      if (
        id === metadata.id ||
        target === undefined ||
        target.metadata.kind !== metadata.kind
      ) {
        errors.push(
          `${record.path}: ${field} has unresolved ${metadata.kind} id ${id}`,
        );
      }
    }
  }
  if (
    metadata.status === "superseded" &&
    (metadata.superseded_by ?? []).length === 0
  ) {
    errors.push(
      `${record.path}: superseded ${metadata.kind} requires superseded_by`,
    );
  }
}

function validateKindSpecific(
  record,
  recordsById,
  evidenceIds,
  matrixAssertions,
  errors,
) {
  const metadata = record.metadata;
  if (metadata.kind === "invariant") {
    if (!["MUST", "MUST NOT"].includes(metadata.normative))
      errors.push(`${record.path}: invalid normative value`);
    if (
      !["not-implemented", "partial", "implemented", "retired"].includes(
        metadata.enforcement_status,
      )
    )
      errors.push(`${record.path}: invalid enforcement_status`);
    if (
      ["partial", "implemented"].includes(metadata.enforcement_status) &&
      metadata.enforcement_scope === "none"
    )
      errors.push(
        `${record.path}: enforced invariant cannot have enforcement_scope none`,
      );
  }
  if (metadata.kind === "failure-pattern") {
    if (!["live", "test", "review"].includes(metadata.origin))
      errors.push(`${record.path}: invalid failure origin`);
    if (
      ![
        "hypothesized",
        "scenario-defined",
        "reproduced",
        "observed-live",
      ].includes(metadata.evidence_status)
    )
      errors.push(`${record.path}: invalid evidence_status`);
    if (
      ![
        "observed",
        "mitigating",
        "mitigated",
        "accepted-risk",
        "retired",
      ].includes(metadata.status)
    )
      errors.push(`${record.path}: invalid failure status`);
    if (
      !["unassessed", "low", "medium", "high", "critical"].includes(
        metadata.severity,
      )
    )
      errors.push(`${record.path}: invalid severity`);
    requireDate(metadata.first_observed, "first_observed", record, errors);
    const evidence = requireArray(record, "evidence_ids", errors);
    const implementations = requireArray(record, "implementation_refs", errors);
    const regressions = requireArray(record, "regression_test_refs", errors);
    for (const id of evidence)
      if (!evidenceIds.has(id))
        errors.push(`${record.path}: unknown evidence id ${id}`);
    for (const ref of implementations) {
      const match = /^commit:([0-9a-f]{40})$/.exec(ref);
      if (match === null)
        errors.push(
          `${record.path}: implementation ref must use commit:<full-sha>: ${ref}`,
        );
      else if (!gitObjectExists(`${match[1]}^{commit}`))
        errors.push(
          `${record.path}: implementation ref does not name a local commit ${ref}`,
        );
    }
    for (const ref of regressions) {
      const match = /^([^@]+)@([0-9a-f]{40})$/.exec(ref);
      if (
        match === null ||
        match[1].startsWith("/") ||
        match[1].split("/").includes("..")
      ) {
        errors.push(
          `${record.path}: regression ref must use repository-path@full-sha: ${ref}`,
        );
      } else if (!gitObjectExists(`${match[2]}:${match[1]}`)) {
        errors.push(
          `${record.path}: regression test path does not exist at claimed commit: ${ref}`,
        );
      }
    }
    if (
      metadata.status === "mitigated" &&
      regressions.length === 0 &&
      (metadata.qualification_ids ?? []).length === 0
    ) {
      errors.push(
        `${record.path}: mitigated pattern requires regression proof`,
      );
    }
    if (metadata.status === "accepted-risk") {
      for (const field of [
        "risk_decision_id",
        "residual_risk",
        "next_review_at",
      ])
        requireField(record, field, errors);
      requireDate(metadata.next_review_at, "next_review_at", record, errors);
      const decision = recordsById.get(metadata.risk_decision_id);
      if (
        decision?.metadata.kind !== "decision" ||
        decision.metadata.status !== "accepted"
      ) {
        errors.push(
          `${record.path}: accepted-risk requires an accepted risk_decision_id`,
        );
      }
    }
  }
  if (
    metadata.kind === "decision" &&
    !["proposed", "accepted", "rejected", "superseded"].includes(
      metadata.status,
    )
  )
    errors.push(`${record.path}: invalid ADR status`);
  if (
    metadata.kind === "rfc" &&
    !["draft", "proposed", "accepted", "declined", "superseded"].includes(
      metadata.status,
    )
  )
    errors.push(`${record.path}: invalid RFC status`);
  if (metadata.kind === "qualification-matrix") {
    if (
      !Number.isInteger(metadata.matrix_version) ||
      metadata.matrix_version < 1
    )
      errors.push(`${record.path}: matrix_version must be a positive integer`);
  }
  if (metadata.kind === "qualification") {
    if (!["completed", "halted", "aborted"].includes(metadata.run_status))
      errors.push(`${record.path}: invalid run_status`);
    if (!["passed", "failed", "inconclusive"].includes(metadata.result))
      errors.push(`${record.path}: invalid qualification result`);
    if (!/^(?:[0-9a-f]{40}|not-applicable)$/.test(metadata.source_commit))
      errors.push(
        `${record.path}: source_commit must be exact or not-applicable`,
      );
    else if (
      metadata.source_commit !== "not-applicable" &&
      !gitObjectExists(`${metadata.source_commit}^{commit}`)
    )
      errors.push(`${record.path}: source_commit does not name a local commit`);
    if (
      !/^(?:sha256:[0-9a-f]{64}|not-applicable)$/.test(metadata.artifact_digest)
    )
      errors.push(
        `${record.path}: artifact_digest must be exact or not-applicable`,
      );
    for (const field of ["configuration_identity", "state_identity"]) {
      if (
        !/^(?:opaque:[A-Z0-9][A-Z0-9-]*|sha256:[0-9a-f]{64}|not-applicable)$/.test(
          String(metadata[field]),
        )
      )
        errors.push(
          `${record.path}: ${field} must be opaque, a SHA-256, or not-applicable`,
        );
    }
    if (
      metadata.started_at !== "not-recorded" &&
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(
        metadata.started_at,
      )
    )
      errors.push(
        `${record.path}: started_at must be RFC 3339 or not-recorded`,
      );
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
    const assertions = requireArray(record, "assertion_ids", errors);
    const resultRows = parseQualificationResults(record, errors);
    const expectedAssertions =
      matrixAssertions.get(metadata.matrix_id) ?? new Set();
    if (
      new Set(assertions).size !== assertions.length ||
      !sameSet(new Set(assertions), expectedAssertions) ||
      !sameSet(new Set(resultRows.keys()), expectedAssertions)
    ) {
      errors.push(
        `${record.path}: qualification assertions must exactly match its matrix`,
      );
    }
    const reportEvidence = new Set(
      requireArray(record, "evidence_ids", errors),
    );
    for (const id of reportEvidence)
      if (!evidenceIds.has(id))
        errors.push(`${record.path}: unknown evidence id ${id}`);
    for (const [id, row] of resultRows) {
      if (!["passed", "failed", "not-run"].includes(row.outcome))
        errors.push(
          `${record.path}: assertion ${id} has invalid outcome ${row.outcome}`,
        );
      if (row.evidenceIds.length === 0)
        errors.push(`${record.path}: assertion ${id} requires evidence`);
      for (const evidenceId of row.evidenceIds) {
        if (!reportEvidence.has(evidenceId) || !evidenceIds.has(evidenceId))
          errors.push(
            `${record.path}: assertion ${id} has unresolved evidence id ${evidenceId}`,
          );
      }
      if (metadata.result === "passed" && row.outcome !== "passed")
        errors.push(
          `${record.path}: passed qualification has non-passing assertion ${id}`,
        );
    }
    const stopped =
      metadata.run_status === "halted" || metadata.run_status === "aborted";
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
}

function sameSet(left, right) {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function validateRelations(record, recordsById, errors) {
  const relationKinds = new Map([
    ["component_ids", new Set(["component"])],
    ["decision_ids", new Set(["decision"])],
    ["failure_pattern_ids", new Set(["failure-pattern"])],
    ["runbook_ids", new Set(["runbook"])],
    ["qualification_ids", new Set(["qualification", "qualification-matrix"])],
  ]);
  for (const [field, kinds] of relationKinds) {
    for (const id of record.metadata[field] ?? []) {
      const target = recordsById.get(id);
      if (target === undefined || !kinds.has(target.metadata.kind))
        errors.push(`${record.path}: ${field} has unresolved id ${id}`);
    }
  }
  for (const id of record.metadata.invariant_ids ?? []) {
    const target = recordsById.get(id);
    if (
      !LEGACY_INVARIANT_IDS.has(id) &&
      (target === undefined || target.metadata.kind !== "invariant")
    )
      errors.push(`${record.path}: invariant_ids has unresolved id ${id}`);
  }
  validateSupersession(record, recordsById, errors);
}

function validateCatalog(recordsById, errors) {
  const catalog = recordsById.get("CMP-CATALOG");
  if (catalog === undefined) {
    errors.push("docs/components/README.md: missing CMP-CATALOG");
    return;
  }
  const expected = [...recordsById.values()]
    .filter((record) => record.metadata.kind === "component")
    .map((record) => record.metadata.id)
    .sort();
  const actual = [...catalog.metadata.component_ids].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    errors.push("CMP-CATALOG component_ids do not match component records");
  const registryPath = join(REPO, "tools/workspace-source-boundaries.v1.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
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

function validateMarkdownLinks(files, errors) {
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(pattern)) {
      let target = match[1].trim();
      if (target.startsWith("<") && target.endsWith(">"))
        target = target.slice(1, -1);
      else target = target.split(/\s+["']/)[0];
      if (
        target === "" ||
        target.startsWith("#") ||
        /^[a-z][a-z0-9+.-]*:/i.test(target) ||
        target.startsWith("//")
      )
        continue;
      const withoutAnchorOrQuery = target.split(/[?#]/, 1)[0];
      let decoded;
      try {
        decoded = decodeURIComponent(withoutAnchorOrQuery);
      } catch {
        errors.push(
          `${relative(REPO, path)}: malformed percent-encoded local link ${target}`,
        );
        continue;
      }
      const resolved = resolve(dirname(path), decoded);
      if (!existsSync(resolved))
        errors.push(`${relative(REPO, path)}: broken local link ${target}`);
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
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    for (const [label, pattern] of forbidden)
      if (pattern.test(source))
        errors.push(`${relative(REPO, path)}: contains forbidden ${label}`);
  }
}

function isManagedRecordFile(path) {
  const [directory] = relative(DOCS, path).split("/");
  return (
    MANAGED_RECORD_DIRECTORIES.has(directory) && !path.endsWith("/README.md")
  );
}

export function checkDocumentation() {
  const errors = [];
  const files = markdownFiles(DOCS);
  const records = [];
  for (const absolutePath of files) {
    if (absolutePath.startsWith(`${TEMPLATE_ROOT}/`)) continue;
    const source = readFileSync(absolutePath, "utf8");
    const metadata = parseFrontMatter(absolutePath, source, errors);
    if (metadata === null) {
      if (isManagedRecordFile(absolutePath))
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
    validateRecordShape(record, errors);
    if (typeof record.metadata.id === "string") {
      const prior = recordsById.get(record.metadata.id);
      if (prior !== undefined)
        errors.push(
          `${record.path}: duplicate id ${record.metadata.id} already used by ${prior.path}`,
        );
      else recordsById.set(record.metadata.id, record);
    }
  }
  const evidenceIndex = recordsById.get("EVID-INDEX-001");
  const evidenceIds =
    evidenceIndex?.metadata.kind === "evidence-index"
      ? parseEvidenceIndex(evidenceIndex, errors)
      : new Set();
  if (evidenceIndex === undefined)
    errors.push("docs/qualification/evidence-index.md: missing EVID-INDEX-001");
  const matrixAssertions = new Map();
  for (const record of records) {
    if (record.metadata.kind !== "qualification-matrix") continue;
    const assertions = parseMatrixAssertions(record, errors);
    const declared = requireArray(record, "assertion_ids", errors);
    if (!sameSet(new Set(declared), assertions))
      errors.push(
        `${record.path}: matrix assertion_ids must exactly match its Assertion ID table`,
      );
    matrixAssertions.set(record.metadata.id, assertions);
  }
  for (const record of records) {
    validateRelations(record, recordsById, errors);
    validateKindSpecific(
      record,
      recordsById,
      evidenceIds,
      matrixAssertions,
      errors,
    );
  }
  validateCatalog(recordsById, errors);
  validateMarkdownLinks(files, errors);
  validateSensitiveMaterial(files, errors);
  return errors;
}

const errors = checkDocumentation();
if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`docs: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "docs: metadata, relations, links, catalog, and safety checks passed\n",
  );
}
