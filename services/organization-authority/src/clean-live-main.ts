import { runCleanLiveCli } from "./composition/clean-live-cli.js";

process.exitCode = await runCleanLiveCli(process.argv.slice(2));
