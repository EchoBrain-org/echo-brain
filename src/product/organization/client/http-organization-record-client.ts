import { Buffer } from 'node:buffer';
import {
  isOrganizationApiValidationError,
  isOrganizationRecordPermanentRejectionCode,
  MAX_ORGANIZATION_API_BODY_BYTES,
  MAX_ORGANIZATION_RECORD_API_BODY_BYTES,
  ORGANIZATION_API_RECORD_ENVELOPES_PATH,
  validateAcceptedOrganizationRecord,
  validateOrganizationApiError,
} from '@echo-brain/organization-api';
import { verifyOrganizationRecordReceipt } from '@echo-brain/organization-protocol';
import type {
  OrganizationRecordReceiptV1,
  PinnedOrganizationAuthority,
} from '@echo-brain/organization-protocol';
import type { P256SigningKeyDescriptor } from '@echo-brain/federation-protocol';
import {
  normalizeOrganizationAuthorityBaseUrl,
  OrganizationAuthorityTransportError,
  readBoundedJsonResponse,
  resolveOrganizationAuthorityFetch,
} from './http-organization-authority-client.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const JSON_HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json',
} as const;

export interface HttpOrganizationRecordClientOptions {
  baseUrl: string;
  pinnedAuthority: PinnedOrganizationAuthority;
  installationSigningKey: P256SigningKeyDescriptor;
  fetch?: typeof fetch;
  authorityCaPem?: string;
  timeoutMs?: number;
  /** Development/test only. Plain HTTP is restricted to loopback hosts. */
  allowInsecureLoopback?: boolean;
}

/** Structural mirror of the submitter's `OrganizationRecordSubmission`. */
export interface OrganizationRecordSubmissionRequest {
  readonly envelope_id: string;
  readonly idempotency_key: string;
  readonly envelope_sha256: string;
  readonly envelope: Record<string, unknown>;
}

/**
 * Structural mirror of the submitter's `OrganizationRecordSubmissionResult`.
 * Only `rejected` is terminal; `retry` keeps the frozen envelope alive for the
 * next sweep.
 */
export type OrganizationRecordSubmissionOutcome =
  | {
      readonly outcome: 'accepted';
      readonly receipt: OrganizationRecordReceiptV1;
    }
  | {
      readonly outcome: 'rejected';
      readonly reason_code: string;
      readonly reason: string;
    }
  | { readonly outcome: 'retry'; readonly reason: string };

/**
 * The member-side organization record ingest client.
 *
 * Two rules make this client different from the generic authority client, and
 * both come straight from the design:
 *
 * 1. It uses the record-specific 256 KiB request allowance because an approved
 *    brief can exceed the shared 16 KiB limit. Receipts remain under the shared
 *    response allowance.
 * 2. It cryptographically verifies the signed receipt against the pinned
 *    authority key and the exact envelope bytes before returning it. A receipt
 *    that fails verification is never an accepted outcome.
 */
export class HttpOrganizationRecordClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpOrganizationRecordClientOptions) {
    this.baseUrl = normalizeOrganizationAuthorityBaseUrl(
      options.baseUrl,
      options.allowInsecureLoopback === true,
    );
    this.fetchImpl = resolveOrganizationAuthorityFetch(options);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('organization record timeout must be positive');
    }
  }

  async submitRecord(
    submission: OrganizationRecordSubmissionRequest,
    signal?: AbortSignal,
  ): Promise<OrganizationRecordSubmissionOutcome> {
    const body = JSON.stringify({ record_envelope: submission.envelope });
    if (Buffer.byteLength(body) > MAX_ORGANIZATION_RECORD_API_BODY_BYTES) {
      // Permanent by construction: the frozen bytes will never shrink, so
      // retrying them forever would strand the node instead of surfacing it.
      return {
        outcome: 'rejected',
        reason_code: 'record_envelope_too_large',
        reason: 'organization record envelope exceeds the ingest body limit',
      };
    }
    let response: Response;
    try {
      const deadline = AbortSignal.timeout(this.timeoutMs);
      response = await this.fetchImpl(
        new URL(ORGANIZATION_API_RECORD_ENVELOPES_PATH, this.baseUrl).href,
        {
          method: 'POST',
          headers: JSON_HEADERS,
          body,
          redirect: 'error',
          signal:
            signal === undefined
              ? deadline
              : AbortSignal.any([signal, deadline]),
        },
      );
    } catch (error) {
      signal?.throwIfAborted();
      return {
        outcome: 'retry',
        reason: `organization record submission failed: ${(error as Error).message}`,
      };
    }
    let value: unknown;
    try {
      value = await readBoundedJsonResponse(
        response,
        MAX_ORGANIZATION_API_BODY_BYTES,
      );
    } catch (error) {
      return {
        outcome: 'retry',
        reason:
          error instanceof OrganizationAuthorityTransportError
            ? `organization record response was unusable: ${error.code}`
            : 'organization record response could not be read',
      };
    }
    if (!response.ok) return this.failure(value, response.status);
    return this.accepted(value, submission);
  }

  /**
   * A terminal outcome is decided by the exact error code, never by status or
   * message text. Anything unrecognized stays retryable.
   */
  private failure(
    value: unknown,
    status: number,
  ): OrganizationRecordSubmissionOutcome {
    let code: string;
    let message: string;
    try {
      const apiError = validateOrganizationApiError(value);
      code = apiError.error.code;
      message = apiError.error.message;
    } catch (error) {
      if (!isOrganizationApiValidationError(error)) throw error;
      return {
        outcome: 'retry',
        reason: `organization authority returned an unreadable error (status ${status})`,
      };
    }
    if (isOrganizationRecordPermanentRejectionCode(code)) {
      return { outcome: 'rejected', reason_code: code, reason: message };
    }
    return {
      outcome: 'retry',
      reason: `organization authority rejected the submission: ${code}`,
    };
  }

  private accepted(
    value: unknown,
    submission: OrganizationRecordSubmissionRequest,
  ): OrganizationRecordSubmissionOutcome {
    let receipt: OrganizationRecordReceiptV1;
    try {
      const accepted = validateAcceptedOrganizationRecord(value);
      // Verification, not validation: the authority signature over the exact
      // receipt payload, the pinned authority key, and every receipt-to-
      // envelope binding, recomputed from the canonical envelope bytes.
      receipt = verifyOrganizationRecordReceipt(
        accepted.record_receipt,
        this.options.pinnedAuthority,
        submission.envelope,
        this.options.installationSigningKey,
      );
    } catch (error) {
      return {
        outcome: 'retry',
        reason: `organization record receipt failed verification: ${(error as Error).message}`,
      };
    }
    if (receipt.envelope_sha256 !== submission.envelope_sha256) {
      return {
        outcome: 'retry',
        reason: 'organization record receipt names other envelope bytes',
      };
    }
    return { outcome: 'accepted', receipt };
  }
}
