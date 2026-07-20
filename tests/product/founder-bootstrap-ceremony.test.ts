import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LLM_DECISION_PROCESSOR_PROMPT_VERSION } from "../../src/adapters/decision-processors/llm/llm-decision-processor.js";
import type { ProductRuntimeConfig } from "../../src/product/config.js";
import { runProductCli } from "../../src/product/cli.js";
import { DecisionNodeStore } from "../../src/product/approval/decision-node-store.js";
import { resolveProductStatePaths } from "../../src/product/paths.js";
import {
  createProductStateBackup,
  restoreProductStateBackup,
} from "../../src/product/state-backup.js";
import { canonicalProductConfigSha256 } from "../../src/product/lifecycle-lock.js";
import {
  abortFounderBootstrap,
  beginFounderBootstrap,
  commitFounderBootstrapCeremony,
  statusFounderBootstrap,
  type FounderBootstrapCeremonyDependencies,
} from "../../src/product/federation/bootstrap/founder-bootstrap-ceremony.js";
import { ActiveIdentityBundleStore } from "../../src/product/federation/identity/active-identity-bundle-store.js";
import { checkFounderIdentity } from "../../src/product/federation/bootstrap/identity-check.js";
import { FounderBootstrapSessionStore } from "../../src/product/federation/bootstrap/bootstrap-session-store.js";
import {
  assertFounderCutoverReceiptMatchesActiveBundle,
  founderCutoverGuardPath,
  inspectFounderCutoverFence,
  readFounderCutoverGuard,
  requiresFounderFederation,
} from "../../src/product/federation/cutover-fence.js";
import {
  canonicalJson,
  canonicalSha256,
} from "../../src/product/federation/foundation/canonical-json.js";
import {
  commitLegacyClassificationReport,
  recoverLegacyClassificationCutoverAt,
} from "../../src/product/federation/legacy-classification.js";
import { createSignedDocument } from "../../src/product/federation/foundation/signed-document.js";
import {
  createPrivateTestState,
  founderCeremonyFixture,
  founderRuntimeConfig,
} from "./fixtures/founder-identity.js";

const NOW = "2026-07-19T23:00:00.000Z";
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function privateState(): string {
  return createPrivateTestState(temporary, "echo-founder-bootstrap-");
}

function config(stateDir: string): ProductRuntimeConfig {
  return founderRuntimeConfig(stateDir);
}

function fixture(stateDir: string) {
  return founderCeremonyFixture(stateDir, NOW);
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

  it("recovers the exact legacy cutover plan after authorization is durable but the session transition crashes", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    let clock = NOW;
    let crashAfterReport = true;
    const decisionNodes = new DecisionNodeStore(stateDir, {
      now: () => clock,
    });
    const dependencies: FounderBootstrapCeremonyDependencies = {
      ...test.dependencies,
      now: () => clock,
      recoverSeedCutoverConfirmedAt: async ({ config, session }) =>
        recoverLegacyClassificationCutoverAt({
          state_directory: config.state_dir,
          bootstrap_session_id: session.session_id,
        }),
      authorizeSeedCutover: async ({ config, session, plan }) => {
        await commitLegacyClassificationReport({
          state_directory: config.state_dir,
          bootstrap_session_id: session.session_id,
          decision_nodes: decisionNodes,
          core_database_path: resolveProductStatePaths(config.state_dir)
            .database,
          cutover_at: plan.manifest.legacy_cutover.declared_at,
        });
        if (crashAfterReport) {
          crashAfterReport = false;
          throw new Error("simulated crash after durable legacy report");
        }
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

    const firstCommitAt = "2026-07-19T23:01:00.000Z";
    clock = firstCommitAt;
    await expect(
      commitFounderBootstrapCeremony(
        test.config,
        begun.session_id,
        ready.confirmation!.confirmation_sha256,
        dependencies,
      ),
    ).rejects.toThrow(/simulated crash after durable legacy report/);
    expect(
      new FounderBootstrapSessionStore(stateDir).read(begun.session_id).phase,
    ).toBe("ready_for_confirmation");
    expect(
      recoverLegacyClassificationCutoverAt({
        state_directory: stateDir,
        bootstrap_session_id: begun.session_id,
      }),
    ).toBe(firstCommitAt);

    clock = "2026-07-19T23:02:00.000Z";
    const completed = await commitFounderBootstrapCeremony(
      test.config,
      begun.session_id,
      ready.confirmation!.confirmation_sha256,
      dependencies,
    );
    expect(completed.phase).toBe("complete");
    const session = new FounderBootstrapSessionStore(stateDir).read(
      begun.session_id,
    );
    expect(session.commit!.confirmed_at).toBe(firstCommitAt);
    expect(session.commit!.plan.manifest.legacy_cutover.declared_at).toBe(
      firstCommitAt,
    );
  });

  it("writes the external fail-closed guard before the committing transition", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    const dependencies: FounderBootstrapCeremonyDependencies = {
      ...test.dependencies,
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
    const originalSign = test.signer.sign.bind(test.signer);
    let crashAfterGuard = true;
    test.signer.sign = async (...args) => {
      if (crashAfterGuard && readFounderCutoverGuard(stateDir) !== null) {
        crashAfterGuard = false;
        throw new Error("simulated crash after external guard");
      }
      return await originalSign(...args);
    };

    await expect(
      commitFounderBootstrapCeremony(
        test.config,
        begun.session_id,
        ready.confirmation!.confirmation_sha256,
        dependencies,
      ),
    ).rejects.toThrow(/simulated crash after external guard/);
    expect(
      new FounderBootstrapSessionStore(stateDir).read(begun.session_id).phase,
    ).toBe("ready_for_confirmation");
    expect(readFounderCutoverGuard(stateDir)).toMatchObject({
      session_id: begun.session_id,
    });
    expect(requiresFounderFederation(stateDir)).toBe(true);
    await expect(checkFounderIdentity(stateDir)).resolves.toMatchObject({
      mode: "identity_enabled",
      foundation_ok: false,
      seed_grade_ready: false,
    });
    await expect(
      abortFounderBootstrap(
        test.config,
        begun.session_id,
        new FounderBootstrapSessionStore(stateDir).read(begun.session_id)
          .signing_key!.key_id,
        dependencies,
      ),
    ).rejects.toThrow(/identity material/);
    await expect(
      beginFounderBootstrap(
        test.config,
        {
          organizationDisplayName: "Other",
          principalDisplayName: "Other",
          slackUserId: "UOTHER",
        },
        dependencies,
      ),
    ).rejects.toThrow(/identity material/);

    await expect(
      commitFounderBootstrapCeremony(
        test.config,
        begun.session_id,
        ready.confirmation!.confirmation_sha256,
        dependencies,
      ),
    ).resolves.toMatchObject({ phase: "complete" });

    const slackCalls = test.slack.authCalls;
    rmSync(stateDir, { recursive: true });
    mkdirSync(stateDir, { mode: 0o700 });
    expect(requiresFounderFederation(stateDir)).toBe(true);
    await expect(
      beginFounderBootstrap(
        test.config,
        {
          organizationDisplayName: "Replacement",
          principalDisplayName: "Replacement",
          slackUserId: "UREPLACEMENT",
        },
        dependencies,
      ),
    ).rejects.toThrow(/identity material/);
    expect(test.slack.authCalls).toBe(slackCalls);
  });

  it("keeps an active cutover in committing until post-activation verification succeeds", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    let finalizationCalls = 0;
    const dependencies: FounderBootstrapCeremonyDependencies = {
      ...test.dependencies,
      authorizeSeedCutover: async () => undefined,
      finalizeSeedCutover: async ({ result, session }) => {
        finalizationCalls += 1;
        expect(result.manifest.installation.installation_id).toBe(
          session.request.ids.installation_id,
        );
        if (finalizationCalls === 1) {
          throw new Error("independent copy verification failed");
        }
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
    ).rejects.toThrow(/independent copy verification failed/);
    expect(
      new FounderBootstrapSessionStore(stateDir).read(begun.session_id).phase,
    ).toBe("committing");
    expect(
      existsSync(join(stateDir, "identity", "active-identity-bundle.v1.json")),
    ).toBe(true);

    await expect(
      commitFounderBootstrapCeremony(
        test.config,
        begun.session_id,
        ready.confirmation!.confirmation_sha256,
        dependencies,
      ),
    ).resolves.toMatchObject({ phase: "complete" });
    expect(finalizationCalls).toBe(2);
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

  it("requires a protected independent-copy target before production commit", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    const configPath = join(stateDir, "runtime.json");
    writeFileSync(configPath, `${JSON.stringify(test.config)}\n`, {
      mode: 0o600,
    });
    let stdout = "";
    let stderr = "";

    const status = await runProductCli(
      [
        "identity-bootstrap",
        "commit",
        "--config",
        configPath,
        "--session",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "--confirm",
        `sha256:${"1".repeat(64)}`,
      ],
      {
        founderBootstrap: test.dependencies,
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
      },
    );

    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      ok: false,
      command: "identity-bootstrap",
      action: "commit",
      error: expect.stringContaining("--independent-copy-root"),
    });
    expect(existsSync(join(stateDir, "identity"))).toBe(false);
  });
});

describe("founder seed cutover fence", () => {
  it("keeps precommit enrollment in rehearsal and complete enrollment fenced after identity loss", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    const dependencies: FounderBootstrapCeremonyDependencies = {
      ...test.dependencies,
      authorizeSeedCutover: async () => undefined,
    };

    expect(inspectFounderCutoverFence(stateDir)).toEqual({
      state: "none",
      session: null,
    });
    const begun = await beginFounderBootstrap(
      test.config,
      {
        organizationDisplayName: "EchoBrain",
        principalDisplayName: "Zhenye",
        slackUserId: "U123FOUNDER",
      },
      dependencies,
    );
    expect(inspectFounderCutoverFence(stateDir).state).toBe("precommit");
    expect(requiresFounderFederation(stateDir)).toBe(false);

    test.slack.reactionObserved = true;
    const ready = await statusFounderBootstrap(
      test.config,
      begun.session_id,
      {},
      dependencies,
    );
    expect(inspectFounderCutoverFence(stateDir).state).toBe("precommit");
    await commitFounderBootstrapCeremony(
      test.config,
      begun.session_id,
      ready.confirmation!.confirmation_sha256,
      dependencies,
    );

    const activeStore = new ActiveIdentityBundleStore(stateDir);
    const active = activeStore.loadVerified(test.config)!;
    expect(inspectFounderCutoverFence(stateDir).state).toBe("complete");
    expect(requiresFounderFederation(stateDir)).toBe(true);
    expect(
      assertFounderCutoverReceiptMatchesActiveBundle(stateDir, active).phase,
    ).toBe("complete");
    expect(() =>
      assertFounderCutoverReceiptMatchesActiveBundle(
        stateDir,
        active,
        {},
        { list: () => [] },
      ),
    ).toThrow(/no irreversible bootstrap receipt/);
    expect(() =>
      assertFounderCutoverReceiptMatchesActiveBundle(stateDir, {
        ...active,
        pointer: {
          ...active.pointer,
          activated_at: "2026-07-19T23:00:00.001Z",
        },
      }),
    ).toThrow(/does not match the active identity pointer/);

    rmSync(join(stateDir, "identity"), { recursive: true, force: true });
    expect(requiresFounderFederation(stateDir)).toBe(true);
    const identityCheck = await checkFounderIdentity(stateDir);
    expect(identityCheck).toMatchObject({
      mode: "identity_enabled",
      foundation_ok: false,
      seed_grade_ready: false,
    });
    expect(
      identityCheck.checks.find((item) => item.id === "active-bundle"),
    ).toMatchObject({
      ok: false,
      detail: expect.stringContaining("irreversible founder cutover"),
    });
  });

  it("rejects a pre-cutover restore even when the adjacent guard is missing", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    const backupRoot = join(dirname(stateDir), "backups");
    const configSha256 = canonicalProductConfigSha256(test.config);
    const preCutover = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: "pre-founder-cutover",
      createdAt: "2026-07-19T22:58:00.000Z",
      canonicalConfigSha256: configSha256,
    });
    const dependencies: FounderBootstrapCeremonyDependencies = {
      ...test.dependencies,
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
    await commitFounderBootstrapCeremony(
      test.config,
      begun.session_id,
      ready.confirmation!.confirmation_sha256,
      dependencies,
    );
    const recoverySentinel = join(stateDir, "identity-recovery-sentinel.txt");
    writeFileSync(recoverySentinel, "trusted\n", { mode: 0o600 });
    const activeBackup = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: "active-founder-cutover",
      createdAt: "2026-07-19T23:01:00.000Z",
      canonicalConfigSha256: configSha256,
    });
    writeFileSync(recoverySentinel, "mutated\n", { mode: 0o600 });
    await restoreProductStateBackup({
      stateDir,
      backupDirectory: activeBackup.backupDirectory,
      automaticBackupRoot: backupRoot,
      operationId: "restore-matching-founder-cutover",
      restoredAt: "2026-07-19T23:03:00.000Z",
      preRestoreBackupId: "pre-restore-matching-founder-cutover",
      preRestoreBackupCreatedAt: "2026-07-19T23:02:00.000Z",
      canonicalConfigSha256: configSha256,
    });
    expect(readFileSync(recoverySentinel, "utf8")).toBe("trusted\n");
    rmSync(founderCutoverGuardPath(stateDir));

    await expect(
      restoreProductStateBackup({
        stateDir,
        backupDirectory: preCutover.backupDirectory,
        automaticBackupRoot: backupRoot,
        operationId: "reject-missing-guard-downgrade",
        restoredAt: "2026-07-19T23:05:00.000Z",
        preRestoreBackupId: "must-not-create-missing-guard-pre-backup",
        preRestoreBackupCreatedAt: "2026-07-19T23:04:00.000Z",
        canonicalConfigSha256: configSha256,
      }),
    ).rejects.toThrow(/irreversible founder identity cutover/);
    expect(
      new FounderBootstrapSessionStore(stateDir).read(begun.session_id).phase,
    ).toBe("complete");

    const sessionPath = join(
      resolveProductStatePaths(stateDir).bootstrapRoot,
      "founder-identity",
      `session.${begun.session_id}.v1.json`,
    );
    writeFileSync(sessionPath, "{}", { mode: 0o600 });
    await expect(
      restoreProductStateBackup({
        stateDir,
        backupDirectory: preCutover.backupDirectory,
        automaticBackupRoot: backupRoot,
        operationId: "reject-malformed-fence-downgrade",
        restoredAt: "2026-07-19T23:07:00.000Z",
        preRestoreBackupId: "must-not-create-malformed-pre-backup",
        preRestoreBackupCreatedAt: "2026-07-19T23:06:00.000Z",
        canonicalConfigSha256: configSha256,
      }),
    ).rejects.toThrow(/bootstrap session|canonical|shape|signature/i);
  });

  it("accepts committing only for explicit crash finalization", async () => {
    const stateDir = privateState();
    const test = fixture(stateDir);
    const dependencies: FounderBootstrapCeremonyDependencies = {
      ...test.dependencies,
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
    const originalSign = test.signer.sign.bind(test.signer);
    let failCompletion = true;
    test.signer.sign = async (...args) => {
      if (
        failCompletion &&
        existsSync(join(stateDir, "identity", "active-identity-bundle.v1.json"))
      ) {
        failCompletion = false;
        throw new Error("simulated crash before complete receipt");
      }
      return await originalSign(...args);
    };

    await expect(
      commitFounderBootstrapCeremony(
        test.config,
        begun.session_id,
        ready.confirmation!.confirmation_sha256,
        dependencies,
      ),
    ).rejects.toThrow(/simulated crash before complete receipt/);
    expect(inspectFounderCutoverFence(stateDir).state).toBe("committing");
    expect(requiresFounderFederation(stateDir)).toBe(true);
    const active = new ActiveIdentityBundleStore(stateDir).loadVerified(
      test.config,
    )!;
    expect(() =>
      assertFounderCutoverReceiptMatchesActiveBundle(stateDir, active),
    ).toThrow(/must be finalized/);
    expect(
      assertFounderCutoverReceiptMatchesActiveBundle(stateDir, active, {
        allowCommittingFinalization: true,
      }).phase,
    ).toBe("committing");

    await commitFounderBootstrapCeremony(
      test.config,
      begun.session_id,
      ready.confirmation!.confirmation_sha256,
      dependencies,
    );
    expect(inspectFounderCutoverFence(stateDir).state).toBe("complete");
  });

  it("fails closed on malformed or multiple irreversible receipts", async () => {
    const malformedState = privateState();
    const malformedDirectory = join(
      malformedState,
      "bootstrap",
      "founder-identity",
    );
    mkdirSync(malformedDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(
        malformedDirectory,
        "session.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.v1.json",
      ),
      "{}",
      { mode: 0o600 },
    );
    expect(() => inspectFounderCutoverFence(malformedState)).toThrow();
    expect(() => requiresFounderFederation(malformedState)).toThrow();

    const stateDir = privateState();
    const test = fixture(stateDir);
    const dependencies: FounderBootstrapCeremonyDependencies = {
      ...test.dependencies,
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
    await commitFounderBootstrapCeremony(
      test.config,
      begun.session_id,
      ready.confirmation!.confirmation_sha256,
      dependencies,
    );
    const store = new FounderBootstrapSessionStore(stateDir);
    const existing = store.read(begun.session_id);
    const { integrity: _integrity, ...payload } = existing;
    const duplicate = await createSignedDocument(
      {
        ...payload,
        session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        revision: 1,
      },
      test.signer,
      existing.signing_key!.installation_id,
      existing.signing_key!.key_id,
    );
    store.write(duplicate);
    expect(() => inspectFounderCutoverFence(stateDir)).toThrow(
      /multiple irreversible bootstrap sessions/,
    );
    expect(() => requiresFounderFederation(stateDir)).toThrow(
      /multiple irreversible bootstrap sessions/,
    );
  });
});
