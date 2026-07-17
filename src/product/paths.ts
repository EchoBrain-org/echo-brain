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
}

export function resolveProductStatePaths(stateDir: string): ProductStatePaths {
  const root = resolve(stateDir);
  const checkpoints = join(root, 'checkpoints');
  return Object.freeze({
    root,
    logs: join(root, 'logs'),
    health: join(root, 'health'),
    checkpoints,
    manifests: join(root, 'manifests'),
    drafts: join(root, 'drafts'),
    briefs: join(root, 'briefs'),
    database: join(root, 'echo-brain.sqlite'),
  });
}
