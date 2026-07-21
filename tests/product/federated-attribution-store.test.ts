import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LLM_DECISION_PROCESSOR_PROMPT_VERSION,
  LLM_DECISION_PROCESSOR_SCHEMA_VERSION,
} from '../../src/adapters/decision-processors/llm/llm-decision-processor.js';
import type { ApprovalRequest } from '../../src/core/approval/approval-gate.js';
import type { CoreStateStore } from '../../src/core/storage/core-state-store.js';
import type { DecisionSet } from '../../src/core/contracts/decision.js';
import type { MeetingDocument } from '../../src/core/contracts/meeting.js';
import { SqliteCoreStateStore } from '../../src/product/storage/sqlite-core-state-store.js';
import type { VerifiedActiveIdentityBundle } from '../../src/product/federation/identity/active-identity-bundle-store.js';
import { SqliteFederatedAttributionStore } from '../../src/product/federation/attribution-store.js';
import {
  AttributingCoreStateStore,
  createAttributionStorageEvidenceVerifier,
  type AttributionArtifactProvider,
  type AttributionIdentityLineageReader,
} from '../../src/product/federation/attributing-core-state-store.js';
import {
  canonicalJson,
  canonicalSha256,
} from '../../src/product/federation/foundation/canonical-json.js';
import type {
  ApprovalFederationMetadataV1,
  ProductArtifactIdentityV1,
} from '../../src/product/federation/contracts.js';
import { testBinding, testConnection } from './fixtures/founder-identity.js';
import { activeIdentityBundleFixture } from './fixtures/federated-records.js';

const BEFORE = '2026-07-19T20:00:00.000Z';
const NOW = '2026-07-19T20:30:00.000Z';
const AFTER_ROTATION = '2026-07-19T21:00:00.000Z';
const IDS = {
  organization: 'org_10000000-0000-4000-8000-000000000001',
  principal: 'prn_10000000-0000-4000-8000-000000000002',
  membership: 'mem_10000000-0000-4000-8000-000000000003',
  device: 'dev_10000000-0000-4000-8000-000000000004',
  installation: 'ins_10000000-0000-4000-8000-000000000005',
  manifest: 'idm_10000000-0000-4000-8000-000000000006',
  registry: 'reg_10000000-0000-4000-8000-000000000007',
  policy: 'pol_10000000-0000-4000-8000-000000000008',
  sourceConnection: 'con_10000000-0000-4000-8000-000000000009',
  sourceBinding: 'bnd_10000000-0000-4000-8000-00000000000a',
  processorBinding: 'bnd_10000000-0000-4000-8000-00000000000b',
  approvalBinding: 'bnd_10000000-0000-4000-8000-00000000000c',
  observation: 'obs_10000000-0000-4000-8000-00000000000d',
};
const ARTIFACT: ProductArtifactIdentityV1 = {
  product_version: '0.1.0-dev.6',
  source_sha: '1'.repeat(40),
  artifact_sha256: `sha256:${'2'.repeat(64)}`,
};
const ROTATED_ARTIFACT: ProductArtifactIdentityV1 = {
  product_version: '0.1.0-dev.7',
  source_sha: 'a'.repeat(40),
  artifact_sha256: `sha256:${'b'.repeat(64)}`,
};
const INTEGRITY = {
  canonicalization: 'RFC8785' as const,
  payload_sha256: `sha256:${'3'.repeat(64)}` as const,
  signature_algorithm: 'ecdsa-p256-sha256-der-low-s' as const,
  key_id: `sha256:${'4'.repeat(64)}` as const,
  signature_base64: 'AQ==',
};

const meeting: MeetingDocument = {
  schema_version: 1,
  id: 'granola:primary:not-1',
  title: 'Founder planning',
  capture: { state: 'complete', components: [] },
  participants: [
    {
      id: 'not-1:participant:1',
      display_name: 'Ada',
      identities: [
        { kind: 'source', value: 'person-1' },
        { kind: 'email', value: 'ada@example.test' },
        { kind: 'phone', value: '+14155550123' },
        { kind: 'other', value: 'guest-1' },
      ],
    },
  ],
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
    normalizer_version: '1.0.0',
  },
};

const decisions: DecisionSet = {
  schema_version: 1,
  meeting_id: meeting.id,
  meeting_revision: meeting.provenance.canonical_revision,
  processor: {
    kind: 'decision-processor',
    adapter_id: 'structured-text',
    instance_id: 'primary',
    version: '1.0.0',
  },
  generated_at: NOW,
  signals: [],
};

function bundle(): VerifiedActiveIdentityBundle {
  const sourceConfiguration = { page_size: 100 };
  const processorConfiguration = { prompt_version: 'structured-text-v1' };
  return activeIdentityBundleFixture({
    ids: IDS,
    at: BEFORE,
    artifact: ARTIFACT,
    signingKey: {
      key_id: INTEGRITY.key_id,
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: 'AQ==',
      protection: 'secure-enclave',
      assurance: 'hardware_bound',
    },
    connections: [
      testConnection({
        connectionId: IDS.sourceConnection,
        organizationId: IDS.organization,
        owner: { kind: 'membership', id: IDS.membership },
        provider: 'granola',
        activeAt: BEFORE,
        providerIdentity: {
          tenant: null,
          subject: null,
          verification: {
            method: 'provider_first_capture',
            assurance: 'credential_observed',
            verified_at: BEFORE,
            evidence_sha256: `sha256:${'5'.repeat(64)}`,
          },
        },
        credentialGuard: {
          reference: 'file:/private/tmp/granola-token',
          algorithm: 'sha256-salted',
          salt_base64: 'AQ==',
          digest: `sha256:${'6'.repeat(64)}`,
          exportable: false,
        },
      }),
    ],
    bindings: [
      testBinding({
        adapterBindingId: IDS.sourceBinding,
        capability: 'meeting-source',
        adapterId: 'granola',
        instanceId: 'primary',
        connectionId: IDS.sourceConnection,
        createdAt: BEFORE,
        configuration: sourceConfiguration,
      }),
      testBinding({
        adapterBindingId: IDS.processorBinding,
        capability: 'decision-processor',
        adapterId: 'structured-text',
        instanceId: 'primary',
        connectionId: null,
        createdAt: BEFORE,
        configuration: processorConfiguration,
      }),
    ],
    integrity: INTEGRITY,
    referenceDigests: {
      manifest: `sha256:${'7'.repeat(64)}`,
      registry: `sha256:${'8'.repeat(64)}`,
      policy: `sha256:${'9'.repeat(64)}`,
    },
  });
}
function artifactProvider(): AttributionArtifactProvider {
  return {
    current: () => ARTIFACT,
    verify(value) {
      if (canonicalJson(value) !== canonicalJson(ARTIFACT)) {
        throw new Error('untrusted artifact');
      }
    },
  };
}

function rotatedBundle(): VerifiedActiveIdentityBundle {
  const value = structuredClone(bundle());
  const manifestId = 'idm_20000000-0000-4000-8000-000000000006';
  const registryId = 'reg_20000000-0000-4000-8000-000000000007';
  const sourceBindingId = 'bnd_20000000-0000-4000-8000-00000000000a';
  const processorBindingId = 'bnd_20000000-0000-4000-8000-00000000000b';
  const rotatedKeyId = `sha256:${'c'.repeat(64)}` as const;

  value.manifest.manifest_id = manifestId;
  value.manifest.predecessor_manifest_id = IDS.manifest;
  value.manifest.created_at = AFTER_ROTATION;
  value.manifest.installation.product = {
    name: 'echo-brain',
    version: ROTATED_ARTIFACT.product_version,
    source_sha: ROTATED_ARTIFACT.source_sha,
  };
  value.manifest.installation.signing_key.key_id = rotatedKeyId;
  value.manifest.integrity.key_id = rotatedKeyId;
  value.pointer.manifest.manifest_id = manifestId;
  value.pointer.connection_registry.registry_id = registryId;
  value.pointer.activated_at = AFTER_ROTATION;
  value.pointer.integrity.key_id = rotatedKeyId;
  value.connectionRegistry.registry_id = registryId;
  value.connectionRegistry.identity_manifest_id = manifestId;
  value.connectionRegistry.updated_at = AFTER_ROTATION;
  value.connectionRegistry.integrity.key_id = rotatedKeyId;

  const connection = value.connectionRegistry.connections[0]!;
  connection.generations[0]!.ended_at = AFTER_ROTATION;
  connection.generations = [
    ...connection.generations,
    {
      ...structuredClone(connection.generations[0]!),
      generation: 2,
      active_from: AFTER_ROTATION,
      ended_at: null,
      local_credential_guard: {
        ...structuredClone(connection.generations[0]!.local_credential_guard),
        digest: `sha256:${'d'.repeat(64)}`,
      },
    },
  ];

  const sourceBinding = value.connectionRegistry.bindings[0]!;
  sourceBinding.adapter_binding_id = sourceBindingId;
  sourceBinding.connection_generation = 2;
  sourceBinding.configuration_snapshot = { page_size: 25 };
  sourceBinding.configuration_sha256 = canonicalSha256(
    sourceBinding.configuration_snapshot,
  );
  sourceBinding.created_at = AFTER_ROTATION;

  const processorBinding = value.connectionRegistry.bindings[1]!;
  processorBinding.adapter_binding_id = processorBindingId;
  processorBinding.configuration_snapshot = {
    prompt_version: 'structured-text-v2',
  };
  processorBinding.configuration_sha256 = canonicalSha256(
    processorBinding.configuration_snapshot,
  );
  processorBinding.created_at = AFTER_ROTATION;

  value.publicationPolicy.identity_manifest_id = manifestId;
  value.publicationPolicy.issued_by.key_id = rotatedKeyId;
  value.publicationPolicy.integrity.key_id = rotatedKeyId;
  return value;
}

function rotatingArtifactProvider(holder: {
  current: ProductArtifactIdentityV1;
  currentCalls: number;
}): AttributionArtifactProvider {
  return {
    current: () => {
      holder.currentCalls += 1;
      return holder.current;
    },
    verify(value) {
      if (
        ![ARTIFACT, ROTATED_ARTIFACT].some(
          (trusted) => canonicalJson(value) === canonicalJson(trusted),
        )
      ) {
        throw new Error('untrusted artifact');
      }
    },
  };
}

function lineageReader(
  ...bundles: VerifiedActiveIdentityBundle[]
): AttributionIdentityLineageReader {
  return {
    assertManifestAncestorOrEqual(ancestorManifestId, descendantManifestId) {
      const seen = new Set<string>();
      let current = bundles.find(
        (item) => item.manifest.manifest_id === descendantManifestId,
      );
      while (current !== undefined) {
        if (current.manifest.manifest_id === ancestorManifestId) return;
        if (seen.has(current.manifest.manifest_id)) break;
        seen.add(current.manifest.manifest_id);
        const predecessor = current.manifest.predecessor_manifest_id;
        current =
          predecessor === null
            ? undefined
            : bundles.find((item) => item.manifest.manifest_id === predecessor);
      }
      throw new Error('test lineage: manifest order is reversed or unanchored');
    },
    resolveBindingAt(reference, observedAt) {
      const selected = bundles.find(
        (item) => item.manifest.manifest_id === reference.identity_manifest_id,
      );
      if (selected === undefined) {
        throw new Error('historical manifest is unavailable');
      }
      const binding = selected.connectionRegistry.bindings.find(
        (item) => item.adapter_binding_id === reference.adapter_binding_id,
      );
      if (
        binding === undefined ||
        binding.capability !== reference.capability ||
        binding.adapter_id !== reference.adapter_id ||
        binding.instance_id !== reference.instance_id ||
        binding.configuration_sha256 !== reference.configuration_sha256 ||
        canonicalJson(binding.configuration_snapshot) !==
          canonicalJson(reference.configuration_snapshot) ||
        binding.connection_id !== reference.connection_id ||
        binding.connection_generation !== reference.connection_generation ||
        binding.created_at > observedAt ||
        (binding.ended_at !== null && observedAt >= binding.ended_at)
      ) {
        throw new Error('historical binding does not match');
      }
      const connection =
        reference.connection_id === null
          ? null
          : (selected.connectionRegistry.connections.find(
              (item) => item.connection_id === reference.connection_id,
            ) ?? null);
      const generation =
        reference.connection_generation === null
          ? null
          : (connection?.generations.find(
              (item) => item.generation === reference.connection_generation,
            ) ?? null);
      const revision = {
        registry: selected.connectionRegistry,
        canonical: canonicalJson(selected.connectionRegistry),
        sha256: canonicalSha256(selected.connectionRegistry),
      };
      return {
        manifest: selected.manifest,
        chain: {
          registry_id: selected.connectionRegistry.registry_id,
          identity_manifest_id: selected.manifest.manifest_id,
          revisions: [revision],
        },
        revision,
        binding,
        connection,
        generation,
      };
    },
  };
}

function identityReader(holder: {
  active: boolean;
  material: boolean;
  current: VerifiedActiveIdentityBundle;
}) {
  return {
    hasActiveBundle: () => holder.active,
    hasIdentityMaterial: () => holder.material,
    loadVerified: () => (holder.active ? holder.current : null),
  };
}

function proxyCore(
  core: SqliteCoreStateStore,
  overrides: Partial<CoreStateStore>,
): CoreStateStore & { close(): void } {
  return new Proxy(core, {
    get(target, property) {
      const override = overrides[property as keyof CoreStateStore];
      if (override !== undefined) return override;
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as CoreStateStore & { close(): void };
}

const temporaryDirectories: string[] = [];

function temporaryDatabase(): { root: string; database: string } {
  const root = mkdtempSync(join(tmpdir(), 'echo-federated-attribution-'));
  temporaryDirectories.push(root);
  return { root, database: join(root, 'echo-brain.sqlite') };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Founder Live attribution persistence', () => {
  it('installs the approved additive migration and leaves identity-inactive saves unchanged', async () => {
    const paths = temporaryDatabase();
    const core = new SqliteCoreStateStore(paths.database);
    const holder = { active: false, material: false, current: bundle() };
    const state = new AttributingCoreStateStore(core, {
      stateDirectory: paths.root,
      databasePath: paths.database,
      identityBundleReader: identityReader(holder),
    });

    await state.saveMeeting(meeting);
    await state.saveDecisionSet(meeting, decisions);
    state.close();

    const db = new Database(paths.database, { readonly: true });
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'federated_%'
         ORDER BY name`,
      )
      .all() as { name: string }[];
    expect(tables.map((row) => row.name)).toEqual([
      'federated_chain_heads',
      'federated_outbox_events',
      'federated_processor_attributions',
      'federated_source_attributions',
    ]);
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM federated_source_attributions')
        .get(),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM federated_processor_attributions',
        )
        .get(),
    ).toEqual({ count: 0 });
    db.close();
  });

  it('freezes source observation and extraction facts before core persistence', async () => {
    const paths = temporaryDatabase();
    const core = new SqliteCoreStateStore(paths.database);
    const holder = { active: true, material: true, current: bundle() };
    const state = new AttributingCoreStateStore(core, {
      stateDirectory: paths.root,
      databasePath: paths.database,
      artifactProvider: artifactProvider(),
      identityBundleReader: identityReader(holder),
      now: () => NOW,
      createObservationId: () => IDS.observation,
    });

    await state.saveMeeting(meeting);
    await state.saveDecisionSet(meeting, decisions);

    const pair = await state.attributions.getAttributions({
      processing_key: 'unchanged-processing-key',
      requested_at: NOW,
      meeting,
      decisions,
      brief: {
        schema_version: 1,
        id: 'brief-1',
        meeting: { id: meeting.id, participants: meeting.participants },
        decisions: [],
        actions: [],
        rationales: [],
        provenance: {
          meeting_revision: meeting.provenance.canonical_revision,
          processor: decisions.processor,
          generated_at: decisions.generated_at,
        },
      },
    });
    expect(pair.source.source_observation_id).toBe(IDS.observation);
    expect(pair.source.meeting.document_sha256).toBe(canonicalSha256(meeting));
    expect(pair.source.connection).toMatchObject({
      connection_id: IDS.sourceConnection,
      generation: 1,
      provider: 'granola',
      provider_identity: {
        tenant: null,
        subject: null,
        verification_method: 'provider_first_capture',
        assurance: 'credential_observed',
      },
    });
    expect(pair.source.participant_observations).toEqual([
      {
        meeting_participant_id: 'not-1:participant:1',
        display_name: 'Ada',
        observed_claims: [
          {
            namespace: `provider:granola:${IDS.sourceConnection}`,
            kind: 'source',
            value: 'person-1',
          },
          {
            namespace: 'internet:rfc5322-email',
            kind: 'email',
            value: 'ada@example.test',
          },
          {
            namespace: 'internet:telephone',
            kind: 'phone',
            value: '+14155550123',
          },
          {
            namespace: `provider:granola:${IDS.sourceConnection}:other`,
            kind: 'other',
            value: 'guest-1',
          },
        ],
      },
    ]);
    expect(pair.processor).toMatchObject({
      identity_manifest_id: IDS.manifest,
      processor: {
        adapter_binding_id: IDS.processorBinding,
        decision_set_sha256: canonicalSha256(decisions),
      },
      produced_by: ARTIFACT,
      captured_at: NOW,
    });
    expect(state.attributions.verifyStoredAttributions()).toEqual({
      source_attributions: 1,
      processor_attributions: 1,
    });

    const db = new Database(paths.database, { readonly: true });
    const sourceRow = db
      .prepare('SELECT attribution_json FROM federated_source_attributions')
      .get() as { attribution_json: string };
    const processorRow = db
      .prepare('SELECT attribution_json FROM federated_processor_attributions')
      .get() as { attribution_json: string };
    expect(sourceRow.attribution_json).toBe(canonicalJson(pair.source));
    expect(processorRow.attribution_json).toBe(canonicalJson(pair.processor));
    db.close();
    state.close();
  });

  it('continues one meeting from source manifest A into processor manifest B', async () => {
    const paths = temporaryDatabase();
    const sourceBundle = bundle();
    const processorBundle = rotatedBundle();
    const holder = {
      active: true,
      material: true,
      current: sourceBundle,
    };
    const artifact = { current: ARTIFACT, currentCalls: 0 };
    let clock = NOW;
    const state = new AttributingCoreStateStore(
      new SqliteCoreStateStore(paths.database),
      {
        stateDirectory: paths.root,
        databasePath: paths.database,
        artifactProvider: rotatingArtifactProvider(artifact),
        identityBundleReader: identityReader(holder),
        identityLineageReader: lineageReader(sourceBundle, processorBundle),
        now: () => clock,
        createObservationId: () => IDS.observation,
      },
    );

    await state.saveMeeting(meeting);
    holder.current = processorBundle;
    artifact.current = ROTATED_ARTIFACT;
    clock = AFTER_ROTATION;
    await state.saveDecisionSet(meeting, decisions);

    const pair = await state.attributions.getAttributions({
      processing_key: 'unchanged-processing-key',
      requested_at: AFTER_ROTATION,
      meeting,
      decisions,
      brief: {
        schema_version: 1,
        id: 'brief-rotated-lineage',
        meeting: { id: meeting.id, participants: meeting.participants },
        decisions: [],
        actions: [],
        rationales: [],
        provenance: {
          meeting_revision: meeting.provenance.canonical_revision,
          processor: decisions.processor,
          generated_at: decisions.generated_at,
        },
      },
    });
    expect(pair.source.identity_manifest_id).toBe(
      sourceBundle.manifest.manifest_id,
    );
    expect(pair.processor.identity_manifest_id).toBe(
      processorBundle.manifest.manifest_id,
    );
    const evidenceVerifier = createAttributionStorageEvidenceVerifier(
      lineageReader(sourceBundle, processorBundle),
      rotatingArtifactProvider(artifact),
    );
    expect(() =>
      evidenceVerifier.verifyAttributionPair(
        {
          ...pair.source,
          identity_manifest_id: processorBundle.manifest.manifest_id,
        },
        {
          ...pair.processor,
          identity_manifest_id: sourceBundle.manifest.manifest_id,
        },
      ),
    ).toThrow(/manifest order is reversed or unanchored/);
    expect(() => state.attributions.verifyStoredAttributions()).toThrow(
      /cross-manifest attribution pair requires historical lineage verification/,
    );
    expect(
      state.attributions.verifyStoredAttributions(evidenceVerifier),
    ).toEqual({ source_attributions: 1, processor_attributions: 1 });
    state.close();
  });

  it('persists the code-owned LLM prompt version with extraction attribution', async () => {
    const paths = temporaryDatabase();
    const current = bundle();
    const processorBinding = current.connectionRegistry.bindings[1]!;
    processorBinding.adapter_id = 'llm';
    processorBinding.instance_id = 'ollama-qwen3-4b';
    processorBinding.configuration_snapshot = {
      model: 'qwen3:4b',
      base_url: 'http://127.0.0.1:11434',
      request_timeout_ms: 240_000,
      prompt_version: LLM_DECISION_PROCESSOR_PROMPT_VERSION,
      output_schema_version: LLM_DECISION_PROCESSOR_SCHEMA_VERSION,
    };
    processorBinding.configuration_sha256 = canonicalSha256(
      processorBinding.configuration_snapshot,
    );
    const llmDecisions: DecisionSet = {
      ...decisions,
      processor: {
        kind: 'decision-processor',
        adapter_id: 'llm',
        instance_id: 'ollama-qwen3-4b',
        version: '1.0.0',
      },
    };
    const core = new SqliteCoreStateStore(paths.database);
    const holder = { active: true, material: true, current };
    const state = new AttributingCoreStateStore(core, {
      stateDirectory: paths.root,
      databasePath: paths.database,
      artifactProvider: artifactProvider(),
      identityBundleReader: identityReader(holder),
      now: () => NOW,
      createObservationId: () => IDS.observation,
    });
    await state.saveMeeting(meeting);

    processorBinding.connection_id =
      current.connectionRegistry.connections[0]!.connection_id;
    processorBinding.connection_generation = 1;
    await expect(state.saveDecisionSet(meeting, llmDecisions)).rejects.toThrow(
      /processor attribution requires a local uncredentialed binding/,
    );
    processorBinding.connection_id = null;
    processorBinding.connection_generation = null;

    processorBinding.configuration_snapshot['provider'] = 'openai';
    processorBinding.configuration_sha256 = canonicalSha256(
      processorBinding.configuration_snapshot,
    );
    await expect(state.saveDecisionSet(meeting, llmDecisions)).rejects.toThrow(
      /hosted LLM federation requires connection-aware processor attribution/,
    );
    delete processorBinding.configuration_snapshot['provider'];
    processorBinding.configuration_sha256 = canonicalSha256(
      processorBinding.configuration_snapshot,
    );

    const promptVersion =
      processorBinding.configuration_snapshot['prompt_version'];
    delete processorBinding.configuration_snapshot['prompt_version'];
    processorBinding.configuration_sha256 = canonicalSha256(
      processorBinding.configuration_snapshot,
    );
    await expect(state.saveDecisionSet(meeting, llmDecisions)).rejects.toThrow(
      /lacks the code-owned prompt or output-schema version/,
    );
    processorBinding.configuration_snapshot['prompt_version'] = promptVersion!;
    processorBinding.configuration_sha256 = canonicalSha256(
      processorBinding.configuration_snapshot,
    );
    await state.saveDecisionSet(meeting, llmDecisions);

    expect(
      state.attributions.getProcessorAttribution({
        source_adapter_id: 'granola',
        source_instance_id: 'primary',
        external_id: 'not-1',
        meeting_revision: 'rev-1',
        processor_adapter_id: 'llm',
        processor_instance_id: 'ollama-qwen3-4b',
        processor_version: '1.0.0',
      })?.processor.configuration_snapshot,
    ).toEqual(processorBinding.configuration_snapshot);
    state.close();
  });

  it('is retry-safe when a sidecar commits before the delegated save crashes', async () => {
    const paths = temporaryDatabase();
    const core = new SqliteCoreStateStore(paths.database);
    let failMeetingOnce = true;
    let failProcessorOnce = true;
    const delegate = proxyCore(core, {
      saveMeeting: async (value) => {
        if (failMeetingOnce) {
          failMeetingOnce = false;
          throw new Error('simulated core save crash');
        }
        await core.saveMeeting(value);
      },
      saveDecisionSet: async (inputMeeting, value) => {
        if (failProcessorOnce) {
          failProcessorOnce = false;
          throw new Error('simulated decision-set save crash');
        }
        await core.saveDecisionSet(inputMeeting, value);
      },
    });
    const historical = bundle();
    const holder = { active: true, material: true, current: historical };
    const state = new AttributingCoreStateStore(delegate, {
      stateDirectory: paths.root,
      databasePath: paths.database,
      artifactProvider: artifactProvider(),
      identityBundleReader: identityReader(holder),
      identityLineageReader: lineageReader(historical),
      now: () => NOW,
      createObservationId: () => IDS.observation,
    });

    await expect(state.saveMeeting(meeting)).rejects.toThrow(
      /simulated core save crash/,
    );
    const db = new Database(paths.database, { readonly: true });
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM federated_source_attributions')
        .get(),
    ).toEqual({ count: 1 });
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM core_meeting_documents').get(),
    ).toEqual({ count: 0 });
    db.close();

    await state.saveMeeting(meeting);
    expect(
      state.attributions.getSourceAttribution({
        source_adapter_id: 'granola',
        source_instance_id: 'primary',
        external_id: 'not-1',
        meeting_revision: 'rev-1',
      })?.source_observation_id,
    ).toBe(IDS.observation);
    await expect(state.saveDecisionSet(meeting, decisions)).rejects.toThrow(
      /simulated decision-set save crash/,
    );
    const afterProcessorCrash = new Database(paths.database, {
      readonly: true,
    });
    expect(
      afterProcessorCrash
        .prepare(
          'SELECT COUNT(*) AS count FROM federated_processor_attributions',
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      afterProcessorCrash
        .prepare('SELECT COUNT(*) AS count FROM core_decision_sets')
        .get(),
    ).toEqual({ count: 0 });
    afterProcessorCrash.close();
    await state.saveDecisionSet(meeting, decisions);
    state.close();
  });

  it('passes the strict restart gate only for historically verified recoverable sidecars', async () => {
    const paths = temporaryDatabase();
    const historical = bundle();
    const holder = { active: true, material: true, current: historical };
    const firstCore = new SqliteCoreStateStore(paths.database);
    const firstState = new AttributingCoreStateStore(
      proxyCore(firstCore, {
        saveMeeting: async () => {
          throw new Error('simulated process loss before core meeting save');
        },
      }),
      {
        stateDirectory: paths.root,
        databasePath: paths.database,
        artifactProvider: artifactProvider(),
        identityBundleReader: identityReader(holder),
        identityLineageReader: lineageReader(historical),
        now: () => NOW,
        createObservationId: () => IDS.observation,
      },
    );

    await expect(firstState.saveMeeting(meeting)).rejects.toThrow(
      /simulated process loss/,
    );
    firstState.close();

    const restartedGateStore = new SqliteFederatedAttributionStore(
      paths.database,
    );
    expect(() => restartedGateStore.verifyStoredAttributions()).toThrow(
      /requires historical evidence verification/,
    );
    expect(() =>
      restartedGateStore.verifyStoredAttributions({
        verifySourceAttribution() {
          throw new Error('historical evidence is unavailable');
        },
        verifyProcessorAttribution() {
          throw new Error('historical evidence is unavailable');
        },
        verifyAttributionPair() {
          throw new Error('historical evidence is unavailable');
        },
      }),
    ).toThrow(/historical evidence is unavailable/);
    const evidenceVerifier = createAttributionStorageEvidenceVerifier(
      lineageReader(historical),
      artifactProvider(),
    );
    expect(
      restartedGateStore.verifyStoredAttributions(evidenceVerifier),
    ).toEqual({
      source_attributions: 1,
      processor_attributions: 0,
    });
    restartedGateStore.close();

    const restartedCore = new SqliteCoreStateStore(paths.database);
    const restartedState = new AttributingCoreStateStore(restartedCore, {
      stateDirectory: paths.root,
      databasePath: paths.database,
      artifactProvider: artifactProvider(),
      identityBundleReader: identityReader(holder),
      identityLineageReader: lineageReader(historical),
      now: () => AFTER_ROTATION,
      createObservationId: () => {
        throw new Error('restart must reuse the frozen observation ID');
      },
    });
    await restartedState.saveMeeting(meeting);
    expect(
      restartedState.attributions.verifyStoredAttributions(evidenceVerifier),
    ).toEqual({
      source_attributions: 1,
      processor_attributions: 0,
    });
    restartedState.close();
  });

  it('reuses the exact source sidecar after identity and artifact rotation when core persistence crashed', async () => {
    const paths = temporaryDatabase();
    const core = new SqliteCoreStateStore(paths.database);
    let failMeetingOnce = true;
    const delegate = proxyCore(core, {
      saveMeeting: async (value) => {
        if (failMeetingOnce) {
          failMeetingOnce = false;
          throw new Error('simulated core save crash');
        }
        await core.saveMeeting(value);
      },
    });
    const historical = bundle();
    const holder = { active: true, material: true, current: historical };
    const artifact = { current: ARTIFACT, currentCalls: 0 };
    let clock = NOW;
    const state = new AttributingCoreStateStore(delegate, {
      stateDirectory: paths.root,
      databasePath: paths.database,
      artifactProvider: rotatingArtifactProvider(artifact),
      identityBundleReader: identityReader(holder),
      identityLineageReader: lineageReader(historical),
      now: () => clock,
      createObservationId: () => IDS.observation,
    });

    await expect(state.saveMeeting(meeting)).rejects.toThrow(
      /simulated core save crash/,
    );
    const frozen = state.attributions.getSourceAttribution({
      source_adapter_id: 'granola',
      source_instance_id: 'primary',
      external_id: 'not-1',
      meeting_revision: 'rev-1',
    })!;
    expect(artifact.currentCalls).toBe(1);

    holder.current = rotatedBundle();
    artifact.current = ROTATED_ARTIFACT;
    clock = AFTER_ROTATION;
    await state.saveMeeting(meeting);

    expect(
      state.attributions.getSourceAttribution({
        source_adapter_id: 'granola',
        source_instance_id: 'primary',
        external_id: 'not-1',
        meeting_revision: 'rev-1',
      }),
    ).toEqual(frozen);
    expect(frozen).toMatchObject({
      identity_manifest_id: IDS.manifest,
      source: { adapter_binding_id: IDS.sourceBinding },
      connection: { generation: 1 },
      captured_by: ARTIFACT,
      captured_at: NOW,
    });
    expect(artifact.currentCalls).toBe(1);
    const materializedMeeting = new Database(paths.database, {
      readonly: true,
    });
    expect(
      materializedMeeting
        .prepare('SELECT COUNT(*) AS count FROM core_meeting_documents')
        .get(),
    ).toEqual({ count: 1 });
    materializedMeeting.close();
    state.close();
  });

  it('reuses the exact processor sidecar after identity and artifact rotation when core persistence crashed', async () => {
    const paths = temporaryDatabase();
    const core = new SqliteCoreStateStore(paths.database);
    let failProcessorOnce = true;
    const delegate = proxyCore(core, {
      saveDecisionSet: async (inputMeeting, value) => {
        if (failProcessorOnce) {
          failProcessorOnce = false;
          throw new Error('simulated decision-set save crash');
        }
        await core.saveDecisionSet(inputMeeting, value);
      },
    });
    const historical = bundle();
    const holder = { active: true, material: true, current: historical };
    const artifact = { current: ARTIFACT, currentCalls: 0 };
    let clock = NOW;
    const state = new AttributingCoreStateStore(delegate, {
      stateDirectory: paths.root,
      databasePath: paths.database,
      artifactProvider: rotatingArtifactProvider(artifact),
      identityBundleReader: identityReader(holder),
      identityLineageReader: lineageReader(historical),
      now: () => clock,
      createObservationId: () => IDS.observation,
    });
    await state.saveMeeting(meeting);
    await expect(state.saveDecisionSet(meeting, decisions)).rejects.toThrow(
      /simulated decision-set save crash/,
    );
    const frozen = state.attributions.getProcessorAttribution({
      source_adapter_id: 'granola',
      source_instance_id: 'primary',
      external_id: 'not-1',
      meeting_revision: 'rev-1',
      processor_adapter_id: 'structured-text',
      processor_instance_id: 'primary',
      processor_version: '1.0.0',
    })!;
    expect(artifact.currentCalls).toBe(2);

    holder.current = rotatedBundle();
    artifact.current = ROTATED_ARTIFACT;
    clock = AFTER_ROTATION;
    await state.saveDecisionSet(meeting, decisions);

    expect(
      state.attributions.getProcessorAttribution({
        source_adapter_id: 'granola',
        source_instance_id: 'primary',
        external_id: 'not-1',
        meeting_revision: 'rev-1',
        processor_adapter_id: 'structured-text',
        processor_instance_id: 'primary',
        processor_version: '1.0.0',
      }),
    ).toEqual(frozen);
    expect(frozen).toMatchObject({
      identity_manifest_id: IDS.manifest,
      processor: { adapter_binding_id: IDS.processorBinding },
      produced_by: ARTIFACT,
      captured_at: NOW,
    });
    expect(artifact.currentCalls).toBe(2);
    const materializedDecisionSet = new Database(paths.database, {
      readonly: true,
    });
    expect(
      materializedDecisionSet
        .prepare('SELECT COUNT(*) AS count FROM core_decision_sets')
        .get(),
    ).toEqual({ count: 1 });
    materializedDecisionSet.close();
    state.close();
  });

  it('reuses materialized source and processor sidecars after identity rotation', async () => {
    const paths = temporaryDatabase();
    const core = new SqliteCoreStateStore(paths.database);
    const historical = bundle();
    const rotated = rotatedBundle();
    const holder = { active: true, material: true, current: historical };
    const artifact = { current: ARTIFACT, currentCalls: 0 };
    let clock = NOW;
    const state = new AttributingCoreStateStore(core, {
      stateDirectory: paths.root,
      databasePath: paths.database,
      artifactProvider: rotatingArtifactProvider(artifact),
      identityBundleReader: identityReader(holder),
      identityLineageReader: lineageReader(historical, rotated),
      now: () => clock,
      createObservationId: () => IDS.observation,
    });
    await state.saveMeeting(meeting);
    await state.saveDecisionSet(meeting, decisions);
    const sourceKey = {
      source_adapter_id: 'granola',
      source_instance_id: 'primary',
      external_id: 'not-1',
      meeting_revision: 'rev-1',
    };
    const processorKey = {
      ...sourceKey,
      processor_adapter_id: 'structured-text',
      processor_instance_id: 'primary',
      processor_version: '1.0.0',
    };
    const frozenSource = state.attributions.getSourceAttribution(sourceKey);
    const frozenProcessor =
      state.attributions.getProcessorAttribution(processorKey);
    expect(artifact.currentCalls).toBe(2);

    holder.current = rotated;
    artifact.current = ROTATED_ARTIFACT;
    clock = AFTER_ROTATION;
    await state.saveMeeting(meeting);
    await state.saveDecisionSet(meeting, decisions);

    expect(state.attributions.getSourceAttribution(sourceKey)).toEqual(
      frozenSource,
    );
    expect(state.attributions.getProcessorAttribution(processorKey)).toEqual(
      frozenProcessor,
    );
    expect(artifact.currentCalls).toBe(2);
    state.close();
  });

  it('blocks changed documents and extraction output before overwrite', async () => {
    const paths = temporaryDatabase();
    const core = new SqliteCoreStateStore(paths.database);
    const historical = bundle();
    const holder = { active: true, material: true, current: historical };
    const state = new AttributingCoreStateStore(core, {
      stateDirectory: paths.root,
      databasePath: paths.database,
      artifactProvider: artifactProvider(),
      identityBundleReader: identityReader(holder),
      identityLineageReader: lineageReader(historical),
      now: () => NOW,
      createObservationId: () => IDS.observation,
    });
    await state.saveMeeting(meeting);
    await state.saveDecisionSet(meeting, decisions);

    await expect(
      state.saveMeeting({ ...meeting, title: 'Changed after capture' }),
    ).rejects.toThrow(/stored source attribution differs/);
    await expect(
      state.saveDecisionSet(meeting, {
        ...decisions,
        signals: [
          {
            id: 'decision-1',
            kind: 'decision',
            text: 'A changed extraction',
            subject: null,
            confidence: 1,
            evidence: [],
            status: 'decided',
          },
        ],
      }),
    ).rejects.toThrow(/stored processor attribution differs/);

    const db = new Database(paths.database, { readonly: true });
    const stored = db
      .prepare('SELECT document_json FROM core_meeting_documents')
      .get() as { document_json: string };
    expect(JSON.parse(stored.document_json)).toEqual(meeting);
    db.close();
    state.close();
  });

  it('keeps legacy core-only rows disposable without backfilling or blocking readiness', async () => {
    const paths = temporaryDatabase();
    const core = new SqliteCoreStateStore(paths.database);
    await core.saveMeeting(meeting);
    await core.saveDecisionSet(meeting, decisions);
    const holder = { active: true, material: true, current: bundle() };
    const state = new AttributingCoreStateStore(core, {
      stateDirectory: paths.root,
      databasePath: paths.database,
      artifactProvider: artifactProvider(),
      identityBundleReader: identityReader(holder),
      now: () => NOW,
      createObservationId: () => IDS.observation,
    });

    await expect(state.saveMeeting(meeting)).rejects.toThrow(
      /pre-existing legacy meeting row/,
    );
    await expect(
      state.getDecisionSet(meeting, decisions.processor),
    ).rejects.toThrow(/no matching extraction-time attribution/);
    expect(
      state.attributions.verifyStoredAttributions(
        createAttributionStorageEvidenceVerifier(
          lineageReader(holder.current),
          artifactProvider(),
        ),
      ),
    ).toEqual({ source_attributions: 0, processor_attributions: 0 });
    state.close();
  });

  it('resolves approval metadata only to the exact durable pair and rejects noncanonical storage', async () => {
    const paths = temporaryDatabase();
    const core = new SqliteCoreStateStore(paths.database);
    const holder = { active: true, material: true, current: bundle() };
    const state = new AttributingCoreStateStore(core, {
      stateDirectory: paths.root,
      databasePath: paths.database,
      artifactProvider: artifactProvider(),
      identityBundleReader: identityReader(holder),
      now: () => NOW,
      createObservationId: () => IDS.observation,
    });
    await state.saveMeeting(meeting);
    await state.saveDecisionSet(meeting, decisions);
    const source = state.attributions.getSourceAttribution({
      source_adapter_id: 'granola',
      source_instance_id: 'primary',
      external_id: 'not-1',
      meeting_revision: 'rev-1',
    })!;
    const processor = state.attributions.getProcessorAttribution({
      source_adapter_id: 'granola',
      source_instance_id: 'primary',
      external_id: 'not-1',
      meeting_revision: 'rev-1',
      processor_adapter_id: 'structured-text',
      processor_instance_id: 'primary',
      processor_version: '1.0.0',
    })!;
    const metadata: ApprovalFederationMetadataV1 = {
      schema_version: 1,
      identity_manifest_id: IDS.manifest,
      source_attribution_ref: {
        source_adapter_id: 'granola',
        source_instance_id: 'primary',
        external_id: 'not-1',
        meeting_revision: 'rev-1',
        attribution_sha256: canonicalSha256(source),
      },
      processor: {
        adapter_binding_id: IDS.processorBinding,
        adapter: decisions.processor,
        configuration_snapshot: processor.processor.configuration_snapshot,
        configuration_sha256: processor.processor.configuration_sha256,
        attribution_sha256: canonicalSha256(processor),
      },
      approval_surface: {
        binding: {
          adapter_binding_id: IDS.approvalBinding,
          adapter: {
            kind: 'approval-surface',
            adapter_id: 'slack-reactions',
            instance_id: 'founder-approval',
            version: '1.0.0',
          },
          configuration_snapshot: {},
          configuration_sha256: canonicalSha256({}),
        },
        connection: null,
      },
      publication: {
        policy_id: IDS.policy,
        version: 1,
        policy_sha256: `sha256:${'9'.repeat(64)}`,
        identity_manifest_id: IDS.manifest,
        signer_installation_id: IDS.installation,
        signer_key_id: INTEGRITY.key_id,
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
      candidate_context_sha256: `sha256:${'a'.repeat(64)}`,
    };
    await expect(
      state.attributions.getAttributionsForMetadata(metadata),
    ).resolves.toEqual({ source, processor });
    await expect(
      state.attributions.getAttributionsForMetadata({
        ...metadata,
        processor: {
          ...metadata.processor,
          attribution_sha256: `sha256:${'b'.repeat(64)}`,
        },
      }),
    ).rejects.toThrow(/exact attribution pair/);

    const db = new Database(paths.database);
    const raw = db
      .prepare('SELECT attribution_json FROM federated_source_attributions')
      .get() as { attribution_json: string };
    db.prepare(
      'UPDATE federated_source_attributions SET attribution_json = ?',
    ).run(` ${raw.attribution_json}`);
    db.close();
    expect(() =>
      state.attributions.getSourceAttribution({
        source_adapter_id: 'granola',
        source_instance_id: 'primary',
        external_id: 'not-1',
        meeting_revision: 'rev-1',
      }),
    ).toThrow(/not RFC 8785 canonical/);
    state.close();
  });

  it('can be used directly as the approval attribution provider', async () => {
    const paths = temporaryDatabase();
    const core = new SqliteCoreStateStore(paths.database);
    const holder = { active: true, material: true, current: bundle() };
    const state = new AttributingCoreStateStore(core, {
      stateDirectory: paths.root,
      databasePath: paths.database,
      artifactProvider: artifactProvider(),
      identityBundleReader: identityReader(holder),
      now: () => NOW,
      createObservationId: () => IDS.observation,
    });
    await state.saveMeeting(meeting);
    await state.saveDecisionSet(meeting, decisions);
    const request = {
      meeting,
      decisions,
    } as ApprovalRequest;
    const provider: Pick<
      SqliteFederatedAttributionStore,
      'getAttributions' | 'getAttributionsForMetadata'
    > = state.attributions;
    await expect(provider.getAttributions(request)).resolves.toMatchObject({
      source: { kind: 'echo-source-attribution' },
      processor: { kind: 'echo-processor-attribution' },
    });
    state.close();
  });
});
