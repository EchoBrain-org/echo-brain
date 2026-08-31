import { runOrganizationAuthorityPersonAdministrationCli } from "./composition/organization-authority-person-administration-cli.js";

try {
  process.exitCode = await runOrganizationAuthorityPersonAdministrationCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Person administration command failed"}\n`,
  );
  process.exitCode = 1;
}
