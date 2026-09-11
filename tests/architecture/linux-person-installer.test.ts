import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const REPO = resolve(import.meta.dirname, "..", "..");
const INSTALLER = join(REPO, "deploy/release/start-person-onboarding-kit-linux.sh");
const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "echo-linux-installer-"));
  roots.push(root);
  const home = join(root, "home");
  const kit = join(root, "kit");
  const tools = join(root, "tools");
  for (const path of [home, kit, tools]) mkdirSync(path, { mode: 0o700 });
  const tool = (name: string, body: string) => writeFileSync(join(tools, name), `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
  tool("uname", 'if [[ "${WRONG_OS:-}" == yes ]]; then echo Darwin; elif [[ "$1" == -s ]]; then echo Linux; else echo x86_64; fi');
  tool("getconf", '[[ "${MUSL:-}" != yes ]] && echo "glibc 2.36"');
  tool("od", 'if [[ "${WRONG_ELF:-}" == yes ]]; then printf " 127 69 76 70 2 1 1 0 0 0 0 0 0 0 0 0 0 0 3 0\\n"; else printf " 127 69 76 70 2 1 1 0 0 0 0 0 0 0 0 0 0 0 62 0\\n"; fi');
  if (process.platform === "darwin") {
    tool("stat", 'if [[ "$2" == %u ]]; then /usr/bin/stat -f %u "$3"; else /usr/bin/stat -f %Lp "$3"; fi');
  }
  const installer = readFileSync(INSTALLER, "utf8");
  writeFileSync(join(kit, "Start-ECHO.sh"), installer, { mode: 0o755 });
  writeFileSync(join(kit, "node"), `#!/usr/bin/env bash\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  writeFileSync(join(kit, "verify-person-onboarding-kit.mjs"), 'if (process.env.REJECT_KIT) process.exit(1);\n');
  writeFileSync(join(kit, "clean-v1-release.mjs"), `import {readFileSync} from 'node:fs';
const record=JSON.parse(readFileSync(process.argv[3]));
if(process.argv[2] === 'field') console.log(record[process.argv[4]] ?? record.person_client[process.argv[4] === 'client-version' ? 'version' : '']);
else if(process.argv[2] !== 'validate') process.exit(1);
`);
  writeFileSync(join(kit, "kit-manifest.v1.json"), "{}\n");
  writeFileSync(join(kit, "build-identity.v1.json"), "{}\n");
  function prepare(release: number) {
    const version = `0.1.${release}`;
    const releaseId = `clean-v1-linux-${release}`;
    writeFileSync(join(kit, "release.json"), JSON.stringify({ "release-id": releaseId, "client-version": version }));
    const packageRoot = join(root, "package");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(packageRoot, "dist", "main.js"), `const args=process.argv.slice(2); if(args[0] === '--version') console.log('${version}'); else if(args[0] === 'person' && args[1] === 'status') console.log(JSON.stringify({kind:'echo-person-client-status-v1',signed_in:process.env.SIGNED_IN === 'yes'})); else if(args[0] === 'person' && args[1] === 'login') console.log(JSON.stringify(args));\n`);
    execFileSync("tar", ["-czf", join(kit, "person-client.tgz"), "package"], { cwd: root });
  }
  let preparedRelease: number | undefined;
  function run(release: number, argument = "--install-only", env: Record<string, string> = {}) {
    if (preparedRelease !== release) {
      prepare(release);
      preparedRelease = release;
    }
    return spawnSync("bash", [join(kit, "Start-ECHO.sh"), argument], { encoding: "utf8", env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), PATH: `${tools}:${process.env.PATH}`, ...env } });
  }
  return { root, home, kit, run, prepare };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Linux x64 Person onboarding installer", () => {
  it("installs with its bundled runtime, reuses a matching release, and retains an earlier release", () => {
    const subject = fixture();
    const first = subject.run(1);
    expect(first.status, first.stderr).toBe(0);
    const wrapper = join(subject.home, ".local/share/echo/person/bin/echo-brain");
    expect(existsSync(wrapper)).toBe(true);
    expect(execFileSync("bash", [wrapper, "--version"], { encoding: "utf8" }).trim()).toBe("0.1.1");
    const reinstalled = subject.run(1);
    expect(reinstalled.status, reinstalled.stderr).toBe(0);
    expect(subject.run(2).status).toBe(0);
    const releases = join(subject.home, ".local/share/echo/person/releases");
    expect(existsSync(join(releases, "clean-v1-linux-1"))).toBe(true);
    expect(existsSync(join(releases, "clean-v1-linux-2"))).toBe(true);
  });

  it("refuses an altered retained client payload or a changed same-release artifact", () => {
    const subject = fixture();
    expect(subject.run(1).status).toBe(0);
    const main = join(subject.home, ".local/share/echo/person/releases/clean-v1-linux-1/package/dist/main.js");
    writeFileSync(main, "tampered");
    const changedPayload = subject.run(1);
    expect(changedPayload.status).toBe(1);
    expect(changedPayload.stderr).toContain("payload does not match");

    const another = fixture();
    expect(another.run(1).status).toBe(0);
    writeFileSync(join(another.kit, "person-client.tgz"), "tampered");
    const changedArtifact = another.run(1);
    expect(changedArtifact.status).toBe(1);
    expect(changedArtifact.stderr).toContain("different release artifacts");

    const linked = fixture();
    expect(linked.run(1).status).toBe(0);
    const packagePath = join(linked.home, ".local/share/echo/person/releases/clean-v1-linux-1/package");
    rmSync(packagePath, { recursive: true });
    symlinkSync(join(linked.root, "outside-package"), packagePath);
    const symlinkedPayload = linked.run(1);
    expect(symlinkedPayload.status).toBe(1);
    expect(symlinkedPayload.stderr).toContain("entrypoint is missing");
  });

  it("fails before executing Node for the wrong ELF header and rejects verifier tampering", () => {
    const subject = fixture();
    const wrongHeader = subject.run(1, "--install-only", { WRONG_ELF: "yes", REJECT_KIT: "1" });
    expect(wrongHeader.status).toBe(1);
    expect(wrongHeader.stderr).toContain("x86_64 ELF executable");
    const tampered = subject.run(2, "--install-only", { REJECT_KIT: "1" });
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toContain("onboarding kit verification failed");
  });

  it("refuses missing or relative invitations, a held lock, and symlinked data paths", () => {
    const subject = fixture();
    const missing = subject.run(1, "relative.json");
    expect(missing.status).toBe(2);
    const root = join(subject.home, ".local/share/echo/person");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, ".installer-lock"), { mode: 0o700 });
    const locked = subject.run(1);
    expect(locked.status).toBe(1);
    expect(locked.stderr).toContain("installer lock");
    rmSync(join(root, ".installer-lock"), { recursive: true });
    const linked = fixture();
    mkdirSync(join(linked.home, ".local/share"), { recursive: true });
    symlinkSync(join(linked.home, ".local/share"), join(linked.home, ".local/share/echo"));
    const rejected = linked.run(1);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("symbolic link");
  });

  it("uses an absolute invitation only after a signed-out status check", () => {
    const subject = fixture();
    const invitation = join(subject.root, "person-invitation.json");
    writeFileSync(invitation, "{}", { mode: 0o600 });
    const result = subject.run(1, invitation);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"login"');
    expect(result.stdout).not.toContain("--open-browser");
    const reinstalled = subject.run(1);
    expect(reinstalled.status, reinstalled.stderr).toBe(0);
  });

  it("preserves an existing signed-in session instead of applying an invitation", () => {
    const subject = fixture();
    const invitation = join(subject.root, "person-invitation.json");
    writeFileSync(invitation, "{}", { mode: 0o600 });
    const result = subject.run(1, invitation, { SIGNED_IN: "yes" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("session already exists");
    expect(result.stdout).not.toContain('"login"');
  });

  it("accepts an absolute current-user-owned XDG data location outside HOME", () => {
    const subject = fixture();
    const data = join(subject.root, "external-data");
    mkdirSync(data, { mode: 0o700 });
    const result = subject.run(1, "--install-only", { XDG_DATA_HOME: data });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(data, "echo/person/bin/echo-brain"))).toBe(true);
  });

  it("refuses non-Linux and musl hosts before checking the kit", () => {
    const subject = fixture();
    const wrongOs = subject.run(1, "--install-only", { WRONG_OS: "yes" });
    expect(wrongOs.status).toBe(1);
    expect(wrongOs.stderr).toContain("Linux x86_64 only");
    const musl = subject.run(1, "--install-only", { MUSL: "yes" });
    expect(musl.status).toBe(1);
    expect(musl.stderr).toContain("glibc Linux only");
  });
});
