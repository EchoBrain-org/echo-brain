import { runOrganizationAuthorityCli } from './composition/cli.js';

void runOrganizationAuthorityCli(process.argv.slice(2), process.env).catch(
  (error: unknown) => {
    const message = error instanceof Error ? error.message : 'authority failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  },
);
