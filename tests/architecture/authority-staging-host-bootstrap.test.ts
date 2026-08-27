import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
      "RELEASE_VALIDATOR_SOURCE",
      "RUNTIME_PROFILE_VALIDATOR_SOURCE",
    ]) {
      expect(script).toContain(source);
    }
    for (const target of [
      "$DEPLOY_DIR/onboard-clean-v1.sh",
      "$DEPLOY_DIR/update-clean-v1.sh",
      "$DEPLOY_DIR/restore-clean-v1-host.sh",
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
