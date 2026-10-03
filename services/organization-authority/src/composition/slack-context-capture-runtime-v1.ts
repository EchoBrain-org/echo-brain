import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { openOrganizationControlDatabase } from '@echo-brain/organization-control-plane/persistence/open-organization-control-database';
import { createSlackContextSourceV1 } from '@echo-brain/provider-slack-server/context/slack-context-source-v1';
import { createSlackContextTransportV1 } from '@echo-brain/provider-slack-server/context/slack-context-transport-v1';
import { readSlackContextCurrentIdentityV1 } from '@echo-brain/provider-slack-server/context/slack-context-current-identity-v1';
import { isSlackIdentityTokenRejectedV1, type SlackIdentityProviderV1 } from '@echo-brain/provider-slack-server/organization-control-plane/adapters/slack/slack-web-identity-provider-v1';
import type { SlackBotTokenSourceV1 } from '@echo-brain/provider-slack-server/organization-control-plane/application/slack-bot-token-source-v1';
import type { SlackConnectionHealthV1 } from '@echo-brain/provider-slack-server/organization-control-plane/application/slack-connection-health-v1';
import { slackPrivateAppBotScopesV1, type SlackPublicChannelContextCapabilityV1 } from '@echo-brain/provider-slack-server/organization-control-plane/application/slack-integration-contracts';
import { assertSlackPublicChannelContextConnectionV1 } from '@echo-brain/provider-slack-server/organization-control-plane/application/slack-public-channel-context-capability-v1';
import { join } from 'node:path';
import { isActiveInitialOwnerV1, type ConnectorRehearsalAuthenticatorV1, type ConnectorRehearsalInitialOwnerV1, type ConnectorRehearsalSlackV1 } from './connector-rehearsal-capture-v1.js';
import { verifyOrganizationAuthorityApiLineage } from './organization-authority-api-runtime.js';

/** The same composed objects used by setup, person linking and approval delivery. */
export interface SlackContextCaptureRuntimePortsV1 {
  readonly bot_token_source: SlackBotTokenSourceV1;
  readonly connection_health: SlackConnectionHealthV1;
  readonly provider: Pick<SlackIdentityProviderV1, 'verifyConnection'>;
}

export interface OpenSlackContextCaptureRuntimeInputV1 {
  readonly state_directory: string;
  readonly initial_owner: ConnectorRehearsalInitialOwnerV1;
  readonly authenticate_access: ConnectorRehearsalAuthenticatorV1;
  /** Explicit Authority authorization, selected only by the validated V2 profile. */
  readonly profile_sha256: `sha256:${string}`;
  readonly capability: SlackPublicChannelContextCapabilityV1;
  readonly channel_id: string;
  readonly source_instance_id: string;
  readonly slack: SlackContextCaptureRuntimePortsV1;
  readonly fetch?: typeof fetch;
}

function unavailable(): Error { return new Error('Slack context capture is not available'); }

/** One manually requested, fixed public-channel capture. No schedules or message bodies. */
export function openSlackContextCaptureRuntimeV1(options: OpenSlackContextCaptureRuntimeInputV1): ConnectorRehearsalSlackV1 & { close(): void } {
  if (options.capability === undefined) throw unavailable();
  slackPrivateAppBotScopesV1(options.capability);
  const capability = Object.freeze({ ...options.capability });
  const owner = Object.freeze({ ...options.initial_owner });
  const { channel_id, source_instance_id, profile_sha256 } = options;
  if (!/^C[A-Z0-9]{2,63}$/.test(channel_id) || !/^sha256:[0-9a-f]{64}$/.test(profile_sha256) ||
      typeof source_instance_id !== 'string' || source_instance_id.trim() === '' || source_instance_id.length > 256) throw unavailable();
  const lineage = verifyOrganizationAuthorityApiLineage(options.state_directory).root;
  if (lineage.organization_id !== owner.organization_id) throw unavailable();
  const coordinates = Object.freeze({ authority_id: lineage.authority_id, organization_id: lineage.organization_id, state_lineage_id: lineage.state_lineage_id,
    principal_id: owner.principal_id, membership_id: owner.membership_id });
  const database = openAuthorityDatabase(join(options.state_directory, 'authority.sqlite'), { fileMustExist: true });
  let control: ReturnType<typeof openOrganizationControlDatabase>;
  try { control = openOrganizationControlDatabase(join(options.state_directory, 'integrations.sqlite'), { fileMustExist: true }); }
  catch (error) { database.close(); throw error; }
  const slack = Object.freeze({ ...options.slack });
  const authenticate = options.authenticate_access.authenticateAccess.bind(options.authenticate_access);
  const fetch = options.fetch ?? globalThis.fetch;
  let closed = false;
  const requireOwner = (access_token: string): void => {
    if (closed) throw unavailable();
    if (!isActiveInitialOwnerV1(database, owner, authenticate({ access_token }))) throw unavailable();
  };
  return Object.freeze({
    async create_source(input: { readonly access_token: string; readonly signal: AbortSignal }) {
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
      signal.throwIfAborted();
      requireOwner(input.access_token);
      const current = readSlackContextCurrentIdentityV1(control, coordinates);
      if (current === undefined) throw unavailable();
      const healthGeneration = slack.connection_health.generation();
      const requireCurrent = () => {
        signal.throwIfAborted();
        requireOwner(input.access_token);
        const latest = readSlackContextCurrentIdentityV1(control, coordinates);
        if (latest === undefined || latest.stored.contract_sha256 !== current.stored.contract_sha256 ||
            latest.stored.state_sha256 !== current.stored.state_sha256 || latest.identity_link_id !== current.identity_link_id ||
            latest.identity_link_sha256 !== current.identity_link_sha256 || latest.human_user_id !== current.human_user_id ||
            slack.connection_health.generation() !== healthGeneration || slack.connection_health.needsReinstall(current.stored.state_sha256)) throw unavailable();
      };
      requireCurrent();
      // The optional scope upgrade deliberately keeps the old approval state hash.
      // Bypass that state's five-minute token cache for every explicit capture.
      const token = await slack.bot_token_source.botToken(current.stored, { force_refresh: true });
      requireCurrent();
      try {
        const verified = await slack.provider.verifyConnection(token, signal);
        requireCurrent();
        assertSlackPublicChannelContextConnectionV1({ connection: current.stored.connection, verified });
      } catch (error) {
        if (isSlackIdentityTokenRejectedV1(error)) slack.connection_health.markNeedsReinstall(current.stored.state_sha256, healthGeneration);
        signal.throwIfAborted();
        throw unavailable();
      }
      const binding: PersonConnectorReadBindingV1 = Object.freeze({
        organization_id: owner.organization_id, principal_id: owner.principal_id, membership_id: owner.membership_id,
        tool_id: 'slack', external_scope_id: current.stored.connection.provider_tenant_id, external_subject_id: current.human_user_id,
        // This commits to explicit Authority profile policy, not to identity-link possession.
        read_grant_sha256: canonicalSha256({ schema_version: 1, kind: 'echo-staging-slack-channel-read-authorization-v1',
          profile_sha256, capability, channel_id, source_instance_id, ...coordinates,
          connection_sha256: current.stored.contract_sha256, connection_state_sha256: current.stored.state_sha256,
          identity_link_sha256: current.identity_link_sha256 }),
      });
      const transport = createSlackContextTransportV1({ binding, async fetch(url, init) {
        requireCurrent();
        const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${token}`);
        const response = await fetch(url, { ...init, headers, signal: AbortSignal.any([signal, ...(init.signal == null ? [] : [init.signal])]) });
        try { requireCurrent(); } catch (error) { await response.body?.cancel(); throw error; }
        return response;
      } });
      const source = createSlackContextSourceV1({
        transport, read_grant_fence: { async requireCurrent({ binding: candidate, signal: caller }) {
          caller?.throwIfAborted();
          if (canonicalSha256(candidate) !== canonicalSha256(binding)) throw unavailable();
          requireCurrent();
        } },
        team_id: current.stored.connection.provider_tenant_id, channel_id,
        expected_bot_user_id: current.stored.connection.provider_bot_user_id,
        identity: { kind: 'source', adapter_id: 'slack-context-capture', instance_id: source_instance_id, version: '1.0.0' },
        representation: 'pointer', public_channel_only: true,
      });
      return Object.freeze({ source, source_instance_id, require_current: requireCurrent });
    },
    close() { if (!closed) { closed = true; control.close(); database.close(); } },
  });
}
