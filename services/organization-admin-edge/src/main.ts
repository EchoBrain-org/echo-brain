import { runOrganizationAdminEdgeCli } from './cli.js';

void runOrganizationAdminEdgeCli(process.argv.slice(2))
  .then((exitCode) => {
    if (exitCode !== 0) process.exitCode = exitCode;
  })
  .catch(() => {
    process.stderr.write('organization admin edge failed\n');
    process.exitCode = 1;
  });
