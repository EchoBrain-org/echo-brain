import { runSlackConnectionSetupCli } from "./composition/slack-connection-setup-cli.js";

void runSlackConnectionSetupCli(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Slack connection setup failed"}\n`,
  );
  process.exitCode = 1;
});
