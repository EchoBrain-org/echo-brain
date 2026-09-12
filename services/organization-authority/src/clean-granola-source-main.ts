import { runGranolaMeetingSourceAdmissionCli } from "./composition/admit-granola-meeting-source-cli-v1.js";

try {
  process.exitCode = await runGranolaMeetingSourceAdmissionCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Granola meeting-source admission failed"}\n`,
  );
  process.exitCode = 1;
}
