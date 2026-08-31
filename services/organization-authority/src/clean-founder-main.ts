import { runOrganizationAuthoritySetupCli } from "./composition/organization-authority-setup-cli.js";

process.exitCode = await runOrganizationAuthoritySetupCli(process.argv.slice(2));
