export function captureCommand(
  run: (stdout: (value: string) => void) => number | Promise<number>,
): Promise<Record<string, unknown>> {
  let output = "";
  return Promise.resolve(run((value) => (output += value))).then((status) => {
    if (status !== 0)
      throw new Error("organization setup stopped-state command failed");
    try {
      return JSON.parse(output) as Record<string, unknown>;
    } catch {
      throw new Error(
        "organization setup stopped-state command returned invalid JSON",
      );
    }
  });
}
