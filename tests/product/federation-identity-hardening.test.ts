import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AdapterBindingV1,
  LocalConnectionRegistryV1,
  LocalIdentityManifestV1,
  PublicationPolicyV1,
  ToolConnectionV1,
} from "../../src/product/federation/contracts.js";
import { canonicalSha256 } from "../../src/product/federation/canonical-json.js";
import { federationId } from "../../src/product/federation/identifiers.js";
import {
  checkFounderIdentity,
  verifyActiveConnectionCredentialGuards,
} from "../../src/product/federation/identity-check.js";
import { createLocalCredentialGuard } from "../../src/product/federation/credential-guard.js";
import { validateIdentityDocumentSemantics } from "../../src/product/federation/bundle-semantics.js";

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
  const root = mkdtempSync(join(tmpdir(), "echo-identity-hardening-"));
  temporary.push(root);
  const state = join(realpathSync(root), "state");
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  return state;
}

function slackConnection(
  organizationId: string,
  tenantId: string,
  reference: string,
  credential: string,
): ToolConnectionV1 {
  return {
    connection_id: federationId("con"),
    organization_id: organizationId,
    owner: { kind: "organization", id: organizationId },
    provider: "slack",
    generations: [
      {
        generation: 1,
        active_from: NOW,
        ended_at: null,
        provider_identity: {
          tenant: { kind: "slack-team", id: tenantId, enterprise_id: null },
          subject: {
            kind: "bot-installation",
            id: `U_${tenantId}`,
            bot_id: `B_${tenantId}`,
            app_id: `A_${tenantId}`,
          },
          verification: {
            method: "slack_auth_test",
            assurance: "provider_verified",
            verified_at: NOW,
            evidence_sha256: DIGEST,
          },
        },
        local_credential_guard: createLocalCredentialGuard(
          reference,
          credential,
          Buffer.alloc(16, tenantId === "T_APPROVAL" ? 1 : 2),
        ),
      },
    ],
  };
}

function activeBinding(
  capability: AdapterBindingV1["capability"],
  adapterId: string,
  instanceId: string,
  connectionId: string,
): AdapterBindingV1 {
  return {
    adapter_binding_id: federationId("bnd"),
    capability,
    adapter_id: adapterId,
    instance_id: instanceId,
    connection_id: connectionId,
    connection_generation: 1,
    configuration_snapshot: {},
    configuration_sha256: canonicalSha256({}),
    created_at: NOW,
    ended_at: null,
    status: "active",
  };
}

function semanticFixture(claimTenant: string): {
  manifest: Omit<LocalIdentityManifestV1, "integrity">;
  registry: Omit<LocalConnectionRegistryV1, "integrity">;
  policy: Omit<PublicationPolicyV1, "integrity">;
} {
  const organizationId = federationId("org");
  const principalId = federationId("prn");
  const membershipId = federationId("mem");
  const installationId = federationId("ins");
  const manifestId = federationId("idm");
  const approval = slackConnection(
    organizationId,
    "T_APPROVAL",
    "file:/private/slack-approval-token",
    "approval-token",
  );
  const decoy = slackConnection(
    organizationId,
    "T_DECOY",
    "file:/private/slack-decoy-token",
    "decoy-token",
  );
  return {
    manifest: {
      schema_version: 1,
      kind: "echo-local-identity-manifest",
      manifest_id: manifestId,
      predecessor_manifest_id: null,
      created_at: NOW,
      authority: {
        kind: "local-founder-bootstrap",
        assurance: "founder_attested",
      },
      organization: {
        organization_id: organizationId,
        display_name: "EchoBrain",
        created_at: NOW,
      },
      principal: {
        principal_id: principalId,
        organization_id: organizationId,
        kind: "human",
        display_name: "Founder",
      },
      membership: {
        membership_id: membershipId,
        organization_id: organizationId,
        principal_id: principalId,
        type: "owner",
        status: "active",
        valid_from: NOW,
      },
      installation: {
        installation_id: installationId,
        organization_id: organizationId,
        membership_id: membershipId,
        device_id: federationId("dev"),
        device_class: "byod",
        enrolled_at: NOW,
        product: {
          name: "echo-brain",
          version: "0.1.0-dev.6",
          source_sha: "a".repeat(40),
        },
        signing_key: {
          key_id: DIGEST,
          algorithm: "ecdsa-p256-sha256-der-low-s",
          public_key_spki_der_base64: "AQ==",
          protection: "secure-enclave",
          assurance: "hardware_bound",
        },
      },
      identity_claims: [
        {
          claim_id: federationId("clm"),
          principal_id: principalId,
          issuer: {
            kind: "provider",
            provider: "slack",
            tenant_id: claimTenant,
          },
          subject: { kind: "user", id: "U_FOUNDER" },
          verification: {
            method: "slack_dm_challenge",
            assurance: "provider_challenge_observed",
            verified_at: NOW,
            evidence_sha256: DIGEST,
          },
        },
      ],
      legacy_cutover: {
        declared_at: NOW,
        pre_cutover_default: "disposable_test",
        native_records_require: [
          "source-attribution-v1",
          "processor-attribution-v1",
          "approval-context-v1",
          "signed-outbox-v1",
        ],
      },
    },
    registry: {
      schema_version: 1,
      kind: "echo-local-connection-registry",
      registry_id: federationId("reg"),
      identity_manifest_id: manifestId,
      revision: 1,
      previous_registry_sha256: null,
      updated_at: NOW,
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
    },
    policy: {
      schema_version: 1,
      kind: "echo-publication-policy",
      policy_id: federationId("pol"),
      organization_id: organizationId,
      identity_manifest_id: manifestId,
      issued_by: { installation_id: installationId, key_id: DIGEST },
      version: 1,
      effective_at: NOW,
      publication: {
        payload_scope:
          "approved-signal-with-meeting-context-brief-digest-and-bounded-evidence",
        audience: {
          scope: "organization",
          subjects: [{ kind: "organization", id: organizationId }],
        },
        sensitivity: "internal",
        retention: { kind: "indefinite" },
        raw_meeting_content: "local-only",
        participant_observations: "included-namespaced",
      },
    },
  };
}

describe("active connection credential continuity", () => {
  it("verifies every active generation and ignores retired generations", () => {
    const organizationId = federationId("org");
    const first = slackConnection(
      organizationId,
      "T_FIRST",
      "file:/private/first-token",
      "first-token",
    );
    const second = slackConnection(
      organizationId,
      "T_SECOND",
      "file:/private/second-token",
      "second-token",
    );
    const retired = slackConnection(
      organizationId,
      "T_RETIRED",
      "file:/private/retired-token",
      "retired-token",
    );
    retired.generations[0]!.ended_at = NOW;
    const credentials = new Map([
      ["file:/private/first-token", "first-token"],
      ["file:/private/second-token", "second-token"],
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
      "enrolled-token",
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
