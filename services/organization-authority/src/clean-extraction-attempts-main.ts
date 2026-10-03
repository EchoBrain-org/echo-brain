import { runOrganizationAuthorityExtractionAttemptCli } from "./composition/organization-authority-extraction-attempt-cli.js";

try {
  process.exitCode = runOrganizationAuthorityExtractionAttemptCli(process.argv.slice(2));
} catch {
  // Neither provider errors nor stored content belong in operator diagnostics.
  process.stderr.write('{"kind":"echo-extraction-attempt-recovery-failed-v1","schema_version":1}\n');
  process.exitCode = 1;
}
