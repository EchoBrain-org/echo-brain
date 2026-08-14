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
    ...(kind === "component" || kind === "component-index"
      ? ["owners:", "  - test"]
      : []),
    "component_ids:",
    componentIds,
    "created_at: 2026-08-13",
    "reviewed_at: 2026-08-13",
    `reviewed_ref: ${PLACEHOLDER}`,
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
    `${common("CMP-CATALOG", "component-index")}\n---\n# Components\n`,
  );
  write(
    join(root, "docs/components/test.md"),
    `${common("CMP-TEST", "component")}\n---\n# Test component\n`,
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
  ])
    writeFileSync(
      join(root, path),
      readFileSync(join(root, path), "utf8").replaceAll(PLACEHOLDER, sha),
    );
  return { root, sha };
}
function validate(root: string) {
  const result = spawnSync(process.execPath, [TOOL], {
    cwd: root,
    encoding: "utf8",
  });
  return result.stdout + "\n" + result.stderr;
}
function failurePattern(root: string, sha: string, extra = "") {
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
      extra.replaceAll(PLACEHOLDER, sha),
      "---",
      "# Failure pattern",
      "",
    ].join("\n"),
  );
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("documentation validator", () => {
  it("accepts the lean proof-grade baseline", () =>
    expect(validate(fixture().root)).toContain("checks passed"));
  it.each([
    [
      "qualification assertion set",
      (root: string) =>
        edit(root, "docs/qualification/QUAL-20260813-120000-001.md", (source) =>
          source
            .replace("  - TEST-A-002\n", "")
            .replace("| TEST-A-002 | passed | EVID-TEST-001 |\n", ""),
        ),
      "qualification assertions must exactly match its matrix",
    ],
    [
      "matrix version",
      (root: string) =>
        edit(root, "docs/qualification/QUAL-20260813-120000-001.md", (source) =>
          source.replace("matrix_version: 1", "matrix_version: 2"),
        ),
      "matrix_version does not match QMAT-TEST-001",
    ],
    [
      "matrix declaration/table set",
      (root: string) =>
        edit(root, "docs/qualification/matrix.md", (source) =>
          source.replace("  - TEST-A-002\n", ""),
        ),
      "matrix assertion_ids must exactly match its Assertion ID table",
    ],
    [
      "passed result with failed assertion",
      (root: string) =>
        edit(root, "docs/qualification/QUAL-20260813-120000-001.md", (source) =>
          source.replace(
            "| TEST-A-002 | passed | EVID-TEST-001 |",
            "| TEST-A-002 | failed | EVID-TEST-001 |",
          ),
        ),
      "passed qualification has non-passing assertion TEST-A-002",
    ],
    [
      "halted success",
      (root: string) =>
        edit(root, "docs/qualification/QUAL-20260813-120000-001.md", (source) =>
          source.replace("run_status: completed", "run_status: halted"),
        ),
      "halted or aborted qualification requires non-passing result and stop reason",
    ],
    [
      "failed result with every assertion passed",
      (root: string) =>
        edit(root, "docs/qualification/QUAL-20260813-120000-001.md", (source) =>
          source.replace("result: passed", "result: failed"),
        ),
      "non-passing qualification requires a failed or not-run assertion",
    ],
  ])("rejects %s", (_label, change, expected) => {
    const { root } = fixture();
    change(root);
    expect(validate(root)).toContain(expected);
  });
  it("rejects malformed, duplicate, and unresolved evidence", () => {
    const { root, sha } = fixture();
    edit(root, "docs/qualification/evidence-index.md", (source) =>
      source.replace(
        `| EVID-TEST-001 | ${"d".repeat(64)} | test fixture | test |`,
        `| EVID-TEST-001 | ${"d".repeat(64)} | test fixture | test |\n| EVID-TEST-001 | short | duplicate | test |`,
      ),
    );
    failurePattern(root, sha, "");
    edit(root, "docs/failure-patterns/FP-TEST-001.md", (source) =>
      source.replace("  - EVID-TEST-001", "  - EVID-GHOST-001"),
    );
    const output = validate(root);
    expect(output).toContain("duplicate evidence id EVID-TEST-001");
    expect(output).toContain("must have a 64-hex SHA-256");
    expect(output).toContain("unknown evidence id EVID-GHOST-001");
  });
  it("rejects malformed managed records, historic references, and sensitive content", () => {
    const { root, sha } = fixture();
    write(join(root, "docs/failure-patterns/FP-TEST-002.md"), "# Untyped\n");
    failurePattern(
      root,
      sha,
      `implementation_refs:\n  - commit:deadbeef\nregression_test_refs:\n  - tests/regression.test.ts@${"b".repeat(40)}`,
    );
    edit(
      root,
      "docs/qualification/QUAL-20260813-120000-001.md",
      (source) =>
        `${source}\nSynthetic /Users/example/private and xoxb-not-a-real-token. [bad](%ZZ)\n`,
    );
    const output = validate(root);
    expect(output).toContain("managed record requires front matter");
    expect(output).toContain("implementation ref must use commit:<full-sha>");
    expect(output).toContain(
      "regression test path does not exist at claimed commit",
    );
    expect(output).toContain("contains forbidden /Users path");
    expect(output).toContain("contains forbidden Slack token");
    expect(output).toContain("malformed percent-encoded local link %ZZ");
  });
  it.each([
    ["component_ids: null", "component_ids must be an array"],
    ["invariant_ids: 1", "invariant_ids must be an array"],
  ])("rejects malformed relation %s without crashing", (field, expected) => {
    const { root } = fixture();
    edit(root, "docs/components/test.md", (source) =>
      field.startsWith("component_ids")
        ? source.replace("component_ids:\n  - CMP-TEST", field)
        : source.replace("reviewed_at: 2026-08-13", `invariant_ids: 1\nreviewed_at: 2026-08-13`),
    );
    expect(validate(root)).toContain(expected);
  });
});
function edit(root: string, file: string, mutate: (source: string) => string) {
  const path = join(root, file);
  writeFileSync(path, mutate(readFileSync(path, "utf8")));
}
