import { join, resolve } from "node:path";

export interface ProductStatePaths {
  root: string;
  logs: string;
  health: string;
  checkpoints: string;
  manifests: string;
  drafts: string;
  briefs: string;
  database: string;
  /** Retired founder-identity location, retained only for residue detection. */
  identityRoot: string;
  /** Retired founder-bootstrap location, retained only for residue detection. */
  founderIdentityBootstrap: string;
}

export function resolveProductStatePaths(stateDir: string): ProductStatePaths {
  const root = resolve(stateDir);
  return Object.freeze({
    root,
    logs: join(root, "logs"),
    health: join(root, "health"),
    checkpoints: join(root, "checkpoints"),
    manifests: join(root, "manifests"),
    drafts: join(root, "drafts"),
    briefs: join(root, "briefs"),
    database: join(root, "echo-brain.sqlite"),
    // The retired mode's on-disk layout is frozen: these derivations must
    // keep finding residue that is already on disk.
    identityRoot: join(root, "identity"),
    founderIdentityBootstrap: join(root, "bootstrap", "founder-identity"),
  });
}
