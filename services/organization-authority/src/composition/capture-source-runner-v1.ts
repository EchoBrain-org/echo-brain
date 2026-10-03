import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import { verifyAuthorityStateLineage } from '@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { SqliteCaptureCursorStoreV1 } from '../adapters/persistence/sqlite/capture-cursors-v1.js';
import { SqliteCaptureFoundationV1 } from '../adapters/persistence/sqlite/capture-foundation-v1.js';
import {
  createCaptureSourceRunnerV1, type CaptureSourceRunnerOptionsV1, type CaptureSourceRunnerV1,
} from '../application/capture-source-run-v1.js';

/** Sidecar beside authority.sqlite in the state directory. */
export const CAPTURE_CURSORS_DATABASE_V1 = 'capture-cursors.sqlite';

/**
 * Manual and test entry for vendor-free capture over an existing Authority state
 * directory. Registers no provider, timer, route or production composition.
 * Open at most one runner per state directory: the run guard is in-process.
 */
export function openCaptureSourceRunnerV1<TDeps>(options: Omit<CaptureSourceRunnerOptionsV1<TDeps>, 'open_store' | 'cursors'> & {
  readonly state_directory: string;
}): CaptureSourceRunnerV1 & { close(): void } {
  const { state_directory: stateDirectory, ...runnerOptions } = options;
  const lineage = verifyAuthorityStateLineage(stateDirectory).root;
  const authority = openAuthorityDatabase(join(stateDirectory, 'authority.sqlite'), { fileMustExist: true });
  let bookmarks: Database.Database | undefined;
  try {
    bookmarks = openAuthorityDatabase(join(stateDirectory, CAPTURE_CURSORS_DATABASE_V1));
    // Validates every configuration before the organization check reads it.
    const runner = createCaptureSourceRunnerV1({ ...runnerOptions, cursors: new SqliteCaptureCursorStoreV1(bookmarks),
      open_store: ({ containers, authority: fence }) => new SqliteCaptureFoundationV1(authority, fence, containers) });
    if (runnerOptions.configs.some(config => config.scope.organization_id !== lineage.organization_id)) {
      throw new Error('Capture source configuration belongs to another organization');
    }
    const opened = bookmarks;
    let closed = false;
    return Object.freeze({
      runCaptureSourceOnce(source_id: string, context?: Parameters<CaptureSourceRunnerV1['runCaptureSourceOnce']>[1]) {
        if (closed) return Promise.reject(new Error('Capture source runner is closed'));
        return runner.runCaptureSourceOnce(source_id, context);
      },
      close() {
        if (closed) return;
        closed = true;
        opened.close(); authority.close();
      },
    });
  } catch (error) {
    bookmarks?.close(); authority.close();
    throw error;
  }
}
