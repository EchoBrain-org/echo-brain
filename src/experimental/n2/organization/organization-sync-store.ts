import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
  sha256Digest,
} from "../../../product/federation/foundation/canonical-json.js";
import type {
  FederatedEventV1,
  Sha256Digest,
} from "../../../product/federation/contracts.js";
import type {
  OrganizationAuthorityDescriptorV1,
  OrganizationBatchReceiptV1,
  OrganizationEnrollmentReceiptV1,
  OrganizationIngestBatchV1,
} from "../contracts.js";
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
} from "../../../product/federation/foundation/identifiers.js";
import { verifySignedDocument } from "../../../product/federation/foundation/signed-document.js";
import {
  assertFederationDocumentSize,
  validateFederationDocument,
} from "../../../product/federation/schema-validation.js";
import { assertCompleteFederatedApprovalGroup } from "../../../product/federation/outbox-store.js";
import { verifyOrganizationAuthorityDescriptor } from "../authority/authority-signer.js";
import { validateN2Document } from "../schema-validation.js";

const ORGANIZATION_SYNC_SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "organization-sync-schema.sql"),
  "utf8",
);
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_ORGANIZATION_INGEST_EVENTS = 256;
const MAX_ORGANIZATION_INGEST_CANONICAL_BYTES = 16 * 1024 * 1024;

export type OrganizationSyncTerminalStatus = "active" | "revoked";

export interface OrganizationSyncState {
  authority_id: string;
  installation_id: string;
  enrollment_id: string;
  enrollment_receipt_sha256: Sha256Digest;
  acknowledged_sequence: number;
  acknowledged_event_hash: Sha256Digest | null;
  terminal_status: OrganizationSyncTerminalStatus;
}

export interface StoredOrganizationEnrollment {
  receipt: OrganizationEnrollmentReceiptV1;
  canonical: string;
  sha256: Sha256Digest;
}

export interface StoredOrganizationBatchReceipt {
  receipt: OrganizationBatchReceiptV1;
  canonical: string;
  sha256: Sha256Digest;
}

export interface StoreOrganizationBatchReceiptResult {
  state: OrganizationSyncState;
  stored: StoredOrganizationBatchReceipt;
}

interface AuthorityRow {
  authority_id: string;
  organization_id: string;
  authority_key_id: string;
  descriptor_sha256: string;
  descriptor_json: string;
}

interface EnrollmentRow {
  enrollment_id: string;
  authority_id: string;
  organization_id: string;
  membership_id: string;
  installation_id: string;
  enrollment_receipt_sha256: string;
  receipt_json: string;
}

interface StateRow {
  authority_id: string;
  installation_id: string;
  enrollment_id: string;
  enrollment_receipt_sha256: string;
  acknowledged_sequence: number;
  acknowledged_event_hash: string | null;
  terminal_status: string;
}

interface ReceiptRow {
  receipt_id: string;
  authority_id: string;
  installation_id: string;
  batch_sha256: string;
  status: string;
  receipt_sha256: string;
  receipt_json: string;
}

interface ParsedBatchEvent {
  canonical: string;
  sha256: Sha256Digest;
  envelope: FederatedEventV1;
}

export function assertOrganizationEventMatchesEnrollment(
  event: FederatedEventV1,
  enrollment: OrganizationEnrollmentReceiptV1,
): void {
  if (
    event.organization_id !== enrollment.organization_id ||
    event.identity_manifest_sha256 !== enrollment.identity_manifest_sha256 ||
    event.producer.principal_id !== enrollment.principal_id ||
    event.producer.membership_id !== enrollment.membership_id ||
    event.producer.installation_id !== enrollment.installation_id ||
    event.producer.key_id !== enrollment.installation_key_id ||
    event.source.identity_manifest_id !== enrollment.identity_manifest_id ||
    event.source.identity_manifest_sha256 !==
      enrollment.identity_manifest_sha256 ||
    event.processor.identity_manifest_id !== enrollment.identity_manifest_id ||
    event.processor.identity_manifest_sha256 !==
      enrollment.identity_manifest_sha256 ||
    event.publication.identity_manifest_id !==
      enrollment.identity_manifest_id ||
    event.publication.policy_id !== enrollment.publication_policy_id ||
    event.publication.version !== enrollment.publication_policy_version ||
    event.publication.policy_sha256 !== enrollment.publication_policy_sha256 ||
    event.publication.signer_installation_id !== enrollment.installation_id ||
    event.publication.signer_key_id !== enrollment.installation_key_id ||
    event.approval.approver.principal_id !== enrollment.principal_id ||
    event.approval.approver.membership_id !== enrollment.membership_id
  ) {
    throw new Error(
      "organization ingest event does not match its stored enrollment",
    );
  }
}

function assertDigest(
  value: string,
  label: string,
): asserts value is Sha256Digest {
  if (!SHA256_DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical SHA-256 digest`);
  }
}

function assertPositiveVersion(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has an unexpected shape`);
  }
}

function validateAuthorityDescriptor(
  input: OrganizationAuthorityDescriptorV1,
): {
  descriptor: OrganizationAuthorityDescriptorV1;
  canonical: string;
  sha256: Sha256Digest;
  publicKey: Buffer;
} {
  const canonical = canonicalJson(input);
  const descriptor = parseCanonicalJson(
    canonical,
  ) as unknown as OrganizationAuthorityDescriptorV1;
  const publicKey = verifyOrganizationAuthorityDescriptor(descriptor);
  return {
    descriptor,
    canonical,
    sha256: sha256Digest(canonical),
    publicKey,
  };
}

function parseBatch(batch: OrganizationIngestBatchV1): {
  batch: OrganizationIngestBatchV1;
  sha256: Sha256Digest;
  events: readonly ParsedBatchEvent[];
} {
  if (typeof batch !== "object" || batch === null || Array.isArray(batch)) {
    throw new Error("organization ingest batch must be an object");
  }
  assertExactKeys(
    batch,
    [
      "schema_version",
      "kind",
      "authority_id",
      "organization_id",
      "installation_id",
      "enrollment_receipt_sha256",
      "events",
    ],
    "organization ingest batch",
  );
  if (
    batch.schema_version !== 1 ||
    batch.kind !== "echo-organization-ingest-batch" ||
    !Array.isArray(batch.events) ||
    batch.events.length === 0 ||
    batch.events.length > MAX_ORGANIZATION_INGEST_EVENTS
  ) {
    throw new Error("organization ingest batch is invalid");
  }
  let canonicalBytes = 0;
  const rawEvents = batch.events.map((event) => {
    if (typeof event !== "string") {
      throw new Error("organization ingest batch events must be text");
    }
    canonicalBytes += Buffer.byteLength(event);
    if (canonicalBytes > MAX_ORGANIZATION_INGEST_CANONICAL_BYTES) {
      throw new Error("organization ingest batch exceeds the byte limit");
    }
    return event;
  });
  const snapshot = parseCanonicalJson(
    canonicalJson({
      schema_version: batch.schema_version,
      kind: batch.kind,
      authority_id: batch.authority_id,
      organization_id: batch.organization_id,
      installation_id: batch.installation_id,
      enrollment_receipt_sha256: batch.enrollment_receipt_sha256,
      events: rawEvents,
    }),
  ) as unknown as OrganizationIngestBatchV1;
  assertFederationId(snapshot.authority_id, "oau", "batch authority_id");
  assertFederationId(snapshot.organization_id, "org", "batch organization_id");
  assertFederationId(snapshot.installation_id, "ins", "batch installation_id");
  assertDigest(
    snapshot.enrollment_receipt_sha256,
    "batch enrollment receipt digest",
  );
  const events = snapshot.events.map((canonical, index): ParsedBatchEvent => {
    if (typeof canonical !== "string") {
      throw new Error(
        `organization ingest batch event ${index + 1} is not text`,
      );
    }
    assertFederationDocumentSize(canonical, "organization ingest batch event");
    const envelope = validateFederationDocument<FederatedEventV1>(
      "federated-record-envelope",
      parseCanonicalJson(canonical),
    );
    if (
      envelope.organization_id !== snapshot.organization_id ||
      envelope.producer.installation_id !== snapshot.installation_id
    ) {
      throw new Error(
        "organization ingest event does not match its batch identity",
      );
    }
    return { canonical, sha256: sha256Digest(canonical), envelope };
  });

  const completedGroups = new Set<string>();
  let currentGroup: ParsedBatchEvent[] = [];
  let currentApprovalId: string | undefined;
  const verifyGroup = (): void => {
    if (currentGroup.length === 0) return;
    assertCompleteFederatedApprovalGroup(
      currentGroup.map(({ envelope }) => ({
        local_subject_key: `approved-org-record:${envelope.local_reference.approval_id}:${envelope.local_reference.signal_id}`,
        envelope,
      })),
    );
  };
  for (const event of events) {
    const approvalId = event.envelope.local_reference.approval_id;
    if (currentApprovalId !== approvalId) {
      verifyGroup();
      if (completedGroups.has(approvalId)) {
        throw new Error(
          "organization ingest approval groups are not contiguous",
        );
      }
      if (currentApprovalId !== undefined)
        completedGroups.add(currentApprovalId);
      currentApprovalId = approvalId;
      currentGroup = [];
    }
    currentGroup.push(event);
  }
  verifyGroup();
  return { batch: snapshot, sha256: canonicalSha256(snapshot), events };
}

export class OrganizationSyncStore {
  readonly authority: OrganizationAuthorityDescriptorV1;

  private readonly database: Database.Database;
  private readonly publicKey: Buffer;
  private operationTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    databasePath: string,
    authority: OrganizationAuthorityDescriptorV1,
  ) {
    const verifiedAuthority = validateAuthorityDescriptor(authority);
    this.authority = verifiedAuthority.descriptor;
    this.publicKey = verifiedAuthority.publicKey;
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
      if (existsSync(databasePath)) {
        const state = lstatSync(databasePath);
        if (state.isSymbolicLink() || !state.isFile()) {
          throw new Error("organization sync database must be a regular file");
        }
      }
    }
    this.database = new Database(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.database.exec(ORGANIZATION_SYNC_SCHEMA);
    this.pinAuthority(verifiedAuthority.canonical, verifiedAuthority.sha256);
  }

  private pinAuthority(canonical: string, sha256: Sha256Digest): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare(
          `SELECT authority_id, organization_id, authority_key_id,
                  descriptor_sha256, descriptor_json
           FROM organization_sync_authorities
           WHERE singleton = 1`,
        )
        .get() as AuthorityRow | undefined;
      if (existing !== undefined) {
        if (
          existing.authority_id !== this.authority.authority_id ||
          existing.organization_id !== this.authority.organization_id ||
          existing.authority_key_id !== this.authority.signing_key.key_id ||
          existing.descriptor_sha256 !== sha256 ||
          existing.descriptor_json !== canonical
        ) {
          throw new Error(
            "pinned organization authority conflicts with local state",
          );
        }
      } else {
        this.database
          .prepare(
            `INSERT INTO organization_sync_authorities (
               singleton, authority_id, organization_id, authority_key_id,
               descriptor_sha256, descriptor_json
             ) VALUES (1, ?, ?, ?, ?, ?)`,
          )
          .run(
            this.authority.authority_id,
            this.authority.organization_id,
            this.authority.signing_key.key_id,
            sha256,
            canonical,
          );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the pinning failure if SQLite already rolled back.
      }
      throw error;
    }
  }

  private runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.operationTail.then(async () => {
      if (this.closed) throw new Error("organization sync store is closed");
      return operation();
    });
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private parseEnrollment(raw: string): StoredOrganizationEnrollment {
    assertFederationDocumentSize(raw, "organization enrollment receipt");
    const receipt = validateN2Document<OrganizationEnrollmentReceiptV1>(
      "organization-enrollment-receipt",
      parseCanonicalJson(raw),
    );
    if (
      receipt.authority_id !== this.authority.authority_id ||
      receipt.organization_id !== this.authority.organization_id ||
      receipt.authority_key_id !== this.authority.signing_key.key_id
    ) {
      throw new Error(
        "organization enrollment receipt does not match the pinned authority",
      );
    }
    assertFederationId(receipt.enrollment_id, "enr", "enrollment_id");
    assertFederationId(receipt.principal_id, "prn", "principal_id");
    assertFederationId(receipt.membership_id, "mem", "membership_id");
    assertFederationId(receipt.installation_id, "ins", "installation_id");
    assertFederationId(
      receipt.identity_manifest_id,
      "idm",
      "identity_manifest_id",
    );
    assertFederationId(
      receipt.publication_policy_id,
      "pol",
      "publication_policy_id",
    );
    assertPositiveVersion(
      receipt.publication_policy_version,
      "publication_policy_version",
    );
    assertDigest(
      receipt.publication_policy_sha256,
      "publication policy digest",
    );
    assertDigest(receipt.request_sha256, "enrollment request digest");
    assertUtcMillisecondTimestamp(receipt.enrolled_at, "enrolled_at");
    verifySignedDocument(
      receipt,
      this.publicKey,
      this.authority.signing_key.key_id,
    );
    return { receipt, canonical: raw, sha256: sha256Digest(raw) };
  }

  private parseBatchReceipt(raw: string): StoredOrganizationBatchReceipt {
    assertFederationDocumentSize(raw, "organization batch receipt");
    const receipt = validateN2Document<OrganizationBatchReceiptV1>(
      "organization-batch-receipt",
      parseCanonicalJson(raw),
    );
    if (
      receipt.authority_id !== this.authority.authority_id ||
      receipt.organization_id !== this.authority.organization_id ||
      receipt.authority_key_id !== this.authority.signing_key.key_id
    ) {
      throw new Error(
        "organization batch receipt does not match the pinned authority",
      );
    }
    assertFederationId(receipt.receipt_id, "igr", "receipt_id");
    assertFederationId(receipt.membership_id, "mem", "membership_id");
    assertFederationId(receipt.installation_id, "ins", "installation_id");
    assertDigest(
      receipt.enrollment_receipt_sha256,
      "enrollment receipt digest",
    );
    assertDigest(receipt.batch_sha256, "batch digest");
    assertPositiveVersion(receipt.event_count, "event_count");
    for (const [label, head] of [
      ["previous_head", receipt.previous_head],
      ["resulting_head", receipt.resulting_head],
    ] as const) {
      if (
        !Number.isSafeInteger(head.last_sequence) ||
        head.last_sequence < 0 ||
        (head.last_sequence === 0) !== (head.last_event_hash === null)
      ) {
        throw new Error(`organization batch receipt ${label} is invalid`);
      }
      if (head.last_event_hash !== null) {
        assertDigest(head.last_event_hash, `${label} event hash`);
      }
    }
    assertUtcMillisecondTimestamp(
      receipt.server_received_at,
      "server_received_at",
    );
    verifySignedDocument(
      receipt,
      this.publicKey,
      this.authority.signing_key.key_id,
    );
    return { receipt, canonical: raw, sha256: sha256Digest(raw) };
  }

  private stateFromRow(row: StateRow): OrganizationSyncState {
    assertFederationId(row.authority_id, "oau", "stored authority_id");
    assertFederationId(row.installation_id, "ins", "stored installation_id");
    assertFederationId(row.enrollment_id, "enr", "stored enrollment_id");
    assertDigest(
      row.enrollment_receipt_sha256,
      "stored enrollment receipt digest",
    );
    if (
      !Number.isSafeInteger(row.acknowledged_sequence) ||
      row.acknowledged_sequence < 0 ||
      (row.acknowledged_sequence === 0) !==
        (row.acknowledged_event_hash === null)
    ) {
      throw new Error(
        "stored organization sync acknowledgement is inconsistent",
      );
    }
    if (row.acknowledged_event_hash !== null) {
      assertDigest(
        row.acknowledged_event_hash,
        "stored acknowledged event hash",
      );
    }
    if (row.terminal_status !== "active" && row.terminal_status !== "revoked") {
      throw new Error("stored organization sync terminal status is invalid");
    }
    return {
      ...row,
      enrollment_receipt_sha256: row.enrollment_receipt_sha256,
      acknowledged_event_hash: row.acknowledged_event_hash,
      terminal_status: row.terminal_status,
    };
  }

  private stateRow(installationId: string): StateRow | undefined {
    return this.database
      .prepare(
        `SELECT authority_id, installation_id, enrollment_id,
                enrollment_receipt_sha256, acknowledged_sequence,
                acknowledged_event_hash, terminal_status
         FROM organization_sync_states
         WHERE authority_id = ? AND installation_id = ?`,
      )
      .get(this.authority.authority_id, installationId) as StateRow | undefined;
  }

  async storeEnrollmentReceipt(
    canonicalReceipt: string,
  ): Promise<StoredOrganizationEnrollment> {
    const stored = this.parseEnrollment(canonicalReceipt);
    return this.runExclusive(() => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const byId = this.database
          .prepare(
            `SELECT enrollment_id, authority_id, organization_id, membership_id,
                    installation_id, enrollment_receipt_sha256, receipt_json
             FROM organization_sync_enrollments
             WHERE enrollment_id = ?`,
          )
          .get(stored.receipt.enrollment_id) as EnrollmentRow | undefined;
        const byInstallation = this.database
          .prepare(
            `SELECT enrollment_id, authority_id, organization_id, membership_id,
                    installation_id, enrollment_receipt_sha256, receipt_json
             FROM organization_sync_enrollments
             WHERE authority_id = ? AND installation_id = ?`,
          )
          .get(this.authority.authority_id, stored.receipt.installation_id) as
          EnrollmentRow | undefined;
        const existing = byId ?? byInstallation;
        if (existing !== undefined) {
          if (
            byId?.receipt_json !== stored.canonical ||
            byInstallation?.receipt_json !== stored.canonical ||
            existing.enrollment_receipt_sha256 !== stored.sha256
          ) {
            throw new Error(
              "organization enrollment receipt conflicts with immutable local state",
            );
          }
          this.database.exec("COMMIT");
          return stored;
        }
        this.database
          .prepare(
            `INSERT INTO organization_sync_enrollments (
               enrollment_id, authority_id, organization_id, membership_id,
               installation_id, enrollment_receipt_sha256, receipt_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            stored.receipt.enrollment_id,
            stored.receipt.authority_id,
            stored.receipt.organization_id,
            stored.receipt.membership_id,
            stored.receipt.installation_id,
            stored.sha256,
            stored.canonical,
          );
        this.database
          .prepare(
            `INSERT INTO organization_sync_states (
               authority_id, installation_id, enrollment_id,
               enrollment_receipt_sha256
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            stored.receipt.authority_id,
            stored.receipt.installation_id,
            stored.receipt.enrollment_id,
            stored.sha256,
          );
        this.database.exec("COMMIT");
        return stored;
      } catch (error) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the first failure.
        }
        throw error;
      }
    });
  }

  async inspectEnrollment(
    installationId: string,
  ): Promise<StoredOrganizationEnrollment | null> {
    assertFederationId(installationId, "ins", "installation_id");
    return this.runExclusive(() => {
      const row = this.database
        .prepare(
          `SELECT enrollment_id, authority_id, organization_id, membership_id,
                  installation_id, enrollment_receipt_sha256, receipt_json
           FROM organization_sync_enrollments
           WHERE authority_id = ? AND installation_id = ?`,
        )
        .get(this.authority.authority_id, installationId) as
        EnrollmentRow | undefined;
      if (row === undefined) return null;
      const stored = this.parseEnrollment(row.receipt_json);
      if (
        stored.sha256 !== row.enrollment_receipt_sha256 ||
        stored.receipt.enrollment_id !== row.enrollment_id ||
        stored.receipt.authority_id !== row.authority_id ||
        stored.receipt.organization_id !== row.organization_id ||
        stored.receipt.membership_id !== row.membership_id ||
        stored.receipt.installation_id !== row.installation_id
      ) {
        throw new Error(
          "stored organization enrollment receipt metadata is inconsistent",
        );
      }
      return stored;
    });
  }

  async inspectState(
    installationId: string,
  ): Promise<OrganizationSyncState | null> {
    assertFederationId(installationId, "ins", "installation_id");
    return this.runExclusive(() => {
      const row = this.stateRow(installationId);
      return row === undefined ? null : this.stateFromRow(row);
    });
  }

  async storeBatchReceipt(
    batchInput: OrganizationIngestBatchV1,
    canonicalReceipt: string,
  ): Promise<StoreOrganizationBatchReceiptResult> {
    const parsedBatch = parseBatch(batchInput);
    const stored = this.parseBatchReceipt(canonicalReceipt);

    return this.runExclusive(() => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.stateRow(parsedBatch.batch.installation_id);
        if (row === undefined) {
          throw new Error(
            "organization enrollment receipt must be stored before ingest",
          );
        }
        const state = this.stateFromRow(row);
        const enrollmentRow = this.database
          .prepare(
            `SELECT enrollment_id, authority_id, organization_id, membership_id,
                    installation_id, enrollment_receipt_sha256, receipt_json
             FROM organization_sync_enrollments
             WHERE enrollment_id = ?`,
          )
          .get(state.enrollment_id) as EnrollmentRow | undefined;
        if (enrollmentRow === undefined) {
          throw new Error(
            "organization sync state is missing its enrollment receipt",
          );
        }
        const enrollment = this.parseEnrollment(enrollmentRow.receipt_json);
        if (
          parsedBatch.batch.authority_id !== this.authority.authority_id ||
          parsedBatch.batch.organization_id !==
            this.authority.organization_id ||
          parsedBatch.batch.enrollment_receipt_sha256 !== enrollment.sha256 ||
          state.enrollment_receipt_sha256 !== enrollment.sha256
        ) {
          throw new Error(
            "organization ingest batch does not match its stored enrollment",
          );
        }

        for (const event of parsedBatch.events) {
          assertOrganizationEventMatchesEnrollment(
            event.envelope,
            enrollment.receipt,
          );
        }

        const receipt = stored.receipt;
        if (
          receipt.installation_id !== state.installation_id ||
          receipt.membership_id !== enrollment.receipt.membership_id ||
          receipt.enrollment_receipt_sha256 !== enrollment.sha256 ||
          receipt.batch_sha256 !== parsedBatch.sha256 ||
          receipt.event_count !== parsedBatch.events.length
        ) {
          throw new Error(
            "organization batch receipt does not match the exact local batch",
          );
        }

        const receiptSelect = `SELECT receipt_id, authority_id, installation_id,
                                      batch_sha256, status, receipt_sha256,
                                      receipt_json
                               FROM organization_sync_batch_receipts`;
        const existingById = this.database
          .prepare(`${receiptSelect} WHERE receipt_id = ?`)
          .get(receipt.receipt_id) as ReceiptRow | undefined;
        const existingByBatch = this.database
          .prepare(`${receiptSelect} WHERE batch_sha256 = ?`)
          .get(receipt.batch_sha256) as ReceiptRow | undefined;
        if (existingById !== undefined || existingByBatch !== undefined) {
          if (
            existingById === undefined ||
            existingByBatch === undefined ||
            existingById.receipt_json !== stored.canonical ||
            existingByBatch.receipt_json !== stored.canonical ||
            existingById.receipt_sha256 !== stored.sha256 ||
            existingByBatch.receipt_sha256 !== stored.sha256
          ) {
            throw new Error(
              "organization batch receipt conflicts with immutable local state",
            );
          }
          this.database.exec("COMMIT");
          return {
            state: this.stateFromRow(this.stateRow(state.installation_id)!),
            stored,
          };
        }
        let previousHash = parsedBatch.events[0]!.envelope.previous_event_hash;
        let expectedSequence = parsedBatch.events[0]!.envelope.sequence;
        for (const event of parsedBatch.events) {
          if (
            event.envelope.sequence !== expectedSequence ||
            event.envelope.previous_event_hash !== previousHash
          ) {
            throw new Error(
              "organization ingest batch is not contiguous with local acknowledgement",
            );
          }
          previousHash = event.sha256;
          expectedSequence += 1;
        }

        const firstEvent = parsedBatch.events[0]!;
        const lastEvent = parsedBatch.events.at(-1)!;
        const advancing =
          receipt.status === "accepted" || receipt.status === "duplicate";
        if (advancing) {
          if (
            receipt.reason !== null ||
            receipt.previous_head.last_sequence !==
              firstEvent.envelope.sequence - 1 ||
            receipt.previous_head.last_event_hash !==
              firstEvent.envelope.previous_event_hash ||
            receipt.resulting_head.last_sequence !==
              lastEvent.envelope.sequence ||
            receipt.resulting_head.last_event_hash !== lastEvent.sha256
          ) {
            throw new Error(
              "organization batch receipt has invalid advancing heads",
            );
          }
        } else if (
          receipt.reason === null ||
          receipt.previous_head.last_sequence !==
            receipt.resulting_head.last_sequence ||
          receipt.previous_head.last_event_hash !==
            receipt.resulting_head.last_event_hash
        ) {
          throw new Error(
            "organization batch receipt has invalid revocation heads",
          );
        }
        const advances =
          receipt.previous_head.last_sequence === state.acknowledged_sequence &&
          receipt.previous_head.last_event_hash ===
            state.acknowledged_event_hash;
        if (advancing && !advances) {
          if (
            receipt.resulting_head.last_sequence >
              state.acknowledged_sequence ||
            (receipt.resulting_head.last_sequence ===
              state.acknowledged_sequence &&
              receipt.resulting_head.last_event_hash !==
                state.acknowledged_event_hash)
          ) {
            throw new Error(
              "organization batch receipt conflicts with local acknowledgement",
            );
          }
        }
        if (state.terminal_status === "revoked" && advancing) {
          throw new Error(
            `organization sync is terminal: ${state.terminal_status}`,
          );
        }

        this.database
          .prepare(
            `INSERT INTO organization_sync_batch_receipts (
               receipt_id, authority_id, installation_id, batch_sha256,
               status, receipt_sha256, receipt_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            receipt.receipt_id,
            receipt.authority_id,
            receipt.installation_id,
            receipt.batch_sha256,
            receipt.status,
            stored.sha256,
            stored.canonical,
          );
        this.database
          .prepare(
            `UPDATE organization_sync_states
             SET acknowledged_sequence = ?, acknowledged_event_hash = ?,
                 terminal_status = ?
             WHERE authority_id = ? AND installation_id = ?`,
          )
          .run(
            advancing && advances
              ? receipt.resulting_head.last_sequence
              : state.acknowledged_sequence,
            advancing && advances
              ? receipt.resulting_head.last_event_hash
              : state.acknowledged_event_hash,
            advancing ? state.terminal_status : "revoked",
            this.authority.authority_id,
            state.installation_id,
          );
        this.database.exec("COMMIT");
        return {
          state: this.stateFromRow(this.stateRow(state.installation_id)!),
          stored,
        };
      } catch (error) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the first failure.
        }
        throw error;
      }
    });
  }

  async inspectBatchReceipts(
    installationId: string,
  ): Promise<readonly StoredOrganizationBatchReceipt[]> {
    assertFederationId(installationId, "ins", "installation_id");
    return this.runExclusive(() => {
      const rows = this.database
        .prepare(
          `SELECT receipt_id, authority_id, installation_id, batch_sha256,
                  status, receipt_sha256, receipt_json
           FROM organization_sync_batch_receipts
           WHERE authority_id = ? AND installation_id = ?
           ORDER BY rowid ASC`,
        )
        .all(this.authority.authority_id, installationId) as ReceiptRow[];
      return rows.map((row) => {
        const stored = this.parseBatchReceipt(row.receipt_json);
        if (
          stored.sha256 !== row.receipt_sha256 ||
          stored.receipt.receipt_id !== row.receipt_id ||
          stored.receipt.authority_id !== row.authority_id ||
          stored.receipt.installation_id !== row.installation_id ||
          stored.receipt.batch_sha256 !== row.batch_sha256 ||
          stored.receipt.status !== row.status
        ) {
          throw new Error(
            "stored organization batch receipt metadata is inconsistent",
          );
        }
        return stored;
      });
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
