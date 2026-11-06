export function releasePreflight(options?: { target?: string; cwd?: string }, dependencies?: {
  run?: (command: string, args: string[]) => { status: number | null; stdout?: string };
  nodeVersion?: string; umask?: number; statfs?: (path: string) => { bavail: number; bsize: number };
}): { ready: boolean; checks: Array<{ check: string; passed: boolean }>; live_checks_required: string[] };
