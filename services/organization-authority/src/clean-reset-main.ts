import { runOrganizationAuthorityResetCli } from "./composition/organization-authority-reset-cli.js";

try {
  process.exitCode = runOrganizationAuthorityResetCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Organization Authority reset failed"}\n`,
  );
  process.exitCode = 1;
}
