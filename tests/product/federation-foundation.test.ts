import {
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { AdapterRegistry } from '../../src/core/index.js';
import type { ProductRuntimeConfig } from '../../src/product/config.js';
import { runProductCli } from '../../src/product/cli.js';
import { prepareProductComposition } from '../../src/product/composition.js';
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
} from '../../src/product/federation/canonical-json.js';
import {
  commitFounderBootstrap,
  mintFounderBootstrapIds,
  planFounderBootstrap,
  type FounderBootstrapInput,
} from '../../src/product/federation/bootstrap.js';
import type {
  AdapterBindingV1,
  PublicationSnapshotV1,
  ToolConnectionV1,
} from '../../src/product/federation/contracts.js';
import { checkFounderIdentity } from '../../src/product/federation/identity-check.js';
import {
  assertUtcMillisecondTimestamp,
  federationId,
} from '../../src/product/federation/identifiers.js';
import { validateFederationDocument } from '../../src/product/federation/schema-validation.js';
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from '../../src/product/federation/installation-signer.js';
import { verifyInstallationKeyDescriptor } from '../../src/product/federation/installation-signer.js';
import {
  decodeStrictP256DerSignature,
  encodeP256DerSignature,
  normalizeP256LowS,
  p256KeyId,
  verifyP256LowSSignature,
} from '../../src/product/federation/signature-profile.js';

const temporary: string[] = [];
const NOW = '2026-07-19T20:10:00.000Z';
const REPO = resolve(import.meta.dirname, '../..');
const P256_ORDER = BigInt(
  '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
);

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

class FakeHardwareSigner implements InstallationSigner {
  private readonly keys = new Map<
    string,
    { privateKey: KeyObject; descriptor: InstallationKeyDescriptor }
  >();

  constructor(
    private readonly protection: Pick<
      InstallationKeyDescriptor,
      'protection' | 'assurance'
    > = {
      protection: 'secure-enclave',
      assurance: 'hardware_bound',
    },
  ) {}

  async generate(installationId: string): Promise<InstallationKeyDescriptor> {
    const existing = this.keys.get(installationId);
    if (existing !== undefined) return existing.descriptor;
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const descriptor: InstallationKeyDescriptor = {
      installation_id: installationId,
      key_id: p256KeyId(spki),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: spki.toString('base64'),
      protection: this.protection.protection,
      assurance: this.protection.assurance,
      private_key_exportable: false,
    };
    this.keys.set(installationId, { privateKey, descriptor });
    return descriptor;
  }

  async inspect(installationId: string): Promise<InstallationKeyDescriptor | null> {
    return this.keys.get(installationId)?.descriptor ?? null;
  }

  async sign(
    installationId: string,
    message: Buffer,
    expectedKeyId?: `sha256:${string}`,
  ): Promise<Buffer> {
    const key = this.keys.get(installationId);
    if (key === undefined) throw new Error('test key is unavailable');
    if (expectedKeyId !== undefined && expectedKeyId !== key.descriptor.key_id) {
      throw new Error('test key fingerprint mismatch');
    }
    return normalizeP256LowS(
      signMessage('sha256', message, {
        key: key.privateKey,
        dsaEncoding: 'der',
      }),
    );
  }
}

function privateState(): string {
  const root = mkdtempSync(join(tmpdir(), 'echo-federation-foundation-'));
  temporary.push(root);
  const state = join(realpathSync(root), 'state');
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  return state;
}

function config(stateDir: string): ProductRuntimeConfig {
  return {
    schema_version: 1,
    lane: 'team-product',
    state_dir: stateDir,
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
    approval_mode: 'manual',
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
            evidence_sha256: `sha256:${'4'.repeat(64)}`,
          },
        },
        local_credential_guard: {
          reference: 'file:/private/local/slack-bot-token',
          algorithm: 'sha256-salted',
          salt_base64: Buffer.from('slack-test-salt').toString('base64'),
          digest: `sha256:${'5'.repeat(64)}`,
          exportable: false,
        },
      },
    ],
  };
}

function binding(
  capability: AdapterBindingV1['capability'],
  adapterId: string,
  instanceId: string,
  connectionId: string | null,
): AdapterBindingV1 {
  const snapshot = {};
  return {
    adapter_binding_id: federationId('bnd'),
    capability,
    adapter_id: adapterId,
    instance_id: instanceId,
    connection_id: connectionId,
    connection_generation: connectionId === null ? null : 1,
    configuration_snapshot: snapshot,
    configuration_sha256: canonicalSha256(snapshot),
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
        local_credential_guard: {
          reference: 'file:/private/local/granola-api-key',
          algorithm: 'sha256-salted',
          salt_base64: Buffer.from('test-salt').toString('base64'),
          digest: `sha256:${'2'.repeat(64)}`,
          exportable: false,
        },
      },
    ],
  };
}

describe('RFC 8785 foundation', () => {
  it('canonicalizes numbers, strings, and UTF-16 key order deterministically', () => {
    expect(
      canonicalJson({
        numbers: [333333333.33333329, 1e30, 4.5, 0.002, 1e-27],
        literals: [null, true, false],
        string: '€$\u000f\nA\'B"\\"/',
      }),
    ).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\"/"}',
    );
    expect(canonicalJson({ '\u20ac': 1, '\r': 2, a: 3 })).toBe(
      '{"\\r":2,"a":3,"€":1}',
    );
  });

  it('rejects non-I-JSON and noncanonical input bytes', () => {
    const sparse = Array<string>(1);
    expect(() => canonicalJson(sparse)).toThrow(/sparse array slot/);
    expect(() => canonicalJson(Number.NaN)).toThrow(/finite JSON number/);
    expect(() => canonicalJson(String.fromCharCode(0xd800))).toThrow(
      /unpaired surrogate/,
    );
    expect(() => parseCanonicalJson('{"b":1,"a":2}')).toThrow(/not RFC 8785/);
    expect(() => parseCanonicalJson('{"a":1,"a":1}')).toThrow(/not RFC 8785/);
    expect(() =>
      assertUtcMillisecondTimestamp(
        '2026-02-31T00:00:00.000Z',
        'impossible date',
      ),
    ).toThrow(/not a real UTC timestamp/);
  });

  it('rejects an otherwise valid high-S P-256 signature encoding', async () => {
    const signer = new FakeHardwareSigner();
    const installationId = federationId('ins');
    const descriptor = await signer.generate(installationId);
    const message = Buffer.from('canonical-message', 'utf8');
    const lowSignature = await signer.sign(
      installationId,
      message,
      descriptor.key_id,
    );
    const decoded = decodeStrictP256DerSignature(lowSignature);
    const highSignature = encodeP256DerSignature(
      decoded.r,
      P256_ORDER - decoded.s,
    );
    const publicKey = Buffer.from(
      descriptor.public_key_spki_der_base64,
      'base64',
    );

    expect(() =>
      verifyP256LowSSignature(publicKey, message, highSignature),
    ).toThrow(/not low-S/);
  });

  it('rejects a P-256 SPKI with trailing noncanonical bytes', async () => {
    const signer = new FakeHardwareSigner();
    const descriptor = await signer.generate(federationId('ins'));
    const publicKey = Buffer.from(
      descriptor.public_key_spki_der_base64,
      'base64',
    );
    const noncanonical = Buffer.concat([publicKey, Buffer.from([0])]);

    expect(() =>
      verifyInstallationKeyDescriptor({
        ...descriptor,
        key_id: p256KeyId(noncanonical),
        public_key_spki_der_base64: noncanonical.toString('base64'),
      }),
    ).toThrow(/canonical P-256 SPKI DER/);
  });
});

describe('federation wire schemas', () => {
  it('compiles all ten exact-key schemas and forbids extras on every typed object', () => {
    const names = [
      'active-identity-bundle',
      'local-identity-manifest',
      'local-connection-registry',
      'publication-policy',
      'source-attribution',
      'processor-attribution',
      'approval-federation-metadata',
      'federated-record-envelope',
      'federated-export',
      'federated-recovery-report',
    ];
    const ajv = new Ajv({ strict: true, allErrors: true });
    ajv.addFormat('utc-millisecond-timestamp', {
      type: 'string',
      validate: () => true,
    });
    const visit = (value: unknown, path: string): void => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}/${index}`));
        return;
      }
      const record = value as Record<string, unknown>;
      if (record['type'] === 'object') {
        expect(record['additionalProperties'], path).toBe(false);
      }
      for (const [key, item] of Object.entries(record)) visit(item, `${path}/${key}`);
    };
    for (const name of names) {
      const schema = JSON.parse(
        readFileSync(
          join(REPO, 'schemas', 'product', `${name}.v1.schema.json`),
          'utf8',
        ),
      ) as object;
      expect(() => ajv.compile(schema), name).not.toThrow();
      visit(schema, name);
    }
  });

  it('represents CLI recovery approvals without claiming provider identity', () => {
    const ajv = new Ajv({ strict: true, allErrors: true });
    ajv.addFormat('utc-millisecond-timestamp', {
      type: 'string',
      validate: () => true,
    });
    const schema = JSON.parse(
      readFileSync(
        join(
          REPO,
          'schemas',
          'product',
          'federated-record-envelope.v1.schema.json',
        ),
        'utf8',
      ),
    ) as object;
    ajv.compile(schema);
    const validateApproval = ajv.getSchema(
      'https://echo.local/schemas/product/federated-record-envelope.v1.schema.json#/definitions/approval',
    );
    expect(validateApproval).toBeDefined();
    const installationId = federationId('ins');
    const approval = {
      surface: null,
      approver: {
        principal_id: federationId('prn'),
        membership_id: federationId('mem'),
        claim_id: null,
      },
      raw_actor_assertion: {
        surface: 'cli',
        installation_id: installationId,
        reviewer_label: 'founder-recovery',
        command: 'approve',
        observed_at: NOW,
      },
      assurance: 'installation_holder_self_attested',
      reviewed_at: NOW,
      reason: 'Recovery after provider outage',
      approved_brief_sha256: `sha256:${'2'.repeat(64)}`,
      approved_context_sha256: `sha256:${'3'.repeat(64)}`,
      observed_by: {
        product_version: '0.1.0-dev.6',
        source_sha: '4'.repeat(40),
        artifact_sha256: `sha256:${'5'.repeat(64)}`,
      },
    };
    expect(validateApproval!(approval), JSON.stringify(validateApproval!.errors)).toBe(
      true,
    );
    expect(
      validateApproval!({
        ...approval,
        assurance: 'provider_verified',
      }),
    ).toBe(false);
  });
});

describe('Founder identity bundle foundation', () => {
  it('keeps a state directory without a pointer in disposable rehearsal mode', async () => {
    const report = await checkFounderIdentity(privateState());
    expect(report).toMatchObject({
      mode: 'local_only_unattributed',
      foundation_ok: true,
      seed_grade_ready: false,
      organization_id: null,
      installation_id: null,
    });
  });

  it('keeps identity-check informational for rehearsal and strict only for cutover', async () => {
    const stateDir = privateState();
    const configPath = join(stateDir, 'runtime.json');
    writeFileSync(configPath, `${JSON.stringify(config(stateDir))}\n`, { mode: 0o600 });
    let stdout = '';
    let stderr = '';
    const dependencies = {
      classifyStateFilesystem: async () => ({ kind: 'local' as const, raw: 'apfs' }),
      stdout: { write: (value: string | Uint8Array) => ((stdout += value.toString()), true) },
      stderr: { write: (value: string | Uint8Array) => ((stderr += value.toString()), true) },
    };
    expect(
      await runProductCli(['identity-check', '--config', configPath], dependencies),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      strict: false,
      mode: 'local_only_unattributed',
      seed_grade_ready: false,
    });
    stdout = '';
    stderr = '';
    expect(
      await runProductCli(
        ['identity-check', '--config', configPath, '--strict'],
        dependencies,
      ),
    ).toBe(1);
    expect(JSON.parse(stderr)).toMatchObject({
      ok: false,
      strict: true,
      mode: 'local_only_unattributed',
      seed_grade_ready: false,
    });
  });

  it('blocks runtime composition before adapter resolution when identity material is incomplete', async () => {
    const stateDir = privateState();
    const manifestDirectory = join(stateDir, 'identity', 'manifests');
    mkdirSync(manifestDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(manifestDirectory, 'interrupted-bootstrap.json'), '{}', {
      mode: 0o600,
    });

    await expect(
      prepareProductComposition(config(stateDir), new AdapterRegistry(), {
        classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
      }),
    ).rejects.toMatchObject({ code: 'identity_not_seed_grade' });
  });

  it('writes dependencies and pointer last, resumes them unchanged, and detects tampering', async () => {
    const stateDir = privateState();
    const runtime = config(stateDir);
    const ids = mintFounderBootstrapIds();
    const connection = granolaConnection(ids.organization_id, ids.membership_id);
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
    const bootstrapDependencies = {
      loadBuildIdentity: () => ({
        schema_version: 1 as const,
        kind: 'echo-packaged-build-identity' as const,
        product_version: '0.1.0-dev.6',
        source_sha: 'a'.repeat(40),
        source_kind: 'materialized-commit' as const,
      }),
    };
    const bootstrapInput = {
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
      connections: [connection, slack],
      bindings: [
        binding(
          'meeting-source',
          'granola',
          'primary',
          connection.connection_id,
        ),
        binding('decision-processor', 'structured-text', 'primary', null),
        binding('delivery-surface', 'jsonl-outbox', 'local', null),
      ],
      publication,
    } satisfies FounderBootstrapInput;
    expect(() =>
      planFounderBootstrap(bootstrapInput, {
        loadBuildIdentity: () => ({
          schema_version: 1,
          kind: 'echo-packaged-build-identity',
          product_version: '0.1.0-dev.6',
          source_sha: 'b'.repeat(40),
          source_kind: 'worktree-head-unverified',
        }),
      }),
    ).toThrow(/materialized commit/);
    const plan = planFounderBootstrap(bootstrapInput, bootstrapDependencies);
    const opaqueConfiguration = { created_at: 'provider-owned-label' };
    const schemaRegistry = {
      ...plan.registry,
      bindings: plan.registry.bindings.map((item, index) =>
        index === 0
          ? {
              ...item,
              configuration_snapshot: opaqueConfiguration,
              configuration_sha256: canonicalSha256(opaqueConfiguration),
            }
          : item,
      ),
      integrity: {
        canonicalization: 'RFC8785',
        payload_sha256: `sha256:${'0'.repeat(64)}`,
        signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
        key_id: `sha256:${'1'.repeat(64)}`,
        signature_base64: 'AA==',
      },
    } as const;
    expect(() =>
      validateFederationDocument(
        'local-connection-registry',
        schemaRegistry,
      ),
    ).not.toThrow();
    expect(() =>
      validateFederationDocument('local-connection-registry', {
        ...schemaRegistry,
        updated_at: '2026-02-31T00:00:00.000Z',
      }),
    ).toThrow(/format/);
    const inconsistentState = privateState();
    await expect(
      commitFounderBootstrap(
        config(inconsistentState),
        {
          ...plan,
          ids: { ...plan.ids, registry_id: federationId('reg') },
        },
        new FakeHardwareSigner(),
        bootstrapDependencies,
      ),
    ).rejects.toThrow(/plan IDs do not match/);
    expect(existsSync(join(inconsistentState, 'identity'))).toBe(false);
    await expect(
      commitFounderBootstrap(
        config(privateState()),
        plan,
        new FakeHardwareSigner({
          protection: 'keychain-this-device-only',
          assurance: 'platform_key_device_only',
        }),
        bootstrapDependencies,
      ),
    ).rejects.toThrow(/Secure Enclave/);
    const signer = new FakeHardwareSigner();
    const result = await commitFounderBootstrap(
      runtime,
      plan,
      signer,
      bootstrapDependencies,
    );

    expect(result.created_paths.at(-1)).toBe(
      join(stateDir, 'identity', 'active-identity-bundle.v1.json'),
    );
    expect(readFileSync(result.created_paths.at(-1)!, 'utf8')).toBe(
      canonicalJson(result.active),
    );
    const report = await checkFounderIdentity(stateDir, { signer });
    expect(report.mode).toBe('identity_enabled');
    expect(report.foundation_ok).toBe(true);
    expect(report.seed_grade_ready).toBe(false);
    expect(report.checks.find((item) => item.id === 'bundle-integrity')?.ok).toBe(
      true,
    );
    expect(report.checks.find((item) => item.id === 'installation-key')?.ok).toBe(
      true,
    );
    expect(report.checks.find((item) => item.id === 'provider-identities')?.ok).toBe(
      false,
    );
    const repeated = await commitFounderBootstrap(
      runtime,
      plan,
      signer,
      bootstrapDependencies,
    );
    expect(repeated.created_paths).toEqual([]);

    const pointerPath = join(
      stateDir,
      'identity',
      'active-identity-bundle.v1.json',
    );
    const manifestPath = result.created_paths.find((path) =>
      path.includes('/manifests/'),
    );
    const registryPath = result.created_paths.find((path) =>
      path.includes('/registries/'),
    );
    expect(manifestPath).toBeDefined();
    expect(registryPath).toBeDefined();
    const manifestBytes = readFileSync(manifestPath!, 'utf8');

    // Simulate a crash after immutable dependencies were durable but before
    // the pointer became visible. ECDSA signatures are non-deterministic, so
    // retry must verify and reuse the prior bytes rather than re-signing them.
    unlinkSync(pointerPath);
    const interrupted = await checkFounderIdentity(stateDir, { signer });
    expect(interrupted.mode).toBe('identity_enabled');
    expect(interrupted.foundation_ok).toBe(false);
    const resumed = await commitFounderBootstrap(
      runtime,
      plan,
      signer,
      bootstrapDependencies,
    );
    expect(resumed.created_paths).toEqual([pointerPath]);
    expect(readFileSync(manifestPath!, 'utf8')).toBe(manifestBytes);
    expect((await checkFounderIdentity(stateDir, { signer })).foundation_ok).toBe(
      true,
    );

    writeFileSync(registryPath!, `${readFileSync(registryPath!, 'utf8')} `, {
      mode: 0o600,
    });
    const tampered = await checkFounderIdentity(stateDir, { signer });
    expect(tampered.mode).toBe('identity_enabled');
    expect(tampered.foundation_ok).toBe(false);
    expect(
      tampered.checks.find((item) => item.id === 'bundle-integrity')?.ok,
    ).toBe(false);
  });
});
