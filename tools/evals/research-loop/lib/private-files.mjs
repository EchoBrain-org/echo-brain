import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Results carry released text: they live only in a private directory outside the repository. */
const REPOSITORY = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

const privateRoots = new Map();
const contains = (root, path) => { const part = relative(root, path); return part === "" || (part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(part)); };

/** Resolve existing ancestors before creating a missing tail; a parent symlink cannot hide a checkout. */
function realDestination(path) {
  const tail = [];
  let ancestor = resolve(path);
  for (;;) {
    try { return resolve(realpathSync(ancestor), ...tail.reverse()); }
    catch (error) {
      if (error?.code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      tail.push(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
}

function repositoryRoots() {
  try {
    const run = args => execFileSync("git", args, { cwd: REPOSITORY, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const common = realDestination(resolve(REPOSITORY, run(["rev-parse", "--git-common-dir"]).trim()));
    const roots = run(["worktree", "list", "--porcelain", "-z"]).split("\0").filter(field => field.startsWith("worktree ")).map(field => realDestination(field.slice(9)));
    // Cover both linked checkouts and the common metadata/main-checkout directory.
    return [...roots, realpathSync(REPOSITORY), common, ...(basename(common) === ".git" ? [dirname(common)] : [])];
  } catch { throw new Error("Cannot establish the private output repository boundary"); }
}

function privateFolder(path, create = false) {
  if (create) { try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") throw error; } }
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Private output directories must not be symlinks or non-directories");
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const actual = fstatSync(fd);
    if (!actual.isDirectory() || actual.dev !== entry.dev || actual.ino !== entry.ino) throw new Error("Private output directory changed");
    fchmodSync(fd, 0o700);
    return actual;
  } finally { closeSync(fd); }
}

function checkedRoot(directory) {
  const root = resolve(directory);
  const expected = privateRoots.get(root);
  if (expected === undefined) throw new Error("Private output must use a validated output directory");
  const actual = privateFolder(root);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || realpathSync(root) !== root) throw new Error("Private output directory changed");
  return root;
}

function relativeParts(name) {
  if (typeof name !== "string" || isAbsolute(name) || name.includes("\\") || name.includes("\0")) throw new Error("Private output filename must be a relative path");
  const parts = name.split("/");
  if (parts.some(part => part === "" || part === "." || part === "..")) throw new Error("Private output filename must not traverse directories");
  return parts;
}

function privateFilePath(directory, name, createFolders) {
  let folder = checkedRoot(directory);
  const parts = relativeParts(name);
  for (const part of parts.slice(0, -1)) { folder = join(folder, part); privateFolder(folder, createFolders); }
  return join(folder, parts.at(-1));
}

export function privateDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("--out must be an absolute private directory path");
  const real = realDestination(path);
  if (repositoryRoots().some(root => contains(root, real))) throw new Error("--out must be outside the repository and all associated worktrees");
  mkdirSync(real, { recursive: true, mode: 0o700 });
  const entry = privateFolder(real);
  if (realpathSync(real) !== real) throw new Error("Private output directory changed");
  privateRoots.set(real, { dev: entry.dev, ino: entry.ino });
  return real;
}

function writePrivate(directory, name, value) {
  const path = privateFilePath(directory, name, true);
  // Do not truncate until the descriptor is verified. O_NOFOLLOW refuses a
  // final symlink; O_NONBLOCK also makes a substituted FIFO safe to reject.
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.nlink !== 1) throw new Error("Private output must be a regular file with no other hard links");
    if (privateFilePath(directory, name, false) !== path || realpathSync(path) !== path) throw new Error("Private output path changed");
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    writeFileSync(fd, value);
  } finally { closeSync(fd); }
  return path;
}

export function writePrivateJson(directory, name, value) {
  return writePrivate(directory, name, `${JSON.stringify(value, null, 2)}\n`);
}

export function writePrivateText(directory, name, text) {
  return writePrivate(directory, name, text);
}

function readRegular(path) {
  const full = resolve(path);
  const root = [...privateRoots.keys()].find(directory => contains(directory, full));
  if (root !== undefined) privateFilePath(root, relative(root, full), false);
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.nlink !== 1) throw new Error("Private input must be a regular file with no other hard links");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export function readJson(path) {
  return JSON.parse(readRegular(path).toString("utf8"));
}

/** Every saved run under `runs/`, in a stable order, with its file name and byte digest. */
export function savedRunFiles(directory) {
  const root = join(checkedRoot(directory), "runs");
  const files = [];
  function walk(folder, prefix = "") {
    privateFolder(folder);
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(prefix, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Private run files must not contain symlinks");
      if (entry.isDirectory()) walk(join(folder, entry.name), file);
      else if (!entry.isFile()) throw new Error("Private run files must be regular files");
      else if (entry.name.endsWith(".json")) files.push(file);
    }
  }
  walk(root);
  return files.sort().map(file => {
    const bytes = readRegular(join(root, file));
    return { file, sha256: createHash("sha256").update(bytes).digest("hex"), run: JSON.parse(bytes.toString("utf8")) };
  });
}
