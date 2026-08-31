import { runOrganizationAuthorityServiceCli } from "./composition/organization-authority-service-cli.js";

process.exitCode = await runOrganizationAuthorityServiceCli(process.argv.slice(2));
