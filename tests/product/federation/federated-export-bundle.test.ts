import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFederatedExportBundle,
  type CreateFederatedExportBundleRequest,
  type FederatedExportIdentitySource,
  type FederatedExportOutboxSource,
  verifyFederatedExportBundle,
} from '../../../src/product/federation/export-bundle.js';
import {
  canonicalJson,
  sha256Digest,
} from '../../../src/product/federation/foundation/canonical-json.js';
import type {
  FederatedEventV1,
  FederatedExportManifestV1,
  FederationId,
  LocalIdentityManifestV1,
  PublicationPolicyV1,
  Sha256Digest,
} from '../../../src/product/federation/contracts.js';
import type {
  HistoricalPublicationPolicyReference,
  VerifiedHistoricalIdentityManifest,
  VerifiedHistoricalPublicationPolicy,
} from '../../../src/product/federation/identity-lineage-store.js';
import type {
  StoredFederatedOutboxEvent,
  VerifiedFederatedChain,
} from '../../../src/product/federation/outbox-store.js';
import {
  createSignedDocument,
  signedPayload,
} from '../../../src/product/federation/foundation/signed-document.js';
import {
  CountingInstallationSigner as TestSigner,
  federatedApprovalGroupDrafts,
  signFederatedApprovalGroupDrafts,
} from './fixtures/federated-records.js';

const ROOT_TIME = '2026-07-19T20:00:00.000Z';
const CURRENT_TIME = '2026-07-19T20:10:00.000Z';
const POLICY_TIME = '2026-07-19T20:15:00.000Z';
const EVENT_TIME = '2026-07-19T20:30:00.000Z';
const EXPORT_TIME = '2026-07-19T21:00:00.000Z';
const ORG_ID = 'org_00000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = 'prn_00000000-0000-4000-8000-000000000001';
const MEMBERSHIP_ID = 'mem_00000000-0000-4000-8000-000000000001';
const DEVICE_ID = 'dev_00000000-0000-4000-8000-000000000001';
const INSTALLATION_ID = 'ins_00000000-0000-4000-8000-000000000001';
const EXPORT_SIGNING_INSTALLATION_ID =
  'ins_00000000-0000-4000-8000-000000000002';
const ROOT_MANIFEST_ID = 'idm_00000000-0000-4000-8000-000000000001';
const CURRENT_MANIFEST_ID = 'idm_00000000-0000-4000-8000-000000000002';
const EXTRA_MANIFEST_ID = 'idm_00000000-0000-4000-8000-000000000003';
const CLAIM_ID = 'clm_00000000-0000-4000-8000-000000000001';
const POLICY_ID = 'pol_00000000-0000-4000-8000-000000000001';
const EARLY_POLICY_ID = 'pol_00000000-0000-4000-8000-000000000002';
const SOURCE_BINDING_ID = 'bnd_00000000-0000-4000-8000-000000000001';
const PROCESSOR_BINDING_ID = 'bnd_00000000-0000-4000-8000-000000000002';
const SOURCE_CONNECTION_ID = 'con_00000000-0000-4000-8000-000000000001';
const EXPORT_ID = 'exp_00000000-0000-4000-8000-000000000001';
const DIGEST_A = `sha256:${'a'.repeat(64)}` as const;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as const;
const DIGEST_C = `sha256:${'c'.repeat(64)}` as const;
const DECISION_ID = `decision:sha256:${'1'.repeat(64)}`;
const ACTION_ID = `action:sha256:${'2'.repeat(64)}`;
const APPROVAL_ID = 'approval-export-fixture';
const MEETING_ID = 'meeting-export-fixture';
const NODE_ID = 'node-export-fixture';
const PROCESSING_KEY = 'processing-export-fixture';
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

class FixtureIdentitySource implements FederatedExportIdentitySource {
  private readonly activeManifestId: string;

  constructor(
    private readonly manifests: ReadonlyMap<
      string,
      VerifiedHistoricalIdentityManifest
    >,
    private readonly policies: ReadonlyMap<
      string,
      VerifiedHistoricalPublicationPolicy
    >,
    activeManifestId?: string,
  ) {
    this.activeManifestId =
      activeManifestId ?? [...this.manifests.keys()].at(-1)!;
  }

  loadVerifiedActiveManifest(): VerifiedHistoricalIdentityManifest {
    return this.loadVerifiedManifest(this.activeManifestId);
  }

  loadVerifiedManifest(manifestId: string): VerifiedHistoricalIdentityManifest {
    const manifest = this.manifests.get(manifestId);
    if (manifest === undefined)
      throw new Error(`missing manifest ${manifestId}`);
    return manifest;
  }

  loadVerifiedManifestBySha256(
    sha256: Sha256Digest,
  ): VerifiedHistoricalIdentityManifest {
    const matches = [...this.manifests.values()].filter(
      (manifest) => manifest.sha256 === sha256,
    );
    if (matches.length !== 1) {
      throw new Error(
        `manifest digest ${sha256} resolved ${matches.length} times`,
      );
    }
    return matches[0]!;
  }

  loadVerifiedPolicy(
    reference: HistoricalPublicationPolicyReference,
    _observedAt: string,
  ): VerifiedHistoricalPublicationPolicy {
    const key = `${reference.policy_id}:v${reference.version}`;
    const material = this.policies.get(key);
    if (
      material === undefined ||
      material.sha256 !== reference.policy_sha256 ||
      material.policy.identity_manifest_id !== reference.identity_manifest_id ||
      material.policy.issued_by.installation_id !==
        reference.signer_installation_id ||
      material.policy.issued_by.key_id !== reference.signer_key_id
    ) {
      throw new Error(`missing policy ${key}`);
    }
    return material;
  }
}

class FixtureOutbox implements FederatedExportOutboxSource {
  calls = 0;

  constructor(private readonly chain: VerifiedFederatedChain) {}

  async verifyInstallationChain(
    installationId: string,
    verificationKey: Parameters<
      FederatedExportOutboxSource['verifyInstallationChain']
    >[1],
  ): Promise<VerifiedFederatedChain> {
    this.calls += 1;
    if (installationId !== INSTALLATION_ID) {
      throw new Error('fixture outbox verification mismatch');
    }
    for (const event of this.chain.events) {
      const eventKey =
        typeof verificationKey === 'function'
          ? verificationKey(event)
          : verificationKey;
      if (eventKey.key_id !== event.envelope.producer.key_id) {
        throw new Error('fixture outbox verification mismatch');
      }
    }
    return this.chain;
  }
}

interface Fixture {
  root: string;
  signer: TestSigner;
  outbox: FixtureOutbox;
  identitySource: FixtureIdentitySource;
  rootManifest: LocalIdentityManifestV1;
  currentManifest: LocalIdentityManifestV1;
  events: readonly StoredFederatedOutboxEvent[];
  request: CreateFederatedExportBundleRequest;
}

function outputRoot(): string {
  const created = mkdtempSync(join(tmpdir(), 'echo-federated-export-'));
  const root = realpathSync(created);
  chmodSync(root, 0o700);
  temporary.push(root);
  return root;
}

function manifestPayload(
  signer: TestSigner,
  manifestId: string,
  predecessorManifestId: string | null,
  createdAt: string,
): Omit<LocalIdentityManifestV1, 'integrity'> {
  return {
    schema_version: 1,
    kind: 'echo-local-identity-manifest',
    manifest_id: manifestId,
    predecessor_manifest_id: predecessorManifestId,
    created_at: createdAt,
    authority: {
      kind: 'local-founder-bootstrap',
      assurance: 'founder_attested',
    },
    organization: {
      organization_id: ORG_ID,
      display_name: 'Echo Fixture',
      created_at: ROOT_TIME,
    },
    principal: {
      principal_id: PRINCIPAL_ID,
      organization_id: ORG_ID,
      kind: 'human',
      display_name: 'Founder Fixture',
    },
    membership: {
      membership_id: MEMBERSHIP_ID,
      organization_id: ORG_ID,
      principal_id: PRINCIPAL_ID,
      type: 'owner',
      status: 'active',
      valid_from: ROOT_TIME,
    },
    installation: {
      installation_id: signer.descriptor.installation_id,
      organization_id: ORG_ID,
      membership_id: MEMBERSHIP_ID,
      device_id: DEVICE_ID,
      device_class: 'byod',
      enrolled_at: ROOT_TIME,
      product: {
        name: 'echo-brain',
        version: '0.1.0-dev.7',
        source_sha: '1'.repeat(40),
      },
      signing_key: {
        key_id: signer.descriptor.key_id,
        algorithm: signer.descriptor.algorithm,
        public_key_spki_der_base64:
          signer.descriptor.public_key_spki_der_base64,
        protection: signer.descriptor.protection,
        assurance: signer.descriptor.assurance,
      },
    },
    identity_claims: [
      {
        claim_id: CLAIM_ID,
        principal_id: PRINCIPAL_ID,
        issuer: { kind: 'provider', provider: 'slack', tenant_id: 'T123' },
        subject: { kind: 'user', id: 'U123' },
        verification: {
          method: 'slack_dm_challenge',
          assurance: 'provider_challenge_observed',
          verified_at: ROOT_TIME,
          evidence_sha256: DIGEST_A,
        },
      },
    ],
    legacy_cutover: {
      declared_at: ROOT_TIME,
      pre_cutover_default: 'disposable_test',
      native_records_require: [
        'source-attribution-v1',
        'processor-attribution-v1',
        'approval-context-v1',
        'signed-outbox-v1',
      ],
    },
  };
}

function publicationSnapshot(): PublicationPolicyV1['publication'] {
  return {
    payload_scope:
      'approved-signal-with-meeting-context-brief-digest-and-bounded-evidence',
    audience: {
      scope: 'organization',
      subjects: [{ kind: 'organization', id: ORG_ID }],
    },
    sensitivity: 'internal',
    retention: { kind: 'indefinite' },
    raw_meeting_content: 'local-only',
    participant_observations: 'included-namespaced',
  };
}

async function signedPolicy(
  signer: TestSigner,
  manifestId: string,
  policyId = POLICY_ID,
  effectiveAt = POLICY_TIME,
): Promise<PublicationPolicyV1> {
  return createSignedDocument(
    {
      schema_version: 1,
      kind: 'echo-publication-policy',
      policy_id: policyId,
      organization_id: ORG_ID,
      identity_manifest_id: manifestId,
      issued_by: {
        installation_id: signer.descriptor.installation_id,
        key_id: signer.descriptor.key_id,
      },
      version: 1,
      effective_at: effectiveAt,
      publication: publicationSnapshot(),
    } satisfies Omit<PublicationPolicyV1, 'integrity'>,
    signer,
    signer.descriptor.installation_id,
    signer.descriptor.key_id,
  );
}

async function signedEventGroup(
  signer: TestSigner,
  manifest: LocalIdentityManifestV1,
  policy: PublicationPolicyV1,
  manifestSha256: Sha256Digest,
  options: {
    sequence_offset?: number;
    previous_event_hash?: Sha256Digest | null;
    approval_id?: string;
    decision_id?: string;
    action_id?: string;
    slack_claim_id?: FederationId;
    source_identity?: {
      manifest_id: FederationId;
      sha256: Sha256Digest;
    };
    processor_identity?: {
      manifest_id: FederationId;
      sha256: Sha256Digest;
    };
    event_time?: string;
    mutate_source?: (source: FederatedEventV1['source']) => void;
    mutate_processor?: (processor: FederatedEventV1['processor']) => void;
    mutate_approval?: (approval: FederatedEventV1['approval']) => void;
  } = {},
): Promise<StoredFederatedOutboxEvent[]> {
  const approvalId = options.approval_id ?? APPROVAL_ID;
  const eventTime = options.event_time ?? EVENT_TIME;
  const drafts = federatedApprovalGroupDrafts({
    signer,
    occurredAt: eventTime,
    approvalId,
    decisionId: options.decision_id ?? DECISION_ID,
    actionId: options.action_id ?? ACTION_ID,
    digests: { a: DIGEST_A, b: DIGEST_B, c: DIGEST_C },
    organizationId: ORG_ID,
    principalId: PRINCIPAL_ID,
    membershipId: MEMBERSHIP_ID,
    manifestId: manifest.manifest_id,
    manifestSha256,
    sourceManifestId: options.source_identity?.manifest_id,
    sourceManifestSha256: options.source_identity?.sha256,
    processorManifestId: options.processor_identity?.manifest_id,
    processorManifestSha256: options.processor_identity?.sha256,
    sourceBindingId: SOURCE_BINDING_ID,
    processorBindingId: PROCESSOR_BINDING_ID,
    sourceConnectionId: SOURCE_CONNECTION_ID,
    policy: {
      policyId: policy.policy_id,
      version: policy.version,
      sha256: sha256Digest(canonicalJson(policy)),
      identityManifestId: policy.identity_manifest_id,
      signerInstallationId: policy.issued_by.installation_id,
      signerKeyId: policy.issued_by.key_id,
      publication: policy.publication,
    },
    productVersion: '0.1.0-dev.7',
    idOffset: options.sequence_offset,
    meetingId: MEETING_ID,
    meetingTitle: 'Federated export fixture',
    briefId: 'brief-export-fixture',
    nodeId: `${NODE_ID}-${approvalId}`,
    processingKey: PROCESSING_KEY,
    sourceExternalId: 'granola-note-1',
    sourceRevision: 'revision-1',
    decisionText: 'Ship the deterministic federated export.',
    actionText: 'Verify the exact exported bytes.',
    approvalReason: 'Founder approved the fixture.',
    slackClaimId: options.slack_claim_id,
  });
  for (const draft of drafts) {
    options.mutate_source?.(draft.envelope.source);
    options.mutate_processor?.(draft.envelope.processor);
    options.mutate_approval?.(draft.envelope.approval);
  }
  return signFederatedApprovalGroupDrafts({
    signer,
    drafts,
    sequenceOffset: options.sequence_offset,
    previousEventHash: options.previous_event_hash,
  });
}
async function fixture(): Promise<Fixture> {
  const signer = new TestSigner();
  const rootManifest = await createSignedDocument(
    manifestPayload(signer, ROOT_MANIFEST_ID, null, ROOT_TIME),
    signer,
    INSTALLATION_ID,
    signer.descriptor.key_id,
  );
  const currentManifest = await createSignedDocument(
    manifestPayload(
      signer,
      CURRENT_MANIFEST_ID,
      ROOT_MANIFEST_ID,
      CURRENT_TIME,
    ),
    signer,
    INSTALLATION_ID,
    signer.descriptor.key_id,
  );
  const policy = await signedPolicy(signer, ROOT_MANIFEST_ID);
  const rootCanonical = canonicalJson(rootManifest);
  const currentCanonical = canonicalJson(currentManifest);
  const policyCanonical = canonicalJson(policy);
  const events = await signedEventGroup(
    signer,
    rootManifest,
    policy,
    sha256Digest(rootCanonical),
  );
  const manifests = new Map<string, VerifiedHistoricalIdentityManifest>([
    [
      ROOT_MANIFEST_ID,
      {
        manifest: rootManifest,
        canonical: rootCanonical,
        sha256: sha256Digest(rootCanonical),
      },
    ],
    [
      CURRENT_MANIFEST_ID,
      {
        manifest: currentManifest,
        canonical: currentCanonical,
        sha256: sha256Digest(currentCanonical),
      },
    ],
  ]);
  const policies = new Map<string, VerifiedHistoricalPublicationPolicy>([
    [
      `${POLICY_ID}:v1`,
      {
        policy,
        manifest: rootManifest,
        canonical: policyCanonical,
        sha256: sha256Digest(policyCanonical),
      },
    ],
  ]);
  const identitySource = new FixtureIdentitySource(manifests, policies);
  const chain: VerifiedFederatedChain = {
    head: {
      installation_id: INSTALLATION_ID,
      last_sequence: events.length,
      last_event_hash: events.at(-1)!.event_hash,
      updated_at: EVENT_TIME,
    },
    events,
  };
  const outbox = new FixtureOutbox(chain);
  const root = outputRoot();
  const request: CreateFederatedExportBundleRequest = {
    output_root: root,
    installation_id: INSTALLATION_ID,
    signing_identity_manifest_id: CURRENT_MANIFEST_ID,
    first_sequence: 1,
    last_sequence: 2,
    export_id: EXPORT_ID,
    generated_at: EXPORT_TIME,
    signer,
    outbox,
    identity_source: identitySource,
  };
  return {
    root,
    signer,
    outbox,
    identitySource,
    rootManifest,
    currentManifest,
    events,
    request,
  };
}

async function rewriteManifest(
  bundlePath: string,
  signer: TestSigner,
  mutate: (
    payload: Omit<FederatedExportManifestV1, 'integrity'>,
  ) => Omit<FederatedExportManifestV1, 'integrity'>,
): Promise<void> {
  const path = join(bundlePath, 'export-manifest.v1.json');
  const current = JSON.parse(
    readFileSync(path, 'utf8'),
  ) as FederatedExportManifestV1;
  const payload = mutate(
    signedPayload(current) as unknown as Omit<
      FederatedExportManifestV1,
      'integrity'
    >,
  );
  const signed = await createSignedDocument(
    payload,
    signer,
    INSTALLATION_ID,
    signer.descriptor.key_id,
  );
  writeFileSync(path, canonicalJson(signed), { mode: 0o600 });
  chmodSync(path, 0o600);
}

describe('deterministic federated export bundle', () => {
  it('exports exact envelope bytes with complete deterministic verification closure and repeats without consuming', async () => {
    const value = await fixture();
    const signCallsBeforeExport = value.signer.signCalls;
    const created = await createFederatedExportBundle(value.request);

    expect(created.created).toBe(true);
    expect(basename(created.path)).toBe(
      `echo-org-export-${INSTALLATION_ID}-1-2`,
    );
    const expectedRecords = Buffer.from(
      `${value.events.map((event) => event.envelope_json).join('\n')}\n`,
      'utf8',
    );
    expect(created.records_bytes.equals(expectedRecords)).toBe(true);
    expect(created.manifest.records.sha256).toBe(sha256Digest(expectedRecords));
    expect(created.manifest.records.sha256).not.toBe(
      sha256Digest(expectedRecords.subarray(0, -1)),
    );
    expect(created.manifest.sequence).toEqual({
      first: 1,
      last: 2,
      predecessor_hash: null,
      head_hash: value.events[1]!.event_hash,
    });
    expect(created.manifest.artifacts.map((artifact) => artifact.path)).toEqual(
      [
        `identity-manifests/identity-manifest.${ROOT_MANIFEST_ID}.v1.json`,
        `identity-manifests/identity-manifest.${CURRENT_MANIFEST_ID}.v1.json`,
        `publication-policies/publication-policy.${POLICY_ID}.v1.json`,
      ],
    );

    const verified = verifyFederatedExportBundle(created.path);
    expect(verified.events.map((event) => event.event_id)).toEqual(
      value.events.map((event) => event.event_id),
    );
    expect([...verified.identity_manifests]).toHaveLength(2);
    expect([...verified.publication_policies]).toHaveLength(1);
    expect(lstatSync(created.path).mode & 0o777).toBe(0o700);
    expect(
      lstatSync(join(created.path, 'identity-manifests')).mode & 0o777,
    ).toBe(0o700);
    for (const file of [
      'export-manifest.v1.json',
      'records.v1.jsonl',
      ...created.manifest.artifacts.map((artifact) => artifact.path),
    ]) {
      expect(lstatSync(join(created.path, file)).mode & 0o777).toBe(0o600);
    }

    const signCallsAfterFirstExport = value.signer.signCalls;
    expect(signCallsAfterFirstExport).toBe(signCallsBeforeExport + 1);
    const repeated = await createFederatedExportBundle(value.request);
    expect(repeated.created).toBe(false);
    expect(repeated.manifest_json).toBe(created.manifest_json);
    expect(value.signer.signCalls).toBe(signCallsAfterFirstExport);
    expect(value.outbox.calls).toBe(2);
    expect(
      readdirSync(value.root).some((name) => name.includes('.staging-')),
    ).toBe(false);
  });

  it('rejects a range that cuts an approval group before signing or staging', async () => {
    const value = await fixture();
    const signCalls = value.signer.signCalls;
    await expect(
      createFederatedExportBundle({
        ...value.request,
        last_sequence: 1,
        export_id: 'exp_00000000-0000-4000-8000-000000000002',
      }),
    ).rejects.toThrow('incomplete in the export range');
    expect(value.signer.signCalls).toBe(signCalls);
    expect(readdirSync(value.root)).toEqual([]);
  });

  it('preserves export errors for each signal-manifest invariant', async () => {
    const value = await fixture();
    const cases = [
      {
        message: 'duplicate signal IDs',
        mutate: (
          manifest: FederatedEventV1['record']['approval_group']['signal_manifest'],
        ) => [...manifest, manifest[0]!],
      },
      {
        message: 'non-contiguous signal positions',
        mutate: (
          manifest: FederatedEventV1['record']['approval_group']['signal_manifest'],
        ) => [
          { ...manifest[0]!, position_within_kind: 1 },
          ...manifest.slice(1),
        ],
      },
      {
        message: 'non-canonical signal manifest',
        mutate: (
          manifest: FederatedEventV1['record']['approval_group']['signal_manifest'],
        ) => [...manifest].reverse(),
      },
    ];

    for (const item of cases) {
      const events = value.events.map((stored) => ({
        ...stored,
        envelope: {
          ...stored.envelope,
          record: {
            ...stored.envelope.record,
            approval_group: {
              ...stored.envelope.record.approval_group,
              signal_manifest: item.mutate(
                stored.envelope.record.approval_group.signal_manifest,
              ),
            },
          },
        } as FederatedEventV1,
      }));
      const signCalls = value.signer.signCalls;
      await expect(
        createFederatedExportBundle({
          ...value.request,
          output_root: outputRoot(),
          outbox: new FixtureOutbox({
            head: {
              installation_id: INSTALLATION_ID,
              last_sequence: events.length,
              last_event_hash: events.at(-1)!.event_hash,
              updated_at: EVENT_TIME,
            },
            events,
          }),
        }),
      ).rejects.toThrow(item.message);
      expect(value.signer.signCalls).toBe(signCalls);
    }
  });

  it('rejects creation and offline verification when generated_at precedes an exported event', async () => {
    const value = await fixture();
    const signCalls = value.signer.signCalls;
    await expect(
      createFederatedExportBundle({
        ...value.request,
        generated_at: '2026-07-19T20:20:00.000Z',
      }),
    ).rejects.toThrow('generated_at precedes an exported event');
    expect(value.signer.signCalls).toBe(signCalls);
    expect(readdirSync(value.root)).toEqual([]);

    const lateCreatedAt = '2026-07-19T20:50:00.000Z';
    const lateStoredEvents = value.events.map((event) => ({
      ...event,
      created_at: lateCreatedAt,
    }));
    await expect(
      createFederatedExportBundle({
        ...value.request,
        generated_at: '2026-07-19T20:40:00.000Z',
        outbox: new FixtureOutbox({
          head: {
            installation_id: INSTALLATION_ID,
            last_sequence: lateStoredEvents.length,
            last_event_hash: lateStoredEvents.at(-1)!.event_hash,
            updated_at: lateCreatedAt,
          },
          events: lateStoredEvents,
        }),
      }),
    ).rejects.toThrow(
      'generated_at precedes an exported outbox event creation time',
    );
    expect(value.signer.signCalls).toBe(signCalls);
    expect(readdirSync(value.root)).toEqual([]);

    const created = await createFederatedExportBundle(value.request);
    await rewriteManifest(created.path, value.signer, (payload) => ({
      ...payload,
      generated_at: '2026-07-19T20:20:00.000Z',
    }));
    expect(() => verifyFederatedExportBundle(created.path)).toThrow(
      'generated_at precedes an exported event',
    );
  });

  it('verifies A/B historical event keys, an independent policy signer, and current export signer C', async () => {
    const signerA = new TestSigner(INSTALLATION_ID);
    const signerB = new TestSigner(INSTALLATION_ID);
    const signerC = new TestSigner(EXPORT_SIGNING_INSTALLATION_ID);
    const manifestA = await createSignedDocument(
      manifestPayload(signerA, ROOT_MANIFEST_ID, null, ROOT_TIME),
      signerA,
      INSTALLATION_ID,
      signerA.descriptor.key_id,
    );
    const manifestB = await createSignedDocument(
      manifestPayload(
        signerB,
        CURRENT_MANIFEST_ID,
        ROOT_MANIFEST_ID,
        CURRENT_TIME,
      ),
      signerB,
      INSTALLATION_ID,
      signerB.descriptor.key_id,
    );
    const manifestC = await createSignedDocument(
      manifestPayload(
        signerC,
        EXTRA_MANIFEST_ID,
        CURRENT_MANIFEST_ID,
        '2026-07-19T20:40:00.000Z',
      ),
      signerC,
      EXPORT_SIGNING_INSTALLATION_ID,
      signerC.descriptor.key_id,
    );
    const policyA = await signedPolicy(
      signerA,
      ROOT_MANIFEST_ID,
      EARLY_POLICY_ID,
      '2026-07-19T20:05:00.000Z',
    );
    const policyB = await signedPolicy(signerB, CURRENT_MANIFEST_ID);
    const canonicalA = canonicalJson(manifestA);
    const canonicalB = canonicalJson(manifestB);
    const canonicalC = canonicalJson(manifestC);
    const canonicalPolicyA = canonicalJson(policyA);
    const canonicalPolicyB = canonicalJson(policyB);
    const eventsA = await signedEventGroup(
      signerA,
      manifestA,
      policyA,
      sha256Digest(canonicalA),
      {
        approval_id: 'approval-a',
        decision_id: `decision:sha256:${'3'.repeat(64)}`,
        action_id: `action:sha256:${'4'.repeat(64)}`,
        event_time: '2026-07-19T20:08:00.000Z',
        source_identity: {
          manifest_id: ROOT_MANIFEST_ID,
          sha256: sha256Digest(canonicalA),
        },
        processor_identity: {
          manifest_id: ROOT_MANIFEST_ID,
          sha256: sha256Digest(canonicalA),
        },
      },
    );
    const eventsB = await signedEventGroup(
      signerB,
      manifestB,
      policyB,
      sha256Digest(canonicalB),
      {
        sequence_offset: eventsA.length,
        previous_event_hash: eventsA.at(-1)!.event_hash,
        approval_id: 'approval-b',
        decision_id: `decision:sha256:${'5'.repeat(64)}`,
        action_id: `action:sha256:${'6'.repeat(64)}`,
        source_identity: {
          manifest_id: ROOT_MANIFEST_ID,
          sha256: sha256Digest(canonicalA),
        },
        processor_identity: {
          manifest_id: CURRENT_MANIFEST_ID,
          sha256: sha256Digest(canonicalB),
        },
      },
    );
    const events = [...eventsA, ...eventsB];
    const identitySource = new FixtureIdentitySource(
      new Map([
        [
          ROOT_MANIFEST_ID,
          {
            manifest: manifestA,
            canonical: canonicalA,
            sha256: sha256Digest(canonicalA),
          },
        ],
        [
          CURRENT_MANIFEST_ID,
          {
            manifest: manifestB,
            canonical: canonicalB,
            sha256: sha256Digest(canonicalB),
          },
        ],
        [
          EXTRA_MANIFEST_ID,
          {
            manifest: manifestC,
            canonical: canonicalC,
            sha256: sha256Digest(canonicalC),
          },
        ],
      ]),
      new Map([
        [
          `${EARLY_POLICY_ID}:v1`,
          {
            policy: policyA,
            manifest: manifestA,
            canonical: canonicalPolicyA,
            sha256: sha256Digest(canonicalPolicyA),
          },
        ],
        [
          `${POLICY_ID}:v1`,
          {
            policy: policyB,
            manifest: manifestB,
            canonical: canonicalPolicyB,
            sha256: sha256Digest(canonicalPolicyB),
          },
        ],
      ]),
    );
    const outbox = new FixtureOutbox({
      head: {
        installation_id: INSTALLATION_ID,
        last_sequence: events.length,
        last_event_hash: events.at(-1)!.event_hash,
        updated_at: EVENT_TIME,
      },
      events,
    });
    const created = await createFederatedExportBundle({
      output_root: outputRoot(),
      installation_id: INSTALLATION_ID,
      signing_identity_manifest_id: EXTRA_MANIFEST_ID,
      first_sequence: 1,
      last_sequence: events.length,
      export_id: 'exp_00000000-0000-4000-8000-000000000002',
      generated_at: EXPORT_TIME,
      signer: signerC,
      outbox,
      identity_source: identitySource,
    });

    expect(created.manifest.installation_id).toBe(INSTALLATION_ID);
    expect(created.manifest.key_id).toBe(signerC.descriptor.key_id);
    expect(created.manifest.signing_identity_manifest_id).toBe(
      EXTRA_MANIFEST_ID,
    );
    expect(created.manifest.artifacts.map(({ path }) => path)).toEqual([
      `identity-manifests/identity-manifest.${ROOT_MANIFEST_ID}.v1.json`,
      `identity-manifests/identity-manifest.${CURRENT_MANIFEST_ID}.v1.json`,
      `identity-manifests/identity-manifest.${EXTRA_MANIFEST_ID}.v1.json`,
      `publication-policies/publication-policy.${POLICY_ID}.v1.json`,
      `publication-policies/publication-policy.${EARLY_POLICY_ID}.v1.json`,
    ]);
    const verified = verifyFederatedExportBundle(created.path);
    expect(verified.events.map((event) => event.producer.key_id)).toEqual([
      signerA.descriptor.key_id,
      signerA.descriptor.key_id,
      signerB.descriptor.key_id,
      signerB.descriptor.key_id,
    ]);
    expect(
      verified.events.map((event) => event.publication.identity_manifest_id),
    ).toEqual([
      ROOT_MANIFEST_ID,
      ROOT_MANIFEST_ID,
      CURRENT_MANIFEST_ID,
      CURRENT_MANIFEST_ID,
    ]);
    expect(
      verified.events.every(
        (event) =>
          event.source.identity_manifest_id === ROOT_MANIFEST_ID &&
          event.source.identity_manifest_sha256 === sha256Digest(canonicalA),
      ),
    ).toBe(true);
    expect(
      verified.events.map((event) => ({
        id: event.processor.identity_manifest_id,
        sha256: event.processor.identity_manifest_sha256,
      })),
    ).toEqual([
      { id: ROOT_MANIFEST_ID, sha256: sha256Digest(canonicalA) },
      { id: ROOT_MANIFEST_ID, sha256: sha256Digest(canonicalA) },
      { id: CURRENT_MANIFEST_ID, sha256: sha256Digest(canonicalB) },
      { id: CURRENT_MANIFEST_ID, sha256: sha256Digest(canonicalB) },
    ]);

    const oldSignerCalls = signerB.signCalls;
    await expect(
      createFederatedExportBundle({
        output_root: outputRoot(),
        installation_id: INSTALLATION_ID,
        signing_identity_manifest_id: CURRENT_MANIFEST_ID,
        first_sequence: 1,
        last_sequence: events.length,
        export_id: 'exp_00000000-0000-4000-8000-000000000099',
        generated_at: EXPORT_TIME,
        signer: signerB,
        outbox,
        identity_source: identitySource,
      }),
    ).rejects.toThrow('not the verified active identity manifest');
    expect(signerB.signCalls).toBe(oldSignerCalls);

    await rewriteManifest(created.path, signerB, (payload) => ({
      ...payload,
      key_id: signerB.descriptor.key_id,
      signing_identity_manifest_id: CURRENT_MANIFEST_ID,
    }));
    expect(() => verifyFederatedExportBundle(created.path)).toThrow(
      'not the unique newest lineage leaf',
    );
  });

  it('rejects source and processor identity references whose IDs and digests resolve to different manifests', async () => {
    const value = await fixture();
    const rootMaterial =
      value.identitySource.loadVerifiedManifest(ROOT_MANIFEST_ID);
    const currentMaterial =
      value.identitySource.loadVerifiedManifest(CURRENT_MANIFEST_ID);
    const publication = value.events[0]!.envelope.publication;
    const policy = value.identitySource.loadVerifiedPolicy(
      {
        policy_id: publication.policy_id,
        version: publication.version,
        policy_sha256: publication.policy_sha256,
        identity_manifest_id: publication.identity_manifest_id,
        signer_installation_id: publication.signer_installation_id,
        signer_key_id: publication.signer_key_id,
      },
      EVENT_TIME,
    ).policy;

    const invalidSourceEvents = await signedEventGroup(
      value.signer,
      value.rootManifest,
      policy,
      rootMaterial.sha256,
      {
        source_identity: {
          manifest_id: ROOT_MANIFEST_ID,
          sha256: currentMaterial.sha256,
        },
      },
    );
    const invalidSourceSignCalls = value.signer.signCalls;
    await expect(
      createFederatedExportBundle({
        ...value.request,
        output_root: outputRoot(),
        outbox: new FixtureOutbox({
          head: {
            installation_id: INSTALLATION_ID,
            last_sequence: invalidSourceEvents.length,
            last_event_hash: invalidSourceEvents.at(-1)!.event_hash,
            updated_at: EVENT_TIME,
          },
          events: invalidSourceEvents,
        }),
      }),
    ).rejects.toThrow(
      'source identity manifest ID and digest resolved to conflicting bytes',
    );
    expect(value.signer.signCalls).toBe(invalidSourceSignCalls);

    const invalidProcessorEvents = await signedEventGroup(
      value.signer,
      value.rootManifest,
      policy,
      rootMaterial.sha256,
      {
        processor_identity: {
          manifest_id: CURRENT_MANIFEST_ID,
          sha256: rootMaterial.sha256,
        },
      },
    );
    const invalidProcessorSignCalls = value.signer.signCalls;
    await expect(
      createFederatedExportBundle({
        ...value.request,
        output_root: outputRoot(),
        outbox: new FixtureOutbox({
          head: {
            installation_id: INSTALLATION_ID,
            last_sequence: invalidProcessorEvents.length,
            last_event_hash: invalidProcessorEvents.at(-1)!.event_hash,
            updated_at: EVENT_TIME,
          },
          events: invalidProcessorEvents,
        }),
      }),
    ).rejects.toThrow(
      'processor identity manifest ID and digest resolved to conflicting bytes',
    );
    expect(value.signer.signCalls).toBe(invalidProcessorSignCalls);
  });

  it('rejects source or processor manifests that reverse capture chronology', async () => {
    const value = await fixture();
    const rootMaterial =
      value.identitySource.loadVerifiedManifest(ROOT_MANIFEST_ID);
    const currentMaterial =
      value.identitySource.loadVerifiedManifest(CURRENT_MANIFEST_ID);
    const publication = value.events[0]!.envelope.publication;
    const policy = value.identitySource.loadVerifiedPolicy(
      {
        policy_id: publication.policy_id,
        version: publication.version,
        policy_sha256: publication.policy_sha256,
        identity_manifest_id: publication.identity_manifest_id,
        signer_installation_id: publication.signer_installation_id,
        signer_key_id: publication.signer_key_id,
      },
      EVENT_TIME,
    ).policy;
    const cases = [
      {
        signerManifest: value.currentManifest,
        signerDigest: currentMaterial.sha256,
        source: {
          manifest_id: CURRENT_MANIFEST_ID,
          sha256: currentMaterial.sha256,
        },
        processor: {
          manifest_id: ROOT_MANIFEST_ID,
          sha256: rootMaterial.sha256,
        },
      },
      {
        signerManifest: value.rootManifest,
        signerDigest: rootMaterial.sha256,
        source: {
          manifest_id: ROOT_MANIFEST_ID,
          sha256: rootMaterial.sha256,
        },
        processor: {
          manifest_id: CURRENT_MANIFEST_ID,
          sha256: currentMaterial.sha256,
        },
      },
    ] as const;

    for (const item of cases) {
      const events = await signedEventGroup(
        value.signer,
        item.signerManifest,
        policy,
        item.signerDigest,
        {
          source_identity: item.source,
          processor_identity: item.processor,
        },
      );
      await expect(
        createFederatedExportBundle({
          ...value.request,
          output_root: outputRoot(),
          outbox: new FixtureOutbox({
            head: {
              installation_id: INSTALLATION_ID,
              last_sequence: events.length,
              last_event_hash: events.at(-1)!.event_hash,
              updated_at: EVENT_TIME,
            },
            events,
          }),
        }),
      ).rejects.toThrow('not in capture chronology');
    }
  });

  it('rejects source and processor configuration snapshots whose digests drift', async () => {
    const value = await fixture();
    const publication = value.events[0]!.envelope.publication;
    const policy = value.identitySource.loadVerifiedPolicy(
      {
        policy_id: publication.policy_id,
        version: publication.version,
        policy_sha256: publication.policy_sha256,
        identity_manifest_id: publication.identity_manifest_id,
        signer_installation_id: publication.signer_installation_id,
        signer_key_id: publication.signer_key_id,
      },
      EVENT_TIME,
    ).policy;
    const cases = [
      {
        message: 'invalid source identity reference',
        options: {
          mutate_source: (source: FederatedEventV1['source']) => {
            source.binding.configuration_snapshot = { page_size: 101 };
          },
        },
      },
      {
        message: 'invalid processor identity reference',
        options: {
          mutate_processor: (processor: FederatedEventV1['processor']) => {
            processor.configuration_snapshot = { model: 'other-model' };
          },
        },
      },
    ] as const;

    for (const item of cases) {
      const events = await signedEventGroup(
        value.signer,
        value.rootManifest,
        policy,
        sha256Digest(canonicalJson(value.rootManifest)),
        item.options,
      );
      await expect(
        createFederatedExportBundle({
          ...value.request,
          output_root: outputRoot(),
          outbox: new FixtureOutbox({
            head: {
              installation_id: INSTALLATION_ID,
              last_sequence: events.length,
              last_event_hash: events.at(-1)!.event_hash,
              updated_at: EVENT_TIME,
            },
            events,
          }),
        }),
      ).rejects.toThrow(item.message);
    }
  });

  it('rejects an ambiguous identity-manifest digest resolution', async () => {
    const value = await fixture();
    const rootMaterial =
      value.identitySource.loadVerifiedManifest(ROOT_MANIFEST_ID);
    const currentMaterial =
      value.identitySource.loadVerifiedManifest(CURRENT_MANIFEST_ID);
    const publication = value.events[0]!.envelope.publication;
    const policyMaterial = value.identitySource.loadVerifiedPolicy(
      {
        policy_id: publication.policy_id,
        version: publication.version,
        policy_sha256: publication.policy_sha256,
        identity_manifest_id: publication.identity_manifest_id,
        signer_installation_id: publication.signer_installation_id,
        signer_key_id: publication.signer_key_id,
      },
      EVENT_TIME,
    );
    const ambiguousSource = new FixtureIdentitySource(
      new Map([
        [ROOT_MANIFEST_ID, rootMaterial],
        [
          CURRENT_MANIFEST_ID,
          { ...currentMaterial, sha256: rootMaterial.sha256 },
        ],
      ]),
      new Map([[`${POLICY_ID}:v1`, policyMaterial]]),
      ROOT_MANIFEST_ID,
    );
    const signCalls = value.signer.signCalls;
    await expect(
      createFederatedExportBundle({
        ...value.request,
        output_root: outputRoot(),
        signing_identity_manifest_id: ROOT_MANIFEST_ID,
        identity_source: ambiguousSource,
      }),
    ).rejects.toThrow('resolved 2 times');
    expect(value.signer.signCalls).toBe(signCalls);
  });

  it('accepts a rotated Slack credential generation but rejects publication-observation identity drift', async () => {
    const value = await fixture();
    const publication = value.events[0]!.envelope.publication;
    const policy = value.identitySource.loadVerifiedPolicy(
      {
        policy_id: publication.policy_id,
        version: publication.version,
        policy_sha256: publication.policy_sha256,
        identity_manifest_id: publication.identity_manifest_id,
        signer_installation_id: publication.signer_installation_id,
        signer_key_id: publication.signer_key_id,
      },
      EVENT_TIME,
    ).policy;
    const manifestSha256 = sha256Digest(canonicalJson(value.rootManifest));
    const outboxFor = (events: readonly StoredFederatedOutboxEvent[]) =>
      new FixtureOutbox({
        head: {
          installation_id: INSTALLATION_ID,
          last_sequence: events.length,
          last_event_hash: events.at(-1)!.event_hash,
          updated_at: EVENT_TIME,
        },
        events,
      });
    const validEvents = await signedEventGroup(
      value.signer,
      value.rootManifest,
      policy,
      manifestSha256,
      {
        slack_claim_id: CLAIM_ID,
        mutate_approval: (approval) => {
          if (approval.surface === null) throw new Error('expected Slack');
          approval.observation.connection.generation = 2;
          approval.observation.binding.adapter_binding_id =
            'bnd_00000000-0000-4000-8000-000000000099';
        },
      },
    );
    const valid = await createFederatedExportBundle({
      ...value.request,
      output_root: outputRoot(),
      outbox: outboxFor(validEvents),
    });
    expect(verifyFederatedExportBundle(valid.path).events).toHaveLength(2);

    const cases: readonly {
      label: string;
      mutate: (approval: FederatedEventV1['approval']) => void;
    }[] = [
      {
        label: 'connection',
        mutate: (approval) => {
          if (approval.surface === null) throw new Error('expected Slack');
          approval.observation.connection.connection_id =
            'con_00000000-0000-4000-8000-000000000099';
        },
      },
      {
        label: 'owner',
        mutate: (approval) => {
          if (approval.surface === null) throw new Error('expected Slack');
          approval.observation.connection.owner = {
            kind: 'membership',
            id: MEMBERSHIP_ID,
          };
        },
      },
      {
        label: 'bot user',
        mutate: (approval) => {
          if (approval.surface === null) throw new Error('expected Slack');
          approval.observation.connection.provider_identity.bot_user_id =
            'U_DIFFERENT';
        },
      },
      {
        label: 'bot id',
        mutate: (approval) => {
          if (approval.surface === null) throw new Error('expected Slack');
          approval.observation.connection.provider_identity.bot_id =
            'B_DIFFERENT';
        },
      },
      {
        label: 'app id',
        mutate: (approval) => {
          if (approval.surface === null) throw new Error('expected Slack');
          approval.observation.connection.provider_identity.app_id =
            'A_DIFFERENT';
        },
      },
      {
        label: 'enterprise id',
        mutate: (approval) => {
          if (approval.surface === null) throw new Error('expected Slack');
          approval.observation.connection.provider_identity.enterprise_id =
            'E_DIFFERENT';
        },
      },
      {
        label: 'adapter identity',
        mutate: (approval) => {
          if (approval.surface === null) throw new Error('expected Slack');
          approval.observation.binding.adapter.instance_id = 'other-approval';
        },
      },
      {
        label: 'adapter version',
        mutate: (approval) => {
          if (approval.surface === null) throw new Error('expected Slack');
          approval.observation.binding.adapter.version = '2.0.0';
        },
      },
      {
        label: 'configuration snapshot',
        mutate: (approval) => {
          if (approval.surface === null) throw new Error('expected Slack');
          approval.observation.binding.configuration_snapshot = {
            channel_id: 'C123',
            approve_reaction: 'white_check_mark',
            reject_reaction: 'no_entry',
          };
        },
      },
      {
        label: 'configuration digest',
        mutate: (approval) => {
          if (approval.surface === null) throw new Error('expected Slack');
          approval.observation.binding.configuration_sha256 = DIGEST_C;
        },
      },
      {
        label: 'matching snapshots with stale configuration digest',
        mutate: (approval) => {
          if (approval.surface === null) throw new Error('expected Slack');
          const changed = {
            channel_id: 'C123',
            approve_reaction: 'white_check_mark',
            reject_reaction: 'no_entry',
          };
          approval.surface.binding.configuration_snapshot = changed;
          approval.observation.binding.configuration_snapshot = { ...changed };
        },
      },
    ];

    for (const item of cases) {
      const events = await signedEventGroup(
        value.signer,
        value.rootManifest,
        policy,
        manifestSha256,
        {
          slack_claim_id: CLAIM_ID,
          mutate_approval: item.mutate,
        },
      );
      await expect(
        createFederatedExportBundle({
          ...value.request,
          output_root: outputRoot(),
          outbox: outboxFor(events),
        }),
        item.label,
      ).rejects.toThrow('Slack publication and observation snapshots diverge');
    }
  });

  it('rejects Slack approval actors without the captured challenge method, assurance, and null provider timestamp', async () => {
    const value = await fixture();
    const publication = value.events[0]!.envelope.publication;
    const policyMaterial = value.identitySource.loadVerifiedPolicy(
      {
        policy_id: publication.policy_id,
        version: publication.version,
        policy_sha256: publication.policy_sha256,
        identity_manifest_id: publication.identity_manifest_id,
        signer_installation_id: publication.signer_installation_id,
        signer_key_id: publication.signer_key_id,
      },
      EVENT_TIME,
    );
    const currentMaterial =
      value.identitySource.loadVerifiedManifest(CURRENT_MANIFEST_ID);
    const unsignedRoot = signedPayload(value.rootManifest) as unknown as Omit<
      LocalIdentityManifestV1,
      'integrity'
    >;
    const claimCases = [
      {
        assurance: 'provider_challenge_observed' as const,
        approvalAssurance: 'provider_challenge_observed' as const,
      },
      {
        assurance: 'provider_verified' as const,
        approvalAssurance: 'provider_verified' as const,
      },
    ];

    for (const item of claimCases) {
      const rootManifest = await createSignedDocument(
        {
          ...unsignedRoot,
          identity_claims: unsignedRoot.identity_claims.map((claim) => ({
            ...claim,
            verification: {
              ...claim.verification,
              method: 'email_magic_link' as const,
              assurance: item.assurance,
            },
          })),
        } satisfies Omit<LocalIdentityManifestV1, 'integrity'>,
        value.signer,
        INSTALLATION_ID,
        value.signer.descriptor.key_id,
      );
      const rootCanonical = canonicalJson(rootManifest);
      const identitySource = new FixtureIdentitySource(
        new Map([
          [
            ROOT_MANIFEST_ID,
            {
              manifest: rootManifest,
              canonical: rootCanonical,
              sha256: sha256Digest(rootCanonical),
            },
          ],
          [CURRENT_MANIFEST_ID, currentMaterial],
        ]),
        new Map([
          [`${POLICY_ID}:v1`, { ...policyMaterial, manifest: rootManifest }],
        ]),
      );
      const events = await signedEventGroup(
        value.signer,
        rootManifest,
        policyMaterial.policy,
        sha256Digest(rootCanonical),
        {
          slack_claim_id: CLAIM_ID,
          mutate_approval: (approval) => {
            if (approval.surface === null) throw new Error('expected Slack');
            approval.assurance = item.approvalAssurance;
          },
        },
      );
      await expect(
        createFederatedExportBundle({
          ...value.request,
          output_root: outputRoot(),
          identity_source: identitySource,
          outbox: new FixtureOutbox({
            head: {
              installation_id: INSTALLATION_ID,
              last_sequence: events.length,
              last_event_hash: events.at(-1)!.event_hash,
              updated_at: EVENT_TIME,
            },
            events,
          }),
        }),
      ).rejects.toThrow('invalid Slack approval actor claim');
    }

    const providerTimestampEvents = await signedEventGroup(
      value.signer,
      value.rootManifest,
      policyMaterial.policy,
      sha256Digest(canonicalJson(value.rootManifest)),
      {
        slack_claim_id: CLAIM_ID,
        mutate_approval: (approval) => {
          if (approval.surface === null) throw new Error('expected Slack');
          approval.raw_actor_assertion.action.provider_occurred_at =
            '2026-07-19T20:29:00.000Z';
        },
      },
    );
    await expect(
      createFederatedExportBundle({
        ...value.request,
        output_root: outputRoot(),
        outbox: new FixtureOutbox({
          head: {
            installation_id: INSTALLATION_ID,
            last_sequence: providerTimestampEvents.length,
            last_event_hash: providerTimestampEvents.at(-1)!.event_hash,
            updated_at: EVENT_TIME,
          },
          events: providerTimestampEvents,
        }),
      }),
    ).rejects.toThrow('invalid Slack approval actor claim');
  });

  it('fails offline verification for an unbound Slack actor claim and an unknown policy audience', async () => {
    const actorFixture = await fixture();
    const publication = actorFixture.events[0]!.envelope.publication;
    const policy = actorFixture.identitySource.loadVerifiedPolicy(
      {
        policy_id: publication.policy_id,
        version: publication.version,
        policy_sha256: publication.policy_sha256,
        identity_manifest_id: publication.identity_manifest_id,
        signer_installation_id: publication.signer_installation_id,
        signer_key_id: publication.signer_key_id,
      },
      EVENT_TIME,
    ).policy;
    const invalidActorEvents = await signedEventGroup(
      actorFixture.signer,
      actorFixture.rootManifest,
      policy,
      sha256Digest(canonicalJson(actorFixture.rootManifest)),
      {
        slack_claim_id: 'clm_00000000-0000-4000-8000-000000000099',
      },
    );
    const invalidActorOutbox = new FixtureOutbox({
      head: {
        installation_id: INSTALLATION_ID,
        last_sequence: invalidActorEvents.length,
        last_event_hash: invalidActorEvents.at(-1)!.event_hash,
        updated_at: EVENT_TIME,
      },
      events: invalidActorEvents,
    });
    await expect(
      createFederatedExportBundle({
        ...actorFixture.request,
        outbox: invalidActorOutbox,
      }),
    ).rejects.toThrow('invalid Slack approval actor claim');

    const policyFixture = await fixture();
    const policyForAudienceTest = await signedPolicy(
      policyFixture.signer,
      ROOT_MANIFEST_ID,
    );
    const invalidPolicy = await createSignedDocument(
      {
        ...signedPayload(policyForAudienceTest),
        publication: {
          ...policyForAudienceTest.publication,
          audience: {
            scope: 'named-subjects',
            subjects: [
              {
                kind: 'membership',
                id: 'mem_00000000-0000-4000-8000-000000000099',
              },
            ],
          },
        },
      } as unknown as Omit<PublicationPolicyV1, 'integrity'>,
      policyFixture.signer,
      INSTALLATION_ID,
      policyFixture.signer.descriptor.key_id,
    );
    const invalidPolicyCanonical = canonicalJson(invalidPolicy);
    const rootMaterial =
      policyFixture.identitySource.loadVerifiedManifest(ROOT_MANIFEST_ID);
    const currentMaterial =
      policyFixture.identitySource.loadVerifiedManifest(CURRENT_MANIFEST_ID);
    const invalidPolicySource = new FixtureIdentitySource(
      new Map([
        [ROOT_MANIFEST_ID, rootMaterial],
        [CURRENT_MANIFEST_ID, currentMaterial],
      ]),
      new Map([
        [
          `${POLICY_ID}:v1`,
          {
            policy: invalidPolicy,
            manifest: policyFixture.rootManifest,
            canonical: invalidPolicyCanonical,
            sha256: sha256Digest(invalidPolicyCanonical),
          },
        ],
      ]),
    );
    const invalidPolicyEvents = await signedEventGroup(
      policyFixture.signer,
      policyFixture.rootManifest,
      invalidPolicy,
      rootMaterial.sha256,
    );
    const invalidPolicyOutbox = new FixtureOutbox({
      head: {
        installation_id: INSTALLATION_ID,
        last_sequence: invalidPolicyEvents.length,
        last_event_hash: invalidPolicyEvents.at(-1)!.event_hash,
        updated_at: EVENT_TIME,
      },
      events: invalidPolicyEvents,
    });
    await expect(
      createFederatedExportBundle({
        ...policyFixture.request,
        output_root: outputRoot(),
        export_id: 'exp_00000000-0000-4000-8000-000000000003',
        outbox: invalidPolicyOutbox,
        identity_source: invalidPolicySource,
      }),
    ).rejects.toThrow('unknown local audience subject');
  });

  it('rejects publication audiences with swapped identity kinds and IDs', async () => {
    const value = await fixture();
    const basePolicy = await signedPolicy(value.signer, ROOT_MANIFEST_ID);
    const rootMaterial =
      value.identitySource.loadVerifiedManifest(ROOT_MANIFEST_ID);
    const currentMaterial =
      value.identitySource.loadVerifiedManifest(CURRENT_MANIFEST_ID);
    const swappedSubjects = [
      { kind: 'organization', id: MEMBERSHIP_ID },
      { kind: 'membership', id: ORG_ID },
    ] as const;

    for (const subject of swappedSubjects) {
      const policy = await createSignedDocument(
        {
          ...signedPayload(basePolicy),
          publication: {
            ...basePolicy.publication,
            audience: {
              scope: 'named-subjects',
              subjects: [subject],
            },
          },
        } as unknown as Omit<PublicationPolicyV1, 'integrity'>,
        value.signer,
        INSTALLATION_ID,
        value.signer.descriptor.key_id,
      );
      const canonicalPolicy = canonicalJson(policy);
      const identitySource = new FixtureIdentitySource(
        new Map([
          [ROOT_MANIFEST_ID, rootMaterial],
          [CURRENT_MANIFEST_ID, currentMaterial],
        ]),
        new Map([
          [
            `${POLICY_ID}:v1`,
            {
              policy,
              manifest: value.rootManifest,
              canonical: canonicalPolicy,
              sha256: sha256Digest(canonicalPolicy),
            },
          ],
        ]),
      );
      const events = await signedEventGroup(
        value.signer,
        value.rootManifest,
        policy,
        rootMaterial.sha256,
      );
      await expect(
        createFederatedExportBundle({
          ...value.request,
          output_root: outputRoot(),
          identity_source: identitySource,
          outbox: new FixtureOutbox({
            head: {
              installation_id: INSTALLATION_ID,
              last_sequence: events.length,
              last_event_hash: events.at(-1)!.event_hash,
              updated_at: EVENT_TIME,
            },
            events,
          }),
        }),
      ).rejects.toThrow(
        /unknown local audience subject|invalid publication-policy document/,
      );
    }
  });

  it('detects an event mutation even when the records digest, head, and export signature are recomputed', async () => {
    const value = await fixture();
    const created = await createFederatedExportBundle(value.request);
    const recordsPath = join(created.path, 'records.v1.jsonl');
    const lines = readFileSync(recordsPath, 'utf8').trimEnd().split('\n');
    const last = JSON.parse(lines[1]!) as FederatedEventV1;
    const mutated = {
      ...last,
      approval: { ...last.approval, reason: 'mutated after approval' },
    };
    lines[1] = canonicalJson(mutated);
    const records = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
    writeFileSync(recordsPath, records, { mode: 0o600 });
    chmodSync(recordsPath, 0o600);
    await rewriteManifest(created.path, value.signer, (payload) => ({
      ...payload,
      sequence: {
        ...payload.sequence,
        head_hash: sha256Digest(lines[1]!),
      },
      records: {
        ...payload.records,
        sha256: sha256Digest(records),
      },
    }));

    expect(() => verifyFederatedExportBundle(created.path)).toThrow(
      /payload digest|signature is invalid/,
    );
  });

  it('rejects missing predecessor closure and unrelated identity manifests', async () => {
    const missing = await fixture();
    const missingBundle = await createFederatedExportBundle(missing.request);
    const rootPath = `identity-manifests/identity-manifest.${ROOT_MANIFEST_ID}.v1.json`;
    unlinkSync(join(missingBundle.path, rootPath));
    await rewriteManifest(missingBundle.path, missing.signer, (payload) => ({
      ...payload,
      artifacts: payload.artifacts.filter(
        (artifact) => artifact.path !== rootPath,
      ),
    }));
    expect(() => verifyFederatedExportBundle(missingBundle.path)).toThrow(
      'identity_manifest_sha256 does not resolve',
    );

    const unrelated = await fixture();
    const unrelatedBundle = await createFederatedExportBundle(
      unrelated.request,
    );
    const extra = await createSignedDocument(
      manifestPayload(
        unrelated.signer,
        EXTRA_MANIFEST_ID,
        CURRENT_MANIFEST_ID,
        '2026-07-19T20:20:00.000Z',
      ),
      unrelated.signer,
      INSTALLATION_ID,
      unrelated.signer.descriptor.key_id,
    );
    const extraCanonical = canonicalJson(extra);
    const extraPath = `identity-manifests/identity-manifest.${EXTRA_MANIFEST_ID}.v1.json`;
    writeFileSync(join(unrelatedBundle.path, extraPath), extraCanonical, {
      mode: 0o600,
    });
    chmodSync(join(unrelatedBundle.path, extraPath), 0o600);
    await rewriteManifest(
      unrelatedBundle.path,
      unrelated.signer,
      (payload) => ({
        ...payload,
        artifacts: [
          ...payload.artifacts,
          {
            path: extraPath,
            kind: 'echo-local-identity-manifest',
            sha256: sha256Digest(extraCanonical),
          },
        ].sort((left, right) =>
          Buffer.from(left.path).compare(Buffer.from(right.path)),
        ),
      }),
    );
    expect(() => verifyFederatedExportBundle(unrelatedBundle.path)).toThrow(
      /verification closure is not minimal|not the unique newest lineage leaf/,
    );
  });

  it('rejects unlisted physical manifests and duplicate manifest artifact paths', async () => {
    const unlisted = await fixture();
    const unlistedBundle = await createFederatedExportBundle(unlisted.request);
    const extra = await createSignedDocument(
      manifestPayload(
        unlisted.signer,
        EXTRA_MANIFEST_ID,
        CURRENT_MANIFEST_ID,
        '2026-07-19T20:20:00.000Z',
      ),
      unlisted.signer,
      INSTALLATION_ID,
      unlisted.signer.descriptor.key_id,
    );
    writeFileSync(
      join(
        unlistedBundle.path,
        `identity-manifests/identity-manifest.${EXTRA_MANIFEST_ID}.v1.json`,
      ),
      canonicalJson(extra),
      { mode: 0o600 },
    );
    expect(() => verifyFederatedExportBundle(unlistedBundle.path)).toThrow(
      'contains missing or unexpected entries',
    );

    const duplicate = await fixture();
    const duplicateBundle = await createFederatedExportBundle(
      duplicate.request,
    );
    await rewriteManifest(
      duplicateBundle.path,
      duplicate.signer,
      (payload) => ({
        ...payload,
        artifacts: [payload.artifacts[0]!, ...payload.artifacts],
      }),
    );
    expect(() => verifyFederatedExportBundle(duplicateBundle.path)).toThrow(
      'artifact path',
    );
  });

  it('rejects a signed manifest whose artifact inventory is not bytewise ordered', async () => {
    const value = await fixture();
    const created = await createFederatedExportBundle(value.request);
    await rewriteManifest(created.path, value.signer, (payload) => ({
      ...payload,
      artifacts: [...payload.artifacts].reverse(),
    }));
    expect(() => verifyFederatedExportBundle(created.path)).toThrow(
      'deterministic bytewise path order',
    );
  });
});
