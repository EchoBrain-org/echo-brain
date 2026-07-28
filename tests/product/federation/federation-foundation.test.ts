import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import { AdapterRegistry } from "../../../src/core/index.js";
import type { ProductRuntimeConfig } from "../../../src/product/config.js";
import { runProductCli } from "../../../src/product/cli.js";
import { prepareProductComposition } from "../../../src/product/composition.js";
import {
  canonicalJson,
  canonicalSha256,
} from "../../../src/product/federation/foundation/canonical-json.js";
import {
  commitFounderBootstrap,
  mintFounderBootstrapIds,
  planFounderBootstrap,
  type FounderBootstrapInput,
} from "../../../src/product/federation/bootstrap/bootstrap.js";
import type {
  AdapterBindingV1,
  PublicationSnapshotV1,
  ToolConnectionV1,
} from "../../../src/product/federation/contracts.js";
import {
  assertFounderIdentityAllowsPipeline,
  checkFounderIdentity,
} from "../../../src/product/federation/bootstrap/identity-check.js";
import { createLocalCredentialGuard } from "../../../src/product/federation/identity/credential-guard.js";
import { federationId } from "../../../src/product/federation/foundation/identifiers.js";
import { validateFederationDocument } from "../../../src/product/federation/schema-validation.js";
import {
  createPrivateTestState,
  manualRuntimeConfig,
  slackConnectionFixture,
  testBinding,
  TestHardwareSigner,
} from "./fixtures/founder-identity.js";

const temporary: string[] = [];
const NOW = "2026-07-19T20:10:00.000Z";
const REPO = resolve(import.meta.dirname, "../../..");

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const FakeHardwareSigner = TestHardwareSigner;

function privateState(): string {
  return createPrivateTestState(temporary, "echo-federation-foundation-");
}

function config(stateDir: string): ProductRuntimeConfig {
  return manualRuntimeConfig(stateDir);
}

function slackConnection(organizationId: string): ToolConnectionV1 {
  return slackConnectionFixture({
    connectionId: federationId("con"),
    organizationId,
    activeAt: NOW,
    tenantId: "T123",
    subject: { id: "U_BOT", bot_id: "B123", app_id: "A123" },
    evidenceSha256: `sha256:${"4".repeat(64)}`,
    credentialGuard: createLocalCredentialGuard(
      "file:/private/local/slack-bot-token",
      "slack-test-token",
      Buffer.alloc(16, 4),
    ),
  });
}

function binding(
  capability: AdapterBindingV1["capability"],
  adapterId: string,
  instanceId: string,
  connectionId: string | null,
): AdapterBindingV1 {
  return testBinding({
    adapterBindingId: federationId("bnd"),
    capability,
    adapterId,
    instanceId,
    connectionId,
    createdAt: NOW,
  });
}

function granolaConnection(
  organizationId: string,
  membershipId: string,
): ToolConnectionV1 {
  return {
    connection_id: federationId("con"),
    organization_id: organizationId,
    owner: { kind: "membership", id: membershipId },
    provider: "granola",
    generations: [
      {
        generation: 1,
        active_from: NOW,
        ended_at: null,
        provider_identity: {
          tenant: null,
          subject: null,
          verification: {
            method: "provider_first_capture",
            assurance: "credential_observed",
            verified_at: NOW,
            evidence_sha256: `sha256:${"1".repeat(64)}`,
          },
        },
        local_credential_guard: createLocalCredentialGuard(
          "file:/private/local/granola-api-key",
          "granola-test-token",
          Buffer.alloc(16, 2),
        ),
      },
    ],
  };
}

describe("federation wire schemas", () => {
  it("compiles every exact-key schema and forbids extras on every typed object", () => {
    const productSchemas = [
      "active-identity-bundle",
      "local-identity-manifest",
      "local-connection-registry",
      "publication-policy",
      "source-attribution",
      "processor-attribution",
      "approval-federation-metadata",
      "federated-record-envelope",
      "federated-export",
      "federated-recovery-report",
    ];
    const ajv = new Ajv({ strict: true, allErrors: true });
    ajv.addFormat("utc-millisecond-timestamp", {
      type: "string",
      validate: () => true,
    });
    const visit = (value: unknown, path: string): void => {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}/${index}`));
        return;
      }
      const record = value as Record<string, unknown>;
      if (record["type"] === "object") {
        expect(record["additionalProperties"], path).toBe(false);
      }
      for (const [key, item] of Object.entries(record))
        visit(item, `${path}/${key}`);
    };
    for (const name of productSchemas) {
      const schema = JSON.parse(
        readFileSync(
          join(REPO, "schemas", "product", `${name}.v1.schema.json`),
          "utf8",
        ),
      ) as object;
      expect(() => ajv.compile(schema), name).not.toThrow();
      visit(schema, name);
    }
  });

  it("represents CLI recovery approvals without claiming provider identity", () => {
    const ajv = new Ajv({ strict: true, allErrors: true });
    ajv.addFormat("utc-millisecond-timestamp", {
      type: "string",
      validate: () => true,
    });
    const schema = JSON.parse(
      readFileSync(
        join(
          REPO,
          "schemas",
          "product",
          "federated-record-envelope.v1.schema.json",
        ),
        "utf8",
      ),
    ) as object;
    ajv.compile(schema);
    const validateApproval = ajv.getSchema(
      "https://echo.local/schemas/product/federated-record-envelope.v1.schema.json#/definitions/approval",
    );
    expect(validateApproval).toBeDefined();
    const installationId = federationId("ins");
    const approval = {
      surface: null,
      approver: {
        principal_id: federationId("prn"),
        membership_id: federationId("mem"),
        claim_id: null,
      },
      raw_actor_assertion: {
        surface: "cli",
        installation_id: installationId,
        reviewer_label: "founder-recovery",
        command: "approve",
        observed_at: NOW,
      },
      assurance: "installation_holder_self_attested",
      reviewed_at: NOW,
      reason: "Recovery after provider outage",
      approved_brief_sha256: `sha256:${"2".repeat(64)}`,
      approved_context_sha256: `sha256:${"3".repeat(64)}`,
      observed_by: {
        product_version: "0.1.0-dev.6",
        source_sha: "4".repeat(40),
        artifact_sha256: `sha256:${"5".repeat(64)}`,
      },
    };
    expect(
      validateApproval!(approval),
      JSON.stringify(validateApproval!.errors),
    ).toBe(true);
    expect(
      validateApproval!({
        ...approval,
        assurance: "provider_verified",
      }),
    ).toBe(false);
  });
});

describe("Founder identity bundle foundation", () => {
  it("keeps a state directory without a pointer in disposable rehearsal mode", async () => {
    const report = await checkFounderIdentity(privateState());
    expect(report).toMatchObject({
      mode: "local_only_unattributed",
      foundation_ok: true,
      seed_grade_ready: false,
      organization_id: null,
      installation_id: null,
    });
  });

  it("keeps identity-check informational for rehearsal and strict only for cutover", async () => {
    const stateDir = privateState();
    const configPath = join(stateDir, "runtime.json");
    writeFileSync(configPath, `${JSON.stringify(config(stateDir))}\n`, {
      mode: 0o600,
    });
    let stdout = "";
    let stderr = "";
    const dependencies = {
      classifyStateFilesystem: async () => ({
        kind: "local" as const,
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
    };
    expect(
      await runProductCli(
        ["identity-check", "--config", configPath],
        dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      strict: false,
      mode: "local_only_unattributed",
      seed_grade_ready: false,
    });
    stdout = "";
    stderr = "";
    expect(
      await runProductCli(
        ["identity-check", "--config", configPath, "--strict"],
        dependencies,
      ),
    ).toBe(1);
    expect(JSON.parse(stderr)).toMatchObject({
      ok: false,
      strict: true,
      mode: "local_only_unattributed",
      seed_grade_ready: false,
    });
  });

  it("blocks runtime composition before adapter resolution when identity material is incomplete", async () => {
    const stateDir = privateState();
    const manifestDirectory = join(stateDir, "identity", "manifests");
    mkdirSync(manifestDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(manifestDirectory, "interrupted-bootstrap.json"), "{}", {
      mode: 0o600,
    });

    await expect(
      prepareProductComposition(config(stateDir), new AdapterRegistry(), {
        classifyStateFilesystem: async () => ({ kind: "local", raw: "apfs" }),
      }),
    ).rejects.toMatchObject({ code: "identity_not_operationally_ready" });
  });

  it("writes dependencies and pointer last, resumes them unchanged, and detects tampering", async () => {
    const stateDir = privateState();
    const runtime: ProductRuntimeConfig = {
      ...config(stateDir),
      approval_mode: "adapter",
      approval_surface: {
        adapter_id: "slack-reactions",
        instance_id: "founder-approval",
        credential_ref: "file:/private/local/slack-bot-token",
        settings: {},
      },
    };
    const ids = mintFounderBootstrapIds();
    const connection = granolaConnection(
      ids.organization_id,
      ids.membership_id,
    );
    const slack = slackConnection(ids.organization_id);
    const publication: PublicationSnapshotV1 = {
      payload_scope:
        "approved-signal-with-meeting-context-brief-digest-and-bounded-evidence",
      audience: {
        scope: "organization",
        subjects: [{ kind: "organization", id: ids.organization_id }],
      },
      sensitivity: "internal",
      retention: { kind: "indefinite" },
      raw_meeting_content: "local-only",
      participant_observations: "included-namespaced",
    };
    const bootstrapDependencies = {
      loadBuildIdentity: () => ({
        schema_version: 1 as const,
        kind: "echo-packaged-build-identity" as const,
        product_version: "0.1.0-dev.6",
        source_sha: "a".repeat(40),
        source_kind: "materialized-commit" as const,
      }),
    };
    const bootstrapInput = {
      ids,
      organization_display_name: "EchoBrain",
      principal_display_name: "Founder",
      device_class: "byod",
      created_at: NOW,
      identity_claims: [
        {
          claim_id: federationId("clm"),
          principal_id: ids.principal_id,
          issuer: { kind: "provider", provider: "slack", tenant_id: "T123" },
          subject: { kind: "user", id: "U123" },
          verification: {
            method: "slack_dm_challenge",
            assurance: "provider_challenge_observed",
            verified_at: NOW,
            evidence_sha256: `sha256:${"3".repeat(64)}`,
          },
        },
      ],
      connections: [connection, slack],
      bindings: [
        binding(
          "meeting-source",
          "granola",
          "primary",
          connection.connection_id,
        ),
        binding("decision-processor", "structured-text", "primary", null),
        binding("delivery-surface", "jsonl-outbox", "local", null),
        binding(
          "approval-surface",
          "slack-reactions",
          "founder-approval",
          slack.connection_id,
        ),
      ],
      publication,
    } satisfies FounderBootstrapInput;
    const unverifiedBuildSigner = new FakeHardwareSigner();
    const unverifiedBuildKey = await unverifiedBuildSigner.generate(
      ids.installation_id,
    );
    expect(() =>
      planFounderBootstrap(bootstrapInput, unverifiedBuildKey, {
        loadBuildIdentity: () => ({
          schema_version: 1,
          kind: "echo-packaged-build-identity",
          product_version: "0.1.0-dev.6",
          source_sha: "b".repeat(40),
          source_kind: "worktree-head-unverified",
        }),
      }),
    ).toThrow(/materialized commit/);
    const signer = new FakeHardwareSigner();
    const expectedSigningKey = await signer.generate(ids.installation_id);
    const plan = planFounderBootstrap(
      bootstrapInput,
      expectedSigningKey,
      bootstrapDependencies,
    );
    const opaqueConfiguration = { created_at: "provider-owned-label" };
    const schemaRegistry = {
      ...plan.registry,
      bindings: plan.registry.bindings.map((item, index) =>
        index === 0
          ? {
              ...item,
              configuration_snapshot: opaqueConfiguration,
              configuration_sha256: canonicalSha256(opaqueConfiguration),
            }
          : item,
      ),
      integrity: {
        canonicalization: "RFC8785",
        payload_sha256: `sha256:${"0".repeat(64)}`,
        signature_algorithm: "ecdsa-p256-sha256-der-low-s",
        key_id: `sha256:${"1".repeat(64)}`,
        signature_base64: "AA==",
      },
    } as const;
    expect(() =>
      validateFederationDocument("local-connection-registry", schemaRegistry),
    ).not.toThrow();
    expect(() =>
      validateFederationDocument("local-connection-registry", {
        ...schemaRegistry,
        updated_at: "2026-02-31T00:00:00.000Z",
      }),
    ).toThrow(/format/);
    const inconsistentState = privateState();
    await expect(
      commitFounderBootstrap(
        config(inconsistentState),
        {
          ...plan,
          ids: { ...plan.ids, registry_id: federationId("reg") },
        },
        new FakeHardwareSigner(),
        bootstrapDependencies,
      ),
    ).rejects.toThrow(/plan IDs do not match/);
    expect(existsSync(join(inconsistentState, "identity"))).toBe(false);
    const invalidSignerState = privateState();
    await expect(
      commitFounderBootstrap(
        { ...runtime, state_dir: invalidSignerState },
        plan,
        new FakeHardwareSigner({
          protection: "keychain-this-device-only",
          assurance: "platform_key_device_only",
        }),
        bootstrapDependencies,
      ),
    ).rejects.toThrow(/does not match/);
    const result = await commitFounderBootstrap(
      runtime,
      plan,
      signer,
      bootstrapDependencies,
    );

    expect(result.created_paths.at(-1)).toBe(
      join(stateDir, "identity", "active-identity-bundle.v1.json"),
    );
    expect(readFileSync(result.created_paths.at(-1)!, "utf8")).toBe(
      canonicalJson(result.active),
    );
    const ready = async () => ({ ok: true, detail: "ready" });
    const identityCheckDependencies = {
      signer,
      credentialResolver: (reference: string) =>
        reference === "file:/private/local/slack-bot-token"
          ? "slack-test-token"
          : reference === "file:/private/local/granola-api-key"
            ? "granola-test-token"
            : undefined,
      approvalCaptureReady: ready,
      attributionStorageReady: ready,
      signedOutboxReady: ready,
      independentCopyReady: ready,
    };
    const report = await checkFounderIdentity(
      stateDir,
      identityCheckDependencies,
    );
    expect(report.mode).toBe("identity_enabled");
    expect(report.foundation_ok).toBe(true);
    expect(report.seed_grade_ready).toBe(false);
    expect(
      report.checks.find((item) => item.id === "bundle-integrity")?.ok,
    ).toBe(true);
    expect(
      report.checks.find((item) => item.id === "seed-cutover"),
    ).toMatchObject({
      ok: false,
      detail: expect.stringContaining("no irreversible bootstrap receipt"),
    });
    expect(
      report.checks.find((item) => item.id === "installation-key")?.ok,
    ).toBe(true);
    const unavailableLegacySigner = {
      generate: (installationId: string) => signer.generate(installationId),
      inspect: async () => null,
      sign: (
        installationId: string,
        message: Buffer,
        expectedKeyId?: `sha256:${string}`,
      ) => signer.sign(installationId, message, expectedKeyId),
    };
    const legacyBackendMissing = await checkFounderIdentity(stateDir, {
      ...identityCheckDependencies,
      signer: unavailableLegacySigner,
    });
    expect(
      legacyBackendMissing.checks.find(
        (item) => item.id === "installation-key",
      ),
    ).toMatchObject({
      ok: false,
      detail: expect.stringContaining("unsupported_legacy_key_backend"),
    });
    expect(
      report.checks.find((item) => item.id === "provider-identities")?.ok,
    ).toBe(true);
    expect(
      report.checks.find((item) => item.id === "connection-credentials")?.ok,
    ).toBe(true);
    const driftedDependencies = {
      ...identityCheckDependencies,
      credentialResolver: (reference: string) =>
        reference === "file:/private/local/slack-bot-token"
          ? "rotated-slack-token"
          : identityCheckDependencies.credentialResolver(reference),
    };
    const driftedCredential = await checkFounderIdentity(
      stateDir,
      driftedDependencies,
    );
    expect(driftedCredential.foundation_ok).toBe(true);
    expect(driftedCredential.seed_grade_ready).toBe(false);
    expect(
      driftedCredential.checks.find(
        (item) => item.id === "connection-credentials",
      )?.detail,
    ).toMatch(/does not match/);
    await expect(
      assertFounderIdentityAllowsPipeline(stateDir, driftedDependencies),
    ).rejects.toMatchObject({ name: "FounderIdentityGateError" });
    const repeated = await commitFounderBootstrap(
      runtime,
      plan,
      signer,
      bootstrapDependencies,
    );
    expect(repeated.created_paths).toEqual([]);

    const pointerPath = join(
      stateDir,
      "identity",
      "active-identity-bundle.v1.json",
    );
    const manifestPath = result.created_paths.find((path) =>
      path.includes("/manifests/"),
    );
    const registryPath = result.created_paths.find((path) =>
      path.includes("/registries/"),
    );
    expect(manifestPath).toBeDefined();
    expect(registryPath).toBeDefined();
    const manifestBytes = readFileSync(manifestPath!, "utf8");

    // Simulate a crash after immutable dependencies were durable but before
    // the pointer became visible. ECDSA signatures are non-deterministic, so
    // retry must verify and reuse the prior bytes rather than re-signing them.
    unlinkSync(pointerPath);
    const interrupted = await checkFounderIdentity(
      stateDir,
      identityCheckDependencies,
    );
    expect(interrupted.mode).toBe("identity_enabled");
    expect(interrupted.foundation_ok).toBe(false);
    const resumed = await commitFounderBootstrap(
      runtime,
      plan,
      signer,
      bootstrapDependencies,
    );
    expect(resumed.created_paths).toEqual([pointerPath]);
    expect(readFileSync(manifestPath!, "utf8")).toBe(manifestBytes);
    expect(
      (await checkFounderIdentity(stateDir, identityCheckDependencies))
        .foundation_ok,
    ).toBe(true);

    writeFileSync(registryPath!, `${readFileSync(registryPath!, "utf8")} `, {
      mode: 0o600,
    });
    const tampered = await checkFounderIdentity(
      stateDir,
      identityCheckDependencies,
    );
    expect(tampered.mode).toBe("identity_enabled");
    expect(tampered.foundation_ok).toBe(false);
    expect(
      tampered.checks.find((item) => item.id === "bundle-integrity")?.ok,
    ).toBe(false);
  });
});
