import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCleanFounderOnboardingManifest,
  runCleanFounderCli,
  type CleanFounderCliDependencies,
} from "../src/composition/clean-founder-cli.js";
import { initializeCleanResetState } from "../src/composition/clean-reset-state.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function stateDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "echo-clean-founder-"));
  temporaryDirectories.push(root);
  const oidcConfig = join(root, "oidc.json");
  writeFileSync(
    oidcConfig,
    JSON.stringify({
      issuer: "https://issuer.example",
      client_id: "founder-client",
      redirect_uri: "https://authority.example/v2/session/oidc/callback",
      tenant: { kind: "issuer" },
      id_token_algorithms: ["RS256"],
      client_authentication: "none",
    }),
    { mode: 0o600 },
  );
  chmodSync(oidcConfig, 0o600);
  return join(root, "state");
}

function dependencies(order: string[]): CleanFounderCliDependencies {
  return {
    now: () => "2026-08-22T12:00:00.000Z",
    reset: (input) => {
      order.push(
        `reset:${input.created_at}:${input.creating_artifact_revision}`,
      );
      return initializeCleanResetState(input);
    },
    initialize_credentials: async () => {
      order.push("credentials");
    },
    connect_slack: async (input) => {
      order.push(`slack:${await input.read_stdin()}`);
      return {
        connection_id: input.connection_id ?? "con_clean-founder",
        verification: {
          workspace_id: "T_WORKSPACE",
          enterprise_id: null,
          app_id: "A_APP",
          bot_id: "B_BOT",
          bot_user_id: "U_BOT",
          approval_channel_id: input.approval_channel_id,
          required_scopes: [
            "channels:history",
            "channels:read",
            "chat:write",
            "reactions:read",
            "users:read",
          ],
          approval_channel_access: "verified" as const,
          selected_channel_public: true,
          selected_channel_active: true,
          bot_membership_verified: true,
          bot_access_verified: true,
          verified_at: "2026-08-22T12:00:00.000Z",
        },
      };
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
  const bootstrapArgs = (state: string) => [
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
    join(dirname(state), "oidc.json"),
    "--slack-approval-channel-id",
    "C123",
  ];

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
        join(dirname(state), "oidc.json"),
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

    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(order).toEqual([
      "reset:2026-08-22T12:00:00.000Z:clean-founder-v1",
      "credentials",
      "slack:xoxb-test-token\n",
      expect.stringMatching(/^invite:mem_/),
    ]);
    const output = JSON.parse(stdout) as Record<string, string>;
    expect(output).toEqual({
      ok: true,
      invitation_path: join(
        state,
        "onboarding",
        "founder-person-invitation.json",
      ),
      slack_verification: {
        workspace_id: "T_WORKSPACE",
        enterprise_id: null,
        app_id: "A_APP",
        bot_id: "B_BOT",
        bot_user_id: "U_BOT",
        approval_channel_id: "C123",
        required_scopes: [
          "channels:history",
          "channels:read",
          "chat:write",
          "reactions:read",
          "users:read",
        ],
        approval_channel_access: "verified",
        selected_channel_public: true,
        selected_channel_active: true,
        bot_membership_verified: true,
        bot_access_verified: true,
        verified_at: "2026-08-22T12:00:00.000Z",
      },
      next_step: "resume_bootstrap",
      next_instruction:
        "Run echo-organization-authority-clean-founder resume --state-dir <absolute-path>.",
    });
    expect(stdout).not.toContain("xoxb-test-token");
    expect(stdout).not.toContain("con_clean-founder");

    const manifestPath = join(state, "onboarding", "clean-founder-v1.json");
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(manifestPath, "utf8")).not.toContain("xoxb-test-token");
    expect(readCleanFounderOnboardingManifest(state)).toMatchObject({
      owner_membership_id: expect.stringMatching(/^mem_/),
      slack_connection_id: expect.stringMatching(/^con_/),
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
        join(dirname(state), "oidc.json"),
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

  it("rejects OIDC configuration before creating a setup plan, genesis, or Slack connection", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    writeFileSync(join(dirname(state), "oidc.json"), "{}", { mode: 0o600 });
    let stderr = "";

    const result = await runCleanFounderCli(
      bootstrapArgs(state),
      { stdout: () => undefined, stderr: (value) => (stderr += value), read_stdin: async () => "token" },
      dependencies(order),
    );

    expect(result).toBe(1);
    expect(stderr).toContain("OIDC config has an unexpected shape");
    expect(order).toEqual([]);
    expect(existsSync(state)).toBe(false);
    expect(existsSync(`${state}.clean-founder-setup-plan-v1.json`)).toBe(false);
  });

  it("rejects a legacy founder manifest shape instead of treating it as compatible", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    await runCleanFounderCli(
      bootstrapArgs(state),
      { stdout: () => undefined, stderr: () => undefined, read_stdin: async () => "token" },
      dependencies(order),
    );
    const path = join(state, "onboarding", "clean-founder-v1.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete manifest.setup_seed;
    delete manifest.owner_email;
    delete manifest.organization_name;
    delete manifest.owner_display_name;
    writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
    chmodSync(path, 0o600);

    expect(() => readCleanFounderOnboardingManifest(state)).toThrow(
      "clean founder onboarding manifest is invalid",
    );
  });

  it("refuses resume when state exists but its exact setup plan is missing", async () => {
    const state = stateDirectory();
    mkdirSync(state, { mode: 0o700 });
    let stderr = "";

    const result = await runCleanFounderCli(
      ["resume", "--state-dir", state],
      {
        stdout: () => undefined,
        stderr: (value) => (stderr += value),
        read_stdin: async () => {
          throw new Error("resume must not read Slack stdin without a plan");
        },
      },
      dependencies([]),
    );

    expect(result).toBe(1);
    expect(stderr).toContain("restore the exact setup plan");
    expect(stderr).toContain("new clean state directory");
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
        join(dirname(state), "oidc.json"),
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
      {
        ...deps,
        read_full_founder_status: () => ({
          founder_oidc_bound: true,
          founder_slack_link_active: true,
          granola_credentials_valid: true,
          slack_approval_binding_active: false,
          granola_admission_present: false,
        }),
      },
    );

    expect(status).toBe(0);
    expect(order).toEqual([
      expect.stringMatching(/^activate:con_.+:C123$/),
      `admit:${join(state, "credentials", "granola-credential")}`,
    ]);
    expect(stdout).not.toContain("con_clean-founder");
    expect(stdout).toContain("live-only cutoff");
  });

  it("refuses finalize before every founder prerequisite without activating anything", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const base = dependencies(order);
    await runCleanFounderCli(
      bootstrapArgs(state),
      { stdout: () => undefined, stderr: () => undefined, read_stdin: async () => "token" },
      base,
    );
    order.splice(0);

    let stderr = "";
    const result = await runCleanFounderCli(
      ["finalize", "--state-dir", state],
      { stdout: () => undefined, stderr: (value) => (stderr += value), read_stdin: async () => "" },
      {
        ...base,
        read_full_founder_status: () => ({
          founder_oidc_bound: false,
          founder_slack_link_active: false,
          granola_credentials_valid: false,
          slack_approval_binding_active: false,
          granola_admission_present: false,
        }),
      },
    );

    expect(result).toBe(1);
    expect(stderr).toContain("founder OIDC binding");
    expect(stderr).toContain("founder Slack link");
    expect(stderr).toContain("provider credentials");
    expect(order).toEqual([]);
  });

  it("proves genesis before a full-status seam can activate anything", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const base = dependencies(order);
    await runCleanFounderCli(
      bootstrapArgs(state),
      { stdout: () => undefined, stderr: () => undefined, read_stdin: async () => "token" },
      base,
    );
    order.splice(0);
    writeFileSync(join(state, "state-lineage-root.v1.json"), "{}", { mode: 0o600 });

    let stderr = "";
    const result = await runCleanFounderCli(
      ["finalize", "--state-dir", state],
      { stdout: () => undefined, stderr: (value) => (stderr += value), read_stdin: async () => "" },
      {
        ...base,
        read_full_founder_status: () => ({
          founder_oidc_bound: true,
          founder_slack_link_active: true,
          granola_credentials_valid: true,
          slack_approval_binding_active: false,
          granola_admission_present: false,
        }),
      },
    );

    expect(result).toBe(1);
    expect(stderr).toContain("valid clean state-lineage root manifest");
    expect(order).toEqual([]);
  });

  it("resumes finalize after source admission fails without activating Slack twice", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const base = dependencies(order);
    await runCleanFounderCli(
      bootstrapArgs(state),
      { stdout: () => undefined, stderr: () => undefined, read_stdin: async () => "token" },
      base,
    );
    order.splice(0);
    const full = {
      founder_oidc_bound: true,
      founder_slack_link_active: true,
      granola_credentials_valid: true,
      slack_approval_binding_active: false,
      granola_admission_present: false,
    };
    let failAdmission = true;
    const retrying: CleanFounderCliDependencies = {
      ...base,
      activate_approval: async (input) => {
        order.push(`activate:${input.connection_id}:${input.approval_channel_id}`);
        full.slack_approval_binding_active = true;
      },
      admit_source: async (input) => {
        order.push(`admit:${input.granola_credential_file}`);
        if (failAdmission) {
          failAdmission = false;
          throw new Error("injected source admission failure");
        }
        full.granola_admission_present = true;
      },
      read_full_founder_status: () => ({ ...full }),
    };
    const io = { stdout: () => undefined, stderr: () => undefined, read_stdin: async () => "" };

    expect(await runCleanFounderCli(["finalize", "--state-dir", state], io, retrying)).toBe(1);
    expect(await runCleanFounderCli(["finalize", "--state-dir", state], io, retrying)).toBe(0);
    expect(order.filter((entry) => entry.startsWith("activate:"))).toHaveLength(1);
    expect(order.filter((entry) => entry.startsWith("admit:"))).toHaveLength(2);
  });

  it("reports the actual post-bootstrap action instead of sending a bound founder to login", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const completedStage = {
      credentials_ready: true,
      slack_connected: true,
      invitation_file_present: false,
    };
    let stdout = "";
    const result = await runCleanFounderCli(
      bootstrapArgs(state),
      { stdout: (value) => (stdout += value), stderr: () => undefined, read_stdin: async () => "token" },
      {
        ...dependencies(order),
        read_setup_stage: () => completedStage,
        read_full_founder_status: () => ({
          founder_oidc_bound: true,
          founder_slack_link_active: false,
          granola_credentials_valid: false,
          slack_approval_binding_active: false,
          granola_admission_present: false,
        }),
      },
    );

    expect(result).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      next_step: "complete_founder_slack_link",
      next_instruction: "Complete the founder Slack identity link in the clean Authority.",
    });
    expect(stdout).not.toContain("invitation_path");
    expect(order).toEqual(["reset:2026-08-22T12:00:00.000Z:clean-founder-v1"]);
  });

  it("installs all provider credentials from private files without printing their values", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    await runCleanFounderCli(
      bootstrapArgs(state),
      {
        stdout: () => undefined,
        stderr: () => undefined,
        read_stdin: async () => "xoxb-test-token",
      },
      dependencies(order),
    );
    const credentialDirectory = join(state, "credentials");
    mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
    chmodSync(credentialDirectory, 0o700);
    const sourceDirectory = join(dirname(state), "private-inputs");
    mkdirSync(sourceDirectory, { mode: 0o700 });
    const values = {
      granola: `grn_${"g".repeat(40)}`,
      owner: "founder@example.com",
      llm: "l".repeat(40),
    };
    const sources = {
      granola: join(sourceDirectory, "granola"),
      owner: join(sourceDirectory, "owner-email"),
      llm: join(sourceDirectory, "llm"),
    };
    for (const [name, path] of Object.entries(sources)) {
      writeFileSync(path, values[name as keyof typeof values], { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    let stdout = "";
    let stderr = "";
    const result = await runCleanFounderCli(
      [
        "credentials-install",
        "--state-dir",
        state,
        "--granola-credential-file",
        sources.granola,
        "--granola-owner-email-file",
        sources.owner,
        "--llm-credential-file",
        sources.llm,
      ],
      {
        stdout: (value) => (stdout += value),
        stderr: (value) => (stderr += value),
        read_stdin: async () => "",
      },
    );

    expect(result).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      credentials_ready: true,
    });
    for (const value of Object.values(values)) expect(stdout).not.toContain(value);
    expect(readFileSync(join(credentialDirectory, "granola-credential"), "utf8"))
      .toBe(values.granola);
    expect(readFileSync(join(credentialDirectory, "granola-owner-email"), "utf8"))
      .toBe(values.owner);
    expect(readFileSync(join(credentialDirectory, "llm-credential"), "utf8"))
      .toBe(values.llm);
    for (const filename of [
      "granola-credential",
      "granola-owner-email",
      "llm-credential",
    ]) {
      expect(statSync(join(credentialDirectory, filename)).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it("resumes a lost bootstrap response from the durable plan without rereading connected Slack stdin", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const stage = {
      credentials_ready: false,
      slack_connected: false,
      invitation_file_present: false,
    };
    let resetFails = true;
    let failAfter: "credentials" | "slack" | "invitation" | undefined =
      undefined;
    let stdinReads = 0;
    const base = dependencies(order);
    const deps: CleanFounderCliDependencies = {
      ...base,
      reset: (input) => {
        if (resetFails) throw new Error("injected before genesis");
        return initializeCleanResetState(input);
      },
      initialize_credentials: async () => {
        order.push("credentials");
        stage.credentials_ready = true;
        if (failAfter === "credentials") throw new Error("injected after credentials");
      },
      connect_slack: async (input) => {
        stdinReads += 1;
        await input.read_stdin();
        order.push("slack");
        stage.slack_connected = true;
        if (failAfter === "slack") throw new Error("injected after slack");
        return { connection_id: input.connection_id ?? "con_unexpected" };
      },
      issue_invitation: async () => {
        order.push("invitation");
        stage.invitation_file_present = true;
        if (failAfter === "invitation") throw new Error("injected after invitation");
      },
      read_setup_stage: () => stage,
    };
    const io = {
      stdout: () => undefined,
      stderr: () => undefined,
      read_stdin: async () => "xoxb-test-token",
    };

    expect(await runCleanFounderCli(bootstrapArgs(state), io, deps)).toBe(1);
    let status = "";
    expect(
      await runCleanFounderCli(["status", "--state-dir", state], {
        ...io,
        stdout: (value) => (status += value),
      }),
    ).toBe(0);
    expect(status).not.toContain("founder@example.com");
    expect(status).not.toContain(state);
    expect(status).not.toContain("oau_");
    expect(status).not.toContain("xoxb-test-token");
    expect(JSON.parse(status)).toMatchObject({
      setup_plan_present: true,
      genesis_published: false,
      next_step: "resume_bootstrap",
    });

    resetFails = false;
    failAfter = "credentials";
    expect(
      await runCleanFounderCli(["resume", "--state-dir", state], io, deps),
    ).toBe(1);
    failAfter = "slack";
    expect(
      await runCleanFounderCli(["resume", "--state-dir", state], io, deps),
    ).toBe(1);
    expect(order.filter((value) => value === "credentials")).toHaveLength(1);
    failAfter = "invitation";
    expect(
      await runCleanFounderCli(["resume", "--state-dir", state], io, deps),
    ).toBe(1);
    expect(order.filter((value) => value === "slack")).toHaveLength(1);
    expect(stdinReads).toBe(1);
    failAfter = undefined;
    expect(
      await runCleanFounderCli(["resume", "--state-dir", state], io, deps),
    ).toBe(0);
    expect(order.filter((value) => value === "invitation")).toHaveLength(1);
    expect(stdinReads).toBe(1);
  });
});
