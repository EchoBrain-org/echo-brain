import { spawnSanitizedChild } from "./spawn-sanitized-child.js";

export interface LaunchctlResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type LaunchctlRunner = (
  args: readonly string[],
) => Promise<LaunchctlResult>;

export interface LaunchdServiceState {
  loaded: boolean;
  running: boolean;
  pid?: number;
}

const MAX_COMMAND_OUTPUT = 64 * 1024;

function appendBounded(current: string, chunk: string): string {
  if (current.length >= MAX_COMMAND_OUTPUT) return current;
  return `${current}${chunk}`.slice(0, MAX_COMMAND_OUTPUT);
}

function collectChild(
  child: ReturnType<typeof spawnSanitizedChild>,
): Promise<LaunchctlResult> {
  let stdout = "";
  let stderr = "";
  let settled = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = appendBounded(stderr, chunk);
  });
  return new Promise((resolve) => {
    const finish = (result: LaunchctlResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) =>
      finish({ status: 1, stdout, stderr: error.message }),
    );
    child.once("close", (code) =>
      finish({ status: code ?? 1, stdout, stderr }),
    );
  });
}

export async function runLaunchctl(
  args: readonly string[],
): Promise<LaunchctlResult> {
  return await collectChild(
    spawnSanitizedChild("/bin/launchctl", args, { timeout: 10_000 }),
  );
}

export function launchdTarget(uid: number, label: string): string {
  return `gui/${uid}/${label}`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export interface LaunchAgentPlistInput {
  label: string;
  nodePath: string;
  cliPath: string;
  configPath: string;
  stateDirectory: string;
  stdoutPath: string;
  stderrPath: string;
}

export function renderLaunchAgentPlist(input: LaunchAgentPlistInput): string {
  const arguments_ = [
    input.nodePath,
    input.cliPath,
    "service-run",
    "--config",
    input.configPath,
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xml(input.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...arguments_.map((argument) => `    <string>${xml(argument)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(input.stateDirectory)}</string>`,
    "  <key>StandardOutPath</key>",
    `  <string>${xml(input.stdoutPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(input.stderrPath)}</string>`,
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    "  <integer>10</integer>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export async function inspectLaunchdService(
  runner: LaunchctlRunner,
  target: string,
): Promise<LaunchdServiceState> {
  const result = await runner(["print", target]);
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    if (
      /could not find service|service(?:\s+.+)?\s+not found|not loaded|no such process/i.test(
        detail,
      )
    ) {
      return { loaded: false, running: false };
    }
    throw new Error(
      `launchd inspection failed: ${detail.slice(0, 2_000) || `exit ${result.status}`}`,
    );
  }
  const pidMatch = /(?:^|\n)\s*pid\s*=\s*(\d+)\s*(?:\n|$)/.exec(result.stdout);
  const pid = pidMatch === null ? undefined : Number(pidMatch[1]);
  const running =
    pid !== undefined ||
    /(?:^|\n)\s*state\s*=\s*running\s*(?:\n|$)/.test(result.stdout);
  return {
    loaded: true,
    running,
    ...(pid === undefined ? {} : { pid }),
  };
}

export async function requireLaunchctlSuccess(
  runner: LaunchctlRunner,
  args: readonly string[],
  action: string,
): Promise<void> {
  const result = await runner(args);
  if (result.status === 0) return;
  const detail = (result.stderr || result.stdout || `exit ${result.status}`)
    .trim()
    .slice(0, 2_000);
  throw new Error(`${action} failed: ${detail}`);
}
