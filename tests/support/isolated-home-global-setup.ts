import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    readonly isolated_home: string;
  }
}

/** One empty home for the whole run, handed to every worker and removed when the run ends. */
export default function setup(project: TestProject): () => void {
  const home = mkdtempSync(join(tmpdir(), 'echo-vitest-home-'));
  project.provide('isolated_home', home);
  return () => rmSync(home, { recursive: true, force: true });
}
