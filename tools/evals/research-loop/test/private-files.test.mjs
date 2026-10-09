import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { privateDirectory, readJson, savedRunFiles, writePrivateJson, writePrivateText } from "../lib/private-files.mjs";

const checkout = realpathSync(fileURLToPath(new URL("../../../..", import.meta.url)));
const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
const common = resolve(checkout, git("rev-parse", "--git-common-dir"));
const worktrees = git("worktree", "list", "--porcelain", "-z").split("\0").filter(line => line.startsWith("worktree ")).map(line => line.slice(9)).filter(existsSync).map(path => realpathSync(path));
const main = worktrees.find(path => resolve(path, ".git") === common) ?? worktrees[0];
function temporary(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "echo-private-files-security-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function output(t) { const root = temporary(t); return { root, out: privateDirectory(join(root, "out")) }; }

/** A failed regression must not create/chmod anything in a real checkout. */
function refusedBeforeMutation(t, path) {
  const attempts = [];
  const guards = ["mkdirSync", "chmodSync"].map(method => t.mock.method(fs, method, candidate => {
    attempts.push({ method, path: candidate });
    throw new Error("test blocked an unexpected filesystem mutation");
  }));
  syncBuiltinESMExports();
  try {
    assert.throws(() => privateDirectory(path), /outside the repository/u);
    assert.deepEqual(attempts, [], "repository rejection must happen before creating or changing a directory");
    assert.equal(existsSync(path), false);
  } finally {
    for (const guarded of guards) guarded.mock.restore();
    syncBuiltinESMExports();
  }
}

test("rejects the current checkout and every active associated worktree before creating a directory", t => {
  assert.ok(worktrees.includes(checkout));
  assert.ok(main && existsSync(main));
  const suffix = `.diagnostic-output-must-not-exist-${randomUUID()}`;
  for (const path of new Set([checkout, main, ...worktrees])) refusedBeforeMutation(t, join(path, suffix, "nested"));
});

test("resolves a parent symlink into the main checkout before creating missing descendants", t => {
  const root = temporary(t);
  const link = join(root, "main-link");
  symlinkSync(main, link, "dir");
  refusedBeforeMutation(t, join(link, `.diagnostic-output-must-not-exist-${randomUUID()}`, "nested"));
});

test("creates a private external output directory and resumes it without losing saved content", t => {
  const { out } = output(t);
  const text = "Exact model prompt\n\tTHERM-50 → THERM-51\n";
  writePrivateJson(out, "request.json", { question: text });
  writePrivateText(out, "models/0001-user.txt", text);
  assert.equal(privateDirectory(out), out);
  assert.deepEqual(readJson(join(out, "request.json")), { question: text });
  assert.equal(readFileSync(join(out, "models/0001-user.txt"), "utf8"), text);
  assert.equal(statSync(out).mode & 0o077, 0);
  assert.equal(statSync(join(out, "request.json")).mode & 0o177, 0);
  assert.equal(statSync(join(out, "models/0001-user.txt")).mode & 0o177, 0);
});

for (const [label, write, extension] of [
  ["JSON", (out, name) => writePrivateJson(out, name, { payload: "must stay private" }), ".json"],
  ["text", (out, name) => writePrivateText(out, name, "must stay private"), ".txt"],
]) {
  test(`${label} writes reject descendant directory symlinks without touching the target`, t => {
    const { root, out } = output(t);
    const victim = join(root, "victim"); mkdirSync(victim);
    const target = join(victim, `target${extension}`); writeFileSync(target, "existing victim bytes", { mode: 0o600 });
    for (const folder of ["events", "models"]) {
      symlinkSync(victim, join(out, folder), "dir");
      assert.throws(() => write(out, `${folder}/target${extension}`));
      assert.throws(() => write(out, `${folder}/new/deep${extension}`));
      assert.equal(readFileSync(target, "utf8"), "existing victim bytes");
      assert.equal(existsSync(join(victim, "new")), false);
    }
  });

  test(`${label} writes reject final symlinks, nonregular outputs, and hardlinked files`, t => {
    const { root, out } = output(t);
    const victim = join(root, "victim"); writeFileSync(victim, "original target bytes", { mode: 0o600 });
    symlinkSync(victim, join(out, `linked${extension}`));
    linkSync(victim, join(out, `hardlinked${extension}`));
    mkdirSync(join(out, `directory${extension}`));
    for (const name of [`linked${extension}`, `hardlinked${extension}`, `directory${extension}`]) assert.throws(() => write(out, name));
    assert.equal(readFileSync(victim, "utf8"), "original target bytes");
    assert.equal(statSync(join(out, `directory${extension}`)).isDirectory(), true);
  });

  test(`${label} writes reject traversal and absolute names before modifying external files`, t => {
    const { root, out } = output(t);
    const victim = join(root, `victim${extension}`); writeFileSync(victim, "original target bytes", { mode: 0o600 });
    const absent = join(root, `must-not-create${extension}`);
    for (const name of [`../victim${extension}`, `events/../../victim${extension}`, victim, absent, "", ".", "..", `events/../victim${extension}`]) assert.throws(() => write(out, name), undefined, `refuse unsafe relative output name ${name}`);
    assert.equal(readFileSync(victim, "utf8"), "original target bytes");
    assert.equal(existsSync(absent), false);
    assert.equal(existsSync(join(out, "events")), false);
  });
}

test("reads within registered output roots reject descendant and final symlinks", t => {
  const { root, out } = output(t);
  const victim = join(root, "victim"); mkdirSync(victim);
  const target = join(victim, "record.json"); writeFileSync(target, '{"private":"outside root"}', { mode: 0o600 });
  symlinkSync(victim, join(out, "events"), "dir");
  symlinkSync(target, join(out, "result.json"));
  assert.throws(() => readJson(join(out, "events/record.json")));
  assert.throws(() => readJson(join(out, "result.json")));
  assert.equal(readFileSync(target, "utf8"), '{"private":"outside root"}');
});

for (const kind of ["root", "nested", "file"]) {
  test(`savedRunFiles rejects a symlinked ${kind} in runs without reading its target`, t => {
    const { root, out } = output(t);
    const victim = join(root, "victim"); mkdirSync(victim);
    const target = join(victim, "case.json"); writeFileSync(target, '{"private":"outside root"}', { mode: 0o600 });
    if (kind === "root") symlinkSync(victim, join(out, "runs"), "dir");
    else {
      mkdirSync(join(out, "runs"));
      if (kind === "nested") symlinkSync(victim, join(out, "runs/linked"), "dir");
      else symlinkSync(target, join(out, "runs/case.json"));
    }
    assert.throws(() => savedRunFiles(out));
    assert.equal(readFileSync(target, "utf8"), '{"private":"outside root"}');
  });
}

test("savedRunFiles still returns stable digests and run contents for private regular files", t => {
  const { out } = output(t);
  writePrivateJson(out, "runs/b/case.json", { case_id: "second" });
  writePrivateJson(out, "runs/a/case.json", { case_id: "first" });
  const files = savedRunFiles(out);
  assert.deepEqual(files.map(row => row.file), [join("a", "case.json"), join("b", "case.json")]);
  assert.deepEqual(files.map(row => row.run.case_id), ["first", "second"]);
  for (const row of files) assert.match(row.sha256, /^[0-9a-f]{64}$/u);
});
