import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import { AdapterRegistry } from "../../../src/core/index.js";
import type { ProductRuntimeConfig } from "../../../src/product/config.js";
import { runProductCli } from "../../../src/product/cli.js";
import { prepareProductComposition } from "../../../src/product/composition.js";
import { canonicalJson } from "../../../src/product/federation/foundation/canonical-json.js";
import {
  assertFounderIdentityAllowsPipeline,
  checkFounderIdentity,
} from "../../../src/product/federation/bootstrap/identity-check.js";
import { ActiveIdentityBundleStore } from "../../../src/product/federation/identity/active-identity-bundle-store.js";
import { federationId } from "../../../src/product/federation/foundation/identifiers.js";
import {
  createPrivateTestState,
  EXACT_SESSION_IDS,
  manualRuntimeConfig,
} from "./fixtures/founder-identity.js";
import {
  goldenCredentialResolver,
  goldenRuntimeConfig,
  installGoldenFounderState,
} from "./fixtures/retired-founder-state.js";

const temporary: string[] = [];
const NOW = "2026-07-19T20:10:00.000Z";
const REPO = resolve(import.meta.dirname, "../../..");

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function privateState(): string {
  return createPrivateTestState(temporary, "echo-federation-foundation-");
}

function config(stateDir: string): ProductRuntimeConfig {
  return manualRuntimeConfig(stateDir);
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

  it("loads the golden retired state, diagnoses it, and catches drift and tampering", async () => {
    const stateDir = privateState();
    installGoldenFounderState(stateDir);
    const runtimeConfig = goldenRuntimeConfig(stateDir);

    // The stored bundle still loads through the retained verified reader:
    // digests, signatures, semantics, and runtime-registry agreement.
    const store = new ActiveIdentityBundleStore(stateDir);
    const verified = store.loadVerified(runtimeConfig);
    expect(verified).not.toBeNull();
    expect(verified!.manifest.organization.organization_id).toBe(
      EXACT_SESSION_IDS.organization_id,
    );

    // The identity diagnostic reads the same residue end to end.
    const dependencies = {
      runtimeConfig,
      credentialResolver: goldenCredentialResolver(),
    };
    const report = await checkFounderIdentity(stateDir, dependencies);
    expect(report.mode).toBe("identity_enabled");
    expect(report.organization_id).toBe(EXACT_SESSION_IDS.organization_id);
    for (const id of [
      "active-bundle",
      "bundle-integrity",
      "seed-cutover",
      "provider-identities",
      "connection-credentials",
    ]) {
      expect(
        report.checks.find((item) => item.id === id),
        id,
      ).toMatchObject({ ok: true });
    }
    // Private-key continuity is intentionally not probed: this historical mode
    // is permanently refused, while its stored public signatures were verified
    // by the bundle and receipt readers above.
    expect(
      report.checks.find((item) => item.id === "installation-key"),
    ).toMatchObject({ ok: false });

    // Credential drift against the enrolled guard is caught without leaking.
    const drifted = await checkFounderIdentity(stateDir, {
      ...dependencies,
      credentialResolver: goldenCredentialResolver({
        "file:/private/slack-token": "rotated-slack-token",
      }),
    });
    expect(
      drifted.checks.find((item) => item.id === "connection-credentials")
        ?.detail,
    ).toMatch(/does not match/);

    // The pipeline gate and the retirement fence both refuse this profile.
    await expect(
      assertFounderIdentityAllowsPipeline(stateDir, dependencies),
    ).rejects.toMatchObject({ name: "FounderIdentityGateError" });
    await expect(
      prepareProductComposition(runtimeConfig, new AdapterRegistry(), {
        classifyStateFilesystem: async () => ({ kind: "local", raw: "apfs" }),
      }),
    ).rejects.toMatchObject({ code: "identity_not_operationally_ready" });

    // Tampering with a stored dependency document breaks bundle integrity.
    const registryPath = join(
      stateDir,
      "identity",
      "registries",
      `connection-registry.${EXACT_SESSION_IDS.registry_id}.r1.v1.json`,
    );
    writeFileSync(registryPath, `${readFileSync(registryPath, "utf8")} `, {
      mode: 0o600,
    });
    const tampered = await checkFounderIdentity(stateDir, dependencies);
    expect(tampered.mode).toBe("identity_enabled");
    expect(tampered.foundation_ok).toBe(false);
    expect(
      tampered.checks.find((item) => item.id === "bundle-integrity")?.ok,
    ).toBe(false);
  });

  it("rejects a re-signed-free mutation of the active pointer", async () => {
    const stateDir = privateState();
    installGoldenFounderState(stateDir);
    const pointerPath = join(
      stateDir,
      "identity",
      "active-identity-bundle.v1.json",
    );
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as Record<
      string,
      unknown
    >;
    pointer["activated_at"] = "2026-07-19T23:59:00.000Z";
    writeFileSync(pointerPath, canonicalJson(pointer), { mode: 0o600 });

    const store = new ActiveIdentityBundleStore(stateDir);
    expect(() => store.loadVerified()).toThrow(
      /signature|digest does not match/i,
    );
    const report = await checkFounderIdentity(stateDir);
    expect(report.foundation_ok).toBe(false);
    expect(
      report.checks.find((item) => item.id === "bundle-integrity")?.ok,
    ).toBe(false);
  });
});
