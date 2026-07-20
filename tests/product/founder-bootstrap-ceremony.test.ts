import {
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LLM_DECISION_PROCESSOR_PROMPT_VERSION } from "../../src/adapters/decision-processors/llm/llm-decision-processor.js";
import type { GranolaApiClient } from "../../src/adapters/meeting-sources/granola/index.js";
import type {
  SlackAuthIdentity,
  SlackDirectMessage,
  SlackPostMessageInput,
  SlackPostedMessage,
  SlackReaction,
} from "../../src/adapters/shared/slack/slack-web-api-client.js";
import type { ProductRuntimeConfig } from "../../src/product/config.js";
import { runProductCli } from "../../src/product/cli.js";
import {
  abortFounderBootstrap,
  beginFounderBootstrap,
  commitFounderBootstrapCeremony,
  statusFounderBootstrap,
  type FounderBootstrapCeremonyDependencies,
} from "../../src/product/federation/founder-bootstrap-ceremony.js";
import { ActiveIdentityBundleStore } from "../../src/product/federation/active-identity-bundle-store.js";
import { checkFounderIdentity } from "../../src/product/federation/identity-check.js";
import { FounderBootstrapSessionStore } from "../../src/product/federation/bootstrap-session-store.js";
import {
  canonicalJson,
  canonicalSha256,
} from "../../src/product/federation/canonical-json.js";
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from "../../src/product/federation/installation-signer.js";
import {
  normalizeP256LowS,
  p256KeyId,
} from "../../src/product/federation/signature-profile.js";
import type { SlackDmChallengeApi } from "../../src/product/federation/slack-dm-challenge.js";

const NOW = "2026-07-19T23:00:00.000Z";
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

class FakeHardwareSigner implements InstallationSigner {
  private readonly keys = new Map<
    string,
    { privateKey: KeyObject; descriptor: InstallationKeyDescriptor }
  >();
  failSignOnce = false;
  failGenerateOnce = false;
  reportDeleteWithoutDeleting = false;
  generateCalls = 0;

  async generate(installationId: string): Promise<InstallationKeyDescriptor> {
    this.generateCalls += 1;
    if (this.failGenerateOnce) {
      this.failGenerateOnce = false;
      throw new Error("simulated crash before key generation");
    }
    const existing = this.keys.get(installationId);
    if (existing !== undefined) return existing.descriptor;
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const spki = publicKey.export({ type: "spki", format: "der" });
    const descriptor: InstallationKeyDescriptor = {
      installation_id: installationId,
      key_id: p256KeyId(spki),
      algorithm: "ecdsa-p256-sha256-der-low-s",
      public_key_spki_der_base64: spki.toString("base64"),
      protection: "secure-enclave",
      assurance: "hardware_bound",
      private_key_exportable: false,
    };
    this.keys.set(installationId, { privateKey, descriptor });
    return descriptor;
  }

  async inspect(
    installationId: string,
  ): Promise<InstallationKeyDescriptor | null> {
    return this.keys.get(installationId)?.descriptor ?? null;
  }

  async sign(
    installationId: string,
    message: Buffer,
    expectedKeyId?: `sha256:${string}`,
  ): Promise<Buffer> {
    if (this.failSignOnce) {
      this.failSignOnce = false;
      throw new Error("simulated crash after key generation");
    }
    const key = this.keys.get(installationId);
    if (key === undefined || key.descriptor.key_id !== expectedKeyId) {
      throw new Error("test key is unavailable or mismatched");
    }
    return normalizeP256LowS(
      signMessage("sha256", message, {
        key: key.privateKey,
        dsaEncoding: "der",
      }),
    );
  }

  async deleteOrphan(
    installationId: string,
    expectedKeyId: `sha256:${string}`,
  ): Promise<boolean> {
    const key = this.keys.get(installationId);
    if (key === undefined) return false;
    if (key.descriptor.key_id !== expectedKeyId) {
      throw new Error("test key fingerprint mismatch");
    }
    if (this.reportDeleteWithoutDeleting) return true;
    return this.keys.delete(installationId);
  }
}

class FakeSlackApi implements SlackDmChallengeApi {
  readonly identity: SlackAuthIdentity = {
    team_id: "T123TEAM",
    enterprise_id: null,
    user_id: "U123BOT",
    bot_id: "B123BOT",
    app_id: "A123APP",
  };
  reactionObserved = false;
  authCalls = 0;
  readonly posted: SlackPostMessageInput[] = [];

  async authIdentity(): Promise<SlackAuthIdentity> {
    this.authCalls += 1;
    return this.identity;
  }

  async openDirectMessage(userId: string): Promise<SlackDirectMessage> {
    return { channel_id: "D123FOUNDER", user_id: userId };
  }

  async postMessage(input: SlackPostMessageInput): Promise<SlackPostedMessage> {
    this.posted.push(input);
    return { channel: String(input.channel), ts: "1752966000.000001" };
  }

  async reactionsGet(): Promise<readonly SlackReaction[]> {
    return this.reactionObserved
      ? [{ name: "white_check_mark", users: ["U123FOUNDER"], count: 1 }]
      : [];
  }
}

class FakeGranolaApi implements GranolaApiClient {
  listCalls = 0;
  failNext = false;

  async listNotes() {
    this.listCalls += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("temporary Granola bootstrap failure");
    }
    return {
      notes: [{ id: "not_bootstrap_evidence" }],
      hasMore: true,
      cursor: "not-persisted",
    };
  }

  async getNote(): Promise<never> {
    throw new Error("bootstrap must not fetch Granola note detail");
  }
}

function privateState(): string {
  const root = mkdtempSync(join(tmpdir(), "echo-founder-bootstrap-"));
  temporary.push(root);
  const state = join(realpathSync(root), "state");
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  return state;
}

function config(stateDir: string): ProductRuntimeConfig {
  return {
    schema_version: 1,
    lane: "team-product",
    state_dir: stateDir,
    meeting_sources: [
      {
        adapter_id: "granola",
        instance_id: "primary",
        credential_ref: `file:${join(stateDir, "credentials", "granola-api-key")}`,
        settings: { page_size: 1 },
      },
    ],
    decision_processor: {
      adapter_id: "structured-text",
      instance_id: "primary",
      settings: {},
    },
    delivery_surfaces: [
      {
        adapter_id: "slack",
        instance_id: "team-decisions",
        credential_ref: `file:${join(stateDir, "credentials", "slack-bot-token")}`,
        settings: { channel_id: "C123DECISIONS" },
      },
    ],
    approval_mode: "adapter",
    approval_surface: {
      adapter_id: "slack-reactions",
      instance_id: "founder-approval",
      credential_ref: `file:${join(stateDir, "credentials", "slack-bot-token")}`,
      settings: {
        channel_id: "C123APPROVALS",
        reviewer: { slack_user_id: "U123FOUNDER", name: "Zhenye" },
      },
    },
  };
}

function fixture(stateDir: string) {
  const slack = new FakeSlackApi();
  const granola = new FakeGranolaApi();
  const signer = new FakeHardwareSigner();
  const credentials = new Map([
    [
      `file:${join(stateDir, "credentials", "slack-bot-token")}`,
      "xoxb-test-slack",
    ],
    [
      `file:${join(stateDir, "credentials", "granola-api-key")}`,
      "grn_test_granola",
    ],
  ]);
  const dependencies: FounderBootstrapCeremonyDependencies = {
    signer,
    credentialResolver: (reference) => credentials.get(reference),
    slackApiFactory: () => slack,
    granolaApiFactory: () => granola,
    loadBuildIdentity: () => ({
      schema_version: 1,
      kind: "echo-packaged-build-identity",
      product_version: "0.1.0-dev.6",
      source_sha: "a".repeat(40),
      source_kind: "materialized-commit",
    }),
    now: () => NOW,
    sessionIdFactory: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
  return {
    config: config(stateDir),
    slack,
    granola,
    signer,
    credentials,
    dependencies,
  };
}

describe("founder bootstrap ceremony", () => {
  it("derives the code-owned LLM prompt version into the signed binding snapshot", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    const llmConfig: ProductRuntimeConfig = {
      ...test.config,
      decision_processor: {
        adapter_id: "llm",
        instance_id: "ollama-qwen3-4b",
        settings: {
          model: "qwen3:4b",
          base_url: "http://127.0.0.1:11434",
          request_timeout_ms: 240_000,
        },
      },
    };
    const dependencies: FounderBootstrapCeremonyDependencies = {
      ...test.dependencies,
      authorizeSeedCutover: async () => undefined,
    };

    const begun = await beginFounderBootstrap(
      llmConfig,
      {
        organizationDisplayName: "EchoBrain",
        principalDisplayName: "Zhenye",
        slackUserId: "U123FOUNDER",
      },
      dependencies,
    );
    const session = new FounderBootstrapSessionStore(stateDir).read(
      begun.session_id,
    );
    const processor = session.request.bindings.find(
      (binding) => binding.capability === "decision-processor",
    )!;
    expect(llmConfig.decision_processor.settings).not.toHaveProperty(
      "prompt_version",
    );
    expect(processor.configuration_snapshot).toEqual({
      ...llmConfig.decision_processor.settings,
      prompt_version: LLM_DECISION_PROCESSOR_PROMPT_VERSION,
    });
    expect(processor.configuration_sha256).toBe(
      canonicalSha256(processor.configuration_snapshot),
    );

    test.slack.reactionObserved = true;
    const ready = await statusFounderBootstrap(
      llmConfig,
      begun.session_id,
      {},
      dependencies,
    );
    await commitFounderBootstrapCeremony(
      llmConfig,
      begun.session_id,
      ready.confirmation!.confirmation_sha256,
      dependencies,
    );
    const verified = new ActiveIdentityBundleStore(stateDir).loadVerified(
      llmConfig,
    )!;
    expect(
      verified.connectionRegistry.bindings.find(
        (binding) => binding.capability === "decision-processor",
      )?.configuration_snapshot,
    ).toEqual(processor.configuration_snapshot);
  });

  it("keeps rehearsal inactive through Slack verification until the seed cutover gate lands", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);

    const begun = await beginFounderBootstrap(
      test.config,
      {
        organizationDisplayName: "EchoBrain",
        principalDisplayName: "Zhenye",
        slackUserId: "U123FOUNDER",
      },
      test.dependencies,
    );

    expect(begun).toMatchObject({
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      phase: "challenge_pending",
      challenge: {
        channel_id: "D123FOUNDER",
        reaction_name: "white_check_mark",
      },
      confirmation: null,
      result: null,
    });
    expect(test.slack.posted).toHaveLength(1);
    expect(test.granola.listCalls).toBe(1);
    expect(existsSync(join(stateDir, "identity"))).toBe(false);

    const pending = await statusFounderBootstrap(
      test.config,
      begun.session_id,
      {},
      test.dependencies,
    );
    expect(pending.phase).toBe("challenge_pending");

    test.slack.reactionObserved = true;
    const ready = await statusFounderBootstrap(
      test.config,
      begun.session_id,
      {},
      test.dependencies,
    );
    expect(ready.phase).toBe("ready_for_confirmation");
    expect(ready.confirmation?.summary).toMatchObject({
      organization: { display_name: "EchoBrain" },
      founder: {
        display_name: "Zhenye",
        slack_team_id: "T123TEAM",
        slack_user_id: "U123FOUNDER",
        assurance: "provider_challenge_observed",
      },
      providers: {
        granola: { tenant: null, assurance: "credential_observed" },
      },
    });
    expect(ready.confirmation?.confirmation_sha256).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );

    await expect(
      commitFounderBootstrapCeremony(
        test.config,
        begun.session_id,
        `sha256:${"0".repeat(64)}`,
        test.dependencies,
      ),
    ).rejects.toThrow(/confirmation digest does not match/);
    expect(existsSync(join(stateDir, "identity"))).toBe(false);

    await expect(
      commitFounderBootstrapCeremony(
        test.config,
        begun.session_id,
        ready.confirmation!.confirmation_sha256,
        test.dependencies,
      ),
    ).rejects.toThrow(/seed_cutover_unavailable/);
    expect(existsSync(join(stateDir, "identity"))).toBe(false);

    const strict = await checkFounderIdentity(stateDir, {
      signer: test.signer,
      runtimeConfig: test.config,
      credentialResolver: test.dependencies.credentialResolver,
    });
    expect(strict).toMatchObject({
      mode: "local_only_unattributed",
      foundation_ok: true,
      seed_grade_ready: false,
    });
  });

  it("detects credential replacement before another provider call", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    const begun = await beginFounderBootstrap(
      test.config,
      {
        organizationDisplayName: "EchoBrain",
        principalDisplayName: "Zhenye",
        slackUserId: "U123FOUNDER",
      },
      test.dependencies,
    );
    const priorAuthCalls = test.slack.authCalls;
    test.credentials.set(
      `file:${join(stateDir, "credentials", "slack-bot-token")}`,
      "xoxb-replaced-token",
    );

    await expect(
      statusFounderBootstrap(
        test.config,
        begun.session_id,
        {},
        test.dependencies,
      ),
    ).rejects.toThrow(/credential material or reference no longer matches/);
    expect(test.slack.authCalls).toBe(priorAuthCalls);
  });

  it("persists a signed resumable session before provider diagnostics", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    test.granola.failNext = true;

    await expect(
      beginFounderBootstrap(
        test.config,
        {
          organizationDisplayName: "EchoBrain",
          principalDisplayName: "Zhenye",
          slackUserId: "U123FOUNDER",
        },
        test.dependencies,
      ),
    ).rejects.toThrow(
      /resume founder bootstrap session aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa with status/,
    );
    expect(existsSync(join(stateDir, "identity"))).toBe(false);

    const resumed = await statusFounderBootstrap(
      test.config,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      {},
      test.dependencies,
    );
    expect(resumed.phase).toBe("challenge_pending");
    expect(test.granola.listCalls).toBe(2);
    expect(test.slack.posted).toHaveLength(1);
  });

  it("journals installation identity before key generation and can abort a failed signing transition", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    test.signer.failSignOnce = true;

    await expect(
      beginFounderBootstrap(
        test.config,
        {
          organizationDisplayName: "EchoBrain",
          principalDisplayName: "Zhenye",
          slackUserId: "U123FOUNDER",
        },
        test.dependencies,
      ),
    ).rejects.toThrow(/resume founder bootstrap session/);
    expect(test.slack.authCalls).toBe(0);
    expect(test.granola.listCalls).toBe(0);

    await expect(
      abortFounderBootstrap(
        test.config,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "not-the-key",
        test.dependencies,
      ),
    ).rejects.toThrow(/planned bootstrap has installation key sha256:/);

    const recovered = await statusFounderBootstrap(
      test.config,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      {},
      test.dependencies,
    );
    expect(recovered).toMatchObject({
      phase: "key_ready",
      installation_key_id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(test.slack.authCalls).toBe(0);
    expect(test.granola.listCalls).toBe(0);

    const aborted = await abortFounderBootstrap(
      test.config,
      recovered.session_id,
      recovered.installation_key_id,
      test.dependencies,
    );
    expect(aborted).toMatchObject({
      aborted: true,
      key_deleted: true,
      installation_key_id: recovered.installation_key_id,
    });
    expect(
      readdirSync(join(stateDir, "bootstrap", "founder-identity")),
    ).toEqual([]);

    const restarted = await beginFounderBootstrap(
      test.config,
      {
        organizationDisplayName: "EchoBrain",
        principalDisplayName: "Zhenye",
        slackUserId: "U123FOUNDER",
      },
      test.dependencies,
    );
    expect(restarted.phase).toBe("challenge_pending");
  });

  it("recovers an fsynced atomic-write temp session after a process kill", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    test.signer.failGenerateOnce = true;
    await expect(
      beginFounderBootstrap(
        test.config,
        {
          organizationDisplayName: "EchoBrain",
          principalDisplayName: "Zhenye",
          slackUserId: "U123FOUNDER",
        },
        test.dependencies,
      ),
    ).rejects.toThrow(/resume founder bootstrap session/);
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const directory = join(stateDir, "bootstrap", "founder-identity");
    const filename = readdirSync(directory).find((item) =>
      item.startsWith("session."),
    )!;
    const interrupted = `${filename}.${process.pid}.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.tmp`;
    renameSync(join(directory, filename), join(directory, interrupted));

    const recovered = await statusFounderBootstrap(
      test.config,
      sessionId,
      {},
      test.dependencies,
    );
    expect(recovered.phase).toBe("key_ready");
    expect(readdirSync(directory)).toEqual([filename]);
  });

  it("can discard a planned journal when key generation never created a key", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    test.signer.failGenerateOnce = true;
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await expect(
      beginFounderBootstrap(
        test.config,
        {
          organizationDisplayName: "EchoBrain",
          principalDisplayName: "Zhenye",
          slackUserId: "U123FOUNDER",
        },
        test.dependencies,
      ),
    ).rejects.toThrow(/resume founder bootstrap session/);

    await expect(
      abortFounderBootstrap(
        test.config,
        sessionId,
        "wrong-confirmation",
        test.dependencies,
      ),
    ).rejects.toThrow(`--confirm session:${sessionId}`);
    const aborted = await abortFounderBootstrap(
      test.config,
      sessionId,
      `session:${sessionId}`,
      test.dependencies,
    );
    expect(aborted).toMatchObject({
      aborted: true,
      installation_key_id: null,
      key_deleted: false,
    });
    expect(
      readdirSync(join(stateDir, "bootstrap", "founder-identity")),
    ).toEqual([]);
  });

  it("retains the session when a signer falsely reports key deletion", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    const begun = await beginFounderBootstrap(
      test.config,
      {
        organizationDisplayName: "EchoBrain",
        principalDisplayName: "Zhenye",
        slackUserId: "U123FOUNDER",
      },
      test.dependencies,
    );
    test.signer.reportDeleteWithoutDeleting = true;

    await expect(
      abortFounderBootstrap(
        test.config,
        begun.session_id,
        begun.installation_key_id,
        test.dependencies,
      ),
    ).rejects.toThrow(/key was not deleted; session retained/);
    expect(
      new FounderBootstrapSessionStore(stateDir).read(begun.session_id).phase,
    ).toBe("challenge_pending");
  });

  it("proves the live session key before any resume provider call", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    const begun = await beginFounderBootstrap(
      test.config,
      {
        organizationDisplayName: "EchoBrain",
        principalDisplayName: "Zhenye",
        slackUserId: "U123FOUNDER",
      },
      test.dependencies,
    );
    const priorAuthCalls = test.slack.authCalls;
    const signedSession = new FounderBootstrapSessionStore(stateDir).read(
      begun.session_id,
    );
    await test.signer.deleteOrphan(
      signedSession.request.ids.installation_id,
      begun.installation_key_id as `sha256:${string}`,
    );

    await expect(
      statusFounderBootstrap(
        test.config,
        begun.session_id,
        {},
        test.dependencies,
      ),
    ).rejects.toThrow(/installation key is unavailable/);
    expect(test.slack.authCalls).toBe(priorAuthCalls);
  });

  it("rejects nested poison through the production session read path", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    const begun = await beginFounderBootstrap(
      test.config,
      {
        organizationDisplayName: "EchoBrain",
        principalDisplayName: "Zhenye",
        slackUserId: "U123FOUNDER",
      },
      test.dependencies,
    );
    const directory = join(stateDir, "bootstrap", "founder-identity");
    const filename = readdirSync(directory)[0]!;
    const path = join(directory, filename);
    const poisoned = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    (poisoned["integrity"] as Record<string, unknown>)["raw_token"] =
      "xoxb-must-never-survive";
    writeFileSync(path, canonicalJson(poisoned), { mode: 0o600 });

    expect(() =>
      new FounderBootstrapSessionStore(stateDir).read(begun.session_id),
    ).toThrow(/integrity has unsupported key 'raw_token'/);
  });

  it("rejects approval-actor mismatch, unsafe credential refs, and poison settings before key or network work", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    if (test.config.approval_mode !== "adapter") {
      throw new Error("test fixture must use adapter approval mode");
    }
    const runtime = test.config;
    const approval = runtime.approval_surface;
    const mismatch: ProductRuntimeConfig = {
      ...runtime,
      approval_surface: {
        ...approval,
        settings: {
          ...approval.settings,
          reviewer: { slack_user_id: "U999OTHER", name: "Other" },
        },
      },
    };
    await expect(
      beginFounderBootstrap(
        mismatch,
        {
          organizationDisplayName: "EchoBrain",
          principalDisplayName: "Zhenye",
          slackUserId: "U123FOUNDER",
        },
        test.dependencies,
      ),
    ).rejects.toThrow(/must match the workspace-scoped approval reviewer/);

    const poison: ProductRuntimeConfig = {
      ...runtime,
      meeting_sources: [
        {
          ...runtime.meeting_sources[0]!,
          settings: {
            ...runtime.meeting_sources[0]!.settings,
            token: "must-not-persist",
          },
        },
      ],
    };
    await expect(
      beginFounderBootstrap(
        poison,
        {
          organizationDisplayName: "EchoBrain",
          principalDisplayName: "Zhenye",
          slackUserId: "U123FOUNDER",
        },
        test.dependencies,
      ),
    ).rejects.toThrow(/settings.token is not supported/);

    const unsafe: ProductRuntimeConfig = {
      ...runtime,
      meeting_sources: [
        {
          ...runtime.meeting_sources[0]!,
          credential_ref: "env:GRANOLA_TOKEN",
        },
      ],
      delivery_surfaces: runtime.delivery_surfaces.map((surface) => ({
        ...surface,
        credential_ref: "env:SLACK_TOKEN",
      })),
      approval_surface: {
        ...approval,
        credential_ref: "env:SLACK_TOKEN",
      },
    };
    await expect(
      beginFounderBootstrap(
        unsafe,
        {
          organizationDisplayName: "EchoBrain",
          principalDisplayName: "Zhenye",
          slackUserId: "U123FOUNDER",
        },
        test.dependencies,
      ),
    ).rejects.toThrow(/requires managed file credentials/);
    expect(test.signer.generateCalls).toBe(0);
    expect(test.slack.authCalls).toBe(0);
    expect(test.granola.listCalls).toBe(0);
    expect(existsSync(join(stateDir, "bootstrap"))).toBe(false);
  });

  it("rechecks the seed-cutover authorization after a committing crash boundary", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    let gateCalls = 0;
    const dependencies: FounderBootstrapCeremonyDependencies = {
      ...test.dependencies,
      authorizeSeedCutover: async () => {
        gateCalls += 1;
        if (gateCalls > 1) throw new Error("seed gate became red");
      },
    };
    const begun = await beginFounderBootstrap(
      test.config,
      {
        organizationDisplayName: "EchoBrain",
        principalDisplayName: "Zhenye",
        slackUserId: "U123FOUNDER",
      },
      dependencies,
    );
    test.slack.reactionObserved = true;
    const ready = await statusFounderBootstrap(
      test.config,
      begun.session_id,
      {},
      dependencies,
    );

    await expect(
      commitFounderBootstrapCeremony(
        test.config,
        begun.session_id,
        ready.confirmation!.confirmation_sha256,
        dependencies,
      ),
    ).rejects.toThrow(/seed gate became red/);
    expect(gateCalls).toBe(2);
    expect(existsSync(join(stateDir, "identity"))).toBe(false);

    await expect(
      commitFounderBootstrapCeremony(
        test.config,
        begun.session_id,
        ready.confirmation!.confirmation_sha256,
        dependencies,
      ),
    ).rejects.toThrow(/seed gate became red/);
    expect(gateCalls).toBe(3);
    expect(existsSync(join(stateDir, "identity"))).toBe(false);
  });

  it("never reports a completed session when its active bundle is missing", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    const dependencies: FounderBootstrapCeremonyDependencies = {
      ...test.dependencies,
      // Test-only seam for the already separately tested immutable commit
      // mechanics. Product dependencies intentionally omit this until WS5.
      authorizeSeedCutover: async () => undefined,
    };
    const begun = await beginFounderBootstrap(
      test.config,
      {
        organizationDisplayName: "EchoBrain",
        principalDisplayName: "Zhenye",
        slackUserId: "U123FOUNDER",
      },
      dependencies,
    );
    test.slack.reactionObserved = true;
    const ready = await statusFounderBootstrap(
      test.config,
      begun.session_id,
      {},
      dependencies,
    );
    const completed = await commitFounderBootstrapCeremony(
      test.config,
      begun.session_id,
      ready.confirmation!.confirmation_sha256,
      dependencies,
    );
    expect(completed.phase).toBe("complete");
    expect(
      (
        await statusFounderBootstrap(
          test.config,
          begun.session_id,
          {},
          dependencies,
        )
      ).phase,
    ).toBe("complete");
    await expect(
      commitFounderBootstrapCeremony(
        test.config,
        begun.session_id,
        `sha256:${"0".repeat(64)}`,
        dependencies,
      ),
    ).rejects.toThrow(/confirmation digest does not match/);

    rmSync(join(stateDir, "identity", "active-identity-bundle.v1.json"));
    await expect(
      statusFounderBootstrap(test.config, begun.session_id, {}, dependencies),
    ).rejects.toThrow(/does not match the verified active identity bundle/);
  });

  it("fails without a protected signer before network or bootstrap state writes", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);

    await expect(
      beginFounderBootstrap(
        test.config,
        {
          organizationDisplayName: "EchoBrain",
          principalDisplayName: "Zhenye",
          slackUserId: "U123FOUNDER",
        },
        { ...test.dependencies, signer: undefined },
      ),
    ).rejects.toThrow(/signer_unavailable/);
    expect(test.slack.authCalls).toBe(0);
    expect(test.granola.listCalls).toBe(0);
    expect(existsSync(join(stateDir, "bootstrap"))).toBe(false);
    expect(existsSync(join(stateDir, "identity"))).toBe(false);
  });

  it("keeps the packaged CLI bootstrap disabled before the trusted signer lands", async () => {
    const stateDir = privateState();
    const runtime = config(stateDir);
    const configPath = join(stateDir, "runtime.json");
    writeFileSync(configPath, `${JSON.stringify(runtime)}\n`, { mode: 0o600 });
    let stdout = "";
    let stderr = "";

    const status = await runProductCli(
      [
        "identity-bootstrap",
        "begin",
        "--config",
        configPath,
        "--organization-name",
        "EchoBrain",
        "--principal-name",
        "Zhenye",
        "--slack-user-id",
        "U123FOUNDER",
      ],
      {
        classifyStateFilesystem: async () => ({
          kind: "local",
          raw: "apfs",
        }),
        stdout: {
          write: (value: string | Uint8Array) => (
            (stdout += value.toString()),
            true
          ),
        },
        stderr: {
          write: (value: string | Uint8Array) => (
            (stderr += value.toString()),
            true
          ),
        },
        now: () => NOW,
      },
    );

    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      ok: false,
      command: "identity-bootstrap",
      action: "begin",
      error: expect.stringContaining("signer_unavailable"),
    });
    expect(existsSync(join(stateDir, "bootstrap"))).toBe(false);
    expect(existsSync(join(stateDir, "identity"))).toBe(false);
  });
});
