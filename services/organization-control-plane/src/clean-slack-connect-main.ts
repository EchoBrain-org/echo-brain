import { runCleanSlackConnectCli } from "./composition/clean-slack-connect-cli.js";

void runCleanSlackConnectCli(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "clean Slack connect failed"}\n`,
  );
  process.exitCode = 1;
});
