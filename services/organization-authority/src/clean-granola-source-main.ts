import { runCleanGranolaSourceCli } from "./composition/clean-granola-source-cli.js";

try {
  process.exitCode = await runCleanGranolaSourceCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "clean Granola source admission failed"}\n`,
  );
  process.exitCode = 1;
}
