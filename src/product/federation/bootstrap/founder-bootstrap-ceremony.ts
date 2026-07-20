import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AdapterInstanceConfig } from "../../../core/index.js";
import {
  HttpGranolaApiClient,
  type GranolaApiClient,
} from "../../../adapters/meeting-sources/granola/index.js";
import { SlackWebApiClient } from "../../../adapters/shared/slack/slack-web-api-client.js";
import { addUtcMilliseconds } from "../../../util/timestamp.js";
import type { ProductRuntimeConfig } from "../../config.js";
import { createConfiguredAdapterRegistry } from "../../adapter-factories.js";
import { createDefaultAdapterFactories } from "../../default-adapters.js";
import { canonicalProductConfigSha256 } from "../../lifecycle-lock.js";
import {
  createProductCredentialResolver,
  isServiceSafeCredentialReference,
  type ProductCredentialResolver,
} from "../../credentials.js";
import { ActiveIdentityBundleStore } from "../identity/active-identity-bundle-store.js";
import { identityBindingConfigurationSnapshot } from "../identity/binding-configuration.js";
import {
  commitFounderBootstrap as commitFounderIdentityBundle,
  mintFounderBootstrapIds,
  type FounderBootstrapResult,
  type FounderBootstrapIds,
  type FounderBootstrapPlan,
} from "./bootstrap.js";
import {
  buildFounderBootstrapConfirmationSummary,
  deriveFounderBootstrapPlanFromSession,
  type FounderBootstrapConfirmationSummaryV1,
  type FounderBootstrapRequestV1,
  type FounderBootstrapSessionV1,
  FounderBootstrapSessionStore,
} from "./bootstrap-session-store.js";
import {
  loadPackagedBuildIdentity,
  validatePackagedBuildIdentity,
  type PackagedBuildIdentityV1,
} from "../build-identity.js";
import { canonicalJson, canonicalSha256 } from "../foundation/canonical-json.js";
import {
  assertLocalCredentialGuardMatches,
  createLocalCredentialGuard,
} from "../identity/credential-guard.js";
import type { AdapterBindingV1, PublicationSnapshotV1 } from "../contracts.js";
import { federationId } from "../foundation/identifiers.js";
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from "../foundation/installation-signer.js";
import { verifyInstallationKeyDescriptor } from "../foundation/installation-signer.js";
import { signWithInstallationKey } from "../foundation/installation-signer.js";
import { observeGranolaConnection } from "../identity/granola-connection-evidence.js";
import {
  issueSlackDmChallenge,
  pollSlackDmChallenge,
  type SlackDmChallengeApi,
} from "./slack-dm-challenge.js";
import {
  assertCapturedSlackProviderIdentity,
  captureSlackProviderIdentity,
  type CapturedSlackProviderIdentityV1,
} from "../identity/slack-provider-identity.js";
import { createSignedDocument } from "../foundation/signed-document.js";
import {
  commitFounderCutoverGuard,
  readFounderCutoverGuard,
} from "../cutover-fence.js";

const DEFAULT_CHALLENGE_LIFETIME_MS = 10 * 60 * 1_000;
const STATUS_POLL_INTERVAL_MS = 1_000;

export interface BeginFounderBootstrapInput {
  organizationDisplayName: string;
  principalDisplayName: string;
  slackUserId: string;
  deviceClass?: "byod" | "managed";
}

export interface FounderBootstrapCeremonyDependencies {
  signer?: InstallationSigner;
  credentialResolver?: ProductCredentialResolver;
  slackApiFactory?: (credential: string) => SlackDmChallengeApi;
  granolaApiFactory?: (credential: string) => GranolaApiClient;
  loadBuildIdentity?: () => PackagedBuildIdentityV1;
  now?: () => string;
  sessionIdFactory?: () => string;
  idsFactory?: () => FounderBootstrapIds;
  federationIdFactory?: (prefix: "clm" | "con" | "bnd") => string;
  challengeLifetimeMs?: number;
  /**
   * Recover a cutover timestamp already frozen by a durable authorization
   * side effect. Production uses the immutable legacy-classification report
   * so a crash after that report is written but before the signed session
   * enters `committing` rederives the exact same activation plan.
   */
  recoverSeedCutoverConfirmedAt?: (input: {
    config: ProductRuntimeConfig;
    session: FounderBootstrapSessionV1;
  }) => Promise<string | null>;
  /**
   * Test seam until the signed outbox and independent-copy gate land. Product
   * bootstrap deliberately has no default authorization in Workstream 2.
   */
  authorizeSeedCutover?: (input: {
    config: ProductRuntimeConfig;
    session: FounderBootstrapSessionV1;
    plan: FounderBootstrapPlan;
  }) => Promise<void>;
  /**
   * Runs after the active pointer is durable but before the signed bootstrap
   * session becomes complete. Production uses this recovery-safe window to
   * prove the full strict gate, including the independent-copy target.
   */
  finalizeSeedCutover?: (input: {
    config: ProductRuntimeConfig;
    session: FounderBootstrapSessionV1;
    plan: FounderBootstrapPlan;
    result: FounderBootstrapResult;
  }) => Promise<void>;
}

export interface FounderBootstrapProgress {
  session_id: string;
  phase: FounderBootstrapSessionV1["phase"];
  installation_key_id: string;
  challenge: {
    channel_id: string;
    message_ts: string;
    reaction_name: string;
    expires_at: string;
  } | null;
  confirmation: {
    confirmation_sha256: string;
    summary: FounderBootstrapConfirmationSummaryV1;
  } | null;
  result: FounderBootstrapSessionV1["result"];
}

export interface FounderBootstrapAbortResult {
  aborted: true;
  session_id: string;
  installation_id: string;
  installation_key_id: string | null;
  key_deleted: boolean;
}

interface ConfiguredCapability {
  capability: AdapterBindingV1["capability"];
  config: AdapterInstanceConfig;
}

interface CeremonyContext {
  signer: InstallationSigner;
  credentialResolver: ProductCredentialResolver;
  slackApiFactory: (credential: string) => SlackDmChallengeApi;
  granolaApiFactory: (credential: string) => GranolaApiClient;
  loadBuildIdentity: () => PackagedBuildIdentityV1;
  now: () => string;
  sessionIdFactory: () => string;
  idsFactory: () => FounderBootstrapIds;
  federationIdFactory: (prefix: "clm" | "con" | "bnd") => string;
  challengeLifetimeMs: number;
  recoverSeedCutoverConfirmedAt: NonNullable<
    FounderBootstrapCeremonyDependencies["recoverSeedCutoverConfirmedAt"]
  >;
  authorizeSeedCutover: NonNullable<
    FounderBootstrapCeremonyDependencies["authorizeSeedCutover"]
  >;
  finalizeSeedCutover: NonNullable<
    FounderBootstrapCeremonyDependencies["finalizeSeedCutover"]
  >;
}

function requireSigner(
  dependencies: FounderBootstrapCeremonyDependencies,
): InstallationSigner {
  if (dependencies.signer === undefined) {
    throw new Error(
      "signer_unavailable: seed-grade bootstrap requires the verified packaged Secure Enclave helper",
    );
  }
  return dependencies.signer;
}

function context(
  dependencies: FounderBootstrapCeremonyDependencies,
): CeremonyContext {
  const challengeLifetimeMs =
    dependencies.challengeLifetimeMs ?? DEFAULT_CHALLENGE_LIFETIME_MS;
  if (
    !Number.isSafeInteger(challengeLifetimeMs) ||
    challengeLifetimeMs <= 0 ||
    challengeLifetimeMs > 15 * 60 * 1_000
  ) {
    throw new Error("founder bootstrap challenge lifetime must be 1-900000ms");
  }
  const customAuthorization = dependencies.authorizeSeedCutover !== undefined;
  return {
    signer: requireSigner(dependencies),
    credentialResolver:
      dependencies.credentialResolver ?? createProductCredentialResolver(),
    slackApiFactory:
      dependencies.slackApiFactory ??
      ((credential) => new SlackWebApiClient(credential)),
    granolaApiFactory:
      dependencies.granolaApiFactory ??
      ((credential) => new HttpGranolaApiClient(credential)),
    loadBuildIdentity:
      dependencies.loadBuildIdentity ?? loadPackagedBuildIdentity,
    now:
      dependencies.now ??
      (() => {
        throw new Error("founder bootstrap requires an injected product clock");
      }),
    sessionIdFactory: dependencies.sessionIdFactory ?? randomUUID,
    idsFactory: dependencies.idsFactory ?? mintFounderBootstrapIds,
    federationIdFactory:
      dependencies.federationIdFactory ?? ((prefix) => federationId(prefix)),
    challengeLifetimeMs,
    recoverSeedCutoverConfirmedAt:
      dependencies.recoverSeedCutoverConfirmedAt ?? (async () => null),
    authorizeSeedCutover:
      dependencies.authorizeSeedCutover ??
      (async () => {
        throw new Error(
          "seed_cutover_unavailable: approval attribution, signed outbox, and verified independent copy are not installed",
        );
      }),
    finalizeSeedCutover:
      dependencies.finalizeSeedCutover ??
      (customAuthorization
        ? async () => undefined
        : async () => {
            throw new Error(
              "seed_cutover_unavailable: post-activation strict verification is not installed",
            );
          }),
  };
}

function configuredCapabilities(
  config: ProductRuntimeConfig,
): ConfiguredCapability[] {
  return [
    ...config.meeting_sources.map((item) => ({
      capability: "meeting-source" as const,
      config: item,
    })),
    {
      capability: "decision-processor" as const,
      config: config.decision_processor,
    },
    ...config.delivery_surfaces.map((item) => ({
      capability: "delivery-surface" as const,
      config: item,
    })),
    ...(config.approval_mode === "adapter"
      ? [
          {
            capability: "approval-surface" as const,
            config: config.approval_surface,
          },
        ]
      : []),
  ];
}

function providerForAdapter(adapterId: string): "slack" | "granola" | null {
  if (adapterId === "granola") return "granola";
  if (adapterId === "slack" || adapterId === "slack-reactions") return "slack";
  return null;
}

function requireCredential(
  resolver: ProductCredentialResolver,
  reference: string,
  provider: string,
): string {
  const credential = resolver(reference);
  if (credential === undefined || credential.trim() === "") {
    throw new Error(`${provider} bootstrap credential is unavailable`);
  }
  return credential;
}

function buildIdentity(
  loader: () => PackagedBuildIdentityV1,
): PackagedBuildIdentityV1 {
  const build = validatePackagedBuildIdentity(loader());
  if (build.source_kind !== "materialized-commit") {
    throw new Error(
      "founder bootstrap requires a package built from one materialized commit",
    );
  }
  return build;
}

function configDigest(config: ProductRuntimeConfig): `sha256:${string}` {
  return `sha256:${canonicalProductConfigSha256(config)}`;
}

function validateBootstrapConfiguration(config: ProductRuntimeConfig): {
  capabilities: readonly ConfiguredCapability[];
  slackReference: string;
  granolaReference: string;
} {
  if (
    config.approval_mode !== "adapter" ||
    config.approval_surface.adapter_id !== "slack-reactions"
  ) {
    throw new Error(
      "founder bootstrap requires one configured slack-reactions approval surface",
    );
  }
  const granolaSources = config.meeting_sources.filter(
    (item) => item.adapter_id === "granola",
  );
  if (granolaSources.length !== 1 || config.meeting_sources.length !== 1) {
    throw new Error(
      "founder bootstrap requires exactly one Granola meeting source",
    );
  }
  const slackReference = config.approval_surface.credential_ref;
  const granolaReference = granolaSources[0]!.credential_ref;
  if (slackReference === undefined || granolaReference === undefined) {
    throw new Error(
      "Slack and Granola bootstrap adapters require credential references",
    );
  }
  const credentialsDirectory = join(config.state_dir, "credentials");
  if (
    !isServiceSafeCredentialReference(slackReference, credentialsDirectory) ||
    !isServiceSafeCredentialReference(granolaReference, credentialsDirectory)
  ) {
    throw new Error(
      "founder bootstrap requires managed file credentials inside the product state credentials directory",
    );
  }
  const capabilities = configuredCapabilities(config);
  for (const item of capabilities) {
    const provider = providerForAdapter(item.config.adapter_id);
    if (provider === null && item.config.credential_ref !== undefined) {
      throw new Error(
        `founder bootstrap cannot attribute credentialed adapter ${item.capability}:${item.config.adapter_id}/${item.config.instance_id}`,
      );
    }
    if (provider === "slack" && item.config.credential_ref !== slackReference) {
      throw new Error(
        "founder bootstrap requires all Slack capabilities to share one verified connection",
      );
    }
    if (
      provider === "granola" &&
      item.config.credential_ref !== granolaReference
    ) {
      throw new Error(
        "founder bootstrap requires the Granola source to use one verified connection",
      );
    }
  }
  return { capabilities, slackReference, granolaReference };
}

async function assertConfiguredAdaptersValid(
  config: ProductRuntimeConfig,
  ceremony: CeremonyContext,
): Promise<void> {
  const registry = await createConfiguredAdapterRegistry(
    config,
    createDefaultAdapterFactories(),
    {
      credentialResolver: ceremony.credentialResolver,
      now: ceremony.now,
    },
  );
  for (const item of configuredCapabilities(config)) {
    const adapter = registry.get(
      item.capability,
      item.config.adapter_id,
      item.config.instance_id,
    );
    if (adapter === undefined) {
      throw new Error(
        `founder bootstrap adapter is unavailable: ${item.capability}:${item.config.adapter_id}/${item.config.instance_id}`,
      );
    }
    const validation = adapter.validateConfig(item.config);
    if (!validation.ok) {
      throw new Error(
        `founder bootstrap adapter configuration is invalid for ${item.capability}:${item.config.adapter_id}/${item.config.instance_id}: ${validation.errors.join("; ")}`,
      );
    }
  }
}

function createRequest(
  config: ProductRuntimeConfig,
  input: BeginFounderBootstrapInput,
  ids: FounderBootstrapIds,
  createdAt: string,
  build: PackagedBuildIdentityV1,
  ceremony: CeremonyContext,
): FounderBootstrapRequestV1 {
  const configuration = validateBootstrapConfiguration(config);
  const organizationDisplayName = input.organizationDisplayName.trim();
  const principalDisplayName = input.principalDisplayName.trim();
  if (
    organizationDisplayName.length === 0 ||
    organizationDisplayName.length > 200 ||
    principalDisplayName.length === 0 ||
    principalDisplayName.length > 200 ||
    !/^[UW][A-Z0-9]{2,}$/.test(input.slackUserId)
  ) {
    throw new Error("founder bootstrap names or Slack user ID are invalid");
  }
  const reviewer = config.approval_surface!.settings["reviewer"];
  const configuredReviewerUserId =
    reviewer !== null &&
    typeof reviewer === "object" &&
    !Array.isArray(reviewer) &&
    typeof reviewer["slack_user_id"] === "string"
      ? reviewer["slack_user_id"]
      : undefined;
  if (configuredReviewerUserId !== input.slackUserId) {
    throw new Error(
      "founder bootstrap Slack user must match the workspace-scoped approval reviewer",
    );
  }
  const slackCredential = requireCredential(
    ceremony.credentialResolver,
    configuration.slackReference,
    "Slack",
  );
  const granolaCredential = requireCredential(
    ceremony.credentialResolver,
    configuration.granolaReference,
    "Granola",
  );
  const slackConnectionId = ceremony.federationIdFactory("con");
  const granolaConnectionId = ceremony.federationIdFactory("con");
  const connectionByProvider = {
    slack: slackConnectionId,
    granola: granolaConnectionId,
  } as const;
  const bindings: AdapterBindingV1[] = configuration.capabilities.map(
    ({ capability, config: adapter }) => {
      const provider = providerForAdapter(adapter.adapter_id);
      const configurationSnapshot = identityBindingConfigurationSnapshot(
        capability,
        adapter,
      );
      return {
        adapter_binding_id: ceremony.federationIdFactory("bnd"),
        capability,
        adapter_id: adapter.adapter_id,
        instance_id: adapter.instance_id,
        connection_id:
          provider === null ? null : connectionByProvider[provider],
        connection_generation: provider === null ? null : 1,
        configuration_snapshot: configurationSnapshot,
        configuration_sha256: canonicalSha256(configurationSnapshot),
        created_at: createdAt,
        ended_at: null,
        status: "active",
      };
    },
  );
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
  return {
    config_sha256: configDigest(config),
    build,
    created_at: createdAt,
    organization_display_name: organizationDisplayName,
    principal_display_name: principalDisplayName,
    device_class: input.deviceClass ?? "byod",
    slack_user_id: input.slackUserId,
    ids,
    claim_id: ceremony.federationIdFactory("clm"),
    connection_seeds: [
      {
        provider: "slack",
        connection_id: slackConnectionId,
        owner: { kind: "organization", id: ids.organization_id },
        credential_guard: createLocalCredentialGuard(
          configuration.slackReference,
          slackCredential,
        ),
      },
      {
        provider: "granola",
        connection_id: granolaConnectionId,
        owner: { kind: "membership", id: ids.membership_id },
        credential_guard: createLocalCredentialGuard(
          configuration.granolaReference,
          granolaCredential,
        ),
      },
    ],
    bindings,
    publication,
  };
}

function progress(
  session: FounderBootstrapSessionV1,
): FounderBootstrapProgress {
  return {
    session_id: session.session_id,
    phase: session.phase,
    installation_key_id: session.signing_key?.key_id ?? "",
    challenge:
      session.challenge === null
        ? null
        : {
            channel_id: session.challenge.channel_id,
            message_ts: session.challenge.message_ts,
            reaction_name: session.challenge.reaction_name,
            expires_at: session.challenge.expires_at,
          },
    confirmation:
      session.confirmation === null
        ? null
        : {
            confirmation_sha256: session.confirmation.confirmation_sha256,
            summary: session.confirmation.summary,
          },
    result: session.result,
  };
}

async function signedSession(
  payload: Omit<FounderBootstrapSessionV1, "integrity">,
  signer: InstallationSigner,
): Promise<FounderBootstrapSessionV1> {
  const key = payload.signing_key;
  if (key === null)
    throw new Error("bootstrap session cannot be signed without a key");
  return await createSignedDocument(
    payload,
    signer,
    payload.request.ids.installation_id,
    key.key_id,
  );
}

function sameInstallationKey(
  left: InstallationKeyDescriptor,
  right: InstallationKeyDescriptor,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function assertLiveSessionKey(
  session: FounderBootstrapSessionV1,
  signer: InstallationSigner,
): Promise<InstallationKeyDescriptor> {
  const expected = session.signing_key;
  if (expected === null) {
    throw new Error("founder bootstrap session has no installation key");
  }
  const live = await signer.inspect(session.request.ids.installation_id);
  if (live === null) {
    throw new Error("founder bootstrap installation key is unavailable");
  }
  verifyInstallationKeyDescriptor(live);
  if (
    !sameInstallationKey(live, expected) ||
    live.protection !== "secure-enclave" ||
    live.assurance !== "hardware_bound"
  ) {
    throw new Error(
      "founder bootstrap live installation key does not match the signed session",
    );
  }
  await signWithInstallationKey(
    signer,
    live.installation_id,
    live.key_id,
    Buffer.from(
      `echo-founder-bootstrap-live-key-v1\n${session.session_id}\n${session.revision}\n`,
      "utf8",
    ),
  );
  return live;
}

function assertCompletedSessionMatchesActiveBundle(
  config: ProductRuntimeConfig,
  session: FounderBootstrapSessionV1,
): void {
  const completion = session.result;
  if (completion === null) {
    throw new Error("completed founder bootstrap lacks completion evidence");
  }
  const active = new ActiveIdentityBundleStore(config.state_dir).loadVerified(
    config,
  );
  if (
    active === null ||
    active.manifest.organization.organization_id !==
      completion.organization_id ||
    active.manifest.installation.installation_id !==
      completion.installation_id ||
    active.manifest.manifest_id !== completion.manifest_id ||
    canonicalSha256(active.pointer) !== completion.active_bundle_sha256
  ) {
    throw new Error(
      "completed founder bootstrap does not match the verified active identity bundle",
    );
  }
}

async function transition(
  store: FounderBootstrapSessionStore,
  current: FounderBootstrapSessionV1,
  signer: InstallationSigner,
  update: Partial<Omit<FounderBootstrapSessionV1, "integrity" | "revision">>,
): Promise<FounderBootstrapSessionV1> {
  const { integrity: _integrity, ...payload } = current;
  const next = await signedSession(
    {
      ...payload,
      ...update,
      revision: current.revision + 1,
    },
    signer,
  );
  store.write(next);
  return next;
}

async function ensureKeyReady(
  store: FounderBootstrapSessionStore,
  session: FounderBootstrapSessionV1,
  signer: InstallationSigner,
): Promise<FounderBootstrapSessionV1> {
  if (session.phase !== "planned") return session;
  const installationId = session.request.ids.installation_id;
  const key = await signer.generate(installationId);
  verifyInstallationKeyDescriptor(key);
  if (
    key.installation_id !== installationId ||
    key.protection !== "secure-enclave" ||
    key.assurance !== "hardware_bound"
  ) {
    throw new Error("founder bootstrap did not receive a Secure Enclave key");
  }
  return await transition(store, session, signer, {
    phase: "key_ready",
    signing_key: key,
  });
}

function resolveGuardedCredentials(
  session: FounderBootstrapSessionV1,
  resolver: ProductCredentialResolver,
): { slack: string; granola: string } {
  const values = new Map<"slack" | "granola", string>();
  for (const seed of session.request.connection_seeds) {
    const credential = requireCredential(
      resolver,
      seed.credential_guard.reference,
      seed.provider,
    );
    assertLocalCredentialGuardMatches(
      seed.credential_guard,
      seed.credential_guard.reference,
      credential,
    );
    values.set(seed.provider, credential);
  }
  const slack = values.get("slack");
  const granola = values.get("granola");
  if (slack === undefined || granola === undefined) {
    throw new Error("bootstrap session has incomplete credential guards");
  }
  return { slack, granola };
}

function assertCurrentEnvironment(
  config: ProductRuntimeConfig,
  session: FounderBootstrapSessionV1,
  ceremony: CeremonyContext,
): { slack: string; granola: string } {
  if (configDigest(config) !== session.request.config_sha256) {
    throw new Error("runtime configuration changed during founder bootstrap");
  }
  const currentBuild = buildIdentity(ceremony.loadBuildIdentity);
  if (canonicalJson(currentBuild) !== canonicalJson(session.request.build)) {
    throw new Error("packaged build changed during founder bootstrap");
  }
  return resolveGuardedCredentials(session, ceremony.credentialResolver);
}

function sameSlackIdentity(
  left: CapturedSlackProviderIdentityV1,
  right: CapturedSlackProviderIdentityV1,
): boolean {
  assertCapturedSlackProviderIdentity(left);
  assertCapturedSlackProviderIdentity(right);
  return canonicalJson(left.snapshot) === canonicalJson(right.snapshot);
}

async function issueChallenge(
  store: FounderBootstrapSessionStore,
  session: FounderBootstrapSessionV1,
  ceremony: CeremonyContext,
  credentials: { slack: string; granola: string },
): Promise<FounderBootstrapSessionV1> {
  const slackApi = ceremony.slackApiFactory(credentials.slack);
  const slack = await captureSlackProviderIdentity(slackApi, ceremony.now);
  const granola = await observeGranolaConnection(
    ceremony.granolaApiFactory(credentials.granola),
    { now: ceremony.now },
  );
  const issuedAt = ceremony.now();
  const expiresAt = addUtcMilliseconds(issuedAt, ceremony.challengeLifetimeMs);
  const challenge = await issueSlackDmChallenge(
    slackApi,
    slack,
    {
      provider: "slack",
      team_id: slack.snapshot.team_id,
      user_id: session.request.slack_user_id,
    },
    { issuedAt, expiresAt },
  );
  return await transition(store, session, ceremony.signer, {
    phase: "challenge_pending",
    provider_observations: { slack, granola },
    challenge,
  });
}

async function renewChallenge(
  store: FounderBootstrapSessionStore,
  session: FounderBootstrapSessionV1,
  ceremony: CeremonyContext,
  slackCredential: string,
): Promise<FounderBootstrapSessionV1> {
  const observations = session.provider_observations;
  if (observations === null)
    throw new Error("bootstrap provider observations are absent");
  const slackApi = ceremony.slackApiFactory(slackCredential);
  const slack = await captureSlackProviderIdentity(slackApi, ceremony.now);
  if (!sameSlackIdentity(slack, observations.slack)) {
    throw new Error("Slack provider identity changed during founder bootstrap");
  }
  const issuedAt = ceremony.now();
  const challenge = await issueSlackDmChallenge(
    slackApi,
    slack,
    {
      provider: "slack",
      team_id: slack.snapshot.team_id,
      user_id: session.request.slack_user_id,
    },
    {
      issuedAt,
      expiresAt: addUtcMilliseconds(issuedAt, ceremony.challengeLifetimeMs),
    },
  );
  return await transition(store, session, ceremony.signer, {
    provider_observations: { ...observations, slack },
    challenge,
  });
}

export async function beginFounderBootstrap(
  config: ProductRuntimeConfig,
  input: BeginFounderBootstrapInput,
  dependencies: FounderBootstrapCeremonyDependencies = {},
): Promise<FounderBootstrapProgress> {
  const ceremony = context(dependencies);
  const identity = new ActiveIdentityBundleStore(config.state_dir);
  if (
    readFounderCutoverGuard(config.state_dir) !== null ||
    identity.hasActiveBundle() ||
    identity.hasIdentityMaterial()
  ) {
    throw new Error("this state directory already contains identity material");
  }
  const store = new FounderBootstrapSessionStore(config.state_dir);
  const existing = store.list();
  if (existing.length > 0) {
    throw new Error(
      `founder bootstrap session ${existing[0]!.session_id} already exists; resume it with status`,
    );
  }
  await assertConfiguredAdaptersValid(config, ceremony);
  const ids = ceremony.idsFactory();
  const createdAt = ceremony.now();
  const request = createRequest(
    config,
    input,
    ids,
    createdAt,
    buildIdentity(ceremony.loadBuildIdentity),
    ceremony,
  );
  const planned: FounderBootstrapSessionV1 = {
    schema_version: 1,
    kind: "echo-founder-bootstrap-session",
    session_id: ceremony.sessionIdFactory(),
    revision: 1,
    phase: "planned",
    request,
    signing_key: null,
    provider_observations: null,
    challenge: null,
    verification: null,
    confirmation: null,
    commit: null,
    result: null,
    integrity: null,
  };
  store.write(planned);
  try {
    const initial = await ensureKeyReady(store, planned, ceremony.signer);
    const credentials = resolveGuardedCredentials(
      initial,
      ceremony.credentialResolver,
    );
    return progress(
      await issueChallenge(store, initial, ceremony, credentials),
    );
  } catch (error) {
    const sessions = store.list();
    if (sessions.length === 0) {
      const orphan = await ceremony.signer
        .inspect(ids.installation_id)
        .catch(() => null);
      if (orphan !== null) {
        await ceremony.signer
          .deleteOrphan?.(ids.installation_id, orphan.key_id)
          .catch(() => false);
      }
    }
    if (sessions.length > 0) {
      throw new Error(
        `${(error as Error).message}; resume founder bootstrap session ${sessions[0]!.session_id} with status`,
      );
    }
    throw error;
  }
}

export async function statusFounderBootstrap(
  config: ProductRuntimeConfig,
  sessionId: string,
  options: { renewChallenge?: boolean } = {},
  dependencies: FounderBootstrapCeremonyDependencies = {},
): Promise<FounderBootstrapProgress> {
  const ceremony = context(dependencies);
  const store = new FounderBootstrapSessionStore(config.state_dir);
  let session = store.read(sessionId);
  const recoveredPlannedSession = session.phase === "planned";
  session = await ensureKeyReady(store, session, ceremony.signer);
  await assertLiveSessionKey(session, ceremony.signer);
  if (recoveredPlannedSession) return progress(session);
  if (session.phase === "complete") {
    assertCompletedSessionMatchesActiveBundle(config, session);
    return progress(session);
  }
  const credentials = assertCurrentEnvironment(config, session, ceremony);
  if (session.phase === "key_ready") {
    session = await issueChallenge(store, session, ceremony, credentials);
  }
  if (session.phase !== "challenge_pending") return progress(session);
  const observations = session.provider_observations!;
  const slackApi = ceremony.slackApiFactory(credentials.slack);
  const currentSlack = await captureSlackProviderIdentity(
    slackApi,
    ceremony.now,
  );
  if (!sameSlackIdentity(currentSlack, observations.slack)) {
    throw new Error("Slack provider identity changed during founder bootstrap");
  }
  const polled = await pollSlackDmChallenge(slackApi, session.challenge!, {
    maxAttempts: 1,
    pollIntervalMs: STATUS_POLL_INTERVAL_MS,
    now: ceremony.now,
  });
  if (polled.status === "expired") {
    if (options.renewChallenge !== true) return progress(session);
    return progress(
      await renewChallenge(store, session, ceremony, credentials.slack),
    );
  }
  if (polled.status === "not_observed") return progress(session);
  const readyAt = ceremony.now();
  const summary = buildFounderBootstrapConfirmationSummary(session);
  session = await transition(store, session, ceremony.signer, {
    phase: "ready_for_confirmation",
    verification: polled.verification,
    confirmation: {
      summary,
      confirmation_sha256: canonicalSha256(summary),
      ready_at: readyAt,
    },
  });
  return progress(session);
}

export async function abortFounderBootstrap(
  config: ProductRuntimeConfig,
  sessionId: string,
  expectedKeyId: string,
  dependencies: FounderBootstrapCeremonyDependencies = {},
): Promise<FounderBootstrapAbortResult> {
  const ceremony = context(dependencies);
  const identity = new ActiveIdentityBundleStore(config.state_dir);
  if (
    readFounderCutoverGuard(config.state_dir) !== null ||
    identity.hasActiveBundle() ||
    identity.hasIdentityMaterial()
  ) {
    throw new Error(
      "founder bootstrap cannot be aborted after identity material exists",
    );
  }
  const store = new FounderBootstrapSessionStore(config.state_dir);
  const session = store.read(sessionId);
  if (session.phase === "committing" || session.phase === "complete") {
    throw new Error(
      "founder bootstrap cannot be aborted after activation commit begins",
    );
  }
  if (session.phase === "planned") {
    const installationId = session.request.ids.installation_id;
    const live = await ceremony.signer.inspect(installationId);
    if (live === null) {
      if (expectedKeyId !== `session:${session.session_id}`) {
        throw new Error(
          `planned bootstrap has no installation key; rerun abort with --confirm session:${session.session_id}`,
        );
      }
      store.discard(session.session_id, session.revision);
      return {
        aborted: true,
        session_id: session.session_id,
        installation_id: installationId,
        installation_key_id: null,
        key_deleted: false,
      };
    }
    verifyInstallationKeyDescriptor(live);
    if (
      live.installation_id !== installationId ||
      live.protection !== "secure-enclave" ||
      live.assurance !== "hardware_bound"
    ) {
      throw new Error(
        "planned bootstrap found an invalid installation key; session retained",
      );
    }
    if (expectedKeyId !== live.key_id) {
      throw new Error(
        `planned bootstrap has installation key ${live.key_id}; rerun abort with that exact fingerprint`,
      );
    }
    if (ceremony.signer.deleteOrphan === undefined) {
      throw new Error(
        "founder bootstrap signer cannot safely delete an aborted installation key",
      );
    }
    await ceremony.signer.deleteOrphan(installationId, live.key_id);
    if ((await ceremony.signer.inspect(installationId)) !== null) {
      throw new Error(
        "founder bootstrap installation key was not deleted; session retained",
      );
    }
    store.discard(session.session_id, session.revision);
    return {
      aborted: true,
      session_id: session.session_id,
      installation_id: installationId,
      installation_key_id: live.key_id,
      key_deleted: true,
    };
  }
  const key = session.signing_key!;
  if (expectedKeyId !== key.key_id) {
    throw new Error(
      "founder bootstrap abort confirmation does not match the installation key fingerprint",
    );
  }
  const live = await ceremony.signer.inspect(key.installation_id);
  let keyDeleted = false;
  if (live !== null) {
    await assertLiveSessionKey(session, ceremony.signer);
    if (ceremony.signer.deleteOrphan === undefined) {
      throw new Error(
        "founder bootstrap signer cannot safely delete an aborted installation key",
      );
    }
    await ceremony.signer.deleteOrphan(key.installation_id, key.key_id);
    const remaining = await ceremony.signer.inspect(key.installation_id);
    if (remaining !== null) {
      throw new Error(
        "founder bootstrap installation key was not deleted; session retained",
      );
    }
    keyDeleted = true;
  }
  store.discard(session.session_id, session.revision);
  return {
    aborted: true,
    session_id: session.session_id,
    installation_id: key.installation_id,
    installation_key_id: key.key_id,
    key_deleted: keyDeleted,
  };
}

export async function commitFounderBootstrapCeremony(
  config: ProductRuntimeConfig,
  sessionId: string,
  confirmationSha256: string,
  dependencies: FounderBootstrapCeremonyDependencies = {},
): Promise<FounderBootstrapProgress> {
  const ceremony = context(dependencies);
  const store = new FounderBootstrapSessionStore(config.state_dir);
  let session = store.read(sessionId);
  if (session.phase === "planned") {
    throw new Error(
      "founder bootstrap key recovery is incomplete; run identity-bootstrap status first",
    );
  }
  await assertLiveSessionKey(session, ceremony.signer);
  if (
    session.confirmation === null ||
    session.confirmation.confirmation_sha256 !== confirmationSha256
  ) {
    throw new Error("founder bootstrap confirmation digest does not match");
  }
  if (session.phase === "complete") {
    assertCompletedSessionMatchesActiveBundle(config, session);
    return progress(session);
  }
  const credentials = assertCurrentEnvironment(config, session, ceremony);
  if (
    session.phase !== "ready_for_confirmation" &&
    session.phase !== "committing"
  ) {
    throw new Error("founder bootstrap is not ready for confirmation");
  }
  const currentSlack = await captureSlackProviderIdentity(
    ceremony.slackApiFactory(credentials.slack),
    ceremony.now,
  );
  if (
    session.provider_observations === null ||
    !sameSlackIdentity(currentSlack, session.provider_observations.slack)
  ) {
    throw new Error("Slack provider identity changed before bootstrap commit");
  }
  if (session.phase === "ready_for_confirmation") {
    const confirmedAt =
      (await ceremony.recoverSeedCutoverConfirmedAt({ config, session })) ??
      ceremony.now();
    const plan = deriveFounderBootstrapPlanFromSession(session, confirmedAt);
    await ceremony.authorizeSeedCutover({ config, session, plan });
    const planSha256 = canonicalSha256(plan);
    commitFounderCutoverGuard(config.state_dir, session, planSha256);
    session = await transition(store, session, ceremony.signer, {
      phase: "committing",
      commit: {
        confirmed_at: confirmedAt,
        confirmation_sha256: session.confirmation.confirmation_sha256,
        plan_sha256: planSha256,
        plan,
      },
    });
  }
  commitFounderCutoverGuard(config.state_dir, session);
  await ceremony.authorizeSeedCutover({
    config,
    session,
    plan: session.commit!.plan,
  });
  const result = await commitFounderIdentityBundle(
    config,
    session.commit!.plan,
    ceremony.signer,
    { loadBuildIdentity: ceremony.loadBuildIdentity },
  );
  await ceremony.finalizeSeedCutover({
    config,
    session,
    plan: session.commit!.plan,
    result,
  });
  const completedAt = ceremony.now();
  session = await transition(store, session, ceremony.signer, {
    phase: "complete",
    result: {
      completed_at: completedAt,
      organization_id: result.manifest.organization.organization_id,
      installation_id: result.manifest.installation.installation_id,
      manifest_id: result.manifest.manifest_id,
      active_bundle_sha256: canonicalSha256(result.active),
    },
  });
  return progress(session);
}
