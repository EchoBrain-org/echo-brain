import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Results carry released text: they live only in a private directory outside the repository. */
const REPOSITORY = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

function insideRepository(path) {
  const inside = relative(realpathSync(REPOSITORY), path);
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

export function privateDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("--out must be an absolute private directory path");
  // Refuse before creating anything, then again after resolving links.
  if (insideRepository(resolve(path))) throw new Error("--out must be outside the repository");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const real = realpathSync(path);
  if (insideRepository(real)) throw new Error("--out must be outside the repository");
  chmodSync(real, 0o700);
  if ((statSync(real).mode & 0o077) !== 0) throw new Error("--out must not be readable by group or other users");
  return real;
}

export function writePrivateJson(directory, name, value) {
  const parts = name.split("/");
  const folder = join(directory, ...parts.slice(0, -1));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, parts.at(-1));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function writePrivateText(directory, name, text) {
  const path = join(directory, name);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Every saved run under `runs/`, in a stable order. */
export function savedRuns(directory) {
  const root = join(directory, "runs");
  return readdirSync(root, { recursive: true }).filter(name => String(name).endsWith(".json")).sort().map(name => readJson(join(root, String(name))));
}
