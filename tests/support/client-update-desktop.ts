import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { canonicalJsonForTest } from "./test-canonical-json.js";

export type DesktopTarget = "macos-app" | "linux-deb";
type Release = { release_id: string; source_sha: string; person_client: { version: string; artifact_sha256: string } };
/** Bytes of a repository path at the release commit. */
type Committed = (path: string) => Buffer;
interface DesktopFixtureInputs {
  root: string;
  clientArchive: string;
  /** The whole release record; the CLI kits carry its canonical bytes. */
  release: Release;
  releaseSha256: string;
  /** The feed's cli-kit bootstrap config; the identity carries it as electron. */
  config: Record<string, unknown>;
  committed: Committed;
}
interface DesktopArtifact {
  path: string;
  /** echo-desktop-identity.v1.json inside the unpacked tree. */
  identity: string;
  /** The embedded person-client directory inside the unpacked tree. */
  client: string;
  /** Repackages the unpacked tree after a test edits it. */
  rebuild: () => void;
}

const PLATFORM = {
  "macos-app": { platform: "darwin", architecture: "arm64", libc: null },
  "linux-deb": { platform: "linux", architecture: "x64", libc: "glibc" },
} as const;
// macOS tar would otherwise add AppleDouble members for extended attributes.
const env = { ...process.env, COPYFILE_DISABLE: "1" };
const LINUX = "product/echo-desktop/linux/";

export const infoPlist = (bundleId: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleExecutable</key>
    <string>ECHO</string>
    <key>CFBundleIdentifier</key>
    <string>${bundleId}</string>
  </dict>
</plist>
`;

export interface TarMember {
  name: string;
  type?: "file" | "directory" | "symlink" | "hard link" | "device" | "fifo" | "pax";
  mode?: number;
  bytes?: Buffer | string;
  link?: string;
  uid?: number;
  uname?: string;
}
const FLAGS = { file: "0", directory: "5", symlink: "2", "hard link": "1", device: "3", fifo: "6", pax: "x" } as const;

/**
 * A tar as fpm writes one with GNU tar: GNU headers, root-owned members, and
 * names or link targets over 100 bytes in 'L' and 'K' records.
 */
export function gnuTar(members: TarMember[]): Buffer {
  const blocks: Buffer[] = [];
  const pad = (bytes: Buffer) => Buffer.concat([bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
  const header = (name: string, flag: string, size: number, member: Partial<TarMember> = {}) => {
    const block = Buffer.alloc(512);
    const number = (value: number, offset: number, width: number) => block.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, "latin1");
    block.write(name, 0, 100, "latin1");
    number(member.mode ?? 0o644, 100, 8);
    number(member.uid ?? 0, 108, 8);
    number(0, 116, 8);
    number(size, 124, 12);
    number(0, 136, 12);
    block.write(flag, 156, "latin1");
    block.write(member.link ?? "", 157, 100, "latin1");
    block.write("ustar  \0", 257, "latin1");
    block.write(member.uname ?? "", 265, 32, "latin1");
    block.fill(0x20, 148, 156);
    block.write(`${block.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    return block;
  };
  for (const member of members) {
    const type = member.type ?? "file";
    const bytes = Buffer.from(member.bytes ?? "");
    const link = member.link ?? "";
    if (member.name.length > 100) blocks.push(header("././@LongLink", "L", member.name.length + 1), pad(Buffer.from(`${member.name}\0`, "latin1")));
    if (link.length > 100) blocks.push(header("././@LongLink", "K", link.length + 1), pad(Buffer.from(`${link}\0`, "latin1")));
    const sized = type === "file" || type === "pax";
    blocks.push(header(member.name.slice(0, 100), FLAGS[type], sized ? bytes.length : 0,
      { ...member, link: link.slice(0, 100), mode: member.mode ?? (type === "directory" ? 0o755 : type === "symlink" ? 0o777 : 0o644) }));
    if (sized) blocks.push(pad(bytes));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** A folder as GNU tar archives `-C folder .`: parents first, files 0644 or 0755. */
function treeMembers(root: string): TarMember[] {
  const members: TarMember[] = [{ name: "./", type: "directory" }];
  const walk = (relative: string) => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const state = lstatSync(join(root, path));
      if (state.isDirectory()) { members.push({ name: `./${path}/`, type: "directory" }); walk(path); }
      else if (state.isSymbolicLink()) members.push({ name: `./${path}`, type: "symlink", link: readlinkSync(join(root, path)) });
      else members.push({ name: `./${path}`, bytes: readFileSync(join(root, path)), mode: state.mode & 0o100 ? 0o755 : 0o644 });
    }
  };
  walk("");
  return members;
}

/** An ar archive with GNU ar's slash-terminated member names, as fpm on Linux writes, or BSD ar's plain ones. */
function arArchive(members: Array<[string, Buffer]>, gnu: boolean) {
  const parts: Buffer[] = [Buffer.from("!<arch>\n")];
  for (const [name, bytes] of members) {
    parts.push(Buffer.from(`${`${name}${gnu ? "/" : ""}`.padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(bytes.length).padEnd(10)}\`\n`), bytes);
    if (bytes.length % 2) parts.push(Buffer.from("\n"));
  }
  return Buffer.concat(parts);
}

export interface LinuxDeb {
  path: string;
  /** The unpacked control and data tarballs, which a test may edit before rebuild. */
  control: string;
  data: string;
  /** Members appended after each tree, for what a test folder cannot hold. */
  extraControl: TarMember[];
  extraData: TarMember[];
  /** Bytes appended after the data tarball's end. */
  dataTail: Buffer;
  /** Rewrites the control file: fpm's fields, then these, where undefined removes one. */
  writeControl: (fields?: Record<string, string | undefined>) => void;
  rebuild: () => void;
}

/**
 * The .deb electron-builder 26 and fpm build for ECHO, at a smaller scale: the
 * app under /opt/ECHO with the committed root helper and AppArmor profile, the
 * desktop entry, icons and changelog, and the committed maintainer scripts.
 */
export function linuxDeb(directory: string, committed: Committed, { controlCompression = "xz", gnuAr = true }: { controlCompression?: "xz" | "gz"; gnuAr?: boolean } = {}): LinuxDeb {
  const control = join(directory, "control");
  const data = join(directory, "data");
  const write = (path: string, bytes: Buffer | string, mode = 0o644) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { mode });
  };
  write(join(data, "opt/ECHO/echo-desktop"), "synthetic electron", 0o755);
  write(join(data, "opt/ECHO/chrome-sandbox"), "synthetic sandbox", 0o755);
  write(join(data, "opt/ECHO/resources/app.asar"), "synthetic app");
  write(join(data, "opt/ECHO/resources/echo-desktop-update-helper"), committed(`${LINUX}echo-desktop-update-helper`), 0o755);
  write(join(data, "opt/ECHO/resources/apparmor-profile"), committed(`${LINUX}apparmor-profile`));
  // A path over 100 bytes, and links inside the app, one through a long target.
  const deep = `opt/ECHO/resources/app.asar.unpacked/${"nested-folder/".repeat(8)}module.node`;
  write(join(data, deep), "synthetic module", 0o755);
  symlinkSync("chrome-sandbox", join(data, "opt/ECHO/chrome-sandbox-link"));
  symlinkSync(`/${deep}`, join(data, "opt/ECHO/resources/module-link"));
  write(join(data, "usr/share/applications/org.echobrain.echo-desktop.desktop"), "[Desktop Entry]\nName=ECHO\nExec=/opt/ECHO/echo-desktop %U\nType=Application\n");
  for (const size of ["16x16", "256x256"]) write(join(data, `usr/share/icons/hicolor/${size}/apps/echo-desktop.png`), `synthetic ${size} icon`);
  write(join(data, "usr/share/doc/echo-desktop/changelog.gz"), gzipSync("echo-desktop (0.1.0) whatever; urgency=medium\n"));

  const relationships = JSON.parse(committed(`${LINUX}deb-relationships.json`).toString("utf8")) as { depends: string[]; recommends: string[] };
  const writeControl = (fields: Record<string, string | undefined> = {}) => write(join(control, "control"), Object.entries({
    Package: "echo-desktop", Version: "0.1.0", License: "unknown", Vendor: "EchoBrain", Architecture: "amd64",
    Maintainer: "EchoBrain", "Installed-Size": "1", Depends: relationships.depends.join(", "),
    Recommends: relationships.recommends.join(", "), Section: "default", Priority: "optional",
    Homepage: "https://github.com/EchoBrain-org/echo-brain", Description: "\n  ECHO desktop app (Electron) for macOS and Linux", ...fields,
  }).filter(([, value]) => value !== undefined).map(([name, value]) => `${name}: ${value}\n`).join(""));
  writeControl();
  write(join(control, "md5sums"), "0123456789abcdef0123456789abcdef  opt/ECHO/echo-desktop\n");
  write(join(control, "postinst"), committed(`${LINUX}postinst`), 0o755);
  write(join(control, "postrm"), committed(`${LINUX}postrm`), 0o755);

  const deb: LinuxDeb = {
    path: join(directory, "echo-desktop.deb"), control, data, extraControl: [], extraData: [], dataTail: Buffer.alloc(0), writeControl,
    rebuild: () => {
      const compress = (bytes: Buffer, format: "xz" | "gz") => (format === "gz" ? gzipSync(bytes) : execFileSync("xz", ["-c"], { input: bytes, maxBuffer: 64 * 1024 * 1024 }));
      writeFileSync(deb.path, arArchive([
        ["debian-binary", Buffer.from("2.0\n")],
        [`control.tar.${controlCompression}`, compress(gnuTar([...treeMembers(control), ...deb.extraControl]), controlCompression)],
        ["data.tar.xz", compress(Buffer.concat([gnuTar([...treeMembers(data), ...deb.extraData]), deb.dataTail]), "xz")],
      ], gnuAr));
    },
  };
  deb.rebuild();
  return deb;
}

/**
 * A synthetic ECHO.app ZIP and .deb laid out as electron-builder packages them,
 * each tree left unpacked so a test can edit it and rebuild.
 */
export function desktopArtifacts(inputs: DesktopFixtureInputs, debOptions: Parameters<typeof linuxDeb>[2] = {}): Record<DesktopTarget, DesktopArtifact> {
  const { release, releaseSha256, config } = inputs;
  // The identity product/echo-desktop/scripts/package.mjs writes, independently restated.
  const identityBytes = (target: DesktopTarget) => `${canonicalJsonForTest({
    schema_version: 1, kind: "echo-desktop-identity-v1", release_id: release.release_id,
    release_record_sha256: releaseSha256, source_sha: release.source_sha, product_version: release.person_client.version,
    person_client_artifact_sha256: release.person_client.artifact_sha256, ...PLATFORM[target],
    installation: "electron", update_bootstrap: { ...config, installation: "electron" },
  })}\n`;
  const mac = join(inputs.root, "macos-app");
  const resources = join(mac, "ECHO.app/Contents/Resources");
  mkdirSync(join(resources, "person-client"), { recursive: true });
  writeFileSync(join(mac, "ECHO.app/Contents/Info.plist"), infoPlist("org.echobrain.echo-desktop"));
  writeFileSync(join(resources, "echo-desktop-identity.v1.json"), identityBytes("macos-app"));
  execFileSync("tar", ["-xzf", inputs.clientArchive, "-C", join(resources, "person-client")], { env });
  const zip = join(inputs.root, "ECHO-mac.zip");
  const zipApp = () => { rmSync(zip, { force: true }); execFileSync("zip", ["-qry", zip, "ECHO.app"], { cwd: mac }); };
  zipApp();

  const deb = linuxDeb(join(inputs.root, "linux-deb"), inputs.committed, debOptions);
  const opt = join(deb.data, "opt/ECHO/resources");
  mkdirSync(join(opt, "person-client"));
  writeFileSync(join(opt, "echo-desktop-identity.v1.json"), identityBytes("linux-deb"));
  execFileSync("tar", ["-xzf", inputs.clientArchive, "-C", join(opt, "person-client")], { env });
  deb.rebuild();
  return {
    "macos-app": { path: zip, identity: join(resources, "echo-desktop-identity.v1.json"), client: join(resources, "person-client"), rebuild: zipApp },
    "linux-deb": { path: deb.path, identity: join(opt, "echo-desktop-identity.v1.json"), client: join(opt, "person-client"), rebuild: deb.rebuild },
  };
}

const CLI_KITS = {
  linux: { platform: "linux", architecture: "x64", schema_version: 2, kind: "echo-person-onboarding-kit-v2", start: "deploy/release/start-person-onboarding-kit-linux.sh" },
  macos: { platform: "darwin", architecture: "arm64", schema_version: 3, kind: "echo-person-cli-kit-v1", start: "deploy/release/start-person-cli-kit-macos.sh" },
} as const;
export type CliKitTarget = keyof typeof CLI_KITS;
interface CliKit {
  /** The unpacked kit folder. */
  directory: string;
  zip: string;
  /** Rezips the folder after a test edits it. */
  rebuild: () => void;
}

/**
 * The Linux and macOS command-line kit ZIPs for the release, with the files
 * deploy/release/create-person-onboarding-kit.mjs puts in them; only the Linux
 * kit carries the update bootstrap. Each folder stays unpacked for a test to edit.
 */
export function cliKits(inputs: DesktopFixtureInputs): Record<CliKitTarget, CliKit> {
  const { root, release, config, committed } = inputs;
  const kits = {} as Record<CliKitTarget, CliKit>;
  for (const name of ["linux", "macos"] as const) {
    const target = CLI_KITS[name];
    const kit = join(root, name, "echo-person-onboarding-kit");
    mkdirSync(kit, { recursive: true, mode: 0o700 });
    const write = (file: string, bytes: Buffer | string) => writeFileSync(join(kit, file), bytes, { mode: 0o600 });
    const digest = (file: string) => createHash("sha256").update(readFileSync(join(kit, file))).digest("hex");
    write("Start-ECHO.sh", committed(target.start));
    write("clean-v1-release.mjs", committed("tools/clean-v1-release.mjs"));
    write("verify-person-onboarding-kit.mjs", committed("deploy/release/verify-person-onboarding-kit.mjs"));
    write("release.json", `${canonicalJsonForTest(release)}\n`);
    write("person-client.tgz", readFileSync(inputs.clientArchive));
    write("build-identity.v1.json", `${canonicalJsonForTest({
      schema_version: 1, kind: "echo-person-onboarding-kit-identity-v1", product_version: release.person_client.version,
      source_sha: release.source_sha, platform: target.platform, architecture: target.architecture, release_id: release.release_id,
    })}\n`);
    write("node", `synthetic ${name} runtime`);
    write("kit-manifest.v1.json", `${canonicalJsonForTest({
      schema_version: target.schema_version, kind: target.kind, release_id: release.release_id, source_sha: release.source_sha,
      release_record_sha256: digest("release.json"), person_client_artifact_sha256: release.person_client.artifact_sha256,
      build_identity_sha256: digest("build-identity.v1.json"),
      runtime: { platform: target.platform, architecture: target.architecture, version: "v22.22.1", node_sha256: digest("node") },
      ...(name === "linux" ? { update_bootstrap: config } : {}),
    })}\n`);
    const zip = join(root, `${name}-kit.zip`);
    const rebuild = () => { rmSync(zip, { force: true }); execFileSync("zip", ["-qr", zip, "echo-person-onboarding-kit"], { cwd: join(root, name) }); };
    rebuild();
    kits[name] = { directory: kit, zip, rebuild };
  }
  return kits;
}
