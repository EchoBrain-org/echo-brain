import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { spawnSanitizedChild } from "../../src/product/spawn-sanitized-child.js";
// @ts-expect-error Phase 5 orchestration tools are repository-owned JavaScript.
import * as phase5Report from "../../tools/phase5/report.mjs";
// @ts-expect-error Phase 5 orchestration tools are repository-owned JavaScript.
import { validateOneMachineRehearsalReport } from "../../tools/phase5/validate-report.mjs";

const {
  ALL_CHECK_IDS,
  BLOCKED_CHECK_IDS,
  BLOCKED_CHECK_REASON_BY_ID,
  PASSING_CHECK_IDS,
  createOneMachineRehearsalReport,
} = phase5Report;

const SOURCE_SHA = "1".repeat(40);
const STARTED_AT = "2026-07-22T10:00:00.000Z";
const COMPLETED_AT = "2026-07-22T10:05:00.000Z";
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const VALIDATOR = join(REPO_ROOT, "tools/phase5/validate-report.mjs");
const TEMPORARY_ROOT = mkdtempSync(join(tmpdir(), "echo-phase5-report-"));

interface RehearsalCheck {
  id: string;
  status: "pass" | "blocked";
  observed_at: string;
  evidence_sha256?: string;
  reason_code?: string;
}

interface RehearsalReport {
  result: string;
  phase5_gate: string;
  unexpected_skip_count: number;
  checks: RehearsalCheck[];
  artifacts: {
    authority: { source_sha: string };
  };
  topology: {
    installations: Array<{
      label: string;
      installation_id: string;
    }>;
  };
}

function id(prefix: string, suffix: number): string {
  return `${prefix}_00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

function passingEvidence(): Record<
  string,
  { observed_at: string; evidence_sha256: string }
> {
  return Object.fromEntries(
    PASSING_CHECK_IDS.map((checkId: string, index: number) => [
      checkId,
      {
        observed_at: "2026-07-22T10:03:00.000Z",
        evidence_sha256: (index % 16).toString(16).repeat(64),
      },
    ]),
  );
}

function validReport(): RehearsalReport {
  return createOneMachineRehearsalReport({
    source_sha: SOURCE_SHA,
    run_id: id("p5r", 1),
    started_at: STARTED_AT,
    completed_at: COMPLETED_AT,
    host: { os: "darwin", architecture: "x64", node: "22.22.1" },
    artifacts: {
      employee: {
        version: "0.1.0-dev.phase5",
        source_sha: SOURCE_SHA,
        artifact_sha256: "a".repeat(64),
        manifest_sha256: "b".repeat(64),
      },
      authority: {
        version: "0.1.0-dev.phase5",
        source_sha: SOURCE_SHA,
        artifact_sha256: "c".repeat(64),
        manifest_sha256: "d".repeat(64),
      },
      ceremony_driver: {
        source_sha: SOURCE_SHA,
        sha256: "e".repeat(64),
      },
    },
    topology: {
      mode: "one-machine-isolated",
      authority_id: id("oau", 1),
      organization_id: id("org", 1),
      installations: [
        {
          label: "A",
          principal_id: id("prn", 1),
          membership_id: id("mem", 1),
          installation_id: id("ins", 1),
          installation_key_id: `sha256:${"1".repeat(64)}`,
        },
        {
          label: "B",
          principal_id: id("prn", 2),
          membership_id: id("mem", 2),
          installation_id: id("ins", 2),
          installation_key_id: `sha256:${"2".repeat(64)}`,
        },
      ],
    },
    passing_evidence: passingEvidence(),
  }) as RehearsalReport;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

afterAll(() => {
  rmSync(TEMPORARY_ROOT, { recursive: true, force: true });
});

describe("Phase 5 one-machine rehearsal report", () => {
  it("accepts the exact passing and blocked vector without claiming Phase 5 completion", () => {
    const report = validReport();

    expect(validateOneMachineRehearsalReport(report)).toEqual({
      ok: true,
      errors: [],
    });
    expect(report).toMatchObject({
      result: "rehearsal_passed",
      phase5_gate: "incomplete",
      unexpected_skip_count: 0,
    });
    expect(report.checks.map((check) => check.id)).toEqual(ALL_CHECK_IDS);
    expect(
      report.checks
        .filter((check) => check.status === "blocked")
        .map((check) => check.id),
    ).toEqual(BLOCKED_CHECK_IDS);
    for (const check of report.checks.filter(
      (candidate) => candidate.status === "blocked",
    )) {
      expect(check.reason_code).toBe(BLOCKED_CHECK_REASON_BY_ID[check.id]);
    }
  });

  it("rejects missing, duplicate, and unexpected check identifiers", () => {
    const missing = validReport();
    missing.checks = missing.checks.slice(1);
    expect(validateOneMachineRehearsalReport(missing).errors).toContain(
      "missing Phase 5 check: P5-ART-001",
    );

    const duplicate = validReport();
    duplicate.checks[1] = clone(duplicate.checks[0]!);
    const duplicateResult = validateOneMachineRehearsalReport(duplicate);
    expect(duplicateResult.errors).toEqual(
      expect.arrayContaining([
        "duplicate Phase 5 check: P5-ART-001",
        "missing Phase 5 check: P5-ART-002",
      ]),
    );

    const unexpected = validReport();
    unexpected.checks[0] = {
      ...unexpected.checks[0]!,
      id: "P5-NEW-999",
    };
    expect(validateOneMachineRehearsalReport(unexpected).errors).toEqual(
      expect.arrayContaining([
        "unexpected Phase 5 check identifier",
        "missing Phase 5 check: P5-ART-001",
      ]),
    );
  });

  it("refuses to waive blocked checks or upgrade the rehearsal outcome", () => {
    const waived = validReport();
    const platform = waived.checks.find((check) => check.id === "P5-PLAT-001")!;
    waived.checks[waived.checks.indexOf(platform)] = {
      id: platform.id,
      status: "pass",
      observed_at: platform.observed_at,
      evidence_sha256: "f".repeat(64),
    };
    expect(validateOneMachineRehearsalReport(waived).errors).toEqual(
      expect.arrayContaining([
        "P5-PLAT-001 must remain blocked in a one-machine report",
        "P5-PLAT-001 cannot be waived by a one-machine rehearsal",
      ]),
    );

    const promoted = validReport() as unknown as Record<string, unknown>;
    promoted.result = "qualified";
    promoted.phase5_gate = "complete";
    const promotedResult = validateOneMachineRehearsalReport(promoted);
    expect(promotedResult.ok).toBe(false);
    expect(promotedResult.errors).toEqual(
      expect.arrayContaining([
        "/result violates report schema (const)",
        "/phase5_gate violates report schema (const)",
      ]),
    );
  });

  it("binds every artifact to one source and requires independent installations", () => {
    const sourceMismatch = validReport();
    sourceMismatch.artifacts.authority.source_sha = "2".repeat(40);
    expect(validateOneMachineRehearsalReport(sourceMismatch).errors).toContain(
      "authority source identity differs from the report",
    );

    const sharedIdentity = validReport();
    sharedIdentity.topology.installations[1]!.installation_id =
      sharedIdentity.topology.installations[0]!.installation_id;
    expect(validateOneMachineRehearsalReport(sharedIdentity).errors).toContain(
      "installation A and B share installation_id",
    );

    const reversed = validReport();
    reversed.topology.installations.reverse();
    expect(validateOneMachineRehearsalReport(reversed).errors).toContain(
      "topology installations must be ordered A then B",
    );
  });

  it("rejects arbitrary errors, identity leakage, network locations, and raw protocol content", () => {
    const unsafe = validReport() as unknown as Record<string, unknown>;
    unsafe.error = "ambiguous failure text";
    unsafe.operator_username = "founder";
    unsafe.debug_path = "/Users/founder/phase5";
    unsafe.remote = "10.0.0.1";
    unsafe.remote_v6 = "::1";
    unsafe.machine = "founder-mac.local";
    unsafe.material = "A".repeat(43);
    unsafe.raw_request = {
      headers: { authorization: "Bearer should-never-appear" },
      body: "{}",
    };

    const result = validateOneMachineRehearsalReport(unsafe);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "/error is a forbidden free-form or sensitive field",
        "/operator_username is a forbidden free-form or sensitive field",
        "/debug_path contains an absolute local path",
        "/remote contains an IP address",
        "/remote_v6 contains an IP address",
        "/machine contains a hostname",
        "/material contains secret-like content",
        "/raw_request is a forbidden free-form or sensitive field",
        "/raw_request/headers/authorization contains secret-like content",
      ]),
    );
  });

  it("rejects invalid or out-of-window evidence timestamps", () => {
    const invalid = validReport();
    invalid.checks[0]!.observed_at = "2026-07-22T99:00:00.000Z";
    expect(validateOneMachineRehearsalReport(invalid).errors).toContain(
      "P5-ART-001 observed_at is not a real timestamp",
    );

    const outside = validReport();
    outside.checks[0]!.observed_at = "2026-07-22T11:00:00.000Z";
    expect(validateOneMachineRehearsalReport(outside).errors).toContain(
      "P5-ART-001 observation is outside the run window",
    );
  });

  it("does not construct a report when any required passing evidence is absent", () => {
    const evidence = passingEvidence();
    delete evidence["P5-SEC-002"];
    expect(() =>
      createOneMachineRehearsalReport({
        ...validReport(),
        passing_evidence: evidence,
      }),
    ).toThrow(/passingEvidence is missing checks: P5-SEC-002/);
  });

  it("validates a bounded report through the standalone CLI", async () => {
    const reportPath = join(TEMPORARY_ROOT, "report.json");
    writeFileSync(reportPath, `${JSON.stringify(validReport())}\n`, {
      mode: 0o600,
    });
    const child = spawnSanitizedChild(
      process.execPath,
      [VALIDATOR, "--report", reportPath],
      { cwd: REPO_ROOT },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const status = await new Promise<number | null>((resolveStatus, reject) => {
      child.once("error", reject);
      child.once("close", resolveStatus);
    });

    expect(status, stderr).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ ok: true, errors: [] });
  });
});
