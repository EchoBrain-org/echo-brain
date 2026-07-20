import {
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from 'node:crypto';
import type { ApprovalRequest } from '../../../src/core/approval/approval-gate.js';
import type { VerifiedActiveIdentityBundle } from '../../../src/product/federation/identity/active-identity-bundle-store.js';
import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
} from '../../../src/product/federation/foundation/canonical-json.js';
import type {
  ActiveIdentityBundleV1,
  AdapterBindingV1,
  FederationId,
  LocalConnectionRegistryV1,
  LocalIdentityManifestV1,
  NativeProducerV1,
  ProductArtifactIdentityV1,
  PublicationPolicyV1,
  PublicationSnapshotV1,
  Sha256Digest,
  SignedIntegrity,
  ToolConnectionV1,
} from '../../../src/product/federation/contracts.js';
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from '../../../src/product/federation/foundation/installation-signer.js';
import { createSignedDocument } from '../../../src/product/federation/foundation/signed-document.js';
import type {
  FederatedEventDraftV1,
  FederatedOutboxEventDraft,
  StoredFederatedOutboxEvent,
} from '../../../src/product/federation/outbox-store.js';
import {
  normalizeP256LowS,
  p256KeyId,
} from '../../../src/product/federation/foundation/signature-profile.js';
import { testPublication } from './founder-identity.js';

export function federationFixtureId(prefix: string, suffix: number): string {
  return `${prefix}_00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;
}

export class CountingInstallationSigner implements InstallationSigner {
  private readonly privateKey: KeyObject;
  readonly descriptor: InstallationKeyDescriptor;
  signCalls = 0;
  failOnSignCall: number | undefined;

  constructor(
    private readonly installationId = federationFixtureId('ins', 1),
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    this.privateKey = privateKey;
    this.descriptor = {
      installation_id: installationId,
      key_id: p256KeyId(publicKeyDer),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicKeyDer.toString('base64'),
      protection: 'secure-enclave',
      assurance: 'hardware_bound',
      private_key_exportable: false,
    };
  }

  async generate(installationId: string): Promise<InstallationKeyDescriptor> {
    if (installationId !== this.installationId) {
      throw new Error('unknown test installation');
    }
    return this.descriptor;
  }

  async inspect(
    installationId: string,
  ): Promise<InstallationKeyDescriptor | null> {
    return installationId === this.installationId ? this.descriptor : null;
  }

  async sign(
    installationId: string,
    message: Buffer,
    expectedKeyId?: Sha256Digest,
  ): Promise<Buffer> {
    if (
      installationId !== this.installationId ||
      expectedKeyId !== this.descriptor.key_id
    ) {
      throw new Error('test signing identity mismatch');
    }
    this.signCalls += 1;
    if (this.signCalls === this.failOnSignCall) {
      throw new Error('injected signing failure');
    }
    return normalizeP256LowS(
      signMessage('sha256', message, {
        key: this.privateKey,
        dsaEncoding: 'der',
      }),
    );
  }
}

type FixtureInstallationSigner = InstallationSigner & {
  readonly descriptor: InstallationKeyDescriptor;
};

interface ActiveIdentityBundleFixtureOptions {
  ids: {
    organization: string;
    principal: string;
    membership: string;
    device: string;
    installation: string;
    manifest: string;
    registry: string;
    policy: string;
  };
  at: string;
  artifact: ProductArtifactIdentityV1;
  signingKey: LocalIdentityManifestV1['installation']['signing_key'];
  connections: readonly ToolConnectionV1[];
  bindings: readonly AdapterBindingV1[];
  identityClaims?: LocalIdentityManifestV1['identity_claims'];
  integrity:
    | SignedIntegrity
    | {
        manifest: SignedIntegrity;
        registry: SignedIntegrity;
        policy: SignedIntegrity;
        pointer: SignedIntegrity;
      };
  referenceDigests: {
    manifest: Sha256Digest;
    registry: Sha256Digest;
    policy: Sha256Digest;
  };
  predecessorManifestId?: FederationId | null;
  organizationDisplayName?: string;
  principalDisplayName?: string;
  publication?: PublicationSnapshotV1;
}

export function activeIdentityBundleFixture(
  options: ActiveIdentityBundleFixtureOptions,
): VerifiedActiveIdentityBundle {
  const { ids, at } = options;
  const integrity =
    'manifest' in options.integrity
      ? options.integrity
      : {
          manifest: options.integrity,
          registry: options.integrity,
          policy: options.integrity,
          pointer: options.integrity,
        };
  const manifest: LocalIdentityManifestV1 = {
    schema_version: 1,
    kind: 'echo-local-identity-manifest',
    manifest_id: ids.manifest,
    predecessor_manifest_id: options.predecessorManifestId ?? null,
    created_at: at,
    authority: {
      kind: 'local-founder-bootstrap',
      assurance: 'founder_attested',
    },
    organization: {
      organization_id: ids.organization,
      display_name: options.organizationDisplayName ?? 'Echo',
      created_at: at,
    },
    principal: {
      principal_id: ids.principal,
      organization_id: ids.organization,
      kind: 'human',
      display_name: options.principalDisplayName ?? 'Founder',
    },
    membership: {
      membership_id: ids.membership,
      organization_id: ids.organization,
      principal_id: ids.principal,
      type: 'owner',
      status: 'active',
      valid_from: at,
    },
    installation: {
      installation_id: ids.installation,
      organization_id: ids.organization,
      membership_id: ids.membership,
      device_id: ids.device,
      device_class: 'byod',
      enrolled_at: at,
      product: {
        name: 'echo-brain',
        version: options.artifact.product_version,
        source_sha: options.artifact.source_sha,
      },
      signing_key: structuredClone(options.signingKey),
    },
    identity_claims: structuredClone(options.identityClaims ?? []),
    legacy_cutover: {
      declared_at: at,
      pre_cutover_default: 'disposable_test',
      native_records_require: [
        'source-attribution-v1',
        'processor-attribution-v1',
        'approval-context-v1',
        'signed-outbox-v1',
      ],
    },
    integrity: structuredClone(integrity.manifest),
  };
  const connectionRegistry: LocalConnectionRegistryV1 = {
    schema_version: 1,
    kind: 'echo-local-connection-registry',
    registry_id: ids.registry,
    identity_manifest_id: ids.manifest,
    revision: 1,
    previous_registry_sha256: null,
    updated_at: at,
    connections: structuredClone(options.connections),
    bindings: structuredClone(options.bindings),
    integrity: structuredClone(integrity.registry),
  };
  const publicationPolicy: PublicationPolicyV1 = {
    schema_version: 1,
    kind: 'echo-publication-policy',
    policy_id: ids.policy,
    organization_id: ids.organization,
    identity_manifest_id: ids.manifest,
    issued_by: {
      installation_id: ids.installation,
      key_id: options.signingKey.key_id,
    },
    version: 1,
    effective_at: at,
    publication:
      structuredClone(options.publication) ?? testPublication(ids.organization),
    integrity: structuredClone(integrity.policy),
  };
  const pointer: ActiveIdentityBundleV1 = {
    schema_version: 1,
    kind: 'echo-active-identity-bundle',
    manifest: {
      manifest_id: ids.manifest,
      path: 'manifests/manifest.json',
      sha256: options.referenceDigests.manifest,
    },
    connection_registry: {
      registry_id: ids.registry,
      revision: 1,
      path: 'registries/registry.json',
      sha256: options.referenceDigests.registry,
    },
    default_publication_policy: {
      policy_id: ids.policy,
      version: 1,
      path: 'policies/policy.json',
      sha256: options.referenceDigests.policy,
    },
    active_installation_id: ids.installation,
    activated_at: at,
    activation_reason: 'founder-bootstrap',
    integrity: structuredClone(integrity.pointer),
  };
  return {
    pointer,
    manifest,
    connectionRegistry,
    publicationPolicy,
    canonical: {
      pointer: '{}',
      manifest: '{}',
      connectionRegistry: '{}',
      publicationPolicy: '{}',
    },
  };
}

interface ApprovalRequestFixtureOptions {
  now: string;
  meetingId: string;
  externalId: string;
  revision: string;
  title: string;
  processingKey: string;
  briefId: string;
  actualStartAt?: string;
  sourceNormalizerVersion?: string;
  sourceUpdatedAt?: string;
  processor?: ApprovalRequest['decisions']['processor'];
}

export function approvalRequestFixture(
  options: ApprovalRequestFixtureOptions,
): ApprovalRequest {
  const processor = options.processor ?? {
    kind: 'decision-processor',
    adapter_id: 'structured-text',
    instance_id: 'primary',
    version: '1.0.0',
  };
  const time =
    options.actualStartAt === undefined
      ? undefined
      : { actual_start_at: options.actualStartAt };
  return {
    processing_key: options.processingKey,
    requested_at: options.now,
    meeting: {
      schema_version: 1,
      id: options.meetingId,
      title: options.title,
      ...(time === undefined ? {} : { time }),
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
        external_id: options.externalId,
        canonical_revision: options.revision,
        observed_at: options.now,
        normalizer_version: options.sourceNormalizerVersion ?? '1.0.0',
        ...(options.sourceUpdatedAt === undefined
          ? {}
          : { source_updated_at: options.sourceUpdatedAt }),
      },
    },
    decisions: {
      schema_version: 1,
      meeting_id: options.meetingId,
      meeting_revision: options.revision,
      processor: structuredClone(processor),
      generated_at: options.now,
      signals: [],
    },
    brief: {
      schema_version: 1,
      id: options.briefId,
      meeting: {
        id: options.meetingId,
        title: options.title,
        ...(time === undefined ? {} : { time }),
        participants: [],
      },
      decisions: [],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: options.revision,
        processor: structuredClone(processor),
        generated_at: options.now,
      },
    },
  };
}

interface EventGroupFixtureOptions {
  signer: FixtureInstallationSigner;
  occurredAt: string;
  approvalId: string;
  decisionId: string;
  actionId: string;
  digests: { a: Sha256Digest; b: Sha256Digest; c: Sha256Digest };
  organizationId?: string;
  principalId?: string;
  membershipId?: string;
  manifestId?: string;
  manifestSha256?: Sha256Digest;
  sourceManifestId?: string;
  sourceManifestSha256?: Sha256Digest;
  processorManifestId?: string;
  processorManifestSha256?: Sha256Digest;
  sourceBindingId?: string;
  processorBindingId?: string;
  sourceConnectionId?: string;
  policy?: {
    policyId: string;
    version: number;
    sha256: Sha256Digest;
    identityManifestId: string;
    signerInstallationId: string;
    signerKeyId: Sha256Digest;
    publication: PublicationSnapshotV1;
  };
  productVersion?: string;
  idOffset?: number;
  signals?: readonly string[];
  meetingId?: string;
  meetingTitle?: string;
  briefId?: string;
  nodeId?: string;
  processingKey?: string;
  sourceExternalId?: string;
  sourceRevision?: string;
  sourceConfigurationSha256?: Sha256Digest;
  processorConfigurationSha256?: Sha256Digest;
  decisionText?: string;
  actionText?: string;
  approvalReason?: string | null;
  slackClaimId?: FederationId;
  membershipAssertion?: NativeProducerV1['membership_assertion'];
}

export function federatedApprovalGroupDrafts(
  options: EventGroupFixtureOptions,
): FederatedOutboxEventDraft[] {
  const organizationId = options.organizationId ?? federationFixtureId('org', 1);
  const principalId = options.principalId ?? federationFixtureId('prn', 1);
  const membershipId = options.membershipId ?? federationFixtureId('mem', 1);
  const manifestId = options.manifestId ?? federationFixtureId('idm', 1);
  const sourceManifestId = options.sourceManifestId ?? manifestId;
  const processorManifestId = options.processorManifestId ?? manifestId;
  const sourceBindingId = options.sourceBindingId ?? federationFixtureId('bnd', 1);
  const processorBindingId =
    options.processorBindingId ?? federationFixtureId('bnd', 2);
  const sourceConnectionId =
    options.sourceConnectionId ?? federationFixtureId('con', 1);
  const meetingId = options.meetingId ?? 'meeting-fixture';
  const artifact = {
    product_version: options.productVersion ?? '0.1.0-dev.6',
    source_sha: '1'.repeat(40),
    artifact_sha256: options.digests.a,
  } satisfies ProductArtifactIdentityV1;
  const decision = {
    id: options.decisionId,
    kind: 'decision',
    text: options.decisionText ?? 'Ship the signed founder record.',
    subject: null,
    confidence: options.productVersion === '0.1.0-dev.7' ? 0.95 : 0.9,
    evidence: [],
    status: 'decided',
  } as const;
  const action = {
    id: options.actionId,
    kind: 'action',
    text: options.actionText ?? 'Export the signed founder record.',
    subject: null,
    confidence: options.productVersion === '0.1.0-dev.7' ? 0.9 : 0.8,
    evidence: [],
    owner: null,
    due_at: null,
  } as const;
  const signalManifest = [decision, action].map((signal) => ({
    signal_id: signal.id,
    kind: signal.kind,
    position_within_kind: 0,
    sha256: canonicalSha256(signal),
  }));
  const approvedBriefSha256 =
    options.productVersion === '0.1.0-dev.7'
      ? canonicalSha256({ meeting: meetingId, signals: signalManifest })
      : options.digests.a;
  const publication = options.policy ?? {
    policyId: federationFixtureId('pol', 1),
    version: 1,
    sha256: options.digests.c,
    identityManifestId: manifestId,
    signerInstallationId: options.signer.descriptor.installation_id,
    signerKeyId: options.signer.descriptor.key_id,
    publication: testPublication(organizationId),
  };
  const signals = options.signals ?? [options.decisionId, options.actionId];
  const offset = options.idOffset ?? 0;

  return signals.map((signalId, index) => {
    const signal = signalId === options.decisionId ? decision : action;
    const record: FederatedEventDraftV1['record'] = {
      record_id: federationFixtureId('rec', offset + index + 1),
      kind: signal.kind,
      signal_id: signal.id,
      signal,
      meeting_context: {
        id: meetingId,
        title: options.meetingTitle ?? 'Founder fixture',
        participants: [],
      },
      approval_group: {
        brief_schema_version: 1,
        brief_id: options.briefId ?? 'brief-fixture',
        approved_brief_sha256: approvedBriefSha256,
        signal_manifest: signalManifest,
      },
    } as FederatedEventDraftV1['record'];
    const sourceConfiguration = { page_size: 100 };
    const processorConfiguration = { model: 'qwen3:4b' };
    const envelope = {
      schema_version: 1,
      kind: 'echo-federated-event',
      event_type: 'approved-org-record',
      event_id: federationFixtureId('evt', offset + index + 1),
      organization_id: organizationId,
      occurred_at: options.occurredAt,
      producer: {
        principal_id: principalId,
        membership_id: membershipId,
        installation_id: options.signer.descriptor.installation_id,
        key_id: options.signer.descriptor.key_id,
        membership_assertion: options.membershipAssertion ?? {
          status: 'active',
          authority: 'local-founder-bootstrap',
          assurance: 'founder_attested',
        },
        product_artifact: artifact,
      },
      source: {
        identity_manifest_id: sourceManifestId,
        identity_manifest_sha256:
          options.sourceManifestSha256 ?? options.manifestSha256 ?? options.digests.a,
        binding: {
          adapter_binding_id: sourceBindingId,
          adapter: {
            kind: 'meeting-source',
            adapter_id: 'granola',
            instance_id: 'primary',
            version: '2.2.0',
          },
          configuration_snapshot: sourceConfiguration,
          configuration_sha256:
            options.sourceConfigurationSha256 ??
            (options.productVersion === '0.1.0-dev.7'
              ? canonicalSha256(sourceConfiguration)
              : options.digests.a),
        },
        connection: {
          connection_id: sourceConnectionId,
          generation: 1,
          owner: { kind: 'membership', id: membershipId },
          provider_identity: {
            provider: 'granola',
            tenant: null,
            subject: null,
            verification_method: 'provider_first_capture',
            assurance: 'credential_observed',
          },
        },
        meeting: {
          external_id: options.sourceExternalId ?? 'meeting-external-1',
          revision: options.sourceRevision ?? 'revision-1',
          source_observation_id: federationFixtureId('obs', 1),
          document_sha256: options.digests.a,
        },
        participant_observations: [],
        attribution_sha256: options.digests.b,
        observed_by: artifact,
      },
      processor: {
        identity_manifest_id: processorManifestId,
        identity_manifest_sha256:
          options.processorManifestSha256 ??
          options.manifestSha256 ??
          options.digests.a,
        adapter_binding_id: processorBindingId,
        adapter: {
          kind: 'decision-processor',
          adapter_id: 'llm',
          instance_id: 'ollama',
          version: '1.0.0',
        },
        configuration_snapshot: processorConfiguration,
        configuration_sha256:
          options.processorConfigurationSha256 ??
          (options.productVersion === '0.1.0-dev.7'
            ? canonicalSha256(processorConfiguration)
            : options.digests.b),
        attribution_sha256: options.digests.c,
        decision_set_sha256: options.digests.a,
        generated_at: options.occurredAt,
        produced_by: artifact,
      },
      local_reference: {
        processing_key: options.processingKey ?? 'processing-fixture',
        approval_id: options.approvalId,
        node_id: options.nodeId ?? 'node-fixture',
        meeting_id: meetingId,
        signal_id: signal.id,
      },
      record,
      approval:
        options.slackClaimId === undefined
          ? {
              surface: null,
              approver: {
                principal_id: principalId,
                membership_id: membershipId,
                claim_id: null,
              },
              raw_actor_assertion: {
                surface: 'cli',
                installation_id: options.signer.descriptor.installation_id,
                reviewer_label: 'founder',
                command: 'approve',
                observed_at: options.occurredAt,
              },
              assurance: 'installation_holder_self_attested',
              reviewed_at: options.occurredAt,
              reason: options.approvalReason ?? 'Founder approved.',
              approved_brief_sha256: approvedBriefSha256,
              approved_context_sha256: options.digests.b,
              observed_by: artifact,
            }
          : slackApproval({
              claimId: options.slackClaimId,
              principalId,
              membershipId,
              artifact,
              occurredAt: options.occurredAt,
              approvedBriefSha256,
              digestA: options.digests.a,
            }),
      publication: {
        policy_id: publication.policyId,
        version: publication.version,
        policy_sha256: publication.sha256,
        identity_manifest_id: publication.identityManifestId,
        signer_installation_id: publication.signerInstallationId,
        signer_key_id: publication.signerKeyId,
        ...structuredClone(publication.publication),
      },
      classification: 'native_attributed',
      identity_manifest_sha256:
        options.manifestSha256 ?? options.digests.a,
    } satisfies FederatedEventDraftV1;
    return {
      local_subject_key: `approved-org-record:${options.approvalId}:${signal.id}`,
      envelope,
    };
  });
}

function slackApproval(input: {
  claimId: FederationId;
  principalId: string;
  membershipId: string;
  artifact: ProductArtifactIdentityV1;
  occurredAt: string;
  approvedBriefSha256: Sha256Digest;
  digestA: Sha256Digest;
}): FederatedEventDraftV1['approval'] {
  const configuration = {
    channel_id: 'C123',
    approve_reaction: 'white_check_mark',
    reject_reaction: 'x',
  };
  const binding = {
    adapter_binding_id: federationFixtureId('bnd', 3),
    adapter: {
      kind: 'approval-surface' as const,
      adapter_id: 'slack-reactions',
      instance_id: 'founder-approval',
      version: '1.0.0',
    },
    configuration_snapshot: configuration,
    configuration_sha256: canonicalSha256(configuration),
  };
  const connection = {
    connection_id: federationFixtureId('con', 2),
    generation: 1,
    owner: { kind: 'organization' as const, id: federationFixtureId('org', 1) },
    provider_identity: {
      provider: 'slack' as const,
      team_id: 'T123',
      enterprise_id: null,
      bot_user_id: 'U999',
      bot_id: 'B123',
      app_id: 'A123',
    },
  };
  return {
    surface: {
      binding: structuredClone(binding),
      connection: structuredClone(connection),
      presentation: {
        channel_id: 'C123',
        message_ts: '1752956990.000100',
        rendered_blocks_sha256: input.digestA,
      },
    },
    observation: {
      binding: structuredClone(binding),
      connection: structuredClone(connection),
      observed_by: structuredClone(input.artifact),
    },
    approver: {
      principal_id: input.principalId,
      membership_id: input.membershipId,
      claim_id: input.claimId,
    },
    raw_actor_assertion: {
      provider: 'slack',
      tenant_id: 'T123',
      subject_id: 'U123',
      display_name: 'Founder',
      channel_id: 'C123',
      message_ts: '1752956990.000100',
      action: {
        kind: 'reaction',
        name: 'white_check_mark',
        provider_occurred_at: null,
        observed_at: input.occurredAt,
      },
      reason_reply: null,
    },
    assurance: 'provider_challenge_observed',
    reviewed_at: input.occurredAt,
    reason: null,
    approved_brief_sha256: input.approvedBriefSha256,
    approved_context_sha256: `sha256:${'b'.repeat(64)}`,
  };
}

export async function signFederatedApprovalGroupDrafts(options: {
  signer: FixtureInstallationSigner;
  drafts: readonly FederatedOutboxEventDraft[];
  sequenceOffset?: number;
  previousEventHash?: Sha256Digest | null;
}): Promise<StoredFederatedOutboxEvent[]> {
  const stored: StoredFederatedOutboxEvent[] = [];
  const sequenceOffset = options.sequenceOffset ?? 0;
  let previousHash = options.previousEventHash ?? null;
  for (let index = 0; index < options.drafts.length; index += 1) {
    const draft = options.drafts[index]!;
    const sequence = sequenceOffset + index + 1;
    const envelope = await createSignedDocument(
      {
        ...structuredClone(draft.envelope),
        sequence,
        previous_event_hash: previousHash,
      },
      options.signer,
      options.signer.descriptor.installation_id,
      options.signer.descriptor.key_id,
    );
    const envelopeJson = canonicalJson(envelope);
    const eventHash = sha256Digest(envelopeJson);
    stored.push({
      event_id: envelope.event_id,
      installation_id: envelope.producer.installation_id,
      sequence,
      event_type: envelope.event_type,
      local_subject_key: draft.local_subject_key,
      previous_event_hash: previousHash,
      event_hash: eventHash,
      envelope_json: envelopeJson,
      envelope_bytes: Buffer.from(envelopeJson, 'utf8'),
      envelope,
      created_at: envelope.occurred_at,
    });
    previousHash = eventHash;
  }
  return stored;
}
