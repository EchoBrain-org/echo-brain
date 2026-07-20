import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/product/federation/foundation/canonical-json.js";
import { runManualN2Onboarding } from "../../src/product/n2-manual-onboarding.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "echo-manual-n2-"));
  roots.push(root);
  return root;
}

async function command(...args: string[]): Promise<Record<string, unknown>> {
  return (await runManualN2Onboarding(args)) as Record<string, unknown>;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("manual N=2 onboarding", () => {
  it("ingests from A and B, revokes A, rejects A, and keeps B advancing", async () => {
    const root = temporaryRoot();
    const authority = join(root, "authority");
    const ownerState = join(root, "owner");
    const employeeState = join(root, "employee");
    const buildIdentity = join(root, "build-identity.v1.json");
    writeFileSync(
      buildIdentity,
      canonicalJson({
        schema_version: 1,
        kind: "echo-packaged-build-identity",
        product_version: "0.0.0-manual-n2-pilot",
        source_sha: "a".repeat(40),
        source_kind: "worktree-head-unverified",
      }),
      { mode: 0o600 },
    );

    await command(
      "authority-init",
      "--state",
      authority,
      "--organization-name",
      "Manual N2 Org",
      "--owner-name",
      "Owner A",
    );

    const enroll = async (
      label: string,
      state: string,
      membershipType: "owner" | "employee",
    ) => {
      const invite = join(root, `${label}-invite.json`);
      const request = join(root, `${label}-request.json`);
      const challenge = join(root, `${label}-challenge.json`);
      const proof = join(root, `${label}-proof.json`);
      const receipt = join(root, `${label}-receipt.json`);
      await command(
        "invite-create",
        "--state",
        authority,
        "--membership-type",
        membershipType,
        ...(membershipType === "employee" ? ["--name", "Employee B"] : []),
        "--out",
        invite,
      );
      const prepared = await command(
        "join-prepare",
        "--state",
        state,
        "--invite",
        invite,
        "--build-identity",
        buildIdentity,
        "--out",
        request,
      );
      await command(
        "challenge-issue",
        "--state",
        authority,
        "--request",
        request,
        "--out",
        challenge,
      );
      await command(
        "proof-create",
        "--state",
        state,
        "--request",
        request,
        "--challenge",
        challenge,
        "--out",
        proof,
      );
      await command(
        "enrollment-complete",
        "--state",
        authority,
        "--request",
        request,
        "--challenge",
        challenge,
        "--proof",
        proof,
        "--out",
        receipt,
      );
      await command(
        "enrollment-accept",
        "--state",
        state,
        "--request",
        request,
        "--receipt",
        receipt,
      );
      return String(prepared["installation_id"]);
    };

    const ownerInstallation = await enroll("owner", ownerState, "owner");
    const employeeInstallation = await enroll(
      "employee",
      employeeState,
      "employee",
    );
    expect(ownerInstallation).not.toBe(employeeInstallation);

    const ingest = async (state: string, label: string) => {
      const batch = join(root, `${label}-batch.json`);
      const response = join(root, `${label}-response.json`);
      await command(
        "record-create",
        "--state",
        state,
        "--text",
        `${label} synthetic proof`,
      );
      await command("batch-create", "--state", state, "--out", batch);
      const authorityResult = await command(
        "authority-ingest",
        "--state",
        authority,
        "--batch",
        batch,
        "--out",
        response,
      );
      const localResult = await command(
        "receipt-accept",
        "--state",
        state,
        "--response",
        response,
      );
      return { authorityResult, localResult };
    };

    const ownerFirst = await ingest(ownerState, "owner-first");
    const employeeFirst = await ingest(employeeState, "employee-first");
    expect(ownerFirst.authorityResult["statuses"]).toEqual(["accepted"]);
    expect(employeeFirst.authorityResult["statuses"]).toEqual(["accepted"]);
    expect(ownerFirst.localResult["acknowledged_sequence"]).toBe(1);
    expect(employeeFirst.localResult["acknowledged_sequence"]).toBe(1);

    const revoked = await command(
      "authority-revoke-installation",
      "--state",
      authority,
      "--installation-id",
      ownerInstallation,
      "--reason",
      "Manual N=2 test revocation",
    );
    expect(revoked["status"]).toBe("revoked");

    const ownerAfter = await ingest(ownerState, "owner-after-revocation");
    const employeeAfter = await ingest(
      employeeState,
      "employee-after-owner-revocation",
    );
    expect(ownerAfter.authorityResult["statuses"]).toEqual(["rejected"]);
    expect(ownerAfter.localResult).toMatchObject({
      acknowledged_sequence: 1,
      terminal_status: "rejected",
    });
    expect(employeeAfter.authorityResult["statuses"]).toEqual(["accepted"]);
    expect(employeeAfter.localResult).toMatchObject({
      acknowledged_sequence: 2,
      terminal_status: "active",
    });
  });
});
