import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import {
  MAX_ENROLLMENT_GRANT_LIFETIME_SECONDS,
  MAX_ORGANIZATION_API_CURSOR_CHARACTERS,
  MAX_ORGANIZATION_API_PAGE_ITEMS,
  organizationInternalLiveManifestSha256,
  validateApproveOrganizationInternalLiveReleaseRequest,
  validateOrganizationInternalLiveReleaseManifest,
  validateProvisionOrganizationMembershipRequest,
  validateRecoverOrganizationInstallationAccessRequest,
  validateRevokeOrganizationSubjectRequest,
} from '@echo-brain/organization-api';
import type {
  ApproveOrganizationInternalLiveReleaseRequestV1,
  IssueOrganizationEnrollmentGrantRequestV1,
  IssuedOrganizationEnrollmentGrantV1,
  OrganizationAdminOverviewV1,
  OrganizationApiPageCursorV1,
  OrganizationAuditPageV1,
  OrganizationEnrollmentGrantPageV1,
  OrganizationInstallationPageV1,
  OrganizationInternalLiveReleaseManifestV1,
  OrganizationInternalLiveRolloutStatusV1,
  OrganizationInternalLiveUpdateDirectiveV1,
  OrganizationMembershipPageV1,
  ProvisionedOrganizationMembershipV1,
  ProvisionOrganizationMembershipRequestV1,
  RecoverOrganizationInstallationAccessRequestV1,
  RecoveredOrganizationInstallationAccessV1,
  RevokeOrganizationSubjectRequestV1,
  RevokedOrganizationInstallationV1,
  RevokedOrganizationMembershipV1,
} from '@echo-brain/organization-api';
import { canonicalJson } from '@echo-brain/federation-protocol';
import {
  OrganizationAdminApiClient,
  type OrganizationAdminApiClientOptions,
  type OrganizationAdminPageRequest,
} from '../adapters/http/organization-admin-api-client.js';
import type {
  ActivateOrganizationSlackApprovalRequest,
  ActivatedOrganizationSlackApproval,
} from '../application/slack-approval-activation.js';
import {
  prepareOrganizationInvitation,
  recordOrganizationInvitationIssued,
} from '../adapters/files/private-organization-invitation.js';
import {
  normalizedAbsolutePath,
  readAuthorityRuntimeConfig,
  resolveAuthorityServeConfig,
} from './operator-config.js';
import {
  inspectAuthorityRuntimeOwnership,
  type AuthorityStatusReport,
} from './status.js';

const USAGE = `usage:
  echo-organization-admin overview --config <absolute-path>
  echo-organization-admin memberships list --config <absolute-path> [--cursor <cursor>] [--limit <1-${MAX_ORGANIZATION_API_PAGE_ITEMS}>]
  echo-organization-admin installations list --config <absolute-path> [--cursor <cursor>] [--limit <1-${MAX_ORGANIZATION_API_PAGE_ITEMS}>]
  echo-organization-admin invitations list --config <absolute-path> [--cursor <cursor>] [--limit <1-${MAX_ORGANIZATION_API_PAGE_ITEMS}>]
  echo-organization-admin audit list --config <absolute-path> [--cursor <cursor>] [--limit <1-${MAX_ORGANIZATION_API_PAGE_ITEMS}>]
  echo-organization-admin member create --config <absolute-path> --display-name <name> --membership-type <owner|employee> [--command-id <adm_UUIDv4>]
  echo-organization-admin invitation create --config <absolute-path> --authority-url <public-https-origin> --membership-id <mem_UUIDv4> --lifetime-seconds <1-${MAX_ENROLLMENT_GRANT_LIFETIME_SECONDS}> --out <absolute-path> [--command-id <adm_UUIDv4>]
  echo-organization-admin member revoke --config <absolute-path> --membership-id <mem_UUIDv4> --reason <reason>
  echo-organization-admin installation revoke --config <absolute-path> --installation-id <ins_UUIDv4> --reason <reason>
  echo-organization-admin installation access-recover --config <absolute-path> --installation-id <ins_UUIDv4> --local-access-sequence <positive-integer> --reason <reason>
  echo-organization-admin slack approval activate --config <absolute-path> --administrator-membership-id <mem_UUIDv4> --target-membership-id <mem_UUIDv4> --installation-id <ins_UUIDv4> --identity-link-id <clm_UUIDv4> --adapter-binding-id <bnd_UUIDv4> [--command-id <adm_UUIDv4>]

INTERNAL LIVE:
  echo-organization-admin internal-live release approve --config <absolute-path> --manifest <absolute-path> [--command-id <adm_UUIDv4>]
  echo-organization-admin internal-live rollout status --config <absolute-path>`;

const UUID_V4_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const COMMAND_ID_PATTERN = new RegExp(`^adm_${UUID_V4_SOURCE}$`);
const MEMBERSHIP_ID_PATTERN = new RegExp(`^mem_${UUID_V4_SOURCE}$`);
const INSTALLATION_ID_PATTERN = new RegExp(`^ins_${UUID_V4_SOURCE}$`);
const IDENTITY_LINK_ID_PATTERN = new RegExp(`^clm_${UUID_V4_SOURCE}$`);
const ADAPTER_BINDING_ID_PATTERN = new RegExp(`^bnd_${UUID_V4_SOURCE}$`);
const MAX_CLI_ARGUMENTS = 24;
const MAX_CLI_ARGUMENT_CHARACTERS = 4096;
const MAX_INTERNAL_LIVE_MANIFEST_BYTES = 64 * 1024;
const INTERNAL_LIVE_MANIFEST_FILENAME =
  'internal-live-release-manifest.v1.json';

export interface OrganizationAdminCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface OrganizationAdminCliClient {
  overview(): Promise<OrganizationAdminOverviewV1>;
  listMemberships(
    page?: OrganizationAdminPageRequest,
  ): Promise<OrganizationMembershipPageV1>;
  listInstallations(
    page?: OrganizationAdminPageRequest,
  ): Promise<OrganizationInstallationPageV1>;
  listEnrollmentGrants(
    page?: OrganizationAdminPageRequest,
  ): Promise<OrganizationEnrollmentGrantPageV1>;
  listAudit(
    page?: OrganizationAdminPageRequest,
  ): Promise<OrganizationAuditPageV1>;
  provisionMembership(
    input: ProvisionOrganizationMembershipRequestV1,
  ): Promise<ProvisionedOrganizationMembershipV1>;
  registerEnrollmentGrant(
    membershipId: string,
    input: IssueOrganizationEnrollmentGrantRequestV1,
  ): Promise<IssuedOrganizationEnrollmentGrantV1>;
  revokeMembership(
    membershipId: string,
    input: RevokeOrganizationSubjectRequestV1,
  ): Promise<RevokedOrganizationMembershipV1>;
  revokeInstallation(
    installationId: string,
    input: RevokeOrganizationSubjectRequestV1,
  ): Promise<RevokedOrganizationInstallationV1>;
  recoverInstallationAccess(
    installationId: string,
    input: RecoverOrganizationInstallationAccessRequestV1,
  ): Promise<RecoveredOrganizationInstallationAccessV1>;
  activateSlackApproval(
    input: ActivateOrganizationSlackApprovalRequest,
  ): Promise<ActivatedOrganizationSlackApproval>;
  approveInternalLiveRelease(
    input: ApproveOrganizationInternalLiveReleaseRequestV1,
  ): Promise<OrganizationInternalLiveUpdateDirectiveV1>;
  internalLiveRolloutStatus(): Promise<OrganizationInternalLiveRolloutStatusV1>;
}

export interface OrganizationAdminCliDependencies {
  client_factory?: (
    options: OrganizationAdminApiClientOptions,
  ) => OrganizationAdminCliClient;
  random_bytes?: (size: number) => Uint8Array;
  random_uuid?: () => string;
  preflight?: (configPath: string) => Promise<AuthorityStatusReport>;
}

const PROCESS_IO: OrganizationAdminCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

interface AdminCommandContext {
  client: OrganizationAdminCliClient;
  authority_id: string;
  authority_pin_sha256: `sha256:${string}`;
  organization_id: string;
}

function parseFlags(
  arguments_: readonly string[],
  accepted: readonly string[],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const allowed = new Set(accepted);
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      flag === undefined ||
      !allowed.has(flag) ||
      value === undefined ||
      value.length === 0 ||
      result[flag] !== undefined
    ) {
      throw new Error(USAGE);
    }
    result[flag] = value;
  }
  return result;
}

function requiredFlag(
  flags: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = flags[name];
  if (value === undefined || value.length === 0) throw new Error(USAGE);
  return value;
}

function optionalCanonicalId(
  value: string | undefined,
  pattern: RegExp,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!pattern.test(value)) {
    throw new Error(`${label} must be a canonical identifier`);
  }
  return value;
}

function canonicalId(value: string, pattern: RegExp, label: string): string {
  const validated = optionalCanonicalId(value, pattern, label);
  if (validated === undefined) {
    throw new Error(`${label} must be a canonical identifier`);
  }
  return validated;
}

function parseInteger(
  value: string,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(
      `${label} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${label} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return parsed;
}

function validateCanonicalCursor(value: string): OrganizationApiPageCursorV1 {
  if (
    value.length === 0 ||
    value.length > MAX_ORGANIZATION_API_CURSOR_CHARACTERS ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error('page cursor is invalid');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length === 0 || bytes.toString('base64url') !== value) {
    throw new Error('page cursor is invalid');
  }
  return value;
}

function pageRequest(
  flags: Readonly<Record<string, string>>,
): OrganizationAdminPageRequest | undefined {
  const cursor = flags['--cursor'];
  const rawLimit = flags['--limit'];
  if (cursor === undefined && rawLimit === undefined) return undefined;
  return {
    ...(cursor === undefined
      ? {}
      : { cursor: validateCanonicalCursor(cursor) }),
    ...(rawLimit === undefined
      ? {}
      : {
          limit: parseInteger(
            rawLimit,
            1,
            MAX_ORGANIZATION_API_PAGE_ITEMS,
            'page limit',
          ),
        }),
  };
}

function validateBoundedText(
  value: string,
  maximum: number,
  label: string,
): string {
  if (
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a bounded trimmed text value`);
  }
  return value;
}

function generatedCommandId(randomUuid: () => string): string {
  return canonicalId(`adm_${randomUuid()}`, COMMAND_ID_PATTERN, 'command_id');
}

function readInternalLiveManifest(
  manifestPath: string,
): OrganizationInternalLiveReleaseManifestV1 {
  let bytes: Buffer;
  try {
    const path = normalizedAbsolutePath(
      manifestPath,
      'INTERNAL LIVE manifest path',
    );
    const state = lstatSync(path);
    const currentUid = process.getuid?.();
    if (
      state.isSymbolicLink() ||
      !state.isFile() ||
      state.size <= 0 ||
      state.size > MAX_INTERNAL_LIVE_MANIFEST_BYTES ||
      (currentUid !== undefined && state.uid !== currentUid) ||
      (state.mode & 0o022) !== 0 ||
      realpathSync(path) !== path
    ) {
      throw new Error('unsafe manifest file');
    }
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const file = openSync(path, fsConstants.O_RDONLY | noFollow);
    try {
      const opened = fstatSync(file);
      if (
        opened.dev !== state.dev ||
        opened.ino !== state.ino ||
        opened.size !== state.size ||
        !opened.isFile()
      ) {
        throw new Error('manifest changed while opening');
      }
      bytes = readFileSync(file);
      const afterRead = fstatSync(file);
      if (
        bytes.byteLength !== opened.size ||
        afterRead.size !== opened.size ||
        afterRead.mtimeMs !== opened.mtimeMs ||
        afterRead.ctimeMs !== opened.ctimeMs
      ) {
        throw new Error('manifest changed while reading');
      }
    } finally {
      closeSync(file);
    }
  } catch {
    throw new Error(
      'INTERNAL LIVE manifest must be a bounded current-user canonical regular file that is not writable by group or others',
    );
  }

  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('INTERNAL LIVE manifest must contain valid UTF-8 JSON');
  }
  return validateOrganizationInternalLiveReleaseManifest(parsed);
}

function internalLiveManifestUrl(
  manifest: OrganizationInternalLiveReleaseManifestV1,
): string {
  return `https://github.com/${manifest.build.repository}/releases/download/${encodeURIComponent(manifest.release_tag)}/${INTERNAL_LIVE_MANIFEST_FILENAME}`;
}

function baseUrl(host: '127.0.0.1' | '::1', port: number): string {
  const address = host === '::1' ? '[::1]' : host;
  return `http://${address}:${port}`;
}

export function organizationAdminClientIdentity(input: {
  config_path: string;
  authority_id: string;
  organization_id: string;
}): string {
  const identity = canonicalJson({
    schema_version: 1,
    kind: 'echo-organization-admin-cli-identity',
    config_path: input.config_path,
    authority_id: input.authority_id,
    organization_id: input.organization_id,
  });
  return `cid_${createHash('sha256').update(identity, 'utf8').digest('base64url')}`;
}

async function commandContext(
  configPath: string,
  dependencies: OrganizationAdminCliDependencies,
): Promise<AdminCommandContext> {
  const preflight = await (
    dependencies.preflight ?? inspectAuthorityRuntimeOwnership
  )(configPath);
  if (!preflight.ok || !preflight.running || !preflight.healthy) {
    throw new Error(
      'organization authority must prove that it is running and healthy before administrator credentials can be used',
    );
  }
  const runtimeConfig = readAuthorityRuntimeConfig(configPath);
  const serveConfig = resolveAuthorityServeConfig(runtimeConfig);
  const authorityBaseUrl = baseUrl(serveConfig.host, serveConfig.port);
  if (
    preflight.authority_id !== serveConfig.authority_id ||
    preflight.organization_id !== serveConfig.organization_id ||
    preflight.listener !== authorityBaseUrl
  ) {
    throw new Error(
      'organization authority runtime proof does not match the administrator config',
    );
  }
  const factory =
    dependencies.client_factory ??
    ((options: OrganizationAdminApiClientOptions) =>
      new OrganizationAdminApiClient(options));
  return {
    client: factory({
      base_url: authorityBaseUrl,
      admin_token: serveConfig.admin_token,
      trusted_proxy_token: serveConfig.trusted_proxy_token,
      client_identity: organizationAdminClientIdentity({
        config_path: configPath,
        authority_id: serveConfig.authority_id,
        organization_id: serveConfig.organization_id,
      }),
    }),
    authority_id: serveConfig.authority_id,
    authority_pin_sha256: serveConfig.authority_pin_sha256,
    organization_id: serveConfig.organization_id,
  };
}

function outputJson(io: OrganizationAdminCliIo, value: unknown): void {
  io.stdout(`${canonicalJson(value)}\n`);
}

async function runListCommand(
  command: string,
  arguments_: readonly string[],
  io: OrganizationAdminCliIo,
  dependencies: OrganizationAdminCliDependencies,
): Promise<number> {
  const flags = parseFlags(arguments_, ['--config', '--cursor', '--limit']);
  const page = pageRequest(flags);
  const context = await commandContext(
    requiredFlag(flags, '--config'),
    dependencies,
  );
  let result:
    | OrganizationMembershipPageV1
    | OrganizationInstallationPageV1
    | OrganizationEnrollmentGrantPageV1
    | OrganizationAuditPageV1;
  if (command === 'memberships list') {
    result = await context.client.listMemberships(page);
  } else if (command === 'installations list') {
    result = await context.client.listInstallations(page);
  } else if (command === 'invitations list') {
    result = await context.client.listEnrollmentGrants(page);
  } else {
    result = await context.client.listAudit(page);
  }
  outputJson(io, result);
  return 0;
}

async function runMemberCreate(
  arguments_: readonly string[],
  io: OrganizationAdminCliIo,
  dependencies: OrganizationAdminCliDependencies,
): Promise<number> {
  const flags = parseFlags(arguments_, [
    '--config',
    '--display-name',
    '--membership-type',
    '--command-id',
  ]);
  const membershipType = requiredFlag(flags, '--membership-type');
  if (membershipType !== 'owner' && membershipType !== 'employee') {
    throw new Error('membership type must be owner or employee');
  }
  const suppliedCommand = optionalCanonicalId(
    flags['--command-id'],
    COMMAND_ID_PATTERN,
    'command_id',
  );
  const request = validateProvisionOrganizationMembershipRequest({
    command_id:
      suppliedCommand ??
      generatedCommandId(dependencies.random_uuid ?? randomUUID),
    display_name: validateBoundedText(
      requiredFlag(flags, '--display-name'),
      200,
      'display name',
    ),
    membership_type: membershipType,
  });
  const context = await commandContext(
    requiredFlag(flags, '--config'),
    dependencies,
  );
  outputJson(io, await context.client.provisionMembership(request));
  return 0;
}

async function runInvitationCreate(
  arguments_: readonly string[],
  io: OrganizationAdminCliIo,
  dependencies: OrganizationAdminCliDependencies,
): Promise<number> {
  const flags = parseFlags(arguments_, [
    '--config',
    '--authority-url',
    '--membership-id',
    '--lifetime-seconds',
    '--out',
    '--command-id',
  ]);
  const membershipId = canonicalId(
    requiredFlag(flags, '--membership-id'),
    MEMBERSHIP_ID_PATTERN,
    'membership_id',
  );
  const suppliedCommand = optionalCanonicalId(
    flags['--command-id'],
    COMMAND_ID_PATTERN,
    'command_id',
  );
  const lifetimeSeconds = parseInteger(
    requiredFlag(flags, '--lifetime-seconds'),
    1,
    MAX_ENROLLMENT_GRANT_LIFETIME_SECONDS,
    'invitation lifetime',
  );
  const authorityUrl = requiredFlag(flags, '--authority-url');
  const outputPath = requiredFlag(flags, '--out');
  const context = await commandContext(
    requiredFlag(flags, '--config'),
    dependencies,
  );
  const prepared = prepareOrganizationInvitation({
    output_path: outputPath,
    authority_base_url: authorityUrl,
    authority_id: context.authority_id,
    authority_pin_sha256: context.authority_pin_sha256,
    organization_id: context.organization_id,
    membership_id: membershipId,
    lifetime_seconds: lifetimeSeconds,
    ...(suppliedCommand === undefined ? {} : { command_id: suppliedCommand }),
    random_bytes: dependencies.random_bytes ?? randomBytes,
    random_uuid: dependencies.random_uuid ?? randomUUID,
  });
  const issued = await context.client.registerEnrollmentGrant(membershipId, {
    command_id: prepared.envelope.command_id,
    enrollment_grant_sha256: prepared.envelope.enrollment_grant_sha256,
    lifetime_seconds: prepared.envelope.lifetime_seconds,
  });
  recordOrganizationInvitationIssued(prepared, issued);
  outputJson(io, {
    schema_version: 1,
    kind: 'echo-organization-enrollment-invitation-created',
    invitation_path: prepared.output_path,
    authority_url: prepared.envelope.authority_base_url,
    issued,
    configured_authority_pin_sha256: context.authority_pin_sha256,
    authority_pin_verification: 'verify_independently_before_enrollment',
  });
  return 0;
}

async function runMemberRevoke(
  arguments_: readonly string[],
  io: OrganizationAdminCliIo,
  dependencies: OrganizationAdminCliDependencies,
): Promise<number> {
  const flags = parseFlags(arguments_, [
    '--config',
    '--membership-id',
    '--reason',
  ]);
  const membershipId = canonicalId(
    requiredFlag(flags, '--membership-id'),
    MEMBERSHIP_ID_PATTERN,
    'membership_id',
  );
  const request = validateRevokeOrganizationSubjectRequest({
    reason: validateBoundedText(
      requiredFlag(flags, '--reason'),
      500,
      'revocation reason',
    ),
  });
  const context = await commandContext(
    requiredFlag(flags, '--config'),
    dependencies,
  );
  outputJson(io, await context.client.revokeMembership(membershipId, request));
  return 0;
}

async function runInstallationRevoke(
  arguments_: readonly string[],
  io: OrganizationAdminCliIo,
  dependencies: OrganizationAdminCliDependencies,
): Promise<number> {
  const flags = parseFlags(arguments_, [
    '--config',
    '--installation-id',
    '--reason',
  ]);
  const installationId = canonicalId(
    requiredFlag(flags, '--installation-id'),
    INSTALLATION_ID_PATTERN,
    'installation_id',
  );
  const request = validateRevokeOrganizationSubjectRequest({
    reason: validateBoundedText(
      requiredFlag(flags, '--reason'),
      500,
      'revocation reason',
    ),
  });
  const context = await commandContext(
    requiredFlag(flags, '--config'),
    dependencies,
  );
  outputJson(
    io,
    await context.client.revokeInstallation(installationId, request),
  );
  return 0;
}

async function runInstallationAccessRecover(
  arguments_: readonly string[],
  io: OrganizationAdminCliIo,
  dependencies: OrganizationAdminCliDependencies,
): Promise<number> {
  const flags = parseFlags(arguments_, [
    '--config',
    '--installation-id',
    '--local-access-sequence',
    '--reason',
  ]);
  const installationId = canonicalId(
    requiredFlag(flags, '--installation-id'),
    INSTALLATION_ID_PATTERN,
    'installation_id',
  );
  const request = validateRecoverOrganizationInstallationAccessRequest({
    local_access_state_sequence: parseInteger(
      requiredFlag(flags, '--local-access-sequence'),
      1,
      Number.MAX_SAFE_INTEGER,
      'local access sequence',
    ),
    reason: validateBoundedText(
      requiredFlag(flags, '--reason'),
      500,
      'access recovery reason',
    ),
  });
  const context = await commandContext(
    requiredFlag(flags, '--config'),
    dependencies,
  );
  outputJson(
    io,
    await context.client.recoverInstallationAccess(installationId, request),
  );
  return 0;
}

async function runSlackApprovalActivate(
  arguments_: readonly string[],
  io: OrganizationAdminCliIo,
  dependencies: OrganizationAdminCliDependencies,
): Promise<number> {
  const flags = parseFlags(arguments_, [
    '--config',
    '--administrator-membership-id',
    '--target-membership-id',
    '--installation-id',
    '--identity-link-id',
    '--adapter-binding-id',
    '--command-id',
  ]);
  const suppliedCommand = optionalCanonicalId(
    flags['--command-id'],
    COMMAND_ID_PATTERN,
    'command_id',
  );
  const request: ActivateOrganizationSlackApprovalRequest = {
    command_id:
      suppliedCommand ??
      generatedCommandId(dependencies.random_uuid ?? randomUUID),
    administrator_membership_id: canonicalId(
      requiredFlag(flags, '--administrator-membership-id'),
      MEMBERSHIP_ID_PATTERN,
      'administrator_membership_id',
    ),
    target_membership_id: canonicalId(
      requiredFlag(flags, '--target-membership-id'),
      MEMBERSHIP_ID_PATTERN,
      'target_membership_id',
    ),
    installation_id: canonicalId(
      requiredFlag(flags, '--installation-id'),
      INSTALLATION_ID_PATTERN,
      'installation_id',
    ),
    identity_link_id: canonicalId(
      requiredFlag(flags, '--identity-link-id'),
      IDENTITY_LINK_ID_PATTERN,
      'identity_link_id',
    ),
    adapter_binding_id: canonicalId(
      requiredFlag(flags, '--adapter-binding-id'),
      ADAPTER_BINDING_ID_PATTERN,
      'adapter_binding_id',
    ),
  };
  const context = await commandContext(
    requiredFlag(flags, '--config'),
    dependencies,
  );
  outputJson(io, await context.client.activateSlackApproval(request));
  return 0;
}

async function runInternalLiveReleaseApprove(
  arguments_: readonly string[],
  io: OrganizationAdminCliIo,
  dependencies: OrganizationAdminCliDependencies,
): Promise<number> {
  const flags = parseFlags(arguments_, [
    '--config',
    '--manifest',
    '--command-id',
  ]);
  const suppliedCommand = optionalCanonicalId(
    flags['--command-id'],
    COMMAND_ID_PATTERN,
    'command_id',
  );
  const manifest = readInternalLiveManifest(
    requiredFlag(flags, '--manifest'),
  );
  const manifestSha256 = organizationInternalLiveManifestSha256(manifest);
  const request = validateApproveOrganizationInternalLiveReleaseRequest({
    schema_version: 1,
    kind: 'echo-internal-live-release-approval-request',
    command_id:
      suppliedCommand ??
      generatedCommandId(dependencies.random_uuid ?? randomUUID),
    manifest_url: internalLiveManifestUrl(manifest),
    manifest_sha256: manifestSha256,
    manifest,
  });
  const context = await commandContext(
    requiredFlag(flags, '--config'),
    dependencies,
  );
  const directive = await context.client.approveInternalLiveRelease(request);
  outputJson(io, {
    schema_version: 1,
    kind: 'echo-organization-internal-live-release-approved',
    promotion_stage: 'INTERNAL LIVE',
    command_id: request.command_id,
    release: {
      release_version: manifest.release_version,
      release_tag: manifest.release_tag,
      source_sha: manifest.source.sha,
      artifact_filename: manifest.artifact.filename,
      artifact_sha256: manifest.artifact.sha256,
      manifest_sha256: manifestSha256,
    },
    directive,
  });
  return 0;
}

async function runInternalLiveRolloutStatus(
  arguments_: readonly string[],
  io: OrganizationAdminCliIo,
  dependencies: OrganizationAdminCliDependencies,
): Promise<number> {
  const flags = parseFlags(arguments_, ['--config']);
  const context = await commandContext(
    requiredFlag(flags, '--config'),
    dependencies,
  );
  outputJson(io, await context.client.internalLiveRolloutStatus());
  return 0;
}

export async function runOrganizationAuthorityAdminCli(
  arguments_: readonly string[],
  io: OrganizationAdminCliIo = PROCESS_IO,
  dependencies: OrganizationAdminCliDependencies = {},
): Promise<number> {
  if (
    arguments_.length > MAX_CLI_ARGUMENTS ||
    arguments_.some(
      (value) =>
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > MAX_CLI_ARGUMENT_CHARACTERS ||
        value.includes('\0'),
    )
  ) {
    throw new Error(USAGE);
  }

  const first = arguments_[0];
  const second = arguments_[1];
  const third = arguments_[2];
  if ((first === 'help' || first === '--help') && arguments_.length === 1) {
    outputJson(io, {
      schema_version: 1,
      kind: 'echo-organization-admin-help',
      usage: USAGE,
    });
    return 0;
  }
  if (first === 'overview') {
    const flags = parseFlags(arguments_.slice(1), ['--config']);
    const context = await commandContext(
      requiredFlag(flags, '--config'),
      dependencies,
    );
    outputJson(io, await context.client.overview());
    return 0;
  }

  if (first === 'slack' && second === 'approval' && third === 'activate') {
    return await runSlackApprovalActivate(
      arguments_.slice(3),
      io,
      dependencies,
    );
  }

  if (
    first === 'internal-live' &&
    second === 'release' &&
    third === 'approve'
  ) {
    return await runInternalLiveReleaseApprove(
      arguments_.slice(3),
      io,
      dependencies,
    );
  }
  if (
    first === 'internal-live' &&
    second === 'rollout' &&
    third === 'status'
  ) {
    return await runInternalLiveRolloutStatus(
      arguments_.slice(3),
      io,
      dependencies,
    );
  }

  const command = `${first ?? ''} ${second ?? ''}`;
  const commandArguments = arguments_.slice(2);
  if (
    command === 'memberships list' ||
    command === 'installations list' ||
    command === 'invitations list' ||
    command === 'audit list'
  ) {
    return await runListCommand(command, commandArguments, io, dependencies);
  }
  if (command === 'member create') {
    return await runMemberCreate(commandArguments, io, dependencies);
  }
  if (command === 'invitation create') {
    return await runInvitationCreate(commandArguments, io, dependencies);
  }
  if (command === 'member revoke') {
    return await runMemberRevoke(commandArguments, io, dependencies);
  }
  if (command === 'installation revoke') {
    return await runInstallationRevoke(commandArguments, io, dependencies);
  }
  if (command === 'installation access-recover') {
    return await runInstallationAccessRecover(
      commandArguments,
      io,
      dependencies,
    );
  }
  throw new Error(USAGE);
}
