import { randomBytes } from "node:crypto";
import { ActiveIdentityBundleStore } from "./active-identity-bundle-store.js";
import {
  assertFounderCutoverReceiptMatchesActiveBundle,
  inspectFounderCutoverFence,
  readFounderCutoverGuard,
} from "./cutover-fence.js";
import type { InstallationSigner } from "./installation-signer.js";
import { verifyInstallationKeyDescriptor } from "./installation-signer.js";
import { verifyP256LowSSignature } from "./signature-profile.js";
import type { ProductRuntimeConfig } from "../config.js";
import type { ProductCredentialResolver } from "../credentials.js";
import type { LocalConnectionRegistryV1 } from "./contracts.js";
import { assertLocalCredentialGuardMatches } from "./credential-guard.js";

export type IdentityCheckId =
  | "active-bundle"
  | "bundle-integrity"
  | "seed-cutover"
  | "legacy-boundary"
  | "installation-key"
  | "provider-identities"
  | "connection-credentials"
  | "approval-capture"
  | "attribution-storage"
  | "signed-outbox"
  | "independent-copy";

export interface IdentityCheckResult {
  id: IdentityCheckId;
  ok: boolean;
  required_for_seed: boolean;
  detail: string;
}

export interface IdentityCheckReport {
  schema_version: 1;
  kind: "echo-founder-identity-check";
  mode: "local_only_unattributed" | "identity_enabled";
  foundation_ok: boolean;
  seed_grade_ready: boolean;
  organization_id: string | null;
  installation_id: string | null;
  checks: readonly IdentityCheckResult[];
}

export interface IdentityCheckDependencies {
  signer?: InstallationSigner;
  runtimeConfig?: ProductRuntimeConfig;
  credentialResolver?: ProductCredentialResolver;
  approvalCaptureReady?: () => Promise<{ ok: boolean; detail: string }>;
  attributionStorageReady?: () => Promise<{ ok: boolean; detail: string }>;
  signedOutboxReady?: () => Promise<{ ok: boolean; detail: string }>;
  independentCopyReady?: () => Promise<{ ok: boolean; detail: string }>;
  legacyBoundaryReady?: () => Promise<{ ok: boolean; detail: string }>;
  /** Recovery-only: lets the bootstrap finalizer validate before completion. */
  allowCommittingCutoverFinalization?: boolean;
}

export interface ActiveCredentialGuardCheck {
  ok: boolean;
  detail: string;
}

/**
 * Verify local credential continuity for every non-retired connection
 * generation. Provider tokens never enter the report, even when resolution or
 * comparison fails.
 */
export function verifyActiveConnectionCredentialGuards(
  registry: Pick<LocalConnectionRegistryV1, "connections">,
  credentialResolver: ProductCredentialResolver | undefined,
): ActiveCredentialGuardCheck {
  const active = registry.connections.flatMap((connection) =>
    connection.generations
      .filter((generation) => generation.ended_at === null)
      .map((generation) => ({ connection, generation })),
  );
  if (active.length === 0) {
    return {
      ok: true,
      detail:
        "no active connection credential generations require verification",
    };
  }
  if (credentialResolver === undefined) {
    return {
      ok: false,
      detail:
        "current credential resolver is unavailable for active connections",
    };
  }

  const failures: string[] = [];
  for (const { connection, generation } of active) {
    const label = `${connection.provider} connection ${connection.connection_id} generation ${generation.generation}`;
    let credential: string | undefined;
    try {
      credential = credentialResolver(
        generation.local_credential_guard.reference,
      );
    } catch {
      failures.push(`${label} current credential is unreadable`);
      continue;
    }
    if (credential === undefined) {
      failures.push(`${label} current credential is unavailable`);
      continue;
    }
    try {
      assertLocalCredentialGuardMatches(
        generation.local_credential_guard,
        generation.local_credential_guard.reference,
        credential,
      );
    } catch {
      failures.push(
        `${label} current credential does not match its enrolled guard`,
      );
    }
  }
  return failures.length === 0
    ? {
        ok: true,
        detail: `verified ${active.length} active connection credential generation${active.length === 1 ? "" : "s"}`,
      }
    : { ok: false, detail: failures.join("; ") };
}

export class FounderIdentityGateError extends Error {
  constructor(public readonly report: IdentityCheckReport) {
    const failures = report.checks
      .filter((item) => !item.ok)
      .map((item) => `${item.id}: ${item.detail}`);
    super(
      `identity-enabled profile is not seed-grade ready: ${failures.join("; ")}`,
    );
    this.name = "FounderIdentityGateError";
  }
}

function check(
  id: IdentityCheckId,
  ok: boolean,
  detail: string,
): IdentityCheckResult {
  return { id, ok, required_for_seed: true, detail };
}

async function optionalCapabilityCheck(
  id: IdentityCheckId,
  probe: (() => Promise<{ ok: boolean; detail: string }>) | undefined,
  notImplemented: string,
): Promise<IdentityCheckResult> {
  if (probe === undefined) return check(id, false, notImplemented);
  try {
    const result = await probe();
    return check(id, result.ok, result.detail);
  } catch (error) {
    return check(id, false, `${id} check failed: ${(error as Error).message}`);
  }
}

export async function checkFounderIdentity(
  stateDirectory: string,
  dependencies: IdentityCheckDependencies = {},
): Promise<IdentityCheckReport> {
  const store = new ActiveIdentityBundleStore(stateDirectory);
  if (!store.hasActiveBundle()) {
    let identityMaterial = false;
    let irreversibleCutover = false;
    let inspectionFailure: string | null = null;
    try {
      identityMaterial = store.hasIdentityMaterial();
      const fence = inspectFounderCutoverFence(stateDirectory);
      const guard = readFounderCutoverGuard(stateDirectory);
      irreversibleCutover =
        guard !== null ||
        fence.state === "committing" ||
        fence.state === "complete";
      identityMaterial ||= irreversibleCutover;
    } catch (error) {
      inspectionFailure = (error as Error).message;
    }
    if (identityMaterial || inspectionFailure !== null) {
      return {
        schema_version: 1,
        kind: "echo-founder-identity-check",
        mode: "identity_enabled",
        foundation_ok: false,
        seed_grade_ready: false,
        organization_id: null,
        installation_id: null,
        checks: [
          check(
            "active-bundle",
            false,
            inspectionFailure === null
              ? irreversibleCutover
                ? "an irreversible founder cutover guard or receipt exists but the active bundle pointer is missing"
                : "identity material exists but the active bundle pointer is missing"
              : `identity material could not be inspected: ${inspectionFailure}`,
          ),
          check(
            "bundle-integrity",
            false,
            "not checked without an active bundle",
          ),
          check(
            "seed-cutover",
            false,
            "not checked without an active bundle",
          ),
          check(
            "legacy-boundary",
            false,
            "not checked without an active bundle",
          ),
          check(
            "installation-key",
            false,
            "not checked without an active bundle",
          ),
          check(
            "provider-identities",
            false,
            "not checked without an active bundle",
          ),
          check(
            "connection-credentials",
            false,
            "not checked without an active bundle",
          ),
          check(
            "approval-capture",
            false,
            "not checked without an active bundle",
          ),
          check(
            "attribution-storage",
            false,
            "not checked without an active bundle",
          ),
          check("signed-outbox", false, "not checked without an active bundle"),
          check(
            "independent-copy",
            false,
            "not checked without an active bundle",
          ),
        ],
      };
    }
    return {
      schema_version: 1,
      kind: "echo-founder-identity-check",
      mode: "local_only_unattributed",
      foundation_ok: true,
      seed_grade_ready: false,
      organization_id: null,
      installation_id: null,
      checks: [
        check(
          "active-bundle",
          false,
          "no active identity bundle; current runs remain disposable rehearsals",
        ),
        check(
          "bundle-integrity",
          false,
          "not checked without an active bundle",
        ),
        check(
          "seed-cutover",
          false,
          "not checked without an active bundle",
        ),
        check(
          "legacy-boundary",
          false,
          "not checked without an active bundle",
        ),
        check(
          "installation-key",
          false,
          "not checked without an active bundle",
        ),
        check(
          "provider-identities",
          false,
          "not checked without an active bundle",
        ),
        check(
          "connection-credentials",
          false,
          "not checked without an active bundle",
        ),
        check(
          "approval-capture",
          false,
          "not checked without an active bundle",
        ),
        check(
          "attribution-storage",
          false,
          "not checked without an active bundle",
        ),
        check("signed-outbox", false, "not checked without an active bundle"),
        check(
          "independent-copy",
          false,
          "not checked without an active bundle",
        ),
      ],
    };
  }

  const checks: IdentityCheckResult[] = [
    check("active-bundle", true, "active identity bundle pointer exists"),
  ];
  let verified: ReturnType<ActiveIdentityBundleStore["loadVerified"]>;
  try {
    verified = store.loadVerified(dependencies.runtimeConfig);
    if (verified === null)
      throw new Error("active pointer disappeared during validation");
    checks.push(
      check(
        "bundle-integrity",
        true,
        "manifest, registry, policy, pointer, digests, signatures, and cross-identities verify",
      ),
    );
  } catch (error) {
    checks.push(check("bundle-integrity", false, (error as Error).message));
    return {
      schema_version: 1,
      kind: "echo-founder-identity-check",
      mode: "identity_enabled",
      foundation_ok: false,
      seed_grade_ready: false,
      organization_id: null,
      installation_id: null,
      checks,
    };
  }

  try {
    const receipt = assertFounderCutoverReceiptMatchesActiveBundle(
      stateDirectory,
      verified,
      {
        allowCommittingFinalization:
          dependencies.allowCommittingCutoverFinalization === true,
      },
    );
    checks.push(
      check(
        "seed-cutover",
        true,
        receipt.phase === "complete"
          ? "signed founder cutover receipt matches the active identity bundle"
          : "signed committing receipt matches the active bundle for crash finalization",
      ),
    );
  } catch (error) {
    checks.push(check("seed-cutover", false, (error as Error).message));
  }

  checks.push(
    await optionalCapabilityCheck(
      "legacy-boundary",
      dependencies.legacyBoundaryReady,
      "legacy cutover classification is not installed yet",
    ),
  );

  const signer = dependencies.signer;
  if (signer === undefined) {
    checks.push(
      check(
        "installation-key",
        false,
        "signed Secure Enclave helper is unavailable; seed-grade signing is disabled",
      ),
    );
  } else {
    try {
      const installationId = verified.manifest.installation.installation_id;
      const descriptor = await signer.inspect(installationId);
      if (descriptor === null)
        throw new Error("installation signing key is unavailable");
      const publicKey = verifyInstallationKeyDescriptor(descriptor);
      const manifestKey = verified.manifest.installation.signing_key;
      if (
        descriptor.installation_id !== installationId ||
        descriptor.key_id !== manifestKey.key_id ||
        descriptor.algorithm !== manifestKey.algorithm ||
        descriptor.public_key_spki_der_base64 !==
          manifestKey.public_key_spki_der_base64 ||
        descriptor.protection !== manifestKey.protection ||
        descriptor.assurance !== manifestKey.assurance ||
        descriptor.protection !== "secure-enclave" ||
        descriptor.assurance !== "hardware_bound"
      ) {
        throw new Error(
          "live installation key does not match the hardware-bound manifest key",
        );
      }
      const challenge = randomBytes(32);
      const signature = await signer.sign(
        installationId,
        challenge,
        descriptor.key_id,
      );
      if (!verifyP256LowSSignature(publicKey, challenge, signature)) {
        throw new Error("installation signing challenge did not verify");
      }
      checks.push(
        check(
          "installation-key",
          true,
          "matching non-exportable Secure Enclave key signed a fresh challenge",
        ),
      );
    } catch (error) {
      checks.push(check("installation-key", false, (error as Error).message));
    }
  }

  const hasSlackClaim = verified.manifest.identity_claims.some(
    (claim) =>
      claim.issuer.kind === "provider" &&
      claim.issuer.provider === "slack" &&
      claim.verification.method === "slack_dm_challenge" &&
      claim.verification.assurance === "provider_challenge_observed",
  );
  const hasSlackConnection = verified.connectionRegistry.connections.some(
    (connection) =>
      connection.provider === "slack" &&
      connection.generations.some(
        (generation) =>
          generation.ended_at === null &&
          generation.provider_identity.verification.method ===
            "slack_auth_test" &&
          generation.provider_identity.verification.assurance ===
            "provider_verified" &&
          generation.provider_identity.tenant !== null,
      ),
  );
  const hasGranolaConnection = verified.connectionRegistry.connections.some(
    (connection) =>
      connection.provider === "granola" &&
      connection.generations.some(
        (generation) =>
          generation.ended_at === null &&
          generation.provider_identity.verification.method ===
            "provider_first_capture" &&
          generation.provider_identity.verification.assurance ===
            "credential_observed",
      ),
  );
  const configuredCapabilities = new Set(
    verified.connectionRegistry.bindings
      .filter((binding) => binding.status === "active")
      .map((binding) => binding.capability),
  );
  const providerReady =
    hasSlackClaim &&
    hasSlackConnection &&
    hasGranolaConnection &&
    configuredCapabilities.has("meeting-source") &&
    configuredCapabilities.has("decision-processor") &&
    configuredCapabilities.has("approval-surface") &&
    configuredCapabilities.has("delivery-surface");
  checks.push(
    check(
      "provider-identities",
      providerReady,
      providerReady
        ? "Slack tenant/actor and Granola first-capture assurance are frozen with all bindings"
        : "verified Slack tenant/actor, Granola first-capture assurance, or required binding is missing",
    ),
  );
  const credentialGuard = verifyActiveConnectionCredentialGuards(
    verified.connectionRegistry,
    dependencies.credentialResolver,
  );
  checks.push(
    check("connection-credentials", credentialGuard.ok, credentialGuard.detail),
  );
  checks.push(
    await optionalCapabilityCheck(
      "approval-capture",
      dependencies.approvalCaptureReady,
      "approval federation capture is not installed yet",
    ),
    await optionalCapabilityCheck(
      "attribution-storage",
      dependencies.attributionStorageReady,
      "source and processor attribution storage is not installed yet",
    ),
    await optionalCapabilityCheck(
      "signed-outbox",
      dependencies.signedOutboxReady,
      "signed outbox projection is not installed yet",
    ),
    await optionalCapabilityCheck(
      "independent-copy",
      dependencies.independentCopyReady,
      "no verified protected independent outbox copy is recorded",
    ),
  );
  const foundationOk = checks
    .filter(
      (item) =>
        item.id === "active-bundle" ||
        item.id === "bundle-integrity" ||
        item.id === "installation-key",
    )
    .every((item) => item.ok);
  return {
    schema_version: 1,
    kind: "echo-founder-identity-check",
    mode: "identity_enabled",
    foundation_ok: foundationOk,
    seed_grade_ready: checks.every((item) => item.ok),
    organization_id: verified.manifest.organization.organization_id,
    installation_id: verified.manifest.installation.installation_id,
    checks,
  };
}

/** Disposable rehearsals pass; any identity material requires every seed gate. */
export async function assertFounderIdentityAllowsPipeline(
  stateDirectory: string,
  dependencies: IdentityCheckDependencies = {},
): Promise<IdentityCheckReport> {
  const report = await checkFounderIdentity(stateDirectory, dependencies);
  if (report.mode === "identity_enabled" && !report.seed_grade_ready) {
    throw new FounderIdentityGateError(report);
  }
  return report;
}
