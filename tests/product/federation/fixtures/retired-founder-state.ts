import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProductRuntimeConfig } from "../../../../src/product/config.js";
import {
  validateFounderBootstrapSession,
  type FounderBootstrapSessionV1,
} from "../../../../src/product/federation/bootstrap/bootstrap-session-store.js";
import {
  founderCutoverGuardPath,
  type FounderCutoverGuardV1,
} from "../../../../src/product/federation/cutover-fence.js";
import type { LocalConnectionRegistryV1 } from "../../../../src/product/federation/contracts.js";
import {
  canonicalJson,
  parseCanonicalJson,
} from "../../../../src/product/federation/foundation/canonical-json.js";
import { validateFederationDocument } from "../../../../src/product/federation/schema-validation.js";
import { resolveProductStatePaths } from "../../../../src/product/paths.js";
import { EXACT_SESSION_IDS } from "./founder-identity.js";

/**
 * Immutable historical founder-state fixture.
 *
 * The founder bootstrap authoring surface is deleted from production. These
 * bytes under `retired-founder-state/` are two signed, dummy-only founder
 * sessions (the primary ceremony's `committing` and `complete` revisions plus
 * one distinct complete ceremony) and the primary session's matching active
 * identity bundle, generated once from the last known-good authoring
 * implementation at commit 0f30743 by temporary, uncommitted generators.
 * Every ID, credential guard, provider ID, and Slack / Granola identifier in
 * them is a dummy; signatures embed only public keys from discarded in-memory
 * test keypairs. Tests copy these fixed bytes -- they never regenerate
 * signatures, plans, provider observations, or identity bundles.
 *
 * This helper only copies the fixed files, restores the 0700/0600 modes git
 * does not preserve, parses them through retained production readers, and can
 * write the one artifact that cannot be golden: the external cutover guard,
 * whose digest is state-path-bound. The guard is derived by reading the digest
 * production already encodes in `founderCutoverGuardPath` -- never by
 * reimplementing the path-hash algorithm.
 */

const FIXTURE_ROOT = join(import.meta.dirname, "retired-founder-state");

export const GOLDEN_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const GOLDEN_ALTERNATE_SESSION_ID =
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Dummy credentials whose salted digests are frozen in the golden registry. */
export const GOLDEN_DUMMY_CREDENTIALS = {
  "file:/private/slack-token": "retired-founder-dummy-slack-credential",
  "file:/private/granola-token": "retired-founder-dummy-granola-credential",
} as const;

export type GoldenSessionPhase = "committing" | "complete";
export type GoldenSessionFixture =
  | GoldenSessionPhase
  | "alternate-complete";

const IDENTITY_ARTIFACTS = [
  {
    fixture: `identity-manifest.${EXACT_SESSION_IDS.manifest_id}.v1.json`,
    subdirectory: "manifests",
  },
  {
    fixture: `connection-registry.${EXACT_SESSION_IDS.registry_id}.r1.v1.json`,
    subdirectory: "registries",
  },
  {
    fixture: `publication-policy.${EXACT_SESSION_IDS.policy_id}.v1.json`,
    subdirectory: "policies",
  },
] as const;

function fixtureBytes(name: string): Buffer {
  return readFileSync(join(FIXTURE_ROOT, name));
}

function sessionFixtureName(session: GoldenSessionFixture): string {
  return `session.${session}.v1.json`;
}

export function goldenSessionBytes(session: GoldenSessionFixture): Buffer {
  return fixtureBytes(sessionFixtureName(session));
}

/** The golden session, revalidated through the retained production validator. */
export function goldenSession(
  session: GoldenSessionFixture = "complete",
): FounderBootstrapSessionV1 {
  return validateFounderBootstrapSession(
    parseCanonicalJson(goldenSessionBytes(session).toString("utf8")),
  );
}

/** The golden session as a plain mutable JSON record, for tamper cases. */
export function goldenSessionRecord(
  session: GoldenSessionFixture = "complete",
): Record<string, unknown> {
  return JSON.parse(goldenSessionBytes(session).toString("utf8")) as Record<
    string,
    unknown
  >;
}

export function goldenConnectionRegistry(): LocalConnectionRegistryV1 {
  return validateFederationDocument<LocalConnectionRegistryV1>(
    "local-connection-registry",
    parseCanonicalJson(
      fixtureBytes(IDENTITY_ARTIFACTS[1].fixture).toString("utf8"),
    ),
  );
}

/** A pinned credential guard from the golden registry, never recomputed. */
export function goldenCredentialGuard(
  provider: "slack" | "granola",
): LocalConnectionRegistryV1["connections"][number]["generations"][number]["local_credential_guard"] {
  const connection = goldenConnectionRegistry().connections.find(
    (item) => item.provider === provider,
  );
  if (connection === undefined) {
    throw new Error(`golden registry has no ${provider} connection`);
  }
  return connection.generations[0]!.local_credential_guard;
}

/** The frozen runtime config that matches the golden registry bindings. */
export function goldenRuntimeConfig(stateDir: string): ProductRuntimeConfig {
  const parsed = JSON.parse(
    fixtureBytes("runtime-config.v1.json").toString("utf8"),
  ) as ProductRuntimeConfig;
  return { ...parsed, state_dir: stateDir };
}

/** Resolver for the dummy credentials the golden guards were computed over. */
export function goldenCredentialResolver(
  overrides: Record<string, string | undefined> = {},
): (reference: string) => string | undefined {
  return (reference) =>
    reference in overrides
      ? overrides[reference]
      : GOLDEN_DUMMY_CREDENTIALS[
          reference as keyof typeof GOLDEN_DUMMY_CREDENTIALS
        ];
}

/** The canonical on-disk location of the golden session, for tamper cases. */
export function goldenSessionPath(
  stateDirectory: string,
  sessionId = GOLDEN_SESSION_ID,
): string {
  return join(
    resolveProductStatePaths(stateDirectory).founderIdentityBootstrap,
    `session.${sessionId}.v1.json`,
  );
}

/**
 * `founderCutoverGuardPath` embeds the state-path digest in the filename, so
 * the accepted value is read back off the path production picks rather than
 * duplicating the path-hash algorithm.
 */
export function guardStatePathDigest(
  stateDirectory: string,
): `sha256:${string}` {
  const filename = founderCutoverGuardPath(stateDirectory).split("/").at(-1)!;
  const prefix = ".echo-founder-cutover.";
  return `sha256:${filename.slice(prefix.length, prefix.length + 64)}`;
}

/**
 * The external guard the retired ceremony would have left beside this state
 * path for the golden session: path digest from production, the rest from the
 * validated golden session.
 */
export function goldenCutoverGuard(
  stateDirectory: string,
  fixture: GoldenSessionFixture = "complete",
): FounderCutoverGuardV1 {
  const session = goldenSession(fixture);
  if (session.commit === null || session.signing_key === null) {
    throw new Error("golden session lacks its commit or signing key");
  }
  return {
    schema_version: 1,
    kind: "echo-founder-cutover-guard",
    state_path_sha256: guardStatePathDigest(stateDirectory),
    session_id: session.session_id,
    plan_sha256: session.commit.plan_sha256,
    installation_key_id: session.signing_key.key_id,
  };
}

export function writeGoldenCutoverGuard(
  stateDirectory: string,
  guard: FounderCutoverGuardV1 = goldenCutoverGuard(stateDirectory),
): string {
  const path = founderCutoverGuardPath(stateDirectory);
  writeFileSync(path, canonicalJson(guard), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function copyInto(fixture: string, target: string): void {
  writeFileSync(target, fixtureBytes(fixture), { mode: 0o600 });
  chmodSync(target, 0o600);
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export interface InstallGoldenFounderStateOptions {
  /** Which signed session revision to place, or false for none. */
  session?: GoldenSessionFixture | false;
  /** Copy the active pointer and the signed identity documents. */
  identity?: boolean;
  /** Write the path-bound external cutover guard beside the state root. */
  guard?: boolean;
}

/**
 * Copy the fixed golden bytes into a state directory exactly where the retired
 * ceremony persisted them, restoring private modes. Selects variants only; it
 * cannot author, sign, or mutate anything.
 */
export function installGoldenFounderState(
  stateDirectory: string,
  options: InstallGoldenFounderStateOptions = {},
): void {
  const session = options.session ?? "complete";
  const identity = options.identity ?? true;
  const paths = resolveProductStatePaths(stateDirectory);
  if (session !== false) {
    privateDirectory(paths.founderIdentityBootstrap);
    const validated = goldenSession(session);
    copyInto(
      sessionFixtureName(session),
      goldenSessionPath(stateDirectory, validated.session_id),
    );
  }
  if (identity) {
    privateDirectory(paths.identityRoot);
    for (const artifact of IDENTITY_ARTIFACTS) {
      const directory = join(paths.identityRoot, artifact.subdirectory);
      privateDirectory(directory);
      copyInto(artifact.fixture, join(directory, artifact.fixture));
    }
    copyInto("active-identity-bundle.v1.json", paths.activeIdentityBundle);
  }
  if (options.guard ?? true) {
    // The guard's parent is the state root's parent; make sure it exists when
    // a test installs into a nested, not-yet-created state path.
    mkdirSync(dirname(founderCutoverGuardPath(stateDirectory)), {
      recursive: true,
    });
    writeGoldenCutoverGuard(
      stateDirectory,
      goldenCutoverGuard(stateDirectory, session === false ? "complete" : session),
    );
  }
}
