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
import type { GranolaApiClient } from '../../src/adapters/meeting-sources/granola/index.js';
import type {
  SlackAuthIdentity,
  SlackDirectMessage,
  SlackPostMessageInput,
  SlackPostedMessage,
  SlackReaction,
} from '../../src/adapters/shared/slack/slack-web-api-client.js';
import type { ApprovalRequest } from '../../src/core/index.js';
import { ProductAdapterFactoryRegistry } from '../../src/product/adapter-factories.js';
import type { ProductRuntimeConfig } from '../../src/product/config.js';
import { runProductCli } from '../../src/product/cli.js';
import type { DecisionNodeState } from '../../src/product/approval/decision-node.js';
import { DecisionNodeStore } from '../../src/product/approval/decision-node-store.js';
import { FederatedApprovalCapture } from '../../src/product/federation/approval-capture.js';
import {
  beginFounderBootstrap,
  commitFounderBootstrapCeremony,
  statusFounderBootstrap,
  type FounderBootstrapCeremonyDependencies,
} from '../../src/product/federation/founder-bootstrap-ceremony.js';
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from '../../src/product/federation/installation-signer.js';
import type { FounderFederationRuntime } from '../../src/product/federation/runtime-wiring.js';
import {
  normalizeP256LowS,
  p256KeyId,
} from '../../src/product/federation/signature-profile.js';
import type { SlackDmChallengeApi } from '../../src/product/federation/slack-dm-challenge.js';

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

function runtimeConfigFor(stateDirectory: string): ProductRuntimeConfig {
  const credentialDirectory = join(stateDirectory, 'credentials');
  return {
    schema_version: 1,
    lane: 'team-product',
    state_dir: stateDirectory,
    meeting_sources: [
      {
        adapter_id: 'granola',
        instance_id: 'primary',
        credential_ref: `file:${join(credentialDirectory, 'granola-api-key')}`,
        settings: { page_size: 1 },
      },
    ],
    decision_processor: {
      adapter_id: 'structured-text',
      instance_id: 'primary',
      settings: {},
    },
    delivery_surfaces: [
      {
        adapter_id: 'jsonl-outbox',
        instance_id: 'local',
        settings: { path: join(stateDirectory, 'delivery', 'decisions.jsonl') },
      },
    ],
    approval_mode: 'adapter',
    approval_surface: {
      adapter_id: 'slack-reactions',
      instance_id: 'founder-approval',
      credential_ref: `file:${join(credentialDirectory, 'slack-bot-token')}`,
      settings: {
        channel_id: 'C123APPROVALS',
        reviewer: { slack_user_id: 'U123FOUNDER', name: 'Founder' },
      },
    },
  };
}

class BootstrapSlackApi implements SlackDmChallengeApi {
  readonly identity: SlackAuthIdentity = {
    team_id: 'T123TEAM',
    enterprise_id: null,
    user_id: 'U123BOT',
    bot_id: 'B123BOT',
    app_id: 'A123APP',
  };

  async authIdentity(): Promise<SlackAuthIdentity> {
    return this.identity;
  }

  async openDirectMessage(userId: string): Promise<SlackDirectMessage> {
    return { channel_id: 'D123FOUNDER', user_id: userId };
  }

  async postMessage(
    _input: SlackPostMessageInput,
  ): Promise<SlackPostedMessage> {
    return { channel: 'D123FOUNDER', ts: '1752966000.000001' };
  }

  async reactionsGet(): Promise<readonly SlackReaction[]> {
    return [
      {
        name: 'white_check_mark',
        users: ['U123FOUNDER'],
        count: 1,
      },
    ];
  }
}

class BootstrapGranolaApi implements GranolaApiClient {
  async listNotes() {
    return {
      notes: [{ id: 'not_bootstrap_evidence' }],
      hasMore: false,
      cursor: null,
    };
  }

  async getNote(): Promise<never> {
    throw new Error('bootstrap must not fetch Granola note detail');
  }
}

async function bootstrapIdentity(stateDirectory: string) {
  const runtimeConfig = runtimeConfigFor(stateDirectory);
  const signer = new TestHardwareSigner();
  const slack = new BootstrapSlackApi();
  const granola = new BootstrapGranolaApi();
  const credentialResolver = (reference: string) =>
    reference.endsWith('/granola-api-key')
      ? 'granola-test-token'
      : reference.endsWith('/slack-bot-token')
        ? 'slack-test-token'
        : undefined;
  const dependencies: FounderBootstrapCeremonyDependencies = {
    signer,
    credentialResolver,
    slackApiFactory: () => slack,
    granolaApiFactory: () => granola,
    loadBuildIdentity: () => ({
      schema_version: 1 as const,
      kind: 'echo-packaged-build-identity' as const,
      product_version: '0.1.0-dev.6',
      source_sha: 'a'.repeat(40),
      source_kind: 'materialized-commit' as const,
    }),
    now: () => NOW,
    sessionIdFactory: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    authorizeSeedCutover: async () => undefined,
    finalizeSeedCutover: async () => undefined,
  };
  const begun = await beginFounderBootstrap(
    runtimeConfig,
    {
      organizationDisplayName: 'EchoBrain',
      principalDisplayName: 'Founder',
      slackUserId: 'U123FOUNDER',
    },
    dependencies,
  );
  const ready = await statusFounderBootstrap(
    runtimeConfig,
    begun.session_id,
    {},
    dependencies,
  );
  await commitFounderBootstrapCeremony(
    runtimeConfig,
    begun.session_id,
    ready.confirmation!.confirmation_sha256,
    dependencies,
  );
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
  it('runs the CLI export repair route and rechecks strict identity readiness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-federation-cli-export-'));
    roots.push(root);
    const stateDirectory = join(realpathSync(root), 'state');
    mkdirSync(stateDirectory, { mode: 0o700 });
    chmodSync(stateDirectory, 0o700);
    const { runtimeConfig, signer } = await bootstrapIdentity(stateDirectory);
    const configPath = join(root, 'runtime.json');
    writeFileSync(configPath, `${JSON.stringify(runtimeConfig)}\n`, {
      mode: 0o600,
    });
    let repaired = false;
    let closed = false;
    const ready = async () => ({ ok: true, detail: 'ready' });
    const federationRuntime: FounderFederationRuntime = {
      identityEnabled: true,
      approvalCapture: {} as never,
      signer,
      createDecisionNodeStore: () =>
        new DecisionNodeStore(stateDirectory) as never,
      wrapCoreState: (state) => state,
      projectApproved: async () => [],
      ensureIndependentCopy: async () => {
        repaired = true;
        return {
          ok: true,
          detail: 'protected copy repaired and reverified',
          copied_installations: 1,
          copied_events: 3,
        };
      },
      identityChecks: (configured = {}) => ({
        ...configured,
        signer,
        legacyBoundaryReady: ready,
        approvalCaptureReady: ready,
        attributionStorageReady: ready,
        signedOutboxReady: ready,
        independentCopyReady: async () =>
          repaired
            ? { ok: true, detail: 'protected copy repaired' }
            : { ok: false, detail: 'protected copy is stale' },
      }),
      close: async () => {
        closed = true;
      },
    };
    const credentialResolver = (reference: string) =>
      reference.endsWith('/granola-api-key')
        ? 'granola-test-token'
        : reference.endsWith('/slack-bot-token')
          ? 'slack-test-token'
          : undefined;
    const stdout = output();
    const stderr = output();

    expect(
      await runProductCli(['export', '--config', configPath], {
        federationRuntime,
        identityCheck: { signer, credentialResolver },
        classifyStateFilesystem: async () => ({
          kind: 'local',
          raw: 'apfs',
        }),
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).toBe(0);
    expect(stderr.read()).toBe('');
    expect(JSON.parse(stdout.read())).toMatchObject({
      ok: true,
      command: 'export',
      independent_copy: {
        detail: 'protected copy repaired and reverified',
        copied_installations: 1,
        copied_events: 3,
      },
      identity: { seed_grade_ready: true },
    });
    expect(repaired).toBe(true);
    expect(closed).toBe(true);
  });

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
      ensureIndependentCopy: async () => ({
        ok: true,
        detail: 'ready',
        copied_installations: 0,
        copied_events: 0,
      }),
      identityChecks: (configured = {}) => ({
        ...configured,
        signer,
        legacyBoundaryReady: ready,
        approvalCaptureReady: ready,
        attributionStorageReady: ready,
        signedOutboxReady: ready,
        independentCopyReady: ready,
      }),
      close: async () => undefined,
    };
    const credentialResolver = (reference: string) =>
      reference.endsWith('/granola-api-key')
        ? 'granola-test-token'
        : reference.endsWith('/slack-bot-token')
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
      ensureIndependentCopy: async () => ({
        ok: true,
        detail: 'ready',
        copied_installations: 0,
        copied_events: 0,
      }),
      identityChecks: (configured = {}) => ({
        ...configured,
        signer,
        legacyBoundaryReady: ready,
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
      reference.endsWith('/granola-api-key')
        ? 'granola-test-token'
        : reference.endsWith('/slack-bot-token')
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

  it('retries a failed independent copy without duplicating the signed projection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-federation-cli-copy-retry-'));
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
    let reviewTransitions = 0;
    let signedProjectionAppends = 0;
    let signedProjectionExists = false;
    let independentCopyAttempts = 0;
    let independentCopyVerified = false;
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
            reviewTransitions += 1;
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
    const ready = async () => ({ ok: true, detail: 'ready' });
    const federationRuntime: FounderFederationRuntime = {
      identityEnabled: true,
      approvalCapture: {} as never,
      signer,
      createDecisionNodeStore: () => approvals,
      wrapCoreState: (state) => state,
      projectApproved: vi.fn(async () => {
        if (!signedProjectionExists) {
          signedProjectionExists = true;
          signedProjectionAppends += 1;
        }
        independentCopyAttempts += 1;
        if (independentCopyAttempts === 1) {
          throw new Error('simulated protected-copy interruption');
        }
        independentCopyVerified = true;
        return [];
      }),
      ensureIndependentCopy: async () => ({
        ok: independentCopyVerified,
        detail: independentCopyVerified
          ? 'ready'
          : 'protected independent copy is stale',
        copied_installations: independentCopyVerified ? 1 : 0,
        copied_events: independentCopyVerified ? 1 : 0,
      }),
      identityChecks: (configured = {}) => ({
        ...configured,
        signer,
        legacyBoundaryReady: ready,
        approvalCaptureReady: ready,
        attributionStorageReady: ready,
        signedOutboxReady: async () =>
          node.status === 'approved' && !signedProjectionExists
            ? {
                ok: false,
                detail: `projection pending: approval ${node.approval_id} has no signed outbox group`,
              }
            : { ok: true, detail: 'ready' },
        independentCopyReady: async () =>
          signedProjectionExists && !independentCopyVerified
            ? {
                ok: false,
                detail: 'protected independent copy is stale',
              }
            : { ok: true, detail: 'ready' },
      }),
      close: vi.fn(async () => undefined),
    };
    const credentialResolver = (reference: string) =>
      reference.endsWith('/granola-api-key')
        ? 'granola-test-token'
        : reference.endsWith('/slack-bot-token')
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
    expect(reviewTransitions).toBe(1);
    expect(signedProjectionAppends).toBe(1);
    expect(independentCopyAttempts).toBe(1);
    expect(independentCopyVerified).toBe(false);

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
    expect(reviewTransitions).toBe(1);
    expect(signedProjectionAppends).toBe(1);
    expect(independentCopyAttempts).toBe(2);
    expect(independentCopyVerified).toBe(true);
    expect(federationRuntime.projectApproved).toHaveBeenCalledTimes(2);
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
