import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRecordPolicyFactProjectorRegistryV1,
  createPersonPolicyFactProjectorV2,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/organization-record-api-v1";
import { openAuthorityDatabase } from "../../services/organization-authority/src/adapters/persistence/sqlite/open-authority-database.js";
import { FileOrganizationAuthoritySigner } from "../../services/organization-authority/src/adapters/security/file-organization-authority-signer.js";
import { createReadableSearchGenerationReconcilerV1 } from "../../services/organization-authority/src/composition/readable-search-generation-composition.js";
import { initializeAuthorityState } from "../../services/organization-authority/src/composition/authority-state-initializer.js";
import { verifyAuthorityStateLineage } from "../../services/organization-authority/src/composition/verify-authority-state-lineage.js";
import {
  inspectLinuxReadOnlyMount,
  parseLinuxMountinfo,
  verifyAuthorityRecovery,
} from "../../tools/verify-authority-recovery.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const TOOL = join(REPO, "tools", "verify-authority-recovery.mjs");
const roots: string[] = [];
const TEST_READ_ONLY_MOUNT = Object.freeze({
  mount_id: "test-read-only-mount",
  mount_point: "/",
  mount_options: Object.freeze(["ro", "relatime"]),
});
type MountInspection = {
  readonly mount_id: string;
  readonly mount_point: string;
  readonly mount_options: readonly string[];
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function root(): string {
  const created = mkdtempSync(
    join(tmpdir(), "echo-authority-recovery-verifier-"),
  );
  chmodSync(created, 0o700);
  roots.push(created);
  return created;
}

async function writeFixture(): Promise<string> {
  const parent = root();
  const cleanData = join(parent, "clean-data");
  const stateDirectory = join(cleanData, "state");
  const releaseDirectory = join(cleanData, "release");
  const privateDirectory = join(cleanData, "private");
  mkdirSync(releaseDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(privateDirectory, 0o700);
  writeFileSync(join(privateDirectory, "provider-credential"), "never read\n", {
    mode: 0o600,
  });

  const initialized = initializeAuthorityState({
    state_directory: stateDirectory,
    organization_display_name: "Recovery Verifier Organization",
    owner_display_name: "Founder",
    created_at: "2026-08-25T12:00:00.000Z",
    creating_artifact_revision: "recovery-verifier-test",
  });
  const lineage = verifyAuthorityStateLineage(stateDirectory);
  const authority = openAuthorityDatabase(
    join(stateDirectory, "authority.sqlite"),
    {
      fileMustExist: true,
    },
  );
  const record = openOrganizationRecordDatabase(
    join(stateDirectory, "record-log.sqlite"),
    {
      fileMustExist: true,
    },
  );
  try {
    const reconciler = createReadableSearchGenerationReconcilerV1({
      state_directory: stateDirectory,
      root: lineage.root,
      authority,
      record,
      signer: FileOrganizationAuthoritySigner.openExisting({
        directory: join(stateDirectory, "keys"),
        authority_id: initialized.authority_id,
        organization_id: initialized.organization_id,
      }),
      policy_projectors: createRecordPolicyFactProjectorRegistryV1([
        createPersonPolicyFactProjectorV2(),
      ]),
      now: () => "2026-08-25T12:01:00.000Z",
    });
    await reconciler.reconcile(new AbortController().signal);
  } finally {
    authority.close();
    record.close();
  }
  return writeReleaseTuple(cleanData);
}

function writeReleaseTuple(cleanData: string): string {
  const releaseDirectory = join(cleanData, "release");
  const sourceSha = "a".repeat(40);
  const profile = {
    schema_version: 1,
    kind: "echo-clean-v1-runtime-profile",
    source_sha: sourceSha,
    files: Object.fromEntries(
      [
        "Caddyfile.clean-v1",
        "Caddyfile.clean-v1.ec2",
        "compose.clean-v1.ec2.yaml",
        "compose.clean-v1.yaml",
      ].map((name) => [
        name,
        readFileSync(
          join(REPO, "deploy", "organization-authority", name),
          "utf8",
        ),
      ]),
    ),
  };
  const profileBytes = `${canonical(profile)}\n`;
  const profileDigest = createHash("sha256").update(profileBytes).digest("hex");
  const release = {
    schema_version: 1,
    kind: "echo-clean-v1-release",
    release_id: "clean-v1-20260825-001",
    released_at: "2026-08-25T12:00:00Z",
    baseline_compatibility_class: "clean-v1",
    source_sha: sourceSha,
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
      artifact_sha256: profileDigest,
      profile_version: "clean-v1-profile-1",
    },
  };
  const releaseId = release.release_id;
  mkdirSync(join(releaseDirectory, "runtime-profiles"), { mode: 0o700 });
  mkdirSync(join(releaseDirectory, "runtime-environments"), { mode: 0o700 });
  writeFileSync(
    join(releaseDirectory, "current.clean-v1.json"),
    `${canonical(release)}\n`,
    {
      mode: 0o600,
    },
  );
  writeFileSync(
    join(releaseDirectory, "runtime-profile.active"),
    profileBytes,
    { mode: 0o600 },
  );
  copyFileSync(
    join(releaseDirectory, "runtime-profile.active"),
    join(releaseDirectory, "runtime-profiles", `${releaseId}.profile`),
  );
  writeFileSync(
    join(releaseDirectory, "runtime-environments", `${releaseId}.env`),
    runtimeEnvironment(release, lstatSync(join(cleanData, "private"))),
    { mode: 0o600 },
  );
  return cleanData;
}

function runtimeEnvironment(
  release: {
    authority_image: { reference: string };
    release_id: string;
    source_sha: string;
    runtime_profile: { artifact_sha256: string; profile_version: string };
  },
  owner: { uid: number; gid: number },
): string {
  const host = "authority.example.test";
  return [
    `ECHO_CLEAN_AUTHORITY_HOST=${host}`,
    `ECHO_CLEAN_AUTHORITY_URL=https://${host}`,
    `ECHO_CLEAN_AUTHORITY_UID=${owner.uid}`,
    `ECHO_CLEAN_AUTHORITY_GID=${owner.gid}`,
    `ECHO_CLEAN_AUTHORITY_IMAGE=${release.authority_image.reference}`,
    `ECHO_CLEAN_RELEASE_ID=${release.release_id}`,
    `ECHO_CLEAN_RELEASE_SOURCE_SHA=${release.source_sha}`,
    `ECHO_CLEAN_RUNTIME_PROFILE_SHA256=${release.runtime_profile.artifact_sha256}`,
    `ECHO_CLEAN_RUNTIME_PROFILE_VERSION=${release.runtime_profile.profile_version}`,
    "ECHO_CLEAN_AWS_REGION=us-west-2",
    `ECHO_CLEAN_AUTHORITY_LOG_GROUP=/echo-brain/authority/${host}`,
    "ECHO_CLEAN_SLACK_APPROVAL_CHANNEL_ID=C012345678",
    "ECHO_CLEAN_OWNER_EMAIL=founder@example.test",
  ].join("\n");
}

async function run(
  cleanData: string,
  mountInspector: (path: string) => MountInspection = () =>
    TEST_READ_ONLY_MOUNT,
) {
  try {
    const result = await verifyAuthorityRecovery({
      cleanData,
      sourceRoot: REPO,
      mountInspector,
    });
    return { status: 0, stdout: `${canonical(result)}\n`, stderr: "" };
  } catch {
    return {
      status: 1,
      stdout: "",
      stderr: "authority offline recovery verification failed\n",
    };
  }
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("authority offline recovery verifier", () => {
  it("validates an offline release tuple, lineage, primary databases, and published retrieval databases", async () => {
    const cleanData = await writeFixture();
    const result = await run(cleanData);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schema_version: 1,
      kind: "echo-authority-offline-recovery-verification-v1",
      ok: true,
      release_runtime_profile_tuple_valid: true,
      runtime_environment_snapshot_schema_valid: true,
      release_bound_environment_fields_valid: true,
      state_lineage_valid: true,
      private_metadata_valid: true,
      private_entry_count: 1,
      primary_sqlite_database_count: 4,
      primary_sqlite_integrity_valid: true,
      retrieval_generation_count: 1,
      retrieval_segment_count: 1,
      retrieval_sqlite_database_count: 3,
      retrieval_sqlite_integrity_valid: true,
    });
    expect(result.stdout).not.toContain("provider-credential");
    expect(result.stdout).not.toContain("never read");
  });

  it("fails closed before reporting when a release tuple file is unsafe", async () => {
    const cleanData = await writeFixture();
    chmodSync(join(cleanData, "release", "runtime-profile.active"), 0o644);
    const result = await run(cleanData);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "authority offline recovery verification failed\n",
    );
  });

  it("refuses a state SQLite symlink before lineage or SQLite inspection", async () => {
    const cleanData = await writeFixture();
    const database = join(cleanData, "state", "authority.sqlite");
    unlinkSync(database);
    symlinkSync(join(cleanData, "private", "provider-credential"), database);

    const result = await run(cleanData);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "authority offline recovery verification failed\n",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "provider-credential",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain("private");
  });

  it("refuses a retrieval SQLite symlink before lineage or SQLite inspection", async () => {
    const cleanData = await writeFixture();
    const lineage = verifyAuthorityStateLineage(join(cleanData, "state"));
    const retrievalDatabase = lineage.databases.find((database) =>
      database.role.startsWith("retrieval-"),
    );
    expect(retrievalDatabase).toBeDefined();
    unlinkSync(retrievalDatabase!.path);
    symlinkSync(
      join(cleanData, "private", "provider-credential"),
      retrievalDatabase!.path,
    );

    const result = await run(cleanData);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "authority offline recovery verification failed\n",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "provider-credential",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain("private");
  });

  it("refuses a primary SQLite hot-state sidecar before immutable reads", async () => {
    const cleanData = await writeFixture();
    writeFileSync(join(cleanData, "state", "authority.sqlite-wal"), "hot");

    const result = await run(cleanData);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "authority offline recovery verification failed\n",
    );
  });

  it("refuses a retrieval SQLite hot-state sidecar before immutable reads", async () => {
    const cleanData = await writeFixture();
    const lineage = verifyAuthorityStateLineage(join(cleanData, "state"));
    const retrievalDatabase = lineage.databases.find((database) =>
      database.role.startsWith("retrieval-"),
    );
    expect(retrievalDatabase).toBeDefined();
    writeFileSync(`${retrievalDatabase!.path}-shm`, "hot");

    const result = await run(cleanData);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "authority offline recovery verification failed\n",
    );
  });

  it("refuses a runtime environment snapshot with a duplicate, missing, or unexpected field", async () => {
    const cleanData = await writeFixture();
    const environmentPath = join(
      cleanData,
      "release",
      "runtime-environments",
      "clean-v1-20260825-001.env",
    );
    const valid = readFileSync(environmentPath, "utf8");
    const variants = [
      valid.replace(
        "ECHO_CLEAN_RELEASE_ID=clean-v1-20260825-001",
        "ECHO_CLEAN_AUTHORITY_HOST=authority.example.test",
      ),
      valid.replace("ECHO_CLEAN_AWS_REGION=us-west-2\n", ""),
      `${valid}\nECHO_CLEAN_EXTRA=value`,
    ];

    for (const value of variants) {
      writeFileSync(environmentPath, value, { mode: 0o600 });
      const result = await run(cleanData);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "authority offline recovery verification failed\n",
      );
    }
  });

  it("the CLI refuses a clean-data directory that is not on a Linux read-only mount", async () => {
    const cleanData = await writeFixture();
    const result = spawnSync(
      process.execPath,
      [TOOL, "--clean-data", cleanData, "--source-root", REPO],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "authority offline recovery verification failed\n",
    );
  });

  it("parses escaped mountpoints and chooses the closest Linux mount", () => {
    const mountinfo = [
      "36 25 0:32 / / rw,relatime - overlay overlay rw",
      "37 36 8:1 / /mnt/restored\\040volume ro,nosuid - ext4 /dev/xvdf ro",
      "",
    ].join("\n");

    expect(parseLinuxMountinfo(mountinfo)).toEqual([
      {
        mount_id: "36",
        mount_point: "/",
        mount_options: ["rw", "relatime"],
      },
      {
        mount_id: "37",
        mount_point: "/mnt/restored volume",
        mount_options: ["ro", "nosuid"],
      },
    ]);
    expect(
      inspectLinuxReadOnlyMount(
        "/mnt/restored volume/clean-data",
        () => mountinfo,
      ),
    ).toEqual({
      mount_id: "37",
      mount_point: "/mnt/restored volume",
      mount_options: ["ro", "nosuid"],
    });
    expect(() => inspectLinuxReadOnlyMount("/other", () => mountinfo)).toThrow(
      "offline recovery verification refused",
    );
  });

  it("refuses when the read-only mount changes before the final attestation", async () => {
    const cleanData = await writeFixture();
    let inspections = 0;
    const result = await run(cleanData, () => {
      inspections += 1;
      return inspections === 1
        ? TEST_READ_ONLY_MOUNT
        : {
            ...TEST_READ_ONLY_MOUNT,
            mount_id: "changed-read-only-mount",
          };
    });

    expect(inspections).toBe(2);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "authority offline recovery verification failed\n",
    );
  });

  it("refuses when the environment runtime identity does not own private state", async () => {
    const cleanData = await writeFixture();
    const environmentPath = join(
      cleanData,
      "release",
      "runtime-environments",
      "clean-v1-20260825-001.env",
    );
    const privateOwner = lstatSync(join(cleanData, "private"));
    writeFileSync(
      environmentPath,
      readFileSync(environmentPath, "utf8").replace(
        `ECHO_CLEAN_AUTHORITY_UID=${privateOwner.uid}`,
        `ECHO_CLEAN_AUTHORITY_UID=${privateOwner.uid + 1}`,
      ),
      { mode: 0o600 },
    );

    const result = await run(cleanData);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "authority offline recovery verification failed\n",
    );
  });

  it.skipIf(
    process.getuid === undefined ||
      process.getgid === undefined ||
      process.getgroups === undefined ||
      process.getgroups().every((group) => group === process.getgid!()),
  )(
    "fails closed when a private entry has a different numeric owner",
    async () => {
      const cleanData = await writeFixture();
      const alternateGroup = process.getgroups!().find(
        (group) => group !== process.getgid!(),
      );
      expect(alternateGroup).toBeDefined();
      chownSync(
        join(cleanData, "private", "provider-credential"),
        process.getuid!(),
        alternateGroup!,
      );
      const result = await run(cleanData);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "authority offline recovery verification failed\n",
      );
    },
  );
});
