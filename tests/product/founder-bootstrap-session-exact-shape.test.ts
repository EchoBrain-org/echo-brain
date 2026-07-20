import { describe, expect, it } from "vitest";
import { assertExactFounderBootstrapSessionShape } from "../../src/product/federation/bootstrap-session-exact-shape.js";

type JsonRecord = Record<string, unknown>;

const AT = "2026-07-19T23:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

const IDS = {
  organization_id: "org_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  principal_id: "prn_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  membership_id: "mem_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  device_id: "dev_dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  installation_id: "ins_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  manifest_id: "idm_11111111-1111-4111-8111-111111111111",
  registry_id: "reg_22222222-2222-4222-8222-222222222222",
  policy_id: "pol_33333333-3333-4333-8333-333333333333",
};

function credentialGuard(reference: string): JsonRecord {
  return {
    reference,
    algorithm: "sha256-salted",
    salt_base64: "c2FsdC1zYWx0LXNhbHQ=",
    digest: DIGEST,
    exportable: false,
  };
}

function publication(): JsonRecord {
  return {
    payload_scope:
      "approved-signal-with-meeting-context-brief-digest-and-bounded-evidence",
    audience: {
      scope: "organization",
      subjects: [{ kind: "organization", id: IDS.organization_id }],
    },
    sensitivity: "internal",
    retention: { kind: "indefinite" },
    raw_meeting_content: "local-only",
    participant_observations: "included-namespaced",
  };
}

function slackProviderIdentity(): JsonRecord {
  return {
    tenant: {
      kind: "slack-team",
      id: "T123TEAM",
      enterprise_id: null,
    },
    subject: {
      kind: "bot-installation",
      id: "U123BOT",
      bot_id: "B123BOT",
      app_id: "A123APP",
    },
    verification: {
      method: "slack_auth_test",
      assurance: "provider_verified",
      verified_at: AT,
      evidence_sha256: DIGEST,
    },
  };
}

function granolaProviderIdentity(): JsonRecord {
  return {
    tenant: null,
    subject: null,
    verification: {
      method: "provider_first_capture",
      assurance: "credential_observed",
      verified_at: AT,
      evidence_sha256: DIGEST,
    },
  };
}

function fullBindings(at = AT): JsonRecord[] {
  return [
    {
      adapter_binding_id: "bnd_11111111-1111-4111-8111-111111111111",
      capability: "meeting-source",
      adapter_id: "granola",
      instance_id: "primary",
      connection_id: "con_11111111-1111-4111-8111-111111111111",
      connection_generation: 1,
      configuration_snapshot: {
        base_url: "https://api.granola.test/v1",
        request_timeout_ms: 15_000,
        page_size: 1,
        cursor_overlap_ms: 0,
      },
      configuration_sha256: DIGEST,
      created_at: at,
      ended_at: null,
      status: "active",
    },
    {
      adapter_binding_id: "bnd_22222222-2222-4222-8222-222222222222",
      capability: "decision-processor",
      adapter_id: "structured-text",
      instance_id: "primary",
      connection_id: null,
      connection_generation: null,
      configuration_snapshot: {},
      configuration_sha256: DIGEST,
      created_at: at,
      ended_at: null,
      status: "active",
    },
    {
      adapter_binding_id: "bnd_33333333-3333-4333-8333-333333333333",
      capability: "delivery-surface",
      adapter_id: "slack",
      instance_id: "team-decisions",
      connection_id: "con_11111111-1111-4111-8111-111111111111",
      connection_generation: 1,
      configuration_snapshot: {
        channel_id: "C123DECISIONS",
        request_timeout_ms: 60_000,
      },
      configuration_sha256: DIGEST,
      created_at: at,
      ended_at: null,
      status: "active",
    },
    {
      adapter_binding_id: "bnd_44444444-4444-4444-8444-444444444444",
      capability: "approval-surface",
      adapter_id: "slack-reactions",
      instance_id: "founder-approval",
      connection_id: "con_11111111-1111-4111-8111-111111111111",
      connection_generation: 1,
      configuration_snapshot: {
        channel_id: "C123APPROVALS",
        reviewer: {
          slack_user_id: "U123FOUNDER",
          name: "Founder",
        },
        approve_reaction: "white_check_mark",
        reject_reaction: "x",
        request_timeout_ms: 60_000,
      },
      configuration_sha256: DIGEST,
      created_at: at,
      ended_at: null,
      status: "active",
    },
  ];
}

function bindingSummaries(): JsonRecord[] {
  return fullBindings().map(
    ({
      created_at: _createdAt,
      ended_at: _endedAt,
      status: _status,
      ...item
    }) => item,
  );
}

function signingKey(): JsonRecord {
  return {
    installation_id: IDS.installation_id,
    key_id: DIGEST,
    algorithm: "ecdsa-p256-sha256-der-low-s",
    public_key_spki_der_base64: "cHVibGljLWtleQ==",
    protection: "secure-enclave",
    assurance: "hardware_bound",
    private_key_exportable: false,
  };
}

function slackClaimAssertion(): JsonRecord {
  return {
    issuer: {
      kind: "provider",
      provider: "slack",
      tenant_id: "T123TEAM",
    },
    subject: { kind: "user", id: "U123FOUNDER" },
    verification: {
      method: "slack_dm_challenge",
      assurance: "provider_challenge_observed",
      verified_at: AT,
      evidence_sha256: DIGEST,
    },
  };
}

function plan(): JsonRecord {
  const bindings = fullBindings();
  return {
    ids: { ...IDS },
    expected_signing_key: signingKey(),
    manifest: {
      schema_version: 1,
      kind: "echo-local-identity-manifest",
      manifest_id: IDS.manifest_id,
      predecessor_manifest_id: null,
      created_at: AT,
      authority: {
        kind: "local-founder-bootstrap",
        assurance: "founder_attested",
      },
      organization: {
        organization_id: IDS.organization_id,
        display_name: "Echo",
        created_at: AT,
      },
      principal: {
        principal_id: IDS.principal_id,
        organization_id: IDS.organization_id,
        kind: "human",
        display_name: "Founder",
      },
      membership: {
        membership_id: IDS.membership_id,
        organization_id: IDS.organization_id,
        principal_id: IDS.principal_id,
        type: "owner",
        status: "active",
        valid_from: AT,
      },
      installation: {
        installation_id: IDS.installation_id,
        organization_id: IDS.organization_id,
        membership_id: IDS.membership_id,
        device_id: IDS.device_id,
        device_class: "byod",
        enrolled_at: AT,
        product: {
          name: "echo-brain",
          version: "0.1.0-dev.6",
          source_sha: "a".repeat(40),
        },
      },
      identity_claims: [
        {
          claim_id: "clm_11111111-1111-4111-8111-111111111111",
          principal_id: IDS.principal_id,
          ...slackClaimAssertion(),
        },
      ],
      legacy_cutover: {
        declared_at: AT,
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
      registry_id: IDS.registry_id,
      identity_manifest_id: IDS.manifest_id,
      revision: 1,
      previous_registry_sha256: null,
      updated_at: AT,
      connections: [
        {
          connection_id: "con_11111111-1111-4111-8111-111111111111",
          organization_id: IDS.organization_id,
          owner: { kind: "organization", id: IDS.organization_id },
          provider: "slack",
          generations: [
            {
              generation: 1,
              active_from: AT,
              ended_at: null,
              provider_identity: slackProviderIdentity(),
              local_credential_guard: credentialGuard(
                "file:/private/slack-token",
              ),
            },
          ],
        },
        {
          connection_id: "con_22222222-2222-4222-8222-222222222222",
          organization_id: IDS.organization_id,
          owner: { kind: "membership", id: IDS.membership_id },
          provider: "granola",
          generations: [
            {
              generation: 1,
              active_from: AT,
              ended_at: null,
              provider_identity: granolaProviderIdentity(),
              local_credential_guard: credentialGuard(
                "file:/private/granola-token",
              ),
            },
          ],
        },
      ],
      bindings,
    },
    policy: {
      schema_version: 1,
      kind: "echo-publication-policy",
      policy_id: IDS.policy_id,
      organization_id: IDS.organization_id,
      identity_manifest_id: IDS.manifest_id,
      version: 1,
      effective_at: AT,
      publication: publication(),
    },
  };
}

function completeSession(): JsonRecord {
  const challenge = {
    schema_version: 1,
    kind: "echo-slack-dm-challenge-ticket",
    provider: "slack",
    tenant_id: "T123TEAM",
    enterprise_id: null,
    subject_id: "U123FOUNDER",
    bot_user_id: "U123BOT",
    bot_id: "B123BOT",
    app_id: "A123APP",
    auth_test_evidence_sha256: DIGEST,
    channel_id: "D123FOUNDER",
    message_ts: "1752966000.000001",
    reaction_name: "white_check_mark",
    challenge_sha256: DIGEST,
    issued_at: AT,
    expires_at: AT,
  };
  return {
    schema_version: 1,
    kind: "echo-founder-bootstrap-session",
    session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    revision: 6,
    phase: "complete",
    request: {
      config_sha256: DIGEST,
      build: {
        schema_version: 1,
        kind: "echo-packaged-build-identity",
        product_version: "0.1.0-dev.6",
        source_sha: "a".repeat(40),
        source_kind: "materialized-commit",
      },
      created_at: AT,
      organization_display_name: "Echo",
      principal_display_name: "Founder",
      device_class: "byod",
      slack_user_id: "U123FOUNDER",
      ids: { ...IDS },
      claim_id: "clm_11111111-1111-4111-8111-111111111111",
      connection_seeds: [
        {
          provider: "slack",
          connection_id: "con_11111111-1111-4111-8111-111111111111",
          owner: { kind: "organization", id: IDS.organization_id },
          credential_guard: credentialGuard("file:/private/slack-token"),
        },
        {
          provider: "granola",
          connection_id: "con_22222222-2222-4222-8222-222222222222",
          owner: { kind: "membership", id: IDS.membership_id },
          credential_guard: credentialGuard("file:/private/granola-token"),
        },
      ],
      bindings: fullBindings(),
      publication: publication(),
    },
    signing_key: signingKey(),
    provider_observations: {
      slack: {
        snapshot: {
          provider: "slack",
          team_id: "T123TEAM",
          enterprise_id: null,
          bot_user_id: "U123BOT",
          bot_id: "B123BOT",
          app_id: "A123APP",
        },
        provider_identity: slackProviderIdentity(),
        evidence_input: {
          schema_version: 1,
          kind: "echo-slack-auth-test-evidence-input",
          provider: "slack",
          tenant: { team_id: "T123TEAM", enterprise_id: null },
          subject: {
            bot_user_id: "U123BOT",
            bot_id: "B123BOT",
            app_id: "A123APP",
          },
        },
        evidence_sha256: DIGEST,
      },
      granola: {
        provider: "granola",
        provider_identity: granolaProviderIdentity(),
        evidence: {
          schema_version: 1,
          kind: "echo-granola-first-capture-evidence",
          provider: "granola",
          operation: "list_notes",
          requested_page_size: 1,
          notes_observed: 1,
          observed_note_id_sha256: DIGEST,
          response_has_more: false,
          observed_at: AT,
        },
      },
    },
    challenge,
    verification: {
      evidence_input: {
        schema_version: 1,
        kind: "echo-slack-dm-challenge-evidence-input",
        provider: "slack",
        tenant: { team_id: "T123TEAM", enterprise_id: null },
        subject: { user_id: "U123FOUNDER" },
        bot: {
          user_id: "U123BOT",
          bot_id: "B123BOT",
          app_id: "A123APP",
          auth_test_evidence_sha256: DIGEST,
        },
        challenge: {
          channel_id: "D123FOUNDER",
          message_ts: "1752966000.000001",
          nonce_sha256: DIGEST,
          issued_at: AT,
          expires_at: AT,
        },
        assertion: {
          kind: "reaction",
          name: "white_check_mark",
          observed_at: AT,
        },
      },
      evidence_sha256: DIGEST,
      claim_assertion: slackClaimAssertion(),
    },
    confirmation: {
      summary: {
        organization: {
          organization_id: IDS.organization_id,
          display_name: "Echo",
        },
        founder: {
          principal_id: IDS.principal_id,
          membership_id: IDS.membership_id,
          display_name: "Founder",
          slack_team_id: "T123TEAM",
          slack_user_id: "U123FOUNDER",
          assurance: "provider_challenge_observed",
        },
        installation: {
          installation_id: IDS.installation_id,
          device_id: IDS.device_id,
          key_id: DIGEST,
          key_protection: "secure-enclave",
        },
        providers: {
          slack: { team_id: "T123TEAM", assurance: "provider_verified" },
          granola: { tenant: null, assurance: "credential_observed" },
        },
        configuration: {
          runtime_config_sha256: DIGEST,
          bindings: bindingSummaries(),
        },
        publication: publication(),
        cutover: {
          before: "disposable_test_or_legacy_imported_unverified",
          after: "native_attributed_only_when_strict_green",
        },
      },
      confirmation_sha256: DIGEST,
      ready_at: AT,
    },
    commit: {
      confirmed_at: AT,
      confirmation_sha256: DIGEST,
      plan_sha256: DIGEST,
      plan: plan(),
    },
    result: {
      completed_at: AT,
      organization_id: IDS.organization_id,
      installation_id: IDS.installation_id,
      manifest_id: IDS.manifest_id,
      active_bundle_sha256: DIGEST,
    },
    integrity: {
      canonicalization: "RFC8785",
      payload_sha256: DIGEST,
      signature_algorithm: "ecdsa-p256-sha256-der-low-s",
      key_id: DIGEST,
      signature_base64: "c2lnbmF0dXJl",
    },
  };
}

function cloneSession(): JsonRecord {
  return structuredClone(completeSession());
}

function setAtPath(
  root: unknown,
  path: readonly (string | number)[],
  value: unknown,
): void {
  let current = root;
  for (const segment of path.slice(0, -1)) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) throw new Error("test path is not an array");
      current = current[segment];
    } else {
      if (
        current === null ||
        typeof current !== "object" ||
        Array.isArray(current)
      ) {
        throw new Error("test path is not an object");
      }
      current = (current as JsonRecord)[segment];
    }
  }
  const leaf = path.at(-1);
  if (leaf === undefined) throw new Error("test path must not be empty");
  if (typeof leaf === "number") {
    if (!Array.isArray(current)) throw new Error("test leaf is not an array");
    current[leaf] = value;
  } else {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      throw new Error("test leaf is not an object");
    }
    (current as JsonRecord)[leaf] = value;
  }
}

const POISON_FIXTURES = [
  {
    name: "credential token",
    path: ["request", "connection_seeds", 0, "credential_guard", "token"],
    value: "xoxb-secret",
  },
  {
    name: "raw nonce on challenge ticket",
    path: ["challenge", "raw_nonce"],
    value: "one-time-secret",
  },
  {
    name: "raw nonce in verification evidence",
    path: ["verification", "evidence_input", "challenge", "nonce"],
    value: "one-time-secret",
  },
  {
    name: "Granola notes",
    path: ["provider_observations", "granola", "evidence", "notes"],
    value: [{ id: "not-secret-but-not-allowed" }],
  },
  {
    name: "Granola title",
    path: ["provider_observations", "granola", "evidence", "title"],
    value: "Private meeting title",
  },
  {
    name: "Granola owner",
    path: ["provider_observations", "granola", "evidence", "owner"],
    value: { name: "Employee" },
  },
  {
    name: "Granola transcript",
    path: ["provider_observations", "granola", "evidence", "transcript"],
    value: "Raw meeting transcript",
  },
  {
    name: "signing private key",
    path: ["signing_key", "private_key"],
    value: "private-key-material",
  },
  {
    name: "integrity secret",
    path: ["integrity", "secret"],
    value: "hidden-material",
  },
  {
    name: "adapter configuration api_key",
    path: ["request", "bindings", 0, "configuration_snapshot", "api_key"],
    value: "granola-secret",
  },
  {
    name: "provider raw response inside the committed registry",
    path: [
      "commit",
      "plan",
      "registry",
      "connections",
      0,
      "generations",
      0,
      "provider_identity",
      "raw_response",
    ],
    value: { token: "provider-secret" },
  },
  {
    name: "temporal field in the founder-confirmed binding summary",
    path: [
      "confirmation",
      "summary",
      "configuration",
      "bindings",
      0,
      "created_at",
    ],
    value: AT,
  },
  {
    name: "activation timestamp in the founder-confirmed cutover summary",
    path: ["confirmation", "summary", "cutover", "activation_at"],
    value: AT,
  },
  {
    name: "meeting content on the completion result",
    path: ["result", "meeting"],
    value: { title: "Not completion evidence" },
  },
] as const;

describe("Founder bootstrap persisted-session exact shape", () => {
  it("accepts the complete Founder Live session shape", () => {
    expect(() =>
      assertExactFounderBootstrapSessionShape(completeSession()),
    ).not.toThrow();
  });

  it.each(POISON_FIXTURES)("rejects $name", ({ path, value }) => {
    const session = cloneSession();
    setAtPath(session, path, value);
    expect(() => assertExactFounderBootstrapSessionShape(session)).toThrow(
      /unsupported key/,
    );
  });

  it.each([
    "https://token@example.test/v1",
    "https://example.test/v1?token=secret",
    "https://example.test/v1#secret",
  ])("rejects a Granola base URL carrying authority data: %s", (baseUrl) => {
    const session = cloneSession();
    setAtPath(
      session,
      ["request", "bindings", 0, "configuration_snapshot", "base_url"],
      baseUrl,
    );
    expect(() => assertExactFounderBootstrapSessionShape(session)).toThrow(
      /must not contain credentials, query, or hash/,
    );
  });

  it("accepts the other finite bundled adapter configuration shapes", () => {
    const llm = cloneSession();
    setAtPath(llm, ["request", "bindings", 1, "adapter_id"], "llm");
    setAtPath(llm, ["request", "bindings", 1, "configuration_snapshot"], {
      model: "qwen3:4b",
      base_url: "http://127.0.0.1:11434",
      request_timeout_ms: 240_000,
      prompt_version: "decision-extraction-v1",
    });
    expect(() => assertExactFounderBootstrapSessionShape(llm)).not.toThrow();

    const missingPromptVersion = JSON.parse(JSON.stringify(llm)) as JsonRecord;
    const missingLlmSnapshot = (
      (missingPromptVersion["request"] as JsonRecord)[
        "bindings"
      ] as JsonRecord[]
    )[1]!["configuration_snapshot"] as JsonRecord;
    delete missingLlmSnapshot["prompt_version"];
    expect(() =>
      assertExactFounderBootstrapSessionShape(missingPromptVersion),
    ).toThrow(/prompt_version/);

    const wrongPromptVersion = JSON.parse(JSON.stringify(llm)) as JsonRecord;
    const wrongLlmSnapshot = (
      (wrongPromptVersion["request"] as JsonRecord)["bindings"] as JsonRecord[]
    )[1]!["configuration_snapshot"] as JsonRecord;
    wrongLlmSnapshot["prompt_version"] = "operator-supplied";
    expect(() =>
      assertExactFounderBootstrapSessionShape(wrongPromptVersion),
    ).toThrow(/unsupported value/);

    const jsonl = cloneSession();
    setAtPath(jsonl, ["request", "bindings", 2, "adapter_id"], "jsonl-outbox");
    setAtPath(jsonl, ["request", "bindings", 2, "configuration_snapshot"], {
      path: "/private/echo/outbox.jsonl",
      destination_id: "local",
    });
    expect(() => assertExactFounderBootstrapSessionShape(jsonl)).not.toThrow();
  });

  it("requires an exact one-person Slack reviewer snapshot", () => {
    const session = cloneSession();
    setAtPath(
      session,
      ["request", "bindings", 3, "configuration_snapshot", "reviewer", "token"],
      "xoxb-secret",
    );
    expect(() => assertExactFounderBootstrapSessionShape(session)).toThrow(
      /reviewer has unsupported key 'token'/,
    );
  });

  it("rejects adapters outside the finite bundled Founder Live set", () => {
    const session = cloneSession();
    setAtPath(
      session,
      ["request", "bindings", 1, "adapter_id"],
      "remote-processor",
    );
    expect(() => assertExactFounderBootstrapSessionShape(session)).toThrow(
      /outside the bundled Founder Live set/,
    );
  });

  it("caps the persisted binding snapshot", () => {
    const session = cloneSession();
    const excessive = Array.from({ length: 33 }, () =>
      structuredClone(fullBindings()[0]),
    );
    setAtPath(session, ["request", "bindings"], excessive);
    expect(() => assertExactFounderBootstrapSessionShape(session)).toThrow(
      /between 4 and 32 items/,
    );
  });

  it.each([
    {
      name: "connection seed count",
      path: ["request", "connection_seeds"],
      value: [],
    },
    {
      name: "binding count",
      path: ["request", "bindings"],
      value: [],
    },
    {
      name: "audience count",
      path: ["request", "publication", "audience", "subjects"],
      value: [],
    },
    {
      name: "identity claim count",
      path: ["commit", "plan", "manifest", "identity_claims"],
      value: [],
    },
    {
      name: "connection count",
      path: ["commit", "plan", "registry", "connections"],
      value: [],
    },
    {
      name: "connection generation count",
      path: ["commit", "plan", "registry", "connections", 0, "generations"],
      value: [],
    },
    {
      name: "native record requirement count",
      path: [
        "commit",
        "plan",
        "manifest",
        "legacy_cutover",
        "native_records_require",
      ],
      value: [],
    },
  ])("bounds the Founder Live $name", ({ path, value }) => {
    const session = cloneSession();
    setAtPath(session, path, value);
    expect(() => assertExactFounderBootstrapSessionShape(session)).toThrow(
      /must contain between/,
    );
  });
});
