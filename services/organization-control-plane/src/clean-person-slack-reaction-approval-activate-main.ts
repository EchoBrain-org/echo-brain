import { runCleanPersonSlackReactionApprovalActivateCli } from "./composition/clean-person-slack-reaction-approval-activate-cli.js";

void runCleanPersonSlackReactionApprovalActivateCli(process.argv.slice(2)).catch(
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "clean Slack reaction approval activation failed"}\n`,
    );
    process.exitCode = 1;
  },
);
