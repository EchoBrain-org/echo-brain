import { join, resolve } from 'node:path';

export interface ProductStatePaths {
  root: string;
  logs: string;
  health: string;
  checkpoints: string;
  manifests: string;
  drafts: string;
  briefs: string;
  database: string;
  pollCheckpoint: string;
  signalCheckpoint: string;
  heartbeat: string;
}

export function resolveProductStatePaths(stateDir: string): ProductStatePaths {
  const root = resolve(stateDir);
  const checkpoints = join(root, 'checkpoints');
  const health = join(root, 'health');
  return Object.freeze({
    root,
    logs: join(root, 'logs'),
    health,
    checkpoints,
    manifests: join(root, 'manifests'),
    drafts: join(root, 'drafts'),
    briefs: join(root, 'briefs'),
    database: join(root, 'echo-brain.sqlite'),
    pollCheckpoint: join(checkpoints, 'granola.json'),
    signalCheckpoint: join(checkpoints, 'granola-signals.json'),
    heartbeat: join(health, 'granola-signals.json'),
  });
}
