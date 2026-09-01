import { runSyntheticDemoOrganizationAuthorityCliV1 } from "./composition/synthetic-demo-organization-authority-cli.js";

process.exitCode = await runSyntheticDemoOrganizationAuthorityCliV1(process.argv.slice(2));
