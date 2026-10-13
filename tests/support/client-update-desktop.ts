import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJsonForTest } from "./test-canonical-json.js";

export type DesktopTarget = "macos-app" | "linux-deb";
type Release = { release_id: string; source_sha: string; person_client: { version: string; artifact_sha256: string } };
export interface DesktopFixtureInputs {
  root: string;
  clientArchive: string;
  release: Release;
  releaseSha256: string;
  /** The feed's cli-kit bootstrap config; the identity carries it as electron. */
  config: Record<string, unknown>;
  /** The committed Linux root helper at release.source_sha. */
  helper: Buffer;
}
export interface DesktopArtifact {
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

/** The identity product/echo-desktop/scripts/package.mjs writes, independently restated. */
export function desktopIdentity(target: DesktopTarget, { release, releaseSha256, config }: Omit<DesktopFixtureInputs, "root" | "clientArchive" | "helper">) {
  return {
    schema_version: 1, kind: "echo-desktop-identity-v1", release_id: release.release_id,
    release_record_sha256: releaseSha256, source_sha: release.source_sha, product_version: release.person_client.version,
    person_client_artifact_sha256: release.person_client.artifact_sha256, ...PLATFORM[target],
    installation: "electron", update_bootstrap: { ...config, installation: "electron" },
  };
}
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
export const debControl = (fields: Record<string, string> = {}) => Object.entries({
  Package: "echo-desktop", Version: "0.1.0", License: "UNLICENSED", Architecture: "amd64",
  Maintainer: "EchoBrain", "Installed-Size": "1", Depends: "python3, openssl", Section: "default", Priority: "optional",
  Description: "ECHO\n desktop", ...fields,
}).map(([name, value]) => `${name}: ${value}\n`).join("");

/** An ar archive with GNU ar's slash-terminated member names, as fpm on Linux writes. */
export function writeGnuAr(path: string, members: Array<[string, Buffer]>) {
  const parts: Buffer[] = [Buffer.from("!<arch>\n")];
  for (const [name, bytes] of members) {
    parts.push(Buffer.from(`${`${name}/`.padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(bytes.length).padEnd(10)}\`\n`), bytes);
    if (bytes.length % 2) parts.push(Buffer.from("\n"));
  }
  writeFileSync(path, Buffer.concat(parts));
}

/**
 * A synthetic ECHO.app ZIP and .deb laid out as electron-builder packages
 * them: the identity and the release client tarball extracted beside it, plus
 * the root helper on Linux. Each tree stays unpacked so a test can edit it.
 */
export function desktopArtifacts(inputs: DesktopFixtureInputs, { controlCompression = "xz", gnuAr = false }: { controlCompression?: "xz" | "gz"; gnuAr?: boolean } = {}): Record<DesktopTarget, DesktopArtifact> {
  const identityBytes = (target: DesktopTarget) => `${canonicalJsonForTest(desktopIdentity(target, inputs))}\n`;
  const mac = join(inputs.root, "macos-app");
  const resources = join(mac, "ECHO.app/Contents/Resources");
  mkdirSync(join(resources, "person-client"), { recursive: true });
  writeFileSync(join(mac, "ECHO.app/Contents/Info.plist"), infoPlist("org.echobrain.echo-desktop"));
  writeFileSync(join(resources, "echo-desktop-identity.v1.json"), identityBytes("macos-app"));
  execFileSync("tar", ["-xzf", inputs.clientArchive, "-C", join(resources, "person-client")], { env });
  const zip = join(inputs.root, "ECHO-mac.zip");
  const zipApp = () => { rmSync(zip, { force: true }); execFileSync("zip", ["-qry", zip, "ECHO.app"], { cwd: mac }); };

  const linux = join(inputs.root, "linux-deb");
  const opt = join(linux, "data/opt/ECHO/resources");
  mkdirSync(join(opt, "person-client"), { recursive: true });
  mkdirSync(join(linux, "control"));
  writeFileSync(join(opt, "echo-desktop-identity.v1.json"), identityBytes("linux-deb"));
  writeFileSync(join(opt, "echo-desktop-update-helper"), inputs.helper, { mode: 0o755 });
  execFileSync("tar", ["-xzf", inputs.clientArchive, "-C", join(opt, "person-client")], { env });
  writeFileSync(join(linux, "control/control"), debControl());
  const deb = join(inputs.root, "echo-desktop.deb");
  const packDeb = () => {
    const build = join(linux, "build");
    rmSync(build, { recursive: true, force: true }); rmSync(deb, { force: true });
    mkdirSync(build);
    writeFileSync(join(build, "debian-binary"), "2.0\n");
    const control = `control.tar.${controlCompression}`;
    execFileSync("tar", [controlCompression === "xz" ? "-cJf" : "-czf", join(build, control), "-C", join(linux, "control"), "./control"], { env });
    execFileSync("tar", ["-cJf", join(build, "data.tar.xz"), "-C", join(linux, "data"), "./opt"], { env });
    const members = ["debian-binary", control, "data.tar.xz"];
    if (gnuAr) writeGnuAr(deb, members.map(name => [name, readFileSync(join(build, name))]));
    else execFileSync("ar", ["rcS", deb, ...members], { cwd: build });
  };
  zipApp(); packDeb();
  return {
    "macos-app": { path: zip, identity: join(resources, "echo-desktop-identity.v1.json"), client: join(resources, "person-client"), rebuild: zipApp },
    "linux-deb": { path: deb, identity: join(opt, "echo-desktop-identity.v1.json"), client: join(opt, "person-client"), rebuild: packDeb },
  };
}
