import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

function runGit(args: string[], input?: Buffer): Buffer {
  const result = spawnSync("git", args, {
    encoding: "buffer",
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr?.toString("utf8") ?? result.error?.message ?? "unknown error"}`,
    );
  }
  return result.stdout ?? Buffer.alloc(0);
}

function copyUntrackedFiles(source: string, destination: string): void {
  const paths = runGit([
    "-C",
    source,
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ])
    .toString("utf8")
    .split("\0");
  for (const path of paths) {
    if (path === "") continue;
    const from = join(source, path);
    if (!lstatSync(from).isFile()) continue;
    const to = join(destination, path);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { force: true });
  }
}

function applyWorkingTreeDiff(source: string, destination: string): void {
  const diff = runGit([
    "-C",
    source,
    "diff",
    "--binary",
    "--no-ext-diff",
    "HEAD",
    "--",
    ".",
  ]);
  if (diff.length === 0) return;
  runGit(["-C", destination, "apply", "--whitespace=nowarn", "-"], diff);
}

function linkNodeModules(source: string, destination: string): void {
  symlinkSync(join(source, "node_modules"), join(destination, "node_modules"), "dir");
}

// Captures the caller's current worktree exactly once. The result is a valid
// Git checkout with its dirty tracked changes and regular untracked files.
export function createCoherentWorktreeSnapshot(
  source: string,
  root: string,
): string {
  const snapshot = join(root, "repo");
  runGit(["clone", "--quiet", source, snapshot]);
  applyWorkingTreeDiff(source, snapshot);
  copyUntrackedFiles(source, snapshot);
  linkNodeModules(source, snapshot);
  return snapshot;
}

// Creates an independently indexed mutable Git worktree of a coherent snapshot.
// The object database stays shared; the checkout and index stay local.
export function copyCoherentWorktreeSnapshot(
  snapshot: string,
  root: string,
): string {
  const repository = join(root, "repo");
  runGit(["-C", snapshot, "worktree", "add", "--detach", repository, "HEAD"]);
  applyWorkingTreeDiff(snapshot, repository);
  copyUntrackedFiles(snapshot, repository);
  linkNodeModules(snapshot, repository);
  return repository;
}
