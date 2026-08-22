import { runCleanPersonCli } from "./composition/clean-person-cli.js";

try {
  process.exitCode = await runCleanPersonCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "clean Person command failed"}\n`,
  );
  process.exitCode = 1;
}
