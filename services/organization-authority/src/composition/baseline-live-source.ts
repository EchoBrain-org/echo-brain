import {
  GRANOLA_MEETING_SOURCE_ADAPTER_ID,
  GRANOLA_MEETING_SOURCE_ADAPTER_VERSION,
  createGranolaLiveOnlyCursor,
  granolaCursorPhase,
} from '../processing/adapters/meeting-sources/granola/index.js';
import { readAuthorityProcessingSourceRuntimeBinding } from '../adapters/persistence/sqlite/processing-source-runtime-binding.js';
import {
  SqliteAuthorityProcessingStore,
  type AuthorityProcessingStoreBinding,
} from '../processing/storage/sqlite-authority-processing-store.js';
import {
  acquireAuthorityInitializationLock,
  acquireAuthorityRuntimeLock,
} from '../adapters/runtime/singleton-runtime-lock.js';
import { authorityMaintenanceFingerprint } from '../adapters/runtime/runtime-fingerprint.js';
import {
  normalizedAbsolutePath,
  readAuthorityRuntimeConfig,
  resolveAuthorityServeConfig,
} from './operator-config.js';
import {
  inspectAuthorityServePreflight,
  resolveEffectiveAuthorityServeConfig,
} from './operator-state.js';

export interface AuthorityLiveSourceBaselineResult {
  readonly schema_version: 1;
  readonly kind: 'echo-organization-authority-meeting-live-source-baseline';
  readonly outcome: 'baseline_created';
  readonly source: {
    readonly adapter_id: 'granola';
    readonly instance_id: string;
  };
  readonly cutoff_at: string;
}

export interface BaselineAuthorityLiveSourceOptions {
  /** Test seam; production samples the cutoff immediately before the write. */
  readonly now?: () => string;
}

function requireSourceRuntimeBinding(
  binding: ReturnType<typeof readAuthorityProcessingSourceRuntimeBinding>,
): NonNullable<ReturnType<typeof readAuthorityProcessingSourceRuntimeBinding>> {
  if (binding === null) {
    throw new Error('live source baseline requires one persisted Granola source binding');
  }
  return binding;
}

function processingBinding(
  binding: NonNullable<ReturnType<typeof readAuthorityProcessingSourceRuntimeBinding>>,
): AuthorityProcessingStoreBinding {
  return {
    organization_id: binding.organization_id,
    principal_id: binding.principal_id,
    membership_id: binding.membership_id,
    membership_type: binding.membership_type,
    source_adapter_id: binding.source_adapter_id,
    source_instance_id: binding.source_instance_id,
  };
}

/**
 * Replaces only an absent or never-finished history cursor with a live-only
 * cutoff. It does not read credentials, contact Granola, or inspect content.
 */
export async function baselineAuthorityLiveSource(
  configPath: string,
  options: BaselineAuthorityLiveSourceOptions = {},
): Promise<AuthorityLiveSourceBaselineResult> {
  const path = normalizedAbsolutePath(configPath, 'authority config path');
  const config = readAuthorityRuntimeConfig(path);
  const releaseInitialization = await acquireAuthorityInitializationLock(
    path,
    config.state_dir,
  );
  try {
    const runtimeLock = await acquireAuthorityRuntimeLock(
      config.state_dir,
      authorityMaintenanceFingerprint(
        resolveAuthorityServeConfig(config),
        'baseline-live-source',
      ),
    );
    try {
      await inspectAuthorityServePreflight(path, config);
      const effective = resolveEffectiveAuthorityServeConfig(path, config);
      const sourceRuntime = requireSourceRuntimeBinding(
        readAuthorityProcessingSourceRuntimeBinding(
          effective.database_path,
          effective.organization_id,
        ),
      );
      const binding = processingBinding(sourceRuntime);
      const source = {
        kind: 'meeting-source' as const,
        adapter_id: GRANOLA_MEETING_SOURCE_ADAPTER_ID,
        instance_id: binding.source_instance_id,
        version: GRANOLA_MEETING_SOURCE_ADAPTER_VERSION,
      };
      const store = new SqliteAuthorityProcessingStore(
        effective.database_path,
        binding,
        {
          bindingMode: 'require-existing',
          sourceConfiguration: {
            owner_email_sha256: sourceRuntime.owner_email_sha256,
            credential_scope: sourceRuntime.credential_scope,
            credential_reference_sha256:
              sourceRuntime.credential_reference_sha256,
          },
          fileMustExist: true,
        },
      );
      try {
        await store.initialize();
        if ((await store.countUnfinishedCandidates()) !== 0) {
          throw new Error('live source baseline requires zero unfinished candidates');
        }
        const cursor = await store.getSourceCursor(source);
        if (granolaCursorPhase(cursor) === 'live') {
          throw new Error('live source baseline refuses an existing live cursor');
        }
        const cutoffAt = (options.now ?? (() => new Date().toISOString()))();
        const liveCursor = createGranolaLiveOnlyCursor(cutoffAt);
        await store.setSourceCursor(source, liveCursor);
        if ((await store.getSourceCursor(source)) !== liveCursor) {
          throw new Error('live source baseline cursor verification failed');
        }
        return Object.freeze({
          schema_version: 1,
          kind: 'echo-organization-authority-meeting-live-source-baseline',
          outcome: 'baseline_created',
          source: {
            adapter_id: GRANOLA_MEETING_SOURCE_ADAPTER_ID as 'granola',
            instance_id: binding.source_instance_id,
          },
          cutoff_at: cutoffAt,
        });
      } finally {
        store.close();
      }
    } finally {
      await runtimeLock.release();
    }
  } finally {
    await releaseInitialization();
  }
}
