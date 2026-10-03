import { sourceContentSha256V1 } from '../processing/source-admission.js';
import { assertPlainContextObjectV1 } from './context-capture-v1.js';

export const CAPTURE_SOURCE_REF_LIMITS_V1 = Object.freeze({
  token_bytes: 64, opaque_bytes: 256, reference_bytes: 2048,
});

export interface CaptureSourceRefPartsV1 {
  readonly tool: string;
  readonly tenant: string;
  readonly kind: string;
  readonly id: string;
}

function token(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error('Capture reference token is invalid');
}
function opaque(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > CAPTURE_SOURCE_REF_LIMITS_V1.opaque_bytes || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new Error('Capture reference component must be bounded text');
  }
  // Reject malformed UTF-16 before either URI encoding or hashing can erase it.
  try { encodeURIComponent(value); } catch { throw new Error('Capture reference component has malformed Unicode'); }
}
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Stable upstream identities use kind "actor"; this reference grants no ECHO identity or permissions. */
export function captureSourceRefV1(input: CaptureSourceRefPartsV1): string {
  assertPlainContextObjectV1(input, ['tool', 'tenant', 'kind', 'id'], 'Capture reference');
  token(input.tool); token(input.kind); opaque(input.tenant); opaque(input.id);
  return `${input.tool}:${encode(input.tenant)}:${input.kind}:${encode(input.id)}`;
}

/** One canonical spelling per opaque tenant-qualified identity. */
export function parseCaptureSourceRefV1(value: unknown): CaptureSourceRefPartsV1 {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > CAPTURE_SOURCE_REF_LIMITS_V1.reference_bytes) throw new Error('Capture reference exceeds its bound');
  const parts = value.split(':');
  if (parts.length !== 4) throw new Error('Capture reference must have four components');
  let tenant: string; let id: string;
  try { tenant = decodeURIComponent(parts[1]!); id = decodeURIComponent(parts[3]!); }
  catch { throw new Error('Capture reference encoding is invalid'); }
  const parsed = { tool: parts[0]!, tenant, kind: parts[2]!, id };
  if (captureSourceRefV1(parsed) !== value) throw new Error('Capture reference encoding is not canonical');
  return parsed;
}

/**
 * Source-local labels or unresolved speakers are never global actor identities.
 * The source ID prefix lets capture validation prove which item owns the ref.
 * The local ID must distinguish participants within that source; a display name
 * alone cannot distinguish two different people with the same name.
 */
export function captureLocalActorRefV1(input: {
  readonly tool: string; readonly tenant: string; readonly source_id: string; readonly local_id: string;
}): string {
  assertPlainContextObjectV1(input, ['tool', 'tenant', 'source_id', 'local_id'], 'Capture local actor reference');
  token(input.tool); opaque(input.tenant); opaque(input.local_id);
  if (typeof input.source_id !== 'string' || !/^source:[a-f0-9]{64}$/.test(input.source_id)) throw new Error('Capture local actor source ID is invalid');
  return captureSourceRefV1({ tool: input.tool, tenant: input.tenant, kind: 'local-actor',
    id: `${input.source_id.slice(7)}.${sourceContentSha256V1({ local_id: input.local_id })}` });
}
