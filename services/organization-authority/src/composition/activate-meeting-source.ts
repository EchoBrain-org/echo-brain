import { join } from 'node:path';
import { assertFederationId } from '@echo-brain/federation-protocol';
import { assertAuthorityProcessingOwnerEmailBinding } from '../adapters/persistence/sqlite/processing-source-identity.js';
import {
  readPrivateAuthorityGranolaOrganizationCredential,
  readPrivateAuthorityGranolaOwnerEmail,
  readPrivateAuthorityOrganizationCredentialScope,
} from '../adapters/security/private-file-credentials.js';
import {
  acquireAuthorityInitializationLock,
  acquireAuthorityRuntimeLock,
} from '../adapters/runtime/singleton-runtime-lock.js';
import { authorityMaintenanceFingerprint } from '../adapters/runtime/runtime-fingerprint.js';
import {
  GRANOLA_MEETING_SOURCE_ADAPTER_ID,
  GRANOLA_MEETING_SOURCE_ADAPTER_VERSION,
  createGranolaLiveOnlyCursor,
  granolaCursorPhase,
  granolaLiveOnlyCutoff,
} from '../processing/adapters/meeting-sources/granola/index.js';
import { SqliteAuthorityProcessingStore } from '../processing/storage/sqlite-authority-processing-store.js';
import {
  normalizedAbsolutePath,
  readAuthorityRuntimeConfig,
  resolveAuthorityServeConfig,
} from './operator-config.js';
import {
  inspectAuthorityServePreflight,
  resolveEffectiveAuthorityServeConfig,
} from './operator-state.js';
import {
  AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_FILENAME,
  AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_REFERENCE,
  AUTHORITY_GRANOLA_ORGANIZATION_OWNER_EMAIL_FILENAME,
  AUTHORITY_GRANOLA_ORGANIZATION_SCOPE_FILENAME,
  authorityProcessingCredentialReferenceSha256,
} from './processing-source-credentials.js';

export interface AuthorityActivateMeetingSourceInput {
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: 'owner' | 'employee';
  readonly source_instance_id: string;
}

export interface AuthorityActivateMeetingSourceResult {
  readonly schema_version: 1;
  readonly kind: 'echo-organization-authority-meeting-source-activation';
  readonly outcome: 'activated' | 'already_activated';
  readonly source: {
    readonly adapter_id: 'granola';
    readonly instance_id: string;
    readonly version: string;
  };
  readonly cutoff_at: string;
  readonly source_binding: {
    readonly owner: 'provisioned' | 'existing';
    readonly configuration: 'provisioned' | 'existing';
  };
}

export interface ActivateAuthorityMeetingSourceOptions {
  /** Test seam; evaluated only if no immutable activation cursor exists. */
  readonly now?: () => string;
}

function assertInput(input: AuthorityActivateMeetingSourceInput): void {
  assertFederationId(input.principal_id, 'prn', 'meeting source principal_id');
  assertFederationId(input.membership_id, 'mem', 'meeting source membership_id');
  if (input.membership_type !== 'owner' && input.membership_type !== 'employee') {
    throw new Error('meeting source membership_type is unsupported');
  }
  if (!/^[a-z][a-z0-9-]{0,127}$/.test(input.source_instance_id)) {
    throw new Error('meeting source instance_id is invalid');
  }
}

/**
 * A stopped, provider-free admission for one Authority-owned Granola source.
 * Reading the private credential only verifies its local contract; it never
 * contacts Granola or exposes the credential. The store transaction then
 * permanently binds the exact Person, credential proof, and live cutoff.
 */
export async function activateAuthorityMeetingSource(
  configPath: string,
  input: AuthorityActivateMeetingSourceInput,
  options: ActivateAuthorityMeetingSourceOptions = {},
): Promise<AuthorityActivateMeetingSourceResult> {
  assertInput(input);
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
        'activate-meeting-source',
      ),
    );
    try {
      await inspectAuthorityServePreflight(path, config);
      const effective = resolveEffectiveAuthorityServeConfig(path, config);
      if (effective.organization_recording_policy_v1 === undefined) {
        throw new Error('meeting source activation requires active organization recording policy');
      }
      const credentialDirectory = join(effective.state_directory, 'credentials');
      const ownerEmail = readPrivateAuthorityGranolaOwnerEmail(
        `file:${join(credentialDirectory, AUTHORITY_GRANOLA_ORGANIZATION_OWNER_EMAIL_FILENAME)}`,
      );
      // This is deliberately local: activation is not an implicit provider pull.
      readPrivateAuthorityGranolaOrganizationCredential(
        `file:${join(credentialDirectory, AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_FILENAME)}`,
      );
      const credentialScope = readPrivateAuthorityOrganizationCredentialScope(
        `file:${join(credentialDirectory, AUTHORITY_GRANOLA_ORGANIZATION_SCOPE_FILENAME)}`,
      );
      const ownerEmailSha256 = assertAuthorityProcessingOwnerEmailBinding(
        effective.database_path,
        {
          organization_id: effective.organization_id,
          principal_id: input.principal_id,
          membership_id: input.membership_id,
          membership_type: input.membership_type,
        },
        ownerEmail,
      );
      const source = {
        kind: 'meeting-source' as const,
        adapter_id: GRANOLA_MEETING_SOURCE_ADAPTER_ID,
        instance_id: input.source_instance_id,
        version: GRANOLA_MEETING_SOURCE_ADAPTER_VERSION,
      };
      const store = new SqliteAuthorityProcessingStore(
        effective.database_path,
        {
          organization_id: effective.organization_id,
          principal_id: input.principal_id,
          membership_id: input.membership_id,
          membership_type: input.membership_type,
          source_adapter_id: source.adapter_id,
          source_instance_id: source.instance_id,
        },
        {
          bindingMode: 'provision',
          sourceConfiguration: {
            owner_email_sha256: ownerEmailSha256,
            credential_scope: credentialScope,
            credential_reference_sha256:
              authorityProcessingCredentialReferenceSha256(
                AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_REFERENCE,
              ),
          },
          fileMustExist: true,
          ...(options.now === undefined ? {} : { now: options.now }),
        },
      );
      try {
        const activation = await store.activateLiveSource(
          source,
          (activatedAt) => createGranolaLiveOnlyCursor(activatedAt),
          (cursor) => {
            if (granolaCursorPhase(cursor) !== 'live') {
              throw new Error('authority processing source activation requires a live-only Granola cursor');
            }
            granolaLiveOnlyCutoff(cursor);
          },
        );
        return Object.freeze({
          schema_version: 1,
          kind: 'echo-organization-authority-meeting-source-activation',
          outcome: activation.outcome,
          source: {
            adapter_id: GRANOLA_MEETING_SOURCE_ADAPTER_ID as 'granola',
            instance_id: input.source_instance_id,
            version: GRANOLA_MEETING_SOURCE_ADAPTER_VERSION,
          },
          cutoff_at: granolaLiveOnlyCutoff(activation.cursor),
          source_binding: {
            owner: activation.source_binding.owner_binding,
            configuration: activation.source_binding.configuration_binding,
          },
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
