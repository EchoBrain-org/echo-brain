import {
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../../src/core/index.js';
import { ProductAdapterFactoryRegistry } from '../../src/product/adapter-factories.js';
import type { ProductRuntimeConfig } from '../../src/product/config.js';
import { runProductCli } from '../../src/product/cli.js';
import type { DecisionNodeState } from '../../src/product/approval/decision-node.js';
import { DecisionNodeStore } from '../../src/product/approval/decision-node-store.js';
import { FederatedApprovalCapture } from '../../src/product/federation/approval-capture.js';
import {
  commitFounderBootstrap,
  mintFounderBootstrapIds,
  planFounderBootstrap,
  type FounderBootstrapInput,
} from '../../src/product/federation/bootstrap.js';
import { canonicalSha256 } from '../../src/product/federation/canonical-json.js';
import type {
  AdapterBindingV1,
  PublicationSnapshotV1,
  ToolConnectionV1,
} from '../../src/product/federation/contracts.js';
import { createLocalCredentialGuard } from '../../src/product/federation/credential-guard.js';
import { federationId } from '../../src/product/federation/identifiers.js';
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from '../../src/product/federation/installation-signer.js';
import type { FounderFederationRuntime } from '../../src/product/federation/runtime-wiring.js';
import {
  normalizeP256LowS,
  p256KeyId,
} from '../../src/product/federation/signature-profile.js';

const NOW = '2026-07-19T23:30:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

class TestHardwareSigner implements InstallationSigner {
  private readonly keys = new Map<
    string,
    { privateKey: KeyObject; descriptor: InstallationKeyDescriptor }
  >();

  async generate(installationId: string): Promise<InstallationKeyDescriptor> {
    const existing = this.keys.get(installationId);
    if (existing !== undefined) return existing.descriptor;
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    const descriptor: InstallationKeyDescriptor = {
      installation_id: installationId,
      key_id: p256KeyId(publicKeyDer),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicKeyDer.toString('base64'),
      protection: 'secure-enclave',
      assurance: 'hardware_bound',
      private_key_exportable: false,
    };
    this.keys.set(installationId, { privateKey, descriptor });
    return descriptor;
  }

  async inspect(
    installationId: string,
  ): Promise<InstallationKeyDescriptor | null> {
    return this.keys.get(installationId)?.descriptor ?? null;
  }

  async sign(
    installationId: string,
    message: Buffer,
    expectedKeyId?: `sha256:${string}`,
  ): Promise<Buffer> {
    const key = this.keys.get(installationId);
    if (
      key === undefined ||
      (expectedKeyId !== undefined && expectedKeyId !== key.descriptor.key_id)
    ) {
      throw new Error('test installation signing identity mismatch');
    }
    return normalizeP256LowS(
      signMessage('sha256', message, {
        key: key.privateKey,
        dsaEncoding: 'der',
      }),
    );
  }
}

function output() {
  let value = '';
  return {
    stream: {
      write: (chunk: string | Uint8Array) => {
        value += chunk.toString();
        return true;
      },
    },
    read: () => value,
  };
}

function binding(
  capability: AdapterBindingV1['capability'],
  adapterId: string,
  instanceId: string,
  connectionId: string | null,
): AdapterBindingV1 {
  const configuration = {};
  return {
    adapter_binding_id: federationId('bnd'),
    capability,
    adapter_id: adapterId,
    instance_id: instanceId,
    connection_id: connectionId,
    connection_generation: connectionId === null ? null : 1,
    configuration_snapshot: configuration,
    configuration_sha256: canonicalSha256(configuration),
    created_at: NOW,
    ended_at: null,
    status: 'active',
  };
}

function granolaConnection(
  organizationId: string,
  membershipId: string,
): ToolConnectionV1 {
  return {
    connection_id: federationId('con'),
    organization_id: organizationId,
    owner: { kind: 'membership', id: membershipId },
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
            evidence_sha256: `sha256:${'1'.repeat(64)}`,
          },
        },
        local_credential_guard: createLocalCredentialGuard(
          'file:/private/local/granola-api-key',
          'granola-test-token',
          Buffer.alloc(16, 2),
        ),
      },
    ],
  };
}

function slackConnection(organizationId: string): ToolConnectionV1 {
  return {
    connection_id: federationId('con'),
    organization_id: organizationId,
    owner: { kind: 'organization', id: organizationId },
    provider: 'slack',
    generations: [
      {
        generation: 1,
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
            id: 'U_BOT',
            bot_id: 'B123',
            app_id: 'A123',
          },
          verification: {
            method: 'slack_auth_test',
            assurance: 'provider_verified',
            verified_at: NOW,
            evidence_sha256: `sha256:${'2'.repeat(64)}`,
          },
        },
        local_credential_guard: createLocalCredentialGuard(
          'file:/private/local/slack-bot-token',
          'slack-test-token',
          Buffer.alloc(16, 3),
        ),
      },
    ],
  };
}

function runtimeConfigFor(stateDirectory: string): ProductRuntimeConfig {
  return {
    schema_version: 1,
    lane: 'team-product',
    state_dir: stateDirectory,
    meeting_sources: [
      {
        adapter_id: 'granola',
        instance_id: 'primary',
        credential_ref: 'file:/private/local/granola-api-key',
        settings: {},
      },
    ],
    decision_processor: {
      adapter_id: 'structured-text',
      instance_id: 'primary',
      settings: {},
    },
    delivery_surfaces: [
      { adapter_id: 'jsonl-outbox', instance_id: 'local', settings: {} },
    ],
    approval_mode: 'adapter',
    approval_surface: {
      adapter_id: 'slack-reactions',
      instance_id: 'founder-approval',
      credential_ref: 'file:/private/local/slack-bot-token',
      settings: {},
    },
  };
}

async function bootstrapIdentity(stateDirectory: string) {
  const runtimeConfig = runtimeConfigFor(stateDirectory);
  const ids = mintFounderBootstrapIds();
  const granola = granolaConnection(ids.organization_id, ids.membership_id);
  const slack = slackConnection(ids.organization_id);
  const publication: PublicationSnapshotV1 = {
    payload_scope:
      'approved-signal-with-meeting-context-brief-digest-and-bounded-evidence',
    audience: {
      scope: 'organization',
      subjects: [{ kind: 'organization', id: ids.organization_id }],
    },
    sensitivity: 'internal',
    retention: { kind: 'indefinite' },
    raw_meeting_content: 'local-only',
    participant_observations: 'included-namespaced',
  };
  const input = {
    ids,
    organization_display_name: 'EchoBrain',
    principal_display_name: 'Founder',
    device_class: 'byod',
    created_at: NOW,
    identity_claims: [
      {
        claim_id: federationId('clm'),
        principal_id: ids.principal_id,
        issuer: { kind: 'provider', provider: 'slack', tenant_id: 'T123' },
        subject: { kind: 'user', id: 'U123' },
        verification: {
          method: 'slack_dm_challenge',
          assurance: 'provider_challenge_observed',
          verified_at: NOW,
          evidence_sha256: `sha256:${'3'.repeat(64)}`,
        },
      },
    ],
    connections: [granola, slack],
    bindings: [
      binding('meeting-source', 'granola', 'primary', granola.connection_id),
      binding('decision-processor', 'structured-text', 'primary', null),
      binding('delivery-surface', 'jsonl-outbox', 'local', null),
      binding(
        'approval-surface',
        'slack-reactions',
        'founder-approval',
        slack.connection_id,
      ),
    ],
    publication,
  } satisfies FounderBootstrapInput;
  const signer = new TestHardwareSigner();
  const descriptor = await signer.generate(ids.installation_id);
  const build = {
    loadBuildIdentity: () => ({
      schema_version: 1 as const,
      kind: 'echo-packaged-build-identity' as const,
      product_version: '0.1.0-dev.6',
      source_sha: 'a'.repeat(40),
      source_kind: 'materialized-commit' as const,
    }),
  };
  const plan = planFounderBootstrap(input, descriptor, build);
  await commitFounderBootstrap(runtimeConfig, plan, signer, build);
  return { runtimeConfig, signer };
}

function pendingNode(): DecisionNodeState {
  return {
    approval_id: 'a'.repeat(64),
    node_id: 'node-cli-retry',
    processing_key: 'processing:v1:cli-retry',
    requested_at: NOW,
    requested_metadata: { federation: { identity_manifest_id: 'test' } },
    brief: {
      schema_version: 1,
      id: 'brief-cli-retry',
      meeting: {
        id: 'meeting-cli-retry',
        title: 'Projection retry',
        time: { actual_start_at: NOW },
        participants: [],
      },
      decisions: [
        {
          id: 'decision-cli-retry',
          kind: 'decision',
          text: 'Retry the exact approved projection',
          subject: null,
          confidence: 1,
          evidence: [],
          status: 'decided',
        },
      ],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: 'revision-cli-retry',
        processor: {
          kind: 'decision-processor',
          adapter_id: 'structured-text',
          instance_id: 'primary',
          version: '1.0.0',
        },
        generated_at: NOW,
      },
    },
    alternatives: [],
    links: { parent: null, supersedes: null },
    status: 'pending',
    reviewed_at: null,
    reviewed_by: null,
    reason: null,
    resolved_surface: null,
    resolved_metadata: null,
    published: [],
  };
}

function legacyApprovalRequest(): ApprovalRequest {
  return {
    processing_key: 'legacy:dev6:meeting:revision:processor:primary:1.0.0',
    requested_at: NOW,
    meeting: {
      schema_version: 1,
      id: 'legacy-meeting',
      title: 'DEV.6 rehearsal',
      time: { actual_start_at: NOW },
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
        external_id: 'legacy-external',
        canonical_revision: 'legacy-revision',
        observed_at: NOW,
        normalizer_version: '1.0.0',
        source_updated_at: NOW,
      },
    },
    decisions: {
      schema_version: 1,
      meeting_id: 'legacy-meeting',
      meeting_revision: 'legacy-revision',
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
      id: 'legacy-brief',
      meeting: {
        id: 'legacy-meeting',
        title: 'DEV.6 rehearsal',
        time: { actual_start_at: NOW },
        participants: [],
      },
      decisions: [],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: 'legacy-revision',
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

function emptyCycleFactories(): ProductAdapterFactoryRegistry {
  const factories = new ProductAdapterFactoryRegistry();
  const common = (
    kind: string,
    adapterId: string,
    instanceId: string,
    version: string,
  ) => ({
    identity: {
      kind,
      adapter_id: adapterId,
      instance_id: instanceId,
      version,
    },
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async () => ({ status: 'healthy', checked_at: NOW }),
  });
  factories.register({
    kind: 'meeting-source',
    adapter_id: 'granola',
    create: (config) =>
      ({
        ...common('meeting-source', 'granola', config.instance_id, '2.2.0'),
        pull: async () => ({ meetings: [] }),
      }) as never,
  });
  factories.register({
    kind: 'decision-processor',
    adapter_id: 'structured-text',
    create: (config) =>
      ({
        ...common(
          'decision-processor',
          'structured-text',
          config.instance_id,
          '1.0.0',
        ),
        extract: async () => {
          throw new Error('empty meeting source must not invoke extraction');
        },
      }) as never,
  });
  factories.register({
    kind: 'delivery-surface',
    adapter_id: 'jsonl-outbox',
    create: (config) =>
      ({
        ...common(
          'delivery-surface',
          'jsonl-outbox',
          config.instance_id,
          '1.0.0',
        ),
        publish: async () => {
          throw new Error('empty meeting source must not invoke delivery');
        },
      }) as never,
  });
  factories.register({
    kind: 'approval-surface',
    adapter_id: 'slack-reactions',
    create: (config) =>
      ({
        ...common(
          'approval-surface',
          'slack-reactions',
          config.instance_id,
          '1.0.0',
        ),
        review: async () => {
          throw new Error('empty meeting source must not invoke approval');
        },
      }) as never,
  });
  return factories;
}

describe('identity-active CLI approval projection retry', () => {
  it('lists DEV.6 approvals and completes an empty cycle after identity activation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-federation-cli-legacy-'));
    roots.push(root);
    const stateDirectory = join(realpathSync(root), 'state');
    mkdirSync(stateDirectory, { mode: 0o700 });
    chmodSync(stateDirectory, 0o700);

    const legacyStore = new DecisionNodeStore(stateDirectory, {
      now: () => NOW,
    });
    const legacy = await legacyStore.ensureRequested(legacyApprovalRequest());
    const { runtimeConfig, signer } = await bootstrapIdentity(stateDirectory);
    const configPath = join(root, 'runtime.json');
    writeFileSync(configPath, `${JSON.stringify(runtimeConfig)}\n`, {
      mode: 0o600,
    });

    const capture = new FederatedApprovalCapture({
      stateDirectory,
      runtimeConfig,
    });
    const approvals = new DecisionNodeStore(stateDirectory, {
      now: () => NOW,
      federationCapture: capture,
    });
    const ready = async () => ({ ok: true, detail: 'ready' });
    const federationRuntime: FounderFederationRuntime = {
      identityEnabled: true,
      approvalCapture: capture,
      signer,
      createDecisionNodeStore: () => approvals,
      wrapCoreState: (state) => state,
      projectApproved: async () => [],
      identityChecks: (configured = {}) => ({
        ...configured,
        signer,
        approvalCaptureReady: ready,
        attributionStorageReady: ready,
        signedOutboxReady: ready,
        independentCopyReady: ready,
      }),
      close: async () => undefined,
    };
    const credentialResolver = (reference: string) =>
      reference === 'file:/private/local/granola-api-key'
        ? 'granola-test-token'
        : reference === 'file:/private/local/slack-bot-token'
          ? 'slack-test-token'
          : undefined;
    const common = {
      adapterFactories: emptyCycleFactories(),
      classifyStateFilesystem: async () => ({
        kind: 'local' as const,
        raw: 'apfs',
      }),
      now: () => NOW,
      identityCheck: { signer, credentialResolver },
      federationRuntime,
    };

    const approvalsOut = output();
    const approvalsErr = output();
    expect(
      await runProductCli(['approvals', '--config', configPath], {
        ...common,
        stdout: approvalsOut.stream,
        stderr: approvalsErr.stream,
      }),
    ).toBe(0);
    expect(approvalsErr.read()).toBe('');
    expect(JSON.parse(approvalsOut.read())).toMatchObject({
      ok: true,
      command: 'approvals',
      approvals: [
        {
          approval_id: legacy.approval_id,
          status: 'pending',
        },
      ],
    });
    expect(JSON.parse(approvalsOut.read()).approvals[0]).not.toHaveProperty(
      'federation',
    );

    const cycleOut = output();
    const cycleErr = output();
    expect(
      await runProductCli(['run-once', '--config', configPath], {
        ...common,
        stdout: cycleOut.stream,
        stderr: cycleErr.stream,
      }),
    ).toBe(0);
    expect(cycleErr.read()).toBe('');
    expect(JSON.parse(cycleOut.read())).toMatchObject({
      ok: true,
      command: 'run-once',
      cycle: { ok: true, meetings_seen: 0 },
      pending_approval_ids: [legacy.approval_id],
    });

    const mutationOut = output();
    const mutationErr = output();
    expect(
      await runProductCli(
        [
          'approve',
          '--config',
          configPath,
          '--id',
          legacy.approval_id,
          '--reviewer',
          'founder',
        ],
        {
          ...common,
          stdout: mutationOut.stream,
          stderr: mutationErr.stream,
        },
      ),
    ).toBe(1);
    expect(mutationOut.read()).toBe('');
    expect(JSON.parse(mutationErr.read())).toMatchObject({
      ok: false,
      command: 'approve',
      error: expect.stringContaining(
        'pre-cutover decision node is immutable after identity activation',
      ),
    });
    await expect(
      approvals.getState(legacy.processing_key),
    ).resolves.toMatchObject({
      status: 'pending',
      reviewed_at: null,
    });
  });

  it('records approval once, fails closed on projection, and heals by exact retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-federation-cli-retry-'));
    roots.push(root);
    const stateDirectory = join(realpathSync(root), 'state');
    mkdirSync(stateDirectory, { mode: 0o700 });
    chmodSync(stateDirectory, 0o700);
    const { runtimeConfig, signer } = await bootstrapIdentity(stateDirectory);
    const configPath = join(root, 'runtime.json');
    writeFileSync(configPath, `${JSON.stringify(runtimeConfig)}\n`, {
      mode: 0o600,
    });

    let node = pendingNode();
    let projected = false;
    const approvals = {
      initialize: vi.fn(async () => undefined),
      listFederated: vi.fn(async () => [node]),
      resolve: vi.fn(
        async (input: {
          status: 'approved' | 'rejected';
          reviewedBy: string;
          reason?: string | null;
        }) => {
          if (node.status === 'pending') {
            node = {
              ...node,
              status: input.status,
              reviewed_at: NOW,
              reviewed_by: input.reviewedBy,
              reason: input.reason ?? null,
              resolved_surface: 'cli',
              resolved_metadata: { federation: {} },
            };
          }
          return node;
        },
      ),
    } as unknown as DecisionNodeStore;
    let projectionAttempts = 0;
    const ready = async () => ({ ok: true, detail: 'ready' });
    const federationRuntime: FounderFederationRuntime = {
      identityEnabled: true,
      approvalCapture: {} as never,
      signer,
      createDecisionNodeStore: () => approvals,
      wrapCoreState: (state) => state,
      projectApproved: vi.fn(async () => {
        projectionAttempts += 1;
        if (projectionAttempts === 1) {
          throw new Error('simulated append interruption');
        }
        projected = true;
        return [];
      }),
      identityChecks: (configured = {}) => ({
        ...configured,
        signer,
        approvalCaptureReady: ready,
        attributionStorageReady: ready,
        signedOutboxReady: async () =>
          node.status === 'approved' && !projected
            ? {
                ok: false,
                detail: `projection pending: approval ${node.approval_id} has no signed outbox group`,
              }
            : { ok: true, detail: 'ready' },
        independentCopyReady: ready,
      }),
      close: vi.fn(async () => undefined),
    };
    const credentialResolver = (reference: string) =>
      reference === 'file:/private/local/granola-api-key'
        ? 'granola-test-token'
        : reference === 'file:/private/local/slack-bot-token'
          ? 'slack-test-token'
          : undefined;
    const common = {
      classifyStateFilesystem: async () => ({
        kind: 'local' as const,
        raw: 'apfs',
      }),
      now: () => NOW,
      identityCheck: { signer, credentialResolver },
      federationRuntime,
    };
    const argv = [
      'approve',
      '--config',
      configPath,
      '--id',
      node.approval_id,
      '--reviewer',
      'founder',
    ];

    const firstOut = output();
    const firstErr = output();
    expect(
      await runProductCli(argv, {
        ...common,
        stdout: firstOut.stream,
        stderr: firstErr.stream,
      }),
    ).toBe(1);
    expect(firstOut.read()).toBe('');
    expect(JSON.parse(firstErr.read())).toMatchObject({
      ok: false,
      command: 'approve',
      error: expect.stringContaining(
        'approval recorded; federated projection pending',
      ),
    });
    expect(node.status).toBe('approved');
    expect(projected).toBe(false);

    const retryOut = output();
    const retryErr = output();
    expect(
      await runProductCli(argv, {
        ...common,
        stdout: retryOut.stream,
        stderr: retryErr.stream,
      }),
    ).toBe(0);
    expect(retryErr.read()).toBe('');
    expect(JSON.parse(retryOut.read())).toMatchObject({
      ok: true,
      command: 'approve',
      approval: {
        approval_id: node.approval_id,
        status: 'approved',
        reviewed_by: 'founder',
      },
    });
    expect(projected).toBe(true);
    expect(projectionAttempts).toBe(2);
  });

  it('rejects partial composition and legacy runtime seams after cutover', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-federation-cli-seams-'));
    roots.push(root);
    const stateDirectory = join(realpathSync(root), 'state');
    mkdirSync(stateDirectory, { mode: 0o700 });
    chmodSync(stateDirectory, 0o700);
    const { runtimeConfig } = await bootstrapIdentity(stateDirectory);
    const configPath = join(root, 'runtime.json');
    writeFileSync(configPath, `${JSON.stringify(runtimeConfig)}\n`, {
      mode: 0o600,
    });
    const common = {
      classifyStateFilesystem: async () => ({
        kind: 'local' as const,
        raw: 'apfs',
      }),
      stdout: output().stream,
    };

    const compositionError = output();
    expect(
      await runProductCli(['run-once', '--config', configPath], {
        ...common,
        stderr: compositionError.stream,
        composition: { approvals: {} as DecisionNodeStore },
      }),
    ).toBe(1);
    expect(JSON.parse(compositionError.read())).toMatchObject({
      ok: false,
      code: 'identity_not_seed_grade',
      error: expect.stringContaining('caller-owned approval store'),
    });

    const approvalGateError = output();
    expect(
      await runProductCli(['run-once', '--config', configPath], {
        ...common,
        stderr: approvalGateError.stream,
        composition: { approvalGate: {} as never },
      }),
    ).toBe(1);
    expect(JSON.parse(approvalGateError.read())).toMatchObject({
      ok: false,
      code: 'identity_not_seed_grade',
      error: expect.stringContaining('caller-owned approval gate'),
    });

    const runtimeError = output();
    expect(
      await runProductCli(['run', '--config', configPath], {
        ...common,
        stderr: runtimeError.stream,
        runtime: {} as never,
      }),
    ).toBe(1);
    expect(JSON.parse(runtimeError.read())).toMatchObject({
      ok: false,
      code: 'identity_not_seed_grade',
      error: expect.stringContaining('legacy custom runtime wiring'),
    });
  });

  it('keeps the caller-owned approval-gate seam available before identity activation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-federation-cli-inactive-'));
    roots.push(root);
    const stateDirectory = join(realpathSync(root), 'state');
    mkdirSync(stateDirectory, { mode: 0o700 });
    chmodSync(stateDirectory, 0o700);
    const runtimeConfig = runtimeConfigFor(stateDirectory);
    const configPath = join(root, 'runtime.json');
    writeFileSync(configPath, `${JSON.stringify(runtimeConfig)}\n`, {
      mode: 0o600,
    });

    const stdout = output();
    const stderr = output();
    expect(
      await runProductCli(['run-once', '--config', configPath], {
        adapterFactories: emptyCycleFactories(),
        classifyStateFilesystem: async () => ({
          kind: 'local' as const,
          raw: 'apfs',
        }),
        now: () => NOW,
        composition: {
          approvalGate: {
            review: async () => {
              throw new Error('empty meeting source must not request approval');
            },
          },
        },
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).toBe(0);
    expect(stderr.read()).toBe('');
    expect(JSON.parse(stdout.read())).toMatchObject({
      ok: true,
      command: 'run-once',
      cycle: { ok: true, meetings_seen: 0 },
      pending_approval_ids: [],
    });
  });
});
