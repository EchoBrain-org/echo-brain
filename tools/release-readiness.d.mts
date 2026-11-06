export function releaseRoundStatus(path: string, dependencies?: {
  now?: () => number;
  inspectPrepared?: (options: any) => any;
  readServer?: (path: string) => any;
  readPublication?: (path: string, options: any) => any;
}): {
  recorded_phase: string; observation: string; research_coverage_passed: boolean;
  remaining: string[]; next_action: string; review: any; client_proofs: any[];
};
