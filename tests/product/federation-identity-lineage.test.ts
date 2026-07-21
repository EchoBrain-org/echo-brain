import {
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProductStatePaths } from '../../src/product/paths.js';
import { ActiveIdentityBundleStore } from '../../src/product/federation/identity/active-identity-bundle-store.js';
import {
  canonicalJson,
  sha256Digest,
} from '../../src/product/federation/foundation/canonical-json.js';
import {
  connectionRegistryFilename,
  ConnectionRegistryStore,
} from '../../src/product/federation/identity/connection-registry-store.js';
import type {
  AdapterBindingV1,
  LocalConnectionRegistryV1,
  LocalIdentityManifestV1,
  PublicationPolicyV1,
  SignedIntegrity,
  ToolConnectionV1,
} from '../../src/product/federation/contracts.js';
import {
  identityManifestFilename,
  IdentityManifestStore,
} from '../../src/product/federation/identity/identity-manifest-store.js';
import {
  IdentityLineageStore,
  type HistoricalBindingReference,
} from '../../src/product/federation/identity-lineage-store.js';
import { createSignedDocument } from '../../src/product/federation/foundation/signed-document.js';
import {
  publicationPolicyFilename,
  PublicationPolicyStore,
} from '../../src/product/federation/identity/publication-policy-store.js';
import {
  createPrivateTestState,
  slackConnectionFixture,
  testBinding,
  testManifest,
  testPointer,
  testPolicy,
  testRegistry,
  TestHardwareSigner,
} from './fixtures/founder-identity.js';

const IDS = {
  organization: 'org_00000000-0000-4000-8000-000000000001',
  principal: 'prn_00000000-0000-4000-8000-000000000002',
  membership: 'mem_00000000-0000-4000-8000-000000000003',
  device: 'dev_00000000-0000-4000-8000-000000000004',
  installation: 'ins_00000000-0000-4000-8000-000000000005',
  manifest: 'idm_00000000-0000-4000-8000-000000000006',
  successorManifest: 'idm_10000000-0000-4000-8000-000000000006',
  unanchoredManifest: 'idm_00000000-0000-4000-8000-00000000000e',
  claim: 'clm_00000000-0000-4000-8000-000000000007',
  connection: 'con_00000000-0000-4000-8000-000000000008',
  oldBinding: 'bnd_00000000-0000-4000-8000-000000000009',
  newBinding: 'bnd_00000000-0000-4000-8000-00000000000a',
  registry: 'reg_00000000-0000-4000-8000-00000000000b',
  successorRegistry: 'reg_10000000-0000-4000-8000-00000000000b',
  secondRegistry: 'reg_00000000-0000-4000-8000-00000000000c',
  policy: 'pol_00000000-0000-4000-8000-00000000000d',
  successorPolicy: 'pol_10000000-0000-4000-8000-00000000000d',
  wrongProviderConnection: 'con_00000000-0000-4000-8000-00000000000f',
} as const;

const CUTOVER = '2026-07-19T20:00:00.000Z';
const REVISION_ONE_AT = '2026-07-19T20:10:00.000Z';
const OBSERVED_OLD = '2026-07-19T20:12:00.000Z';
const RETIRED_AT = '2026-07-19T20:15:00.000Z';
const OBSERVED_AFTER_RETIREMENT = '2026-07-19T20:16:00.000Z';
const REVISION_TWO_AT = '2026-07-19T20:20:00.000Z';
const OBSERVED_NEW = '2026-07-19T20:21:00.000Z';
const DIGEST = `sha256:${'1'.repeat(64)}` as const;
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const TestInstallationSigner = TestHardwareSigner;

interface Fixture {
  stateDirectory: string;
  signer: TestHardwareSigner;
  manifest: LocalIdentityManifestV1;
  policy: PublicationPolicyV1;
  policyRaw: string;
  connection: ToolConnectionV1;
  oldBinding: AdapterBindingV1;
  registryOne: LocalConnectionRegistryV1;
  registryOneRaw: string;
}

function privateState(): string {
  return createPrivateTestState(temporary, 'echo-identity-lineage-');
}

async function signDocument<T extends object>(
  payload: T,
  signer: TestHardwareSigner,
  keyId: `sha256:${string}`,
): Promise<T & { integrity: SignedIntegrity }> {
  return createSignedDocument(payload, signer, IDS.installation, keyId);
}

function connection(providerVerifiedAt = REVISION_ONE_AT): ToolConnectionV1 {
  return slackConnectionFixture({
    connectionId: IDS.connection,
    organizationId: IDS.organization,
    activeAt: REVISION_ONE_AT,
    tenantId: 'T123',
    subject: { id: 'U123', bot_id: 'B123', app_id: 'A123' },
    verifiedAt: providerVerifiedAt,
    evidenceSha256: DIGEST,
    credentialGuard: {
      reference: 'file:/private/slack-token',
      algorithm: 'sha256-salted',
      salt_base64: 'AQ==',
      digest: DIGEST,
      exportable: false,
    },
  });
}

function binding(
  adapterBindingId: string,
  createdAt: string,
  status: 'active' | 'retired' = 'active',
  endedAt: string | null = null,
): AdapterBindingV1 {
  const configuration = {
    channel_id: 'C123',
    reviewer: { slack_user_id: 'UFOUNDER' },
  };
  return testBinding({
    adapterBindingId,
    capability: 'approval-surface',
    adapterId: 'slack-reactions',
    instanceId:
      adapterBindingId === IDS.oldBinding
        ? 'founder-approval'
        : 'founder-approval-v2',
    connectionId: IDS.connection,
    configuration,
    createdAt,
    endedAt,
    status,
  });
}

async function createFixture(
  options: {
    claimVerifiedAt?: string;
    providerVerifiedAt?: string;
  } = {},
): Promise<Fixture> {
  const stateDirectory = privateState();
  const signer = new TestInstallationSigner();
  const descriptor = await signer.generate(IDS.installation);
  const manifestPayload = testManifest({
    ids: IDS,
    at: CUTOVER,
    claimTenant: 'T123',
    claimVerifiedAt: options.claimVerifiedAt,
    key: {
      key_id: descriptor.key_id,
      algorithm: descriptor.algorithm,
      public_key_spki_der_base64: descriptor.public_key_spki_der_base64,
      protection: 'secure-enclave',
      assurance: 'hardware_bound',
    },
  });
  const manifest = await signDocument(
    manifestPayload,
    signer,
    descriptor.key_id,
  );
  const paths = resolveProductStatePaths(stateDirectory);
  new IdentityManifestStore(paths).create(
    identityManifestFilename(IDS.manifest),
    canonicalJson(manifest),
  );

  const policyPayload = testPolicy({
    policyId: IDS.policy,
    organizationId: IDS.organization,
    manifestId: IDS.manifest,
    installationId: IDS.installation,
    keyId: descriptor.key_id,
    effectiveAt: REVISION_ONE_AT,
  });
  const policy = await signDocument(policyPayload, signer, descriptor.key_id);
  const policyRaw = canonicalJson(policy);
  new PublicationPolicyStore(paths).create(
    publicationPolicyFilename(IDS.policy, 1),
    policyRaw,
  );

  const enrolledConnection = connection(options.providerVerifiedAt);
  const oldBinding = binding(IDS.oldBinding, REVISION_ONE_AT);
  const registryPayload = testRegistry({
    registryId: IDS.registry,
    manifestId: IDS.manifest,
    updatedAt: REVISION_ONE_AT,
    connections: [enrolledConnection],
    bindings: [oldBinding],
  });
  const registryOne = await signDocument(
    registryPayload,
    signer,
    descriptor.key_id,
  );
  const registryOneRaw = canonicalJson(registryOne);
  new ConnectionRegistryStore(paths).create(
    connectionRegistryFilename(IDS.registry, 1),
    registryOneRaw,
  );
  const pointerPayload = testPointer({
    manifestId: IDS.manifest,
    manifestPath: `manifests/${identityManifestFilename(IDS.manifest)}`,
    manifestSha256: sha256Digest(canonicalJson(manifest)),
    registryId: IDS.registry,
    registryPath: `registries/${connectionRegistryFilename(IDS.registry, 1)}`,
    registrySha256: sha256Digest(registryOneRaw),
    policyId: IDS.policy,
    policyPath: `policies/${publicationPolicyFilename(IDS.policy, 1)}`,
    policySha256: sha256Digest(policyRaw),
    installationId: IDS.installation,
    activatedAt: REVISION_ONE_AT,
  });
  const pointer = await signDocument(pointerPayload, signer, descriptor.key_id);
  new ActiveIdentityBundleStore(stateDirectory).createInitialPointer(
    canonicalJson(pointer),
  );
  return {
    stateDirectory,
    signer,
    manifest,
    policy,
    policyRaw,
    connection: enrolledConnection,
    oldBinding,
    registryOne,
    registryOneRaw,
  };
}

function bindingReference(
  bindingValue: AdapterBindingV1,
): HistoricalBindingReference {
  return {
    identity_manifest_id: IDS.manifest,
    adapter_binding_id: bindingValue.adapter_binding_id,
    capability: bindingValue.capability,
    adapter_id: bindingValue.adapter_id,
    instance_id: bindingValue.instance_id,
    configuration_snapshot: bindingValue.configuration_snapshot,
    configuration_sha256: bindingValue.configuration_sha256,
    connection_id: bindingValue.connection_id,
    connection_generation: bindingValue.connection_generation,
  };
}

async function activateSuccessorManifest(fixture: Fixture): Promise<void> {
  const descriptor = await fixture.signer.inspect(IDS.installation);
  if (descriptor === null) throw new Error('test descriptor disappeared');
  const paths = resolveProductStatePaths(fixture.stateDirectory);

  const { integrity: _manifestIntegrity, ...manifestPayload } =
    fixture.manifest;
  void _manifestIntegrity;
  const successorManifest = await signDocument(
    {
      ...manifestPayload,
      manifest_id: IDS.successorManifest,
      predecessor_manifest_id: IDS.manifest,
      created_at: REVISION_TWO_AT,
    },
    fixture.signer,
    descriptor.key_id,
  );
  const successorManifestRaw = canonicalJson(successorManifest);
  new IdentityManifestStore(paths).create(
    identityManifestFilename(IDS.successorManifest),
    successorManifestRaw,
  );

  const { integrity: _registryIntegrity, ...registryPayload } =
    fixture.registryOne;
  void _registryIntegrity;
  const successorRegistry = await signDocument(
    {
      ...registryPayload,
      registry_id: IDS.successorRegistry,
      identity_manifest_id: IDS.successorManifest,
      updated_at: REVISION_TWO_AT,
    },
    fixture.signer,
    descriptor.key_id,
  );
  const successorRegistryRaw = canonicalJson(successorRegistry);
  new ConnectionRegistryStore(paths).create(
    connectionRegistryFilename(IDS.successorRegistry, 1),
    successorRegistryRaw,
  );

  const { integrity: _policyIntegrity, ...policyPayload } = fixture.policy;
  void _policyIntegrity;
  const successorPolicy = await signDocument(
    {
      ...policyPayload,
      policy_id: IDS.successorPolicy,
      identity_manifest_id: IDS.successorManifest,
      effective_at: REVISION_TWO_AT,
    },
    fixture.signer,
    descriptor.key_id,
  );
  const successorPolicyRaw = canonicalJson(successorPolicy);
  new PublicationPolicyStore(paths).create(
    publicationPolicyFilename(IDS.successorPolicy, 1),
    successorPolicyRaw,
  );

  const pointerPayload = testPointer({
    manifestId: IDS.successorManifest,
    manifestPath: `manifests/${identityManifestFilename(IDS.successorManifest)}`,
    manifestSha256: sha256Digest(successorManifestRaw),
    registryId: IDS.successorRegistry,
    registryPath: `registries/${connectionRegistryFilename(IDS.successorRegistry, 1)}`,
    registrySha256: sha256Digest(successorRegistryRaw),
    policyId: IDS.successorPolicy,
    policyPath: `policies/${publicationPolicyFilename(IDS.successorPolicy, 1)}`,
    policySha256: sha256Digest(successorPolicyRaw),
    installationId: IDS.installation,
    activatedAt: REVISION_TWO_AT,
    activationReason: 'bundle-update',
  });
  const pointer = await signDocument(
    pointerPayload,
    fixture.signer,
    descriptor.key_id,
  );
  writeFileSync(paths.activeIdentityBundle, canonicalJson(pointer), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function addSecondRevision(
  fixture: Fixture,
  previousDigest = sha256Digest(fixture.registryOneRaw),
): Promise<{
  registry: LocalConnectionRegistryV1;
  newBinding: AdapterBindingV1;
}> {
  const descriptor = await fixture.signer.inspect(IDS.installation);
  if (descriptor === null) throw new Error('test descriptor disappeared');
  const retiredBinding = {
    ...fixture.oldBinding,
    status: 'retired' as const,
    ended_at: RETIRED_AT,
  };
  const newBinding = binding(IDS.newBinding, RETIRED_AT);
  const payload: Omit<LocalConnectionRegistryV1, 'integrity'> = {
    schema_version: 1,
    kind: 'echo-local-connection-registry',
    registry_id: IDS.registry,
    identity_manifest_id: IDS.manifest,
    revision: 2,
    previous_registry_sha256: previousDigest,
    updated_at: REVISION_TWO_AT,
    connections: [fixture.connection],
    bindings: [retiredBinding, newBinding],
  };
  const registry = await signDocument(
    payload,
    fixture.signer,
    descriptor.key_id,
  );
  const paths = resolveProductStatePaths(fixture.stateDirectory);
  new ConnectionRegistryStore(paths).create(
    connectionRegistryFilename(IDS.registry, 2),
    canonicalJson(registry),
  );
  return { registry, newBinding };
}

describe('historical identity lineage store', () => {
  it('proves order against the active signed predecessor chain', async () => {
    const fixture = await createFixture();
    await activateSuccessorManifest(fixture);
    const store = new IdentityLineageStore(fixture.stateDirectory);

    expect(() =>
      store.assertManifestAncestorOrEqual(IDS.manifest, IDS.successorManifest),
    ).not.toThrow();
    expect(() =>
      store.assertManifestAncestorOrEqual(
        IDS.successorManifest,
        IDS.successorManifest,
      ),
    ).not.toThrow();
    expect(() =>
      store.assertManifestAncestorOrEqual(IDS.successorManifest, IDS.manifest),
    ).toThrow(/is not an ancestor/);
  });

  it('loads canonical signed manifests and exact historical policy bytes', async () => {
    const fixture = await createFixture();
    const store = new IdentityLineageStore(fixture.stateDirectory);

    const manifest = store.loadVerifiedManifest(IDS.manifest);
    expect(manifest.manifest.manifest_id).toBe(IDS.manifest);
    expect(manifest.sha256).toBe(sha256Digest(manifest.canonical));
    expect(store.loadVerifiedActiveManifest()).toEqual(manifest);
    const manifestByDigest = store.loadVerifiedManifestBySha256(
      manifest.sha256,
    );
    expect(manifestByDigest.manifest.manifest_id).toBe(IDS.manifest);
    expect(manifestByDigest.canonical).toBe(manifest.canonical);
    expect(() =>
      store.assertManifestAncestorOrEqual(IDS.manifest, IDS.manifest),
    ).not.toThrow();

    const policy = store.loadVerifiedPolicy(
      {
        policy_id: IDS.policy,
        version: 1,
        policy_sha256: sha256Digest(fixture.policyRaw),
        identity_manifest_id: IDS.manifest,
        signer_installation_id: IDS.installation,
        signer_key_id: fixture.policy.issued_by.key_id,
      },
      OBSERVED_OLD,
    );
    expect(policy.policy.publication.sensitivity).toBe('internal');
    expect(policy.canonical).toBe(fixture.policyRaw);
    expect(() =>
      store.loadVerifiedPolicy(
        {
          policy_id: IDS.policy,
          version: 1,
          policy_sha256: sha256Digest(fixture.policyRaw),
          identity_manifest_id: IDS.manifest,
          signer_installation_id: IDS.installation,
          signer_key_id: fixture.policy.issued_by.key_id,
        },
        CUTOVER,
      ),
    ).toThrow(/not effective at the observation time/);
    expect(() =>
      store.loadVerifiedPolicy(
        {
          policy_id: IDS.policy,
          version: 1,
          policy_sha256: DIGEST,
          identity_manifest_id: IDS.manifest,
          signer_installation_id: IDS.installation,
          signer_key_id: fixture.policy.issued_by.key_id,
        },
        OBSERVED_OLD,
      ),
    ).toThrow(/file digest does not match/);

    const descriptor = await fixture.signer.inspect(IDS.installation);
    if (descriptor === null) throw new Error('test descriptor disappeared');
    const { integrity: _integrity, ...manifestPayload } = fixture.manifest;
    void _integrity;
    const unanchored = await signDocument(
      { ...manifestPayload, manifest_id: IDS.unanchoredManifest },
      fixture.signer,
      descriptor.key_id,
    );
    const paths = resolveProductStatePaths(fixture.stateDirectory);
    new IdentityManifestStore(paths).create(
      identityManifestFilename(IDS.unanchoredManifest),
      canonicalJson(unanchored),
    );
    expect(() => store.loadVerifiedManifest(IDS.unanchoredManifest)).toThrow(
      /not reachable from the active identity lineage/,
    );
    expect(() =>
      store.assertManifestAncestorOrEqual(IDS.manifest, IDS.unanchoredManifest),
    ).toThrow(/outside the active lineage/);
    expect(() =>
      store.loadVerifiedManifestBySha256(
        sha256Digest(canonicalJson(unanchored)),
      ),
    ).toThrow(/not reachable from the active identity lineage/);
  });

  it.each([
    { kind: 'membership' as const, idFrom: 'organization' as const },
    { kind: 'organization' as const, idFrom: 'membership' as const },
  ])(
    'rejects a historical $kind audience subject carrying the $idFrom ID',
    async ({ kind, idFrom }) => {
      const fixture = await createFixture();
      const descriptor = await fixture.signer.inspect(IDS.installation);
      if (descriptor === null) throw new Error('test descriptor disappeared');
      const { integrity: _integrity, ...policyPayload } = fixture.policy;
      void _integrity;
      const invalidPolicy = await signDocument(
        {
          ...policyPayload,
          version: 2,
          effective_at: REVISION_TWO_AT,
          publication: {
            ...policyPayload.publication,
            audience: {
              scope: 'named-subjects' as const,
              subjects: [
                {
                  kind,
                  id:
                    idFrom === 'organization'
                      ? IDS.organization
                      : IDS.membership,
                },
              ],
            },
          },
        },
        fixture.signer,
        descriptor.key_id,
      );
      const invalidPolicyRaw = canonicalJson(invalidPolicy);
      const paths = resolveProductStatePaths(fixture.stateDirectory);
      new PublicationPolicyStore(paths).create(
        publicationPolicyFilename(IDS.policy, 2),
        invalidPolicyRaw,
      );

      expect(() =>
        new IdentityLineageStore(fixture.stateDirectory).loadVerifiedPolicy(
          {
            policy_id: IDS.policy,
            version: 2,
            policy_sha256: sha256Digest(invalidPolicyRaw),
            identity_manifest_id: IDS.manifest,
            signer_installation_id: IDS.installation,
            signer_key_id: descriptor.key_id,
          },
          OBSERVED_NEW,
        ),
      ).toThrow(
        /invalid publication-policy document|unknown local audience subject/,
      );
    },
  );

  it('rejects future-dated signed Slack claim and provider verification evidence', async () => {
    const futureClaim = await createFixture({
      claimVerifiedAt: '2026-07-19T20:00:00.001Z',
    });
    expect(() =>
      new IdentityLineageStore(futureClaim.stateDirectory).loadVerifiedManifest(
        IDS.manifest,
      ),
    ).toThrow(/identity claim was verified after its signed manifest/);

    const futureProvider = await createFixture({
      providerVerifiedAt: '2026-07-19T20:10:00.001Z',
    });
    expect(() =>
      new IdentityLineageStore(
        futureProvider.stateDirectory,
      ).loadVerifiedRegistryChain(IDS.manifest, IDS.registry),
    ).toThrow(/impossible verification or activation time/);
  });

  it('walks the signed hash chain and resolves the binding valid at observed_at', async () => {
    const fixture = await createFixture();
    const { newBinding } = await addSecondRevision(fixture);
    const store = new IdentityLineageStore(fixture.stateDirectory);

    const chains = store.enumerateVerifiedRegistryChains(IDS.manifest);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.revisions.map((item) => item.registry.revision)).toEqual([
      1, 2,
    ]);
    expect(chains[0]?.revisions[1]?.registry.previous_registry_sha256).toBe(
      sha256Digest(fixture.registryOneRaw),
    );

    const old = store.resolveBindingAt(
      bindingReference(fixture.oldBinding),
      OBSERVED_OLD,
    );
    expect(old.revision.registry.revision).toBe(1);
    expect(old.binding.adapter_binding_id).toBe(IDS.oldBinding);
    expect(old.connection?.connection_id).toBe(IDS.connection);
    const located = store.resolveBindingSnapshotAt(
      {
        identity_manifest_id: IDS.manifest,
        adapter_binding_id: fixture.oldBinding.adapter_binding_id,
        configuration_sha256: fixture.oldBinding.configuration_sha256,
        connection_id: fixture.oldBinding.connection_id,
        connection_generation: fixture.oldBinding.connection_generation,
      },
      OBSERVED_OLD,
    );
    expect(located.binding).toEqual(old.binding);

    expect(() =>
      store.resolveBindingAt(
        bindingReference(fixture.oldBinding),
        OBSERVED_AFTER_RETIREMENT,
      ),
    ).toThrow(/no enrolled historical binding/);
    expect(() =>
      store.resolveBindingAt(
        bindingReference(newBinding),
        OBSERVED_AFTER_RETIREMENT,
      ),
    ).toThrow(/no enrolled historical binding/);

    const current = store.resolveBindingAt(
      bindingReference(newBinding),
      OBSERVED_NEW,
    );
    expect(current.revision.registry.revision).toBe(2);
    expect(current.binding.adapter_binding_id).toBe(IDS.newBinding);
  });

  it('rejects a signed registry revision whose exact predecessor digest is wrong', async () => {
    const fixture = await createFixture();
    await addSecondRevision(fixture, DIGEST);
    const store = new IdentityLineageStore(fixture.stateDirectory);
    expect(() =>
      store.loadVerifiedRegistryChain(IDS.manifest, IDS.registry),
    ).toThrow(/broken hash link/);
  });

  it('rejects a signed adapter binding that uses the wrong provider', async () => {
    const fixture = await createFixture();
    const descriptor = await fixture.signer.inspect(IDS.installation);
    if (descriptor === null) throw new Error('test descriptor disappeared');
    const wrongProviderConnection: ToolConnectionV1 = {
      connection_id: IDS.wrongProviderConnection,
      organization_id: IDS.organization,
      owner: { kind: 'organization', id: IDS.organization },
      provider: 'granola',
      generations: [
        {
          generation: 1,
          active_from: RETIRED_AT,
          ended_at: null,
          provider_identity: {
            tenant: null,
            subject: null,
            verification: {
              method: 'provider_first_capture',
              assurance: 'credential_observed',
              verified_at: RETIRED_AT,
              evidence_sha256: DIGEST,
            },
          },
          local_credential_guard: {
            reference: 'file:/private/granola-token',
            algorithm: 'sha256-salted',
            salt_base64: 'Ag==',
            digest: DIGEST,
            exportable: false,
          },
        },
      ],
    };
    const retiredBinding: AdapterBindingV1 = {
      ...fixture.oldBinding,
      status: 'retired',
      ended_at: RETIRED_AT,
    };
    const wrongProviderBinding: AdapterBindingV1 = {
      ...binding(IDS.newBinding, RETIRED_AT),
      connection_id: IDS.wrongProviderConnection,
    };
    const payload: Omit<LocalConnectionRegistryV1, 'integrity'> = {
      schema_version: 1,
      kind: 'echo-local-connection-registry',
      registry_id: IDS.registry,
      identity_manifest_id: IDS.manifest,
      revision: 2,
      previous_registry_sha256: sha256Digest(fixture.registryOneRaw),
      updated_at: REVISION_TWO_AT,
      connections: [fixture.connection, wrongProviderConnection],
      bindings: [retiredBinding, wrongProviderBinding],
    };
    const signed = await signDocument(
      payload,
      fixture.signer,
      descriptor.key_id,
    );
    const paths = resolveProductStatePaths(fixture.stateDirectory);
    new ConnectionRegistryStore(paths).create(
      connectionRegistryFilename(IDS.registry, 2),
      canonicalJson(signed),
    );

    expect(() =>
      new IdentityLineageStore(
        fixture.stateDirectory,
      ).loadVerifiedRegistryChain(IDS.manifest, IDS.registry),
    ).toThrow(/uses the wrong provider/);
  });

  it.each([
    {
      label: 'local processor with a provider connection',
      adapterId: 'structured-text',
      instanceId: 'primary',
      connectionId: IDS.connection,
      configuration: {} as AdapterBindingV1['configuration_snapshot'],
      expected: /must not use a provider connection/,
    },
    {
      label: 'hosted LLM without attributable connection evidence',
      adapterId: 'llm',
      instanceId: 'openai-primary',
      connectionId: null,
      configuration: {
        provider: 'openai',
        model: 'gpt-test',
        prompt_version: 'decision-extraction-v2',
        output_schema_version: 'decision-extraction-schema-v2',
      } as AdapterBindingV1['configuration_snapshot'],
      expected:
        /hosted LLM provider openai.*before connection-aware processor attribution/,
    },
  ])('rejects a signed $label', async (testCase) => {
    const fixture = await createFixture();
    const descriptor = await fixture.signer.inspect(IDS.installation);
    if (descriptor === null) throw new Error('test descriptor disappeared');
    const retiredBinding: AdapterBindingV1 = {
      ...fixture.oldBinding,
      status: 'retired',
      ended_at: RETIRED_AT,
    };
    const invalidBinding = testBinding({
      adapterBindingId: IDS.newBinding,
      capability: 'decision-processor',
      adapterId: testCase.adapterId,
      instanceId: testCase.instanceId,
      connectionId: testCase.connectionId,
      configuration: testCase.configuration,
      createdAt: RETIRED_AT,
    });
    const payload: Omit<LocalConnectionRegistryV1, 'integrity'> = {
      schema_version: 1,
      kind: 'echo-local-connection-registry',
      registry_id: IDS.registry,
      identity_manifest_id: IDS.manifest,
      revision: 2,
      previous_registry_sha256: sha256Digest(fixture.registryOneRaw),
      updated_at: REVISION_TWO_AT,
      connections: [fixture.connection],
      bindings: [retiredBinding, invalidBinding],
    };
    const signed = await signDocument(
      payload,
      fixture.signer,
      descriptor.key_id,
    );
    const paths = resolveProductStatePaths(fixture.stateDirectory);
    new ConnectionRegistryStore(paths).create(
      connectionRegistryFilename(IDS.registry, 2),
      canonicalJson(signed),
    );

    expect(() =>
      new IdentityLineageStore(
        fixture.stateDirectory,
      ).loadVerifiedRegistryChain(IDS.manifest, IDS.registry),
    ).toThrow(testCase.expected);
  });

  it('rejects binding IDs that resolve in more than one verified registry chain', async () => {
    const fixture = await createFixture();
    const descriptor = await fixture.signer.inspect(IDS.installation);
    if (descriptor === null) throw new Error('test descriptor disappeared');
    const duplicatePayload: Omit<LocalConnectionRegistryV1, 'integrity'> = {
      schema_version: 1,
      kind: 'echo-local-connection-registry',
      registry_id: IDS.secondRegistry,
      identity_manifest_id: IDS.manifest,
      revision: 1,
      previous_registry_sha256: null,
      updated_at: REVISION_ONE_AT,
      connections: [fixture.connection],
      bindings: [fixture.oldBinding],
    };
    const duplicate = await signDocument(
      duplicatePayload,
      fixture.signer,
      descriptor.key_id,
    );
    const paths = resolveProductStatePaths(fixture.stateDirectory);
    new ConnectionRegistryStore(paths).create(
      connectionRegistryFilename(IDS.secondRegistry, 1),
      canonicalJson(duplicate),
    );

    const store = new IdentityLineageStore(fixture.stateDirectory);
    expect(() =>
      store.resolveBindingAt(
        bindingReference(fixture.oldBinding),
        OBSERVED_OLD,
      ),
    ).toThrow(/ambiguous across registry chains/);
  });

  it('rejects noncanonical historical manifest bytes before trusting a signature', async () => {
    const fixture = await createFixture();
    const paths = resolveProductStatePaths(fixture.stateDirectory);
    writeFileSync(
      join(paths.identityManifests, identityManifestFilename(IDS.manifest)),
      `${canonicalJson(fixture.manifest)}\n`,
      { mode: 0o600 },
    );
    const store = new IdentityLineageStore(fixture.stateDirectory);
    expect(() => store.loadVerifiedManifest(IDS.manifest)).toThrow(
      /dependency digest does not match|not RFC 8785 canonical/,
    );
  });
});
