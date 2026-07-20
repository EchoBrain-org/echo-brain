import { describe, expect, it } from 'vitest';
import type { DecisionNodeState } from '../../src/product/approval/decision-node.js';
import { canonicalSha256 } from '../../src/product/federation/foundation/canonical-json.js';
import type {
  ApprovalFederationMetadataV1,
  LocalIdentityManifestV1,
  ProcessorAttributionV1,
  ProductArtifactIdentityV1,
  SourceAttributionV1,
} from '../../src/product/federation/contracts.js';
import type { InstallationSigner } from '../../src/product/federation/foundation/installation-signer.js';
import type {
  AppendFederatedApprovalGroupRequest,
  FederatedOutboxStore,
} from '../../src/product/federation/outbox-store.js';
import { FederatedRecordProjector } from '../../src/product/federation/record-projector.js';
import { validateFederationDocument } from '../../src/product/federation/schema-validation.js';
import {
  activeIdentityBundleFixture,
  approvalRequestFixture,
} from './fixtures/federated-records.js';

const NOW = '2026-07-19T22:00:00.000Z';
const ARTIFACT: ProductArtifactIdentityV1 = {
  product_version: '0.1.0-dev.7',
  source_sha: 'a'.repeat(40),
  artifact_sha256: `sha256:${'b'.repeat(64)}`,
};
const UPGRADED_ARTIFACT: ProductArtifactIdentityV1 = {
  product_version: '0.1.0-dev.8',
  source_sha: 'c'.repeat(40),
  artifact_sha256: `sha256:${'d'.repeat(64)}`,
};
const IDS = {
  organization: 'org_00000000-0000-4000-8000-000000000001',
  principal: 'prn_00000000-0000-4000-8000-000000000001',
  membership: 'mem_00000000-0000-4000-8000-000000000001',
  device: 'dev_00000000-0000-4000-8000-000000000001',
  installation: 'ins_00000000-0000-4000-8000-000000000001',
  sourceManifest: 'idm_a0000000-0000-4000-8000-000000000001',
  processorManifest: 'idm_b0000000-0000-4000-8000-000000000001',
  manifest: 'idm_00000000-0000-4000-8000-000000000001',
  claim: 'clm_00000000-0000-4000-8000-000000000001',
  sourceBinding: 'bnd_00000000-0000-4000-8000-000000000001',
  processorBinding: 'bnd_00000000-0000-4000-8000-000000000002',
  approvalBinding1: 'bnd_00000000-0000-4000-8000-000000000003',
  approvalBinding2: 'bnd_00000000-0000-4000-8000-000000000004',
  sourceConnection: 'con_00000000-0000-4000-8000-000000000001',
  approvalConnection: 'con_00000000-0000-4000-8000-000000000002',
  policy: 'pol_00000000-0000-4000-8000-000000000001',
  observation: 'obs_00000000-0000-4000-8000-000000000001',
} as const;
const KEY_ID = `sha256:${'c'.repeat(64)}` as const;
const SIGNAL_ID = `decision:sha256:${'d'.repeat(64)}`;
const CONFIG = {
  channel_id: 'C123',
  reviewer: { slack_user_id: 'U123', name: 'Founder' },
  approve_reaction: 'white_check_mark',
  reject_reaction: 'x',
};
const MANIFEST_SHA = {
  source: `sha256:${'6'.repeat(64)}` as const,
  processor: `sha256:${'7'.repeat(64)}` as const,
  approval: `sha256:${'8'.repeat(64)}` as const,
};
const CONFIG_SHA = canonicalSha256(CONFIG);
const SLACK_PROVIDER = {
  provider: 'slack' as const,
  team_id: 'T123',
  enterprise_id: null,
  bot_user_id: 'U999',
  bot_id: 'B123',
  app_id: 'A123',
};

function manifest(manifestId: string = IDS.manifest): LocalIdentityManifestV1 {
  return activeIdentityBundleFixture({
    ids: {
      ...IDS,
      manifest: manifestId,
      registry: 'reg_00000000-0000-4000-8000-000000000001',
    },
    at: NOW,
    artifact: ARTIFACT,
    predecessorManifestId:
      manifestId === IDS.sourceManifest
        ? null
        : manifestId === IDS.processorManifest
          ? IDS.sourceManifest
          : IDS.processorManifest,
    signingKey: {
      key_id: KEY_ID,
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: 'AQ==',
      protection: 'secure-enclave',
      assurance: 'hardware_bound',
    },
    connections: [],
    bindings: [],
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
          evidence_sha256: `sha256:${'0'.repeat(64)}`,
        },
      },
    ],
    integrity: {
      canonicalization: 'RFC8785',
      payload_sha256: `sha256:${'e'.repeat(64)}`,
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
      key_id: KEY_ID,
      signature_base64: 'AQ==',
    },
    referenceDigests: {
      manifest: `sha256:${'e'.repeat(64)}`,
      registry: `sha256:${'e'.repeat(64)}`,
      policy: `sha256:${'e'.repeat(64)}`,
    },
  }).manifest;
}
function source(): SourceAttributionV1 {
  return {
    schema_version: 1,
    kind: 'echo-source-attribution',
    source_observation_id: IDS.observation,
    organization_id: IDS.organization,
    identity_manifest_id: IDS.sourceManifest,
    source: {
      adapter_binding_id: IDS.sourceBinding,
      adapter: {
        kind: 'meeting-source',
        adapter_id: 'granola',
        instance_id: 'primary',
        version: '2.2.0',
      },
      configuration_snapshot: { page_size: 100 },
      configuration_sha256: canonicalSha256({ page_size: 100 }),
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
      external_id: 'not_123',
      canonical_revision: 'rev_1',
      document_sha256: `sha256:${'1'.repeat(64)}`,
    },
    participant_observations: [
      {
        meeting_participant_id: 'person-1',
        display_name: 'External Person',
        observed_claims: [
          {
            namespace: `provider:granola:${IDS.sourceConnection}`,
            kind: 'source',
            value: 'granola-person-1',
          },
        ],
      },
    ],
    captured_by: ARTIFACT,
    captured_at: NOW,
  };
}

function processor(): ProcessorAttributionV1 {
  const settings = {
    model: 'qwen3:4b',
    prompt_version: 'decision-extraction-v1',
  };
  return {
    schema_version: 1,
    kind: 'echo-processor-attribution',
    identity_manifest_id: IDS.processorManifest,
    meeting: {
      source_adapter_id: 'granola',
      source_instance_id: 'primary',
      external_id: 'not_123',
      meeting_revision: 'rev_1',
    },
    processor: {
      adapter_binding_id: IDS.processorBinding,
      adapter: {
        kind: 'decision-processor',
        adapter_id: 'llm',
        instance_id: 'ollama',
        version: '1.0.0',
      },
      configuration_snapshot: settings,
      configuration_sha256: canonicalSha256(settings),
      decision_set_sha256: `sha256:${'2'.repeat(64)}`,
    },
    produced_by: ARTIFACT,
    captured_at: NOW,
  };
}

function metadata(
  sourceValue: SourceAttributionV1,
  processorValue: ProcessorAttributionV1,
): ApprovalFederationMetadataV1 {
  return {
    schema_version: 1,
    identity_manifest_id: IDS.manifest,
    source_attribution_ref: {
      source_adapter_id: 'granola',
      source_instance_id: 'primary',
      external_id: 'not_123',
      meeting_revision: 'rev_1',
      attribution_sha256: canonicalSha256(sourceValue),
    },
    processor: {
      adapter_binding_id: IDS.processorBinding,
      adapter: processorValue.processor
        .adapter as ApprovalFederationMetadataV1['processor']['adapter'],
      configuration_snapshot: processorValue.processor.configuration_snapshot,
      configuration_sha256: processorValue.processor.configuration_sha256,
      attribution_sha256: canonicalSha256(processorValue),
    },
    approval_surface: {
      binding: {
        adapter_binding_id: IDS.approvalBinding1,
        adapter: {
          kind: 'approval-surface',
          adapter_id: 'slack-reactions',
          instance_id: 'founder-approval',
          version: '1.0.0',
        },
        configuration_snapshot: CONFIG,
        configuration_sha256: CONFIG_SHA,
      },
      connection: {
        connection_id: IDS.approvalConnection,
        generation: 1,
        owner: { kind: 'organization', id: IDS.organization },
        provider_identity: SLACK_PROVIDER,
      },
    },
    publication: {
      policy_id: IDS.policy,
      version: 1,
      policy_sha256: `sha256:${'3'.repeat(64)}`,
      identity_manifest_id: IDS.manifest,
      signer_installation_id: IDS.installation,
      signer_key_id: KEY_ID,
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
    candidate_context_sha256: `sha256:${'4'.repeat(64)}`,
  };
}

function state(meta: ApprovalFederationMetadataV1): DecisionNodeState {
  const processorIdentity = {
    kind: 'decision-processor' as const,
    adapter_id: 'llm',
    instance_id: 'ollama',
    version: '1.0.0',
  };
  const brief = approvalRequestFixture({
    now: NOW,
    meetingId: 'granola:primary:not_123',
    externalId: 'not_123',
    revision: 'rev_1',
    title: 'Founder meeting',
    processingKey: 'processing:v1:fixture',
    briefId: 'brief-1',
    processor: processorIdentity,
  }).brief;
  brief.decisions = [
    {
      id: SIGNAL_ID,
      kind: 'decision',
      text: 'Ship the founder wedge.',
      subject: null,
      confidence: 0.9,
      evidence: [],
      status: 'decided',
    },
  ];
  const presentation = {
    channel_id: 'C123',
    message_ts: '1752956990.000100',
    rendered_blocks_sha256: `sha256:${'5'.repeat(64)}`,
  };
  return {
    approval_id: 'f'.repeat(64),
    node_id: 'node-1',
    processing_key: 'processing:v1:fixture',
    requested_at: NOW,
    requested_metadata: { federation: meta as unknown as never },
    brief,
    alternatives: [],
    links: { parent: null, supersedes: null },
    status: 'approved',
    reviewed_at: NOW,
    reviewed_by: 'Founder',
    reason: null,
    resolved_surface: 'slack',
    resolved_metadata: {
      federation: {
        actor: {
          principal_id: IDS.principal,
          membership_id: IDS.membership,
          claim_id: IDS.claim,
          raw_assertion: {
            surface: 'slack',
            issuer: { provider: 'slack', tenant_id: 'T123' },
            subject_id: 'U123',
            display_name: 'Founder',
            channel_id: 'C123',
            message_ts: '1752956990.000100',
            action: {
              kind: 'reaction',
              name: 'white_check_mark',
              provider_occurred_at: null,
              observed_at: NOW,
            },
            reason_reply: null,
          },
          assurance: 'provider_challenge_observed',
        },
        approval_context: {
          candidate_context_sha256: meta.candidate_context_sha256,
          presentation,
          approved_context_sha256: canonicalSha256({
            domain: 'echo.approved-context.v1',
            candidate_context_sha256: meta.candidate_context_sha256,
            presentation,
          }),
        },
        approval_surface_observation: {
          adapter_binding_id: IDS.approvalBinding2,
          connection_id: IDS.approvalConnection,
          connection_generation: 2,
          configuration_sha256: CONFIG_SHA,
          provider_identity_sha256: canonicalSha256(SLACK_PROVIDER),
          observed_by: { ...ARTIFACT },
        },
      },
    },
    published: [
      {
        schema_version: 1,
        event_type: 'published',
        node_id: 'node-1',
        surface: 'slack',
        posted_at: NOW,
        reference: {
          slack: { channel_id: 'C123', message_ts: '1752956990.000100' },
        },
      },
    ],
  };
}

describe('federated approved-record projector', () => {
  it('projects source A, processor B, and approval C while keeping Slack generations separate', async () => {
    const sourceValue = source();
    const processorValue = processor();
    const meta = metadata(sourceValue, processorValue);
    const node = state(meta);
    let appended: AppendFederatedApprovalGroupRequest | undefined;
    let existing: Awaited<
      ReturnType<FederatedOutboxStore['readByLocalSubject']>
    >;
    let currentArtifact = ARTIFACT;
    let policyAvailable = true;
    const projector = new FederatedRecordProjector({
      signer: {} as InstallationSigner,
      artifactProvider: {
        current: () => currentArtifact,
        verify(value) {
          expect([ARTIFACT, UPGRADED_ARTIFACT]).toContainEqual(value);
        },
      },
      attributionProvider: {
        getAttributions: async () => ({
          source: sourceValue,
          processor: processorValue,
        }),
        getAttributionsForMetadata: async () => ({
          source: sourceValue,
          processor: processorValue,
        }),
      },
      lineage: {
        assertManifestAncestorOrEqual(
          ancestorManifestId,
          descendantManifestId,
        ) {
          let current: string | null = descendantManifestId;
          while (current !== null) {
            if (current === ancestorManifestId) return;
            current = manifest(current).predecessor_manifest_id;
          }
          throw new Error('test lineage: manifest order is reversed');
        },
        loadVerifiedManifest: (manifestId) => {
          const sha256 =
            manifestId === IDS.sourceManifest
              ? MANIFEST_SHA.source
              : manifestId === IDS.processorManifest
                ? MANIFEST_SHA.processor
                : manifestId === IDS.manifest
                  ? MANIFEST_SHA.approval
                  : undefined;
          if (sha256 === undefined) throw new Error('unknown manifest');
          return { manifest: manifest(manifestId), canonical: '{}', sha256 };
        },
        loadVerifiedManifestBySha256: (sha256) => {
          const manifestId =
            sha256 === MANIFEST_SHA.source
              ? IDS.sourceManifest
              : sha256 === MANIFEST_SHA.processor
                ? IDS.processorManifest
                : sha256 === MANIFEST_SHA.approval
                  ? IDS.manifest
                  : undefined;
          if (manifestId === undefined) throw new Error('unknown manifest');
          return { manifest: manifest(manifestId), canonical: '{}', sha256 };
        },
        loadVerifiedPolicy: () => {
          if (!policyAvailable) {
            throw new Error('historical publication policy file is missing');
          }
          return {
            policy: {
              schema_version: 1,
              kind: 'echo-publication-policy',
              policy_id: meta.publication.policy_id,
              organization_id: IDS.organization,
              identity_manifest_id: meta.publication.identity_manifest_id,
              issued_by: {
                installation_id: meta.publication.signer_installation_id,
                key_id: meta.publication.signer_key_id,
              },
              version: meta.publication.version,
              effective_at: NOW,
              publication: {
                payload_scope: meta.publication.payload_scope,
                audience: meta.publication.audience,
                sensitivity: meta.publication.sensitivity,
                retention: meta.publication.retention,
                raw_meeting_content: meta.publication.raw_meeting_content,
                participant_observations:
                  meta.publication.participant_observations,
              },
              integrity: {
                canonicalization: 'RFC8785',
                payload_sha256: `sha256:${'a'.repeat(64)}`,
                signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
                key_id: meta.publication.signer_key_id,
                signature_base64: 'AQ==',
              },
            },
            manifest: manifest(),
            canonical: '{}',
            sha256: meta.publication.policy_sha256,
          };
        },
        resolveBindingSnapshotAt: () =>
          ({
            binding: {
              adapter_binding_id: IDS.approvalBinding2,
              capability: 'approval-surface',
              adapter_id: 'slack-reactions',
              instance_id: 'founder-approval',
              connection_id: IDS.approvalConnection,
              connection_generation: 2,
              configuration_snapshot: CONFIG,
              configuration_sha256: CONFIG_SHA,
              created_at: NOW,
              ended_at: null,
              status: 'active',
            },
            connection: {
              connection_id: IDS.approvalConnection,
              organization_id: IDS.organization,
              owner: { kind: 'organization', id: IDS.organization },
              provider: 'slack',
              generations: [],
            },
            generation: {
              generation: 2,
              active_from: NOW,
              ended_at: null,
              provider_identity: {
                tenant: {
                  kind: 'slack-team',
                  id: 'T123',
                  enterprise_id: null,
                },
                subject: {
                  kind: 'bot-installation',
                  id: 'U999',
                  bot_id: 'B123',
                  app_id: 'A123',
                },
                verification: {
                  method: 'slack_auth_test',
                  assurance: 'provider_verified',
                  verified_at: NOW,
                  evidence_sha256: `sha256:${'8'.repeat(64)}`,
                },
              },
              local_credential_guard: {
                reference: 'file:/private/slack-token',
                algorithm: 'sha256-salted',
                salt_base64: 'AQ==',
                digest: `sha256:${'9'.repeat(64)}`,
                exportable: false,
              },
            },
          }) as never,
      },
      outbox: {
        async readByLocalSubject() {
          return existing;
        },
        async appendApprovalGroup(request) {
          appended = request;
          return [];
        },
      },
      now: () => NOW,
    });

    await projector.projectApproved(node);
    expect(appended?.events).toHaveLength(1);
    const draft = appended!.events[0]!.envelope;
    expect(
      (draft.approval as { surface: { connection: { generation: number } } })
        .surface.connection.generation,
    ).toBe(1);
    expect(
      (
        draft.approval as {
          observation: { connection: { generation: number } };
        }
      ).observation.connection.generation,
    ).toBe(2);
    expect(
      draft.source.participant_observations[0]?.observed_claims[0]?.namespace,
    ).toBe(`provider:granola:${IDS.sourceConnection}`);
    expect(draft.source).toMatchObject({
      identity_manifest_id: IDS.sourceManifest,
      identity_manifest_sha256: MANIFEST_SHA.source,
    });
    expect(draft.processor).toMatchObject({
      identity_manifest_id: IDS.processorManifest,
      identity_manifest_sha256: MANIFEST_SHA.processor,
    });
    expect(draft.identity_manifest_sha256).toBe(MANIFEST_SHA.approval);
    sourceValue.identity_manifest_id = IDS.processorManifest;
    processorValue.identity_manifest_id = IDS.sourceManifest;
    await expect(projector.projectApproved(node)).rejects.toThrow(
      /manifest order is reversed/,
    );
    sourceValue.identity_manifest_id = IDS.sourceManifest;
    processorValue.identity_manifest_id = IDS.processorManifest;
    const payload = {
      ...draft,
      sequence: 1,
      previous_event_hash: null,
    };
    expect(() =>
      validateFederationDocument('federated-record-envelope', {
        ...payload,
        integrity: {
          canonicalization: 'RFC8785',
          payload_sha256: canonicalSha256(payload),
          signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
          key_id: KEY_ID,
          signature_base64: 'AQ==',
        },
      }),
    ).not.toThrow();

    existing = {
      local_subject_key: appended!.events[0]!.local_subject_key,
      installation_id: IDS.installation,
      envelope: {
        ...appended!.events[0]!.envelope,
        sequence: 1,
        previous_event_hash: null,
        integrity: {
          canonicalization: 'RFC8785',
          payload_sha256: `sha256:${'8'.repeat(64)}`,
          signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
          key_id: KEY_ID,
          signature_base64: 'AQ==',
        },
      },
    } as never;
    currentArtifact = UPGRADED_ARTIFACT;
    await projector.projectApproved(node);
    expect(appended!.events[0]!.envelope.producer.product_artifact).toEqual(
      ARTIFACT,
    );

    const wrongActor = structuredClone(node);
    const wrongActorFederation = wrongActor.resolved_metadata![
      'federation'
    ] as Record<string, unknown>;
    (wrongActorFederation['actor'] as Record<string, unknown>)['principal_id'] =
      'prn_00000000-0000-4000-8000-000000000099';
    await expect(projector.projectApproved(wrongActor)).rejects.toThrow(
      /actor belongs to another local identity/,
    );

    const changedContext = structuredClone(node);
    const changedContextFederation = changedContext.resolved_metadata![
      'federation'
    ] as Record<string, unknown>;
    (changedContextFederation['approval_context'] as Record<string, unknown>)[
      'approved_context_sha256'
    ] = `sha256:${'a'.repeat(64)}`;
    await expect(projector.projectApproved(changedContext)).rejects.toThrow(
      /approved-context digest is invalid/,
    );

    policyAvailable = false;
    appended = undefined;
    await expect(projector.projectApproved(node)).rejects.toThrow(
      /historical publication policy file is missing/,
    );
    expect(appended).toBeUndefined();
  });

  it('fails closed when an approved brief has no signals', async () => {
    const sourceValue = source();
    const processorValue = processor();
    const node = state(metadata(sourceValue, processorValue));
    node.brief.decisions = [];
    const projector = new FederatedRecordProjector({
      signer: {} as InstallationSigner,
      artifactProvider: { current: () => ARTIFACT, verify: () => undefined },
      attributionProvider: {
        getAttributions: async () => ({
          source: sourceValue,
          processor: processorValue,
        }),
        getAttributionsForMetadata: async () => ({
          source: sourceValue,
          processor: processorValue,
        }),
      },
      lineage: {} as never,
      outbox: {} as never,
    });
    await expect(projector.projectApproved(node)).rejects.toThrow(/no signals/);
  });
});
