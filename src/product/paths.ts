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
  identityRoot: string;
  activeIdentityBundle: string;
  identityManifests: string;
  identityRegistries: string;
  identityPolicies: string;
}

export function resolveProductStatePaths(stateDir: string): ProductStatePaths {
  const root = resolve(stateDir);
  const checkpoints = join(root, 'checkpoints');
  const identityRoot = join(root, 'identity');
  return Object.freeze({
    root,
    logs: join(root, 'logs'),
    health: join(root, 'health'),
    checkpoints,
    manifests: join(root, 'manifests'),
    drafts: join(root, 'drafts'),
    briefs: join(root, 'briefs'),
    database: join(root, 'echo-brain.sqlite'),
    identityRoot,
    activeIdentityBundle: join(
      identityRoot,
      'active-identity-bundle.v1.json',
    ),
    identityManifests: join(identityRoot, 'manifests'),
    identityRegistries: join(identityRoot, 'registries'),
    identityPolicies: join(identityRoot, 'policies'),
  });
}
