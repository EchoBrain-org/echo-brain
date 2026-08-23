import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const TOOL = join(REPO, "tools", "clean-v1-release.mjs");
const DEPLOY_TOOL = join(REPO, "deploy", "release", "clean-v1-release.py");
const UPDATE = join(REPO, "deploy", "organization-authority", "update-clean-v1.sh");
const INSTALL = join(REPO, "deploy", "release", "install-person-client-clean-v1.sh");
const DOCKERFILE = join(REPO, "deploy", "organization-authority", "Dockerfile");
const roots: string[] = [];

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function record(overrides: Record<string, unknown> = {}) {
  return {
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
      artifact_url: "https://downloads.example.test/echo-brain-person-client.tgz",
      artifact_sha256: "c".repeat(64),
    },
    ...overrides,
  };
}

function writeRecord(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-release-"));
  roots.push(root);
  const path = join(root, "release.json");
  writeFileSync(path, `${canonical(value)}\n`);
  return path;
}

function run(
  command: string,
  args: string[],
  environment: Record<string, string | undefined> = {},
) {
  return spawnSync(command, args, {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("clean-v1 release record", () => {
  it("accepts the same canonical non-secret record in build and operator tools", () => {
    const path = writeRecord(record());
    const node = run(process.execPath, [TOOL, "validate", path]);
    const python = run("python3", [DEPLOY_TOOL, "validate", path]);

    expect(node.status).toBe(0);
    expect(python.status).toBe(0);
    expect(node.stdout).toBe(python.stdout);
    expect(node.stdout).toContain('"baseline_compatibility_class":"clean-v1"');
    expect(node.stdout).not.toMatch(/token|secret|grant|session/i);
  });

  it("creates one canonical record without overwriting a prior release record", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-release-create-"));
    roots.push(root);
    const draft = join(root, "draft.json");
    const output = join(root, "release.json");
    writeFileSync(draft, JSON.stringify(record(), null, 2));

    expect(run(process.execPath, [TOOL, "create", draft, output]).status).toBe(0);
    expect(run(process.execPath, [TOOL, "validate", output]).status).toBe(0);
    expect(run(process.execPath, [TOOL, "create", draft, output]).status).toBe(1);
  });

  it("rejects floating images, noncanonical bytes, and a non-clean compatibility class", () => {
    const floating = writeRecord({
      ...record(),
      authority_image: { reference: "registry.example.test/echo/authority:latest" },
    });
    expect(run(process.execPath, [TOOL, "validate", floating]).status).toBe(1);

    const wrongBaseline = writeRecord({
      ...record(),
      baseline_compatibility_class: "legacy-v1",
    });
    expect(run("python3", [DEPLOY_TOOL, "validate", wrongBaseline]).status).toBe(1);

    const noncanonical = writeRecord(record());
    writeFileSync(noncanonical, `${JSON.stringify(record())}\n`);
    expect(run(process.execPath, [TOOL, "validate", noncanonical]).status).toBe(1);
  });

  it.each([
    ["boolean schema version", (source: string) => source.replace('"schema_version":1', '"schema_version":true')],
    ["floating schema version", (source: string) => source.replace('"schema_version":1', '"schema_version":1.5')],
    ["lexical float schema version", (source: string) => source.replace('"schema_version":1', '"schema_version":1.0')],
    ["impossible timestamp", (source: string) => source.replace("2026-08-22T20:00:00Z", "2026-02-30T20:00:00Z")],
  ])("keeps Node and Python validation in parity for %s", (_name, mutate) => {
    const path = writeRecord(record());
    writeFileSync(path, mutate(readFileSync(path, "utf8")));
    expect(run(process.execPath, [TOOL, "validate", path]).status).toBe(1);
    expect(run("python3", [DEPLOY_TOOL, "validate", path]).status).toBe(1);
  });

  it("keeps update promotion explicitly gated on a bounded canary and never names a floating tag", () => {
    const syntax = run("bash", ["-n", UPDATE]);
    expect(syntax.status).toBe(0);
    const source = readFileSync(UPDATE, "utf8");
    expect(source).toContain("--canary-passed");
    expect(source).toContain("candidate baseline is not compatible");
    expect(source).toContain("@sha256:");
    expect(source).not.toContain("imageTag");
  });

  it("binds Authority image source to the OCI revision label before startup", () => {
    const dockerfile = readFileSync(DOCKERFILE, "utf8");
    const update = readFileSync(UPDATE, "utf8");
    expect(dockerfile).toContain("ARG ECHO_SOURCE_SHA");
    expect(dockerfile).toContain('org.opencontainers.image.revision="${ECHO_SOURCE_SHA}"');
    expect(update).toContain("org.opencontainers.image.revision");
    expect(update).toContain("image_source_matches \"$expected\" \"$expected_source\"");
  });

  it("refuses an Authority image whose OCI revision label differs before startup", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-image-source-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const up = join(root, "up-called");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const candidate = writeRecord(record({
      release_id: "clean-v1-20260822-002",
      authority_image: { reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"d".repeat(64)}` },
    }));
    mkdirSync(bin);
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
if [[ "$1" == compose && "$*" == *" ps -q authority"* ]]; then exit 0; fi
if [[ "$1" == image && "$*" == *'org.opencontainers.image.revision'* ]]; then printf '%s\\n' '${"f".repeat(40)}'; exit 0; fi
if [[ "$1" == compose && "$*" == *" up "* ]]; then touch "${up}"; fi
`,
    );
    chmodSync(docker, 0o755);
    writeFileSync(envFile, "ECHO_CLEAN_AUTHORITY_IMAGE=echo-organization-authority:local\n");
    chmodSync(envFile, 0o600);

    const result = run("bash", [UPDATE, "stage", "--release", candidate], {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
    });
    expect(result.status).toBe(1);
    expect(existsSync(up)).toBe(false);
    expect(existsSync(join(state, "failed", "clean-v1-20260822-002.json"))).toBe(true);
    expect(readFileSync(envFile, "utf8")).toContain("d".repeat(64));
  });

  it("verifies an exact artifact before installing it and uses the product status surface", () => {
    expect(run("bash", ["-n", INSTALL]).status).toBe(0);
    const source = readFileSync(INSTALL, "utf8");
    expect(source.indexOf("actual_sha")).toBeLessThan(source.lastIndexOf("npm install"));
    expect(source).toContain("--ignore-scripts");
    expect(source).toContain("--no-audit");
    expect(source).toContain("--no-fund");
    expect(source).toContain("--offline");
    expect(source).toContain('prefix="$HOME/.local"');
    expect(source).toContain("export PATH=");
    expect(source).toContain('"$prefix/bin/echo-brain" person status');
    expect(source).not.toContain("git clone");
    expect(source).not.toContain("session-install");
  });

  it("refuses an artifact digest mismatch before npm can install anything", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-install-"));
    roots.push(root);
    const archive = join(root, "client.tgz");
    const prefix = join(root, "prefix");
    const marker = join(root, "npm-called");
    const bin = join(root, "bin");
    const npm = join(bin, "npm");
    const node = join(bin, "node");
    const release = writeRecord(record());
    writeFileSync(archive, "not the recorded artifact");
    mkdirSync(bin);
    writeFileSync(npm, `#!/usr/bin/env bash\nif [[ "$1" == --version ]]; then printf '10.9.4\\n'; exit 0; fi\ntouch "${marker}"\n`);
    writeFileSync(node, "#!/usr/bin/env bash\nprintf 'v22.22.1\\n'\n");
    chmodSync(npm, 0o755);
    chmodSync(node, 0o755);

    const result = run(
      "bash",
      [INSTALL, "--release", release, "--prefix", prefix, "--artifact", archive],
      { PATH: `${bin}:${process.env.PATH}`, ECHO_TEST_NPM_MARKER: marker },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SHA-256");
    expect(existsSync(marker)).toBe(false);
  });

  it("binds the installed package build identity to the release source commit", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-install-identity-"));
    roots.push(root);
    const archive = join(root, "client.tgz");
    const prefix = join(root, "prefix");
    const bin = join(root, "bin");
    const npm = join(bin, "npm");
    const node = join(bin, "node");
    const bytes = "correct artifact bytes";
    const artifactSha = createHash("sha256").update(bytes).digest("hex");
    const release = writeRecord(record({ person_client: { ...record().person_client, artifact_sha256: artifactSha } }));
    writeFileSync(archive, bytes);
    mkdirSync(bin);
    writeFileSync(node, "#!/usr/bin/env bash\nprintf 'v22.22.1\\n'\n");
    writeFileSync(
      npm,
      `#!/usr/bin/env bash
if [[ "$1" == --version ]]; then printf '10.9.4\\n'; exit 0; fi
for ((i=1; i<=$#; i++)); do
  if [[ "\${!i}" == --prefix ]]; then j=$((i + 1)); prefix="\${!j}"; fi
done
mkdir -p "$prefix/bin" "$prefix/lib/node_modules/@echo-brain/person-client/dist"
printf '#!/usr/bin/env bash\\nif [[ "$1" == --version ]]; then printf "0.1.0-internal.1\\\\n"; else printf "{}\\\\n"; fi\\n' > "$prefix/bin/echo-brain"
chmod 0755 "$prefix/bin/echo-brain"
printf '%s\\n' '{"schema_version":1,"kind":"echo-packaged-build-identity","product_version":"0.1.0-internal.1","source_sha":"${"f".repeat(40)}","source_kind":"materialized-commit"}' > "$prefix/lib/node_modules/@echo-brain/person-client/dist/build-identity.v1.json"
`,
    );
    chmodSync(node, 0o755);
    chmodSync(npm, 0o755);

    const result = run("bash", [INSTALL, "--release", release, "--prefix", prefix, "--artifact", archive], {
      PATH: `${bin}:${process.env.PATH}`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("build identity does not match");
    expect(result.stdout).not.toContain("a".repeat(40));
  });

  it("checks the exact Node and npm versions before creating the install prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-install-version-"));
    roots.push(root);
    const prefix = join(root, "prefix");
    const bin = join(root, "bin");
    const node = join(bin, "node");
    const npm = join(bin, "npm");
    const release = writeRecord(record());
    mkdirSync(bin);
    writeFileSync(node, "#!/usr/bin/env bash\nprintf 'v20.0.0\\n'\n");
    writeFileSync(npm, "#!/usr/bin/env bash\nprintf '10.9.4\\n'\n");
    chmodSync(node, 0o755);
    chmodSync(npm, 0o755);

    const result = run("bash", [INSTALL, "--release", release, "--prefix", prefix, "--artifact", release], {
      PATH: `${bin}:${process.env.PATH}`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Node.js v22.22.1");
    expect(existsSync(prefix)).toBe(false);
  });

  it("refuses a baseline-mismatched candidate before Docker can mutate the deployment", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-baseline-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const marker = join(root, "docker-called");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const current = writeRecord(record());
    const candidate = writeRecord({ ...record(), baseline_compatibility_class: "clean-v2" });
    mkdirSync(bin);
    writeFileSync(docker, `#!/usr/bin/env bash\ntouch "${marker}"\n`);
    chmodSync(docker, 0o755);
    writeFileSync(envFile, `ECHO_CLEAN_AUTHORITY_IMAGE=${record().authority_image.reference}\n`);
    chmodSync(envFile, 0o600);
    mkdirSync(state, { recursive: true });
    copyFileSync(current, join(state, "current.clean-v1.json"));

    const result = run("bash", [UPDATE, "stage", "--release", candidate], {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
    });
    expect(result.status).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(envFile, "utf8")).toContain(record().authority_image.reference);
  });

  it("stages and promotes the first deployment without a manually installed current record", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-first-deploy-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const started = join(root, "started");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const candidateRecord = record({
      release_id: "clean-v1-20260822-002",
      authority_image: {
        reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"d".repeat(64)}`,
      },
    });
    const candidate = writeRecord(candidateRecord);
    mkdirSync(bin);
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
if [[ "$1" == compose && "$*" == *" ps -q authority"* ]]; then
  [[ -f "${started}" ]] && printf 'authority-container\\n'
  exit 0
fi
if [[ "$1" == compose && "$*" == *" up "* ]]; then touch "${started}"; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.State.Running'* ]]; then printf 'true\\n'; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.Image'* ]]; then printf 'sha256:${"e".repeat(64)}\\n'; exit 0; fi
if [[ "$1" == image && "$*" == *'org.opencontainers.image.revision'* ]]; then printf '%s\\n' '${"a".repeat(40)}'; exit 0; fi
if [[ "$1" == image ]]; then printf '%s\\n' '${candidateRecord.authority_image.reference}'; exit 0; fi
`,
    );
    chmodSync(docker, 0o755);
    writeFileSync(envFile, "ECHO_CLEAN_AUTHORITY_IMAGE=echo-organization-authority:local\n");
    chmodSync(envFile, 0o600);

    const environment = {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
    };
    const staged = run("bash", [UPDATE, "stage", "--release", candidate], environment);
    expect(staged.status).toBe(0);
    expect(staged.stdout).toContain('"accepted_release_present":false');
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(true);
    expect(existsSync(join(state, "current.clean-v1.json"))).toBe(false);
    expect(readFileSync(envFile, "utf8")).toContain(candidateRecord.authority_image.reference);

    const promoted = run("bash", [UPDATE, "promote", "--release", candidate, "--canary-passed"], environment);
    expect(promoted.status).toBe(0);
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(false);
    expect(existsSync(join(state, "current.clean-v1.json"))).toBe(true);
  });

  it("finalizes a promotion crash window idempotently and permits the next update", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-promote-retry-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const accepted = record({
      release_id: "clean-v1-20260822-002",
      authority_image: { reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"d".repeat(64)}` },
    });
    const next = record({
      release_id: "clean-v1-20260822-003",
      authority_image: { reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"e".repeat(64)}` },
    });
    const acceptedPath = writeRecord(accepted);
    const nextPath = writeRecord(next);
    mkdirSync(bin);
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
if [[ "$1" == compose && "$*" == *" ps -q authority"* ]]; then printf 'authority-container\\n'; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.State.Running'* ]]; then printf 'true\\n'; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.Image'* ]]; then printf 'sha256:${"f".repeat(64)}\\n'; exit 0; fi
if [[ "$1" == image && "$*" == *'org.opencontainers.image.revision'* ]]; then printf '%s\\n' '${"a".repeat(40)}'; exit 0; fi
if [[ "$1" == image ]]; then printf '%s\\n' '${accepted.authority_image.reference}' '${next.authority_image.reference}'; exit 0; fi
`,
    );
    chmodSync(docker, 0o755);
    writeFileSync(envFile, `ECHO_CLEAN_AUTHORITY_IMAGE=${accepted.authority_image.reference}\n`);
    chmodSync(envFile, 0o600);
    mkdirSync(state, { recursive: true });
    copyFileSync(acceptedPath, join(state, "current.clean-v1.json"));
    copyFileSync(acceptedPath, join(state, "candidate.clean-v1.json"));
    const environment = {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
    };

    const retry = run("bash", [UPDATE, "promote", "--release", acceptedPath, "--canary-passed"], environment);
    expect(retry.status).toBe(0);
    expect(retry.stdout).toContain('"idempotent":true');
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(false);
    expect(existsSync(join(state, "history", "clean-v1-20260822-002.json"))).toBe(false);

    const staged = run("bash", [UPDATE, "stage", "--release", nextPath], environment);
    expect(staged.status).toBe(0);
    const promoted = run("bash", [UPDATE, "promote", "--release", nextPath, "--canary-passed"], environment);
    expect(promoted.status).toBe(0);
    expect(existsSync(join(state, "history", "clean-v1-20260822-002.json"))).toBe(true);
  });

  it("rejects a reused release ID before Docker can mutate the deployment", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-reuse-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const marker = join(root, "docker-called");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const candidate = writeRecord(record());
    mkdirSync(bin);
    writeFileSync(docker, `#!/usr/bin/env bash\ntouch "${marker}"\n`);
    chmodSync(docker, 0o755);
    writeFileSync(envFile, `ECHO_CLEAN_AUTHORITY_IMAGE=${record().authority_image.reference}\n`);
    chmodSync(envFile, 0o600);
    mkdirSync(join(state, "history"), { recursive: true });
    copyFileSync(candidate, join(state, "history", "clean-v1-20260822-001.json"));

    const result = run("bash", [UPDATE, "stage", "--release", candidate], {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release_id was already used");
    expect(existsSync(marker)).toBe(false);
  });

  it("does not claim an accepted release while a staged candidate has a corrupt current record", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-status-current-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const candidate = writeRecord(record({ release_id: "clean-v1-20260822-002" }));
    writeFileSync(envFile, `ECHO_CLEAN_AUTHORITY_IMAGE=${record().authority_image.reference}\n`);
    chmodSync(envFile, 0o600);
    mkdirSync(state, { recursive: true });
    copyFileSync(candidate, join(state, "candidate.clean-v1.json"));
    writeFileSync(join(state, "current.clean-v1.json"), "not a release record\n");

    const result = run("bash", [UPDATE, "status"], {
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("clean-v1 release record");
  });

  it("does not claim an accepted release through a current-record symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-status-symlink-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const candidate = writeRecord(record({ release_id: "clean-v1-20260822-002" }));
    writeFileSync(envFile, `ECHO_CLEAN_AUTHORITY_IMAGE=${record().authority_image.reference}\n`);
    chmodSync(envFile, 0o600);
    mkdirSync(state, { recursive: true });
    copyFileSync(candidate, join(state, "candidate.clean-v1.json"));
    symlinkSync(candidate, join(state, "current.clean-v1.json"));

    const result = run("bash", [UPDATE, "status"], {
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("regular file");
  });

  it("restores the previous compatible digest when candidate startup health fails", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-rollback-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const log = join(root, "docker.log");
    const count = join(root, "up-count");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const currentRecord = record();
    const candidateRecord = record({
      release_id: "clean-v1-20260822-002",
      authority_image: {
        reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"d".repeat(64)}`,
      },
    });
    const current = writeRecord(currentRecord);
    const candidate = writeRecord(candidateRecord);
    mkdirSync(bin);
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
if [[ "$1" == compose && "$*" == *" ps -q authority"* ]]; then printf 'authority-container\\n'; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.State.Running'* ]]; then printf 'true\\n'; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.Image'* ]]; then printf 'sha256:${"e".repeat(64)}\\n'; exit 0; fi
if [[ "$1" == image && "$*" == *'org.opencontainers.image.revision'* ]]; then printf '%s\\n' '${"a".repeat(40)}'; exit 0; fi
if [[ "$1" == image ]]; then
  printf '%s\\n' '${currentRecord.authority_image.reference}' '${candidateRecord.authority_image.reference}'
  exit 0
fi
if [[ "$1" == compose && "$*" == *" up "* ]]; then
  if [[ ! -f "${count}" ]]; then touch "${count}"; exit 1; fi
fi
`,
    );
    chmodSync(docker, 0o755);
    writeFileSync(envFile, `ECHO_CLEAN_AUTHORITY_IMAGE=${currentRecord.authority_image.reference}\n`);
    chmodSync(envFile, 0o600);
    mkdirSync(state, { recursive: true });
    copyFileSync(current, join(state, "current.clean-v1.json"));

    const result = run("bash", [UPDATE, "stage", "--release", candidate], {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("previous compatible image was restored and verified");
    expect(readFileSync(envFile, "utf8")).toContain(currentRecord.authority_image.reference);
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(false);
    expect(existsSync(join(state, "failed", "clean-v1-20260822-002.json"))).toBe(true);
    expect(readFileSync(log, "utf8")).toContain(" pull authority");
    expect(readFileSync(log, "utf8").match(/ up /g)).toHaveLength(2);
  });

  it("keeps a staged candidate through a transient rollback failure so rollback can be retried", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-rollback-retry-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const count = join(root, "up-count");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const currentRecord = record();
    const candidateRecord = record({
      release_id: "clean-v1-20260822-002",
      authority_image: {
        reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"d".repeat(64)}`,
      },
    });
    const current = writeRecord(currentRecord);
    const candidate = writeRecord(candidateRecord);
    mkdirSync(bin);
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
if [[ "$1" == compose && "$*" == *" ps -q authority"* ]]; then printf 'authority-container\\n'; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.State.Running'* ]]; then printf 'true\\n'; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.Image'* ]]; then printf 'sha256:${"e".repeat(64)}\\n'; exit 0; fi
if [[ "$1" == image && "$*" == *'org.opencontainers.image.revision'* ]]; then printf '%s\\n' '${"a".repeat(40)}'; exit 0; fi
if [[ "$1" == image ]]; then printf '%s\\n' '${currentRecord.authority_image.reference}' '${candidateRecord.authority_image.reference}'; exit 0; fi
if [[ "$1" == compose && "$*" == *" up "* ]]; then
  if [[ ! -f "${count}" ]]; then touch "${count}"; exit 1; fi
fi
`,
    );
    chmodSync(docker, 0o755);
    writeFileSync(envFile, `ECHO_CLEAN_AUTHORITY_IMAGE=${candidateRecord.authority_image.reference}\n`);
    chmodSync(envFile, 0o600);
    mkdirSync(state, { recursive: true });
    copyFileSync(current, join(state, "current.clean-v1.json"));
    copyFileSync(candidate, join(state, "candidate.clean-v1.json"));
    const environment = {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
    };

    const failed = run("bash", [UPDATE, "rollback"], environment);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("candidate remains staged");
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(true);
    expect(existsSync(join(state, "failed", "clean-v1-20260822-002.json"))).toBe(false);

    const retried = run("bash", [UPDATE, "rollback"], environment);
    expect(retried.status).toBe(0);
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(false);
    expect(existsSync(join(state, "failed", "clean-v1-20260822-002.json"))).toBe(true);
  });
});
