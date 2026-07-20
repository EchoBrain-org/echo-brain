import { LLM_DECISION_PROCESSOR_PROMPT_VERSION } from "../../../adapters/decision-processors/llm/llm-decision-processor.js";

type JsonRecord = Record<string, unknown>;
type Shape = (value: unknown, label: string) => void;

const MAX_FOUNDER_BINDINGS = 32;

function objectValue(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): JsonRecord {
  const record = objectValue(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} has unsupported key '${key}'`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      throw new Error(`${label} is missing required key '${key}'`);
    }
  }
  return record;
}

const stringShape: Shape = (value, label) => {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
};

const integerShape: Shape = (value, label) => {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }
};

const booleanShape: Shape = (value, label) => {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
};

function literalShape(expected: unknown): Shape {
  return (value, label) => {
    if (value !== expected)
      throw new Error(`${label} has an unsupported value`);
  };
}

function nullableShape(shape: Shape): Shape {
  return (value, label) => {
    if (value !== null) shape(value, label);
  };
}

function objectShape(
  fields: Readonly<Record<string, Shape>>,
  optional: Readonly<Record<string, Shape>> = {},
): Shape {
  const requiredKeys = Object.keys(fields);
  const optionalKeys = Object.keys(optional);
  return (value, label) => {
    const record = exactRecord(value, requiredKeys, label, optionalKeys);
    for (const [key, shape] of Object.entries(fields)) {
      shape(record[key], `${label}.${key}`);
    }
    for (const [key, shape] of Object.entries(optional)) {
      if (Object.hasOwn(record, key)) shape(record[key], `${label}.${key}`);
    }
  };
}

function arrayShape(minimum: number, maximum: number, itemShape: Shape): Shape {
  return (value, label) => {
    if (
      !Array.isArray(value) ||
      value.length < minimum ||
      value.length > maximum
    ) {
      throw new Error(
        `${label} must contain between ${minimum} and ${maximum} items`,
      );
    }
    value.forEach((item, index) => itemShape(item, `${label}[${index}]`));
  };
}

function exactArrayShape(count: number, itemShape: Shape): Shape {
  return arrayShape(count, count, itemShape);
}

function assertSafeBaseUrl(
  value: unknown,
  allowedProtocols: readonly string[],
  label: string,
): void {
  stringShape(value, label);
  const raw = value as string;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new Error(`${label} uses an unsupported protocol`);
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    raw.includes("?") ||
    raw.includes("#")
  ) {
    throw new Error(`${label} must not contain credentials, query, or hash`);
  }
}

const packagedBuildShape = objectShape({
  schema_version: integerShape,
  kind: stringShape,
  product_version: stringShape,
  source_sha: stringShape,
  source_kind: stringShape,
});

const bootstrapIdsShape = objectShape({
  organization_id: stringShape,
  principal_id: stringShape,
  membership_id: stringShape,
  device_id: stringShape,
  installation_id: stringShape,
  manifest_id: stringShape,
  registry_id: stringShape,
  policy_id: stringShape,
});

const ownerShape = objectShape({ kind: stringShape, id: stringShape });

const credentialGuardShape = objectShape({
  reference: stringShape,
  algorithm: stringShape,
  salt_base64: stringShape,
  digest: stringShape,
  exportable: literalShape(false),
});

const retentionShape: Shape = (value, label) => {
  const candidate = objectValue(value, label);
  if (candidate["kind"] === "indefinite") {
    objectShape({ kind: stringShape })(candidate, label);
    return;
  }
  if (candidate["kind"] === "duration") {
    objectShape({ kind: stringShape, days: integerShape })(candidate, label);
    return;
  }
  throw new Error(`${label}.kind has an unsupported value`);
};

const publicationShape = objectShape({
  payload_scope: stringShape,
  audience: objectShape({
    scope: stringShape,
    subjects: exactArrayShape(1, ownerShape),
  }),
  sensitivity: stringShape,
  retention: retentionShape,
  raw_meeting_content: stringShape,
  participant_observations: stringShape,
});

function granolaSettingsShape(value: unknown, label: string): void {
  objectShape(
    {},
    {
      base_url: (candidate, path) =>
        assertSafeBaseUrl(candidate, ["https:"], path),
      request_timeout_ms: integerShape,
      page_size: integerShape,
      cursor_overlap_ms: integerShape,
    },
  )(value, label);
}

const structuredTextSettingsShape = objectShape({});

const llmSettingsShape = objectShape(
  {
    model: stringShape,
    prompt_version: literalShape(LLM_DECISION_PROCESSOR_PROMPT_VERSION),
  },
  {
    base_url: (value, label) =>
      assertSafeBaseUrl(value, ["http:", "https:"], label),
    request_timeout_ms: integerShape,
  },
);

const jsonlOutboxSettingsShape = objectShape(
  { path: stringShape },
  { destination_id: stringShape },
);

const slackDeliverySettingsShape = objectShape(
  { channel_id: stringShape },
  { request_timeout_ms: integerShape },
);

const slackReactionsSettingsShape = objectShape(
  {
    channel_id: stringShape,
    reviewer: objectShape({
      slack_user_id: stringShape,
      name: stringShape,
    }),
  },
  {
    approve_reaction: stringShape,
    reject_reaction: stringShape,
    request_timeout_ms: integerShape,
  },
);

function assertBundledConfigurationSnapshot(
  binding: JsonRecord,
  label: string,
): void {
  stringShape(binding["capability"], `${label}.capability`);
  stringShape(binding["adapter_id"], `${label}.adapter_id`);
  const adapter = `${String(binding["capability"])}:${String(binding["adapter_id"])}`;
  const snapshotLabel = `${label}.configuration_snapshot`;
  switch (adapter) {
    case "meeting-source:granola":
      granolaSettingsShape(binding["configuration_snapshot"], snapshotLabel);
      return;
    case "decision-processor:structured-text":
      structuredTextSettingsShape(
        binding["configuration_snapshot"],
        snapshotLabel,
      );
      return;
    case "decision-processor:llm":
      llmSettingsShape(binding["configuration_snapshot"], snapshotLabel);
      return;
    case "delivery-surface:jsonl-outbox":
      jsonlOutboxSettingsShape(
        binding["configuration_snapshot"],
        snapshotLabel,
      );
      return;
    case "delivery-surface:slack":
      slackDeliverySettingsShape(
        binding["configuration_snapshot"],
        snapshotLabel,
      );
      return;
    case "approval-surface:slack-reactions":
      slackReactionsSettingsShape(
        binding["configuration_snapshot"],
        snapshotLabel,
      );
      return;
    default:
      throw new Error(
        `${label} names an adapter outside the bundled Founder Live set`,
      );
  }
}

const BINDING_SUMMARY_SHAPES: Readonly<Record<string, Shape>> = {
  adapter_binding_id: stringShape,
  capability: stringShape,
  adapter_id: stringShape,
  instance_id: stringShape,
  connection_id: nullableShape(stringShape),
  connection_generation: nullableShape(integerShape),
  configuration_snapshot: objectValue,
  configuration_sha256: stringShape,
};

function assertBinding(value: unknown, label: string, temporal: boolean): void {
  const fields = temporal
    ? {
        ...BINDING_SUMMARY_SHAPES,
        created_at: stringShape,
        ended_at: nullableShape(stringShape),
        status: stringShape,
      }
    : BINDING_SUMMARY_SHAPES;
  objectShape(fields)(value, label);
  assertBundledConfigurationSnapshot(value as JsonRecord, label);
}

const fullBindingShape: Shape = (value, label) =>
  assertBinding(value, label, true);
const bindingSummaryShape: Shape = (value, label) =>
  assertBinding(value, label, false);
const fullBindingsShape = arrayShape(4, MAX_FOUNDER_BINDINGS, fullBindingShape);
const bindingSummariesShape = arrayShape(
  4,
  MAX_FOUNDER_BINDINGS,
  bindingSummaryShape,
);

const connectionSeedShape = objectShape({
  provider: stringShape,
  connection_id: stringShape,
  owner: ownerShape,
  credential_guard: credentialGuardShape,
});

const requestShape = objectShape({
  config_sha256: stringShape,
  build: packagedBuildShape,
  created_at: stringShape,
  organization_display_name: stringShape,
  principal_display_name: stringShape,
  device_class: stringShape,
  slack_user_id: stringShape,
  ids: bootstrapIdsShape,
  claim_id: stringShape,
  connection_seeds: exactArrayShape(2, connectionSeedShape),
  bindings: fullBindingsShape,
  publication: publicationShape,
});

const signingKeyShape = objectShape({
  installation_id: stringShape,
  key_id: stringShape,
  algorithm: stringShape,
  public_key_spki_der_base64: stringShape,
  protection: stringShape,
  assurance: stringShape,
  private_key_exportable: literalShape(false),
});

const providerVerificationShape = objectShape({
  method: stringShape,
  assurance: stringShape,
  verified_at: stringShape,
  evidence_sha256: stringShape,
});

const slackProviderIdentityShape = objectShape({
  tenant: objectShape({
    kind: stringShape,
    id: stringShape,
    enterprise_id: nullableShape(stringShape),
  }),
  subject: objectShape({
    kind: stringShape,
    id: stringShape,
    bot_id: nullableShape(stringShape),
    app_id: nullableShape(stringShape),
  }),
  verification: providerVerificationShape,
});

const granolaProviderIdentityShape = objectShape({
  tenant: literalShape(null),
  subject: literalShape(null),
  verification: providerVerificationShape,
});

const capturedSlackShape = objectShape({
  snapshot: objectShape({
    provider: stringShape,
    team_id: stringShape,
    enterprise_id: nullableShape(stringShape),
    bot_user_id: stringShape,
    bot_id: stringShape,
    app_id: nullableShape(stringShape),
  }),
  provider_identity: slackProviderIdentityShape,
  evidence_input: objectShape({
    schema_version: integerShape,
    kind: stringShape,
    provider: stringShape,
    tenant: objectShape({
      team_id: stringShape,
      enterprise_id: nullableShape(stringShape),
    }),
    subject: objectShape({
      bot_user_id: stringShape,
      bot_id: stringShape,
      app_id: nullableShape(stringShape),
    }),
  }),
  evidence_sha256: stringShape,
});

const capturedGranolaShape = objectShape({
  provider: stringShape,
  provider_identity: granolaProviderIdentityShape,
  evidence: objectShape({
    schema_version: integerShape,
    kind: stringShape,
    provider: stringShape,
    operation: stringShape,
    requested_page_size: integerShape,
    notes_observed: integerShape,
    observed_note_id_sha256: stringShape,
    response_has_more: booleanShape,
    observed_at: stringShape,
  }),
});

const providerObservationsShape = objectShape({
  slack: capturedSlackShape,
  granola: capturedGranolaShape,
});

const challengeShape = objectShape({
  schema_version: integerShape,
  kind: stringShape,
  provider: stringShape,
  tenant_id: stringShape,
  enterprise_id: nullableShape(stringShape),
  subject_id: stringShape,
  bot_user_id: stringShape,
  bot_id: stringShape,
  app_id: nullableShape(stringShape),
  auth_test_evidence_sha256: stringShape,
  channel_id: stringShape,
  message_ts: stringShape,
  reaction_name: stringShape,
  challenge_sha256: stringShape,
  issued_at: stringShape,
  expires_at: stringShape,
});

const claimSubjectShape = objectShape({ kind: stringShape, id: stringShape });

const claimIssuerShape: Shape = (value, label) => {
  const issuer = objectValue(value, label);
  if (issuer["kind"] === "provider") {
    objectShape({
      kind: stringShape,
      provider: stringShape,
      tenant_id: stringShape,
    })(issuer, label);
    return;
  }
  if (issuer["kind"] === "oidc") {
    objectShape({ kind: stringShape, issuer_uri: stringShape })(issuer, label);
    return;
  }
  throw new Error(`${label}.kind has an unsupported value`);
};

const claimVerificationShape: Shape = (value, label) => {
  const verification = objectValue(value, label);
  if (verification["method"] === "oidc_id_token") {
    objectShape({
      method: stringShape,
      assurance: stringShape,
      verified_at: stringShape,
      evidence_sha256: stringShape,
      audience: stringShape,
      authentication_time: stringShape,
      nonce_sha256: stringShape,
    })(verification, label);
    return;
  }
  objectShape({
    method: stringShape,
    assurance: stringShape,
    verified_at: stringShape,
    evidence_sha256: stringShape,
  })(verification, label);
};

const claimAssertionShape = objectShape({
  issuer: claimIssuerShape,
  subject: claimSubjectShape,
  verification: claimVerificationShape,
});

const challengeVerificationShape = objectShape({
  evidence_input: objectShape({
    schema_version: integerShape,
    kind: stringShape,
    provider: stringShape,
    tenant: objectShape({
      team_id: stringShape,
      enterprise_id: nullableShape(stringShape),
    }),
    subject: objectShape({ user_id: stringShape }),
    bot: objectShape({
      user_id: stringShape,
      bot_id: stringShape,
      app_id: nullableShape(stringShape),
      auth_test_evidence_sha256: stringShape,
    }),
    challenge: objectShape({
      channel_id: stringShape,
      message_ts: stringShape,
      nonce_sha256: stringShape,
      issued_at: stringShape,
      expires_at: stringShape,
    }),
    assertion: objectShape({
      kind: stringShape,
      name: stringShape,
      observed_at: stringShape,
    }),
  }),
  evidence_sha256: stringShape,
  claim_assertion: claimAssertionShape,
});

const confirmationShape = objectShape({
  summary: objectShape({
    organization: objectShape({
      organization_id: stringShape,
      display_name: stringShape,
    }),
    founder: objectShape({
      principal_id: stringShape,
      membership_id: stringShape,
      display_name: stringShape,
      slack_team_id: stringShape,
      slack_user_id: stringShape,
      assurance: stringShape,
    }),
    installation: objectShape({
      installation_id: stringShape,
      device_id: stringShape,
      key_id: stringShape,
      key_protection: stringShape,
    }),
    providers: objectShape({
      slack: objectShape({
        team_id: stringShape,
        assurance: stringShape,
      }),
      granola: objectShape({
        tenant: literalShape(null),
        assurance: stringShape,
      }),
    }),
    configuration: objectShape({
      runtime_config_sha256: stringShape,
      bindings: bindingSummariesShape,
    }),
    publication: publicationShape,
    cutover: objectShape({ before: stringShape, after: stringShape }),
  }),
  confirmation_sha256: stringShape,
  ready_at: stringShape,
});

const identityClaimShape = objectShape({
  claim_id: stringShape,
  principal_id: stringShape,
  issuer: claimIssuerShape,
  subject: claimSubjectShape,
  verification: claimVerificationShape,
});

const unsignedManifestShape = objectShape({
  schema_version: integerShape,
  kind: stringShape,
  manifest_id: stringShape,
  predecessor_manifest_id: nullableShape(stringShape),
  created_at: stringShape,
  authority: objectShape({ kind: stringShape, assurance: stringShape }),
  organization: objectShape({
    organization_id: stringShape,
    display_name: stringShape,
    created_at: stringShape,
  }),
  principal: objectShape({
    principal_id: stringShape,
    organization_id: stringShape,
    kind: stringShape,
    display_name: stringShape,
  }),
  membership: objectShape({
    membership_id: stringShape,
    organization_id: stringShape,
    principal_id: stringShape,
    type: stringShape,
    status: stringShape,
    valid_from: stringShape,
  }),
  installation: objectShape({
    installation_id: stringShape,
    organization_id: stringShape,
    membership_id: stringShape,
    device_id: stringShape,
    device_class: stringShape,
    enrolled_at: stringShape,
    product: objectShape({
      name: stringShape,
      version: stringShape,
      source_sha: stringShape,
    }),
  }),
  identity_claims: exactArrayShape(1, identityClaimShape),
  legacy_cutover: objectShape({
    declared_at: stringShape,
    pre_cutover_default: stringShape,
    native_records_require: exactArrayShape(4, stringShape),
  }),
});

function connectionGenerationShape(provider: string): Shape {
  const providerIdentityShape =
    provider === "slack"
      ? slackProviderIdentityShape
      : provider === "granola"
        ? granolaProviderIdentityShape
        : undefined;
  if (providerIdentityShape === undefined) {
    throw new Error(
      "connection belongs to an unsupported Founder Live provider",
    );
  }
  return objectShape({
    generation: integerShape,
    active_from: stringShape,
    ended_at: nullableShape(stringShape),
    provider_identity: providerIdentityShape,
    local_credential_guard: credentialGuardShape,
  });
}

const toolConnectionShape: Shape = (value, label) => {
  const connection = exactRecord(
    value,
    ["connection_id", "organization_id", "owner", "provider", "generations"],
    label,
  );
  stringShape(connection["connection_id"], `${label}.connection_id`);
  stringShape(connection["organization_id"], `${label}.organization_id`);
  ownerShape(connection["owner"], `${label}.owner`);
  stringShape(connection["provider"], `${label}.provider`);
  exactArrayShape(
    1,
    connectionGenerationShape(connection["provider"] as string),
  )(connection["generations"], `${label}.generations`);
};

const unsignedRegistryShape = objectShape({
  schema_version: integerShape,
  kind: stringShape,
  registry_id: stringShape,
  identity_manifest_id: stringShape,
  revision: integerShape,
  previous_registry_sha256: nullableShape(stringShape),
  updated_at: stringShape,
  connections: exactArrayShape(2, toolConnectionShape),
  bindings: fullBindingsShape,
});

const unsignedPolicyShape = objectShape({
  schema_version: integerShape,
  kind: stringShape,
  policy_id: stringShape,
  organization_id: stringShape,
  identity_manifest_id: stringShape,
  version: integerShape,
  effective_at: stringShape,
  publication: publicationShape,
});

const planShape = objectShape({
  ids: bootstrapIdsShape,
  expected_signing_key: signingKeyShape,
  manifest: unsignedManifestShape,
  registry: unsignedRegistryShape,
  policy: unsignedPolicyShape,
});

const commitShape = objectShape({
  confirmed_at: stringShape,
  confirmation_sha256: stringShape,
  plan_sha256: stringShape,
  plan: planShape,
});

const resultShape = objectShape({
  completed_at: stringShape,
  organization_id: stringShape,
  installation_id: stringShape,
  manifest_id: stringShape,
  active_bundle_sha256: stringShape,
});

const integrityShape = objectShape({
  canonicalization: stringShape,
  payload_sha256: stringShape,
  signature_algorithm: stringShape,
  key_id: stringShape,
  signature_base64: stringShape,
});

const sessionShape = objectShape({
  schema_version: integerShape,
  kind: stringShape,
  session_id: stringShape,
  revision: integerShape,
  phase: stringShape,
  request: requestShape,
  signing_key: nullableShape(signingKeyShape),
  provider_observations: nullableShape(providerObservationsShape),
  challenge: nullableShape(challengeShape),
  verification: nullableShape(challengeVerificationShape),
  confirmation: nullableShape(confirmationShape),
  commit: nullableShape(commitShape),
  result: nullableShape(resultShape),
  integrity: nullableShape(integrityShape),
});

/**
 * Reject persisted bootstrap-session fields that are outside the deliberately
 * finite Founder Live format. This is a structural poison guard only: the
 * session store remains responsible for identifiers, chronology, digests,
 * signatures, provider evidence agreement, and phase-transition semantics.
 */
export function assertExactFounderBootstrapSessionShape(value: unknown): void {
  sessionShape(value, "founder bootstrap session");
}
