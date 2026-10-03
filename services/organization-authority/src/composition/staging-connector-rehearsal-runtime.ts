import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import { verifyAuthorityStateLineage } from '@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage';
import { STAGING_AUTHORITY_ORIGIN_V1 } from '@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1';
import type { ProviderHttpApplicationV1, ProviderHttpRequestV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { readAdmittedMeetingProcessingCommitmentsV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-processing-commitments';
import { SqliteAuthorityMeetingProcessingStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1';
import { createGranolaMeetingSourceBundleV1 } from '@echo-brain/provider-granola/granola-meeting-source-bundle-v1';
import { createOpenRouterDecisionProcessorBundleV1 } from '@echo-brain/provider-openrouter/openrouter-decision-processor-bundle-v1';
import { validateOrganizationAuthorityOrigin } from '@echo-brain/organization-api';
import { SLACK_PUBLIC_CHANNEL_CONTEXT_CAPABILITY_V1 } from '@echo-brain/provider-slack-server/organization-control-plane/application/slack-integration-contracts';
import { openSlackContextCaptureRuntimeV1, type SlackContextCaptureRuntimePortsV1 } from './slack-context-capture-runtime-v1.js';
import Database from 'better-sqlite3';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  STAGING_CONNECTOR_REHEARSAL_PATH_V1,
  validateStagingConnectorRehearsalProfileV1,
  type StagingConnectorRehearsalProfileV1,
} from './staging-connector-rehearsal-protocol-v1.js';
import { stagingConnectorRehearsalProtocol, validateStagingConnectorRehearsalProfile, type StagingConnectorRehearsalProfile, type StagingConnectorRehearsalRequest, type StagingConnectorRehearsalResponse } from './staging-connector-rehearsal-protocol.js';
import type { StagingConnectorRehearsalProfileV2 } from './staging-connector-rehearsal-protocol-v2.js';
import { isActiveInitialOwnerV1, openConnectorRehearsalCaptureV1, type OpenedConnectorRehearsalCaptureV1 } from './connector-rehearsal-capture-v1.js';
import { openJiraPersonLiveRuntimeV1, type JiraPersonLiveRuntimeSeamsV1, type OpenedJiraPersonLiveRuntimeV1 } from './jira-person-live-runtime-v1.js';
import {
  openOrganizationAuthorityService,
  type OrganizationAuthorityServiceConfig,
  type OrganizationAuthorityServiceDependencies,
} from './organization-authority-composition-root.js';
import { readOrganizationAuthoritySetupManifest } from './organization-authority-setup-cli.js';
import type { OpenedOrganizationAuthorityRuntime } from './organization-authority-runtime.js';

const SIDECAR_DIRECTORY = 'staging-connector-rehearsal-v1';
const SIDECAR_BINDING = 'binding.json';
const SIDECAR_DATABASE = 'jira-person-connections.sqlite';
const MAX_BINDING_BYTES = 8 * 1024;

export interface StagingConnectorRehearsalSelectionV1 {
  readonly profile: StagingConnectorRehearsalProfileV1;
  readonly release_id: string;
  /** Exact public host that the staging candidate is configured to serve. */
  readonly authority_host: string;
}

export interface StagingConnectorRehearsalSelectionV2 {
  readonly profile: StagingConnectorRehearsalProfileV2;
  readonly release_id: string;
  readonly authority_host: string;
}
export type StagingConnectorRehearsalSelection = StagingConnectorRehearsalSelectionV1 | StagingConnectorRehearsalSelectionV2;

export interface StagingConnectorRehearsalRuntimeDependenciesV1 extends OrganizationAuthorityServiceDependencies {
  /** Test seams only. The wrapper always owns the sidecar SQLite handle. */
  readonly jira?: Omit<JiraPersonLiveRuntimeSeamsV1, 'database'>;
}

interface OwnerV1 {
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
}
interface SidecarBindingV1 extends OwnerV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-staging-connector-rehearsal-sidecar-binding-v1';
  readonly authority_id: string;
  readonly state_lineage_id: string;
  readonly profile_sha256: `sha256:${string}`;
}

function unavailable(): never {
  throw new AuthorityOperationError('unavailable', 'Staging connector rehearsal is unavailable');
}
function unauthorized(): never {
  throw new AuthorityOperationError('unauthorized', 'Person authentication failed');
}
function invalid(): never {
  throw new AuthorityOperationError('invalid_request', 'Staging connector rehearsal request is invalid');
}
function sidecarFailure(): never {
  throw new Error('Staging connector rehearsal sidecar is invalid');
}
function entry(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    sidecarFailure();
  }
}
function assertNoSymlinkAncestor(path: string): void {
  let current = resolve(path);
  for (;;) {
    const value = entry(current);
    if (value === undefined || value.isSymbolicLink()) sidecarFailure();
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function ownedPrivateDirectory(path: string): void {
  const value = entry(path);
  if (value === undefined) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const current = entry(path);
  if (current === undefined || !current.isDirectory() || current.isSymbolicLink() ||
      current.uid !== process.getuid?.() || (Number(current.mode) & 0o777) !== 0o700) sidecarFailure();
}
function ownedPrivateFile(path: string): void {
  const value = entry(path);
  if (value === undefined) {
    const descriptor = openSync(path, 'wx', 0o600);
    closeSync(descriptor);
    chmodSync(path, 0o600);
  }
  const current = entry(path);
  if (current === undefined || !current.isFile() || current.isSymbolicLink() ||
      current.uid !== process.getuid?.() || (Number(current.mode) & 0o777) !== 0o600 || current.nlink !== 1) sidecarFailure();
}
function privateJson(path: string): Record<string, unknown> {
  const value = entry(path);
  if (value === undefined || !value.isFile() || value.isSymbolicLink() || value.uid !== process.getuid?.() ||
      (Number(value.mode) & 0o777) !== 0o600 || value.nlink !== 1 || value.size < 1 || value.size > MAX_BINDING_BYTES) sidecarFailure();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) sidecarFailure();
    return parsed as Record<string, unknown>;
  } catch { sidecarFailure(); }
}
function exactBinding(value: Record<string, unknown>, expected: SidecarBindingV1): boolean {
  const keys = ['schema_version', 'kind', 'authority_id', 'organization_id', 'state_lineage_id', 'principal_id', 'membership_id', 'profile_sha256'];
  return Object.keys(value).sort().join(',') === keys.sort().join(',') &&
    keys.every(key => value[key] === expected[key as keyof SidecarBindingV1]);
}
function openSidecar(stateDirectory: string, binding: SidecarBindingV1): { readonly database: Database.Database; close(): void } {
  assertNoSymlinkAncestor(stateDirectory);
  const parent = dirname(stateDirectory);
  assertNoSymlinkAncestor(parent);
  const directory = join(parent, SIDECAR_DIRECTORY);
  ownedPrivateDirectory(directory);
  const marker = join(directory, SIDECAR_BINDING);
  const databasePath = join(directory, SIDECAR_DATABASE);
  const existingMarker = entry(marker);
  if (existingMarker === undefined) {
    // A database without its binding cannot be attributed to this Authority.
    if (entry(databasePath) !== undefined) sidecarFailure();
    writeFileSync(marker, `${JSON.stringify(binding)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(marker, 0o600);
  } else if (!exactBinding(privateJson(marker), binding)) sidecarFailure();
  ownedPrivateFile(databasePath);
  let closed = false;
  const database = new Database(databasePath);
  return Object.freeze({ database, close() { if (!closed) { closed = true; database.close(); } } });
}
function bearer(request: ProviderHttpRequestV1): string {
  const value = request.headers.authorization;
  if (value === undefined || !value.startsWith('Bearer ') || value.length === 7) unauthorized();
  return value.slice(7);
}
function requestBody(request: ProviderHttpRequestV1, protocol: ReturnType<typeof stagingConnectorRehearsalProtocol>): StagingConnectorRehearsalRequest {
  if (request.content_type === undefined || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.content_type)) invalid();
  try { return protocol.validate_request(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.raw_body))); }
  catch { invalid(); }
}
function response(value: unknown, protocol: ReturnType<typeof stagingConnectorRehearsalProtocol>): StagingConnectorRehearsalResponse {
  try { return protocol.validate_response(value); }
  catch { unavailable(); }
}
function requireSelection(config: OrganizationAuthorityServiceConfig, selection: StagingConnectorRehearsalSelection, dependencies: StagingConnectorRehearsalRuntimeDependenciesV1): { readonly profile: StagingConnectorRehearsalProfile; readonly profile_sha256: `sha256:${string}` } {
  const profile = validateStagingConnectorRehearsalProfile(selection.profile);
  const protocol = stagingConnectorRehearsalProtocol(profile);
  // Reuse the closed request validation for canonical release syntax.
  protocol.validate_request({ schema_version: protocol.schema_version, release_id: selection.release_id, profile_sha256: canonicalSha256(profile), action: 'status' });
  validateOrganizationAuthorityOrigin(config.authority_url);
  const authority = new URL(config.authority_url);
  if (config.authority_url !== STAGING_AUTHORITY_ORIGIN_V1 || selection.authority_host !== authority.host ||
      selection.authority_host !== 'authority-staging.echobrain.org' || (config.slack_nango.base_url !== undefined && config.slack_nango.base_url !== 'https://api.nango.dev') ||
      (config.scheduling !== undefined && config.scheduling !== 'periodic') || config.jira_person_live !== undefined ||
      config.staging_synthetic_meetings_directory !== undefined || config.staging_synthetic_owner_email !== undefined ||
      dependencies.api?.ticket_live_runtime_factory !== undefined || dependencies.api?.person_http_runtime_factory !== undefined ||
      dependencies.person_http_runtime_factory_with_slack !== undefined || config.slack_public_channel_context !== undefined) {
    throw new Error('Staging connector rehearsal selection is invalid');
  }
  return Object.freeze({ profile, profile_sha256: canonicalSha256(profile) });
}

/** V2 never migrates V1 custody: it anchors the untouched V1 profile and marker first. */
export function requireStagingConnectorV1PredecessorV2(input: {
  readonly state_directory: string;
  readonly profile: StagingConnectorRehearsalProfileV2;
  readonly authority_id: string;
  readonly state_lineage_id: string;
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
}): void {
  const parent = dirname(input.state_directory);
  assertNoSymlinkAncestor(input.state_directory);
  assertNoSymlinkAncestor(join(parent, 'private'));
  assertNoSymlinkAncestor(join(parent, SIDECAR_DIRECTORY));
  const predecessor = validateStagingConnectorRehearsalProfileV1(privateJson(join(parent, 'private', 'staging-connector-rehearsal.json')));
  if (canonicalSha256(predecessor) !== input.profile.predecessor_profile_sha256 || predecessor.jira.cloud_id !== input.profile.jira.cloud_id || predecessor.jira.integration_key !== input.profile.jira.integration_key) throw new Error('Staging connector rehearsal predecessor is invalid');
  const marker = privateJson(join(parent, 'staging-connector-rehearsal-v1', 'binding.json'));
  const expected = { schema_version: 1, kind: 'echo-staging-connector-rehearsal-sidecar-binding-v1', authority_id: input.authority_id,
    organization_id: input.organization_id, state_lineage_id: input.state_lineage_id, principal_id: input.principal_id,
    membership_id: input.membership_id, profile_sha256: input.profile.predecessor_profile_sha256 };
  if (Object.keys(marker).sort().join(',') !== Object.keys(expected).sort().join(',') ||
      Object.entries(expected).some(([key, value]) => marker[key] !== value)) throw new Error('Staging connector rehearsal predecessor is invalid');
  const database = lstatSync(join(parent, 'staging-connector-rehearsal-v1', 'jira-person-connections.sqlite'));
  if (!database.isFile() || database.isSymbolicLink() || database.uid !== process.getuid?.() || (database.mode & 0o777) !== 0o600 || database.nlink !== 1) throw new Error('Staging connector rehearsal sidecar is invalid');
}


/**
 * Staging-only, owner-bound capture surface. It composes existing provider
 * clients but does not select normal Jira evidence or the Jira Ask path.
 */
export async function openStagingConnectorRehearsalService(
  config: OrganizationAuthorityServiceConfig,
  selection: StagingConnectorRehearsalSelection,
  dependencies: StagingConnectorRehearsalRuntimeDependenciesV1 = {},
): Promise<OpenedOrganizationAuthorityRuntime> {
  const selected = requireSelection(config, selection, dependencies);
  const protocol = stagingConnectorRehearsalProtocol(selected.profile);
  const manifest = readOrganizationAuthoritySetupManifest(config.state_directory);
  const lineage = verifyAuthorityStateLineage(config.state_directory).root;
  const owner: OwnerV1 = Object.freeze({
    organization_id: manifest.organization_id,
    principal_id: manifest.owner_principal_id,
    membership_id: manifest.owner_membership_id,
  });
  if (manifest.authority_url !== config.authority_url || manifest.authority_id !== lineage.authority_id ||
      lineage.organization_id !== owner.organization_id || lineage.state_lineage_id !== manifest.state_lineage_id) throw new Error('Staging connector rehearsal Authority binding is invalid');
  if (config.granola_credential_file === undefined || config.granola_owner_email_file === undefined) {
    throw new Error('Staging connector rehearsal requires the committed Granola source');
  }
  if (selected.profile.schema_version === 2) {
    requireStagingConnectorV1PredecessorV2({ state_directory: config.state_directory, profile: selected.profile, authority_id: lineage.authority_id, state_lineage_id: lineage.state_lineage_id, ...owner });
  }
  const sidecar = openSidecar(config.state_directory, Object.freeze({
    schema_version: 1,
    kind: 'echo-staging-connector-rehearsal-sidecar-binding-v1',
    authority_id: lineage.authority_id,
    state_lineage_id: lineage.state_lineage_id,
    ...owner,
    profile_sha256: selected.profile.schema_version === 2 ? selected.profile.predecessor_profile_sha256 : selected.profile_sha256,
  }));
  let runtime: OpenedOrganizationAuthorityRuntime | undefined;
  let captures: OpenedConnectorRehearsalCaptureV1 | undefined;
  let jira: OpenedJiraPersonLiveRuntimeV1 | undefined;
  let fenceDatabase: Database.Database | undefined;
  let slack: ReturnType<typeof openSlackContextCaptureRuntimeV1> | undefined;
  try {
    const sourceBundle = createGranolaMeetingSourceBundleV1({
      granola_credential_file: config.granola_credential_file,
      granola_owner_email_file: config.granola_owner_email_file,
    });
    const processorBundle = createOpenRouterDecisionProcessorBundleV1({ credential_file: config.openrouter_credential_file });
    const authority = openAuthorityDatabase(join(config.state_directory, 'authority.sqlite'), { fileMustExist: true });
    let granola: Parameters<typeof openConnectorRehearsalCaptureV1>[0]['granola'];
    try {
      if (authority.prepare('SELECT 1 FROM authority_live_source_admission_v2 WHERE singleton=1').get() !== undefined) {
        const commitments = readAdmittedMeetingProcessingCommitmentsV1(authority);
        sourceBundle.assert_admission_commitments(commitments);
        processorBundle.assert_admission_commitments(commitments);
        const state = new SqliteAuthorityMeetingProcessingStateV1(authority, sourceBundle.source_cursor_policy, processorBundle.processor_adapter_id);
        const admission = await state.readAdmission();
        granola = Object.freeze({ source: sourceBundle.create_source(admission), source_cursor_policy: sourceBundle.source_cursor_policy, processor_adapter_id: processorBundle.processor_adapter_id });
      }
    } finally { authority.close(); }
    fenceDatabase = openAuthorityDatabase(join(config.state_directory, 'authority.sqlite'), { fileMustExist: true });
    let authenticate: ((input: { readonly access_token: string }) => PersonAccessAuthorization) | undefined;
    const requireOwner = (access_token: string) => {
      const application = authenticate;
      if (application === undefined) unavailable();
      const authorization = application({ access_token });
      if (!isActiveInitialOwnerV1(fenceDatabase!, owner, authorization)) unavailable();
      return authorization;
    };
    let captureInFlight = false;
    const capturesApplication: ProviderHttpApplicationV1 = Object.freeze({
      routes: Object.freeze([{ route_id: 'staging-connector-rehearsal', method: 'POST' as const, path: STAGING_CONNECTOR_REHEARSAL_PATH_V1 }]),
      async accept(input: ProviderHttpRequestV1) {
        if (input.route_id !== 'staging-connector-rehearsal') invalid();
        const access_token = bearer(input);
        const request = requestBody(input, protocol);
        if (request.release_id !== selection.release_id || request.profile_sha256 !== selected.profile_sha256) unavailable();
        if (runtime === undefined) unavailable();
        if (request.action === 'status') {
          requireOwner(access_token);
          return Object.freeze({ status: 200 as const, body: response({ schema_version: protocol.schema_version, kind: protocol.receipt_kind, release_id: selection.release_id, profile_sha256: selected.profile_sha256, action: 'status', processing: runtime?.processing ?? 'idle_until_finalize', granola_available: runtime?.processing === 'active' && granola !== undefined, qualified: false }, protocol) });
        }
        if (captures === undefined || (request.tool === 'granola' && runtime.processing !== 'active')) unavailable();
        const before = requireOwner(access_token);
        if (input.signal?.aborted) unavailable();
        if (captureInFlight) unavailable();
        captureInFlight = true;
        try {
          const receipt = await captures.capture({ tool: request.tool, access_token, limit: request.limit, ...(input.signal === undefined ? {} : { signal: input.signal }) });
          input.signal?.throwIfAborted();
          const after = requireOwner(access_token);
          if (before.access_credential_sha256 !== after.access_credential_sha256 || before.person_state_sha256 !== after.person_state_sha256 || before.session_state_sha256 !== after.session_state_sha256) unavailable();
          return Object.freeze({ status: 200 as const, body: response({ schema_version: protocol.schema_version, kind: protocol.receipt_kind, release_id: selection.release_id, profile_sha256: selected.profile_sha256, action: 'capture', tool: request.tool, receipt, qualified: false }, protocol) });
        } catch (_error) { unavailable(); } finally { captureInFlight = false; }
      },
    });
    const personFactory = (sessions: Parameters<NonNullable<NonNullable<OrganizationAuthorityServiceDependencies['api']>['person_http_runtime_factory']>>[0], slackPorts?: SlackContextCaptureRuntimePortsV1) => {
      authenticate = input => sessions.authenticateAccess(input);
      jira = openJiraPersonLiveRuntimeV1({
        state_directory: config.state_directory,
        sessions: { authenticateAccess: input => requireOwner(input.access_token) },
        configuration: { enabled: true, cloud_id: selected.profile.jira.cloud_id, integration_id: selected.profile.jira.integration_key, nango_authorization: () => config.slack_nango.secret_key },
        seams: { ...dependencies.jira, database: sidecar.database },
      });
      if (selected.profile.schema_version === 2) {
        if (slackPorts === undefined) unavailable();
        slack = openSlackContextCaptureRuntimeV1({
          state_directory: config.state_directory, initial_owner: owner,
          channel_id: selected.profile.slack.channel_id, source_instance_id: 'staging-slack-context-v2',
          profile_sha256: selected.profile_sha256, capability: SLACK_PUBLIC_CHANNEL_CONTEXT_CAPABILITY_V1,
          authenticate_access: sessions,
          slack: slackPorts,
        });
      }
      captures = openConnectorRehearsalCaptureV1({
        state_directory: config.state_directory,
        initial_owner: owner,
        authenticate_access: sessions,
        exclusive: { run_exclusive: operation => runtime === undefined ? Promise.reject(new Error('Staging connector rehearsal is starting')) : runtime.runExclusive(operation) },
        ...(granola === undefined ? {} : { granola }),
        ...(slack === undefined ? {} : { slack }),
        jira: { connection: jira.application, project: selected.profile.jira.project, source_instance_id: 'staging-jira-context-v1', ...(selected.profile.schema_version === 2 ? { representation: 'pointer' as const, retention: 'retained_pointer' as const } : {}) },
      });
      const ownerJira: ProviderHttpApplicationV1 = Object.freeze({
        routes: jira.connection_http.routes,
        accept: (request: ProviderHttpRequestV1) => { requireOwner(bearer(request)); return jira!.connection_http.accept(request); },
      });
      return Object.freeze({ applications: Object.freeze([ownerJira, capturesApplication]), close() { captures?.close(); slack?.close(); jira?.close(); } });
    };
    runtime = await openOrganizationAuthorityService({
      ...config,
      ...(selected.profile.schema_version === 2 ? { slack_public_channel_context: SLACK_PUBLIC_CHANNEL_CONTEXT_CAPABILITY_V1 } : {}),
    }, {
      ...dependencies,
      ...(selected.profile.schema_version === 2 ? { person_http_runtime_factory_with_slack: personFactory } : {}),
      processing_adapter_overrides: granola === undefined ? dependencies.processing_adapter_overrides : {
        ...dependencies.processing_adapter_overrides,
        source: granola.source,
      },
      api: {
        ...dependencies.api,
        ...(selected.profile.schema_version === 1 ? { person_http_runtime_factory: personFactory } : {}),
      },
    });
    let closing: Promise<void> | undefined;
    return Object.freeze({
      ...runtime,
      close: () => closing ??= (async () => {
        try { await runtime!.close(); } finally {
          try { fenceDatabase?.close(); } finally { sidecar.close(); }
        }
      })(),
    });
  } catch (error) {
    try { captures?.close(); slack?.close(); jira?.close(); fenceDatabase?.close(); } finally { sidecar.close(); }
    throw error;
  }
}
