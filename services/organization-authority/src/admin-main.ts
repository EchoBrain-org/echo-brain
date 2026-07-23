import { runOrganizationAuthorityAdminCli } from './composition/admin-cli.js';

void runOrganizationAuthorityAdminCli(process.argv.slice(2))
  .then((exitCode) => {
    if (exitCode !== 0) process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'organization admin failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
