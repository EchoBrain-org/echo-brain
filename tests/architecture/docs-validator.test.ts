import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const TOOL = join(REPO, "tools", "check-docs.mjs");
const PLACEHOLDER = "__SHA__";
const roots: string[] = [];

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function write(path: string, contents: string) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

function common(id: string, kind: string, componentIds = "  - CMP-TEST") {
  return [
    "---",
    "schema_version: 1",
    `id: ${id}`,
    `kind: ${kind}`,
    `title: Test ${kind}`,
    "owners:",
    "  - test",
    "component_ids:",
    componentIds,
    "created_at: 2026-08-13",
    "reviewed_at: 2026-08-13",
    `reviewed_ref: ${PLACEHOLDER}`,
    "invariant_ids: []",
    "decision_ids: []",
    "failure_pattern_ids: []",
    "runbook_ids: []",
    "qualification_ids: []",
    "issue_urls: []",
  ].join("\n");
}

function qualification(root: string) {
  write(
    join(root, "docs/qualification/QUAL-20260813-120000-001.md"),
    [
      common("QUAL-20260813-120000-001", "qualification"),
      "run_status: completed",
      "result: passed",
      "stop_reason: not-applicable",
      `source_commit: ${PLACEHOLDER}`,
      "artifact_digest: not-applicable",
      "configuration_identity: opaque:CONFIG-TEST-001",
      "state_identity: opaque:STATE-TEST-001",
      "started_at: 2026-08-13T12:00:00Z",
      "completed_at: 2026-08-13T12:01:00Z",
      "matrix_id: QMAT-TEST-001",
      "matrix_version: 1",
      "assertion_ids:",
      "  - TEST-A-001",
      "  - TEST-A-002",
      "evidence_ids:",
      "  - EVID-TEST-001",
      "---",
      "# Test qualification",
      "",
      "| Assertion | Outcome | Evidence |",
      "| --- | --- | --- |",
      "| TEST-A-001 | passed | EVID-TEST-001 |",
      "| TEST-A-002 | passed | EVID-TEST-001 |",
      "",
    ].join("\n"),
  );
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "echo-docs-validator-"));
  roots.push(root);
  write(
    join(root, "tools/workspace-source-boundaries.v1.json"),
    '{"manifests":[]}\n',
  );
  write(join(root, "tests/regression.test.ts"), "export {};\n");
  write(
    join(root, "docs/components/README.md"),
    common("CMP-CATALOG", "component-index", "  - CMP-TEST") +
      "\n---\n# Components\n",
  );
  write(
    join(root, "docs/components/test.md"),
    common("CMP-TEST", "component") + "\n---\n# Test component\n",
  );
  write(
    join(root, "docs/qualification/evidence-index.md"),
    [
      common("EVID-INDEX-001", "evidence-index"),
      "---",
      "# Evidence",
      "",
      "| Evidence ID | SHA-256 | Bounded purpose | Access class |",
      "| --- | --- | --- | --- |",
      `| EVID-TEST-001 | ${"d".repeat(64)} | test fixture | test |`,
      "",
    ].join("\n"),
  );
  write(
    join(root, "docs/qualification/matrix.md"),
    [
      common("QMAT-TEST-001", "qualification-matrix"),
      "matrix_version: 1",
      "assertion_ids:",
      "  - TEST-A-001",
      "  - TEST-A-002",
      "---",
      "# Matrix",
      "",
      "| Assertion ID | Assertion |",
      "| --- | --- |",
      "| TEST-A-001 | first assertion |",
      "| TEST-A-002 | second assertion |",
      "",
    ].join("\n"),
  );
  qualification(root);
  run("git", ["init", "--quiet"], root);
  run("git", ["config", "user.email", "docs@example.test"], root);
  run("git", ["config", "user.name", "Docs Validator"], root);
  run("git", ["add", "."], root);
  run("git", ["commit", "--quiet", "-m", "fixture"], root);
  const sha = run("git", ["rev-parse", "HEAD"], root);
  for (const path of [
    "docs/components/README.md",
    "docs/components/test.md",
    "docs/qualification/evidence-index.md",
    "docs/qualification/matrix.md",
    "docs/qualification/QUAL-20260813-120000-001.md",
  ]) {
    const absolute = join(root, path);
    writeFileSync(
      absolute,
      readFileSync(absolute, "utf8").replaceAll(PLACEHOLDER, sha),
    );
  }
  return { root, sha };
}

function validate(root: string) {
  const result = spawnSync(process.execPath, [TOOL], {
    cwd: root,
    encoding: "utf8",
  });
  return result.stdout + "\n" + result.stderr;
}

function failurePattern(root: string, sha: string, extra: string) {
  write(
    join(root, "docs/failure-patterns/FP-TEST-001.md"),
    [
      common("FP-TEST-001", "failure-pattern").replaceAll(PLACEHOLDER, sha),
      "origin: test",
      "evidence_status: reproduced",
      "status: mitigating",
      "severity: high",
      "first_observed: 2026-08-13",
      "evidence_ids:",
      "  - EVID-TEST-001",
      "implementation_refs: []",
      "regression_test_refs: []",
      "risk_decision_id: null",
      "residual_risk: null",
      "next_review_at: null",
      extra.replaceAll(PLACEHOLDER, sha),
      "---",
      "# Failure pattern",
      "",
    ].join("\n"),
  );
}

afterEach(() => {
  while (roots.length > 0)
    rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("documentation validator", () => {
  it("accepts the proof-grade baseline fixture", () => {
    expect(validate(fixture().root)).toContain("checks passed");
  });

  it("rejects a qualification whose assertions do not exactly match its matrix", () => {
    const { root } = fixture();
    const path = join(root, "docs/qualification/QUAL-20260813-120000-001.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8")
        .replace("  - TEST-A-002\n", "")
        .replace("| TEST-A-002 | passed | EVID-TEST-001 |\n", ""),
    );
    expect(validate(root)).toContain(
      "qualification assertions must exactly match its matrix",
    );
  });

  it("rejects a passing qualification with a failed assertion", () => {
    const { root } = fixture();
    const path = join(root, "docs/qualification/QUAL-20260813-120000-001.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "| TEST-A-002 | passed | EVID-TEST-001 |",
        "| TEST-A-002 | failed | EVID-TEST-001 |",
      ),
    );
    const output = validate(root);
    expect(output).toContain(
      "passed qualification has non-passing assertion TEST-A-002",
    );
  });

  it("rejects incoherent halted qualification outcomes", () => {
    const { root } = fixture();
    const path = join(root, "docs/qualification/QUAL-20260813-120000-001.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "run_status: completed",
        "run_status: halted",
      ),
    );
    expect(validate(root)).toContain(
      "halted or aborted qualification requires non-passing result and stop reason",
    );
  });

  it("rejects prose-only, duplicate, and malformed evidence rows", () => {
    const { root, sha } = fixture();
    const path = join(root, "docs/qualification/evidence-index.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        `| EVID-TEST-001 | ${"d".repeat(64)} | test fixture | test |`,
        `| EVID-TEST-001 | ${"d".repeat(64)} | test fixture | test |\n| EVID-TEST-001 | short | duplicate | test |`,
      ) + "EVID-GHOST-001 is only prose.\n",
    );
    failurePattern(root, sha, "");
    const pattern = join(root, "docs/failure-patterns/FP-TEST-001.md");
    writeFileSync(
      pattern,
      readFileSync(pattern, "utf8").replace(
        "evidence_ids:\n  - EVID-TEST-001",
        "evidence_ids:\n  - EVID-GHOST-001",
      ),
    );
    const output = validate(root);
    expect(output).toContain("duplicate evidence id EVID-TEST-001");
    expect(output).toContain("must have a 64-hex SHA-256");
    expect(output).toContain("unknown evidence id EVID-GHOST-001");
  });

  it("rejects a managed record without front matter", () => {
    const { root } = fixture();
    write(
      join(root, "docs/failure-patterns/FP-TEST-001.md"),
      "# Untyped failure pattern\n",
    );
    expect(validate(root)).toContain("managed record requires front matter");
  });

  it("rejects non-full and non-historical revision references", () => {
    const { root, sha } = fixture();
    failurePattern(root, sha, "");
    const pattern = join(root, "docs/failure-patterns/FP-TEST-001.md");
    writeFileSync(
      pattern,
      readFileSync(pattern, "utf8").replace(
        "implementation_refs: []\nregression_test_refs: []",
        `implementation_refs:\n  - commit:deadbeef\nregression_test_refs:\n  - tests/regression.test.ts@${"b".repeat(40)}`,
      ),
    );
    const output = validate(root);
    expect(output).toContain("implementation ref must use commit:<full-sha>");
    expect(output).toContain(
      "regression test path does not exist at claimed commit",
    );
  });

  it("rejects sensitive material and malformed encoded local links", () => {
    const { root } = fixture();
    const path = join(root, "docs/qualification/QUAL-20260813-120000-001.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8") +
        "\nSynthetic /Users/example/private and xoxb-not-a-real-token. [bad](%ZZ)\n",
    );
    const output = validate(root);
    expect(output).toContain("contains forbidden /Users path");
    expect(output).toContain("contains forbidden Slack token");
    expect(output).toContain("malformed percent-encoded local link %ZZ");
  });
});
