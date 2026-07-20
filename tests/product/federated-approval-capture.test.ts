import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, JsonObject } from '../../src/core/index.js';
import type { ProductRuntimeConfig } from '../../src/product/config.js';
import type {
  DecisionNodeEvents,
  DecisionPublishedEvent,
  DecisionRequestedEvent,
  DecisionResolvedEvent,
} from '../../src/product/approval/decision-node.js';
import { renderSlackApprovalBlocks } from '../../src/adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import type { VerifiedActiveIdentityBundle } from '../../src/product/federation/active-identity-bundle-store.js';
import {
  FederatedApprovalCapture,
  type ApprovalAttributionProvider,
  type ApprovalIdentityLineageReader,
  type ProductArtifactEvidenceProvider,
} from '../../src/product/federation/approval-capture.js';
import { canonicalSha256 } from '../../src/product/federation/canonical-json.js';
import type {
  AdapterBindingV1,
  ProcessorAttributionV1,
  ProductArtifactIdentityV1,
  SourceAttributionV1,
  ToolConnectionGenerationV1,
  ToolConnectionV1,
} from '../../src/product/federation/contracts.js';
import type { ResolvedHistoricalBinding } from '../../src/product/federation/identity-lineage-store.js';

const NOW = '2026-07-19T20:30:00.000Z';
const SOURCE_SHA = '1'.repeat(40);
const ARTIFACT: ProductArtifactIdentityV1 = {
  product_version: '0.1.0-dev.6',
  source_sha: SOURCE_SHA,
  artifact_sha256: `sha256:${'a'.repeat(64)}`,
};
const HISTORICAL_ARTIFACT: ProductArtifactIdentityV1 = {
  product_version: '0.1.0-dev.5',
  source_sha: '2'.repeat(40),
  artifact_sha256: `sha256:${'b'.repeat(64)}`,
};
const IDS = {
  organization: 'org_00000000-0000-4000-8000-000000000001',
  principal: 'prn_00000000-0000-4000-8000-000000000002',
  membership: 'mem_00000000-0000-4000-8000-000000000003',
  installation: 'ins_00000000-0000-4000-8000-000000000004',
  device: 'dev_00000000-0000-4000-8000-000000000005',
  manifest: 'idm_00000000-0000-4000-8000-000000000006',
  registry: 'reg_00000000-0000-4000-8000-000000000007',
  policy: 'pol_00000000-0000-4000-8000-000000000008',
  claim: 'clm_00000000-0000-4000-8000-000000000009',
  sourceBinding: 'bnd_00000000-0000-4000-8000-000000000010',
  processorBinding: 'bnd_00000000-0000-4000-8000-000000000011',
  approvalBinding: 'bnd_00000000-0000-4000-8000-000000000012',
  reboundApprovalBinding: 'bnd_00000000-0000-4000-8000-000000000016',
  sourceConnection: 'con_00000000-0000-4000-8000-000000000013',
  slackConnection: 'con_00000000-0000-4000-8000-000000000014',
  observation: 'obs_00000000-0000-4000-8000-000000000015',
};

function runtime(): ProductRuntimeConfig {
  return {
    schema_version: 1,
    lane: 'team-product',
    state_dir: '/private/tmp/echo-federated-approval',
    meeting_sources: [
      {
        adapter_id: 'granola',
        instance_id: 'primary',
        credential_ref: 'file:/private/tmp/granola-token',
        settings: { page_size: 100 },
      },
    ],
    decision_processor: {
      adapter_id: 'structured-text',
      instance_id: 'primary',
      settings: { prompt_version: 'structured-text-v1' },
    },
    delivery_surfaces: [],
    approval_mode: 'adapter',
    approval_surface: {
      adapter_id: 'slack-reactions',
      instance_id: 'founder-approval',
      credential_ref: 'file:/private/tmp/slack-token',
      settings: {
        channel_id: 'C123',
        reviewer: { slack_user_id: 'U123', name: 'Founder' },
        approve_reaction: 'white_check_mark',
        reject_reaction: 'x',
      },
    },
  };
}

function request(): ApprovalRequest {
  return {
    processing_key: 'granola:primary:not-1:rev-1:structured-text:primary:1.0.0',
    requested_at: NOW,
    meeting: {
      schema_version: 1,
      id: 'granola:primary:not-1',
      title: 'Founder planning',
      time: { actual_start_at: '2026-07-19T19:00:00.000Z' },
      capture: { state: 'complete', components: [] },
      participants: [],
      content: [],
      artifacts: [],
      provenance: {
        source: {
          kind: 'meeting-source',
          adapter_id: 'granola',
          instance_id: 'primary',
          version: '2.2.0',
        },
        external_id: 'not-1',
        canonical_revision: 'rev-1',
        observed_at: NOW,
        normalizer_version: '1',
        source_updated_at: NOW,
      },
    },
    decisions: {
      schema_version: 1,
      meeting_id: 'granola:primary:not-1',
      meeting_revision: 'rev-1',
      processor: {
        kind: 'decision-processor',
        adapter_id: 'structured-text',
        instance_id: 'primary',
        version: '1.0.0',
      },
      generated_at: NOW,
      signals: [],
    },
    brief: {
      schema_version: 1,
      id: 'brief-1',
      meeting: {
        id: 'granola:primary:not-1',
        title: 'Founder planning',
        time: { actual_start_at: '2026-07-19T19:00:00.000Z' },
        participants: [],
      },
      decisions: [],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: 'rev-1',
        processor: {
          kind: 'decision-processor',
          adapter_id: 'structured-text',
          instance_id: 'primary',
          version: '1.0.0',
        },
        generated_at: NOW,
      },
    },
  };
}

function bundle(config = runtime()): VerifiedActiveIdentityBundle {
  const sourceSettings = config.meeting_sources[0]!.settings;
  const processorSettings = config.decision_processor.settings;
  const approvalSettings = config.approval_surface!.settings;
  const slackProvider = {
    tenant: { kind: 'slack-team', id: 'T123', enterprise_id: null },
    subject: {
      kind: 'bot-installation',
      id: 'U999BOT',
      bot_id: 'B999BOT',
      app_id: 'A999APP',
    },
    verification: {
      method: 'slack_auth_test' as const,
      assurance: 'provider_verified' as const,
      verified_at: NOW,
      evidence_sha256: `sha256:${'9'.repeat(64)}` as const,
    },
  };
  const manifest: VerifiedActiveIdentityBundle['manifest'] = {
    schema_version: 1,
    kind: 'echo-local-identity-manifest',
    manifest_id: IDS.manifest,
    predecessor_manifest_id: null,
    created_at: NOW,
    authority: {
      kind: 'local-founder-bootstrap',
      assurance: 'founder_attested',
    },
    organization: {
      organization_id: IDS.organization,
      display_name: 'Echo',
      created_at: NOW,
    },
    principal: {
      principal_id: IDS.principal,
      organization_id: IDS.organization,
      kind: 'human',
      display_name: 'Founder',
    },
    membership: {
      membership_id: IDS.membership,
      organization_id: IDS.organization,
      principal_id: IDS.principal,
      type: 'owner',
      status: 'active',
      valid_from: NOW,
    },
    installation: {
      installation_id: IDS.installation,
      organization_id: IDS.organization,
      membership_id: IDS.membership,
      device_id: IDS.device,
      device_class: 'byod',
      enrolled_at: NOW,
      product: {
        name: 'echo-brain',
        version: ARTIFACT.product_version,
        source_sha: ARTIFACT.source_sha,
      },
      signing_key: {
        key_id: `sha256:${'8'.repeat(64)}`,
        algorithm: 'ecdsa-p256-sha256-der-low-s',
        public_key_spki_der_base64: 'AQ==',
        protection: 'secure-enclave',
        assurance: 'hardware_bound',
      },
    },
    identity_claims: [
      {
        claim_id: IDS.claim,
        principal_id: IDS.principal,
        issuer: { kind: 'provider', provider: 'slack', tenant_id: 'T123' },
        subject: { kind: 'user', id: 'U123' },
        verification: {
          method: 'slack_dm_challenge',
          assurance: 'provider_challenge_observed',
          verified_at: NOW,
          evidence_sha256: `sha256:${'7'.repeat(64)}`,
          nonce_sha256: `sha256:${'6'.repeat(64)}`,
        },
      },
    ],
    legacy_cutover: {
      declared_at: NOW,
      pre_cutover_default: 'disposable_test',
      native_records_require: [
        'source-attribution-v1',
        'processor-attribution-v1',
        'approval-context-v1',
        'signed-outbox-v1',
      ],
    },
    integrity: {
      canonicalization: 'RFC8785',
      payload_sha256: `sha256:${'1'.repeat(64)}`,
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
      key_id: `sha256:${'8'.repeat(64)}`,
      signature_base64: 'AQ==',
    },
  };
  const registry: VerifiedActiveIdentityBundle['connectionRegistry'] = {
    schema_version: 1,
    kind: 'echo-local-connection-registry',
    registry_id: IDS.registry,
    identity_manifest_id: IDS.manifest,
    revision: 1,
    previous_registry_sha256: null,
    updated_at: NOW,
    connections: [
      {
        connection_id: IDS.sourceConnection,
        organization_id: IDS.organization,
        owner: { kind: 'membership', id: IDS.membership },
        provider: 'granola',
        generations: [
          {
            generation: 1,
            active_from: NOW,
            ended_at: null,
            provider_identity: {
              tenant: null,
              subject: null,
              verification: {
                method: 'provider_first_capture',
                assurance: 'credential_observed',
                verified_at: NOW,
                evidence_sha256: `sha256:${'2'.repeat(64)}`,
              },
            },
            local_credential_guard: {
              reference: 'file:/private/tmp/granola-token',
              algorithm: 'sha256-salted',
              salt_base64: 'AQ==',
              digest: `sha256:${'3'.repeat(64)}`,
              exportable: false,
            },
          },
        ],
      },
      {
        connection_id: IDS.slackConnection,
        organization_id: IDS.organization,
        owner: { kind: 'organization', id: IDS.organization },
        provider: 'slack',
        generations: [
          {
            generation: 1,
            active_from: NOW,
            ended_at: null,
            provider_identity: slackProvider,
            local_credential_guard: {
              reference: 'file:/private/tmp/slack-token',
              algorithm: 'sha256-salted',
              salt_base64: 'Ag==',
              digest: `sha256:${'4'.repeat(64)}`,
              exportable: false,
            },
          },
        ],
      },
    ],
    bindings: [
      {
        adapter_binding_id: IDS.sourceBinding,
        capability: 'meeting-source',
        adapter_id: 'granola',
        instance_id: 'primary',
        connection_id: IDS.sourceConnection,
        connection_generation: 1,
        configuration_snapshot: sourceSettings,
        configuration_sha256: canonicalSha256(sourceSettings),
        created_at: NOW,
        ended_at: null,
        status: 'active',
      },
      {
        adapter_binding_id: IDS.processorBinding,
        capability: 'decision-processor',
        adapter_id: 'structured-text',
        instance_id: 'primary',
        connection_id: null,
        connection_generation: null,
        configuration_snapshot: processorSettings,
        configuration_sha256: canonicalSha256(processorSettings),
        created_at: NOW,
        ended_at: null,
        status: 'active',
      },
      {
        adapter_binding_id: IDS.approvalBinding,
        capability: 'approval-surface',
        adapter_id: 'slack-reactions',
        instance_id: 'founder-approval',
        connection_id: IDS.slackConnection,
        connection_generation: 1,
        configuration_snapshot: approvalSettings,
        configuration_sha256: canonicalSha256(approvalSettings),
        created_at: NOW,
        ended_at: null,
        status: 'active',
      },
    ],
    integrity: {
      canonicalization: 'RFC8785',
      payload_sha256: `sha256:${'5'.repeat(64)}`,
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
      key_id: `sha256:${'8'.repeat(64)}`,
      signature_base64: 'AQ==',
    },
  };
  const policy: VerifiedActiveIdentityBundle['publicationPolicy'] = {
    schema_version: 1,
    kind: 'echo-publication-policy',
    policy_id: IDS.policy,
    organization_id: IDS.organization,
    identity_manifest_id: IDS.manifest,
    issued_by: {
      installation_id: IDS.installation,
      key_id: `sha256:${'8'.repeat(64)}`,
    },
    version: 1,
    effective_at: NOW,
    publication: {
      payload_scope:
        'approved-signal-with-meeting-context-brief-digest-and-bounded-evidence',
      audience: {
        scope: 'organization',
        subjects: [{ kind: 'organization', id: IDS.organization }],
      },
      sensitivity: 'internal',
      retention: { kind: 'indefinite' },
      raw_meeting_content: 'local-only',
      participant_observations: 'included-namespaced',
    },
    integrity: {
      canonicalization: 'RFC8785',
      payload_sha256: `sha256:${'6'.repeat(64)}`,
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
      key_id: `sha256:${'8'.repeat(64)}`,
      signature_base64: 'AQ==',
    },
  };
  return {
    pointer: {
      schema_version: 1,
      kind: 'echo-active-identity-bundle',
      manifest: {
        path: 'manifests/manifest.json',
        sha256: `sha256:${'1'.repeat(64)}`,
        manifest_id: IDS.manifest,
      },
      connection_registry: {
        path: 'registries/registry.json',
        sha256: `sha256:${'5'.repeat(64)}`,
        registry_id: IDS.registry,
        revision: 1,
      },
      default_publication_policy: {
        path: 'policies/policy.json',
        sha256: `sha256:${'6'.repeat(64)}`,
        policy_id: IDS.policy,
        version: 1,
      },
      active_installation_id: IDS.installation,
      activated_at: NOW,
      activation_reason: 'founder-bootstrap',
      integrity: {
        canonicalization: 'RFC8785',
        payload_sha256: `sha256:${'0'.repeat(64)}`,
        signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
        key_id: `sha256:${'8'.repeat(64)}`,
        signature_base64: 'AQ==',
      },
    },
    manifest,
    connectionRegistry: registry,
    publicationPolicy: policy,
    canonical: {
      pointer: '{}',
      manifest: '{}',
      connectionRegistry: '{}',
      publicationPolicy: '{}',
    },
  };
}

function attributions(input = request()): {
  source: SourceAttributionV1;
  processor: ProcessorAttributionV1;
} {
  const config = runtime();
  const sourceSettings = config.meeting_sources[0]!.settings;
  const processorSettings = config.decision_processor.settings;
  return {
    source: {
      schema_version: 1,
      kind: 'echo-source-attribution',
      source_observation_id: IDS.observation,
      organization_id: IDS.organization,
      identity_manifest_id: IDS.manifest,
      source: {
        adapter_binding_id: IDS.sourceBinding,
        adapter: input.meeting.provenance.source,
        configuration_snapshot: sourceSettings,
        configuration_sha256: canonicalSha256(sourceSettings),
      },
      connection: {
        connection_id: IDS.sourceConnection,
        generation: 1,
        owner: { kind: 'membership', id: IDS.membership },
        provider: 'granola',
        provider_identity: {
          tenant: null,
          subject: null,
          verification_method: 'provider_first_capture',
          assurance: 'credential_observed',
        },
      },
      meeting: {
        external_id: 'not-1',
        canonical_revision: 'rev-1',
        document_sha256: canonicalSha256(input.meeting),
      },
      participant_observations: [],
      captured_by: ARTIFACT,
      captured_at: NOW,
    },
    processor: {
      schema_version: 1,
      kind: 'echo-processor-attribution',
      identity_manifest_id: IDS.manifest,
      meeting: {
        source_adapter_id: 'granola',
        source_instance_id: 'primary',
        external_id: 'not-1',
        meeting_revision: 'rev-1',
      },
      processor: {
        adapter_binding_id: IDS.processorBinding,
        adapter: input.decisions.processor,
        configuration_snapshot: processorSettings,
        configuration_sha256: canonicalSha256(processorSettings),
        decision_set_sha256: canonicalSha256(input.decisions),
      },
      produced_by: ARTIFACT,
      captured_at: NOW,
    },
  };
}

function lifecycleContains(
  observedAt: string,
  startedAt: string,
  endedAt: string | null,
): boolean {
  return observedAt >= startedAt && (endedAt === null || observedAt < endedAt);
}

function lineageReader(
  historical: VerifiedActiveIdentityBundle,
): ApprovalIdentityLineageReader {
  const revision = {
    registry: historical.connectionRegistry,
    canonical: historical.canonical.connectionRegistry,
    sha256: historical.pointer.connection_registry.sha256,
  };
  const chain = {
    registry_id: historical.connectionRegistry.registry_id,
    identity_manifest_id: historical.manifest.manifest_id,
    revisions: [revision],
  };

  function resolveBinding(
    locator: {
      identity_manifest_id: string;
      adapter_binding_id: string;
      configuration_sha256: string;
      connection_id: string | null;
      connection_generation: number | null;
    },
    observedAt: string,
  ): ResolvedHistoricalBinding {
    if (locator.identity_manifest_id !== historical.manifest.manifest_id) {
      throw new Error('test lineage: unknown identity manifest');
    }
    const binding = historical.connectionRegistry.bindings.find(
      (item) => item.adapter_binding_id === locator.adapter_binding_id,
    );
    if (
      binding === undefined ||
      binding.configuration_sha256 !== locator.configuration_sha256 ||
      binding.connection_id !== locator.connection_id ||
      binding.connection_generation !== locator.connection_generation ||
      !lifecycleContains(observedAt, binding.created_at, binding.ended_at)
    ) {
      throw new Error('test lineage: binding snapshot does not resolve');
    }

    let connection: ToolConnectionV1 | null = null;
    let generation: ToolConnectionGenerationV1 | null = null;
    if (locator.connection_id !== null) {
      connection =
        historical.connectionRegistry.connections.find(
          (item) => item.connection_id === locator.connection_id,
        ) ?? null;
      generation =
        connection?.generations.find(
          (item) => item.generation === locator.connection_generation,
        ) ?? null;
      if (
        connection === null ||
        generation === null ||
        !lifecycleContains(
          observedAt,
          generation.active_from,
          generation.ended_at,
        )
      ) {
        throw new Error('test lineage: connection generation does not resolve');
      }
    }
    return {
      manifest: historical.manifest,
      chain,
      revision,
      binding,
      connection,
      generation,
    };
  }

  return {
    loadVerifiedManifest(manifestId) {
      if (manifestId !== historical.manifest.manifest_id) {
        throw new Error('test lineage: unknown identity manifest');
      }
      return {
        manifest: historical.manifest,
        canonical: historical.canonical.manifest,
        sha256: historical.pointer.manifest.sha256,
      };
    },
    loadVerifiedPolicy(reference, observedAt) {
      const policy = historical.publicationPolicy;
      const expected = {
        policy_id: policy.policy_id,
        version: policy.version,
        policy_sha256: historical.pointer.default_publication_policy.sha256,
        identity_manifest_id: policy.identity_manifest_id,
        signer_installation_id: policy.issued_by.installation_id,
        signer_key_id: policy.issued_by.key_id,
      };
      if (
        canonicalSha256(reference) !== canonicalSha256(expected) ||
        observedAt < policy.effective_at
      ) {
        throw new Error('test lineage: publication policy does not resolve');
      }
      return {
        policy,
        manifest: historical.manifest,
        canonical: historical.canonical.publicationPolicy,
        sha256: historical.pointer.default_publication_policy.sha256,
      };
    },
    resolveBindingAt(reference, observedAt) {
      const resolved = resolveBinding(reference, observedAt);
      const binding: AdapterBindingV1 = resolved.binding;
      if (
        binding.capability !== reference.capability ||
        binding.adapter_id !== reference.adapter_id ||
        binding.instance_id !== reference.instance_id ||
        canonicalSha256(binding.configuration_snapshot) !==
          canonicalSha256(reference.configuration_snapshot)
      ) {
        throw new Error('test lineage: binding facts do not resolve exactly');
      }
      return resolved;
    },
    resolveBindingSnapshotAt(locator, observedAt) {
      return resolveBinding(locator, observedAt);
    },
  };
}

function activeCapture(
  overrides: {
    provider?: ApprovalAttributionProvider | undefined;
    artifactProvider?: ProductArtifactEvidenceProvider | undefined;
    activeBundle?: VerifiedActiveIdentityBundle;
    historicalBundle?: VerifiedActiveIdentityBundle;
  } = {},
): FederatedApprovalCapture {
  const config = runtime();
  const activeIdentity = overrides.activeBundle ?? bundle(config);
  const historicalIdentity = overrides.historicalBundle ?? activeIdentity;
  const artifactProvider =
    'artifactProvider' in overrides
      ? overrides.artifactProvider
      : {
          current: () => ARTIFACT,
          verify: (value: ProductArtifactIdentityV1) => {
            if (canonicalSha256(value) !== canonicalSha256(ARTIFACT)) {
              throw new Error('artifact is not trusted');
            }
          },
        };
  return new FederatedApprovalCapture({
    stateDirectory: config.state_dir,
    runtimeConfig: config,
    attributionProvider:
      'provider' in overrides
        ? overrides.provider
        : {
            getAttributions: async (input) => attributions(input),
            getAttributionsForMetadata: async () => attributions(),
          },
    ...(artifactProvider === undefined ? {} : { artifactProvider }),
    identityLineageReader: lineageReader(historicalIdentity),
    identityBundleReader: {
      hasActiveBundle: () => true,
      hasIdentityMaterial: () => true,
      loadVerified: vi.fn(() => activeIdentity),
    },
  });
}

function requestedEvent(metadata: JsonObject): DecisionRequestedEvent {
  const input = request();
  return {
    schema_version: 1,
    event_type: 'requested',
    node_id: 'node-1',
    processing_key: input.processing_key,
    requested_at: input.requested_at,
    brief: input.brief,
    alternatives: [],
    links: { parent: null, supersedes: null },
    metadata,
  };
}

function nodeEvents(requested: DecisionRequestedEvent): DecisionNodeEvents {
  return {
    approval_id: 'f'.repeat(64),
    requested,
    published: [],
  };
}

const LIVE_SLACK = {
  provider: 'slack' as const,
  team_id: 'T123',
  enterprise_id: null,
  bot_user_id: 'U999BOT',
  bot_id: 'B999BOT',
  app_id: 'A999APP',
};

function renderedBlocks(event: DecisionRequestedEvent) {
  return renderSlackApprovalBlocks({
    brief: event.brief,
    approvalId: 'f'.repeat(64),
    requestedMetadata: event.metadata,
    approveReaction: 'white_check_mark',
    rejectReaction: 'x',
  });
}

describe('federated approval capture', () => {
  it('preserves the exact legacy path while identity is inactive', async () => {
    const provider = {
      getAttributions: vi.fn(),
      getAttributionsForMetadata: vi.fn(),
    };
    const capture = new FederatedApprovalCapture({
      stateDirectory: '/private/tmp/inactive-echo',
      runtimeConfig: runtime(),
      attributionProvider: provider,
      identityBundleReader: {
        hasActiveBundle: () => false,
        hasIdentityMaterial: () => false,
        loadVerified: () => null,
      },
    });
    const reference = { channel_id: 'legacy-channel', message_ts: 'legacy-ts' };
    const metadata = { slack: { reviewer_user_id: 'legacy' } };

    expect(await capture.captureRequested(request())).toEqual({});
    expect(
      await capture.capturePublished({
        events: nodeEvents(requestedEvent({})),
        surface: 'slack',
        reference,
        postedAt: NOW,
      }),
    ).toBe(reference);
    expect(
      await capture.captureResolved({
        events: nodeEvents(requestedEvent({})),
        status: 'approved',
        reviewedAt: NOW,
        reviewedBy: 'legacy',
        reason: null,
        surface: 'cli',
        legacyMetadata: metadata,
      }),
    ).toBe(metadata);
    expect(provider.getAttributions).not.toHaveBeenCalled();
    expect(provider.getAttributionsForMetadata).not.toHaveBeenCalled();
  });

  it('fails partial identity material and active identity without attribution', async () => {
    const partial = new FederatedApprovalCapture({
      stateDirectory: '/private/tmp/partial-echo',
      runtimeConfig: runtime(),
      identityBundleReader: {
        hasActiveBundle: () => false,
        hasIdentityMaterial: () => true,
        loadVerified: () => null,
      },
    });
    await expect(partial.captureRequested(request())).rejects.toThrow(
      /identity material exists without a valid active identity bundle/,
    );
    await expect(
      activeCapture({ provider: undefined }).captureRequested(request()),
    ).rejects.toThrow(/attribution provider/);
  });

  it('refuses stored federation metadata when no active identity lineage remains', async () => {
    const active = activeCapture();
    const event = requestedEvent(await active.captureRequested(request()));
    const withoutIdentity = new FederatedApprovalCapture({
      stateDirectory: '/private/tmp/identity-removed-echo',
      runtimeConfig: runtime(),
      identityBundleReader: {
        hasActiveBundle: () => false,
        hasIdentityMaterial: () => false,
        loadVerified: () => null,
      },
    });

    await expect(withoutIdentity.validateRequested(event)).rejects.toThrow(
      /stored federated approval has no active identity lineage/,
    );
  });

  it('freezes and validates a domain-separated requested candidate', async () => {
    const capture = activeCapture();
    const metadata = await capture.captureRequested(request());
    const event = requestedEvent(metadata);
    await expect(
      capture.validateRequested(event, request()),
    ).resolves.toBeUndefined();

    const tampered = structuredClone(metadata);
    const federation = tampered['federation'] as JsonObject;
    federation['candidate_context_sha256'] = `sha256:${'0'.repeat(64)}`;
    await expect(
      capture.validateRequested(requestedEvent(tampered)),
    ).rejects.toThrow(/candidate context digest is invalid/);
  });

  it('durably rejects a configured Slack reviewer that is the bot itself', async () => {
    const historical = structuredClone(bundle(runtime()));
    const approvalBinding = historical.connectionRegistry.bindings.find(
      (item) => item.adapter_binding_id === IDS.approvalBinding,
    )!;
    approvalBinding.configuration_snapshot = {
      ...approvalBinding.configuration_snapshot,
      reviewer: { slack_user_id: 'U999BOT', name: 'Echo bot' },
    };
    approvalBinding.configuration_sha256 = canonicalSha256(
      approvalBinding.configuration_snapshot,
    );
    historical.pointer.connection_registry.sha256 = canonicalSha256(
      historical.connectionRegistry,
    );
    const unsafe = activeCapture({
      activeBundle: historical,
      historicalBundle: historical,
    });
    const event = requestedEvent(await unsafe.captureRequested(request()));

    await expect(
      activeCapture({
        activeBundle: bundle(runtime()),
        historicalBundle: historical,
      }).validateRequested(event),
    ).rejects.toThrow(/reviewer must be distinct from the bot identity/);
  });

  it('uses frozen identity history while requiring the current Slack publication candidate', async () => {
    const historical = bundle(runtime());
    const original = activeCapture({
      activeBundle: historical,
      historicalBundle: historical,
    });
    const requested = requestedEvent(
      await original.captureRequested(request()),
    );
    const events = nodeEvents(requested);
    const blocks = renderedBlocks(requested);

    const policyChanged = structuredClone(historical);
    policyChanged.publicationPolicy.version = 2;
    policyChanged.publicationPolicy.publication.sensitivity = 'confidential';
    policyChanged.pointer.default_publication_policy.version = 2;
    policyChanged.pointer.default_publication_policy.sha256 = canonicalSha256(
      policyChanged.publicationPolicy,
    );
    const afterPolicyChange = activeCapture({
      activeBundle: policyChanged,
      historicalBundle: historical,
    });

    await expect(
      afterPolicyChange.validateRequested(requested),
    ).resolves.toBeUndefined();
    await expect(
      afterPolicyChange.capturePublished({
        events,
        surface: 'slack',
        reference: { channel_id: 'C123', message_ts: '1752956990.000100' },
        presentationEvidence: {
          rendered_blocks_sha256: canonicalSha256(blocks),
          rendered_blocks: blocks,
          provider_identity: LIVE_SLACK,
        },
        postedAt: NOW,
      }),
    ).resolves.toHaveProperty('slack.channel_id', 'C123');

    const slackCandidateChanged = structuredClone(policyChanged);
    const approvalBinding =
      slackCandidateChanged.connectionRegistry.bindings.find(
        (item) => item.adapter_binding_id === IDS.approvalBinding,
      )!;
    approvalBinding.configuration_snapshot = {
      ...approvalBinding.configuration_snapshot,
      channel_id: 'C999',
    };
    approvalBinding.configuration_sha256 = canonicalSha256(
      approvalBinding.configuration_snapshot,
    );
    slackCandidateChanged.pointer.connection_registry.sha256 = canonicalSha256(
      slackCandidateChanged.connectionRegistry,
    );

    await expect(
      activeCapture({
        activeBundle: slackCandidateChanged,
        historicalBundle: historical,
      }).capturePublished({
        events,
        surface: 'slack',
        reference: { channel_id: 'C999', message_ts: '1752956990.000100' },
        presentationEvidence: {
          rendered_blocks_sha256: canonicalSha256(blocks),
          rendered_blocks: blocks,
          provider_identity: LIVE_SLACK,
        },
        postedAt: NOW,
      }),
    ).rejects.toThrow(/current approval binding and requested candidate/);
  });

  it('binds candidate attribution to the exact meeting, enrolled owner, and durable sidecars', async () => {
    const wrongDocument = attributions();
    wrongDocument.source.meeting.document_sha256 = `sha256:${'0'.repeat(64)}`;
    await expect(
      activeCapture({
        provider: {
          getAttributions: async () => wrongDocument,
          getAttributionsForMetadata: async () => wrongDocument,
        },
      }).captureRequested(request()),
    ).rejects.toThrow(/requested meeting revision/);

    const wrongOwner = attributions();
    wrongOwner.source.connection.owner = {
      kind: 'organization',
      id: IDS.organization,
    };
    await expect(
      activeCapture({
        provider: {
          getAttributions: async () => wrongOwner,
          getAttributionsForMetadata: async () => wrongOwner,
        },
      }).captureRequested(request()),
    ).rejects.toThrow(/connection snapshot is not enrolled/);

    const current = attributions();
    const provider: ApprovalAttributionProvider = {
      getAttributions: async () => attributions(),
      getAttributionsForMetadata: async () => current,
    };
    const capture = activeCapture({ provider });
    const event = requestedEvent(await capture.captureRequested(request()));
    current.processor.processor.decision_set_sha256 = `sha256:${'1'.repeat(64)}`;
    await expect(capture.validateRequested(event)).rejects.toThrow(
      /processor attribution reference does not resolve exactly/,
    );
  });

  it('rejects source and processor attributions captured after the approval request', async () => {
    for (const kind of ['source', 'processor'] as const) {
      const future = attributions();
      future[kind].captured_at = '2026-07-19T20:30:00.001Z';
      await expect(
        activeCapture({
          provider: {
            getAttributions: async () => future,
            getAttributionsForMetadata: async () => future,
          },
        }).captureRequested(request()),
      ).rejects.toThrow(
        new RegExp(`${kind} attribution does not describe the requested`),
      );
    }
  });

  it('accepts exact trusted historical artifacts and rejects invented build digests', async () => {
    const historical = attributions();
    historical.source.captured_by = HISTORICAL_ARTIFACT;
    historical.processor.produced_by = HISTORICAL_ARTIFACT;
    const trusted = new Set([
      canonicalSha256(ARTIFACT),
      canonicalSha256(HISTORICAL_ARTIFACT),
    ]);
    const capture = activeCapture({
      provider: {
        getAttributions: async () => historical,
        getAttributionsForMetadata: async () => historical,
      },
      artifactProvider: {
        current: () => ARTIFACT,
        verify: (value) => {
          if (!trusted.has(canonicalSha256(value))) {
            throw new Error('artifact is not trusted');
          }
        },
      },
    });
    await expect(capture.captureRequested(request())).resolves.toHaveProperty(
      'federation',
    );

    const invented = structuredClone(historical);
    invented.source.captured_by.artifact_sha256 = `sha256:${'c'.repeat(64)}`;
    await expect(
      activeCapture({
        provider: {
          getAttributions: async () => invented,
          getAttributionsForMetadata: async () => invented,
        },
      }).captureRequested(request()),
    ).rejects.toThrow(/artifact is not trusted/);
    await expect(
      activeCapture({ artifactProvider: undefined }).captureRequested(
        request(),
      ),
    ).rejects.toThrow(/trusted product artifact evidence/);
  });

  it('captures an exact Slack publication and rejects unknown fields', async () => {
    const capture = activeCapture();
    const requested = requestedEvent(await capture.captureRequested(request()));
    const events = nodeEvents(requested);
    const blocks = renderedBlocks(requested);
    const reference = await capture.capturePublished({
      events,
      surface: 'slack',
      reference: { channel_id: 'C123', message_ts: '1752956990.000100' },
      presentationEvidence: {
        rendered_blocks_sha256: canonicalSha256(blocks),
        rendered_blocks: blocks,
        provider_identity: LIVE_SLACK,
      },
      postedAt: NOW,
    });
    const published: DecisionPublishedEvent = {
      schema_version: 1,
      event_type: 'published',
      node_id: 'node-1',
      surface: 'slack',
      posted_at: NOW,
      reference,
    };
    await expect(
      capture.validatePublished({ events, event: published }),
    ).resolves.toBeUndefined();
    expect(
      (published.reference['federation'] as JsonObject)['rendered_blocks'],
    ).toEqual(blocks);

    const changedPresentation = structuredClone(published);
    const changedFederation = changedPresentation.reference[
      'federation'
    ] as JsonObject;
    changedFederation['rendered_blocks'] = [
      { type: 'section', text: { type: 'plain_text', text: 'Changed' } },
    ];
    await expect(
      capture.validatePublished({ events, event: changedPresentation }),
    ).rejects.toThrow(/rendered-block digest is invalid/);

    changedFederation['rendered_blocks_sha256'] = canonicalSha256(
      changedFederation['rendered_blocks'],
    );
    await expect(
      capture.validatePublished({ events, event: changedPresentation }),
    ).rejects.toThrow(/approval presentation does not match/);

    const tampered = structuredClone(published);
    (tampered.reference['federation'] as JsonObject)['extra'] = true;
    await expect(
      capture.validatePublished({ events, event: tampered }),
    ).rejects.toThrow(/unknown or missing keys/);

    await expect(
      capture.capturePublished({
        events,
        surface: 'slack',
        reference: { channel_id: 'C123', message_ts: '1752956990.0001' },
        presentationEvidence: {
          rendered_blocks_sha256: canonicalSha256(blocks),
          rendered_blocks: blocks,
          provider_identity: LIVE_SLACK,
        },
        postedAt: NOW,
      }),
    ).rejects.toThrow(/identifiers are malformed/);
  });

  it('rejects publication after resolution and impossible publication chronology', async () => {
    const capture = activeCapture();
    const requested = requestedEvent(await capture.captureRequested(request()));
    const events = nodeEvents(requested);
    const blocks = renderedBlocks(requested);
    const resolved: DecisionResolvedEvent = {
      schema_version: 1,
      event_type: 'resolved',
      node_id: 'node-1',
      status: 'approved',
      reviewed_at: '2026-07-19T20:30:00.500Z',
      reviewed_by: 'Founder',
      reason: null,
      surface: 'cli',
      metadata: {},
    };

    await expect(
      capture.capturePublished({
        events: { ...events, resolved },
        surface: 'slack',
        reference: { channel_id: 'C123', message_ts: '1752956990.000100' },
        presentationEvidence: {
          rendered_blocks_sha256: canonicalSha256(blocks),
          rendered_blocks: blocks,
          provider_identity: LIVE_SLACK,
        },
        postedAt: '2026-07-19T20:30:01.000Z',
      }),
    ).rejects.toThrow(/cannot publish after resolution/);

    const reference = await capture.capturePublished({
      events,
      surface: 'slack',
      reference: { channel_id: 'C123', message_ts: '1752956990.000100' },
      presentationEvidence: {
        rendered_blocks_sha256: canonicalSha256(blocks),
        rendered_blocks: blocks,
        provider_identity: LIVE_SLACK,
      },
      postedAt: '2026-07-19T20:30:01.000Z',
    });
    const published: DecisionPublishedEvent = {
      schema_version: 1,
      event_type: 'published',
      node_id: 'node-1',
      surface: 'slack',
      posted_at: '2026-07-19T20:30:01.000Z',
      reference,
    };
    await expect(
      capture.validatePublished({
        events: { ...events, published: [published], resolved },
        event: published,
      }),
    ).rejects.toThrow(/publication follows its resolution/);
  });

  it('resolves Slack actors only in the enrolled workspace namespace', async () => {
    const capture = activeCapture();
    const requested = requestedEvent(await capture.captureRequested(request()));
    const baseEvents = nodeEvents(requested);
    const blocks = renderedBlocks(requested);
    const publishedReference = await capture.capturePublished({
      events: baseEvents,
      surface: 'slack',
      reference: { channel_id: 'C123', message_ts: '1752956990.000100' },
      presentationEvidence: {
        rendered_blocks_sha256: canonicalSha256(blocks),
        rendered_blocks: blocks,
        provider_identity: LIVE_SLACK,
      },
      postedAt: NOW,
    });
    const published: DecisionPublishedEvent = {
      schema_version: 1,
      event_type: 'published',
      node_id: 'node-1',
      surface: 'slack',
      posted_at: NOW,
      reference: publishedReference,
    };
    const events = { ...baseEvents, published: [published] };
    const evidence = {
      provider_identity: LIVE_SLACK,
      actor: {
        team_id: 'T123',
        user_id: 'U123',
        display_name: 'Founder',
        reaction_name: 'white_check_mark',
        channel_id: 'C123',
        message_ts: '1752956990.000100',
        provider_occurred_at: null,
        reason_reply: {
          message_ts: '1752956991.000200',
          author_user_id: 'U123',
          text: '  Ship it  ',
        },
      },
    };
    const metadata = await capture.captureResolved({
      events,
      status: 'approved',
      reviewedAt: NOW,
      reviewedBy: 'Founder',
      reason: 'Ship it',
      surface: 'slack',
      legacyMetadata: {},
      resolutionEvidence: evidence,
    });
    const resolved: DecisionResolvedEvent = {
      schema_version: 1,
      event_type: 'resolved',
      node_id: 'node-1',
      status: 'approved',
      reviewed_at: NOW,
      reviewed_by: 'Founder',
      reason: 'Ship it',
      surface: 'slack',
      metadata,
    };
    await expect(
      capture.validateResolved({ events, event: resolved }),
    ).resolves.toBeUndefined();
    expect(
      ((metadata['federation'] as JsonObject)['actor'] as JsonObject)[
        'assurance'
      ],
    ).toBe('provider_challenge_observed');

    const wrongWorkspace = structuredClone(evidence);
    wrongWorkspace.actor.team_id = 'T999';
    await expect(
      capture.captureResolved({
        events,
        status: 'approved',
        reviewedAt: NOW,
        reviewedBy: 'Founder',
        reason: 'Ship it',
        surface: 'slack',
        legacyMetadata: {},
        resolutionEvidence: wrongWorkspace,
      }),
    ).rejects.toThrow(/does not match the resolution event|workspace-scoped/);

    const wrongReviewer = structuredClone(evidence);
    wrongReviewer.actor.user_id = 'U456';
    wrongReviewer.actor.reason_reply!.author_user_id = 'U456';
    await expect(
      capture.captureResolved({
        events,
        status: 'approved',
        reviewedAt: NOW,
        reviewedBy: 'Founder',
        reason: 'Ship it',
        surface: 'slack',
        legacyMetadata: {},
        resolutionEvidence: wrongReviewer,
      }),
    ).rejects.toThrow(/does not match the resolution event/);

    const wrongReaction = structuredClone(evidence);
    wrongReaction.actor.reaction_name = 'x';
    await expect(
      capture.captureResolved({
        events,
        status: 'approved',
        reviewedAt: NOW,
        reviewedBy: 'Founder',
        reason: 'Ship it',
        surface: 'slack',
        legacyMetadata: {},
        resolutionEvidence: wrongReaction,
      }),
    ).rejects.toThrow(/reaction does not match/);

    const noncanonicalReply = structuredClone(evidence);
    noncanonicalReply.actor.reason_reply!.message_ts = '1752956991.0002';
    await expect(
      capture.captureResolved({
        events,
        status: 'approved',
        reviewedAt: NOW,
        reviewedBy: 'Founder',
        reason: 'Ship it',
        surface: 'slack',
        legacyMetadata: {},
        resolutionEvidence: noncanonicalReply,
      }),
    ).rejects.toThrow(/invalid provider identifiers/);

    const changedMessage = structuredClone(resolved);
    const changedActor = (
      (changedMessage.metadata['federation'] as JsonObject)[
        'actor'
      ] as JsonObject
    )['raw_assertion'] as JsonObject;
    changedActor['message_ts'] = '1752956999.000999';
    await expect(
      capture.validateResolved({ events, event: changedMessage }),
    ).rejects.toThrow(/another published message/);
  });

  it('rejects approval-configuration drift while allowing an exact-config Slack rebinding', async () => {
    const originalBundle = bundle(runtime());
    const original = activeCapture({
      activeBundle: originalBundle,
      historicalBundle: originalBundle,
    });
    const requested = requestedEvent(
      await original.captureRequested(request()),
    );
    const baseEvents = nodeEvents(requested);
    const blocks = renderedBlocks(requested);
    const publishedReference = await original.capturePublished({
      events: baseEvents,
      surface: 'slack',
      reference: { channel_id: 'C123', message_ts: '1752956990.000100' },
      presentationEvidence: {
        rendered_blocks_sha256: canonicalSha256(blocks),
        rendered_blocks: blocks,
        provider_identity: LIVE_SLACK,
      },
      postedAt: NOW,
    });
    const published: DecisionPublishedEvent = {
      schema_version: 1,
      event_type: 'published',
      node_id: 'node-1',
      surface: 'slack',
      posted_at: NOW,
      reference: publishedReference,
    };
    const events = { ...baseEvents, published: [published] };
    const evidence = {
      provider_identity: LIVE_SLACK,
      actor: {
        team_id: 'T123',
        user_id: 'U123',
        display_name: 'Founder',
        reaction_name: 'white_check_mark',
        channel_id: 'C123',
        message_ts: '1752956990.000100',
        provider_occurred_at: null,
        reason_reply: null,
      },
    };

    const drifted = structuredClone(originalBundle);
    const driftedBinding = drifted.connectionRegistry.bindings.find(
      (item) => item.adapter_binding_id === IDS.approvalBinding,
    )!;
    driftedBinding.configuration_snapshot = {
      ...driftedBinding.configuration_snapshot,
      reviewer: { slack_user_id: 'U456', name: 'Different reviewer' },
    };
    driftedBinding.configuration_sha256 = canonicalSha256(
      driftedBinding.configuration_snapshot,
    );
    await expect(
      activeCapture({
        activeBundle: drifted,
        historicalBundle: originalBundle,
      }).captureResolved({
        events,
        status: 'approved',
        reviewedAt: '2026-07-19T20:32:00.000Z',
        reviewedBy: 'Founder',
        reason: null,
        surface: 'slack',
        legacyMetadata: {},
        resolutionEvidence: evidence,
      }),
    ).rejects.toThrow(
      /publishing and observation do not share one Slack approval configuration and identity/,
    );

    const reboundAt = '2026-07-19T20:31:00.000Z';
    const reboundHistory = structuredClone(originalBundle);
    const slackConnection = reboundHistory.connectionRegistry.connections.find(
      (item) => item.connection_id === IDS.slackConnection,
    )!;
    const firstGeneration = slackConnection.generations.find(
      (item) => item.generation === 1,
    )!;
    firstGeneration.ended_at = reboundAt;
    slackConnection.generations = [
      ...slackConnection.generations,
      {
        ...structuredClone(firstGeneration),
        generation: 2,
        active_from: reboundAt,
        ended_at: null,
        local_credential_guard: {
          ...firstGeneration.local_credential_guard,
          salt_base64: 'Aw==',
        },
      },
    ];
    const firstBinding = reboundHistory.connectionRegistry.bindings.find(
      (item) => item.adapter_binding_id === IDS.approvalBinding,
    )!;
    firstBinding.status = 'retired';
    firstBinding.ended_at = reboundAt;
    reboundHistory.connectionRegistry.bindings = [
      ...reboundHistory.connectionRegistry.bindings,
      {
        ...structuredClone(firstBinding),
        adapter_binding_id: IDS.reboundApprovalBinding,
        connection_generation: 2,
        created_at: reboundAt,
        ended_at: null,
        status: 'active',
      },
    ];
    reboundHistory.pointer.connection_registry.sha256 = canonicalSha256(
      reboundHistory.connectionRegistry,
    );
    const rebound = activeCapture({
      activeBundle: reboundHistory,
      historicalBundle: reboundHistory,
    });
    const metadata = await rebound.captureResolved({
      events,
      status: 'approved',
      reviewedAt: '2026-07-19T20:32:00.000Z',
      reviewedBy: 'Founder',
      reason: null,
      surface: 'slack',
      legacyMetadata: {},
      resolutionEvidence: evidence,
    });
    expect(
      (metadata['federation'] as JsonObject)[
        'approval_surface_observation'
      ],
    ).toMatchObject({
      adapter_binding_id: IDS.reboundApprovalBinding,
      connection_id: IDS.slackConnection,
      connection_generation: 2,
    });
    const resolved: DecisionResolvedEvent = {
      schema_version: 1,
      event_type: 'resolved',
      node_id: 'node-1',
      status: 'approved',
      reviewed_at: '2026-07-19T20:32:00.000Z',
      reviewed_by: 'Founder',
      reason: null,
      surface: 'slack',
      metadata,
    };
    await expect(
      rebound.validateResolved({ events, event: resolved }),
    ).resolves.toBeUndefined();
  });

  it('records CLI reviewer text only as a label at installation-holder assurance', async () => {
    const capture = activeCapture();
    const requested = requestedEvent(await capture.captureRequested(request()));
    const events = nodeEvents(requested);
    const metadata = await capture.captureResolved({
      events,
      status: 'approved',
      reviewedAt: NOW,
      reviewedBy: 'any free-form label',
      reason: null,
      surface: 'cli',
      legacyMetadata: {},
    });
    const federation = metadata['federation'] as JsonObject;
    const actor = federation['actor'] as JsonObject;
    expect(actor).toMatchObject({
      principal_id: IDS.principal,
      membership_id: IDS.membership,
      claim_id: null,
      assurance: 'installation_holder_self_attested',
    });
    expect((actor['raw_assertion'] as JsonObject)['reviewer_label']).toBe(
      'any free-form label',
    );
    const resolved: DecisionResolvedEvent = {
      schema_version: 1,
      event_type: 'resolved',
      node_id: 'node-1',
      status: 'approved',
      reviewed_at: NOW,
      reviewed_by: 'any free-form label',
      reason: null,
      surface: 'cli',
      metadata,
    };
    await expect(
      capture.validateResolved({ events, event: resolved }),
    ).resolves.toBeUndefined();

    const changedReason = structuredClone(resolved);
    changedReason.reason = 'modified later';
    await expect(
      capture.validateResolved({ events, event: changedReason }),
    ).rejects.toThrow(/diverges from the resolved event/);
  });
});
