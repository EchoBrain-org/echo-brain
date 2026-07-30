import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, JsonObject } from '../../../src/core/index.js';
import type { ProductRuntimeConfig } from '../../../src/product/config.js';
import type {
  DecisionNodeEvents,
  DecisionPublishedEvent,
  DecisionRequestedEvent,
  DecisionResolvedEvent,
} from '../../../src/product/approval/decision-node.js';
import { decisionApprovalId } from '../../../src/product/approval/decision-node.js';
import { renderSlackApprovalBlocks } from '../../../src/adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import type { VerifiedActiveIdentityBundle } from '../../../src/product/federation/identity/active-identity-bundle-store.js';
import {
  FederatedApprovalCapture,
  type ApprovalAttributionProvider,
  type ApprovalIdentityLineageReader,
  type ProductArtifactEvidenceProvider,
} from '../../../src/product/federation/approval-capture.js';
import { canonicalSha256 } from '../../../src/product/federation/foundation/canonical-json.js';
import type {
  AdapterBindingV1,
  ProcessorAttributionV1,
  ProductArtifactIdentityV1,
  SourceAttributionV1,
  ToolConnectionGenerationV1,
  ToolConnectionV1,
} from '../../../src/product/federation/contracts.js';
import type { ResolvedHistoricalBinding } from '../../../src/product/federation/identity-lineage-store.js';
import {
  founderRuntimeConfig,
  slackConnectionFixture,
  testBinding,
  testConnection,
} from './fixtures/founder-identity.js';
import {
  activeIdentityBundleFixture,
  approvalRequestFixture,
} from './fixtures/federated-records.js';

const NOW = '2026-07-19T20:30:00.000Z';
const SOURCE_CAPTURED_AT = '2026-07-19T20:28:00.000Z';
const PROCESSOR_CAPTURED_AT = '2026-07-19T20:29:00.000Z';
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
  const config = founderRuntimeConfig('/private/tmp/echo-federated-approval');
  config.meeting_sources[0]!.credential_ref = 'file:/private/tmp/granola-token';
  config.meeting_sources[0]!.settings = { page_size: 100 };
  config.decision_processor.settings = {
    prompt_version: 'structured-text-v1',
  };
  config.delivery_surfaces = [];
  config.approval_surface!.credential_ref = 'file:/private/tmp/slack-token';
  config.approval_surface!.settings = {
    channel_id: 'C123',
    reviewer: { slack_user_id: 'U123', name: 'Founder' },
    approve_reaction: 'white_check_mark',
    reject_reaction: 'x',
  };
  return config;
}

function request(): ApprovalRequest {
  return approvalRequestFixture({
    now: NOW,
    meetingId: 'granola:primary:not-1',
    externalId: 'not-1',
    revision: 'rev-1',
    title: 'Founder planning',
    processingKey: 'granola:primary:not-1:rev-1:structured-text:primary:1.0.0',
    briefId: 'brief-1',
    actualStartAt: '2026-07-19T19:00:00.000Z',
    sourceNormalizerVersion: '1',
    sourceUpdatedAt: NOW,
  });
}

function authorizationEvidence(evaluatedAt = NOW) {
  return {
    schema_version: 1 as const,
    kind: 'echo-organization-authorization-evidence' as const,
    authority_id: 'oau_00000000-0000-4000-8000-000000000001',
    organization_id: IDS.organization,
    enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
    installation_id: IDS.installation,
    request_id: 'pcr_00000000-0000-4000-8000-000000000001',
    approval_id: decisionApprovalId(request().processing_key),
    request_sha256: `sha256:${'c'.repeat(64)}`,
    provider_event_sha256: `sha256:${'d'.repeat(64)}`,
    allowed: true as const,
    reason_code: 'active_membership_and_direct_grant',
    principal_id: IDS.principal,
    membership_id: IDS.membership,
    adapter_binding_id: IDS.approvalBinding,
    permission_grant_id: 'pgr_00000000-0000-4000-8000-000000000001',
    evaluated_at: evaluatedAt,
  };
}

function bundle(config = runtime()): VerifiedActiveIdentityBundle {
  const sourceSettings = config.meeting_sources[0]!.settings;
  const processorSettings = config.decision_processor.settings;
  const approvalSettings = config.approval_surface!.settings;
  const keyId = `sha256:${'8'.repeat(64)}` as const;
  const integrity = (digit: string) => ({
    canonicalization: 'RFC8785' as const,
    payload_sha256: `sha256:${digit.repeat(64)}` as const,
    signature_algorithm: 'ecdsa-p256-sha256-der-low-s' as const,
    key_id: keyId,
    signature_base64: 'AQ==',
  });
  const sourceConnection = testConnection({
    connectionId: IDS.sourceConnection,
    organizationId: IDS.organization,
    owner: { kind: 'membership', id: IDS.membership },
    provider: 'granola',
    activeAt: NOW,
    providerIdentity: {
      tenant: null,
      subject: null,
      verification: {
        method: 'provider_first_capture',
        assurance: 'credential_observed',
        verified_at: NOW,
        evidence_sha256: `sha256:${'2'.repeat(64)}`,
      },
    },
    credentialGuard: {
      reference: 'file:/private/tmp/granola-token',
      algorithm: 'sha256-salted',
      salt_base64: 'AQ==',
      digest: `sha256:${'3'.repeat(64)}`,
      exportable: false,
    },
  });
  const slackConnection = slackConnectionFixture({
    connectionId: IDS.slackConnection,
    organizationId: IDS.organization,
    activeAt: NOW,
    tenantId: 'T123',
    subject: { id: 'U999BOT', bot_id: 'B999BOT', app_id: 'A999APP' },
    verifiedAt: NOW,
    evidenceSha256: `sha256:${'9'.repeat(64)}`,
    credentialGuard: {
      reference: 'file:/private/tmp/slack-token',
      algorithm: 'sha256-salted',
      salt_base64: 'Ag==',
      digest: `sha256:${'4'.repeat(64)}`,
      exportable: false,
    },
  });
  return activeIdentityBundleFixture({
    ids: IDS,
    at: NOW,
    artifact: ARTIFACT,
    signingKey: {
      key_id: keyId,
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: 'AQ==',
      protection: 'secure-enclave',
      assurance: 'hardware_bound',
    },
    connections: [sourceConnection, slackConnection],
    bindings: [
      testBinding({
        adapterBindingId: IDS.sourceBinding,
        capability: 'meeting-source',
        adapterId: 'granola',
        instanceId: 'primary',
        connectionId: IDS.sourceConnection,
        createdAt: NOW,
        configuration: sourceSettings,
      }),
      testBinding({
        adapterBindingId: IDS.processorBinding,
        capability: 'decision-processor',
        adapterId: 'structured-text',
        instanceId: 'primary',
        connectionId: null,
        createdAt: NOW,
        configuration: processorSettings,
      }),
      testBinding({
        adapterBindingId: IDS.approvalBinding,
        capability: 'approval-surface',
        adapterId: 'slack-reactions',
        instanceId: 'founder-approval',
        connectionId: IDS.slackConnection,
        createdAt: NOW,
        configuration: approvalSettings,
      }),
    ],
    identityClaims: [
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
    integrity: {
      manifest: integrity('1'),
      registry: integrity('5'),
      policy: integrity('6'),
      pointer: integrity('0'),
    },
    referenceDigests: {
      manifest: `sha256:${'1'.repeat(64)}`,
      registry: `sha256:${'5'.repeat(64)}`,
      policy: `sha256:${'6'.repeat(64)}`,
    },
  });
}
function lineageBundle(input: {
  manifestId: string;
  predecessorManifestId: string | null;
  registryId: string;
  createdAt: string;
  sourceBindingId: string;
  processorBindingId: string;
}): VerifiedActiveIdentityBundle {
  const value = structuredClone(bundle(runtime()));
  value.manifest.manifest_id = input.manifestId;
  value.manifest.predecessor_manifest_id = input.predecessorManifestId;
  value.manifest.created_at = input.createdAt;
  value.manifest.organization.created_at = SOURCE_CAPTURED_AT;
  value.manifest.membership.valid_from = SOURCE_CAPTURED_AT;
  value.manifest.installation.enrolled_at = SOURCE_CAPTURED_AT;
  value.manifest.legacy_cutover.declared_at = SOURCE_CAPTURED_AT;
  value.manifest.identity_claims[0]!.verification.verified_at =
    SOURCE_CAPTURED_AT;
  value.pointer.manifest.manifest_id = input.manifestId;
  value.pointer.manifest.sha256 = canonicalSha256(value.manifest);
  value.pointer.connection_registry.registry_id = input.registryId;
  value.pointer.activated_at = input.createdAt;
  value.connectionRegistry.registry_id = input.registryId;
  value.connectionRegistry.identity_manifest_id = input.manifestId;
  value.connectionRegistry.updated_at = input.createdAt;
  for (const connection of value.connectionRegistry.connections) {
    for (const generation of connection.generations) {
      generation.active_from = SOURCE_CAPTURED_AT;
      generation.provider_identity.verification.verified_at =
        SOURCE_CAPTURED_AT;
    }
  }
  for (const binding of value.connectionRegistry.bindings) {
    binding.created_at = SOURCE_CAPTURED_AT;
  }
  value.connectionRegistry.bindings[0]!.adapter_binding_id =
    input.sourceBindingId;
  value.connectionRegistry.bindings[1]!.adapter_binding_id =
    input.processorBindingId;
  value.pointer.connection_registry.sha256 = canonicalSha256(
    value.connectionRegistry,
  );
  value.publicationPolicy.identity_manifest_id = input.manifestId;
  value.publicationPolicy.effective_at = SOURCE_CAPTURED_AT;
  value.pointer.default_publication_policy.sha256 = canonicalSha256(
    value.publicationPolicy,
  );
  return value;
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
  ...historicals: VerifiedActiveIdentityBundle[]
): ApprovalIdentityLineageReader {
  function historicalFor(manifestId: string): VerifiedActiveIdentityBundle {
    const historical = historicals.find(
      (item) => item.manifest.manifest_id === manifestId,
    );
    if (historical === undefined) {
      throw new Error('test lineage: unknown identity manifest');
    }
    return historical;
  }

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
    const historical = historicalFor(locator.identity_manifest_id);
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
    assertManifestAncestorOrEqual(ancestorManifestId, descendantManifestId) {
      const seen = new Set<string>();
      let current = historicalFor(descendantManifestId);
      while (true) {
        if (current.manifest.manifest_id === ancestorManifestId) return;
        if (seen.has(current.manifest.manifest_id)) break;
        seen.add(current.manifest.manifest_id);
        const predecessor = current.manifest.predecessor_manifest_id;
        if (predecessor === null) break;
        current = historicalFor(predecessor);
      }
      throw new Error('test lineage: manifest order is reversed');
    },
    loadVerifiedManifest(manifestId) {
      const historical = historicalFor(manifestId);
      return {
        manifest: historical.manifest,
        canonical: historical.canonical.manifest,
        sha256: historical.pointer.manifest.sha256,
      };
    },
    loadVerifiedPolicy(reference, observedAt) {
      const historical = historicalFor(reference.identity_manifest_id);
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
    historicalBundles?: readonly VerifiedActiveIdentityBundle[];
  } = {},
): FederatedApprovalCapture {
  const config = runtime();
  const activeIdentity = overrides.activeBundle ?? bundle(config);
  const historicalIdentities = overrides.historicalBundles ?? [
    overrides.historicalBundle ?? activeIdentity,
  ];
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
    identityLineageReader: lineageReader(...historicalIdentities),
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

  it('accepts source A and processor B when approval is captured under current manifest C', async () => {
    const sourceIdentity = lineageBundle({
      manifestId: 'idm_a0000000-0000-4000-8000-000000000006',
      predecessorManifestId: null,
      registryId: 'reg_a0000000-0000-4000-8000-000000000007',
      createdAt: '2026-07-19T20:27:00.000Z',
      sourceBindingId: 'bnd_a0000000-0000-4000-8000-000000000010',
      processorBindingId: 'bnd_a0000000-0000-4000-8000-000000000011',
    });
    const processorIdentity = lineageBundle({
      manifestId: 'idm_b0000000-0000-4000-8000-000000000006',
      predecessorManifestId: sourceIdentity.manifest.manifest_id,
      registryId: 'reg_b0000000-0000-4000-8000-000000000007',
      createdAt: '2026-07-19T20:28:30.000Z',
      sourceBindingId: 'bnd_b0000000-0000-4000-8000-000000000010',
      processorBindingId: 'bnd_b0000000-0000-4000-8000-000000000011',
    });
    const approvalIdentity = lineageBundle({
      manifestId: 'idm_c0000000-0000-4000-8000-000000000006',
      predecessorManifestId: processorIdentity.manifest.manifest_id,
      registryId: 'reg_c0000000-0000-4000-8000-000000000007',
      createdAt: NOW,
      sourceBindingId: 'bnd_c0000000-0000-4000-8000-000000000010',
      processorBindingId: 'bnd_c0000000-0000-4000-8000-000000000011',
    });
    const frozen = attributions();
    frozen.source.identity_manifest_id = sourceIdentity.manifest.manifest_id;
    frozen.source.source.adapter_binding_id =
      sourceIdentity.connectionRegistry.bindings[0]!.adapter_binding_id;
    frozen.source.captured_at = SOURCE_CAPTURED_AT;
    frozen.processor.identity_manifest_id =
      processorIdentity.manifest.manifest_id;
    frozen.processor.processor.adapter_binding_id =
      processorIdentity.connectionRegistry.bindings[1]!.adapter_binding_id;
    frozen.processor.captured_at = PROCESSOR_CAPTURED_AT;
    const capture = activeCapture({
      activeBundle: approvalIdentity,
      historicalBundles: [sourceIdentity, processorIdentity, approvalIdentity],
      provider: {
        getAttributions: async () => frozen,
        getAttributionsForMetadata: async () => frozen,
      },
    });

    const requested = requestedEvent(await capture.captureRequested(request()));
    expect(
      (requested.metadata['federation'] as JsonObject)['identity_manifest_id'],
    ).toBe(approvalIdentity.manifest.manifest_id);
    await expect(
      capture.validateRequested(requested, request()),
    ).resolves.toBeUndefined();

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
    const resolvedMetadata = await capture.captureResolved({
      events,
      status: 'approved',
      reviewedAt: NOW,
      reviewedBy: 'Founder',
      reason: null,
      surface: 'slack',
      legacyMetadata: {},
      resolutionEvidence: {
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
        authorization: authorizationEvidence(),
      },
    });
    await expect(
      capture.validateResolved({
        events,
        event: {
          schema_version: 1,
          event_type: 'resolved',
          node_id: 'node-1',
          status: 'approved',
          reviewed_at: NOW,
          reviewed_by: 'Founder',
          reason: null,
          surface: 'slack',
          metadata: resolvedMetadata,
        },
      }),
    ).resolves.toBeUndefined();

    const foreignProcessorIdentity = structuredClone(processorIdentity);
    const foreignOrganization = 'org_f0000000-0000-4000-8000-000000000001';
    foreignProcessorIdentity.manifest.organization.organization_id =
      foreignOrganization;
    foreignProcessorIdentity.manifest.principal.organization_id =
      foreignOrganization;
    foreignProcessorIdentity.manifest.membership.organization_id =
      foreignOrganization;
    foreignProcessorIdentity.manifest.installation.organization_id =
      foreignOrganization;
    for (const connection of foreignProcessorIdentity.connectionRegistry
      .connections) {
      connection.organization_id = foreignOrganization;
    }
    await expect(
      activeCapture({
        activeBundle: approvalIdentity,
        historicalBundles: [
          sourceIdentity,
          foreignProcessorIdentity,
          approvalIdentity,
        ],
        provider: {
          getAttributions: async () => frozen,
          getAttributionsForMetadata: async () => frozen,
        },
      }).captureRequested(request()),
    ).rejects.toThrow(/ordered organization identity lineage/);

    const reversed = structuredClone(frozen);
    reversed.source.identity_manifest_id =
      processorIdentity.manifest.manifest_id;
    reversed.source.source.adapter_binding_id =
      processorIdentity.connectionRegistry.bindings[0]!.adapter_binding_id;
    reversed.source.captured_at = PROCESSOR_CAPTURED_AT;
    reversed.processor.identity_manifest_id =
      sourceIdentity.manifest.manifest_id;
    reversed.processor.processor.adapter_binding_id =
      sourceIdentity.connectionRegistry.bindings[1]!.adapter_binding_id;
    reversed.processor.captured_at = PROCESSOR_CAPTURED_AT;
    await expect(
      activeCapture({
        activeBundle: approvalIdentity,
        historicalBundles: [
          sourceIdentity,
          processorIdentity,
          approvalIdentity,
        ],
        provider: {
          getAttributions: async () => reversed,
          getAttributionsForMetadata: async () => reversed,
        },
      }).captureRequested(request()),
    ).rejects.toThrow(/manifest order is reversed/);
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
      authorization: authorizationEvidence(),
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
    expect(
      (
        (metadata['federation'] as JsonObject)[
          'approval_surface_observation'
        ] as JsonObject
      )['authorization'],
    ).toEqual(evidence.authorization);

    const missingAuthorization = {
      provider_identity: evidence.provider_identity,
      actor: evidence.actor,
    };
    await expect(
      capture.captureResolved({
        events,
        status: 'approved',
        reviewedAt: NOW,
        reviewedBy: 'Founder',
        reason: 'Ship it',
        surface: 'slack',
        legacyMetadata: {},
        resolutionEvidence: missingAuthorization,
      }),
    ).rejects.toThrow(/requires organization authorization evidence/);

    const legacyResolved = structuredClone(resolved);
    const legacyObservation = (
      legacyResolved.metadata['federation'] as JsonObject
    )['approval_surface_observation'] as JsonObject;
    delete legacyObservation['authorization'];
    await expect(
      capture.validateResolved({ events, event: legacyResolved }),
    ).resolves.toBeUndefined();

    await expect(
      capture.captureResolved({
        events,
        status: 'approved',
        reviewedAt: NOW,
        reviewedBy: 'Founder',
        reason: '   ',
        surface: 'slack',
        legacyMetadata: {},
        resolutionEvidence: evidence,
      }),
    ).rejects.toThrow(/reason must be null or non-blank text/);

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

    const wrongAuthorization = structuredClone(evidence);
    wrongAuthorization.authorization.membership_id =
      'mem_00000000-0000-4000-8000-000000000099';
    await expect(
      capture.captureResolved({
        events,
        status: 'approved',
        reviewedAt: NOW,
        reviewedBy: 'Founder',
        reason: 'Ship it',
        surface: 'slack',
        legacyMetadata: {},
        resolutionEvidence: wrongAuthorization,
      }),
    ).rejects.toThrow(/another local identity or time/);

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

    const changedAuthorization = structuredClone(resolved);
    const changedObservation = (
      changedAuthorization.metadata['federation'] as JsonObject
    )['approval_surface_observation'] as JsonObject;
    (changedObservation['authorization'] as JsonObject)['membership_id'] =
      'mem_00000000-0000-4000-8000-000000000099';
    await expect(
      capture.validateResolved({ events, event: changedAuthorization }),
    ).rejects.toThrow(/another local identity or time/);
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
      authorization: authorizationEvidence(),
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
      (metadata['federation'] as JsonObject)['approval_surface_observation'],
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
