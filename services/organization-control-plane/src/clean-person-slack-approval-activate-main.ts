import { runCleanPersonSlackApprovalActivateCli } from "./composition/clean-person-slack-approval-activate-cli.js";

void runCleanPersonSlackApprovalActivateCli(process.argv.slice(2)).catch(
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "clean Slack approval activation failed"}\n`,
    );
    process.exitCode = 1;
  },
);
