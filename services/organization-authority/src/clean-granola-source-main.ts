import { runGranolaMeetingSourceAdmissionCli } from "./composition/providers/granola/granola-meeting-source-admission-cli.js";

try {
  process.exitCode = await runGranolaMeetingSourceAdmissionCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Granola meeting-source admission failed"}\n`,
  );
  process.exitCode = 1;
}
