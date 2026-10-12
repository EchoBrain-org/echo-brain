import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJsonForTest } from "./test-canonical-json.js";

const DEPLOYMENT = resolve(import.meta.dirname, "../../deploy/organization-authority");

/**
 * The deploy files a clean-v1 runtime profile carries. This expected list is
 * kept independent of tools/clean-v1-runtime-profile.mjs on purpose.
 */
export const CLEAN_V1_RUNTIME_PROFILE_FILES = [
  "Caddyfile.clean-v1",
  "Caddyfile.clean-v1.ec2",
  "compose.clean-v1.ec2.yaml",
  "compose.clean-v1.yaml",
] as const;

const releaseDefaults = () => ({
  schema_version: 1,
  kind: "echo-clean-v1-release",
  release_id: "clean-v1-20260822-001",
  released_at: "2026-08-22T20:00:00Z",
  baseline_compatibility_class: "clean-v1",
  source_sha: "a".repeat(40),
  authority_image: {
    reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"b".repeat(64)}`,
  },
  person_client: {
    package: "@echo-brain/person-client",
    version: "0.1.0-internal.1",
    artifact_url: "https://downloads.example.test/person-client.tgz",
    artifact_sha256: "c".repeat(64),
  },
  runtime_profile: {
    artifact_url: "https://downloads.example.test/runtime-profile.json",
    artifact_sha256: "e".repeat(64),
    profile_version: "clean-v1-profile-1",
  },
});
type Release = ReturnType<typeof releaseDefaults>;

/** A valid clean-v1 release record. Nested overrides merge over the defaults. */
export function cleanReleaseRecord({
  person_client,
  runtime_profile,
  ...fields
}: Partial<Omit<Release, "person_client" | "runtime_profile">> & {
  person_client?: Partial<Release["person_client"]>;
  runtime_profile?: Partial<Release["runtime_profile"]>;
} = {}): Release {
  const defaults = releaseDefaults();
  return {
    ...defaults,
    ...fields,
    person_client: { ...defaults.person_client, ...person_client },
    runtime_profile: { ...defaults.runtime_profile, ...runtime_profile },
  };
}

/** The canonical runtime-profile document for these files, with its digest. */
export function cleanRuntimeProfile(sourceSha: string, files: Readonly<Record<string, string>>) {
  const bytes = `${canonicalJsonForTest({
    schema_version: 1,
    kind: "echo-clean-v1-runtime-profile",
    source_sha: sourceSha,
    files,
  })}\n`;
  return { bytes, digest: createHash("sha256").update(bytes).digest("hex"), files };
}

/** The repository's runtime-profile files from deploy/organization-authority. */
export function deployRuntimeProfileFiles() {
  return Object.fromEntries(
    CLEAN_V1_RUNTIME_PROFILE_FILES.map((name) => [name, readFileSync(resolve(DEPLOYMENT, name), "utf8")]),
  ) as Record<(typeof CLEAN_V1_RUNTIME_PROFILE_FILES)[number], string>;
}
