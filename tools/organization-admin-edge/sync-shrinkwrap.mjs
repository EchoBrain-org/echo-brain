#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runtimeShrinkwrap } from "../release/runtime-shrinkwrap.mjs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export const ADMIN_EDGE_BUNDLED_WORKSPACE_PACKAGES = Object.freeze([
  "@echo-brain/federation-protocol",
  "@echo-brain/organization-protocol",
  "@echo-brain/organization-api",
]);

export function organizationAdminEdgeShrinkwrap(template, rootLock) {
  return runtimeShrinkwrap(template, rootLock, {
    bundledWorkspacePackages: ADMIN_EDGE_BUNDLED_WORKSPACE_PACKAGES,
  });
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--check") return { check: true };
  if (argv.length === 2 && argv[0] === "--output" && isAbsolute(argv[1])) {
    return { check: false, output: argv[1] };
  }
  throw new Error("usage: sync-shrinkwrap --check | --output <absolute-path>");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(process.cwd());
  const shrinkwrap = organizationAdminEdgeShrinkwrap(
    readJson(
      resolve(root, "release/organization-admin-edge/package.template.json"),
    ),
    readJson(resolve(root, "npm-shrinkwrap.json")),
  );
  if (args.check) {
    process.stdout.write(
      "administrator edge runtime dependency closure resolves from the root shrinkwrap\n",
    );
    return;
  }
  writeFileSync(args.output, `${JSON.stringify(shrinkwrap, null, 2)}\n`);
  process.stdout.write(
    `wrote administrator edge runtime shrinkwrap to ${args.output}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`admin-edge-sync-shrinkwrap: ${error.message}\n`);
    process.exitCode = 1;
  }
}
