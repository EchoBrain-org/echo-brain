// Clean-checkout and plain-path checks shared by the Authority bundle
// builders. Each builder binds these to its own `fail(message)`, so every
// refusal keeps that tool's error prefix and wording.
import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";

const SOURCE_SHA = /^[0-9a-f]{40}$/;

export function sourceCheckout(fail) {
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

  /** The source root's HEAD, refused unless the checkout has no tracked or untracked changes. */
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

  return Object.freeze({ run, regularDirectory, regularFile, checkedCommit });
}
