import { runCleanFounderCli } from "./composition/clean-founder-cli.js";

process.exitCode = await runCleanFounderCli(process.argv.slice(2));
