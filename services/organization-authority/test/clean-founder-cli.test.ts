import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCleanFounderOnboardingManifest,
  runCleanFounderCli,
  type CleanFounderCliDependencies,
} from "../src/composition/clean-founder-cli.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function stateDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "echo-clean-founder-"));
  temporaryDirectories.push(path);
  return path;
}

function dependencies(order: string[]): CleanFounderCliDependencies {
  return {
    now: () => "2026-08-22T12:00:00.000Z",
    reset: (input) => {
      order.push(
        `reset:${input.created_at}:${input.creating_artifact_revision}`,
      );
      return {
        authority_id: "oau_00000000-0000-4000-8000-000000000001",
        organization_id: "org_00000000-0000-4000-8000-000000000001",
        state_lineage_id: "lineage-00000000-0000-4000-8000-000000000001",
        owner_principal_id: "prn_00000000-0000-4000-8000-000000000001",
        owner_membership_id: "mem_00000000-0000-4000-8000-000000000001",
      } as ReturnType<CleanFounderCliDependencies["reset"]>;
    },
    initialize_credentials: async () => {
      order.push("credentials");
    },
    connect_slack: async (input) => {
      order.push(`slack:${await input.read_stdin()}`);
      return { connection_id: "con_clean-founder" };
    },
    issue_invitation: async (input) => {
      order.push(`invite:${input.membership_id}`);
      expect(
        readCleanFounderOnboardingManifest(input.state_directory),
      ).toMatchObject({
        invitation_path: input.output_path,
        pkce_key_file: input.pkce_key_file,
      });
    },
    activate_approval: async (input) => {
      order.push(
        `activate:${input.connection_id}:${input.approval_channel_id}`,
      );
    },
    admit_source: async (input) => {
      order.push(`admit:${input.granola_credential_file}`);
    },
  };
}

describe("clean founder coordinator", () => {
  it("runs reset, credentials, Slack, manifest, and invitation last", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    let stdout = "";
    let stderr = "";
    const status = await runCleanFounderCli(
      [
        "bootstrap",
        "--state-dir",
        state,
        "--organization-name",
        "ECHO",
        "--owner-display-name",
        "Founder",
        "--owner-email",
        "founder@example.com",
        "--authority-url",
        "https://authority.example",
        "--oidc-config",
        join(state, "oidc.json"),
        "--slack-approval-channel-id",
        "C123",
      ],
      {
        stdout: (value) => (stdout += value),
        stderr: (value) => (stderr += value),
        read_stdin: async () => "xoxb-test-token\n",
      },
      dependencies(order),
    );

    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(order).toEqual([
      "reset:2026-08-22T12:00:00.000Z:clean-founder-v1",
      "credentials",
      "slack:xoxb-test-token\n",
      "invite:mem_00000000-0000-4000-8000-000000000001",
    ]);
    const output = JSON.parse(stdout) as Record<string, string>;
    expect(output).toEqual({
      ok: true,
      invitation_path: join(
        state,
        "onboarding",
        "founder-person-invitation.json",
      ),
      next_instruction:
        "Start echo-organization-authority-clean-live serve, then run: echo-brain person login --invitation <invitation_path>.",
    });
    expect(stdout).not.toContain("xoxb-test-token");
    expect(stdout).not.toContain("con_clean-founder");

    const manifestPath = join(state, "onboarding", "clean-founder-v1.json");
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(manifestPath, "utf8")).not.toContain("xoxb-test-token");
    expect(readCleanFounderOnboardingManifest(state)).toMatchObject({
      owner_membership_id: "mem_00000000-0000-4000-8000-000000000001",
      slack_connection_id: "con_clean-founder",
      granola_credential_file: join(state, "credentials", "granola-credential"),
    });
  });

  it("rejects a noncanonical owner email before creating state or connecting Slack", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    let stderr = "";
    const status = await runCleanFounderCli(
      [
        "bootstrap",
        "--state-dir",
        state,
        "--organization-name",
        "ECHO",
        "--owner-display-name",
        "Founder",
        "--owner-email",
        "Founder@Example.com",
        "--authority-url",
        "https://authority.example",
        "--oidc-config",
        join(state, "oidc.json"),
        "--slack-approval-channel-id",
        "C123",
      ],
      {
        stdout: () => undefined,
        stderr: (value) => (stderr += value),
        read_stdin: async () => "token",
      },
      dependencies(order),
    );

    expect(status).toBe(1);
    expect(stderr).toContain("canonical lowercase email");
    expect(order).toEqual([]);
  });

  it("finalizes from the private manifest without asking for IDs", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const deps = dependencies(order);
    await runCleanFounderCli(
      [
        "bootstrap",
        "--state-dir",
        state,
        "--organization-name",
        "ECHO",
        "--owner-display-name",
        "Founder",
        "--owner-email",
        "founder@example.com",
        "--authority-url",
        "https://authority.example",
        "--oidc-config",
        join(state, "oidc.json"),
        "--slack-approval-channel-id",
        "C123",
      ],
      {
        stdout: () => undefined,
        stderr: () => undefined,
        read_stdin: async () => "token",
      },
      deps,
    );
    order.splice(0);
    let stdout = "";
    const status = await runCleanFounderCli(
      ["finalize", "--state-dir", state],
      {
        stdout: (value) => (stdout += value),
        stderr: () => undefined,
        read_stdin: async () => "",
      },
      deps,
    );

    expect(status).toBe(0);
    expect(order).toEqual([
      "activate:con_clean-founder:C123",
      `admit:${join(state, "credentials", "granola-credential")}`,
    ]);
    expect(stdout).not.toContain("con_clean-founder");
    expect(stdout).toContain("live-only cutoff");
  });
});
