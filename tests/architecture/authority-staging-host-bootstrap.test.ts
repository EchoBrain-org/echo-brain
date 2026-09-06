import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const BOOTSTRAP = resolve(
  REPO,
  "deploy/organization-authority/bootstrap-ubuntu-arm64.sh",
);
const TUNNEL_INSTALLER = resolve(
  REPO,
  "deploy/organization-authority/install-cloudflare-tunnel-token.sh",
);

function bootstrap(): string {
  return readFileSync(BOOTSTRAP, "utf8");
}

function tunnelInstaller(): string {
  return readFileSync(TUNNEL_INSTALLER, "utf8");
}

function bootstrapFunction(name: string): string {
  const definition = bootstrap().match(
    new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "m"),
  )?.[0];
  if (!definition) {
    throw new Error(`${name} is missing from the staging bootstrap script`);
  }
  return definition;
}

type VolumeInitializationCase = {
  initialize?: boolean;
  marker?: boolean;
  markerVolumeId?: string;
  rootState?: string;
  lostFoundEntry?: boolean;
  topLevelEntry?: boolean;
  mutateOwnership?: boolean;
};

function runVolumeInitializationCase({
  initialize = true,
  marker = true,
  markerVolumeId = "vol-0123456789abcdef0",
  rootState = "0:0:755",
  lostFoundEntry = false,
  topLevelEntry = false,
  mutateOwnership = true,
}: VolumeInitializationCase = {}) {
  const root = mkdtempSync(join(tmpdir(), "echo-volume-initialization-"));
  const markerPath = join(root, ".echo-authority-volume-initialization-v1");
  const lostFound = join(root, "lost+found");
  const trace = join(root, "trace");
  mkdirSync(lostFound);
  if (marker) {
    writeFileSync(
      markerPath,
      "schema=echo-authority-volume-initialization-v1\n" +
        `data_volume_id=${markerVolumeId}\n`,
      { mode: 0o600 },
    );
  }
  if (lostFoundEntry) {
    writeFileSync(join(lostFound, "unexpected"), "state");
  }
  if (topLevelEntry) {
    writeFileSync(join(root, "unexpected"), "state");
  }

  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
AUTHORITY_UID=999
AUTHORITY_GID=988
DATA_DIR=$1
VOLUME_INITIALIZATION_MARKER=.echo-authority-volume-initialization-v1
VOLUME_INITIALIZATION_SCHEMA=echo-authority-volume-initialization-v1
DATA_VOLUME_ID=vol-0123456789abcdef0
INITIALIZE_BLANK_DATA_VOLUME=$2
TRACE=$3
harness_root_state=$4
mutate_ownership=$5

${bootstrapFunction("fail")}
${bootstrapFunction("finish_pending_volume_initialization")}

# These are the privileged or filesystem-metadata commands that the production
# function uses.  The harness models their effects in shell state, so it needs
# neither a block device nor root access.
stat() {
  case $2 in
    '%u:%g:%a')
      case $3 in
        "$DATA_DIR") printf '%s\\n' "$harness_root_state" ;;
        "$DATA_DIR/$VOLUME_INITIALIZATION_MARKER") printf '0:0:600\\n' ;;
        "$DATA_DIR/lost+found") printf '0:0:700\\n' ;;
        *) return 1 ;;
      esac
      ;;
    '%s') wc -c <"$3" | tr -d ' ' ;;
    *) return 1 ;;
  esac
}
chown() {
  printf 'chown:%s:%s\\n' "$1" "$2" >>"$TRACE"
  if [[ $mutate_ownership == true ]]; then
    harness_root_state="$AUTHORITY_UID:$AUTHORITY_GID:755"
  fi
}
chmod() {
  printf 'chmod:%s:%s\\n' "$1" "$2" >>"$TRACE"
  if [[ $mutate_ownership == true && $1 == 0700 ]]; then
    harness_root_state="$AUTHORITY_UID:$AUTHORITY_GID:700"
  fi
}
rm() {
  printf 'rm:%s\\n' "$3" >>"$TRACE"
  command rm "$@"
}

finish_pending_volume_initialization
`,
        "volume-initialization-harness",
        root,
        String(initialize),
        trace,
        rootState,
        String(mutateOwnership),
      ],
      { encoding: "utf8" },
    );
    return {
      ...result,
      markerExists: existsSync(markerPath),
      trace: existsSync(trace)
        ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean)
        : [],
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function executableTunnelInstaller() {
  const root = mkdtempSync(join(tmpdir(), "echo-tunnel-installer-"));
  const installer = join(root, "install-cloudflare-tunnel-token.sh");
  const asmExec = join(root, "asm-exec");
  const stat = join(root, "stat");
  writeFileSync(
    installer,
    tunnelInstaller()
      .replace("ASM_EXEC=/usr/local/bin/asm-exec", `ASM_EXEC=${asmExec}`)
      .replace("RESOLUTION_ATTEMPTS=4", "RESOLUTION_ATTEMPTS=1"),
    { mode: 0o700 },
  );
  writeFileSync(
    asmExec,
    `#!/bin/sh
set -eu
[ "\${1-}" = -- ]
shift
ECHO_CLOUDFLARE_TUNNEL_TOKEN=resolved-test-placeholder exec "$@"
`,
    { mode: 0o700 },
  );
  writeFileSync(stat, "#!/bin/sh\nprintf '0:600\\n'\n", { mode: 0o700 });
  chmodSync(installer, 0o700);
  chmodSync(asmExec, 0o700);
  chmodSync(stat, 0o700);
  return { installer, root };
}

describe("Authority staging host bootstrap", () => {
  it("pins the fixed Authority identity and verifies it instead of accepting host allocation", () => {
    const script = bootstrap();

    expect(script).toContain("AUTHORITY_UID=999");
    expect(script).toContain("AUTHORITY_GID=988");
    expect(script).toContain('groupadd --gid "$AUTHORITY_GID" --system echo-authority');
    expect(script).toContain('useradd --uid "$AUTHORITY_UID" --gid "$AUTHORITY_GID" --system');
    expect(script).toContain("echo-authority does not have the required fixed UID/GID");
  });

  it("requires explicit non-secret infrastructure identity and persists only root-owned configuration", () => {
    const script = bootstrap();

    for (const option of [
      "--region",
      "--tunnel-secret-arn",
      "--tunnel-secret-reference",
      "--ecr-registry",
      "--data-volume-id",
    ]) {
      expect(script).toContain(option);
    }
    expect(script).toContain("CONFIG_FILE=\"$CONFIG_DIR/host-bootstrap.conf\"");
    expect(script).toContain("install -d -o root -g root -m 0700 \"$CONFIG_DIR\"");
    expect(script).toContain("configuration file must be owned by root with mode 0600");
    expect(script).not.toContain("TUNNEL_CONFIG_FILE");
    expect(script).not.toContain("write_tunnel_config");
    expect(script).not.toMatch(/--config\s+<\/etc/);
    expect(script).not.toMatch(/org1-prod|echo\/org1/i);
  });

  it("accepts only an exact dynamic secret reference and leaves the Tunnel stopped", () => {
    const script = bootstrap();

    expect(script).toContain(
      "{{resolve:secretsmanager:%s:SecretString:token}}",
    );
    expect(script).toContain("validate_secret_reference");
    expect(script).toMatch(/dynamic\s+Secrets Manager reference only at runtime through asm-exec/);
    expect(script).toContain("systemctl disable --now cloudflared-echo-authority.service");
    expect(script).toContain("Authority Cloudflare Tunnel must remain stopped until token installation");
    expect(script).not.toMatch(/get-secret-value|batch-get-secret-value/i);
  });

  it("uses a verified detached EBS disk and refuses an unsafe data cutover", () => {
    const script = bootstrap();

    expect(script).toContain("DATA_DIR=\"$DEPLOY_DIR/clean-data\"");
    expect(script).toContain("resolve_data_device");
    expect(script).toContain("attached data device serial does not match the supplied EBS volume ID");
    expect(script).toContain("refusing to use the root device as Authority data volume");
    expect(script).toContain("--initialize-blank-data-volume");
    expect(script).toContain("refusing to format a device that contains an unrecognized signature");
    expect(script).toContain("refusing to mount over non-empty root-volume Authority data path");
    expect(script).toContain("mount -o noexec,nodev,nosuid \"$device\" \"$DATA_DIR\"");
    expect(script).toContain(
      "mounted Authority data root has unexpected ownership; refusing to rewrite existing state ownership",
    );
  });

  it("uses a volume-bound filesystem marker to resume only pristine blank-volume initialization", () => {
    const script = bootstrap();

    expect(script).toContain("DATA_VOLUME_LABEL=echo-auth-data");
    expect(script).toContain(
      "VOLUME_INITIALIZATION_MARKER=.echo-authority-volume-initialization-v1",
    );
    expect(script).toContain('mkfs.ext4 -F -L "$DATA_VOLUME_LABEL"');
    expect(script).toContain(
      "Ubuntu Noble e2fsprogs 1.47.0 accepts root_owner but not root_perms",
    );
    expect(script).toContain('-E root_owner=0:0 -d "$initialization_seed"');
    expect(script).not.toContain("root_perms=");
    expect(script).toContain('-d "$initialization_seed"');
    expect(script).toContain("data_volume_id=%s");
    expect(script).toContain("finish_pending_volume_initialization");
    expect(script).toContain(
      "unfinished blank data volume initialization requires --initialize-blank-data-volume",
    );
    expect(script).toContain(
      "blank data volume contains state outside its initialization marker",
    );
    expect(script).toContain(
      "blank data volume initialization marker does not match this volume",
    );
    expect(script).toContain(
      'chown "$AUTHORITY_UID:$AUTHORITY_GID" "$DATA_DIR"',
    );
    expect(script).toContain('rm -f -- "$marker"');
    expect(script).not.toMatch(/chown\s+(?:-[^\s]+\s+)*-R/);

    const initialize = script.indexOf(
      "finish_pending_volume_initialization() {",
    );
    const chown = script.indexOf(
      'chown "$AUTHORITY_UID:$AUTHORITY_GID" "$DATA_DIR"',
      initialize,
    );
    const chmod = script.indexOf('chmod 0700 "$DATA_DIR"', chown);
    const removeMarker = script.indexOf('rm -f -- "$marker"', chmod);
    expect(initialize).toBeGreaterThan(-1);
    expect(chown).toBeGreaterThan(initialize);
    expect(chmod).toBeGreaterThan(chown);
    expect(removeMarker).toBeGreaterThan(chmod);
  });

  it.each([
    ["fresh ext4 root", "0:0:755"],
    ["after chown", "999:988:755"],
    ["after chmod", "999:988:700"],
  ])(
    "resumes pending blank-volume initialization from the %s crash boundary",
    (_boundary, rootState) => {
      const result = runVolumeInitializationCase({ rootState });

      expect(result.status, result.stderr).toBe(0);
      expect(result.markerExists).toBe(false);
      expect(result.trace).toEqual([
        expect.stringMatching(/^chown:999:988:/),
        expect.stringMatching(/^chmod:0700:/),
        expect.stringMatching(/^rm:/),
      ]);
    },
  );

  it.each([
    [
      "the explicit initialization flag is absent",
      { initialize: false },
      "unfinished blank data volume initialization requires --initialize-blank-data-volume",
    ],
    [
      "the marker is missing",
      { marker: false },
      "blank data volume initialization marker is missing or unsafe",
    ],
    [
      "the marker is bound to another volume",
      { markerVolumeId: "vol-11111111111111111" },
      "blank data volume initialization marker does not match this volume",
    ],
    [
      "lost+found is non-empty",
      { lostFoundEntry: true },
      "blank data volume lost+found directory is not empty",
    ],
    [
      "an extra top-level entry exists",
      { topLevelEntry: true },
      "blank data volume contains state outside its initialization marker",
    ],
    [
      "the root ownership is outside the crash-resume states",
      { rootState: "0:0:700" },
      "blank data volume root is outside the allowed initialization states",
    ],
  ])("fails closed without repair when %s", (_description, testCase, error) => {
    const result = runVolumeInitializationCase(testCase);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
    expect(result.trace).not.toContainEqual(
      expect.stringMatching(/^chown:/),
    );
    expect(result.markerExists).toBe(
      !("marker" in testCase && testCase.marker === false),
    );
  });

  it("retains the marker when final ownership verification fails", () => {
    const result = runVolumeInitializationCase({ mutateOwnership: false });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "blank data volume ownership initialization did not complete",
    );
    expect(result.trace).toEqual([
      expect.stringMatching(/^chown:999:988:/),
      expect.stringMatching(/^chmod:0700:/),
    ]);
    expect(result.markerExists).toBe(true);
  });

  it("does not enter initialization repair for an already initialized organization volume", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-initialized-volume-"));
    const trace = join(root, "trace");
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
AUTHORITY_UID=999
AUTHORITY_GID=988
DATA_DIR=$1
DATA_VOLUME_LABEL=echo-auth-data
VOLUME_INITIALIZATION_MARKER=.echo-authority-volume-initialization-v1
INITIALIZE_BLANK_DATA_VOLUME=false
TRACE=$2

${bootstrapFunction("fail")}
${bootstrapFunction("finish_pending_volume_initialization")}
${bootstrapFunction("mount_data_volume")}

finish_pending_volume_initialization() {
  printf 'repair-entered\\n' >>"$TRACE"
  return 99
}
mountpoint() { [[ $1 == -q && $2 == "$DATA_DIR" ]]; }
findmnt() {
  case "$*" in
    *SOURCE*) printf '/dev/fake-data-volume\\n' ;;
    *FSTYPE*) printf 'ext4\\n' ;;
    *) return 1 ;;
  esac
}
readlink() { printf '%s\\n' "\${!#}"; }
blkid() { printf 'echo-auth-data\\n'; }
ensure_fstab_mount() { printf 'fstab-verified\\n' >>"$TRACE"; }
stat() {
  [[ $2 == '%u:%g:%a' && $3 == "$DATA_DIR" ]] \\
    && printf '999:988:700\\n'
}

mount_data_volume /dev/fake-data-volume
`,
          "already-initialized-volume-harness",
          root,
          trace,
        ],
        { encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(trace) ? readFileSync(trace, "utf8").trim() : "").toBe(
        "fstab-verified",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("writes the volume initialization marker under Bash nounset", () => {
    const definition = bootstrap().match(
      /^write_volume_initialization_seed\(\) \{\n[\s\S]*?^\}$/m,
    )?.[0];
    if (!definition) {
      throw new Error("volume initialization seed writer is missing");
    }

    const seedDir = mkdtempSync(join(tmpdir(), "echo-volume-seed-"));
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
VOLUME_INITIALIZATION_MARKER=.echo-authority-volume-initialization-v1
VOLUME_INITIALIZATION_SCHEMA=echo-authority-volume-initialization-v1
DATA_VOLUME_ID=vol-0123456789abcdef0
chown() { :; }
${definition}
unset seed_dir marker
write_volume_initialization_seed "$1"
`,
          "bootstrap-seed-test",
          seedDir,
        ],
        { encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
      const marker = join(
        seedDir,
        ".echo-authority-volume-initialization-v1",
      );
      expect(readFileSync(marker, "utf8")).toBe(
        "schema=echo-authority-volume-initialization-v1\n" +
          "data_volume_id=vol-0123456789abcdef0\n",
      );
      expect(statSync(marker).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(seedDir, { force: true, recursive: true });
    }
  });

  it.each([
    ["install_asm_exec", "curl --fail", "asm_exec", "asm-exec"],
    [
      "install_cloudflared",
      "curl --fail",
      "package",
      "cloudflared-linux-arm64.deb",
    ],
    [
      "install_ecr_helper_config",
      "install -d",
      "config",
      "docker-config.json",
    ],
  ])(
    "initializes the %s derived path under Bash nounset",
    (helper, firstEffect, derivedVariable, filename) => {
      const script = bootstrap();
      const bodyStart = script.indexOf(`${helper}() {\n`) + helper.length + 5;
      const firstEffectStart = script.indexOf(`  ${firstEffect}`, bodyStart);
      if (bodyStart < helper.length + 5 || firstEffectStart < bodyStart) {
        throw new Error(`${helper} initialization is missing`);
      }
      const initialization = script.slice(bodyStart, firstEffectStart);
      const temporary = join(tmpdir(), "echo-post-docker-helper");
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
probe() {
${initialization}  printf '%s\\n' "$${derivedVariable}"
}
unset temporary ${derivedVariable}
probe "$1"
`,
          "post-docker-helper-test",
          temporary,
        ],
        { encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${join(temporary, filename)}\n`);
    },
  );

  it("fails closed before Docker can restart containers without the exact verified data mount", () => {
    const script = bootstrap();

    expect(script).toContain("RequiresMountsFor=$DATA_DIR");
    expect(script).toContain("ExecStartPre=$guard");
    expect(script).toContain("mountpoint -q \"$data_dir\"");
    expect(script).toContain("Authority data mount source does not match configured EBS volume");
    expect(script).toContain("Authority data mount ownership or mode is unsafe");
    expect(script).toContain("systemctl disable --now docker.socket");

    const mount = script.lastIndexOf('mount_data_volume "$data_device"');
    const guard = script.lastIndexOf("install_docker_mount_guard");
    const docker = script.lastIndexOf("systemctl enable --now docker.service");
    expect(mount).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(mount);
    expect(docker).toBeGreaterThan(guard);
  });

  it("installs only the verified non-secret deployment control material after the retained data volume is mounted", () => {
    const script = bootstrap();

    for (const source of [
      "ONBOARD_SOURCE",
      "UPDATER_SOURCE",
      "RESTORER_SOURCE",
      "BACKUP_SOURCE",
      "RELEASE_VALIDATOR_SOURCE",
      "RUNTIME_PROFILE_VALIDATOR_SOURCE",
    ]) {
      expect(script).toContain(source);
    }
    for (const target of [
      "$DEPLOY_DIR/onboard-clean-v1.sh",
      "$DEPLOY_DIR/update-clean-v1.sh",
      "$DEPLOY_DIR/restore-clean-v1-host.sh",
      "$DEPLOY_DIR/backup-authority-maintenance.sh",
      "$DEPLOY_DIR/release/clean-v1-release.py",
      "$DEPLOY_DIR/release/clean-v1-runtime-profile.py",
    ]) {
      expect(script).toContain(target);
    }
    expect(script).toContain("install_authority_application_control_material");
    expect(script).toContain("mount_data_volume \"$data_device\"");
    expect(script.indexOf("mount_data_volume \"$data_device\"")).toBeLessThan(
      script.lastIndexOf("install_authority_application_control_material"),
    );
    expect(script).not.toContain("copy credentials");
    expect(script).not.toContain("current.clean-v1.json");
  });

  it("pins cloudflared plus upstream and patched asm-exec before installation", () => {
    const script = bootstrap();

    expect(script).toContain("CLOUDFLARED_VERSION=2026.7.3");
    expect(script).toContain(
      "CLOUDFLARED_SHA256=d3ea7d22dd337b465da33d6bc1c4b3cfd381407447a2a7d29542c19783430db3",
    );
    expect(script).toContain(
      "ASM_EXEC_UPSTREAM_SHA256=d55eb38ad33a5b76f584ca180f633ecc120cf39b8fd29427ffbe11a8fbf19556",
    );
    expect(script).toContain(
      "ASM_EXEC_PATCHED_SHA256=1fbb03673905a55fa4ace3bb80ecd383e75d81de72c40fab23c11b0a7c0f4e89",
    );
    expect(script).toContain("structuredContent");
    expect(script).toMatch(/sha256sum --check --status[\s\S]+upstream asm-exec checksum mismatch/);
    expect(script).toMatch(/sha256sum --check --status[\s\S]+patched asm-exec checksum mismatch/);
    expect(script).toMatch(/sha256sum --check --status[\s\S]+cloudflared package checksum mismatch/);
  });

  it("uses the combined host bootstrap configuration for the installed token helper and rejects a raw-token interface", () => {
    const script = tunnelInstaller();

    expect(script).toContain("CONFIG_FILE=/etc/echo-authority/host-bootstrap.conf");
    expect(script).toContain("--tunnel-secret-reference");
    expect(script).toContain("validate_reference");
    expect(script).toContain(":SecretString:token");
    expect(script).toContain('"$ASM_EXEC" -- "$0" "$resolved_action"');
    expect(script).toContain("unset ECHO_CLOUDFLARE_TUNNEL_TOKEN");
    expect(script).not.toContain("--config");
    expect(script).not.toContain("--token");
    expect(script).not.toMatch(/get-secret-value|batch-get-secret-value/i);
  });

  it.each(["explicit arguments", "combined host config"])(
    "preserves %s across the asm-exec child boundary",
    (configuration) => {
      const fixture = executableTunnelInstaller();
      try {
        const reference =
          "{{resolve:secretsmanager:arn:aws:secretsmanager:us-west-2:123456789012:secret:echo/staging/tunnel-abc:SecretString:token}}";
        let args: string[];
        if (configuration === "explicit arguments") {
          args = [
            fixture.installer,
            "--region",
            "us-west-2",
            "--tunnel-secret-reference",
            reference,
            "--check",
          ];
        } else {
          const config = join(fixture.root, "host-bootstrap.conf");
          writeFileSync(
            config,
            [
              "AWS_REGION=us-west-2",
              `TUNNEL_SECRET_REFERENCE=${reference}`,
              "ECR_REGISTRY=123456789012.dkr.ecr.us-west-2.amazonaws.com",
              "DATA_VOLUME_ID=vol-0123456789abcdef0",
              "DATA_DEVICE=/dev/nvme1n1",
              "",
            ].join("\n"),
            { mode: 0o600 },
          );
          const configuredInstaller = join(
            fixture.root,
            "configured-install-cloudflare-tunnel-token.sh",
          );
          writeFileSync(
            configuredInstaller,
            tunnelInstaller()
              .replace(
                "ASM_EXEC=/usr/local/bin/asm-exec",
                `ASM_EXEC=${join(fixture.root, "asm-exec")}`,
              )
              .replace("RESOLUTION_ATTEMPTS=4", "RESOLUTION_ATTEMPTS=1")
              .replace(
                "CONFIG_FILE=/etc/echo-authority/host-bootstrap.conf",
                `CONFIG_FILE=${config}`,
              ),
            { mode: 0o700 },
          );
          chmodSync(configuredInstaller, 0o700);
          args = [configuredInstaller, "--check"];
        }
        const result = spawnSync("bash", args, {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${fixture.root}:${process.env.PATH ?? ""}`,
          },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(
          "Cloudflare Tunnel secret resolution succeeded.",
        );
        expect(result.stdout).not.toContain("resolved-test-placeholder");
        expect(result.stderr).not.toContain("resolved-test-placeholder");
      } finally {
        rmSync(fixture.root, { force: true, recursive: true });
      }
    },
  );
});
