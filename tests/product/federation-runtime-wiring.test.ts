import {
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreStateStore } from '../../src/core/storage/core-state-store.js';
import type { ProductRuntimeConfig } from '../../src/product/config.js';
import type { DecisionNodeState } from '../../src/product/approval/decision-node.js';
import type { VerifiedActiveIdentityBundle } from '../../src/product/federation/active-identity-bundle-store.js';
import { ApprovalProjectingCoreStateStore } from '../../src/product/federation/approval-projecting-core-state-store.js';
import { SqliteFederatedAttributionStore } from '../../src/product/federation/attribution-store.js';
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from '../../src/product/federation/installation-signer.js';
import { FederatedOutboxStore } from '../../src/product/federation/outbox-store.js';
import type { StoredFederatedOutboxEvent } from '../../src/product/federation/outbox-store.js';
import {
  canonicalJson,
  canonicalSha256,
} from '../../src/product/federation/canonical-json.js';
import type {
  ApprovalFederationMetadataV1,
  ProcessorAttributionV1,
  ProductArtifactIdentityV1,
  SourceAttributionV1,
} from '../../src/product/federation/contracts.js';
import {
  normalizeP256LowS,
  p256KeyId,
} from '../../src/product/federation/signature-profile.js';
import { openFounderFederationRuntime } from '../../src/product/federation/runtime-wiring.js';
import { buildFederatedProjectionSnapshots } from '../../src/product/federation/record-projector.js';

const NOW = '2026-07-19T23:30:00.000Z';
const INSTALLATION_ID = 'ins_00000000-0000-4000-8000-000000000001';
const MANIFEST_ID = 'idm_00000000-0000-4000-8000-000000000001';
const POLICY_SHA256 = `sha256:${'9'.repeat(64)}` as const;
const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = 'prn_00000000-0000-4000-8000-000000000001';
const MEMBERSHIP_ID = 'mem_00000000-0000-4000-8000-000000000001';
const EVIDENCE_ARTIFACT: ProductArtifactIdentityV1 = {
  product_version: '0.1.0-dev.7',
  source_sha: 'a'.repeat(40),
  artifact_sha256: `sha256:${'b'.repeat(64)}`,
};
const PROJECTION_ARTIFACT: ProductArtifactIdentityV1 = {
  product_version: '0.1.0-dev.8',
  source_sha: 'c'.repeat(40),
  artifact_sha256: `sha256:${'d'.repeat(64)}`,
};
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function stateDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'echo-federation-runtime-'));
  roots.push(root);
  return root;
}

function config(stateDir: string): ProductRuntimeConfig {
  return {
    schema_version: 1,
    lane: 'team-product',
    state_dir: stateDir,
    meeting_sources: [],
    decision_processor: {
      adapter_id: 'structured-text',
      instance_id: 'primary',
      settings: {},
    },
    delivery_surfaces: [],
    approval_mode: 'manual',
  };
}

class TestSigner implements InstallationSigner {
  private readonly privateKey: KeyObject;
  readonly descriptor: InstallationKeyDescriptor;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    this.privateKey = privateKey;
    this.descriptor = {
      installation_id: INSTALLATION_ID,
      key_id: p256KeyId(publicKeyDer),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicKeyDer.toString('base64'),
      protection: 'secure-enclave',
      assurance: 'hardware_bound',
      private_key_exportable: false,
    };
  }

  async generate(): Promise<InstallationKeyDescriptor> {
    return this.descriptor;
  }

  async inspect(
    installationId: string,
  ): Promise<InstallationKeyDescriptor | null> {
    return installationId === INSTALLATION_ID ? this.descriptor : null;
  }

  async sign(
    installationId: string,
    message: Buffer,
    expectedKeyId?: `sha256:${string}`,
  ): Promise<Buffer> {
    if (
      installationId !== INSTALLATION_ID ||
      expectedKeyId !== this.descriptor.key_id
    ) {
      throw new Error('test signing identity mismatch');
    }
    return normalizeP256LowS(
      signMessage('sha256', message, {
        key: this.privateKey,
        dsaEncoding: 'der',
      }),
    );
  }
}

function activeBundle(signer: TestSigner): VerifiedActiveIdentityBundle {
  return {
    manifest: {
      manifest_id: MANIFEST_ID,
      organization: {
        organization_id: ORGANIZATION_ID,
      },
      principal: {
        principal_id: PRINCIPAL_ID,
      },
      membership: {
        membership_id: MEMBERSHIP_ID,
      },
      installation: {
        installation_id: INSTALLATION_ID,
        signing_key: {
          key_id: signer.descriptor.key_id,
          public_key_spki_der_base64:
            signer.descriptor.public_key_spki_der_base64,
        },
      },
    },
  } as unknown as VerifiedActiveIdentityBundle;
}

function baseState(): CoreStateStore & { close: () => void } {
  return {
    getSourceCursor: vi.fn(async () => undefined),
    setSourceCursor: vi.fn(async () => undefined),
    hasProcessed: vi.fn(async () => false),
    saveMeeting: vi.fn(async () => undefined),
    getDecisionSet: vi.fn(async () => undefined),
    saveDecisionSet: vi.fn(async () => undefined),
    getApproval: vi.fn(async () => undefined),
    saveApproval: vi.fn(async () => undefined),
    saveDeliveryReceipt: vi.fn(async () => undefined),
    markProcessed: vi.fn(async () => undefined),
    close: vi.fn(),
  };
}

function sourceAttribution(): SourceAttributionV1 {
  return {
    schema_version: 1,
    kind: 'echo-source-attribution',
    source_observation_id: 'obs_00000000-0000-4000-8000-000000000001',
    organization_id: ORGANIZATION_ID,
    identity_manifest_id: MANIFEST_ID,
    source: {
      adapter_binding_id: 'bnd_00000000-0000-4000-8000-000000000001',
      adapter: {
        kind: 'meeting-source',
        adapter_id: 'granola',
        instance_id: 'primary',
        version: '2.2.0',
      },
      configuration_snapshot: {},
      configuration_sha256: canonicalSha256({}),
    },
    connection: {
      connection_id: 'con_00000000-0000-4000-8000-000000000001',
      generation: 1,
      owner: { kind: 'membership', id: MEMBERSHIP_ID },
      provider: 'granola',
      provider_identity: {
        tenant: null,
        subject: null,
        verification_method: 'provider_first_capture',
        assurance: 'credential_observed',
      },
    },
    meeting: {
      external_id: 'external-1',
      canonical_revision: 'revision-1',
      document_sha256: `sha256:${'1'.repeat(64)}`,
    },
    participant_observations: [],
    captured_by: EVIDENCE_ARTIFACT,
    captured_at: '2026-07-19T22:15:00.000Z',
  };
}

function processorAttribution(): ProcessorAttributionV1 {
  return {
    schema_version: 1,
    kind: 'echo-processor-attribution',
    identity_manifest_id: MANIFEST_ID,
    meeting: {
      source_adapter_id: 'granola',
      source_instance_id: 'primary',
      external_id: 'external-1',
      meeting_revision: 'revision-1',
    },
    processor: {
      adapter_binding_id: 'bnd_00000000-0000-4000-8000-000000000002',
      adapter: {
        kind: 'decision-processor',
        adapter_id: 'structured-text',
        instance_id: 'primary',
        version: '1.0.0',
      },
      configuration_snapshot: {},
      configuration_sha256: canonicalSha256({}),
      decision_set_sha256: `sha256:${'2'.repeat(64)}`,
    },
    produced_by: EVIDENCE_ARTIFACT,
    captured_at: '2026-07-19T22:30:00.000Z',
  };
}

function approvedNode(
  signer: TestSigner,
  source: SourceAttributionV1,
  processor: ProcessorAttributionV1,
): { node: DecisionNodeState; metadata: ApprovalFederationMetadataV1 } {
  const candidateContextSha256 = `sha256:${'4'.repeat(64)}` as const;
  const metadata: ApprovalFederationMetadataV1 = {
    schema_version: 1,
    identity_manifest_id: MANIFEST_ID,
    source_attribution_ref: {
      source_adapter_id: 'granola',
      source_instance_id: 'primary',
      external_id: 'external-1',
      meeting_revision: 'revision-1',
      attribution_sha256: canonicalSha256(source),
    },
    processor: {
      adapter_binding_id: processor.processor.adapter_binding_id,
      adapter: processor.processor
        .adapter as ApprovalFederationMetadataV1['processor']['adapter'],
      configuration_snapshot: processor.processor.configuration_snapshot,
      configuration_sha256: processor.processor.configuration_sha256,
      attribution_sha256: canonicalSha256(processor),
    },
    approval_surface: {
      binding: {
        adapter_binding_id: 'bnd_00000000-0000-4000-8000-000000000003',
        adapter: {
          kind: 'approval-surface',
          adapter_id: 'cli',
          instance_id: 'local',
          version: '1.0.0',
        },
        configuration_snapshot: {},
        configuration_sha256: canonicalSha256({}),
      },
      connection: null,
    },
    publication: {
      policy_id: 'pol_00000000-0000-4000-8000-000000000001',
      version: 1,
      policy_sha256: POLICY_SHA256,
      identity_manifest_id: MANIFEST_ID,
      signer_installation_id: INSTALLATION_ID,
      signer_key_id: signer.descriptor.key_id,
      payload_scope:
        'approved-signal-with-meeting-context-brief-digest-and-bounded-evidence',
      audience: {
        scope: 'organization',
        subjects: [{ kind: 'organization', id: ORGANIZATION_ID }],
      },
      sensitivity: 'internal',
      retention: { kind: 'indefinite' },
      raw_meeting_content: 'local-only',
      participant_observations: 'included-namespaced',
    },
    candidate_context_sha256: candidateContextSha256,
  };
  const reviewedAt = '2026-07-19T23:15:00.000Z';
  const node: DecisionNodeState = {
    approval_id: 'a'.repeat(64),
    node_id: 'node-1',
    processing_key: 'processing:v1:test',
    requested_at: '2026-07-19T23:00:00.000Z',
    requested_metadata: { federation: metadata as unknown as never },
    brief: {
      schema_version: 1,
      id: 'brief-1',
      meeting: {
        id: 'meeting-1',
        title: 'Founder projection retry',
        time: { actual_start_at: '2026-07-19T22:00:00.000Z' },
        participants: [],
      },
      decisions: [
        {
          id: 'decision-1',
          kind: 'decision',
          text: 'Ship the retry-safe projection gate',
          subject: null,
          confidence: 1,
          evidence: [],
          status: 'decided',
        },
      ],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: 'revision-1',
        processor: {
          kind: 'decision-processor',
          adapter_id: 'structured-text',
          instance_id: 'primary',
          version: '1.0.0',
        },
        generated_at: '2026-07-19T22:30:00.000Z',
      },
    },
    alternatives: [],
    links: { parent: null, supersedes: null },
    status: 'approved',
    reviewed_at: reviewedAt,
    reviewed_by: 'founder',
    reason: null,
    resolved_surface: 'cli',
    resolved_metadata: {
      federation: {
        actor: {
          principal_id: PRINCIPAL_ID,
          membership_id: MEMBERSHIP_ID,
          claim_id: null,
          raw_assertion: {
            surface: 'cli',
            installation_id: INSTALLATION_ID,
            reviewer_label: 'founder',
            command: 'approve',
            observed_at: reviewedAt,
          },
          assurance: 'installation_holder_self_attested',
        },
        approval_context: {
          candidate_context_sha256: candidateContextSha256,
          presentation: null,
          approved_context_sha256: canonicalSha256({
            domain: 'echo.approved-context.v1',
            candidate_context_sha256: candidateContextSha256,
            presentation: null,
          }),
        },
        approval_surface_observation: {
          installation_id: INSTALLATION_ID,
          key_id: signer.descriptor.key_id,
          observed_by: EVIDENCE_ARTIFACT as unknown as never,
        },
      },
    },
    published: [],
  };
  return { node, metadata };
}

describe('founder federation runtime wiring', () => {
  it('leaves inactive rehearsal state and resources untouched', async () => {
    const stateDir = stateDirectory();
    const base = baseState();
    const artifactCurrent = vi.fn(() => {
      throw new Error('inactive runtime must not inspect artifacts');
    });
    const runtime = await openFounderFederationRuntime({
      runtimeConfig: config(stateDir),
      databasePath: join(stateDir, 'echo-brain.sqlite'),
      identityStore: {
        hasActiveBundle: () => false,
        hasIdentityMaterial: () => false,
        loadVerified: () => null,
      },
      artifactProvider: { current: artifactCurrent, verify: vi.fn() },
    });

    expect(runtime.identityEnabled).toBe(false);
    expect(runtime.wrapCoreState(base, runtime.createDecisionNodeStore())).toBe(
      base,
    );
    await expect(runtime.projectApproved({} as never)).rejects.toThrow(
      /inactive rehearsal records/,
    );
    await runtime.close();
    expect(artifactCurrent).not.toHaveBeenCalled();
    expect(base.close).not.toHaveBeenCalled();
  });

  it('shares active resources across readiness and the projection state gate', async () => {
    const stateDir = stateDirectory();
    const signer = new TestSigner();
    const attribution = new SqliteFederatedAttributionStore(':memory:');
    const outbox = new FederatedOutboxStore(':memory:');
    const artifact = {
      product_version: '0.1.0-dev.7',
      source_sha: 'a'.repeat(40),
      artifact_sha256: `sha256:${'b'.repeat(64)}` as const,
    };
    const verifyArtifact = vi.fn();
    const runtimeCopyCheck = vi.fn(async () => ({
      ok: true,
      detail: 'runtime-owned protected-copy evidence',
      copied_installations: 0,
      copied_events: 0,
    }));
    const runtime = await openFounderFederationRuntime({
      runtimeConfig: config(stateDir),
      databasePath: ':memory:',
      signer,
      identityStore: {
        hasActiveBundle: () => true,
        hasIdentityMaterial: () => true,
        loadVerified: () => activeBundle(signer),
      },
      lineage: {} as never,
      attributionStore: attribution,
      outbox,
      independentCopyStore: {
        check: runtimeCopyCheck,
        ensure: vi.fn(async () => ({
          ok: true,
          detail: 'runtime-owned protected-copy evidence',
          copied_installations: 0,
          copied_events: 0,
        })),
      },
      artifactProvider: {
        current: () => artifact,
        verify: verifyArtifact,
      },
      now: () => NOW,
    });

    expect(runtime.identityEnabled).toBe(true);
    const callerProbe = vi.fn(async () => ({
      ok: false,
      detail: 'caller must not replace a runtime-owned probe',
    }));
    const independentCopyReady = vi.fn(async () => ({
      ok: true,
      detail: 'external protected-copy evidence',
    }));
    const checks = runtime.identityChecks({
      approvalCaptureReady: callerProbe,
      attributionStorageReady: callerProbe,
      signedOutboxReady: callerProbe,
      independentCopyReady,
    });
    await expect(checks.approvalCaptureReady!()).resolves.toMatchObject({
      ok: true,
    });
    await expect(checks.attributionStorageReady!()).resolves.toMatchObject({
      ok: true,
    });
    await expect(checks.signedOutboxReady!()).resolves.toMatchObject({
      ok: true,
    });
    await expect(checks.independentCopyReady!()).resolves.toMatchObject({
      ok: true,
    });
    expect(callerProbe).not.toHaveBeenCalled();
    expect(independentCopyReady).not.toHaveBeenCalled();
    expect(runtimeCopyCheck).toHaveBeenCalledOnce();
    expect(verifyArtifact).toHaveBeenCalledWith(artifact);

    const base = baseState();
    const decisions = runtime.createDecisionNodeStore();
    const state = runtime.wrapCoreState(base, decisions);
    expect(state).toBeInstanceOf(ApprovalProjectingCoreStateStore);
    state.close?.();
    expect(base.close).toHaveBeenCalledOnce();

    await runtime.close();
    await expect(
      outbox.readInstallationEvents(INSTALLATION_ID),
    ).rejects.toThrow(/closed/);
    await runtime.close();
  });

  it('heals an exact projection retry but rejects divergent approval evidence and retired projection artifacts', async () => {
    const stateDir = stateDirectory();
    const signer = new TestSigner();
    const source = sourceAttribution();
    const processor = processorAttribution();
    const { node, metadata } = approvedNode(signer, source, processor);
    const manifest = activeBundle(signer).manifest;
    const manifestSha256 = `sha256:${'c'.repeat(64)}` as const;
    const publication = metadata.publication;
    let events: readonly StoredFederatedOutboxEvent[] = [];
    const outbox = {
      appendApprovalGroup: vi.fn(),
      readByLocalSubject: vi.fn(),
      readInstallationEvents: vi.fn(async () => events),
      listInstallationIds: vi.fn(async () => [INSTALLATION_ID]),
      verifyInstallationChain: vi.fn(async (_installationId, keySource) => {
        if (typeof keySource === 'function') {
          for (const event of events) keySource(event);
        }
        return { head: null, events };
      }),
      close: vi.fn(async () => undefined),
    } as unknown as FederatedOutboxStore;
    const lineage = {
      assertManifestAncestorOrEqual: vi.fn(),
      loadVerifiedManifest: () => ({
        manifest,
        canonical: '{}',
        sha256: manifestSha256,
      }),
      loadVerifiedManifestBySha256: () => ({
        manifest,
        canonical: '{}',
        sha256: manifestSha256,
      }),
      loadVerifiedPolicy: () => ({
        manifest,
        canonical: '{}',
        sha256: POLICY_SHA256,
        policy: {
          policy_id: publication.policy_id,
          version: publication.version,
          identity_manifest_id: publication.identity_manifest_id,
          issued_by: {
            installation_id: publication.signer_installation_id,
            key_id: publication.signer_key_id,
          },
          publication: {
            payload_scope: publication.payload_scope,
            audience: publication.audience,
            sensitivity: publication.sensitivity,
            retention: publication.retention,
            raw_meeting_content: publication.raw_meeting_content,
            participant_observations: publication.participant_observations,
          },
        },
      }),
    } as never;
    const attributions = {
      getAttributionsForMetadata: vi.fn(async () => ({ source, processor })),
      verifyStoredAttributions: vi.fn(() => ({
        source_attributions: 1,
        processor_attributions: 1,
      })),
      close: vi.fn(),
    } as unknown as SqliteFederatedAttributionStore;
    let projectionArtifactRetired = false;
    const artifactProvider = {
      current: () => EVIDENCE_ARTIFACT,
      verify: vi.fn((value: ProductArtifactIdentityV1) => {
        if (
          projectionArtifactRetired &&
          canonicalJson(value) === canonicalJson(PROJECTION_ARTIFACT)
        ) {
          throw new Error('projection artifact evidence is retired');
        }
      }),
    };
    const runtime = await openFounderFederationRuntime({
      runtimeConfig: config(stateDir),
      databasePath: ':memory:',
      signer,
      identityStore: {
        hasActiveBundle: () => true,
        hasIdentityMaterial: () => true,
        loadVerified: () => activeBundle(signer),
      },
      lineage,
      attributionStore: attributions,
      outbox,
      projectionDecisionNodes: {
        listFederated: async () => [node],
      },
      artifactProvider,
      now: () => NOW,
    });
    const probe = runtime.identityChecks().signedOutboxReady!;

    await expect(probe()).resolves.toEqual({
      ok: false,
      detail: `projection pending: approval ${node.approval_id} has no signed outbox group`,
    });

    const signal = node.brief.decisions[0]!;
    const approvedBriefSha256 = canonicalSha256(node.brief);
    const snapshots = buildFederatedProjectionSnapshots({
      state: node,
      metadata,
      manifest,
      sourceAttribution: source,
      processorAttribution: processor,
      lineage,
      artifactProvider,
    });
    events = [
      {
        installation_id: INSTALLATION_ID,
        local_subject_key: `approved-org-record:${node.approval_id}:${signal.id}`,
        envelope: {
          organization_id: manifest.organization.organization_id,
          occurred_at: node.reviewed_at,
          producer: {
            installation_id: INSTALLATION_ID,
            principal_id: manifest.principal.principal_id,
            membership_id: manifest.membership.membership_id,
            key_id: signer.descriptor.key_id,
            membership_assertion: {
              status: 'active',
              authority: 'local-founder-bootstrap',
              assurance: 'founder_attested',
            },
            product_artifact: PROJECTION_ARTIFACT,
          },
          source: snapshots.source,
          processor: snapshots.processor,
          publication,
          identity_manifest_sha256: manifestSha256,
          local_reference: {
            processing_key: node.processing_key,
            approval_id: node.approval_id,
            node_id: node.node_id,
            meeting_id: node.brief.meeting.id,
            signal_id: signal.id,
          },
          record: {
            signal_id: signal.id,
            signal,
            meeting_context: node.brief.meeting,
            approval_group: {
              brief_schema_version: node.brief.schema_version,
              brief_id: node.brief.id,
              approved_brief_sha256: approvedBriefSha256,
              signal_manifest: [
                {
                  signal_id: signal.id,
                  kind: signal.kind,
                  position_within_kind: 0,
                  sha256: canonicalSha256(signal),
                },
              ],
            },
          },
          approval: snapshots.approval,
        },
      } as unknown as StoredFederatedOutboxEvent,
    ];

    await expect(probe()).resolves.toMatchObject({ ok: true });

    const validEvent = events[0]!;
    const divergentActor = JSON.parse(
      canonicalJson(validEvent),
    ) as unknown as StoredFederatedOutboxEvent;
    if (divergentActor.envelope.approval.surface !== null) {
      throw new Error('test fixture expected CLI approval evidence');
    }
    divergentActor.envelope.approval.raw_actor_assertion.reviewer_label =
      'different-actor';
    events = [divergentActor];
    await expect(probe()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('projection differs from its node'),
    });

    const divergentTool = JSON.parse(
      canonicalJson(validEvent),
    ) as unknown as StoredFederatedOutboxEvent;
    if (divergentTool.envelope.approval.surface !== null) {
      throw new Error('test fixture expected CLI approval evidence');
    }
    divergentTool.envelope.approval.observed_by = {
      ...divergentTool.envelope.approval.observed_by,
      product_version: '0.1.0-retired-tool',
    };
    events = [divergentTool];
    await expect(probe()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('projection differs from its node'),
    });

    events = [validEvent];
    projectionArtifactRetired = true;
    await expect(probe()).resolves.toEqual({
      ok: false,
      detail:
        'signed outbox is unavailable or invalid: projection artifact evidence is retired',
    });
    await runtime.close();
  });
});
