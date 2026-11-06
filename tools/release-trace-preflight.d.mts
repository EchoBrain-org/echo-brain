export function releaseTracePreflight(options: { release: string; runs: string; exportStatus: string }, dependencies?: { now?: () => number }): {
  ready: boolean; exporter_healthy: boolean; recent_complete_candidate_traces: number; next_action: string;
};
