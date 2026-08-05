import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { federationId } from "../../../src/product/federation/foundation/identifiers.js";
import {
  checkFounderIdentity,
  verifyActiveConnectionCredentialGuards,
} from "../../../src/product/federation/bootstrap/identity-check.js";
import { validateIdentityDocumentSemantics } from "../../../src/product/federation/identity/bundle-semantics.js";
import {
  createPrivateTestState,
  slackConnectionFixture,
  testBinding,
  testManifest,
  testPolicy,
  testRegistry,
} from "./fixtures/founder-identity.js";
import {
  GOLDEN_DUMMY_CREDENTIALS,
  goldenCredentialGuard,
} from "./fixtures/retired-founder-state.js";

const NOW = "2026-07-19T20:00:00.000Z";
const DIGEST = `sha256:${"1".repeat(64)}` as const;
const temporary: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function privateState(): string {
  return createPrivateTestState(temporary, "echo-identity-hardening-");
}

/**
 * The guard authoring API is deleted, so every guard here is the pinned golden
 * Slack guard rebound to a per-connection reference. The digest is not covered
 * by the reference, so the pinned salted digest keeps matching the one golden
 * dummy credential.
 */
const ENROLLED_CREDENTIAL =
  GOLDEN_DUMMY_CREDENTIALS["file:/private/slack-token"];

function slackConnection(
  organizationId: string,
  tenantId: string,
  reference: string,
) {
  return slackConnectionFixture({
    connectionId: federationId("con"),
    organizationId,
    activeAt: NOW,
    tenantId,
    evidenceSha256: DIGEST,
    credentialGuard: { ...goldenCredentialGuard("slack"), reference },
  });
}

function activeBinding(
  capability: "approval-surface" | "delivery-surface",
  adapterId: string,
  instanceId: string,
  connectionId: string,
) {
  return testBinding({
    adapterBindingId: federationId("bnd"),
    capability,
    adapterId,
    instanceId,
    connectionId,
    createdAt: NOW,
  });
}

function semanticFixture(claimTenant: string) {
  const ids = {
    organization: federationId("org"),
    principal: federationId("prn"),
    membership: federationId("mem"),
    device: federationId("dev"),
    installation: federationId("ins"),
    manifest: federationId("idm"),
    claim: federationId("clm"),
  };
  const approval = slackConnection(
    ids.organization,
    "T_APPROVAL",
    "file:/private/slack-approval-token",
  );
  const decoy = slackConnection(
    ids.organization,
    "T_DECOY",
    "file:/private/slack-decoy-token",
  );
  const manifest = testManifest({
    ids,
    at: NOW,
    claimTenant,
    claimSubject: "U_FOUNDER",
    key: {
      key_id: DIGEST,
      algorithm: "ecdsa-p256-sha256-der-low-s",
      public_key_spki_der_base64: "AQ==",
      protection: "secure-enclave",
      assurance: "hardware_bound",
    },
  });
  const registry = testRegistry({
    registryId: federationId("reg"),
    manifestId: ids.manifest,
    updatedAt: NOW,
    connections: [approval, decoy],
    bindings: [
      activeBinding(
        "approval-surface",
        "slack-reactions",
        "founder-approval",
        approval.connection_id,
      ),
      activeBinding(
        "delivery-surface",
        "slack",
        "decoy-delivery",
        decoy.connection_id,
      ),
    ],
  });
  const policy = testPolicy({
    policyId: federationId("pol"),
    organizationId: ids.organization,
    manifestId: ids.manifest,
    installationId: ids.installation,
    keyId: DIGEST,
    effectiveAt: NOW,
  });
  return { manifest, registry, policy };
}

describe("active connection credential continuity", () => {
  it("verifies every active generation and ignores retired generations", () => {
    const organizationId = federationId("org");
    const first = slackConnection(
      organizationId,
      "T_FIRST",
      "file:/private/first-token",
    );
    const second = slackConnection(
      organizationId,
      "T_SECOND",
      "file:/private/second-token",
    );
    const retired = slackConnection(
      organizationId,
      "T_RETIRED",
      "file:/private/retired-token",
    );
    retired.generations[0]!.ended_at = NOW;
    const credentials = new Map([
      ["file:/private/first-token", ENROLLED_CREDENTIAL],
      ["file:/private/second-token", ENROLLED_CREDENTIAL],
    ]);
    const resolver = vi.fn((reference: string) => credentials.get(reference));

    expect(
      verifyActiveConnectionCredentialGuards(
        { connections: [first, second, retired] },
        resolver,
      ),
    ).toEqual({
      ok: true,
      detail: "verified 2 active connection credential generations",
    });
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("fails closed for a missing, unreadable, or drifted current credential without leaking resolver errors", () => {
    const organizationId = federationId("org");
    const connection = slackConnection(
      organizationId,
      "T_APPROVAL",
      "file:/private/approval-token",
    );
    expect(
      verifyActiveConnectionCredentialGuards(
        { connections: [connection] },
        undefined,
      ),
    ).toMatchObject({ ok: false });
    expect(
      verifyActiveConnectionCredentialGuards(
        { connections: [connection] },
        () => undefined,
      ).detail,
    ).toMatch(/unavailable/);
    expect(
      verifyActiveConnectionCredentialGuards(
        { connections: [connection] },
        () => "replacement-token",
      ).detail,
    ).toMatch(/does not match/);
    const unreadable = verifyActiveConnectionCredentialGuards(
      { connections: [connection] },
      () => {
        throw new Error("must-not-leak-super-secret-token");
      },
    );
    expect(unreadable).toMatchObject({ ok: false });
    expect(unreadable.detail).toMatch(/unreadable/);
    expect(unreadable.detail).not.toContain("must-not-leak");
  });

  it("does not resolve credentials while identity is inactive", async () => {
    const resolver = vi.fn(() => {
      throw new Error("inactive rehearsal must not read credentials");
    });
    const report = await checkFounderIdentity(privateState(), {
      credentialResolver: resolver,
    });
    expect(report.mode).toBe("local_only_unattributed");
    expect(report.foundation_ok).toBe(true);
    expect(report.seed_grade_ready).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe("Slack human claim workspace semantics", () => {
  it("binds the claim to the active slack-reactions approval connection, not another Slack connection", () => {
    const mismatched = semanticFixture("T_DECOY");
    expect(() =>
      validateIdentityDocumentSemantics(
        mismatched.manifest,
        mismatched.registry,
        mismatched.policy,
      ),
    ).toThrow(/approval-surface connection name different workspaces/);

    const matched = semanticFixture("T_APPROVAL");
    expect(() =>
      validateIdentityDocumentSemantics(
        matched.manifest,
        matched.registry,
        matched.policy,
      ),
    ).not.toThrow();
  });

  it("rejects a Slack human claim without an active slack-reactions approval binding", () => {
    const fixture = semanticFixture("T_APPROVAL");
    fixture.registry.bindings = fixture.registry.bindings.filter(
      (binding) => binding.capability !== "approval-surface",
    );
    expect(() =>
      validateIdentityDocumentSemantics(
        fixture.manifest,
        fixture.registry,
        fixture.policy,
      ),
    ).toThrow(/requires exactly one active slack-reactions approval binding/);
  });
});

describe("decision-processor connection semantics", () => {
  it("rejects a local processor binding that carries a provider connection", () => {
    const fixture = semanticFixture("T_APPROVAL");
    fixture.registry.bindings = [
      ...fixture.registry.bindings,
      testBinding({
        adapterBindingId: federationId("bnd"),
        capability: "decision-processor",
        adapterId: "structured-text",
        instanceId: "primary",
        connectionId: fixture.registry.connections[0]!.connection_id,
        createdAt: NOW,
      }),
    ];

    expect(() =>
      validateIdentityDocumentSemantics(
        fixture.manifest,
        fixture.registry,
        fixture.policy,
      ),
    ).toThrow(/must not use a provider connection/);
  });

  it("rejects a hosted LLM before processor attribution carries connection evidence", () => {
    const fixture = semanticFixture("T_APPROVAL");
    fixture.registry.bindings = [
      ...fixture.registry.bindings,
      testBinding({
        adapterBindingId: federationId("bnd"),
        capability: "decision-processor",
        adapterId: "llm",
        instanceId: "openai-primary",
        connectionId: null,
        configuration: {
          provider: "openai",
          model: "gpt-test",
          prompt_version: "decision-extraction-v2",
          output_schema_version: "decision-extraction-schema-v2",
        },
        createdAt: NOW,
      }),
    ];

    expect(() =>
      validateIdentityDocumentSemantics(
        fixture.manifest,
        fixture.registry,
        fixture.policy,
      ),
    ).toThrow(
      /hosted LLM provider openai.*before connection-aware processor attribution/,
    );
  });
});

describe("publication audience identity semantics", () => {
  it("accepts an exact named membership subject", () => {
    const fixture = semanticFixture("T_APPROVAL");
    fixture.policy.publication.audience = {
      scope: "named-subjects",
      subjects: [
        {
          kind: "membership",
          id: fixture.manifest.membership.membership_id,
        },
      ],
    };

    expect(() =>
      validateIdentityDocumentSemantics(
        fixture.manifest,
        fixture.registry,
        fixture.policy,
      ),
    ).not.toThrow();
  });

  it.each([
    { kind: "membership" as const, idFrom: "organization" as const },
    { kind: "organization" as const, idFrom: "membership" as const },
  ])("rejects a $kind subject carrying the $idFrom ID", ({ kind, idFrom }) => {
    const fixture = semanticFixture("T_APPROVAL");
    fixture.policy.publication.audience = {
      scope: "named-subjects",
      subjects: [
        {
          kind,
          id:
            idFrom === "organization"
              ? fixture.manifest.organization.organization_id
              : fixture.manifest.membership.membership_id,
        },
      ],
    };

    expect(() =>
      validateIdentityDocumentSemantics(
        fixture.manifest,
        fixture.registry,
        fixture.policy,
      ),
    ).toThrow(/unknown local subject/);
  });
});
