import { Buffer } from 'node:buffer';
import {
  assertFederationId,
  canonicalJson,
} from '@echo-brain/federation-protocol';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import {
  MAX_ORGANIZATION_RECENT_DECISIONS_ITEMS,
  MAX_ORGANIZATION_RECENT_DECISIONS_RESPONSE_BYTES,
  ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
  ORGANIZATION_RECENT_DECISIONS_WITNESS,
  validateOrganizationRecentDecisionsResponse,
} from '@echo-brain/organization-api';
import type {
  OrganizationRecentDecisionItemV1,
  OrganizationRecentDecisionKindV1,
  OrganizationRecentDecisionsResponseV1,
} from '@echo-brain/organization-api';

export const MAX_ORGANIZATION_RECENT_DECISIONS_POINTERS = 20;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * The immutable marker facts the Authority needs while serving. Composition
 * copies these from the startup-validated record-log marker; application code
 * deliberately does not depend on the record service's persistence types.
 */
export interface OrganizationRecentDecisionsPilotActivation {
  readonly organization_id: string;
  readonly policy_id: typeof ORGANIZATION_RECENT_DECISIONS_POLICY_ID;
  readonly marker_sha256: Sha256Digest;
  readonly audience_notice_sha256: Sha256Digest;
  readonly membership_ids: readonly [string, string];
}

/** The allowlisted output of the existing pure record projector. */
export interface OrganizationRecentDecisionsProjectedAtom {
  readonly atom_id: Sha256Digest;
  readonly record_hash: Sha256Digest;
  readonly kind: OrganizationRecentDecisionKindV1;
  readonly text: string;
}

/**
 * One startup-verified eligibility pointer after its canonical log row has
 * been projected in memory. Internal fields are copied into the closed public
 * DTO below; this object is never serialized directly.
 */
export interface OrganizationRecentDecisionsProjectedRecord {
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly atoms: readonly OrganizationRecentDecisionsProjectedAtom[];
}

export type OrganizationRecentDecisionsAuditedStatus = 200 | 401 | 404;

export interface PreparedOrganizationRecentDecisionsResponse {
  readonly status_code: OrganizationRecentDecisionsAuditedStatus;
  /** These are the exact bytes whose digest was committed to the audit log. */
  readonly body: Buffer;
  /** Minimized audit references; never handed to the HTTP serializer. */
  readonly item_references: readonly {
    readonly atom_id: Sha256Digest;
    readonly record_hash: Sha256Digest;
  }[];
}

export type OrganizationRecentDecisionsErrorCode =
  'invalid_request' | 'unauthorized' | 'unavailable';

/**
 * Expected route failures which carry one of the pilot's metadata-free public
 * error classes. Authenticated 401/404 decisions are returned as prepared
 * responses instead, because their exact bytes must be audited before send.
 */
export class OrganizationRecentDecisionsError extends Error {
  constructor(
    readonly code: OrganizationRecentDecisionsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OrganizationRecentDecisionsError';
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new OrganizationRecentDecisionsError('unavailable', message);
  }
}

function assertDigest(value: string, label: string): void {
  invariant(SHA256_PATTERN.test(value), `${label} is invalid`);
}

export function validateRecentDecisionsPilotActivation(
  activation: OrganizationRecentDecisionsPilotActivation,
): OrganizationRecentDecisionsPilotActivation {
  try {
    assertFederationId(
      activation.organization_id,
      'org',
      'permission pilot organization_id',
    );
    for (const membershipId of activation.membership_ids) {
      assertFederationId(membershipId, 'mem', 'permission pilot membership_id');
    }
  } catch (error) {
    throw new OrganizationRecentDecisionsError(
      'unavailable',
      'permission pilot activation is invalid',
      { cause: error },
    );
  }
  invariant(
    activation.policy_id === ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
    'permission pilot policy is invalid',
  );
  assertDigest(activation.marker_sha256, 'permission pilot marker digest');
  assertDigest(
    activation.audience_notice_sha256,
    'permission pilot audience notice digest',
  );
  invariant(
    activation.membership_ids.length === 2 &&
      activation.membership_ids[0] < activation.membership_ids[1],
    'permission pilot audience is not an ordered distinct pair',
  );
  return {
    organization_id: activation.organization_id,
    policy_id: activation.policy_id,
    marker_sha256: activation.marker_sha256,
    audience_notice_sha256: activation.audience_notice_sha256,
    membership_ids: [
      activation.membership_ids[0],
      activation.membership_ids[1],
    ],
  };
}

function closedItem(
  atom: OrganizationRecentDecisionsProjectedAtom,
  recordHash: Sha256Digest,
): OrganizationRecentDecisionItemV1 {
  assertDigest(recordHash, 'projected record hash');
  assertDigest(atom.atom_id, 'projected atom id');
  assertDigest(atom.record_hash, 'projected atom record hash');
  invariant(
    atom.record_hash === recordHash,
    'projected atom belongs to another record',
  );
  invariant(
    atom.kind === 'decision' ||
      atom.kind === 'action' ||
      atom.kind === 'rationale',
    'projected atom kind is unsupported',
  );
  invariant(
    typeof atom.text === 'string' && atom.text.trim().length > 0,
    'projected atom text is invalid',
  );
  return {
    atom_id: atom.atom_id,
    kind: atom.kind,
    text: atom.text,
    record_hash: recordHash,
  };
}

function uncheckedResponse(
  items: readonly OrganizationRecentDecisionItemV1[],
): OrganizationRecentDecisionsResponseV1 {
  return {
    schema_version: 1,
    policy_id: ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
    witness: ORGANIZATION_RECENT_DECISIONS_WITNESS,
    items: [...items],
  };
}

function responseBytes(value: OrganizationRecentDecisionsResponseV1): Buffer {
  try {
    return Buffer.from(canonicalJson(value), 'utf8');
  } catch (error) {
    throw new OrganizationRecentDecisionsError(
      'unavailable',
      'recent decisions response is not canonicalizable',
      { cause: error },
    );
  }
}

function finalResponse(
  items: readonly OrganizationRecentDecisionItemV1[],
): PreparedOrganizationRecentDecisionsResponse {
  let value: OrganizationRecentDecisionsResponseV1;
  try {
    value = validateOrganizationRecentDecisionsResponse(
      uncheckedResponse(items),
    );
  } catch (error) {
    throw new OrganizationRecentDecisionsError(
      'unavailable',
      'recent decisions response failed closed-schema validation',
      { cause: error },
    );
  }
  return {
    status_code: 200,
    body: responseBytes(value),
    item_references: items.map(({ atom_id, record_hash }) => ({
      atom_id,
      record_hash,
    })),
  };
}

/**
 * Copies projector output into the closed public DTO and applies both response
 * cutoffs as a longest whole-item prefix. The source records must already be
 * the newest eligible records in descending log order.
 */
export function prepareAllowedRecentDecisionsResponse(
  records: readonly OrganizationRecentDecisionsProjectedRecord[],
): PreparedOrganizationRecentDecisionsResponse {
  invariant(
    records.length <= MAX_ORGANIZATION_RECENT_DECISIONS_POINTERS,
    'recent decisions source exceeded the pointer budget',
  );
  const items: OrganizationRecentDecisionItemV1[] = [];
  const atomIds = new Set<string>();
  let previousPosition = Number.POSITIVE_INFINITY;

  for (const record of records) {
    invariant(
      Number.isSafeInteger(record.log_position) && record.log_position > 0,
      'recent decisions source has an invalid log position',
    );
    invariant(
      record.log_position < previousPosition,
      'recent decisions source is not in descending log order',
    );
    previousPosition = record.log_position;
    for (const atom of record.atoms) {
      if (items.length === MAX_ORGANIZATION_RECENT_DECISIONS_ITEMS) {
        return finalResponse(items);
      }
      const item = closedItem(atom, record.record_hash);
      invariant(
        !atomIds.has(item.atom_id),
        'recent decisions source repeats an atom id',
      );
      const candidate = uncheckedResponse([...items, item]);
      const candidateBytes = responseBytes(candidate);
      if (
        candidateBytes.length > MAX_ORGANIZATION_RECENT_DECISIONS_RESPONSE_BYTES
      ) {
        invariant(
          items.length > 0,
          'one eligible recent decision cannot fit the response budget',
        );
        return finalResponse(items);
      }
      items.push(item);
      atomIds.add(item.atom_id);
    }
  }
  return finalResponse(items);
}

const FIXED_ERROR_VALUES = {
  400: {
    error: { code: 'invalid_request', message: 'request is invalid' },
  },
  401: {
    error: { code: 'unauthorized', message: 'authorization failed' },
  },
  404: {
    error: { code: 'not_found', message: 'resource was not found' },
  },
  503: {
    error: {
      code: 'unavailable',
      message: 'service is temporarily unavailable',
    },
  },
} as const;

export type OrganizationRecentDecisionsFixedErrorStatus =
  keyof typeof FIXED_ERROR_VALUES;

export function fixedRecentDecisionsErrorBytes(
  status: OrganizationRecentDecisionsFixedErrorStatus,
): Buffer {
  return Buffer.from(canonicalJson(FIXED_ERROR_VALUES[status]), 'utf8');
}
