import { runLegacySlackReactionApprovalActivationCli } from "./composition/legacy-slack-reaction-approval-activation-cli.js";

void runLegacySlackReactionApprovalActivationCli(process.argv.slice(2)).catch(
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Slack reaction approval activation failed"}\n`,
    );
    process.exitCode = 1;
  },
);
