import type { OrganizationIngestBatchV1, Sha256Digest } from '../contracts.js';
import { canonicalSha256 } from '../foundation/canonical-json.js';
import { assertFederationId } from '../foundation/identifiers.js';
import {
  assertCompleteFederatedApprovalGroup,
  type FederatedOutboxStore,
  type StoredFederatedOutboxEvent,
} from '../outbox-store.js';
import {
  assertOrganizationEventMatchesEnrollment,
  type OrganizationSyncState,
  type OrganizationSyncStore,
} from './organization-sync-store.js';

export interface OrganizationIngestClient {
  upload(
    batch: OrganizationIngestBatchV1,
    options: { signal: AbortSignal },
  ): Promise<readonly string[]>;
}

export const ORGANIZATION_UPLOAD_MAX_EVENTS = 256;
export const ORGANIZATION_UPLOAD_MAX_CANONICAL_BYTES = 16 * 1024 * 1024;

export type OrganizationOutboxUploadStatus =
  'idle' | 'accepted' | 'rejected' | 'quarantined';

export interface OrganizationOutboxUploadResult {
  status: OrganizationOutboxUploadStatus;
  attempted_events: number;
  acknowledged_sequence: number;
  acknowledged_event_hash: Sha256Digest | null;
  batch_sha256: Sha256Digest | null;
}

export interface OrganizationOutboxUploaderOptions {
  installation_id: string;
  outbox: FederatedOutboxStore;
  sync: OrganizationSyncStore;
  client: OrganizationIngestClient;
}

/**
 * Uploads immutable local outbox bytes without taking ownership of the injected
 * stores or transport. A retry always rebuilds the same batch from the exact
 * SQLite strings; only a verified authority receipt can advance local state.
 */
export class OrganizationOutboxUploader {
  private readonly installationId: string;
  private readonly outbox: FederatedOutboxStore;
  private readonly sync: OrganizationSyncStore;
  private readonly client: OrganizationIngestClient;
  private operationTail: Promise<void> = Promise.resolve();
  private activeUpload: AbortController | null = null;
  private closed = false;

  constructor(options: OrganizationOutboxUploaderOptions) {
    assertFederationId(
      options.installation_id,
      'ins',
      'organization uploader installation_id',
    );
    this.installationId = options.installation_id;
    this.outbox = options.outbox;
    this.sync = options.sync;
    this.client = options.client;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(async () => {
      if (this.closed)
        throw new Error('organization outbox uploader is closed');
      return operation();
    });
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async verifiedLocalState(): Promise<{
    state: OrganizationSyncState;
    events: Awaited<ReturnType<FederatedOutboxStore['readInstallationEvents']>>;
  }> {
    const enrollment = await this.sync.inspectEnrollment(this.installationId);
    if (enrollment === null) {
      throw new Error(
        'organization enrollment receipt must be stored before upload',
      );
    }
    const state = await this.sync.inspectState(this.installationId);
    if (state === null) {
      throw new Error('organization sync state is missing after enrollment');
    }
    if (
      state.enrollment_id !== enrollment.receipt.enrollment_id ||
      state.enrollment_receipt_sha256 !== enrollment.sha256
    ) {
      throw new Error(
        'organization sync state disagrees with its enrollment receipt',
      );
    }
    const events = await this.outbox.readInstallationEvents(
      this.installationId,
    );
    for (const event of events) {
      assertOrganizationEventMatchesEnrollment(
        event.envelope,
        enrollment.receipt,
      );
    }
    if (state.acknowledged_sequence > events.length) {
      throw new Error(
        'organization acknowledgement is ahead of local outbox history',
      );
    }
    if (state.acknowledged_sequence === 0) {
      if (state.acknowledged_event_hash !== null) {
        throw new Error(
          'empty organization acknowledgement has a non-empty hash',
        );
      }
    } else {
      const acknowledged = events[state.acknowledged_sequence - 1];
      if (
        acknowledged === undefined ||
        acknowledged.sequence !== state.acknowledged_sequence ||
        acknowledged.event_hash !== state.acknowledged_event_hash
      ) {
        throw new Error(
          'organization acknowledgement does not match exact local history',
        );
      }
    }
    return { state, events };
  }

  private boundedCompleteBatch(
    pending: readonly StoredFederatedOutboxEvent[],
  ): readonly StoredFederatedOutboxEvent[] {
    const selected: StoredFederatedOutboxEvent[] = [];
    let selectedBytes = 0;
    let cursor = 0;
    while (cursor < pending.length) {
      const approvalId = pending[cursor]!.envelope.local_reference.approval_id;
      const group: StoredFederatedOutboxEvent[] = [];
      while (
        cursor < pending.length &&
        pending[cursor]!.envelope.local_reference.approval_id === approvalId
      ) {
        group.push(pending[cursor]!);
        cursor += 1;
      }
      assertCompleteFederatedApprovalGroup(
        group.map((event) => ({
          local_subject_key: event.local_subject_key,
          envelope: event.envelope,
        })),
      );
      const groupBytes = group.reduce(
        (total, event) => total + Buffer.byteLength(event.envelope_json),
        0,
      );
      if (
        group.length > ORGANIZATION_UPLOAD_MAX_EVENTS ||
        groupBytes > ORGANIZATION_UPLOAD_MAX_CANONICAL_BYTES
      ) {
        throw new Error(
          'one organization approval group exceeds the upload batch limit',
        );
      }
      if (
        selected.length > 0 &&
        (selected.length + group.length > ORGANIZATION_UPLOAD_MAX_EVENTS ||
          selectedBytes + groupBytes > ORGANIZATION_UPLOAD_MAX_CANONICAL_BYTES)
      ) {
        break;
      }
      selected.push(...group);
      selectedBytes += groupBytes;
    }
    return selected;
  }

  async inspect(): Promise<OrganizationSyncState> {
    return this.runExclusive(
      async () => (await this.verifiedLocalState()).state,
    );
  }

  async uploadPending(): Promise<OrganizationOutboxUploadResult> {
    return this.runExclusive(async () => {
      const { state, events } = await this.verifiedLocalState();
      if (state.terminal_status === 'quarantined') {
        return {
          status: 'quarantined',
          attempted_events: 0,
          acknowledged_sequence: state.acknowledged_sequence,
          acknowledged_event_hash: state.acknowledged_event_hash,
          batch_sha256: null,
        };
      }
      const pending = events.slice(state.acknowledged_sequence);
      if (pending.length === 0) {
        return {
          status: state.terminal_status === 'rejected' ? 'rejected' : 'idle',
          attempted_events: 0,
          acknowledged_sequence: state.acknowledged_sequence,
          acknowledged_event_hash: state.acknowledged_event_hash,
          batch_sha256: null,
        };
      }
      const selected = this.boundedCompleteBatch(pending);
      const batch: OrganizationIngestBatchV1 = Object.freeze({
        schema_version: 1,
        kind: 'echo-organization-ingest-batch',
        authority_id: this.sync.authority.authority_id,
        organization_id: this.sync.authority.organization_id,
        installation_id: this.installationId,
        enrollment_receipt_sha256: state.enrollment_receipt_sha256,
        events: Object.freeze(selected.map((event) => event.envelope_json)),
      });
      const batchSha256 = canonicalSha256(batch);
      const controller = new AbortController();
      this.activeUpload = controller;
      let canonicalReceipts: readonly string[];
      try {
        canonicalReceipts = await this.client.upload(batch, {
          signal: controller.signal,
        });
      } finally {
        if (this.activeUpload === controller) this.activeUpload = null;
      }
      const updated = await this.sync.storeIngestReceipts(
        batch,
        canonicalReceipts,
      );
      const status: OrganizationOutboxUploadStatus =
        updated.terminal_status === 'quarantined'
          ? 'quarantined'
          : updated.terminal_status === 'rejected'
            ? 'rejected'
            : 'accepted';
      return {
        status,
        attempted_events: selected.length,
        acknowledged_sequence: updated.acknowledged_sequence,
        acknowledged_event_hash: updated.acknowledged_event_hash,
        batch_sha256: batchSha256,
      };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.activeUpload?.abort();
    const close = this.operationTail.then(() => {
      this.activeUpload = null;
    });
    this.operationTail = close;
    await close;
  }
}
