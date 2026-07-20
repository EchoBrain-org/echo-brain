import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.js";
import {
  assertPrivateOwnedDirectory,
  ensureDirectory,
  pathEntryExists,
  readFileNoFollow,
} from "../secure-local-files.js";
import { resolveProductStatePaths } from "../paths.js";
import {
  assertFounderBootstrapPlan,
  planFounderBootstrap,
  type FounderBootstrapIds,
  type FounderBootstrapInput,
  type FounderBootstrapPlan,
} from "./bootstrap.js";
import type { PackagedBuildIdentityV1 } from "./build-identity.js";
import { validatePackagedBuildIdentity } from "./build-identity.js";
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
} from "./canonical-json.js";
import {
  assertLocalCredentialGuard,
  type LocalCredentialGuardV1,
} from "./credential-guard.js";
import type {
  AdapterBindingV1,
  IdentityClaimV1,
  IdentityOwnerV1,
  PublicationSnapshotV1,
  SignedIntegrity,
  ToolConnectionV1,
} from "./contracts.js";
import {
  assertGranolaProviderIdentitySnapshot,
  type GranolaProviderIdentitySnapshotV1,
} from "./granola-connection-evidence.js";
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
} from "./identifiers.js";
import type { InstallationKeyDescriptor } from "./installation-signer.js";
import { verifyInstallationKeyDescriptor } from "./installation-signer.js";
import type {
  SlackDmChallengeTicketV1,
  SlackDmChallengeVerificationV1,
} from "./slack-dm-challenge.js";
import {
  assertSlackDmChallengeTicket,
  assertSlackDmChallengeVerification,
} from "./slack-dm-challenge.js";
import {
  assertCapturedSlackProviderIdentity,
  type CapturedSlackProviderIdentityV1,
} from "./slack-provider-identity.js";
import { verifySignedDocument } from "./signed-document.js";
import { assertExactFounderBootstrapSessionShape } from "./bootstrap-session-exact-shape.js";

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_FILE_RE = /^session\.([0-9a-f-]{36})\.v1\.json$/;
const SESSION_TEMP_FILE_RE =
  /^session\.([0-9a-f-]{36})\.v1\.json\.([1-9][0-9]*)\.([0-9a-f-]{36})\.tmp$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_SESSION_BYTES = 1024 * 1024;

export type FounderBootstrapSessionPhase =
  | "planned"
  | "key_ready"
  | "challenge_pending"
  | "ready_for_confirmation"
  | "committing"
  | "complete";

export interface FounderBootstrapConnectionSeedV1 {
  provider: "slack" | "granola";
  connection_id: string;
  owner: IdentityOwnerV1;
  credential_guard: LocalCredentialGuardV1;
}

export interface FounderBootstrapRequestV1 {
  config_sha256: `sha256:${string}`;
  build: PackagedBuildIdentityV1;
  created_at: string;
  organization_display_name: string;
  principal_display_name: string;
  device_class: "byod" | "managed";
  slack_user_id: string;
  ids: FounderBootstrapIds;
  claim_id: string;
  connection_seeds: readonly FounderBootstrapConnectionSeedV1[];
  bindings: readonly AdapterBindingV1[];
  publication: PublicationSnapshotV1;
}

export interface FounderBootstrapProviderObservationsV1 {
  slack: CapturedSlackProviderIdentityV1;
  granola: GranolaProviderIdentitySnapshotV1;
}

export type FounderBootstrapBindingSummaryV1 = Pick<
  AdapterBindingV1,
  | "adapter_binding_id"
  | "capability"
  | "adapter_id"
  | "instance_id"
  | "connection_id"
  | "connection_generation"
  | "configuration_snapshot"
  | "configuration_sha256"
>;

export interface FounderBootstrapConfirmationSummaryV1 {
  organization: {
    organization_id: string;
    display_name: string;
  };
  founder: {
    principal_id: string;
    membership_id: string;
    display_name: string;
    slack_team_id: string;
    slack_user_id: string;
    assurance: "provider_challenge_observed";
  };
  installation: {
    installation_id: string;
    device_id: string;
    key_id: `sha256:${string}`;
    key_protection: "secure-enclave";
  };
  providers: {
    slack: { team_id: string; assurance: "provider_verified" };
    granola: { tenant: null; assurance: "credential_observed" };
  };
  configuration: {
    runtime_config_sha256: `sha256:${string}`;
    bindings: readonly FounderBootstrapBindingSummaryV1[];
  };
  publication: PublicationSnapshotV1;
  cutover: {
    before: "disposable_test_or_legacy_imported_unverified";
    after: "native_attributed_only_when_strict_green";
  };
}

export interface FounderBootstrapConfirmationV1 {
  summary: FounderBootstrapConfirmationSummaryV1;
  confirmation_sha256: `sha256:${string}`;
  ready_at: string;
}

export interface FounderBootstrapCommitV1 {
  confirmed_at: string;
  confirmation_sha256: `sha256:${string}`;
  plan_sha256: `sha256:${string}`;
  plan: FounderBootstrapPlan;
}

export interface FounderBootstrapCompletionV1 {
  completed_at: string;
  organization_id: string;
  installation_id: string;
  manifest_id: string;
  active_bundle_sha256: `sha256:${string}`;
}

export interface FounderBootstrapSessionV1 {
  schema_version: 1;
  kind: "echo-founder-bootstrap-session";
  session_id: string;
  revision: number;
  phase: FounderBootstrapSessionPhase;
  request: FounderBootstrapRequestV1;
  signing_key: InstallationKeyDescriptor | null;
  provider_observations: FounderBootstrapProviderObservationsV1 | null;
  challenge: SlackDmChallengeTicketV1 | null;
  verification: SlackDmChallengeVerificationV1 | null;
  confirmation: FounderBootstrapConfirmationV1 | null;
  commit: FounderBootstrapCommitV1 | null;
  result: FounderBootstrapCompletionV1 | null;
  integrity: SignedIntegrity | null;
}

function assertAtOrAfter(later: string, earlier: string, label: string): void {
  assertUtcMillisecondTimestamp(later, `${label} later timestamp`);
  assertUtcMillisecondTimestamp(earlier, `${label} earlier timestamp`);
  if (Date.parse(later) < Date.parse(earlier)) {
    throw new Error(`${label} is chronologically invalid`);
  }
}

function activatedBindings(
  session: FounderBootstrapSessionV1,
  activationAt: string,
): readonly AdapterBindingV1[] {
  assertUtcMillisecondTimestamp(
    activationAt,
    "founder bootstrap activation_at",
  );
  return session.request.bindings.map((binding) => ({
    ...binding,
    created_at: activationAt,
  }));
}

export function buildFounderBootstrapConfirmationSummary(
  session: FounderBootstrapSessionV1,
): FounderBootstrapConfirmationSummaryV1 {
  const observations = session.provider_observations;
  const signingKey = session.signing_key;
  if (observations === null || signingKey === null) {
    throw new Error(
      "bootstrap confirmation requires provider and key evidence",
    );
  }
  return {
    organization: {
      organization_id: session.request.ids.organization_id,
      display_name: session.request.organization_display_name,
    },
    founder: {
      principal_id: session.request.ids.principal_id,
      membership_id: session.request.ids.membership_id,
      display_name: session.request.principal_display_name,
      slack_team_id: observations.slack.snapshot.team_id,
      slack_user_id: session.request.slack_user_id,
      assurance: "provider_challenge_observed",
    },
    installation: {
      installation_id: session.request.ids.installation_id,
      device_id: session.request.ids.device_id,
      key_id: signingKey.key_id,
      key_protection: "secure-enclave",
    },
    providers: {
      slack: {
        team_id: observations.slack.snapshot.team_id,
        assurance: "provider_verified",
      },
      granola: { tenant: null, assurance: "credential_observed" },
    },
    configuration: {
      runtime_config_sha256: session.request.config_sha256,
      bindings: session.request.bindings.map(
        ({
          created_at: _createdAt,
          ended_at: _endedAt,
          status: _status,
          ...binding
        }) => binding,
      ),
    },
    publication: session.request.publication,
    cutover: {
      before: "disposable_test_or_legacy_imported_unverified",
      after: "native_attributed_only_when_strict_green",
    },
  };
}

function connectionsFromSession(
  session: FounderBootstrapSessionV1,
  activationAt: string,
): readonly ToolConnectionV1[] {
  const observations = session.provider_observations;
  if (observations === null) {
    throw new Error("bootstrap provider evidence is absent");
  }
  return session.request.connection_seeds.map((seed): ToolConnectionV1 => ({
    connection_id: seed.connection_id,
    organization_id: session.request.ids.organization_id,
    owner: seed.owner,
    provider: seed.provider,
    generations: [
      {
        generation: 1,
        active_from: activationAt,
        ended_at: null,
        provider_identity:
          seed.provider === "slack"
            ? observations.slack.provider_identity
            : observations.granola.provider_identity,
        local_credential_guard: seed.credential_guard,
      },
    ],
  }));
}

export function deriveFounderBootstrapPlanFromSession(
  session: FounderBootstrapSessionV1,
  confirmedAt: string,
): FounderBootstrapPlan {
  const verification = session.verification;
  const confirmation = session.confirmation;
  const signingKey = session.signing_key;
  if (verification === null || confirmation === null || signingKey === null) {
    throw new Error(
      "bootstrap plan requires verification, confirmation, and signing key",
    );
  }
  assertAtOrAfter(
    confirmedAt,
    confirmation.ready_at,
    "bootstrap confirmation after readiness",
  );
  const claim: IdentityClaimV1 = {
    claim_id: session.request.claim_id,
    principal_id: session.request.ids.principal_id,
    ...verification.claim_assertion,
  };
  const input: FounderBootstrapInput = {
    ids: session.request.ids,
    organization_display_name: session.request.organization_display_name,
    principal_display_name: session.request.principal_display_name,
    device_class: session.request.device_class,
    created_at: confirmedAt,
    identity_claims: [claim],
    connections: connectionsFromSession(session, confirmedAt),
    bindings: activatedBindings(session, confirmedAt),
    publication: session.request.publication,
  };
  return planFounderBootstrap(input, signingKey, {
    loadBuildIdentity: () => session.request.build,
  });
}

function nonBlank(value: string, label: string): void {
  if (value.trim() === "" || value.length > 200) {
    throw new Error(`${label} must contain 1-200 characters`);
  }
}

function validateOwner(value: IdentityOwnerV1, label: string): void {
  if (value.kind !== "organization" && value.kind !== "membership") {
    throw new Error(`${label} kind is invalid`);
  }
  assertFederationId(
    value.id,
    value.kind === "organization" ? "org" : "mem",
    `${label}.id`,
  );
}

function validatePublication(value: PublicationSnapshotV1): void {
  if (
    value.payload_scope !==
      "approved-signal-with-meeting-context-brief-digest-and-bounded-evidence" ||
    (value.sensitivity !== "internal" &&
      value.sensitivity !== "confidential" &&
      value.sensitivity !== "restricted") ||
    value.raw_meeting_content !== "local-only" ||
    (value.participant_observations !== "included-namespaced" &&
      value.participant_observations !== "excluded")
  ) {
    throw new Error("bootstrap publication values are invalid");
  }
  if (
    value.audience.scope !== "organization" &&
    value.audience.scope !== "named-subjects"
  ) {
    throw new Error("bootstrap audience is invalid");
  }
  for (const subject of value.audience.subjects) {
    validateOwner(subject, "bootstrap audience subject");
  }
  if (value.retention.kind === "duration" && value.retention.days <= 0) {
    throw new Error("bootstrap retention is invalid");
  }
}

function validateBinding(value: AdapterBindingV1): void {
  assertFederationId(value.adapter_binding_id, "bnd", "adapter_binding_id");
  if (
    ![
      "meeting-source",
      "decision-processor",
      "approval-surface",
      "delivery-surface",
    ].includes(value.capability) ||
    value.adapter_id.trim() === "" ||
    value.instance_id.trim() === "" ||
    !DIGEST_RE.test(value.configuration_sha256) ||
    canonicalSha256(value.configuration_snapshot) !==
      value.configuration_sha256 ||
    value.status !== "active" ||
    value.ended_at !== null
  ) {
    throw new Error("bootstrap binding is invalid");
  }
  assertUtcMillisecondTimestamp(
    value.created_at,
    "bootstrap binding created_at",
  );
  if (value.connection_id === null) {
    if (value.connection_generation !== null) {
      throw new Error("bootstrap binding has a dangling credential generation");
    }
  } else {
    assertFederationId(value.connection_id, "con", "connection_id");
    if (value.connection_generation !== 1) {
      throw new Error(
        "bootstrap binding must use initial connection generation",
      );
    }
  }
}

function validateRequest(value: FounderBootstrapRequestV1): void {
  if (!DIGEST_RE.test(value.config_sha256)) {
    throw new Error("bootstrap session config digest is invalid");
  }
  validatePackagedBuildIdentity(value.build);
  assertUtcMillisecondTimestamp(value.created_at, "bootstrap created_at");
  nonBlank(value.organization_display_name, "organization display name");
  nonBlank(value.principal_display_name, "principal display name");
  if (value.device_class !== "byod" && value.device_class !== "managed") {
    throw new Error("bootstrap device class is invalid");
  }
  if (!/^[UW][A-Z0-9]{2,}$/.test(value.slack_user_id)) {
    throw new Error("bootstrap Slack user ID is invalid");
  }
  for (const [key, prefix] of [
    ["organization_id", "org"],
    ["principal_id", "prn"],
    ["membership_id", "mem"],
    ["device_id", "dev"],
    ["installation_id", "ins"],
    ["manifest_id", "idm"],
    ["registry_id", "reg"],
    ["policy_id", "pol"],
  ] as const) {
    assertFederationId(value.ids[key], prefix, key);
  }
  assertFederationId(value.claim_id, "clm", "claim_id");
  const providers = new Set<string>();
  const connectionIds = new Set<string>();
  for (const seed of value.connection_seeds) {
    if (seed.provider !== "slack" && seed.provider !== "granola") {
      throw new Error("bootstrap connection provider is invalid");
    }
    providers.add(seed.provider);
    assertFederationId(seed.connection_id, "con", "connection_id");
    if (connectionIds.has(seed.connection_id)) {
      throw new Error("bootstrap connection IDs must be unique");
    }
    connectionIds.add(seed.connection_id);
    validateOwner(seed.owner, "bootstrap connection owner");
    assertLocalCredentialGuard(seed.credential_guard);
  }
  if (!providers.has("slack") || !providers.has("granola")) {
    throw new Error("bootstrap connection seeds must cover Slack and Granola");
  }
  const bindingIds = new Set<string>();
  for (const binding of value.bindings) {
    validateBinding(binding);
    if (bindingIds.has(binding.adapter_binding_id)) {
      throw new Error("bootstrap binding IDs must be unique");
    }
    bindingIds.add(binding.adapter_binding_id);
    if (
      binding.connection_id !== null &&
      !connectionIds.has(binding.connection_id)
    ) {
      throw new Error("bootstrap binding refers to an unknown connection seed");
    }
  }
  validatePublication(value.publication);
}

function assertPhaseShape(session: FounderBootstrapSessionV1): void {
  const signed = session.phase !== "planned";
  if (signed !== (session.signing_key !== null && session.integrity !== null)) {
    throw new Error("bootstrap session signing state disagrees with its phase");
  }
  const providersRequired =
    session.phase === "challenge_pending" ||
    session.phase === "ready_for_confirmation" ||
    session.phase === "committing" ||
    session.phase === "complete";
  const verificationRequired =
    session.phase === "ready_for_confirmation" ||
    session.phase === "committing" ||
    session.phase === "complete";
  const commitRequired =
    session.phase === "committing" || session.phase === "complete";
  if (
    (session.provider_observations === null) !== (session.challenge === null) ||
    (session.verification === null) !== (session.confirmation === null) ||
    providersRequired !== (session.provider_observations !== null) ||
    verificationRequired !== (session.verification !== null) ||
    commitRequired !== (session.commit !== null) ||
    (session.phase === "complete") !== (session.result !== null)
  ) {
    throw new Error("bootstrap session fields disagree with its phase");
  }
}

function validateObservedState(session: FounderBootstrapSessionV1): void {
  const observations = session.provider_observations;
  const challenge = session.challenge;
  if (observations !== null && challenge !== null) {
    assertCapturedSlackProviderIdentity(observations.slack);
    assertGranolaProviderIdentitySnapshot(observations.granola);
    assertSlackDmChallengeTicket(challenge);
    assertAtOrAfter(
      observations.slack.provider_identity.verification.verified_at,
      session.request.created_at,
      "Slack provider observation after bootstrap request",
    );
    assertAtOrAfter(
      observations.granola.provider_identity.verification.verified_at,
      session.request.created_at,
      "Granola provider observation after bootstrap request",
    );
    assertAtOrAfter(
      challenge.issued_at,
      observations.slack.provider_identity.verification.verified_at,
      "Slack challenge after provider verification",
    );
    assertAtOrAfter(
      challenge.issued_at,
      observations.granola.provider_identity.verification.verified_at,
      "Slack challenge after Granola observation",
    );
    if (
      observations.slack.snapshot.team_id !== challenge.tenant_id ||
      observations.slack.snapshot.enterprise_id !== challenge.enterprise_id ||
      observations.slack.snapshot.bot_user_id !== challenge.bot_user_id ||
      observations.slack.snapshot.bot_id !== challenge.bot_id ||
      observations.slack.snapshot.app_id !== challenge.app_id ||
      observations.slack.evidence_sha256 !==
        challenge.auth_test_evidence_sha256 ||
      session.request.slack_user_id !== challenge.subject_id
    ) {
      throw new Error(
        "bootstrap challenge disagrees with provider observations",
      );
    }
  }
  if (session.verification !== null && challenge !== null) {
    assertSlackDmChallengeVerification(challenge, session.verification);
  }
  const confirmation = session.confirmation;
  if (confirmation !== null) {
    if (
      canonicalSha256(confirmation.summary) !== confirmation.confirmation_sha256
    ) {
      throw new Error("bootstrap confirmation digest is invalid");
    }
    assertUtcMillisecondTimestamp(
      confirmation.ready_at,
      "bootstrap confirmation ready_at",
    );
    if (session.verification === null) {
      throw new Error("bootstrap confirmation lacks human verification");
    }
    assertAtOrAfter(
      confirmation.ready_at,
      session.verification.claim_assertion.verification.verified_at,
      "bootstrap readiness after human verification",
    );
    const expectedSummary = buildFounderBootstrapConfirmationSummary(session);
    if (
      canonicalJson(confirmation.summary) !== canonicalJson(expectedSummary)
    ) {
      throw new Error(
        "bootstrap confirmation summary disagrees with the session",
      );
    }
  }
  const commit = session.commit;
  if (commit !== null) {
    if (
      commit.confirmation_sha256 !== confirmation?.confirmation_sha256 ||
      commit.plan_sha256 !== canonicalSha256(commit.plan)
    ) {
      throw new Error("bootstrap commit record is invalid");
    }
    assertUtcMillisecondTimestamp(
      commit.confirmed_at,
      "bootstrap confirmed_at",
    );
    assertFounderBootstrapPlan(commit.plan);
    const expectedPlan = deriveFounderBootstrapPlanFromSession(
      session,
      commit.confirmed_at,
    );
    if (canonicalJson(commit.plan) !== canonicalJson(expectedPlan)) {
      throw new Error("bootstrap commit plan disagrees with the session");
    }
  }
  const result = session.result;
  if (result !== null) {
    if (
      result.organization_id !== session.request.ids.organization_id ||
      result.installation_id !== session.request.ids.installation_id ||
      result.manifest_id !== session.request.ids.manifest_id ||
      !DIGEST_RE.test(result.active_bundle_sha256)
    ) {
      throw new Error("bootstrap completion record is invalid");
    }
    assertUtcMillisecondTimestamp(
      result.completed_at,
      "bootstrap completed_at",
    );
    if (commit === null) {
      throw new Error("bootstrap completion lacks a commit record");
    }
    assertAtOrAfter(
      result.completed_at,
      commit.confirmed_at,
      "bootstrap completion after confirmation",
    );
  }
}

export function validateFounderBootstrapSession(
  value: unknown,
): FounderBootstrapSessionV1 {
  assertExactFounderBootstrapSessionShape(value);
  const session = value as FounderBootstrapSessionV1;
  if (
    session.schema_version !== 1 ||
    session.kind !== "echo-founder-bootstrap-session" ||
    !SESSION_ID_RE.test(session.session_id) ||
    session.revision < 1 ||
    ![
      "planned",
      "key_ready",
      "challenge_pending",
      "ready_for_confirmation",
      "committing",
      "complete",
    ].includes(session.phase)
  ) {
    throw new Error("bootstrap session header is invalid");
  }
  validateRequest(session.request);
  assertPhaseShape(session);
  if (session.signing_key !== null) {
    const publicKey = verifyInstallationKeyDescriptor(session.signing_key);
    if (
      session.signing_key.installation_id !==
        session.request.ids.installation_id ||
      session.signing_key.protection !== "secure-enclave" ||
      session.signing_key.assurance !== "hardware_bound"
    ) {
      throw new Error(
        "bootstrap session is not bound to its Secure Enclave key",
      );
    }
    verifySignedDocument(
      session as unknown as FounderBootstrapSessionV1 & {
        integrity: SignedIntegrity;
      },
      publicKey,
      session.signing_key.key_id,
    );
  }
  validateObservedState(session);
  return session;
}

function assertFounderBootstrapSessionTransition(
  current: FounderBootstrapSessionV1,
  next: FounderBootstrapSessionV1,
): void {
  if (
    current.session_id !== next.session_id ||
    canonicalJson(current.request) !== canonicalJson(next.request) ||
    (current.phase !== "planned" &&
      canonicalJson(current.signing_key) !== canonicalJson(next.signing_key))
  ) {
    throw new Error(
      "bootstrap session transition changed immutable enrollment facts",
    );
  }
  const transition = `${current.phase}->${next.phase}`;
  if (
    transition !== "planned->key_ready" &&
    transition !== "key_ready->challenge_pending" &&
    transition !== "challenge_pending->challenge_pending" &&
    transition !== "challenge_pending->ready_for_confirmation" &&
    transition !== "ready_for_confirmation->committing" &&
    transition !== "committing->complete"
  ) {
    throw new Error(`bootstrap session transition ${transition} is invalid`);
  }
  if (
    transition === "challenge_pending->challenge_pending" &&
    canonicalJson(current.provider_observations?.granola) !==
      canonicalJson(next.provider_observations?.granola)
  ) {
    throw new Error(
      "bootstrap challenge renewal changed Granola provider evidence",
    );
  }
  if (
    transition === "challenge_pending->ready_for_confirmation" &&
    (canonicalJson(current.provider_observations) !==
      canonicalJson(next.provider_observations) ||
      canonicalJson(current.challenge) !== canonicalJson(next.challenge))
  ) {
    throw new Error(
      "bootstrap human verification changed its provider challenge facts",
    );
  }
  if (
    transition === "ready_for_confirmation->committing" &&
    (canonicalJson(current.provider_observations) !==
      canonicalJson(next.provider_observations) ||
      canonicalJson(current.challenge) !== canonicalJson(next.challenge) ||
      canonicalJson(current.verification) !==
        canonicalJson(next.verification) ||
      canonicalJson(current.confirmation) !== canonicalJson(next.confirmation))
  ) {
    throw new Error(
      "bootstrap commit transition changed founder-confirmed facts",
    );
  }
  if (
    transition === "committing->complete" &&
    (canonicalJson(current.provider_observations) !==
      canonicalJson(next.provider_observations) ||
      canonicalJson(current.challenge) !== canonicalJson(next.challenge) ||
      canonicalJson(current.verification) !==
        canonicalJson(next.verification) ||
      canonicalJson(current.confirmation) !==
        canonicalJson(next.confirmation) ||
      canonicalJson(current.commit) !== canonicalJson(next.commit))
  ) {
    throw new Error(
      "bootstrap completion transition changed the committed activation plan",
    );
  }
}

function sessionFilename(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId))
    throw new Error("bootstrap session ID is invalid");
  return `session.${sessionId}.v1.json`;
}

export class FounderBootstrapSessionStore {
  readonly directory: string;

  constructor(stateDirectory: string) {
    this.directory =
      resolveProductStatePaths(stateDirectory).founderIdentityBootstrap;
  }

  prepare(): void {
    ensureDirectory(this.directory, 0o700);
    assertPrivateOwnedDirectory(this.directory, "founder bootstrap directory");
  }

  private syncDirectory(): void {
    const descriptor = openSync(this.directory, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private readPath(
    path: string,
    expectedSessionId: string,
    label: string,
  ): FounderBootstrapSessionV1 {
    const state = lstatSync(path);
    const currentUid = process.getuid?.();
    if (
      state.isSymbolicLink() ||
      !state.isFile() ||
      state.nlink !== 1 ||
      (state.mode & 0o777) !== 0o600 ||
      state.size <= 0 ||
      state.size > MAX_SESSION_BYTES ||
      currentUid === undefined ||
      state.uid !== currentUid
    ) {
      throw new Error(
        `${label} must be a bounded current-user file with mode 0600`,
      );
    }
    const raw = readFileNoFollow(path, label).toString("utf8");
    const session = validateFounderBootstrapSession(parseCanonicalJson(raw));
    if (session.session_id !== expectedSessionId) {
      throw new Error(`${label} filename disagrees with its signed session ID`);
    }
    return session;
  }

  private readCanonical(sessionId: string): FounderBootstrapSessionV1 {
    const path = join(this.directory, sessionFilename(sessionId));
    return this.readPath(path, sessionId, "founder bootstrap session");
  }

  private recoverInterruptedWrites(): void {
    if (!pathEntryExists(this.directory)) return;
    assertPrivateOwnedDirectory(this.directory, "founder bootstrap directory");
    const temporary = new Map<string, string[]>();
    for (const filename of readdirSync(this.directory)) {
      const match = SESSION_TEMP_FILE_RE.exec(filename);
      if (match === null) continue;
      const sessionId = match[1]!;
      if (!SESSION_ID_RE.test(sessionId)) {
        throw new Error("founder bootstrap temporary session ID is invalid");
      }
      const candidates = temporary.get(sessionId) ?? [];
      candidates.push(filename);
      temporary.set(sessionId, candidates);
    }
    for (const [sessionId, candidates] of temporary) {
      if (candidates.length !== 1) {
        throw new Error(
          "founder bootstrap has ambiguous interrupted session writes",
        );
      }
      const temporaryPath = join(this.directory, candidates[0]!);
      const interrupted = this.readPath(
        temporaryPath,
        sessionId,
        "founder bootstrap interrupted session",
      );
      const canonicalPath = join(this.directory, sessionFilename(sessionId));
      if (!pathEntryExists(canonicalPath)) {
        if (interrupted.revision !== 1) {
          throw new Error(
            "founder bootstrap interrupted session lacks its prior revision",
          );
        }
        renameSync(temporaryPath, canonicalPath);
        this.syncDirectory();
        continue;
      }
      const current = this.readCanonical(sessionId);
      if (interrupted.revision < current.revision) {
        unlinkSync(temporaryPath);
        this.syncDirectory();
        continue;
      }
      if (interrupted.revision === current.revision) {
        if (canonicalJson(interrupted) !== canonicalJson(current)) {
          throw new Error(
            "founder bootstrap interrupted session conflicts with its durable revision",
          );
        }
        unlinkSync(temporaryPath);
        this.syncDirectory();
        continue;
      }
      if (interrupted.revision !== current.revision + 1) {
        throw new Error(
          "founder bootstrap interrupted session skipped a durable revision",
        );
      }
      assertFounderBootstrapSessionTransition(current, interrupted);
      renameSync(temporaryPath, canonicalPath);
      this.syncDirectory();
    }
  }

  list(): readonly FounderBootstrapSessionV1[] {
    if (!pathEntryExists(this.directory)) return [];
    this.recoverInterruptedWrites();
    assertPrivateOwnedDirectory(this.directory, "founder bootstrap directory");
    return readdirSync(this.directory).map((filename) => {
      const match = SESSION_FILE_RE.exec(filename);
      if (match === null || !SESSION_ID_RE.test(match[1]!)) {
        throw new Error(
          "founder bootstrap directory contains an unexpected entry",
        );
      }
      return this.readCanonical(match[1]!);
    });
  }

  read(sessionId: string): FounderBootstrapSessionV1 {
    this.recoverInterruptedWrites();
    return this.readCanonical(sessionId);
  }

  write(session: FounderBootstrapSessionV1): void {
    this.prepare();
    validateFounderBootstrapSession(session);
    const path = join(this.directory, sessionFilename(session.session_id));
    const raw = canonicalJson(session);
    const size = Buffer.byteLength(raw, "utf8");
    if (size <= 0 || size > MAX_SESSION_BYTES) {
      throw new Error(
        `founder bootstrap session must contain 1-${MAX_SESSION_BYTES} bytes`,
      );
    }
    if (pathEntryExists(path)) {
      const existing = this.readCanonical(session.session_id);
      const existingRaw = canonicalJson(existing);
      if (existingRaw === raw) return;
      if (session.revision !== existing.revision + 1) {
        throw new Error(
          "bootstrap session revision is not the next durable revision",
        );
      }
      assertFounderBootstrapSessionTransition(existing, session);
    } else if (session.revision !== 1) {
      throw new Error("new bootstrap session must begin at revision 1");
    }
    atomicWrite({ filePath: path, content: raw, secretSensitive: true });
  }

  discard(sessionId: string, expectedRevision: number): void {
    this.recoverInterruptedWrites();
    const session = this.readCanonical(sessionId);
    if (session.revision !== expectedRevision) {
      throw new Error(
        "bootstrap session changed before it could be safely discarded",
      );
    }
    unlinkSync(join(this.directory, sessionFilename(sessionId)));
    this.syncDirectory();
  }
}
