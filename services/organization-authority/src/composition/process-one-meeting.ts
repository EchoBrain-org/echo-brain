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
  runOneAuthorityMeeting,
  type AuthorityOneMeetingRunResult,
} from '../processing/live/run-one-meeting.js';
import {
  normalizedAbsolutePath,
  readAuthorityRuntimeConfig,
  resolveAuthorityServeConfig,
} from './operator-config.js';
import {
  inspectAuthorityServePreflight,
  resolveEffectiveAuthorityServeConfig,
} from './operator-state.js';

export const AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_FILENAME =
  'granola-organization-api-key';
export const AUTHORITY_GRANOLA_ORGANIZATION_OWNER_EMAIL_FILENAME =
  'granola-organization-owner-email';
export const AUTHORITY_GRANOLA_ORGANIZATION_SCOPE_FILENAME =
  'granola-organization-credential-scope';
export const AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_REFERENCE =
  'aws-secrets-manager:us-west-2:echo/org1-prod/granola-organization-source:SecretString:api_key';

export interface AuthorityProcessOneMeetingInput {
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: 'owner' | 'employee';
  readonly source_instance_id: string;
}

function assertInput(input: AuthorityProcessOneMeetingInput): void {
  assertFederationId(
    input.principal_id,
    'prn',
    'processing source principal_id',
  );
  assertFederationId(
    input.membership_id,
    'mem',
    'processing source membership_id',
  );
  if (input.membership_type !== 'owner' && input.membership_type !== 'employee') {
    throw new Error('processing source membership_type is unsupported');
  }
  if (!/^[a-z][a-z0-9-]{0,127}$/.test(input.source_instance_id)) {
    throw new Error('processing source instance_id is invalid');
  }
}

/**
 * Runs one bounded meeting pull while owning the same lock as `serve`.
 * Consequently the normal Authority process must be stopped, and a racing
 * restart loses the singleton acquisition rather than creating two writers.
 */
export async function processOneAuthorityMeeting(
  configPath: string,
  input: AuthorityProcessOneMeetingInput,
): Promise<AuthorityOneMeetingRunResult> {
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
        'process-one-meeting',
      ),
    );
    try {
      await inspectAuthorityServePreflight(path, config);
      const effective = resolveEffectiveAuthorityServeConfig(path, config);
      const recordingPolicy = effective.organization_recording_policy_v1;
      if (recordingPolicy === undefined) {
        throw new Error(
          'one-meeting processing requires active organization recording policy',
        );
      }
      const credentialDirectory = join(
        effective.state_directory,
        'credentials',
      );
      const ownerEmail = readPrivateAuthorityGranolaOwnerEmail(
        `file:${join(
          credentialDirectory,
          AUTHORITY_GRANOLA_ORGANIZATION_OWNER_EMAIL_FILENAME,
        )}`,
      );
      const credentialScope =
        readPrivateAuthorityOrganizationCredentialScope(
          `file:${join(
            credentialDirectory,
            AUTHORITY_GRANOLA_ORGANIZATION_SCOPE_FILENAME,
          )}`,
        );
      const approvedOwnerEmailSha256 =
        assertAuthorityProcessingOwnerEmailBinding(
          effective.database_path,
          {
            organization_id: effective.organization_id,
            principal_id: input.principal_id,
            membership_id: input.membership_id,
            membership_type: input.membership_type,
          },
          ownerEmail,
        );
      const credential =
        readPrivateAuthorityGranolaOrganizationCredential(
          `file:${join(
            credentialDirectory,
            AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_FILENAME,
          )}`,
        );
      return await runOneAuthorityMeeting({
        database_path: effective.database_path,
        binding: {
          organization_id: effective.organization_id,
          principal_id: input.principal_id,
          membership_id: input.membership_id,
          membership_type: input.membership_type,
          source_adapter_id: 'granola',
          source_instance_id: input.source_instance_id,
        },
        source_instance_id: input.source_instance_id,
        owner_email: ownerEmail,
        approved_owner_email_sha256: approvedOwnerEmailSha256,
        granola_credential: credential,
        credential_scope: credentialScope,
        credential_reference:
          AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_REFERENCE,
        decision_processor_instance_id:
          recordingPolicy.decision_processor_adapter_instance_id,
      });
    } finally {
      await runtimeLock.release();
    }
  } finally {
    await releaseInitialization();
  }
}
