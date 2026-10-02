import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { validateOrganizationAuthorityOrigin } from '@echo-brain/organization-api';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import { readPrivateAuthorityCredential, readPrivateAuthorityOidcClientSecret } from '@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials';
import { verifyAuthorityStateLineage } from '@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { createGranolaMeetingSourceBundleV1 } from '@echo-brain/provider-granola/granola-meeting-source-bundle-v1';
import { createOpenRouterDecisionProcessorBundleV1 } from '@echo-brain/provider-openrouter/openrouter-decision-processor-bundle-v1';
import { readAdmittedMeetingProcessingCommitmentsV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-processing-commitments';
import { SqliteAuthorityMeetingProcessingStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1';
import { chmodSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { openOrganizationAuthorityService, type OrganizationAuthorityServiceDependencies } from './organization-authority-composition-root.js';
import { readOrganizationAuthoritySetupManifest, runOrganizationAuthoritySetupCli } from './organization-authority-setup-cli.js';
import { readPersonOidcConfiguration } from './organization-authority-person-administration-cli.js';
import { openJiraPersonLiveRuntimeV1, type OpenedJiraPersonLiveRuntimeV1 } from './jira-person-live-runtime-v1.js';
import { openConnectorRehearsalCaptureV1 } from './connector-rehearsal-capture-v1.js';
import { openConnectorRehearsalControlV1, requestConnectorRehearsalControlV1 } from './connector-rehearsal-control-v1.js';

/** Explicit disposable local profile. The deployable service CLI never selects it. */
export interface ConnectorRehearsalConfigurationV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-connector-rehearsal-config-v1';
  readonly authority_url: string;
  readonly organization_name: string;
  readonly owner_name: string;
  readonly owner_email: string;
  readonly oidc: { readonly config_file: string; readonly client_secret_file: string | null };
  readonly nango: { readonly secret_key_file: string; readonly slack_integration_key: string; readonly jira_integration_key: string };
  readonly jira: { readonly cloud_id: string; readonly project: string };
  readonly granola: { readonly credential_file: string; readonly owner_email_file: string };
  readonly openrouter: { readonly credential_file: string };
}

export interface ConnectorRehearsalInvocationV1 {
  readonly action: 'bootstrap' | 'credentials-install' | 'finalize' | 'serve' | 'capture' | 'cycle-once';
  readonly directory: string;
  readonly configuration: ConnectorRehearsalConfigurationV1;
  readonly argv?: readonly string[];
  /** Supplied in memory by the isolated Person client, never command-line arguments. */
  readonly access_token?: string;
}

const PROFILE = 'connector-rehearsal-v1';
const PORT = 39489;
const FILE_LIMIT = 64 * 1024;
function refuse(): never { throw new Error('Connector rehearsal prerequisites or state binding are invalid'); }
function entry(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    refuse();
  }
}
function privateDirectory(path: string): void {
  const value = lstatSync(path);
  if (!value.isDirectory() || realpathSync(path) !== path || value.uid !== process.getuid?.() || (value.mode & 0o777) !== 0o700) refuse();
}
function privateJson(path: string): Record<string, unknown> {
  const value = lstatSync(path);
  if (!value.isFile() || value.isSymbolicLink() || value.uid !== process.getuid?.() || (value.mode & 0o777) !== 0o600 || value.size > FILE_LIMIT) refuse();
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) refuse();
  return parsed as Record<string, unknown>;
}
function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}
function privateIpv4(host: string): boolean {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}
function assertRoot(input: Pick<ConnectorRehearsalInvocationV1, 'directory' | 'configuration'>): void {
  const root = input.directory;
  if (!isAbsolute(root) || resolve(root) !== root || root === '/') refuse();
  privateDirectory(root);
  for (const name of ['private', 'person', 'receipts']) privateDirectory(join(root, name));
  const marker = privateJson(join(root, '.echo-connector-rehearsal-v1.json'));
  if (marker.kind !== 'echo-connector-rehearsal-root-v1' || marker.schema_version !== 1 || marker.root !== root || marker.uid !== process.getuid?.()) refuse();
  const persisted = privateJson(join(root, 'connector-rehearsal.json'));
  if (canonicalSha256(persisted as never) !== canonicalSha256(input.configuration as never)) refuse();
  const config = input.configuration;
  if (config.schema_version !== 1 || config.kind !== 'echo-connector-rehearsal-config-v1') refuse();
  validateOrganizationAuthorityOrigin(config.authority_url);
  const url = new URL(config.authority_url);
  if (['authority-staging.echobrain.org', 'authority.echobrain.org', 'localhost', '[::1]'].includes(url.hostname) || privateIpv4(url.hostname)) refuse();
  const paths = [config.oidc.config_file, config.nango.secret_key_file, config.granola.credential_file, config.granola.owner_email_file, config.openrouter.credential_file];
  if (config.oidc.client_secret_file !== null) paths.push(config.oidc.client_secret_file);
  for (const path of paths) {
    if (typeof path !== 'string' || resolve(path) !== path || dirname(path) !== join(root, 'private')) refuse();
    if (entry(path)?.isSymbolicLink()) refuse();
  }
  const state = entry(join(root, 'state'));
  if (state !== undefined) privateDirectory(join(root, 'state'));
}

/** Holds the local operation/serve lane; no competing bootstrap/finalize can run. */
function operationLock(root: string): () => void {
  const path = join(root, 'operation.lock.json');
  if (entry(path) !== undefined) throw new Error('Connector rehearsal has an active or unfinished operation');
  writePrivateJson(path, { schema_version: 1, kind: 'echo-connector-rehearsal-lock-v1', pid: process.pid });
  const owned = lstatSync(path);
  return () => {
    const current = entry(path);
    if (current?.ino === owned.ino && current.dev === owned.dev) unlinkSync(path);
  };
}
function setupCommitment(config: ConnectorRehearsalConfigurationV1): string {
  privateJson(config.oidc.config_file);
  const oidc = readPersonOidcConfiguration(config.oidc.config_file);
  return canonicalSha256({ authority_url: config.authority_url, organization_name: config.organization_name,
    owner_name: config.owner_name, owner_email: config.owner_email, oidc: oidc as never });
}
function binding(input: Pick<ConnectorRehearsalInvocationV1, 'directory' | 'configuration'>) {
  const state = join(input.directory, 'state');
  const manifest = readOrganizationAuthoritySetupManifest(state);
  const lineage = verifyAuthorityStateLineage(state).root;
  if (manifest.artifact_revision !== PROFILE || manifest.authority_url !== input.configuration.authority_url ||
      manifest.oidc_config_path !== input.configuration.oidc.config_file || manifest.organization_name !== input.configuration.organization_name ||
      manifest.owner_email !== input.configuration.owner_email || manifest.owner_display_name !== input.configuration.owner_name ||
      manifest.authority_id !== lineage.authority_id || manifest.organization_id !== lineage.organization_id ||
      manifest.state_lineage_id !== lineage.state_lineage_id) refuse();
  const expected = { schema_version: 1, kind: 'echo-connector-rehearsal-authority-binding-v1',
    setup_sha256: setupCommitment(input.configuration), authority_id: lineage.authority_id,
    organization_id: lineage.organization_id, state_lineage_id: lineage.state_lineage_id,
    owner_principal_id: manifest.owner_principal_id, owner_membership_id: manifest.owner_membership_id };
  return { manifest, expected };
}
function requireBound(input: Pick<ConnectorRehearsalInvocationV1, 'directory' | 'configuration'>) {
  assertRoot(input);
  const result = binding(input);
  const saved = privateJson(join(input.directory, 'authority-binding.json'));
  if (canonicalSha256(saved as never) !== canonicalSha256(result.expected)) refuse();
  return result.manifest;
}
async function setup(argv: readonly string[]): Promise<void> {
  // Existing setup output can carry private handoff paths. Only our receipt is printable.
  const code = await runOrganizationAuthoritySetupCli(argv, { stdout: () => {}, stderr: () => {} });
  if (code !== 0) throw new Error('Connector rehearsal setup failed; check setup prerequisites');
}
function receipt(action: string, status: string) {
  return { schema_version: 1, kind: 'echo-connector-rehearsal-operation-v1', action, status, qualified: false };
}

export async function bootstrapConnectorRehearsalV1(input: Pick<ConnectorRehearsalInvocationV1, 'directory' | 'configuration'>): Promise<void> {
  assertRoot(input);
  const unlock = operationLock(input.directory);
  try {
    const config = input.configuration;
    const planPath = join(input.directory, 'bootstrap-plan.json');
    const plan = { schema_version: 1, kind: 'echo-connector-rehearsal-bootstrap-v1', setup_sha256: setupCommitment(config) };
    if (entry(planPath) === undefined) {
      if (entry(join(input.directory, 'state')) !== undefined) refuse();
      writePrivateJson(planPath, plan);
    } else if (canonicalSha256(privateJson(planPath) as never) !== canonicalSha256(plan)) refuse();
    await setup(['bootstrap', '--state-dir', join(input.directory, 'state'), '--organization-name', config.organization_name,
      '--owner-display-name', config.owner_name, '--owner-email', config.owner_email,
      '--authority-url', config.authority_url, '--oidc-config', config.oidc.config_file, '--artifact-revision', PROFILE]);
    const { expected } = binding(input);
    const bindingPath = join(input.directory, 'authority-binding.json');
    if (entry(bindingPath) === undefined) writePrivateJson(bindingPath, expected);
    else if (canonicalSha256(privateJson(bindingPath) as never) !== canonicalSha256(expected)) refuse();
  } finally { unlock(); }
}

/** Test seams supply fake provider network only; production uses the concrete adapters. */
export interface ConnectorRehearsalRuntimeDependenciesV1 {
  readonly service?: OrganizationAuthorityServiceDependencies;
  readonly port?: number;
}

export async function openConnectorRehearsalRuntimeV1(
  input: Pick<ConnectorRehearsalInvocationV1, 'directory' | 'configuration'>,
  dependencies: ConnectorRehearsalRuntimeDependenciesV1 = {},
) {
  const manifest = requireBound(input);
  const unlock = operationLock(input.directory);
  let runtime: Awaited<ReturnType<typeof openOrganizationAuthorityService>> | undefined;
  let captures: ReturnType<typeof openConnectorRehearsalCaptureV1> | undefined;
  let control: Awaited<ReturnType<typeof openConnectorRehearsalControlV1>> | undefined;
  try {
    const config = input.configuration;
    const oidc = readPersonOidcConfiguration(config.oidc.config_file);
    if ((oidc.client_authentication === 'none') !== (config.oidc.client_secret_file === null)) refuse();
    const nangoKey = readPrivateAuthorityCredential(`file:${config.nango.secret_key_file}`);
    const sourceBundle = createGranolaMeetingSourceBundleV1({ granola_credential_file: manifest.granola_credential_file, granola_owner_email_file: manifest.granola_owner_email_file });
    const processorBundle = createOpenRouterDecisionProcessorBundleV1({ credential_file: manifest.llm_credential_file });
    const database = openAuthorityDatabase(join(manifest.state_directory, 'authority.sqlite'), { fileMustExist: true });
    let granola: NonNullable<Parameters<typeof openConnectorRehearsalCaptureV1>[0]['granola']> | undefined;
    try {
      if (database.prepare('SELECT 1 FROM authority_live_source_admission_v2 WHERE singleton = 1').get() !== undefined) {
        const commitments = readAdmittedMeetingProcessingCommitmentsV1(database);
        sourceBundle.assert_admission_commitments(commitments);
        processorBundle.assert_admission_commitments(commitments);
        const sourceState = new SqliteAuthorityMeetingProcessingStateV1(database, sourceBundle.source_cursor_policy, processorBundle.processor_adapter_id);
        const admission = await sourceState.readAdmission();
        granola = { source: sourceBundle.create_source(admission), source_cursor_policy: sourceBundle.source_cursor_policy, processor_adapter_id: processorBundle.processor_adapter_id };
      }
    } finally { database.close(); }
    let jira: OpenedJiraPersonLiveRuntimeV1 | undefined;
    let authenticate: ((input: { access_token: string }) => PersonAccessAuthorization) | undefined;
    runtime = await openOrganizationAuthorityService({
      state_directory: manifest.state_directory, authority_url: config.authority_url, host: '127.0.0.1', port: dependencies.port ?? PORT,
      scheduling: 'manual', oidc: oidc.configuration, pkce_key_file: manifest.pkce_key_file,
      client_authentication: oidc.client_authentication === 'none' ? { method: 'none' } : {
        method: oidc.client_authentication, client_secret: readPrivateAuthorityOidcClientSecret(`file:${config.oidc.client_secret_file!}`),
      },
      slack_nango: { secret_key: nangoKey, integration_key: config.nango.slack_integration_key },
      granola_credential_file: manifest.granola_credential_file, granola_owner_email_file: manifest.granola_owner_email_file,
      openrouter_credential_file: manifest.llm_credential_file,
      // The ordinary production CLI/gate remains unchanged. Only this isolated profile selects Jira.
      on_worker_error: () => process.stderr.write(`${JSON.stringify(receipt('worker', 'failed'))}\n`),
    }, {
      ...dependencies.service,
      ...(granola === undefined ? {} : { processing_adapter_overrides: { ...dependencies.service?.processing_adapter_overrides, source: granola.source } }),
      api: { ...dependencies.service?.api, ticket_live_runtime_factory: sessions => {
        authenticate = request => sessions.authenticateAccess(request);
        jira = openJiraPersonLiveRuntimeV1({ state_directory: manifest.state_directory, sessions,
          configuration: { enabled: true, cloud_id: config.jira.cloud_id, integration_id: config.nango.jira_integration_key, nango_authorization: () => nangoKey },
          ...(dependencies.service?.jira_person_live_seams === undefined ? {} : { seams: dependencies.service.jira_person_live_seams }),
        });
        return jira;
      } },
    });
    if (authenticate === undefined || jira === undefined) refuse();
    const authenticateOwner = (request: { access_token: string }) => {
      const actor = authenticate!(request);
      if (actor.organization_id !== manifest.organization_id || actor.principal_id !== manifest.owner_principal_id ||
          actor.membership_id !== manifest.owner_membership_id || actor.membership_type !== 'owner') refuse();
      return actor;
    };
    const opened = runtime;
    captures = openConnectorRehearsalCaptureV1({
      state_directory: manifest.state_directory,
      initial_owner: { organization_id: manifest.organization_id, principal_id: manifest.owner_principal_id, membership_id: manifest.owner_membership_id },
      authenticate_access: { authenticateAccess: authenticateOwner }, exclusive: { run_exclusive: operation => opened.runExclusive(operation) },
      ...(granola === undefined ? {} : { granola }),
      jira: { connection: jira.application, project: config.jira.project, source_instance_id: 'local-jira-context-v1' },
    });
    const captureApplication = captures;
    control = await openConnectorRehearsalControlV1({ socket_path: join(input.directory, 'control.sock'), handle: async (raw, signal) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) refuse();
      const request = raw as Record<string, unknown>;
      if (typeof request.access_token !== 'string' || request.access_token.length > 16 * 1024) refuse();
      const actor = authenticateOwner({ access_token: request.access_token });
      if (request.action === 'capture' && Object.keys(request).sort().join(',') === 'access_token,action,limit,tool' &&
          (request.tool === 'jira' || request.tool === 'granola') && typeof request.limit === 'number') {
        return captureApplication.capture({ tool: request.tool, access_token: request.access_token, limit: request.limit, signal });
      }
      if (request.action === 'cycle-once' && Object.keys(request).sort().join(',') === 'access_token,action') {
        if (opened.processing !== 'active') refuse();
        await opened.runProcessingCycleOnce(signal);
        // Session/membership changes during the cycle prevent release of even the completion receipt.
        const current = authenticateOwner({ access_token: request.access_token });
        if (current.access_credential_sha256 !== actor.access_credential_sha256 || current.person_state_sha256 !== actor.person_state_sha256 || current.session_state_sha256 !== actor.session_state_sha256) refuse();
        return receipt('cycle-once', 'cycle_completed');
      }
      refuse();
    } });
    let closing: Promise<void> | undefined;
    return { address: opened.address, processing: opened.processing, close(): Promise<void> {
      return closing ??= (async () => { try { await control!.close(); } finally { try { captures!.close(); await opened.close(); } finally { unlock(); } } })();
    } };
  } catch (error) {
    try { await control?.close(); } finally {
      captures?.close();
      try { await runtime?.close(); } finally { unlock(); }
    }
    throw error;
  }
}

/** Called only by the repository's isolated local wrapper; no token is printed. */
export async function runConnectorRehearsalV1(input: ConnectorRehearsalInvocationV1): Promise<number> {
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (input.action === 'bootstrap') {
    await bootstrapConnectorRehearsalV1(input); print(receipt(input.action, 'bootstrapped')); return 0;
  }
  const manifest = requireBound(input);
  if (input.action === 'credentials-install' || input.action === 'finalize') {
    const unlock = operationLock(input.directory);
    try {
      await setup([input.action, '--state-dir', manifest.state_directory, ...(input.action === 'credentials-install' ? [
        '--granola-credential-file', input.configuration.granola.credential_file,
        '--granola-owner-email-file', input.configuration.granola.owner_email_file,
        '--llm-credential-file', input.configuration.openrouter.credential_file,
      ] : [])]);
      print(receipt(input.action, 'completed')); return 0;
    } finally { unlock(); }
  }
  if (input.action === 'serve') {
    let stop!: () => void;
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    let opened: Awaited<ReturnType<typeof openConnectorRehearsalRuntimeV1>> | undefined;
    try {
      opened = await openConnectorRehearsalRuntimeV1(input);
      print({ ...receipt('serve', 'listening'), host: '127.0.0.1', port: opened.address.port, processing: opened.processing });
      await stopped;
      return 0;
    } finally {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      await opened?.close();
    }
  }
  if (input.access_token === undefined || input.access_token.length === 0 || input.access_token.length > 16 * 1024) refuse();
  let request: unknown;
  if (input.action === 'capture') {
    const args = input.argv ?? [];
    if (args.length !== 4 || args[0] !== '--tool' || !['granola', 'jira'].includes(args[1]!) || args[2] !== '--limit' || !/^[1-5]$/.test(args[3]!)) refuse();
    request = { action: 'capture', tool: args[1], limit: Number(args[3]), access_token: input.access_token };
  } else if (input.action === 'cycle-once') request = { action: input.action, access_token: input.access_token };
  else refuse();
  const result = await requestConnectorRehearsalControlV1({ socket_path: join(input.directory, 'control.sock'), input: request, signal: AbortSignal.timeout(input.action === 'capture' ? 35_000 : 120_000) });
  print(result); return 0;
}
