import { runCleanResetCli } from "./composition/clean-reset-cli.js";

try {
  process.exitCode = runCleanResetCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "clean reset failed"}\n`,
  );
  process.exitCode = 1;
}
