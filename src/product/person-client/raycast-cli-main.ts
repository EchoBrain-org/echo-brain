#!/usr/bin/env node

import { isAbsolute } from "node:path";
import process from "node:process";
import { runRaycastCliWrapper } from "./raycast-cli-wrapper.js";

const argv = process.argv.slice(2);
const [cliPath, question] = argv;

if (argv.length !== 2 || cliPath === undefined || !isAbsolute(cliPath) || question === undefined) {
  process.stderr.write("usage: raycast-cli-main <absolute-cli-path> <question>\n");
  process.exitCode = 2;
} else {
  const result = runRaycastCliWrapper({ cli_path: cliPath, question });
  (result.ok ? process.stdout : process.stderr).write(`${result.fullOutput}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
