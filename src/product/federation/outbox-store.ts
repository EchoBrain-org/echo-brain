import { createPublicKey } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openProductDatabase } from '../storage/open-product-database.js';
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
  sha256Digest,
} from './foundation/canonical-json.js';
import { analyzeApprovalGroup } from './records/approval-group-invariants.js';
import type {
  FederatedEventV1,
  FederationId,
  Sha256Digest,
} from './contracts.js';
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
} from './foundation/identifiers.js';
import type { InstallationSigner } from './foundation/installation-signer.js';
import { verifyInstallationKeyDescriptor } from './foundation/installation-signer.js';
import {
  assertFederationDocumentSize,
  validateFederationDocument,
} from './schema-validation.js';
import {
  createSignedDocument,
  signedPayload,
  verifySignedDocument,
} from './foundation/signed-document.js';
import { p256KeyId } from './foundation/signature-profile.js';

const EVENT_TYPE = 'approved-org-record' as const;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type FederatedEventDraftV1 = Omit<
  FederatedEventV1,
  'sequence' | 'previous_event_hash' | 'integrity'
>;

export interface FederatedOutboxEventDraft {
  local_subject_key: string;
  envelope: FederatedEventDraftV1;
}

export interface AppendFederatedApprovalGroupRequest {
  installation_id: FederationId;
  key_id: Sha256Digest;
  created_at: string;
  signer: InstallationSigner;
  historical_verification_key_resolver?: FederatedChainVerificationKeyResolver;
  events: readonly FederatedOutboxEventDraft[];
}

interface AppendFederatedApprovalGroupSnapshot {
  installation_id: FederationId;
  key_id: Sha256Digest;
  created_at: string;
  signer: InstallationSigner;
  historical_verification_key_resolver?: FederatedChainVerificationKeyResolver;
  events: readonly FederatedOutboxEventDraft[];
}

export interface StoredFederatedOutboxEvent {
  event_id: FederationId;
  installation_id: FederationId;
  sequence: number;
  event_type: typeof EVENT_TYPE;
  local_subject_key: string;
  previous_event_hash: Sha256Digest | null;
  event_hash: Sha256Digest;
  /** Exact RFC 8785 text stored in SQLite. Export must not reserialize it. */
  envelope_json: string;
  /** Exact UTF-8 bytes derived from the stored canonical SQLite text. */
  envelope_bytes: Buffer;
  envelope: FederatedEventV1;
  created_at: string;
}

export interface FederatedChainHead {
  installation_id: FederationId;
  last_sequence: number;
  last_event_hash: Sha256Digest | null;
  updated_at: string;
}

export interface VerifiedFederatedChain {
  head: FederatedChainHead | null;
  events: readonly StoredFederatedOutboxEvent[];
}

export interface FederatedChainVerificationKey {
  key_id: Sha256Digest;
  public_key_spki_der: Buffer;
}

export type FederatedChainVerificationKeyResolver = (
  event: StoredFederatedOutboxEvent,
) => FederatedChainVerificationKey;

export type FederatedChainVerificationKeySource =
  FederatedChainVerificationKey | FederatedChainVerificationKeyResolver;

interface OutboxRow {
  event_id: string;
  installation_id: string;
  sequence: number;
  event_type: string;
  local_subject_key: string;
  previous_event_hash: string | null;
  event_hash: string;
  envelope_json: string;
  created_at: string;
}

interface ChainHeadRow {
  installation_id: string;
  last_sequence: number;
  last_event_hash: string | null;
  updated_at: string;
}

/**
 * Detach every caller-owned JSON value before append crosses an async boundary.
 * The signer is a trusted capability rather than JSON data, so only its object
 * reference is retained; every value that can affect stored bytes is rebuilt
 * from its canonical representation.
 */
function snapshotAppendRequest(
  request: AppendFederatedApprovalGroupRequest,
): AppendFederatedApprovalGroupSnapshot {
  const jsonSnapshot = parseCanonicalJson(
    canonicalJson({
      installation_id: request.installation_id,
      key_id: request.key_id,
      created_at: request.created_at,
      events: request.events,
    }),
  ) as unknown as Omit<
    AppendFederatedApprovalGroupSnapshot,
    'signer' | 'historical_verification_key_resolver'
  >;
  return {
    ...jsonSnapshot,
    signer: request.signer,
    historical_verification_key_resolver:
      request.historical_verification_key_resolver,
  };
}

function assertDigest(
  value: string,
  label: string,
): asserts value is Sha256Digest {
  if (!SHA256_DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical SHA-256 digest`);
  }
}

function assertVerificationPublicKey(
  publicKeySpkiDer: Buffer,
  expectedKeyId: Sha256Digest,
): void {
  if (p256KeyId(publicKeySpkiDer) !== expectedKeyId) {
    throw new Error(
      'federated chain verification key fingerprint does not match',
    );
  }
  const key = createPublicKey({
    key: publicKeySpkiDer,
    format: 'der',
    type: 'spki',
  });
  if (
    key.asymmetricKeyType !== 'ec' ||
    key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new Error('federated chain verification key must be P-256');
  }
  const canonical = key.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(canonical) || !canonical.equals(publicKeySpkiDer)) {
    throw new Error(
      'federated chain verification key must use canonical SPKI DER bytes',
    );
  }
}

function verifyEventWithKeySource(
  event: StoredFederatedOutboxEvent,
  source: FederatedChainVerificationKeySource,
): void {
  const verificationKey = typeof source === 'function' ? source(event) : source;
  assertDigest(verificationKey.key_id, 'federated chain verification key');
  assertVerificationPublicKey(
    verificationKey.public_key_spki_der,
    verificationKey.key_id,
  );
  if (
    event.envelope.integrity.key_id !== verificationKey.key_id ||
    event.envelope.producer.key_id !== verificationKey.key_id
  ) {
    throw new Error(
      'federated installation chain event uses an unexpected signing key',
    );
  }
  verifySignedDocument(
    event.envelope,
    verificationKey.public_key_spki_der,
    verificationKey.key_id,
  );
}

function expectedLocalSubjectKey(
  event: FederatedEventV1 | FederatedEventDraftV1,
): string {
  return `${EVENT_TYPE}:${event.local_reference.approval_id}:${event.local_reference.signal_id}`;
}

function retryComparableEnvelope(
  event: FederatedEventV1 | FederatedEventDraftV1,
): string {
  return canonicalJson({
    schema_version: event.schema_version,
    kind: event.kind,
    event_type: event.event_type,
    event_id: event.event_id,
    organization_id: event.organization_id,
    occurred_at: event.occurred_at,
    producer: event.producer,
    source: event.source,
    processor: event.processor,
    local_reference: event.local_reference,
    record: event.record,
    approval: event.approval,
    publication: event.publication,
    classification: event.classification,
    identity_manifest_sha256: event.identity_manifest_sha256,
  });
}

function exactPersistedRetry(
  events: readonly StoredFederatedOutboxEvent[],
  requested: readonly FederatedOutboxEventDraft[],
): readonly StoredFederatedOutboxEvent[] | undefined {
  const requestedSubjects = new Set(
    requested.map((item) => item.local_subject_key),
  );
  const matching = events.filter((event) =>
    requestedSubjects.has(event.local_subject_key),
  );
  if (matching.length > 0) {
    if (matching.length !== requested.length) {
      throw new Error('federated approval group is only partially present');
    }
    const approvalId = requested[0]!.envelope.local_reference.approval_id;
    const persistedGroup = events.filter(
      (event) => event.envelope.local_reference.approval_id === approvalId,
    );
    assertCompleteFederatedApprovalGroup(persistedGroup);
    const persistedSubjects = new Set(
      persistedGroup.map((event) => event.local_subject_key),
    );
    if (
      persistedSubjects.size !== requestedSubjects.size ||
      [...requestedSubjects].some((subject) => !persistedSubjects.has(subject))
    ) {
      throw new Error(
        'persisted federated approval group differs from the retry',
      );
    }
    const bySubject = new Map(
      persistedGroup.map((event) => [event.local_subject_key, event]),
    );
    return requested.map((item) => {
      const persisted = bySubject.get(item.local_subject_key)!;
      if (
        retryComparableEnvelope(persisted.envelope) !==
        retryComparableEnvelope(item.envelope)
      ) {
        throw new Error(
          'persisted federated approval group content differs from the retry',
        );
      }
      return persisted;
    });
  }

  const approvalId = requested[0]!.envelope.local_reference.approval_id;
  if (
    events.some(
      (event) => event.envelope.local_reference.approval_id === approvalId,
    )
  ) {
    throw new Error(
      'persisted federated approval group differs from the retry',
    );
  }
  return undefined;
}

export function assertCompleteFederatedApprovalGroup(
  events: readonly {
    local_subject_key: string;
    envelope: FederatedEventV1 | FederatedEventDraftV1;
  }[],
): void {
  if (events.length === 0) {
    throw new Error('federated approval group must contain at least one event');
  }
  const analysis = analyzeApprovalGroup(
    events.map((item) => item.envelope),
  );
  const seenSubjects = new Set<string>();
  const seenEventIds = new Set<string>();
  const seenRecordIds = new Set<string>();
  const firstSignal = analysis.items[0]!.signal;

  if (firstSignal.has_duplicate_signal_ids) {
    throw new Error(
      'federated approval group signal manifest contains duplicates',
    );
  }
  if (!analysis.event_count_matches_manifest) {
    throw new Error(
      'federated approval group must contain its complete signal manifest',
    );
  }
  if (firstSignal.first_ordering_violation !== null) {
    throw new Error(
      'federated approval group signal manifest is not canonically positioned',
    );
  }

  for (let index = 0; index < events.length; index += 1) {
    const item = events[index]!;
    const invariant = analysis.items[index]!;
    const event = item.envelope;
    if (event.event_type !== EVENT_TYPE) {
      throw new Error(
        'federated outbox supports approved organization records only',
      );
    }
    if (!invariant.approval_id_matches) {
      throw new Error(
        'federated outbox transaction may contain only one approval group',
      );
    }
    if (!invariant.approval_group_matches) {
      throw new Error(
        'federated approval group sibling manifests must be identical',
      );
    }
    if (!invariant.shared_facts_match) {
      throw new Error(
        'federated approval group siblings must preserve the same shared facts',
      );
    }
    if (!invariant.signal_identity_consistent) {
      throw new Error('federated record signal identities are inconsistent');
    }
    if (!invariant.signal_expected || invariant.signal_repeated) {
      throw new Error(
        'federated approval group signals must match its manifest exactly',
      );
    }

    if (!invariant.signal.own_entry_digest_matches) {
      throw new Error(
        'federated approval group signal digest does not match its record',
      );
    }
    if (!invariant.references_consistent) {
      throw new Error(
        'federated approval group brief or meeting references are inconsistent',
      );
    }

    const expectedSubject = expectedLocalSubjectKey(event);
    if (item.local_subject_key !== expectedSubject) {
      throw new Error(
        'federated outbox local subject key is inconsistent with its event',
      );
    }
    if (seenSubjects.has(item.local_subject_key)) {
      throw new Error(
        'federated approval group local subject keys must be unique',
      );
    }
    seenSubjects.add(item.local_subject_key);

    if (
      seenEventIds.has(event.event_id) ||
      seenRecordIds.has(event.record.record_id)
    ) {
      throw new Error(
        'federated approval group event and record IDs must be unique',
      );
    }
    seenEventIds.add(event.event_id);
    seenRecordIds.add(event.record.record_id);

    if (!invariant.signal.own_entry_kind_matches) {
      throw new Error(
        'federated approval group must identify each record exactly once',
      );
    }
    if (!invariant.order_is_canonical) {
      throw new Error(
        'federated approval group must use canonical kind and position order',
      );
    }
  }
}

function parseStoredEvent(row: OutboxRow): StoredFederatedOutboxEvent {
  if (!Number.isSafeInteger(row.sequence) || row.sequence < 1) {
    throw new Error('federated outbox sequence is invalid');
  }
  if (row.event_type !== EVENT_TYPE) {
    throw new Error('federated outbox event type is unsupported');
  }
  assertDigest(row.event_hash, 'federated outbox event hash');
  if (row.previous_event_hash !== null) {
    assertDigest(
      row.previous_event_hash,
      'federated outbox previous event hash',
    );
  }
  assertUtcMillisecondTimestamp(
    row.created_at,
    'federated outbox creation time',
  );
  assertFederationDocumentSize(row.envelope_json, 'federated outbox envelope');

  const parsed = parseCanonicalJson(row.envelope_json);
  const envelope = validateFederationDocument<FederatedEventV1>(
    'federated-record-envelope',
    parsed,
  );
  if (
    envelope.event_id !== row.event_id ||
    envelope.producer.installation_id !== row.installation_id ||
    envelope.sequence !== row.sequence ||
    envelope.event_type !== row.event_type ||
    envelope.previous_event_hash !== row.previous_event_hash ||
    expectedLocalSubjectKey(envelope) !== row.local_subject_key
  ) {
    throw new Error(
      'federated outbox row does not match its canonical envelope',
    );
  }
  if (envelope.integrity.key_id !== envelope.producer.key_id) {
    throw new Error(
      'federated outbox envelope signer identity is inconsistent',
    );
  }
  if (
    canonicalSha256(signedPayload(envelope)) !==
    envelope.integrity.payload_sha256
  ) {
    throw new Error('federated outbox envelope payload digest does not match');
  }
  if (sha256Digest(row.envelope_json) !== row.event_hash) {
    throw new Error(
      'federated outbox event hash does not match its exact stored bytes',
    );
  }

  return {
    ...row,
    event_type: EVENT_TYPE,
    previous_event_hash: row.previous_event_hash,
    event_hash: row.event_hash,
    envelope_bytes: Buffer.from(row.envelope_json, 'utf8'),
    envelope,
  };
}

function parseChainHead(row: ChainHeadRow): FederatedChainHead {
  if (!Number.isSafeInteger(row.last_sequence) || row.last_sequence < 0) {
    throw new Error('federated chain head sequence is invalid');
  }
  if (row.last_event_hash !== null) {
    assertDigest(row.last_event_hash, 'federated chain head event hash');
  }
  if ((row.last_sequence === 0) !== (row.last_event_hash === null)) {
    throw new Error('federated chain head empty state is inconsistent');
  }
  assertUtcMillisecondTimestamp(
    row.updated_at,
    'federated chain head update time',
  );
  return {
    installation_id: row.installation_id,
    last_sequence: row.last_sequence,
    last_event_hash: row.last_event_hash,
    updated_at: row.updated_at,
  };
}

function verifyChainShape(
  installationId: string,
  rows: readonly OutboxRow[],
  headRow: ChainHeadRow | undefined,
): VerifiedFederatedChain {
  const events = rows.map(parseStoredEvent);
  const head = headRow === undefined ? null : parseChainHead(headRow);

  if (head !== null && head.installation_id !== installationId) {
    throw new Error('federated chain head belongs to a different installation');
  }
  if (events.length === 0) {
    if (head !== null && head.last_sequence !== 0) {
      throw new Error('federated chain head exists without its events');
    }
    return { head, events };
  }
  if (head === null) {
    throw new Error('federated outbox events are missing their chain head');
  }

  let previousHash: Sha256Digest | null = null;
  const firstEvent = events[0]!;
  const recordIds = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const expectedSequence = index + 1;
    if (event.installation_id !== installationId) {
      throw new Error(
        'federated outbox event belongs to a different installation',
      );
    }
    if (
      event.envelope.organization_id !== firstEvent.envelope.organization_id ||
      event.envelope.producer.principal_id !==
        firstEvent.envelope.producer.principal_id ||
      event.envelope.producer.membership_id !==
        firstEvent.envelope.producer.membership_id
    ) {
      throw new Error(
        'federated installation chain producer identity is inconsistent',
      );
    }
    if (recordIds.has(event.envelope.record.record_id)) {
      throw new Error('federated installation chain record IDs must be unique');
    }
    recordIds.add(event.envelope.record.record_id);
    if (
      event.sequence !== expectedSequence ||
      event.envelope.sequence !== expectedSequence
    ) {
      throw new Error('federated outbox sequence is not contiguous');
    }
    if (
      event.previous_event_hash !== previousHash ||
      event.envelope.previous_event_hash !== previousHash
    ) {
      throw new Error('federated outbox previous-event hash chain is broken');
    }
    previousHash = event.event_hash;
  }
  if (
    head.last_sequence !== events.length ||
    head.last_event_hash !== previousHash ||
    head.updated_at !== events.at(-1)!.created_at
  ) {
    throw new Error('federated chain head does not match its events');
  }

  const approvalGroups = new Map<string, StoredFederatedOutboxEvent[]>();
  const completedApprovalGroups = new Set<string>();
  let currentApprovalId: string | undefined;
  for (const event of events) {
    const approvalId = event.envelope.local_reference.approval_id;
    if (currentApprovalId !== approvalId) {
      if (currentApprovalId !== undefined) {
        completedApprovalGroups.add(currentApprovalId);
      }
      if (completedApprovalGroups.has(approvalId)) {
        throw new Error(
          'federated approval group sequences must be contiguous',
        );
      }
      currentApprovalId = approvalId;
    }
    const group = approvalGroups.get(approvalId) ?? [];
    group.push(event);
    approvalGroups.set(approvalId, group);
  }
  for (const group of approvalGroups.values()) {
    assertCompleteFederatedApprovalGroup(group);
    if (new Set(group.map((event) => event.created_at)).size !== 1) {
      throw new Error(
        'federated approval group siblings must share one creation time',
      );
    }
  }
  return { head, events };
}

/**
 * Append-only signed organization-record storage.
 *
 * One call is one approval-group transaction. The transaction holds a SQLite
 * IMMEDIATE write lock while it allocates the contiguous sequences, signs each
 * envelope, inserts every sibling, and advances the installation chain head.
 */
export class FederatedOutboxStore {
  private readonly database: Database.Database;
  private operationTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(databasePath: string) {
    this.database = openProductDatabase(databasePath, {
      durability: 'evidence',
    });
  }

  private runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.operationTail.then(async () => {
      if (this.closed) throw new Error('federated outbox store is closed');
      return operation();
    });
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private rowsForInstallation(installationId: string): OutboxRow[] {
    return this.database
      .prepare(
        `SELECT event_id, installation_id, sequence, event_type,
                local_subject_key, previous_event_hash, event_hash,
                envelope_json, created_at
         FROM federated_outbox_events
         WHERE installation_id = ?
         ORDER BY sequence ASC`,
      )
      .all(installationId) as OutboxRow[];
  }

  private headForInstallation(
    installationId: string,
  ): ChainHeadRow | undefined {
    return this.database
      .prepare(
        `SELECT installation_id, last_sequence, last_event_hash, updated_at
         FROM federated_chain_heads
         WHERE installation_id = ?`,
      )
      .get(installationId) as ChainHeadRow | undefined;
  }

  private verifiedChainShapeFromCurrentSnapshot(
    installationId: string,
  ): VerifiedFederatedChain {
    return verifyChainShape(
      installationId,
      this.rowsForInstallation(installationId),
      this.headForInstallation(installationId),
    );
  }

  /**
   * Read events and their head from one SQLite snapshot. runExclusive only
   * coordinates this store instance; the read transaction also protects
   * against another process committing between the two SELECTs.
   */
  private verifiedChainShape(installationId: string): VerifiedFederatedChain {
    if (this.database.inTransaction) {
      return this.verifiedChainShapeFromCurrentSnapshot(installationId);
    }
    this.database.exec('BEGIN');
    try {
      const chain = this.verifiedChainShapeFromCurrentSnapshot(installationId);
      this.database.exec('COMMIT');
      return chain;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the read/verification failure if SQLite already rolled back.
      }
      throw error;
    }
  }

  async appendApprovalGroup(
    request: AppendFederatedApprovalGroupRequest,
  ): Promise<readonly StoredFederatedOutboxEvent[]> {
    const snapshot = snapshotAppendRequest(request);
    assertFederationId(
      snapshot.installation_id,
      'ins',
      'federated outbox installation',
    );
    assertUtcMillisecondTimestamp(
      snapshot.created_at,
      'federated outbox creation time',
    );
    assertDigest(snapshot.key_id, 'federated outbox signing key');
    assertCompleteFederatedApprovalGroup(snapshot.events);

    for (const item of snapshot.events) {
      assertUtcMillisecondTimestamp(
        item.envelope.occurred_at,
        'federated outbox event occurrence time',
      );
      if (snapshot.created_at < item.envelope.occurred_at) {
        throw new Error(
          'federated outbox creation time cannot precede event occurrence time',
        );
      }
      if (
        item.envelope.producer.installation_id !== snapshot.installation_id ||
        item.envelope.producer.key_id !== snapshot.key_id
      ) {
        throw new Error(
          'federated approval group does not match its requested signer',
        );
      }
    }

    return this.runExclusive(async () => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const chain = this.verifiedChainShape(snapshot.installation_id);
        const historicalResolver =
          snapshot.historical_verification_key_resolver;
        if (historicalResolver !== undefined) {
          for (const event of chain.events) {
            verifyEventWithKeySource(event, historicalResolver);
          }
          const persisted = exactPersistedRetry(chain.events, snapshot.events);
          if (persisted !== undefined) {
            this.database.exec('COMMIT');
            return persisted;
          }
        }

        const descriptor = await snapshot.signer.inspect(
          snapshot.installation_id,
        );
        if (descriptor === null) {
          throw new Error('installation signing key is unavailable');
        }
        if (descriptor.installation_id !== snapshot.installation_id) {
          throw new Error(
            'installation signing key descriptor belongs to a different installation',
          );
        }
        const publicKey = verifyInstallationKeyDescriptor(descriptor);
        if (descriptor.key_id !== snapshot.key_id) {
          throw new Error(
            'installation signing key does not match the approval group',
          );
        }

        if (historicalResolver === undefined) {
          for (const event of chain.events) {
            verifyEventWithKeySource(event, {
              key_id: snapshot.key_id,
              public_key_spki_der: publicKey,
            });
          }
          const persisted = exactPersistedRetry(chain.events, snapshot.events);
          if (persisted !== undefined) {
            this.database.exec('COMMIT');
            return persisted;
          }
        }

        const existingRecordIds = new Set(
          chain.events.map((event) => event.envelope.record.record_id),
        );
        if (
          snapshot.events.some((event) =>
            existingRecordIds.has(event.envelope.record.record_id),
          )
        ) {
          throw new Error(
            'federated installation chain record IDs must be unique',
          );
        }
        const existingProducer = chain.events[0]?.envelope;
        const requestedProducer = snapshot.events[0]!.envelope;
        if (
          existingProducer !== undefined &&
          (requestedProducer.organization_id !==
            existingProducer.organization_id ||
            requestedProducer.producer.principal_id !==
              existingProducer.producer.principal_id ||
            requestedProducer.producer.membership_id !==
              existingProducer.producer.membership_id)
        ) {
          throw new Error(
            'federated installation chain producer identity is inconsistent',
          );
        }

        let sequence = chain.head?.last_sequence ?? 0;
        let previousEventHash = chain.head?.last_event_hash ?? null;
        const inserted: StoredFederatedOutboxEvent[] = [];
        const insert = this.database.prepare(
          `INSERT INTO federated_outbox_events (
             event_id, installation_id, sequence, event_type,
             local_subject_key, previous_event_hash, event_hash,
             envelope_json, created_at
           ) VALUES (
             @event_id, @installation_id, @sequence, @event_type,
             @local_subject_key, @previous_event_hash, @event_hash,
             @envelope_json, @created_at
           )`,
        );

        for (const draft of snapshot.events) {
          sequence += 1;
          const envelope = await createSignedDocument(
            {
              ...draft.envelope,
              sequence,
              previous_event_hash: previousEventHash,
            },
            snapshot.signer,
            snapshot.installation_id,
            snapshot.key_id,
          );
          validateFederationDocument<FederatedEventV1>(
            'federated-record-envelope',
            envelope,
          );
          verifySignedDocument(envelope, publicKey, snapshot.key_id);
          const envelopeJson = canonicalJson(envelope);
          assertFederationDocumentSize(
            envelopeJson,
            'federated outbox envelope',
          );
          const eventHash = sha256Digest(envelopeJson);
          insert.run({
            event_id: envelope.event_id,
            installation_id: snapshot.installation_id,
            sequence,
            event_type: EVENT_TYPE,
            local_subject_key: draft.local_subject_key,
            previous_event_hash: previousEventHash,
            event_hash: eventHash,
            envelope_json: envelopeJson,
            created_at: snapshot.created_at,
          });
          inserted.push(
            parseStoredEvent({
              event_id: envelope.event_id,
              installation_id: snapshot.installation_id,
              sequence,
              event_type: EVENT_TYPE,
              local_subject_key: draft.local_subject_key,
              previous_event_hash: previousEventHash,
              event_hash: eventHash,
              envelope_json: envelopeJson,
              created_at: snapshot.created_at,
            }),
          );
          previousEventHash = eventHash;
        }

        this.database
          .prepare(
            `INSERT INTO federated_chain_heads (
               installation_id, last_sequence, last_event_hash, updated_at
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT (installation_id) DO UPDATE SET
               last_sequence = excluded.last_sequence,
               last_event_hash = excluded.last_event_hash,
               updated_at = excluded.updated_at`,
          )
          .run(
            snapshot.installation_id,
            sequence,
            previousEventHash,
            snapshot.created_at,
          );

        this.database.exec('COMMIT');
        return inserted;
      } catch (error) {
        try {
          this.database.exec('ROLLBACK');
        } catch {
          // Preserve the transaction/signing failure if SQLite already rolled back.
        }
        throw error;
      }
    });
  }

  async readInstallationEvents(
    installationId: FederationId,
  ): Promise<readonly StoredFederatedOutboxEvent[]> {
    assertFederationId(installationId, 'ins', 'federated outbox installation');
    return this.runExclusive(
      () => this.verifiedChainShape(installationId).events,
    );
  }

  async readSequenceRange(
    installationId: FederationId,
    firstSequence: number,
    lastSequence: number,
  ): Promise<readonly StoredFederatedOutboxEvent[]> {
    assertFederationId(installationId, 'ins', 'federated outbox installation');
    if (
      !Number.isSafeInteger(firstSequence) ||
      !Number.isSafeInteger(lastSequence) ||
      firstSequence < 1 ||
      lastSequence < firstSequence
    ) {
      throw new Error('federated outbox sequence range is invalid');
    }
    return this.runExclusive(() => {
      const chain = this.verifiedChainShape(installationId);
      return chain.events.filter(
        (event) =>
          event.sequence >= firstSequence && event.sequence <= lastSequence,
      );
    });
  }

  async readByLocalSubject(
    installationId: FederationId,
    localSubjectKey: string,
  ): Promise<StoredFederatedOutboxEvent | undefined> {
    assertFederationId(installationId, 'ins', 'federated outbox installation');
    return this.runExclusive(() =>
      this.verifiedChainShape(installationId).events.find(
        (event) => event.local_subject_key === localSubjectKey,
      ),
    );
  }

  async readChainHead(
    installationId: FederationId,
  ): Promise<FederatedChainHead | null> {
    assertFederationId(installationId, 'ins', 'federated outbox installation');
    return this.runExclusive(
      () => this.verifiedChainShape(installationId).head,
    );
  }

  async listInstallationIds(): Promise<readonly FederationId[]> {
    return this.runExclusive(() => {
      const rows = this.database
        .prepare(
          `SELECT installation_id FROM federated_chain_heads
           UNION
           SELECT installation_id FROM federated_outbox_events`,
        )
        .all() as { installation_id: string }[];
      const ids = rows.map(({ installation_id }) => {
        assertFederationId(
          installation_id,
          'ins',
          'federated outbox installation',
        );
        return installation_id;
      });
      return ids.sort((left, right) =>
        Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')),
      );
    });
  }

  async verifyInstallationChain(
    installationId: FederationId,
    verificationKey: FederatedChainVerificationKeySource,
  ): Promise<VerifiedFederatedChain> {
    assertFederationId(installationId, 'ins', 'federated outbox installation');
    return this.runExclusive(() => {
      const chain = this.verifiedChainShape(installationId);
      for (const event of chain.events) {
        verifyEventWithKeySource(event, verificationKey);
      }
      return chain;
    });
  }

  async close(): Promise<void> {
    const close = this.operationTail.then(() => {
      if (!this.closed) {
        this.closed = true;
        this.database.close();
      }
    });
    this.operationTail = close;
    await close;
  }
}
