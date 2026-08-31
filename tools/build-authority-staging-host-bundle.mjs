#!/usr/bin/env node

/**
 * Build the small, reviewable host-bootstrap artifact used by a disposable
 * Authority staging host. It intentionally packages source code only: no
 * release record, host-bootstrap configuration, environment file, state, or
 * secret value belongs in this archive.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const ARCHIVE_SUFFIX = ".tar.gz";
const BOOTSTRAP = "deploy/organization-authority/bootstrap-ubuntu-arm64.sh";
const UNIT = "deploy/organization-authority/cloudflared-echo-authority.service";
const TOKEN_INSTALLER =
  "deploy/organization-authority/install-cloudflare-tunnel-token.sh";
const ONBOARD = "deploy/organization-authority/onboard-clean-v1.sh";
const UPDATER = "deploy/organization-authority/update-clean-v1.sh";
const RESTORER = "deploy/organization-authority/restore-clean-v1-host.sh";
const RELEASE_VALIDATOR = "deploy/release/clean-v1-release.py";
const RUNTIME_PROFILE_VALIDATOR =
  "deploy/release/clean-v1-runtime-profile.py";

// This is deliberately an allowlist, rather than a directory archive. The
// artifact is allowed to carry host and deployment control code only. The
// accepted release record, materialized profile, environment, state, and all
// private credential files remain exclusively on the retained data volume.
const REQUIRED_FILES = Object.freeze([
  BOOTSTRAP,
  UNIT,
  TOKEN_INSTALLER,
  ONBOARD,
  RESTORER,
  UPDATER,
  RELEASE_VALIDATOR,
  RUNTIME_PROFILE_VALIDATOR,
]);

function fail(message) {
  throw new Error(`authority staging host bundle: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function run(file, args, options = {}) {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
  } catch {
    fail(`${file} did not complete successfully`);
  }
}

function regularDirectory(path, label) {
  let state;
  try {
    state = lstatSync(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (state.isSymbolicLink() || !state.isDirectory())
    fail(`${label} must be a directory, not a symlink`);
  return state;
}

function regularFile(path, label) {
  let state;
  try {
    state = lstatSync(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (state.isSymbolicLink() || !state.isFile())
    fail(`${label} must be a regular file, not a symlink`);
  return state;
}

function privateDirectory(path, label) {
  const state = regularDirectory(path, label);
  if ((state.mode & 0o077) !== 0)
    fail(`${label} must not be accessible to group or other users`);
}

function parseArguments(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== "--source-root" ||
    argv[2] !== "--output"
  ) {
    fail(
      "usage: build-authority-staging-host-bundle.mjs --source-root <unchanged-repository-root> --output <new-private-bundle.tar.gz>",
    );
  }
  const sourceRoot = resolve(argv[1]);
  const output = resolve(argv[3]);
  if (!basename(output).endsWith(ARCHIVE_SUFFIX))
    fail("output must be a new .tar.gz path");
  if (existsSync(output) || existsSync(`${output}.manifest.json`))
    fail("output and its manifest must be new paths");
  if (output === sourceRoot || output.startsWith(`${sourceRoot}${sep}`))
    fail("output must be outside the source root");
  privateDirectory(dirname(output), "output directory");
  return Object.freeze({ sourceRoot, output });
}

function checkedCommit(sourceRoot) {
  regularDirectory(sourceRoot, "source root");
  const status = run("git", [
    "-C",
    sourceRoot,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "")
    fail("source root must have no tracked or untracked changes");
  const commit = run("git", ["-C", sourceRoot, "rev-parse", "HEAD"]).trim();
  if (!SOURCE_SHA.test(commit))
    fail("source root must resolve a full Git commit");
  return commit;
}

function bundleFiles(sourceRoot) {
  const files = REQUIRED_FILES.map((path) => {
    regularFile(join(sourceRoot, path), path);
    const mode = path.endsWith(".sh") ? 0o755 : 0o644;
    const content = readFileSync(join(sourceRoot, path));
    return Object.freeze({
      path,
      content,
      mode,
      sha256: sha256(content),
    });
  });
  return Object.freeze(files);
}

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) fail(`tar header field is too long: ${value}`);
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) fail("tar header numeric field is too large");
  writeString(buffer, offset, length, `${encoded}\0`);
}

function tarHeader(name, size, mode) {
  const header = Buffer.alloc(512, 0);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "root");
  writeString(header, 297, 32, "root");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeOctal(header, 148, 8, checksum);
  return header;
}

function deterministicArchive(files) {
  const chunks = [];
  for (const file of files) {
    const name = basename(file.path);
    chunks.push(tarHeader(name, file.content.length, file.mode), file.content);
    const padding = (512 - (file.content.length % 512)) % 512;
    if (padding !== 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

function inspectExtractedBundle(archive, files) {
  const extractRoot = mkdtempSync(
    join(tmpdir(), "echo-authority-staging-host-"),
  );
  try {
    run("tar", ["-xzf", archive, "-C", extractRoot]);
    const expected = files.map((file) => basename(file.path)).sort();
    const actual = readdirSync(extractRoot).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      fail("extracted archive contains an unexpected path");
    for (const file of files) {
      const extracted = join(extractRoot, basename(file.path));
      regularFile(extracted, `extracted ${file.path}`);
      if (sha256(readFileSync(extracted)) !== file.sha256)
        fail(`extracted ${file.path} checksum mismatch`);
    }
    run("bash", ["-n", join(extractRoot, basename(BOOTSTRAP))]);
    run("bash", ["-n", join(extractRoot, basename(TOKEN_INSTALLER))]);
    run("bash", ["-n", join(extractRoot, basename(RESTORER))]);
    const unit = readFileSync(join(extractRoot, basename(UNIT)), "utf8");
    for (const section of ["[Unit]", "[Service]", "[Install]"]) {
      if (!unit.includes(section))
        fail("Cloudflare service unit syntax smoke failed");
    }
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

function makeBundle({ sourceRoot, output }) {
  const sourceCommit = checkedCommit(sourceRoot);
  const files = bundleFiles(sourceRoot);
  const archive = deterministicArchive(files);
  writeFileSync(output, archive, { mode: 0o600, flag: "wx" });
  chmodSync(output, 0o600);
  try {
    inspectExtractedBundle(output, files);
    const manifest = Object.freeze({
      schema_version: 1,
      kind: "echo-authority-staging-host-bundle-v1",
      source_commit: sourceCommit,
      files: files.map(({ path, sha256: digest, mode }) => ({
        path,
        sha256: digest,
        mode: mode.toString(8).padStart(4, "0"),
      })),
      archive_sha256: sha256(archive),
    });
    writeFileSync(
      `${output}.manifest.json`,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    chmodSync(`${output}.manifest.json`, 0o600);
    return manifest;
  } catch (error) {
    rmSync(output, { force: true });
    throw error;
  }
}

try {
  const manifest = makeBundle(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
