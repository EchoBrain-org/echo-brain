// Runs one person-client command in this process, exactly as the terminal CLI
// would, and captures its bounded output.

/** runPersonClientCli from the person client; argv starts after `person`. */
export type PersonCli = (argv: readonly string[], dependencies: Record<string, unknown>) => Promise<number>;

export interface CliRun {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly overflow: boolean;
}

/** More than the largest bounded client output (32 KiB documents, answers). */
export const MAX_OUTPUT_BYTES = 1024 * 1024;

export async function runCli(
  cli: PersonCli,
  argv: readonly string[],
  dependencies: Record<string, unknown>,
  onStdoutLine?: (line: string) => void,
): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  let pending = '';
  let overflow = false;
  const out = {
    write(value: string) {
      if (overflow || stdout.length + value.length > MAX_OUTPUT_BYTES) { overflow = true; return true; }
      stdout += value;
      if (onStdoutLine) {
        pending += value;
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          onStdoutLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
      }
      return true;
    },
  };
  const err = {
    write(value: string) {
      if (stderr.length + value.length > MAX_OUTPUT_BYTES) { overflow = true; return true; }
      stderr += value;
      return true;
    },
  };
  // Commands never read the host's stdin: it is not a terminal.
  const readInput = () => { throw new Error('No input is available to the desktop client'); };
  let exit: number;
  try {
    exit = await cli(argv, { ...dependencies, stdout: out, stderr: err, read_input: readInput });
  } catch {
    exit = 1;
  }
  return { exit, stdout, stderr, overflow };
}

/** Each non-empty stdout line parsed as JSON; unparsable lines are dropped. */
export function jsonLines(text: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try { values.push(JSON.parse(line)); } catch { /* not a JSON line */ }
  }
  return values;
}

export function lastJson(text: string): unknown {
  const values = jsonLines(text);
  return values.length === 0 ? undefined : values[values.length - 1];
}
